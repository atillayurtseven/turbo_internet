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

  const limiter = createLimiter(config.speedLimit);
  progressTimer = setInterval(reportProgress, PROGRESS_INTERVAL_MS);

  try {
    await Promise.all(segments.map((segment) => runSegment(segment, limiter)));
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
  return segments.map(({ index, start, end, received }) => ({ index, start, end, received }));
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
