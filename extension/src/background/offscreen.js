import { OFFSCREEN_PATH } from '../shared/constants.js';

let creating = null;

/** Ensures the offscreen document exists. Safe to call concurrently. */
export async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  if (existing.length > 0) return;

  if (creating) {
    await creating;
    return;
  }

  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: reasons(),
    justification:
      'Runs segmented HTTP downloads in workers, stores parts in OPFS and creates the blob URL handed to chrome.downloads.',
  });

  try {
    await creating;
    console.info('[dlman] offscreen document created');
  } catch (error) {
    // A concurrent caller may have created it first; anything else is real.
    if (!String(error?.message || '').includes('Only a single offscreen')) {
      console.error('[dlman] offscreen creation failed', error);
      throw error;
    }
  } finally {
    creating = null;
  }
}

/** Reason enum members vary by Chrome version; drop any this build lacks. */
function reasons() {
  const wanted = [chrome.offscreen.Reason.BLOBS, chrome.offscreen.Reason.WORKERS];
  const available = wanted.filter(Boolean);
  return available.length > 0 ? available : ['BLOBS'];
}

export async function closeOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length > 0) await chrome.offscreen.closeDocument();
}

const TRANSIENT = ['Receiving end does not exist', 'Could not establish connection'];

/**
 * Sends a message to the offscreen document, starting it if needed.
 *
 * createDocument() can resolve before the document's module scripts have run,
 * so the very first message is regularly sent into the void. Retrying is the
 * only reliable way to close that window.
 */
export async function sendToOffscreen(type, payload, attempts = 6) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await ensureOffscreen();
    try {
      return await chrome.runtime.sendMessage({ target: 'offscreen', type, payload });
    } catch (error) {
      const message = String(error?.message || error);
      const transient = TRANSIENT.some((needle) => message.includes(needle));
      if (!transient || attempt === attempts - 1) {
        console.error('[dlman] offscreen message failed', type, message);
        throw error;
      }
      await delay(50 * 2 ** attempt);
    }
  }
  return undefined;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
