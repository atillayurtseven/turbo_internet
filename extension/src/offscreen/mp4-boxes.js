/**
 * Just enough MP4 box handling to turn fragmented MP4 into a plain one.
 *
 * Fragmented MP4 is a streaming format: playback works, seeking does not,
 * because there is no sample table. These helpers read the sample records out
 * of each fragment and build the `stbl` tables a normal file needs.
 */

export function boxes(view, start, end) {
  const out = [];
  let pos = start;
  while (pos + 8 <= end) {
    const size = view.getUint32(pos);
    const type = String.fromCharCode(
      view.getUint8(pos + 4), view.getUint8(pos + 5),
      view.getUint8(pos + 6), view.getUint8(pos + 7),
    );
    if (size < 8 || pos + size > end) break;
    out.push({ type, start: pos, end: pos + size, body: pos + 8 });
    pos += size;
  }
  return out;
}

export function find(view, start, end, path) {
  let level = boxes(view, start, end);
  let box = null;
  for (const type of path) {
    box = level.find((item) => item.type === type);
    if (!box) return null;
    level = boxes(view, box.body, box.end);
  }
  return box;
}

/**
 * Splits a buffer into its moof/mdat units.
 *
 * One buffer can hold several of them -- mux.js emits video and audio as
 * separate fragments back to back. Keeping only one payload per buffer dropped
 * every fragment but the last and left the sample offsets pointing at nothing.
 */
export function readFragments(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const units = [];
  let pending = null;

  for (const box of boxes(view, 0, bytes.byteLength)) {
    if (box.type === 'moof') {
      pending = { tracks: [], payload: null };
      for (const traf of boxes(view, box.body, box.end).filter((b) => b.type === 'traf')) {
        const track = readTraf(view, traf, box.start);
        if (track) pending.tracks.push(track);
      }
    } else if (box.type === 'mdat' && pending) {
      pending.payload = { start: box.body, end: box.end };
      units.push(pending);
      pending = null;
    }
  }
  return units;
}

function readTraf(view, traf, moofStart) {
  const children = boxes(view, traf.body, traf.end);
  const tfhd = children.find((b) => b.type === 'tfhd');
  const trun = children.find((b) => b.type === 'trun');
  if (!tfhd || !trun) return null;

  const tfhdFlags = view.getUint32(tfhd.body) & 0x00ffffff;
  let p = tfhd.body + 4;
  const trackId = view.getUint32(p);
  p += 4;
  let base = moofStart;
  if (tfhdFlags & 0x000001) {
    base = Number(view.getBigUint64(p));
    p += 8;
  }
  if (tfhdFlags & 0x000002) p += 4; // sample-description-index
  const defaultDuration = tfhdFlags & 0x000008 ? view.getUint32((p += 4) - 4) : 0;
  const defaultSize = tfhdFlags & 0x000010 ? view.getUint32((p += 4) - 4) : 0;
  const defaultFlags = tfhdFlags & 0x000020 ? view.getUint32((p += 4) - 4) : 0;

  const trunFlags = view.getUint32(trun.body) & 0x00ffffff;
  let q = trun.body + 4;
  const count = view.getUint32(q);
  q += 4;
  let dataOffset = 0;
  if (trunFlags & 0x000001) {
    dataOffset = view.getInt32(q);
    q += 4;
  }
  let firstFlags = null;
  if (trunFlags & 0x000004) {
    firstFlags = view.getUint32(q);
    q += 4;
  }

  const samples = [];
  for (let i = 0; i < count; i += 1) {
    const duration = trunFlags & 0x000100 ? view.getUint32((q += 4) - 4) : defaultDuration;
    const size = trunFlags & 0x000200 ? view.getUint32((q += 4) - 4) : defaultSize;
    const flags = trunFlags & 0x000400
      ? view.getUint32((q += 4) - 4)
      : i === 0 && firstFlags !== null
        ? firstFlags
        : defaultFlags;
    // Signed since version 1; the sign only matters for B-frames.
    const cts = trunFlags & 0x000800 ? view.getInt32((q += 4) - 4) : 0;
    // "sample_is_non_sync_sample" lives in bit 16 of the flags word.
    samples.push({ duration, size, cts, sync: (flags & 0x00010000) === 0 });
  }

  return { trackId, samples, dataStart: base + dataOffset };
}
