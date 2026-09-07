import { ACTIVE_STATUSES, KIND, MSG, STATUS, TERMINAL_STATUSES } from '../shared/constants.js';
import { loadSettings, onSettingsChanged } from '../shared/settings.js';
import { joinPath } from '../shared/filetypes.js';
import { initI18n, t } from '../shared/i18n.js';
import { matchRule } from './rules.js';
import { mediaFor, registerMediaSniffer } from './media.js';
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
  await initI18n(settings.language);
  console.info('[dlman] ready', {
    captureMode: settings.captureMode,
    rules: settings.rules.map((rule) => `${rule.id}:${rule.capture ? '' : 'off:'}${Math.round(rule.minSizeBytes / 1048576)}MB`),
  });
})();

onSettingsChanged(async (next) => {
  settings = next;
  await initI18n(next.language);
  await installContextMenu();
  try {
    await sendToOffscreen(MSG.APPLY_SETTINGS, next);
  } catch {
    // Offscreen document is not running; it will pick the settings up on start.
  }
});

registerInterceptor({
  // Awaited: the event can arrive before storage has been read on a cold start.
  getSettings: async () => {
    await ready;
    return settings;
  },
  // Synchronous peek, so the common case can decline without calling suggest().
  getCachedSettings: () => settings,
  resolveOwn: (url) => deliveries.get(url),
  onCapture: (candidate) => start(candidate),
});

/** Queues a download and hands it to the engine. */
async function start(candidate) {
  await ready;

  const duplicate = state
    .getTasks()
    .find((task) => task.url === candidate.url && !TERMINAL_STATUSES.has(task.status));
  if (duplicate) {
    console.info('[dlman] already queued, ignoring duplicate', candidate.filename);
    return duplicate;
  }

  const task = createTask(candidate);
  await state.upsert(task);
  broadcast();
  try {
    await sendToOffscreen(MSG.ENQUEUE, { task, settings });
  } catch (error) {
    // Without this the task sits in the queue forever with no explanation.
    await state.upsert({
      id: task.id,
      status: STATUS.ERROR,
      error: `engine unreachable: ${error?.message || error}`,
    });
    broadcast();
  }
  return task;
}

// ---- context menu -----------------------------------------------------------

const MENU_ID = 'dlman-download-link';

/**
 * A right-click entry that bypasses the rules entirely. Useful when a link does
 * not match any rule, and the reliable way to test the engine on demand.
 */
async function installContextMenu() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_ID,
    title: t('menu.downloadWith'),
    contexts: ['link'],
  });
}

try {
  registerMediaSniffer(() => {
    if (settings?.detectMedia) broadcast();
  });
} catch (error) {
  // Media detection is a nicety; a missing API must never stop downloads from
  // being captured, which is what a throw at this point would do.
  console.error('[dlman] media detection unavailable', error);
}

/** Last http(s) URL seen on a copy event, offered as a suggestion in the popup. */
let clipboard = null;

/** Queues something the user picked by hand: a page's media, or a pasted URL. */
async function startManual({ url, name, kind }) {
  await ready;
  const filename = sanitizeManualName(name, url);
  const matched = matchRule(settings.rules, { filename, url, mime: '' });
  return start({
    url,
    filename,
    mime: '',
    referrer: '',
    sizeHint: 0,
    kind: kind === KIND.HLS ? KIND.HLS : KIND.FILE,
    // Picked deliberately, so neither the size gate nor capture flags apply.
    rule: { ...(matched ?? fallbackRule()), minSizeBytes: 0 },
  });
}

function sanitizeManualName(name, url) {
  const raw = name || decodeURIComponent(new URL(url).pathname.split('/').pop() || 'download');
  return raw.replace(/[\\/]/g, '_').slice(0, 180) || 'download';
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== MENU_ID || !info.linkUrl) return;
  await ready;
  const filename = decodeURIComponent(new URL(info.linkUrl).pathname.split('/').pop() || 'download');
  const matched = matchRule(settings.rules, { filename, url: info.linkUrl, mime: '' });
  await start({
    url: info.linkUrl,
    filename,
    mime: '',
    referrer: info.pageUrl || '',
    sizeHint: 0,
    // The size gate is deliberately dropped here; the user asked explicitly.
    rule: { ...(matched ?? fallbackRule()), minSizeBytes: 0 },
  });
});

function fallbackRule() {
  return { id: 'context-menu', label: t('menu.forceRule'), connections: 4, subfolder: '' };
}

chrome.runtime.onStartup.addListener(async () => {
  await ready;
  await state.markInterrupted();
  await installContextMenu();
  broadcast();
});

chrome.runtime.onInstalled.addListener(async () => {
  await ready;
  await state.markInterrupted();
  await installContextMenu();
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
    case MSG.CANCEL: {
      // Best effort: the user must be able to stop a download even when the
      // engine is wedged, so local state is updated either way.
      await sendToOffscreen(type, payload).catch((error) =>
        console.warn('[dlman] engine unreachable, stopping locally', error?.message || error),
      );
      await state.upsert({
        id: payload?.id,
        status: type === MSG.PAUSE ? STATUS.PAUSED : STATUS.CANCELED,
        speed: 0,
      });
      broadcast();
      return { ok: true };
    }

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

    case MSG.CLIPBOARD_HIT:
      if (settings.clipboardWatch && payload?.url) {
        clipboard = { url: payload.url, at: Date.now() };
        broadcast();
      }
      return { ok: true };

    case MSG.GET_CLIPBOARD:
      return { ok: true, clipboard };

    case MSG.GET_MEDIA: {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return { ok: true, media: tab ? mediaFor(tab.id) : [] };
    }

    case MSG.DOWNLOAD_MEDIA:
    case MSG.DOWNLOAD_URL:
      await startManual(payload ?? {});
      return { ok: true };

    case MSG.CLEAR_COMPLETED:
      await state.clearCompleted(payload?.all === true);
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
/** Blob URL -> relative path, read back by the interceptor for our own downloads. */
const deliveries = new Map();

async function deliver({ id, blobUrl, filename, subfolder }) {
  const path = joinPath(subfolder, filename);
  deliveries.set(blobUrl, path);
  try {
    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: path,
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
    deliveries.delete(blobUrl);
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
    kind: candidate.kind ?? KIND.FILE,
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
  updateBadge();
  chrome.runtime
    .sendMessage({ target: 'ui', type: MSG.STATE_BROADCAST, payload: state.getTasks() })
    .catch(() => {
      // No popup or options page is open.
    });
}

function updateBadge() {
  const active = state.getTasks().filter((task) => ACTIVE_STATUSES.has(task.status)).length;
  chrome.action.setBadgeText({ text: active ? String(active) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#4f6bff' });
}

/**
 * Hands any unfinished work back to the engine. Tasks can be left queued when
 * the service worker is torn down between accepting a download and reaching
 * the offscreen document; the engine ignores ids it already knows.
 */
ready.then(async () => {
  const pending = state
    .getTasks()
    .filter((task) => task.status === STATUS.QUEUED || task.status === STATUS.DOWNLOADING);
  if (pending.length === 0) return;

  await ensureOffscreen();
  for (const task of pending) {
    await sendToOffscreen(MSG.ENQUEUE, { task, settings }).catch((error) =>
      console.error('[dlman] could not resume', task.filename, error),
    );
  }
});
