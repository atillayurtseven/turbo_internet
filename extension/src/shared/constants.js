export const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

/** Messages exchanged between popup/options -> service worker -> offscreen. */
export const MSG = {
  // UI -> service worker
  GET_STATE: 'get-state',
  PAUSE: 'pause',
  RESUME: 'resume',
  CANCEL: 'cancel',
  RETRY: 'retry',
  REMOVE: 'remove',
  CLEAR_COMPLETED: 'clear-completed',
  SHOW_FILE: 'show-file',
  SETTINGS_CHANGED: 'settings-changed',

  // service worker -> offscreen
  ENQUEUE: 'enqueue',
  APPLY_SETTINGS: 'apply-settings',
  RELEASE_BLOB: 'release-blob',

  // offscreen -> service worker
  STATE_UPDATE: 'state-update',
  DELIVER: 'deliver',

  // service worker -> UI (broadcast)
  STATE_BROADCAST: 'state-broadcast',
};

export const STATUS = {
  QUEUED: 'queued',
  PROBING: 'probing',
  DOWNLOADING: 'downloading',
  PAUSED: 'paused',
  ASSEMBLING: 'assembling',
  COMPLETED: 'completed',
  ERROR: 'error',
  CANCELED: 'canceled',
};

export const ACTIVE_STATUSES = new Set([
  STATUS.PROBING,
  STATUS.DOWNLOADING,
  STATUS.ASSEMBLING,
]);

export const TERMINAL_STATUSES = new Set([
  STATUS.COMPLETED,
  STATUS.ERROR,
  STATUS.CANCELED,
]);

export const OPFS_DIR = 'dlman';
export const PROGRESS_INTERVAL_MS = 500;
export const PERSIST_INTERVAL_MS = 4000;
export const KEEPALIVE_INTERVAL_MS = 20000;
export const MAX_HISTORY = 200;
