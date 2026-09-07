import { decide } from './rules.js';
import { CHOICE_MANAGER, askUser } from './prompt.js';
import { sanitizeFilename } from '../shared/filetypes.js';

/**
 * Registers the download interceptor.
 *
 * The decision is asynchronous on purpose. A download often starts while the
 * service worker is dormant: it wakes, registers this listener and receives the
 * event before settings have been read from storage. Returning true tells
 * Chrome to hold the download until suggest() is called, so a cold start no
 * longer silently hands every download back to Chrome.
 */
/**
 * Set by registerInterceptor. The helpers below live at module scope and cannot
 * reach into its parameters -- reading one from there threw on every decline.
 */
let alreadyOurs = () => false;

export function registerInterceptor({
  getSettings,
  getCachedSettings,
  resolveOwn,
  isHandled,
  onCapture,
}) {
  alreadyOurs = isHandled ?? (() => false);
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    // Our own delivery download. The filename passed to chrome.downloads.download
    // is only a suggestion and loses to this event, which is why finished files
    // were landing as <uuid>.txt: a blob URL carries no name of its own. The
    // name is asserted here instead, from the task that produced the blob.
    if (item.byExtensionId === chrome.runtime.id) {
      const own = resolveOwn(item.url);
      if (own) {
        suggest({ filename: own, conflictAction: 'uniquify' });
        return false;
      }
      return false;
    }

    // Same reasoning for anything we are not going to capture: stay out of the
    // way entirely rather than re-asserting a filename. The synchronous path
    // needs settings in hand; a cold start falls through to the async one.
    const cached = getCachedSettings();
    if (cached) {
      const verdict = evaluateWith(cached, item);
      if (!verdict.capture) {
        // Logged rather than dropped silently: "below-min-size" is by far the
        // most common reason a download is not taken over, and an unexplained
        // no-op looks like a broken extension.
        console.info('[dlman] skipped', verdict.reason, verdict.filename);
        return false;
      }
    }

    let suggested = false;
    const finish = () => {
      if (suggested) return;
      suggested = true;
      suggest();
    };

    evaluate(item, getSettings)
      .then(async (verdict) => {
        if (!verdict.capture) {
          console.debug('[dlman] skipped', verdict.reason, item.filename || item.url);
          finish();
          return;
        }
        // Release Chrome's hold first, then decide who finishes the job.
        finish();
        if (verdict.mode === 'ask') await confirmThenTakeOver(item, verdict, onCapture);
        else await takeOver(item, verdict, onCapture);
      })
      .catch((error) => {
        console.error('[dlman] interception failed', error);
        finish();
      });

    return true;
  });
}

async function evaluate(item, getSettings) {
  if (item.byExtensionId) return { capture: false, reason: 'other-extension' };
  const settings = await getSettings();
  if (!settings) return { capture: false, reason: 'no-settings' };
  return evaluateWith(settings, item);
}

function evaluateWith(settings, item) {
  const url = item.finalUrl || item.url;
  const filename = pickFilename(item);
  const candidate = {
    url,
    filename,
    mime: item.mime || '',
    size: item.totalBytes > 0 ? item.totalBytes : item.fileSize,
  };

  const verdict = decide(settings, candidate);
  return {
    ...verdict,
    url,
    filename,
    mime: candidate.mime,
    mode: settings.captureMode,
    seconds: settings.promptSeconds,
  };
}

/**
 * Stops Chrome first, then asks. Pausing and asking was the obvious order but
 * pause() is unreliable on a download that has only just started, and a failed
 * pause meant Chrome and this extension fetched the same file side by side.
 * Declining restarts the download in Chrome; a few lost seconds beats two
 * copies of the file.
 */
async function confirmThenTakeOver(item, verdict, onCapture) {
  await stopChrome(item.id);

  const choice = await askUser({
    filename: verdict.filename,
    sizeBytes: item.totalBytes > 0 ? item.totalBytes : item.fileSize,
    seconds: verdict.seconds,
  });

  if (choice === CHOICE_MANAGER) {
    await enqueue(item, verdict, onCapture);
    return;
  }

  // The card can time out in a tab the user never looked at, long after they
  // started the same file another way. Handing it back then would download it
  // a second time, so the answer is dropped if the file is already ours.
  if (alreadyOurs(verdict.url)) {
    console.info('[dlman] declined late, already downloading it', verdict.filename);
    return;
  }

  console.info('[dlman] declined, handing back to Chrome', verdict.filename);
  try {
    await chrome.downloads.download({ url: verdict.url, conflictAction: 'uniquify' });
  } catch (error) {
    console.error('[dlman] could not hand back to Chrome', error);
  }
}

/**
 * Cancels Chrome's download and makes sure no trace of it is left in the list.
 * A single erase() can lose a race with the download finishing, and the
 * leftover row is what makes it look like the file was downloaded twice.
 */
async function stopChrome(id) {
  try {
    await chrome.downloads.cancel(id);
  } catch {
    // Already finished or gone; nothing to cancel.
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await chrome.downloads.erase({ id });
      const left = await chrome.downloads.search({ id });
      if (left.length === 0) return;
    } catch {
      // Retried below.
    }
    await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
  }
  console.warn('[dlman] could not remove Chrome download row', id);
}

async function takeOver(item, verdict, onCapture) {
  await stopChrome(item.id);
  await enqueue(item, verdict, onCapture);
}

async function enqueue(item, verdict, onCapture) {
  console.info('[dlman] capturing', verdict.filename, `rule=${verdict.rule.id}`);
  await onCapture({
    url: verdict.url,
    filename: verdict.filename,
    mime: verdict.mime,
    rule: verdict.rule,
    referrer: item.referrer || '',
    sizeHint: item.totalBytes > 0 ? item.totalBytes : 0,
  });
}

/**
 * Chrome's suggested name already reflects Content-Disposition. It is only a
 * starting point: the probe re-reads the header and can still correct it.
 */
function pickFilename(item) {
  const base = item.filename || urlBasename(item.finalUrl || item.url);
  return sanitizeFilename(base.split(/[\\/]/).pop());
}

function urlBasename(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return name || 'download';
  } catch {
    return 'download';
  }
}
