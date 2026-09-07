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

// A single stream segment is often a megabyte or two, so the bar for calling
// something a complete file has to sit well above that.
const MIN_DIRECT_BYTES = 8 * 1024 * 1024;
const MAX_PER_TAB = 25;
// Entries go stale: a player re-requests playlists constantly, and a list that
// never empties keeps offering URLs the page has long since stopped using.
const TTL_MS = 10 * 60 * 1000;

/** tabId -> Map(url -> item) */
const perTab = new Map();
/** Tabs where a playlist was seen; their media requests are stream fragments. */
const streaming = new Set();

export function registerMediaSniffer(onChange) {
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      const item = classify(details);
      if (!item) return;

      if (item.kind === 'hls') {
        playlistUsable(item.url).then((usable) => {
          if (usable) remember(details.tabId, item, onChange);
        });
        return;
      }
      if (item.kind !== 'file') {
        remember(details.tabId, item, onChange);
        return;
      }
      // Progressive candidates are verified first: a fragment must never be
      // offered as if it were the whole video.
      looksComplete(item.url).then((complete) => {
        if (complete) remember(details.tabId, item, onChange);
      });
    },
    { urls: ['http://*/*', 'https://*/*'], types: ['media', 'xmlhttprequest', 'other', 'object'] },
    ['responseHeaders'],
  );

  // A new page starts a new list; stale entries would offer dead URLs.
  chrome.webNavigation?.onCommitted.addListener((details) => {
    if (details.frameId === 0) {
      perTab.delete(details.tabId);
      streaming.delete(details.tabId);
      onChange(details.tabId);
    }
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    perTab.delete(tabId);
    streaming.delete(tabId);
  });
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
  streaming.delete(tabId);
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
    streaming.add(details.tabId);
    return { url, kind: 'hls', label: 'HLS', name: nameFor(url, 'stream'), bytes: 0 };
  }
  if (path.endsWith('.mpd') || type === 'application/dash+xml') {
    streaming.add(details.tabId);
    // Detected so the user is not left wondering; DASH needs muxing we do not do.
    return { url, kind: 'dash', label: 'DASH', name: nameFor(url, 'stream'), bytes: 0, unsupported: true };
  }
  // Progressive files only. Once a playlist has been seen on this tab, every
  // media response is a piece of that stream: offering one on its own produced
  // a headerless file that no player could open.
  if (streaming.has(details.tabId)) return null;
  if (/^video\/|^audio\//.test(type) && length >= MIN_DIRECT_BYTES && !isSegment(path)) {
    return { url, kind: 'file', label: type.split('/')[1].toUpperCase(), name: nameFor(url, 'video'), bytes: length };
  }
  return null;
}

/**
 * Reads the first bytes of a candidate before offering it.
 *
 * URL shape is not a reliable tell: a stream segment can be large, have no
 * extension and a token for a name. A real file opens with an `ftyp` box, a
 * fragment with `moof` or `styp`, so the file itself is asked instead.
 */
/**
 * Checks that a playlist is actually reachable and is a playlist.
 *
 * Offering something we cannot fetch is worse than not offering it: the user
 * clicks Download and gets an error, which reads as a broken extension rather
 * than a server saying no.
 */
async function playlistUsable(url) {
  try {
    // Same credentials the real download will use, so the check cannot reject
    // a stream that would in fact have worked.
    const response = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) return false;
    const head = (await response.text()).slice(0, 256).trimStart();
    return head.startsWith('#EXTM3U');
  } catch {
    return false;
  }
}

async function looksComplete(url) {
  try {
    const response = await fetch(url, {
      headers: { Range: 'bytes=0-15' },
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!response.ok && response.status !== 206) return false;
    const head = new Uint8Array((await response.arrayBuffer()).slice(0, 16));
    if (head.byteLength < 8) return false;
    const type = String.fromCharCode(head[4], head[5], head[6], head[7]);
    // Anything that is not an MP4 family box is left alone; only fragments are
    // rejected, so WebM and friends still pass.
    return type !== 'moof' && type !== 'styp';
  } catch {
    return false;
  }
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
