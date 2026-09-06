import { SUPPORTED_LOCALES } from './i18n.js';

const MB = 1024 * 1024;
const STORAGE_KEY = 'settings';

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  language: 'auto',
  captureEnabled: true,
  probeRanges: true,
  fallbackSingleConnection: true,
  maxConcurrentDownloads: 3,
  maxSpeedBytesPerSec: 0,
  segmentRetries: 5,
  retryBackoffMs: 1000,
  minSegmentSizeBytes: 1 * MB,
  rules: [
    {
      id: 'disk-images',
      label: 'Disk images',
      extensions: ['iso', 'img', 'dmg', 'vhd', 'vmdk'],
      mimePatterns: [],
      capture: true,
      connections: 8,
      minSizeBytes: 50 * MB,
      subfolder: '',
    },
    {
      id: 'archives',
      label: 'Archives',
      extensions: ['zip', 'rar', '7z', 'gz', 'bz2', 'xz', 'tar', 'tar.gz', 'tar.xz'],
      mimePatterns: ['application/zip', 'application/x-7z-compressed'],
      capture: true,
      connections: 4,
      minSizeBytes: 20 * MB,
      subfolder: '',
    },
    {
      id: 'video',
      label: 'Video',
      extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm'],
      mimePatterns: ['video/*'],
      capture: true,
      connections: 6,
      minSizeBytes: 10 * MB,
      subfolder: '',
    },
    {
      id: 'installers',
      label: 'Installers',
      extensions: ['exe', 'msi', 'deb', 'rpm', 'pkg', 'appimage'],
      mimePatterns: [],
      capture: true,
      connections: 4,
      minSizeBytes: 5 * MB,
      subfolder: '',
    },
    {
      id: 'documents',
      label: 'Documents',
      extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'],
      mimePatterns: [],
      capture: false,
      connections: 1,
      minSizeBytes: 0,
      subfolder: '',
    },
  ],
});

const clampInt = (value, min, max, fallback) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function normalizeRule(raw, index) {
  return {
    id: String(raw?.id || `rule-${index}`),
    label: String(raw?.label || '').slice(0, 64),
    extensions: (Array.isArray(raw?.extensions) ? raw.extensions : [])
      .map((e) => String(e).trim().toLowerCase().replace(/^\./, ''))
      .filter(Boolean),
    mimePatterns: (Array.isArray(raw?.mimePatterns) ? raw.mimePatterns : [])
      .map((m) => String(m).trim().toLowerCase())
      .filter(Boolean),
    capture: raw?.capture !== false,
    connections: clampInt(raw?.connections, 1, 32, 4),
    minSizeBytes: clampInt(raw?.minSizeBytes, 0, Number.MAX_SAFE_INTEGER, 0),
    subfolder: String(raw?.subfolder || '').slice(0, 128),
  };
}

/** Coerces stored settings into a valid shape; unknown fields are dropped. */
export function normalizeSettings(raw) {
  const d = DEFAULT_SETTINGS;
  const language = SUPPORTED_LOCALES.includes(raw?.language) ? raw.language : 'auto';
  return {
    version: d.version,
    language,
    captureEnabled: raw?.captureEnabled !== false,
    probeRanges: raw?.probeRanges !== false,
    fallbackSingleConnection: raw?.fallbackSingleConnection !== false,
    maxConcurrentDownloads: clampInt(raw?.maxConcurrentDownloads, 1, 10, d.maxConcurrentDownloads),
    maxSpeedBytesPerSec: clampInt(raw?.maxSpeedBytesPerSec, 0, Number.MAX_SAFE_INTEGER, 0),
    segmentRetries: clampInt(raw?.segmentRetries, 0, 20, d.segmentRetries),
    retryBackoffMs: clampInt(raw?.retryBackoffMs, 100, 60000, d.retryBackoffMs),
    minSegmentSizeBytes: clampInt(raw?.minSegmentSizeBytes, 64 * 1024, 512 * MB, d.minSegmentSizeBytes),
    rules: Array.isArray(raw?.rules) ? raw.rules.map(normalizeRule) : d.rules.map(normalizeRule),
  };
}

export async function loadSettings() {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  return normalizeSettings(stored[STORAGE_KEY] ?? DEFAULT_SETTINGS);
}

export async function saveSettings(settings) {
  const normalized = normalizeSettings(settings);
  await chrome.storage.sync.set({ [STORAGE_KEY]: normalized });
  return normalized;
}

export async function resetSettings() {
  return saveSettings(DEFAULT_SETTINGS);
}

export function onSettingsChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes[STORAGE_KEY]) {
      callback(normalizeSettings(changes[STORAGE_KEY].newValue));
    }
  });
}
