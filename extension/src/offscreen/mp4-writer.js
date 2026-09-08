import { boxes, find } from './mp4-boxes.js';

/**
 * Builds a plain (non-fragmented) `moov` from sample tables gathered out of
 * fragments, reusing the codec descriptions from the fragmented init segment.
 */

const ascii = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0));

function box(type, ...parts) {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0) + 8;
  const out = new Uint8Array(length);
  new DataView(out.buffer).setUint32(0, length);
  out.set(ascii(type), 4);
  let at = 8;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/**
 * Takes an array rather than rest arguments: a ten-minute video has tens of
 * thousands of samples, and spreading that many arguments overflows the stack.
 */
function u32(values) {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i += 1) view.setUint32(i * 4, values[i] >>> 0);
  return out;
}

/** Flattens [[a, b], ...] straight into bytes, without an intermediate array. */
function u32pairs(entries, stride) {
  const out = new Uint8Array(entries.length * stride * 4);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const entry of entries) {
    for (let i = 0; i < stride; i += 1) {
      view.setUint32(at, entry[i] >>> 0);
      at += 4;
    }
  }
  return out;
}

function u64(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

const fullBox = (version, flags) => u32([((version & 0xff) << 24) | (flags & 0xffffff)]);

function slice(bytes, box_) {
  return bytes.subarray(box_.start, box_.end);
}

/**
 * Copies a tkhd/mdhd/mvhd and writes a real duration into it.
 * Offsets are relative to the box, since that is what the copy contains.
 */
function withDuration(bytes, box_, seconds, { durationAt, timescaleAt, timescale }) {
  const copy = new Uint8Array(slice(bytes, box_));
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  if (copy[8] === 1) return copy; // 64-bit variants are left as they are
  const scale = timescale ?? view.getUint32(timescaleAt);
  if (scale > 0) view.setUint32(durationAt, Math.round(seconds * scale));
  return copy;
}

// Field positions inside each header box, version 0.
const MVHD = { timescaleAt: 20, durationAt: 24 };
const MDHD = { timescaleAt: 20, durationAt: 24 };
const TKHD_DURATION_AT = 28;

function stts(samples) {
  const entries = [];
  for (const sample of samples) {
    const last = entries[entries.length - 1];
    if (last && last[1] === sample.duration) last[0] += 1;
    else entries.push([1, sample.duration]);
  }
  return box('stts', fullBox(0, 0), u32([entries.length]), u32pairs(entries, 2));
}

function ctts(samples) {
  if (!samples.some((sample) => sample.cts !== 0)) return null;
  const entries = [];
  for (const sample of samples) {
    const last = entries[entries.length - 1];
    if (last && last[1] === sample.cts) last[0] += 1;
    else entries.push([1, sample.cts]);
  }
  // Version 1 so negative composition offsets survive.
  return box('ctts', fullBox(1, 0), u32([entries.length]), u32pairs(entries, 2));
}

function stsc(chunks) {
  const entries = [];
  chunks.forEach((chunk, index) => {
    const last = entries[entries.length - 1];
    if (last && last[1] === chunk.count) return;
    entries.push([index + 1, chunk.count, 1]);
  });
  return box('stsc', fullBox(0, 0), u32([entries.length]), u32pairs(entries, 3));
}

function stsz(samples) {
  const sizes = new Uint8Array(samples.length * 4);
  const view = new DataView(sizes.buffer);
  for (let i = 0; i < samples.length; i += 1) view.setUint32(i * 4, samples[i].size >>> 0);
  return box('stsz', fullBox(0, 0), u32([0, samples.length]), sizes);
}

function co64(chunks) {
  const out = new Uint8Array(chunks.length * 8);
  chunks.forEach((chunk, index) => out.set(u64(chunk.offset), index * 8));
  return box('co64', fullBox(0, 0), u32([chunks.length]), out);
}

function stss(samples) {
  const sync = [];
  samples.forEach((sample, index) => {
    if (sample.sync) sync.push(index + 1);
  });
  // Every sample being a keyframe (audio) means the box carries no information.
  if (sync.length === samples.length) return null;
  return box('stss', fullBox(0, 0), u32([sync.length]), u32(sync));
}

/**
 * @param init    the fragmented init segment (ftyp + moov)
 * @param tracks  Map(trackId -> { samples, chunks })
 * @param seconds fallback duration, used only when the samples carry none
 */
export function buildMoov(init, tracks, seconds) {
  const view = new DataView(init.buffer, init.byteOffset, init.byteLength);
  const moov = boxes(view, 0, init.byteLength).find((b) => b.type === 'moov');
  if (!moov) throw new Error('init segment has no moov');

  const mvhdBox = boxes(view, moov.body, moov.end).find((b) => b.type === 'mvhd');
  // Read from the full buffer here, so this offset is absolute.
  const movieTimescale = view.getUint32(mvhdBox.start + MVHD.timescaleAt);


  const traks = [];
  let longest = 0;
  for (const trak of boxes(view, moov.body, moov.end).filter((b) => b.type === 'trak')) {
    const tkhdBox = boxes(view, trak.body, trak.end).find((b) => b.type === 'tkhd');
    const trackId = view.getUint32(tkhdBox.body + 12);
    const data = tracks.get(trackId);
    if (!data || data.samples.length === 0) continue;

    const mdiaBox = boxes(view, trak.body, trak.end).find((b) => b.type === 'mdia');
    const mdhdBox = boxes(view, mdiaBox.body, mdiaBox.end).find((b) => b.type === 'mdhd');

    // Length comes from the samples themselves, not from the playlist. A
    // playlist that overstates its duration -- or one the player never intended
    // to be summed -- produced files that claimed to be hours long.
    const mediaTimescale = view.getUint32(mdhdBox.start + MDHD.timescaleAt);
    const ticks = data.samples.reduce((sum, sample) => sum + sample.duration, 0);
    const trackSeconds = mediaTimescale > 0 && ticks > 0 ? ticks / mediaTimescale : seconds;
    longest = Math.max(longest, trackSeconds);
    const hdlrBox = boxes(view, mdiaBox.body, mdiaBox.end).find((b) => b.type === 'hdlr');
    const minfBox = boxes(view, mdiaBox.body, mdiaBox.end).find((b) => b.type === 'minf');
    const stsdBox = find(view, minfBox.body, minfBox.end, ['stbl', 'stsd']);

    const header = boxes(view, minfBox.body, minfBox.end).filter(
      (b) => b.type === 'vmhd' || b.type === 'smhd' || b.type === 'dinf',
    );

    const tables = [
      slice(init, stsdBox),
      stts(data.samples),
      ctts(data.samples),
      stsc(data.chunks),
      stsz(data.samples),
      co64(data.chunks),
      stss(data.samples),
    ].filter(Boolean);

    traks.push(
      box(
        'trak',
        // tkhd has no timescale of its own; it counts in movie units.
        withDuration(init, tkhdBox, trackSeconds, {
          durationAt: TKHD_DURATION_AT,
          timescale: movieTimescale,
        }),
        box(
          'mdia',
          withDuration(init, mdhdBox, trackSeconds, MDHD),
          slice(init, hdlrBox),
          box('minf', ...header.map((b) => slice(init, b)), box('stbl', ...tables)),
        ),
      ),
    );
  }

  if (traks.length === 0) throw new Error('no tracks to write');
  const mvhd = withDuration(init, mvhdBox, longest || seconds, MVHD);
  return box('moov', mvhd, ...traks);
}

export function ftypOf(init) {
  const view = new DataView(init.buffer, init.byteOffset, init.byteLength);
  const ftyp = boxes(view, 0, init.byteLength).find((b) => b.type === 'ftyp');
  return ftyp
    ? new Uint8Array(slice(init, ftyp))
    : box('ftyp', ascii('isom'), u32([512]), ascii('isomiso2avc1mp41'));
}

/** A 64-bit mdat header, so files over 4 GB stay valid. */
export function mdatHeader(payloadBytes) {
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  view.setUint32(0, 1);
  out.set(ascii('mdat'), 4);
  view.setBigUint64(8, BigInt(payloadBytes + 16));
  return out;
}
