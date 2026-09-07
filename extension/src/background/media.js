/**
 * Watches network traffic for playable media so the popup can offer it.
 *
 * YouTube is deliberately excluded: downloading from it breaks their terms of
 * service and the Chrome Web Store policies forbid extensions that do it.
 */
const EXCLUDED_HOSTS = [
  'youtube.com',
  'youtu.be',
  'googlevideo.com',
  'ytimg.com',
  'youtube-nocookie.com',
];

const PLAYLIST_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
];

const MIN_DIRECT_BYTES = 1024 * 1024;
const MAX_PER_TAB = 25;
// Entries go stale: a player re-requests playlists constantly, and a list that
// never empties keeps offering URLs the page has long since stopped using.
const TTL_MS = 10 * 60 * 1000;

/** tabId -> Map(url -> item) */
const perTab = new Map();

export function registerMediaSniffer(onChange) {
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      const item = classify(details);
      if (item) remember(details.tabId, item, onChange);
    },
    { urls: ['http://*/*', 'https://*/*'], types: ['media', 'xmlhttprequest', 'other', 'object'] },
    ['responseHeaders'],
  );

  // A new page starts a new list; stale entries would offer dead URLs.
  chrome.webNavigation?.onCommitted.addListener((details) => {
    if (details.frameId === 0) {
      perTab.delete(details.tabId);
      onChange(details.tabId);
    }
  });
  chrome.tabs.onRemoved.addListener((tabId) => perTab.delete(tabId));
}

export function mediaFor(tabId) {
  const now = Date.now();
  const list = perTab.get(tabId);
  if (!list) return [];
  for (const [url, item] of list) {
    if (now - item.at > TTL_MS) list.delete(url);
  }
  return [...list.values()].reverse();
}

export function clearMedia(tabId) {
  perTab.delete(tabId);
}

function classify(details) {
  const { url, responseHeaders = [] } = details;
  if (details.tabId < 0) return null;
  if (isExcluded(url)) return null;

  const header = (name) =>
    responseHeaders.find((h) => h.name.toLowerCase() === name)?.value?.toLowerCase() ?? '';
  const type = header('content-type').split(';')[0].trim();
  const length = Number(header('content-length')) || 0;
  const path = pathOf(url);

  if (path.endsWith('.m3u8') || PLAYLIST_TYPES.includes(type)) {
    return { url, kind: 'hls', label: 'HLS', name: nameFor(url, 'stream'), bytes: 0 };
  }
  if (path.endsWith('.mpd') || type === 'application/dash+xml') {
    // Detected so the user is not left wondering; DASH needs muxing we do not do.
    return { url, kind: 'dash', label: 'DASH', name: nameFor(url, 'stream'), bytes: 0, unsupported: true };
  }
  // Progressive files only when they are big enough to be the actual media and
  // not one segment of a stream.
  if (/^video\/|^audio\//.test(type) && length >= MIN_DIRECT_BYTES && !isSegment(path)) {
    return { url, kind: 'file', label: type.split('/')[1].toUpperCase(), name: nameFor(url, 'video'), bytes: length };
  }
  return null;
}

function remember(tabId, item, onChange) {
  let list = perTab.get(tabId);
  if (!list) {
    list = new Map();
    perTab.set(tabId, list);
  }
  if (list.has(item.url)) return;
  list.set(item.url, { ...item, at: Date.now() });
  while (list.size > MAX_PER_TAB) list.delete(list.keys().next().value);
  onChange(tabId, item);
}

function isExcluded(url) {
  try {
    const host = new URL(url).hostname;
    return EXCLUDED_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
  } catch {
    return true;
  }
}

function isSegment(path) {
  return /\.(ts|m4s|aac|vtt)$/.test(path) || /segment|chunk|frag/.test(path);
}

function pathOf(url) {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return '';
  }
}

function nameFor(url, fallback) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const last = decodeURIComponent(parts.pop() || '');
    const base = last.replace(/\.(m3u8|mpd)$/i, '');
    // Playlists are often called master.m3u8; the directory says more.
    if (!base || /^(master|index|playlist|manifest)$/i.test(base)) {
      return decodeURIComponent(parts.pop() || fallback);
    }
    return base;
  } catch {
    return fallback;
  }
}
