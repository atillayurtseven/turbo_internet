const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Human readable byte count, e.g. 1536 -> "1.5 KB". */
export function formatBytes(bytes, digits = 1) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} ${UNITS[0]}`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : digits)} ${UNITS[unit]}`;
}

export function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** Remaining time in a compact form: "42 s", "7:04", "1:12:30". */
export function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.ceil(seconds)} s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function percent(received, total) {
  if (!total || total <= 0) return 0;
  return Math.min(100, (received / total) * 100);
}
