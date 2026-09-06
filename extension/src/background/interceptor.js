import { decide } from './rules.js';
import { sanitizeFilename } from '../shared/filetypes.js';

/**
 * Registers the download interceptor. `getSettings` returns the cached settings
 * synchronously, because onDeterminingFilename must decide without awaiting.
 */
export function registerInterceptor({ getSettings, onCapture }) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    const settings = getSettings();

    // Settings not loaded yet, or this download came from another extension:
    // leave it alone rather than guessing.
    if (!settings || item.byExtensionId) {
      suggest();
      return false;
    }

    const url = item.finalUrl || item.url;
    const filename = pickFilename(item);
    const candidate = {
      url,
      filename,
      mime: item.mime || '',
      size: item.totalBytes > 0 ? item.totalBytes : item.fileSize,
    };

    const verdict = decide(settings, candidate);
    if (!verdict.capture) {
      suggest();
      return false;
    }

    suggest();
    // Taking over must not block the listener; failures fall back to Chrome's
    // own download, which is still on disk until erase() succeeds.
    takeOver(item, { url, filename, mime: candidate.mime, rule: verdict.rule }, onCapture);
    return false;
  });
}

async function takeOver(item, candidate, onCapture) {
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
    url: candidate.url,
    filename: candidate.filename,
    mime: candidate.mime,
    rule: candidate.rule,
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
