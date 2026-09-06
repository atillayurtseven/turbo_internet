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
export function registerInterceptor({ getSettings, onCapture }) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
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
 * Holds Chrome's download while the user is asked. Saying no simply resumes it,
 * so the file still arrives either way.
 */
async function confirmThenTakeOver(item, verdict, onCapture) {
  const paused = await pause(item.id);

  const choice = await askUser({
    filename: verdict.filename,
    sizeBytes: item.totalBytes > 0 ? item.totalBytes : item.fileSize,
    seconds: verdict.seconds,
  });

  if (choice === CHOICE_MANAGER) {
    await takeOver(item, verdict, onCapture);
    return;
  }

  console.info('[dlman] declined, Chrome keeps the download', verdict.filename);
  if (paused) {
    try {
      await chrome.downloads.resume(item.id);
    } catch (error) {
      console.error('[dlman] could not resume Chrome download', error);
    }
  }
}

/** The download may not be in progress yet, so pausing gets a few tries. */
async function pause(id) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await chrome.downloads.pause(id);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  console.warn('[dlman] could not pause; Chrome keeps downloading while we ask');
  return false;
}

async function takeOver(item, verdict, onCapture) {
  console.info('[dlman] capturing', verdict.filename, `rule=${verdict.rule.id}`);
  try {
    await chrome.downloads.cancel(item.id);
  } catch {
    // Already finished or gone; nothing to cancel.
  }
  try {
    await chrome.downloads.erase({ id: item.id });
  } catch {
    // Erasing only affects the visible list; ignore.
  }
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
