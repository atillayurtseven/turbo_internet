/**
 * Rewraps MPEG-TS segments as fragmented MP4, in order, one segment at a time.
 *
 * A classic worker on purpose: mux.js ships as UMD and importScripts is the
 * simplest way to load it without a build step.
 */
importScripts(`${self.location.origin}/vendor/mux.min.js`);

const OPFS_DIR = 'dlman';
let stopped = false;

self.onmessage = async (event) => {
  const { type, payload } = event.data ?? {};
  if (type === 'stop') {
    stopped = true;
    return;
  }
  if (type !== 'start') return;

  try {
    const written = await remux(payload);
    self.postMessage({ type: 'done', parts: written });
  } catch (error) {
    console.error('[dlman/remux] failed', error);
    self.postMessage({ type: 'error', message: String(error?.message || error) });
  }
};

// Part 0 is the init segment and part 1 the segment index; media starts at 2.
const INIT_PART = 0;
const SIDX_PART = 1;
const FIRST_MEDIA_PART = 2;
const SIDX_TIMESCALE = 90000;

async function remux({ id, count, seconds, segmentSeconds = [] }) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });

  const transmuxer = new muxjs.mp4.Transmuxer({ remux: true });
  let init = null;
  let pending = [];
  transmuxer.on('data', (segment) => {
    if (!init && segment.initSegment) init = segment.initSegment;
    pending.push(segment.data);
  });

  const write = async (index, bytes) => {
    const file = await dir.getFileHandle(`${id}-mux.${index}.part`, { create: true });
    const handle = await file.createSyncAccessHandle();
    try {
      handle.truncate(0);
      handle.write(bytes, { at: 0 });
      handle.flush();
    } finally {
      handle.close();
    }
  };

  const fragments = [];

  for (let index = 0; index < count; index += 1) {
    if (stopped) throw new DOMException('Aborted', 'AbortError');

    const file = await dir.getFileHandle(`${id}.${index}.part`, { create: false });
    const bytes = new Uint8Array(await (await file.getFile()).arrayBuffer());

    pending = [];
    transmuxer.push(bytes);
    // Flushing per segment keeps peak memory at one segment instead of the
    // whole video, and mux.js carries the decode time across flushes.
    transmuxer.flush();

    // The init segment has to land before any media data.
    if (index === 0) {
      if (!init) throw new Error('no init segment produced; stream may not be H.264/AAC');
      // mux.js writes a zero duration, so players report only the first
      // fragment and refuse to seek. The playlist knows the real length.
      await write(INIT_PART, patchDurations(init, seconds));
    }

    // One part per source segment, so each maps to exactly one index entry
    // even when mux.js splits audio and video into separate fragments.
    const merged = concat(pending);
    if (merged.byteLength > 0) {
      await write(FIRST_MEDIA_PART + fragments.length, merged);
      fragments.push({ bytes: merged.byteLength, seconds: segmentSeconds[index] ?? 0 });
    }

    self.postMessage({ type: 'progress', done: index + 1, total: count });
  }

  if (fragments.length === 0) throw new Error('remux produced nothing');

  // Written last because it needs every fragment's size, but it is ordered
  // right after the init segment: without it players cannot seek.
  await write(SIDX_PART, buildSidx(fragments));
  return FIRST_MEDIA_PART + fragments.length;
}

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * A segment index mapping playback time to byte ranges. Concatenated fMP4 has
 * no such map otherwise, so players can play but never seek.
 */
function buildSidx(fragments) {
  const box = new Uint8Array(32 + fragments.length * 12);
  const view = new DataView(box.buffer);

  view.setUint32(0, box.byteLength);
  box.set([0x73, 0x69, 0x64, 0x78], 4); // 'sidx'
  view.setUint32(8, 0); // version 0, flags 0
  view.setUint32(12, 1); // reference_ID
  view.setUint32(16, SIDX_TIMESCALE);
  view.setUint32(20, 0); // earliest_presentation_time
  view.setUint32(24, 0); // first_offset
  view.setUint16(28, 0); // reserved
  view.setUint16(30, fragments.length);

  let at = 32;
  for (const fragment of fragments) {
    // reference_type 0 (media) in the top bit, then the fragment's size.
    view.setUint32(at, fragment.bytes & 0x7fffffff);
    view.setUint32(at + 4, Math.round(fragment.seconds * SIDX_TIMESCALE));
    // starts_with_SAP = 1, SAP_type = 1: every fragment opens on a keyframe.
    view.setUint32(at + 8, 0x90000000);
    at += 12;
  }
  return box;
}


/**
 * Writes a real duration into the init segment's mvhd, tkhd and mdhd boxes.
 * Each carries its own timescale, so the value is converted per box.
 */
function patchDurations(bytes, seconds) {
  if (!seconds || seconds <= 0) return bytes;
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'edts']);

  const walk = (start, end, movieTimescale) => {
    let pos = start;
    let timescale = movieTimescale;

    while (pos + 8 <= end) {
      const size = view.getUint32(pos);
      const type = String.fromCharCode(out[pos + 4], out[pos + 5], out[pos + 6], out[pos + 7]);
      if (size < 8 || pos + size > end) return timescale;

      if (CONTAINERS.has(type)) {
        timescale = walk(pos + 8, pos + size, timescale) ?? timescale;
      } else if (type === 'mvhd' || type === 'mdhd') {
        const version = out[pos + 8];
        const scaleAt = pos + (version === 1 ? 28 : 20);
        const scale = view.getUint32(scaleAt);
        if (scale > 0) {
          if (type === 'mvhd') movieTimescale = scale;
          timescale = scale;
          writeDuration(view, scaleAt + 4, version, Math.round(seconds * scale));
        }
      } else if (type === 'tkhd') {
        const version = out[pos + 8];
        const scale = movieTimescale || 1000;
        writeDuration(view, pos + (version === 1 ? 36 : 28), version, Math.round(seconds * scale));
      }
      pos += size;
    }
    return timescale;
  };

  walk(0, out.byteLength, 1000);
  return out;
}

function writeDuration(view, offset, version, value) {
  if (version === 1) {
    view.setUint32(offset, Math.floor(value / 2 ** 32));
    view.setUint32(offset + 4, value >>> 0);
  } else {
    view.setUint32(offset, Math.min(value, 0xfffffffe));
  }
}
