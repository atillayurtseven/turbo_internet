import { credentialsFor, deadline, referrerInit, HttpError } from './probe.js';

/**
 * Minimal HLS playlist reader: enough for downloading a VOD stream, not a
 * player. Follows a master playlist to its highest-bandwidth variant, resolves
 * segment URLs and reads the AES-128 key when the stream carries one.
 *
 * AES-128 here is transport encryption, not DRM -- the key is served in the
 * clear to any client. SAMPLE-AES and anything Widevine-backed are refused.
 */
export async function loadPlaylist(url, { referrer = '', signal } = {}) {
  const master = await fetchText(url, referrer, signal);
  const lines = master.split(/\r?\n/).map((line) => line.trim());

  const variant = pickVariant(lines, url);
  const mediaUrl = variant ?? url;
  const media = variant ? await fetchText(mediaUrl, referrer, signal) : master;

  return parseMedia(media, mediaUrl, referrer, signal);
}

function pickVariant(lines, baseUrl) {
  let best = null;
  let bestBandwidth = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const bandwidth = Number(/BANDWIDTH=(\d+)/.exec(lines[i])?.[1] ?? 0);
    const target = lines.slice(i + 1).find((line) => line && !line.startsWith('#'));
    if (target && bandwidth > bestBandwidth) {
      bestBandwidth = bandwidth;
      best = new URL(target, baseUrl).href;
    }
  }
  return best;
}

async function parseMedia(text, baseUrl, referrer, signal) {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  if (lines.some((line) => line.startsWith('#EXT-X-KEY') && /METHOD=SAMPLE-AES/.test(line))) {
    throw new Error('encrypted stream (SAMPLE-AES) is not supported');
  }

  const parts = [];
  let key = null;
  let init = null;
  // Byte-range playlists point every segment at the same file; the offset is
  // optional and then continues where the previous segment ended.
  let pendingRange = null;
  let pendingDuration = 0;
  const nextOffset = new Map();
  let sequence = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text)?.[1] ?? 0);
  let duration = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-KEY')) {
      key = await readKey(line, baseUrl, referrer, signal);
      continue;
    }
    if (line.startsWith('#EXT-X-MAP')) {
      const uri = /URI="([^"]+)"/.exec(line)?.[1];
      if (uri) {
        init = { url: new URL(uri, baseUrl).href, byteRange: parseRange(line, null) };
      }
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE')) {
      pendingRange = /#EXT-X-BYTERANGE:([\d@]+)/.exec(line)?.[1] ?? null;
      continue;
    }
    if (line.startsWith('#EXTINF')) {
      pendingDuration = Number(/#EXTINF:([\d.]+)/.exec(line)?.[1] ?? 0);
      duration += pendingDuration;
      continue;
    }
    if (!line || line.startsWith('#')) continue;

    const url = new URL(line, baseUrl).href;
    const byteRange = rangeFrom(pendingRange, url, nextOffset);
    pendingRange = null;

    parts.push({
      url,
      seconds: pendingDuration,
      byteRange,
      key,
      // The IV defaults to the media sequence number when the tag omits one.
      iv: key?.iv ?? (key ? sequenceIv(sequence) : null),
    });
    pendingDuration = 0;
    sequence += 1;
  }

  if (parts.length === 0) throw new Error('playlist has no segments');

  const container = /\.(m4s|mp4|cmfv)(\?|$)/i.test(parts[0].url) || init ? 'mp4' : 'ts';
  return { parts, init, container, duration, encrypted: Boolean(key) };
}

async function readKey(line, baseUrl, referrer, signal) {
  const method = /METHOD=([A-Z0-9-]+)/.exec(line)?.[1] ?? 'NONE';
  if (method === 'NONE') return null;
  if (method !== 'AES-128') throw new Error(`unsupported key method: ${method}`);

  const uri = /URI="([^"]+)"/.exec(line)?.[1];
  if (!uri) throw new Error('key tag without URI');

  const keyUrl = new URL(uri, baseUrl).href;
  const response = await fetch(keyUrl, {
    credentials: credentialsFor(keyUrl),
    cache: 'no-store',
    signal: deadline(signal),
    ...referrerInit(referrer),
  });
  if (!response.ok) throw new HttpError(response.status);

  const raw = new Uint8Array(await response.arrayBuffer());
  const cryptoKey = await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
  const ivHex = /IV=0x([0-9a-fA-F]+)/.exec(line)?.[1];
  return { cryptoKey, iv: ivHex ? hexToBytes(ivHex) : null };
}

/** "#EXT-X-BYTERANGE:<length>[@<offset>]" -> { offset, length }. */
function rangeFrom(value, url, nextOffset) {
  if (!value) return null;
  const [lengthText, offsetText] = value.split('@');
  const length = Number(lengthText);
  if (!Number.isFinite(length) || length <= 0) return null;
  const offset = offsetText !== undefined ? Number(offsetText) : (nextOffset.get(url) ?? 0);
  nextOffset.set(url, offset + length);
  return { offset, length };
}

function parseRange(line, fallback) {
  const value = /BYTERANGE="([^"]+)"/.exec(line)?.[1];
  if (!value) return fallback;
  const [lengthText, offsetText] = value.split('@');
  return { offset: Number(offsetText ?? 0), length: Number(lengthText) };
}

function sequenceIv(sequence) {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, sequence);
  return iv;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function fetchText(url, referrer, signal) {
  const response = await fetch(url, {
    credentials: credentialsFor(url),
    cache: 'no-store',
    signal: deadline(signal),
    ...referrerInit(referrer),
  });
  if (!response.ok) throw new HttpError(response.status);
  return response.text();
}
