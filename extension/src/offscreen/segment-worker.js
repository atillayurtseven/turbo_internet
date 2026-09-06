/**
 * One worker per download. Every segment writes to its own OPFS file through an
 * exclusive sync access handle, so nothing is buffered in memory beyond a
 * single chunk and no file ever approaches the ~2 GB ceiling that makes large
 * OPFS files fail silently.
 */
import { OPFS_DIR, PROGRESS_INTERVAL_MS } from '../shared/constants.js';
import { referrerInit, HttpError } from './probe.js';

let handles = new Map();
let controller = null;
let config = null;
let segments = [];
let progressTimer = 0;
let running = false;
let nextIndex = 0;

/**
 * Work stealing. A connection that finishes early would otherwise idle while
 * the slowest segment holds up the whole download, so it takes over the second
 * half of whichever segment has the most left to do.
 */
const MIN_SPLIT_BYTES = 1024 * 1024;
const MAX_SEGMENTS = 32;
// Past this share of the file, another connection costs more than it saves --
// and it is the guard that keeps splitting from chasing its own tail.
const SPLIT_STOP_RATIO = 0.9;

self.onmessage = async (event) => {
  const { type, payload } = event.data ?? {};
  try {
    if (type === 'start') await start(payload);
    else if (type === 'stop') await stop();
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

  const dir = await openDir();
  for (const segment of segments) {
    const file = await dir.getFileHandle(`${config.id}.${segment.index}.part`, { create: true });
    const handle = await file.createSyncAccessHandle();
    // The file on disk is the authority on how much of this segment is done.
    segment.received = handle.getSize();
    handles.set(segment.index, handle);
  }

  console.info('[dlman/worker] start', config.id, {
    segments: segments.length,
    totalBytes: config.totalBytes,
    rangeSupported: config.rangeSupported,
    resumedBytes: totalReceived(),
  });

  nextIndex = Math.max(...segments.map((segment) => segment.index)) + 1;
  const limiter = createLimiter(config.speedLimit);
  progressTimer = setInterval(reportProgress, PROGRESS_INTERVAL_MS);

  try {
    // One lane per planned segment; a lane picks up stolen work when it frees up.
    await Promise.all(segments.map((segment) => runLane(segment, limiter)));
    closeHandles();
    clearInterval(progressTimer);
    reportProgress();
    self.postMessage({ type: 'done', receivedBytes: totalReceived() });
  } catch (error) {
    closeHandles();
    clearInterval(progressTimer);
    if (controller.signal.aborted) self.postMessage({ type: 'stopped', segments: snapshot() });
    else fail(error);
  } finally {
    running = false;
  }
}

async function stop() {
  controller?.abort();
}

async function runLane(segment, limiter) {
  let current = segment;
  while (current) {
    await runSegment(current, limiter);
    current.done = true;
    current = config.rangeSupported ? await steal() : null;
  }
}

/**
 * Halves the segment with the most work left and returns the new tail, or null
 * when nothing is worth splitting.
 */
async function steal() {
  if (controller.signal.aborted || segments.length >= MAX_SEGMENTS) return null;
  if (config.totalBytes > 0 && totalReceived() / config.totalBytes > SPLIT_STOP_RATIO) return null;

  let donor = null;
  let most = 0;
  for (const segment of segments) {
    if (segment.done || segment.end === null) continue;
    const remaining = segment.end - segment.start + 1 - segment.received;
    if (remaining > most) {
      most = remaining;
      donor = segment;
    }
  }
  if (!donor || most < MIN_SPLIT_BYTES * 2) return null;

  // Recomputed here: the donor keeps downloading while this runs.
  const cursor = donor.start + donor.received;
  const tailStart = cursor + Math.floor((donor.end - cursor + 1) / 2);
  if (tailStart <= cursor || donor.end - tailStart + 1 < MIN_SPLIT_BYTES) return null;

  const tail = { index: nextIndex++, start: tailStart, end: donor.end, received: 0, done: false };
  donor.end = tailStart - 1;
  segments.push(tail);

  const dir = await openDir();
  const file = await dir.getFileHandle(`${config.id}.${tail.index}.part`, { create: true });
  handles.set(tail.index, await file.createSyncAccessHandle());

  console.info('[dlman/worker] split', `seg${donor.index} -> seg${tail.index}`, {
    donorEnd: donor.end,
    tailStart,
    tailBytes: tail.end - tail.start + 1,
  });
  return tail;
}

async function runSegment(segment, limiter) {
  const attempts = config.retries + 1;
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (isSegmentComplete(segment)) return;

    try {
      await fetchSegment(segment, limiter);
      return;
    } catch (error) {
      if (controller.signal.aborted) throw error;
      lastError = error;
      if (error instanceof HttpError && !error.retryable) break;
      await sleep(Math.min(config.backoffMs * 2 ** attempt, 30000), controller.signal);
    }
  }

  const error = new Error(lastError?.message || 'segment failed');
  error.segmentIndex = segment.index;
  error.attempts = attempts;
  throw error;
}

