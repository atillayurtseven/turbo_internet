/**
 * Turns MPEG-TS segments into a plain, seekable MP4.
 *
 * mux.js does the codec work but emits fragmented MP4, which is a streaming
 * format: it plays from the start and nothing else -- no seeking, and several
 * desktop players refuse it outright. So the fragments are unwrapped here: the
 * media payload is kept as-is and a real sample table is built from the
 * fragment headers, producing an ordinary ftyp/moov/mdat file.
 */
import '../../vendor/mux.min.js';
import { OPFS_DIR } from '../shared/constants.js';
import { readFragments } from './mp4-boxes.js';
import { buildMoov, ftypOf, mdatHeader } from './mp4-writer.js';

const HEADER_PART = 0;
let stopped = false;

self.onmessage = async (event) => {
  const { type, payload } = event.data ?? {};
  if (type === 'stop') {
    stopped = true;
    return;
  }
  if (type !== 'start') return;

  try {
    self.postMessage({ type: 'done', parts: await remux(payload) });
  } catch (error) {
    console.error('[dlman/remux] failed', error);
    self.postMessage({ type: 'error', message: String(error?.message || error) });
  }
};

async function remux({ id, count, seconds }) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });

  const transmuxer = new self.muxjs.mp4.Transmuxer({ remux: true });
  let init = null;
  let emitted = [];
  transmuxer.on('data', (segment) => {
    if (!init && segment.initSegment) init = segment.initSegment;
    emitted.push(segment.data);
  });

  const tracks = new Map();
  let payloadBytes = 0;
  let part = HEADER_PART + 1;

  for (let index = 0; index < count; index += 1) {
    if (stopped) throw new DOMException('Aborted', 'AbortError');

    const source = await dir.getFileHandle(`${id}.${index}.part`, { create: false });
    emitted = [];
    transmuxer.push(new Uint8Array(await (await source.getFile()).arrayBuffer()));
    // Flushing per source segment keeps peak memory at one segment.
    transmuxer.flush();

    for (const fragment of emitted) {
      for (const { tracks: trafs, payload } of readFragments(fragment)) {
        for (const traf of trafs) {
          let track = tracks.get(traf.trackId);
          if (!track) {
            track = { samples: [], chunks: [] };
            tracks.set(traf.trackId, track);
          }
          track.chunks.push({
            count: traf.samples.length,
            // Relative for now; the header's own length is added once known.
            offset: payloadBytes + (traf.dataStart - payload.start),
          });
          // push(...) would spread thousands of entries and overflow the stack.
          for (const sample of traf.samples) track.samples.push(sample);
        }

        await write(dir, id, part, fragment.subarray(payload.start, payload.end));
        part += 1;
        payloadBytes += payload.end - payload.start;
      }
    }

    self.postMessage({ type: 'progress', done: index + 1, total: count });
  }

  if (!init) throw new Error('no init segment produced; stream may not be H.264/AAC');
  if (payloadBytes === 0) throw new Error('remux produced nothing');

  // Built twice: the first pass only measures the header, because chunk
  // offsets must be absolute and the header sits in front of them.
  const ftyp = ftypOf(init);
  const headerLength = ftyp.byteLength + buildMoov(init, tracks, seconds).byteLength + 16;
  for (const track of tracks.values()) {
    for (const chunk of track.chunks) chunk.offset += headerLength;
  }

  const moov = buildMoov(init, tracks, seconds);
  const header = new Uint8Array(ftyp.byteLength + moov.byteLength + 16);
  header.set(ftyp, 0);
  header.set(moov, ftyp.byteLength);
  header.set(mdatHeader(payloadBytes), ftyp.byteLength + moov.byteLength);
  await write(dir, id, HEADER_PART, header);

  return part;
}

async function write(dir, id, index, bytes) {
  const file = await dir.getFileHandle(`${id}-mux.${index}.part`, { create: true });
  const handle = await file.createSyncAccessHandle();
  try {
    handle.truncate(0);
    handle.write(bytes, { at: 0 });
    handle.flush();
  } finally {
    handle.close();
  }
}
