/**
 * Downloads the segments of an HLS playlist in parallel, decrypting AES-128
 * streams on the way, and writes each one to its own OPFS file. Unlike the
 * byte-range worker there is nothing to split: the playlist already gives the
 * work in pieces, so a free lane simply takes the next one.
 */
import { OPFS_DIR, PROGRESS_INTERVAL_MS } from '../shared/constants.js';
import { referrerInit, HttpError } from './probe.js';

let controller = null;
let config = null;
let segments = [];
let received = 0;
let cursor = 0;
let progressTimer = 0;
let running = false;

self.onmessage = async (event) => {
  const { type, payload } = event.data ?? {};
  try {
    if (type === 'start') await start(payload);
    else if (type === 'stop') controller?.abort();
  } catch (error) {
    fail(error);
  }
};

async function start(payload) {
  if (running) return;
  running = true;
  config = payload;
  segments = payload.segments.map((segment) => ({ ...segment }));
  controller = new AbortController();
  received = 0;
  cursor = 0;

  console.info('[dlman/hls] start', config.id, {
    segments: segments.length,
    encrypted: segments.some((segment) => Boolean(segment.key)),
  });

  const dir = await openDir();
  progressTimer = setInterval(report, PROGRESS_INTERVAL_MS);

  // Segments already on disk from an interrupted run are not fetched again.
  for (const segment of segments) {
    const size = await existingSize(dir, segment.index);
    if (size > 0) {
      segment.received = 1;
      received += size;
    }
  }

  const lanes = Math.max(1, Math.min(config.connections, segments.length));
  try {
    await Promise.all(Array.from({ length: lanes }, () => runLane(dir)));
    clearInterval(progressTimer);
    report();
    self.postMessage({ type: 'done', receivedBytes: received });
  } catch (error) {
    clearInterval(progressTimer);
    if (controller.signal.aborted) self.postMessage({ type: 'stopped', segments: snapshot() });
    else fail(error);
  } finally {
    running = false;
  }
}

async function runLane(dir) {
  while (true) {
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const segment = segments[cursor];
    if (!segment) return;
    cursor += 1;
    if (segment.received) continue;
    await withRetry(segment, dir);
  }
}

async function withRetry(segment, dir) {
  const attempts = config.retries + 1;
  let last = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      await fetchSegment(segment, dir);
      return;
    } catch (error) {
      if (controller.signal.aborted) throw error;
      last = error;
      if (error instanceof HttpError && !error.retryable) break;
      await sleep(Math.min(config.backoffMs * 2 ** attempt, 30000));
    }
  }

  const error = new Error(last?.message || 'segment failed');
  error.segmentIndex = segment.index;
  throw error;
}

async function fetchSegment(segment, dir) {
  const range = segment.byteRange;
  const response = await fetch(segment.url, {
    headers: range
      ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` }
      : {},
    credentials: 'include',
    cache: 'no-store',
    redirect: 'follow',
    signal: controller.signal,
    ...referrerInit(config.referrer),
  });
  if (!response.ok) throw new HttpError(response.status);
  // Without 206 the server sent the whole file and the segment would be wrong.
  if (range && response.status !== 206) throw new Error('server ignored byte range');

  let bytes = new Uint8Array(await response.arrayBuffer());
  if (segment.key) {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: segment.iv },
      segment.key.cryptoKey,
      bytes,
    );
    bytes = new Uint8Array(plain);
  }

  const file = await dir.getFileHandle(`${config.id}.${segment.index}.part`, { create: true });
  const handle = await file.createSyncAccessHandle();
  try {
    handle.truncate(0);
    handle.write(bytes, { at: 0 });
    handle.flush();
  } finally {
    handle.close();
  }

  segment.received = 1;
  received += bytes.byteLength;
}

async function existingSize(dir, index) {
  try {
    const file = await dir.getFileHandle(`${config.id}.${index}.part`, { create: false });
    return (await file.getFile()).size;
  } catch {
    return 0;
  }
}

function snapshot() {
  return segments.map(({ index, start, end, received: got }) => ({
    index,
    start,
    end,
    received: got,
  }));
}

function report() {
  self.postMessage({ type: 'progress', segments: snapshot(), receivedBytes: received });
}

function fail(error) {
  console.error('[dlman/hls] failed', error);
  self.postMessage({
    type: 'error',
    message: String(error?.message || error),
    segmentIndex: error?.segmentIndex ?? -1,
    segments: snapshot(),
  });
}

async function openDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create: true });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
