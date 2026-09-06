/**
 * One worker per download. It owns the exclusive OPFS sync access handle for
 * the part file and runs every segment fetch, writing each chunk straight to
 * its byte offset. Nothing is buffered in memory beyond a single chunk.
 */
import { OPFS_DIR, PROGRESS_INTERVAL_MS } from '../shared/constants.js';
import { referrerInit, HttpError } from './probe.js';

let accessHandle = null;
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

  console.info('[dlman/worker] start', config.id, {
    segments: segments.length,
    totalBytes: config.totalBytes,
    rangeSupported: config.rangeSupported,
  });
  accessHandle = await openHandle(config.id);
  if (config.totalBytes > 0) accessHandle.truncate(config.totalBytes);

  const limiter = createLimiter(config.speedLimit);
  progressTimer = setInterval(reportProgress, PROGRESS_INTERVAL_MS);

  try {
    await Promise.all(segments.map((segment) => runSegment(segment, limiter)));
    if (config.totalBytes <= 0) accessHandle.truncate(totalReceived());
    accessHandle.flush();
    close();
    reportProgress();
    self.postMessage({ type: 'done', totalBytes: config.totalBytes || totalReceived() });
  } catch (error) {
    if (controller.signal.aborted) {
      flushAndClose();
      self.postMessage({ type: 'stopped', segments: snapshot() });
    } else {
      flushAndClose();
      fail(error);
    }
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
      // Exponential backoff, capped so a long outage does not stall forever.
      const delay = Math.min(config.backoffMs * 2 ** attempt, 30000);
      await sleep(delay, controller.signal);
    }
  }

  const error = new Error(`segment-failed:${segment.index}`);
  error.segmentIndex = segment.index;
  error.attempts = attempts;
  error.cause = lastError;
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
  if (config.rangeSupported && response.status !== 206) {
    // The server ignored the Range header; continuing would corrupt the file.
    throw new HttpError(response.status);
  }
  if (!response.body) throw new Error('empty-body');

  const reader = response.body.getReader();
  let position = from;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (limiter) await limiter.take(value.byteLength);
    accessHandle.write(value, { at: position });
    position += value.byteLength;
    segment.received += value.byteLength;
  }

  if (!isSegmentComplete(segment) && segment.end !== null) {
    throw new Error('short-read');
  }
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
  self.postMessage({
    type: 'error',
    message: String(error?.message || error),
    segmentIndex: error?.segmentIndex ?? -1,
    attempts: error?.attempts ?? 0,
    segments: snapshot(),
  });
}

function flushAndClose() {
  try {
    accessHandle?.flush();
  } catch {
    // The handle may already be closed.
  }
  close();
}

function close() {
  clearInterval(progressTimer);
  progressTimer = 0;
  try {
    accessHandle?.close();
  } catch {
    // Already closed.
  }
  accessHandle = null;
}

async function openHandle(taskId) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
  const file = await dir.getFileHandle(`${taskId}.part`, { create: true });
  return file.createSyncAccessHandle();
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
        const waitMs = ((bytes - tokens) / bytesPerSecond) * 1000;
        await sleep(Math.min(waitMs, 250), controller.signal);
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
