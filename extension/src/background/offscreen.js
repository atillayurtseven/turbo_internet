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
    reasons: [chrome.offscreen.Reason.BLOBS, chrome.offscreen.Reason.WORKERS],
    justification:
      'Runs segmented HTTP downloads in workers, stores parts in OPFS and creates the blob URL handed to chrome.downloads.',
  });
  try {
    await creating;
  } catch (error) {
    // A concurrent caller may have created it first; anything else is real.
    if (!String(error?.message || '').includes('Only a single offscreen')) throw error;
  } finally {
    creating = null;
  }
}

export async function closeOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length > 0) await chrome.offscreen.closeDocument();
}

/** Sends a message to the offscreen document, starting it if needed. */
export async function sendToOffscreen(type, payload) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: 'offscreen', type, payload });
}
