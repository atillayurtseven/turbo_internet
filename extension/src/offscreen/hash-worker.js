/**
 * Hashes the finished parts, in order, so the download can be checked against
 * a published checksum. Runs off the main thread and reads a chunk at a time,
 * because the files it walks can be many gigabytes.
 */
import { OPFS_DIR } from '../shared/constants.js';
import { Sha256 } from './sha256.js';

const CHUNK = 8 * 1024 * 1024;
let stopped = false;

self.onmessage = async (event) => {
  const { type, payload } = event.data ?? {};
  if (type === 'stop') {
    stopped = true;
    return;
  }
  if (type !== 'start') return;

  try {
    self.postMessage({ type: 'done', sha256: await hash(payload) });
  } catch (error) {
    console.error('[dlman/hash] failed', error);
    self.postMessage({ type: 'error', message: String(error?.message || error) });
  }
};

async function hash({ prefix, segments, totalBytes }) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });

  const digest = new Sha256();
  let done = 0;

  for (const segment of [...segments].sort((a, b) => a.start - b.start)) {
    if (stopped) throw new DOMException('Aborted', 'AbortError');
    const handle = await dir.getFileHandle(`${prefix}.${segment.index}.part`, { create: false });
    const file = await handle.getFile();

    for (let at = 0; at < file.size; at += CHUNK) {
      if (stopped) throw new DOMException('Aborted', 'AbortError');
      const slice = file.slice(at, Math.min(at + CHUNK, file.size));
      digest.update(new Uint8Array(await slice.arrayBuffer()));
      done += slice.size;
      if (totalBytes > 0) self.postMessage({ type: 'progress', done, total: totalBytes });
    }
  }
  return digest.digest();
}
