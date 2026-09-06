import { MSG, STATUS } from '../shared/constants.js';
import { loadSettings, onSettingsChanged } from '../shared/settings.js';
import { joinPath } from '../shared/filetypes.js';
import { registerInterceptor } from './interceptor.js';
import { ensureOffscreen, sendToOffscreen } from './offscreen.js';
import * as state from './state.js';

/**
 * The service worker is the coordinator: it owns settings, intercepts Chrome
 * downloads and hands the finished blob to chrome.downloads. All fetching and
 * OPFS work happens in the offscreen document, which is not subject to the
 * 30-second service worker idle timeout.
 */

let settings = null;

const ready = (async () => {
  settings = await loadSettings();
  await state.loadState();
})();

onSettingsChanged(async (next) => {
  settings = next;
  try {
    await sendToOffscreen(MSG.APPLY_SETTINGS, next);
  } catch {
    // Offscreen document is not running; it will pick the settings up on start.
  }
});

registerInterceptor({
  getSettings: () => settings,
  onCapture: async (candidate) => {
    await ready;
    const task = createTask(candidate);
    await state.upsert(task);
    broadcast();
    await sendToOffscreen(MSG.ENQUEUE, { task, settings });
  },
});

chrome.runtime.onStartup.addListener(async () => {
  await ready;
  await state.markInterrupted();
  broadcast();
});

chrome.runtime.onInstalled.addListener(async () => {
  await ready;
  await state.markInterrupted();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target && message.target !== 'background') return false;
  handleMessage(message, sender).then(sendResponse, (error) => {
    console.error('[dlman] message failed', message?.type, error);
    sendResponse({ ok: false, error: String(error?.message || error) });
  });
  return true;
});

async function handleMessage(message, sender) {
  await ready;
  const { type, payload } = message ?? {};

  switch (type) {
    case MSG.GET_STATE:
      return { ok: true, tasks: state.getTasks(), settings };

    case MSG.PAUSE:
    case MSG.CANCEL:
      await sendToOffscreen(type, payload);
      return { ok: true };

    case MSG.RESUME:
    case MSG.RETRY: {
      const task = state.getTasks().find((item) => item.id === payload?.id);
      if (!task) return { ok: false, error: 'unknown-task' };
      await sendToOffscreen(type, { task, settings });
      return { ok: true };
    }

    case MSG.REMOVE:
      await sendToOffscreen(MSG.CANCEL, payload).catch(() => {});
      await state.remove(payload?.id);
      broadcast();
      return { ok: true };

    case MSG.CLEAR_COMPLETED:
      await state.clearCompleted();
      broadcast();
      return { ok: true };

    case MSG.SHOW_FILE: {
      const task = state.getTasks().find((item) => item.id === payload?.id);
      if (task?.chromeDownloadId) chrome.downloads.show(task.chromeDownloadId);
      return { ok: true };
    }

    // From the offscreen document.
    case MSG.STATE_UPDATE:
      await state.replaceState(payload ?? []);
      broadcast();
      return { ok: true };

    case MSG.DELIVER:
      return deliver(payload, sender);

    default:
      return { ok: false, error: `unknown-message:${type}` };
  }
}

/**
 * Writes a finished download to disk. The blob URL is created in the offscreen
 * document and is backed by the OPFS file, so this does not load the file into
 * memory even for multi-gigabyte downloads.
 */
async function deliver({ id, blobUrl, filename, subfolder }) {
  try {
    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: joinPath(subfolder, filename),
      conflictAction: 'uniquify',
      saveAs: false,
    });
    await waitForDownload(downloadId);
    await state.upsert({
      id,
      status: STATUS.COMPLETED,
      chromeDownloadId: downloadId,
      completedAt: Date.now(),
      speed: 0,
    });
    broadcast();
    return { ok: true, downloadId };
  } catch (error) {
    await state.upsert({ id, status: STATUS.ERROR, error: String(error?.message || error) });
    broadcast();
    return { ok: false, error: String(error?.message || error) };
  } finally {
    await sendToOffscreen(MSG.RELEASE_BLOB, { id, blobUrl }).catch(() => {});
  }
}

function waitForDownload(downloadId) {
  return new Promise((resolve, reject) => {
    const listener = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        chrome.downloads.onChanged.removeListener(listener);
        resolve();
      } else if (delta.state?.current === 'interrupted') {
        chrome.downloads.onChanged.removeListener(listener);
        reject(new Error(delta.error?.current || 'interrupted'));
      }
    };
    chrome.downloads.onChanged.addListener(listener);
  });
}

function createTask(candidate) {
  return {
    id: crypto.randomUUID(),
    url: candidate.url,
    filename: candidate.filename,
    mime: candidate.mime,
    referrer: candidate.referrer,
    subfolder: candidate.rule.subfolder,
    ruleId: candidate.rule.id,
    ruleLabel: candidate.rule.label,
    connections: candidate.rule.connections,
    minSizeBytes: candidate.rule.minSizeBytes,
    totalBytes: candidate.sizeHint || 0,
    receivedBytes: 0,
    segments: [],
    rangeSupported: null,
    status: STATUS.QUEUED,
    speed: 0,
    error: '',
    createdAt: Date.now(),
    completedAt: 0,
    chromeDownloadId: 0,
  };
}

function broadcast() {
  chrome.runtime
    .sendMessage({ target: 'ui', type: MSG.STATE_BROADCAST, payload: state.getTasks() })
    .catch(() => {
      // No popup or options page is open.
    });
}

// Keep the engine warm while there is unfinished work.
ready.then(async () => {
  const hasWork = state.getTasks().some((task) => task.status === STATUS.DOWNLOADING);
  if (hasWork) await ensureOffscreen();
});
