import { MSG } from '../shared/constants.js';
import { loadSettings } from '../shared/settings.js';
import { Engine } from './engine.js';

const ready = (async () => new Engine(await loadSettings()))();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;
  handle(message).then(sendResponse, (error) => {
    console.error('[dlman/offscreen]', message?.type, error);
    sendResponse({ ok: false, error: String(error?.message || error) });
  });
  return true;
});

async function handle({ type, payload }) {
  const engine = await ready;

  switch (type) {
    case MSG.ENQUEUE:
      if (payload.settings) engine.applySettings(payload.settings);
      engine.enqueue(payload.task);
      return { ok: true };

    case MSG.APPLY_SETTINGS:
      engine.applySettings(payload);
      return { ok: true };

    case MSG.PAUSE:
      engine.pause(payload.id);
      return { ok: true };

    case MSG.RESUME:
      if (payload.settings) engine.applySettings(payload.settings);
      engine.resume(payload.task);
      return { ok: true };

    case MSG.RETRY:
      if (payload.settings) engine.applySettings(payload.settings);
      engine.retry(payload.task);
      return { ok: true };

    case MSG.CANCEL:
      await engine.cancel(payload.id);
      return { ok: true };

    case MSG.RELEASE_BLOB:
      engine.releaseBlob(payload.id, payload.blobUrl);
      return { ok: true };

    default:
      return { ok: false, error: `unknown-message:${type}` };
  }
}