async function fetchSegment(segment, limiter) {
  const from = segment.start + segment.received;
  const headers = {};
  if (config.rangeSupported) {
    headers.Range = segment.end === null ? `bytes=${from}-` : `bytes=${from}-${segment.end}`;
  }

  const response = await fetch(config.url, {
    method: 'GET',
    headers,
    credentials: 'include',
    cache: 'no-store',
    redirect: 'follow',
    signal: controller.signal,
    ...referrerInit(config.referrer),
  });

  if (!response.ok) throw new HttpError(response.status);
  // A server that ignores Range would restart the body and corrupt the part.
  if (config.rangeSupported && response.status !== 206) throw new HttpError(response.status);
  if (!response.body) throw new Error('empty response body');

  const handle = handles.get(segment.index);
  const reader = response.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (limiter) await limiter.take(value.byteLength);
    // Offsets are relative to this segment's own file.
    handle.write(value, { at: segment.received });
    segment.received += value.byteLength;

    // The end may have been lowered by a split while this request was running;
    // stop here and drop whatever the last chunk carried past it.
    if (segment.end !== null) {
      const needed = segment.end - segment.start + 1;
      if (segment.received >= needed) {
        if (segment.received > needed) {
          handle.truncate(needed);
          segment.received = needed;
        }
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }

  if (segment.end !== null && !isSegmentComplete(segment)) throw new Error('short read');
}

function isSegmentComplete(segment) {
  if (segment.end === null) return false;
  return segment.received >= segment.end - segment.start + 1;
}

function totalReceived() {
  return segments.reduce((sum, segment) => sum + segment.received, 0);
}

function snapshot() {
  return segments.map(({ index, start, end, received, done }) => ({
    index,
    start,
    end,
    received,
    done: Boolean(done),
  }));
}

function reportProgress() {
  self.postMessage({ type: 'progress', segments: snapshot(), receivedBytes: totalReceived() });
}

function fail(error) {
  console.error('[dlman/worker] failed', error);
  self.postMessage({
    type: 'error',
    message: String(error?.message || error),
    segmentIndex: error?.segmentIndex ?? -1,
    attempts: error?.attempts ?? 0,
    segments: snapshot(),
  });
}

function closeHandles() {
  for (const handle of handles.values()) {
    try {
      handle.flush();
      handle.close();
    } catch {
      // Already closed.
    }
  }
  handles = new Map();
}

async function openDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create: true });
}

/** Token bucket shared by every segment of this download. */
function createLimiter(bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond <= 0) return null;
  let tokens = bytesPerSecond;
  let last = performance.now();

  return {
    async take(bytes) {
      while (true) {
        const now = performance.now();
        tokens = Math.min(bytesPerSecond, tokens + ((now - last) / 1000) * bytesPerSecond);
        last = now;
        if (tokens >= bytes) {
          tokens -= bytes;
          return;
        }
        await sleep(Math.min(((bytes - tokens) / bytesPerSecond) * 1000, 250), controller.signal);
      }
    },
  };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}
