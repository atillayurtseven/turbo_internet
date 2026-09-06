import {
  KEEPALIVE_INTERVAL_MS,
  MSG,
  PROGRESS_INTERVAL_MS,
  STATUS,
  TERMINAL_STATUSES,
} from '../shared/constants.js';
import { planSegments, segmentCount } from '../background/rules.js';
import { sanitizeFilename } from '../shared/filetypes.js';
import { probe } from './probe.js';
import { deletePart, openPartFile, pruneOrphans, requestPersistence } from './opfs.js';

/**
 * Owns every live download. Runs in the offscreen document so it is not killed
 * by the service worker idle timeout.
 */
export class Engine {
  #tasks = new Map();
  #workers = new Map();
  #probes = new Map();
  #blobs = new Map();
  #settings = null;
  #pushTimer = 0;
  #keepaliveTimer = 0;

  constructor(settings) {
    this.#settings = settings;
    requestPersistence();
  }

  applySettings(settings) {
    this.#settings = settings;
    this.#pump();
  }

  snapshot() {
    return [...this.#tasks.values()].map((task) => ({ ...task, segments: task.segments }));
  }

  enqueue(task) {
    if (this.#tasks.has(task.id)) return;
    this.#tasks.set(task.id, { ...task, status: STATUS.QUEUED });
    this.#push();
    this.#pump();
  }

  pause(id) {
    const task = this.#tasks.get(id);
    if (!task) return;
    this.#probes.get(id)?.abort();
    const worker = this.#workers.get(id);
    if (worker) worker.postMessage({ type: 'stop' });
    else this.#setStatus(task, STATUS.PAUSED);
  }

  resume(task) {
    const existing = this.#tasks.get(task.id) ?? task;
    this.#tasks.set(task.id, { ...existing, status: STATUS.QUEUED, error: '', speed: 0 });
    this.#push();
    this.#pump();
  }

  retry(task) {
    const fresh = {
      ...task,
      status: STATUS.QUEUED,
      error: '',
      speed: 0,
      receivedBytes: 0,
      segments: [],
      rangeSupported: null,
    };
    this.#tasks.set(task.id, fresh);
    deletePart(task.id);
    this.#push();
    this.#pump();
  }

  async cancel(id) {
    const task = this.#tasks.get(id);
    this.#probes.get(id)?.abort();
    const worker = this.#workers.get(id);
    if (worker) {
      worker.postMessage({ type: 'stop' });
      // Give the worker a moment to release its OPFS handle before deleting.
      await new Promise((resolve) => setTimeout(resolve, 100));
      this.#terminate(id);
    }
    await deletePart(id);
    if (task) {
      task.status = STATUS.CANCELED;
      task.speed = 0;
    }
    this.#pushNow();
    this.#tasks.delete(id);
    this.#pump();
  }

  releaseBlob(id, blobUrl) {
    URL.revokeObjectURL(blobUrl ?? this.#blobs.get(id));
    this.#blobs.delete(id);
    deletePart(id);
  }

  // ---- internals -----------------------------------------------------------

  #activeCount() {
    return [...this.#tasks.values()].filter(
      (task) => task.status === STATUS.PROBING || task.status === STATUS.DOWNLOADING,
    ).length;
  }

  /** Starts queued tasks up to the concurrency limit. */
  #pump() {
    const limit = this.#settings.maxConcurrentDownloads;
    for (const task of this.#tasks.values()) {
      if (this.#activeCount() >= limit) break;
      if (task.status !== STATUS.QUEUED) continue;
      this.#start(task).catch((error) => {
        // Aborting is how pause and cancel unwind a probe; it is not a failure.
        if (error?.name !== 'AbortError') this.#fail(task, error);
      });
    }
    this.#updateKeepalive();
  }

  async #start(task) {
    const hasPlan = Array.isArray(task.segments) && task.segments.length > 0;
    if (!hasPlan) {
      await this.#probeTask(task);
      if (task.status !== STATUS.PROBING) return; // paused or canceled mid-probe
    }
    this.#setStatus(task, STATUS.DOWNLOADING);
    this.#spawn(task);
  }

  async #probeTask(task) {
    this.#setStatus(task, STATUS.PROBING);
    const controller = new AbortController();
    this.#probes.set(task.id, controller);

    try {
      const result = await probe(task.url, { referrer: task.referrer, signal: controller.signal });
      task.url = result.url;
      task.totalBytes = result.totalBytes || task.totalBytes;
      task.mime = task.mime || result.mime;
      if (result.filename) task.filename = sanitizeFilename(result.filename);
      task.rangeSupported = result.rangeSupported;

      if (!result.rangeSupported && !this.#settings.fallbackSingleConnection) {
        throw new Error('range-unsupported');
      }

      const count =
        result.rangeSupported && this.#settings.probeRanges
          ? segmentCount(
              { connections: task.connections },
              task.totalBytes,
              this.#settings.minSegmentSizeBytes,
            )
          : 1;
      task.segments = planSegments(task.totalBytes, count);
      task.connections = task.segments.length;
    } finally {
      this.#probes.delete(task.id);
    }
  }

  #spawn(task) {
    const worker = new Worker(new URL('./segment-worker.js', import.meta.url), { type: 'module' });
    this.#workers.set(task.id, worker);

    worker.onmessage = (event) => this.#onWorkerMessage(task.id, event.data);
    worker.onerror = (event) => {
      this.#fail(this.#tasks.get(task.id), new Error(event.message || 'worker-error'));
      this.#terminate(task.id);
    };

    worker.postMessage({
      type: 'start',
      payload: {
        id: task.id,
        url: task.url,
        referrer: task.referrer,
        totalBytes: task.totalBytes,
        rangeSupported: Boolean(task.rangeSupported),
        segments: task.segments,
        retries: this.#settings.segmentRetries,
        backoffMs: this.#settings.retryBackoffMs,
        // The global cap is shared between the downloads running right now.
        speedLimit: this.#perTaskSpeedLimit(),
      },
    });

    task.startedAt = Date.now();
    task.lastSample = { bytes: task.receivedBytes, at: Date.now() };
  }

  #perTaskSpeedLimit() {
    const limit = this.#settings.maxSpeedBytesPerSec;
    if (!limit) return 0;
    return Math.max(16 * 1024, Math.floor(limit / Math.max(1, this.#activeCount() || 1)));
  }

  #onWorkerMessage(id, message) {
    const task = this.#tasks.get(id);
    if (!task) return;

    switch (message.type) {
      case 'progress':
        task.segments = message.segments;
        this.#sample(task, message.receivedBytes);
        this.#push();
        break;

      case 'stopped':
        task.segments = message.segments;
        task.receivedBytes = message.segments.reduce((sum, s) => sum + s.received, 0);
        this.#terminate(id);
        this.#setStatus(task, STATUS.PAUSED);
        this.#pump();
        break;

      case 'done':
        task.receivedBytes = task.totalBytes || task.receivedBytes;
        this.#terminate(id);
        this.#finish(task).catch((error) => this.#fail(task, error));
        break;

      case 'error':
        task.segments = message.segments ?? task.segments;
        this.#terminate(id);
        this.#fail(task, new Error(message.message), message);
        this.#pump();
        break;

      default:
        break;
    }
  }

  /** Exponentially smoothed transfer rate, so the UI does not flicker. */
  #sample(task, receivedBytes) {
    const now = Date.now();
    const previous = task.lastSample ?? { bytes: receivedBytes, at: now - PROGRESS_INTERVAL_MS };
    const elapsed = Math.max(1, now - previous.at) / 1000;
    const instant = Math.max(0, receivedBytes - previous.bytes) / elapsed;
    task.speed = task.speed ? task.speed * 0.7 + instant * 0.3 : instant;
    task.receivedBytes = receivedBytes;
    task.lastSample = { bytes: receivedBytes, at: now };
  }

  async #finish(task) {
    this.#setStatus(task, STATUS.ASSEMBLING);
    const file = await openPartFile(task.id);

    if (task.totalBytes > 0 && file.size !== task.totalBytes) {
      throw new Error('size-mismatch');
    }

    // Backed by the OPFS file on disk — creating the URL does not read it in.
    const blobUrl = URL.createObjectURL(file);
    this.#blobs.set(task.id, blobUrl);

    const response = await chrome.runtime.sendMessage({
      target: 'background',
      type: MSG.DELIVER,
      payload: {
        id: task.id,
        blobUrl,
        filename: task.filename,
        subfolder: task.subfolder,
      },
    });

    if (response?.ok) {
      task.completedAt = Date.now();
      task.speed = 0;
      task.status = STATUS.COMPLETED;
      this.#pushNow();
      this.#tasks.delete(task.id);
    } else {
      throw new Error(response?.error || 'delivery-failed');
    }
    this.#pump();
  }

  #fail(task, error, detail) {
    if (!task) return;
    task.error = detail?.segmentIndex >= 0
      ? `segment ${detail.segmentIndex}: ${error.message}`
      : String(error?.message || error);
    task.speed = 0;
    this.#setStatus(task, STATUS.ERROR);
  }

  #terminate(id) {
    const worker = this.#workers.get(id);
    if (worker) {
      worker.terminate();
      this.#workers.delete(id);
    }
  }

  #setStatus(task, status) {
    task.status = status;
    if (TERMINAL_STATUSES.has(status)) task.speed = 0;
    this.#push();
    this.#updateKeepalive();
  }

  /** Throttled snapshot to the service worker; it persists and broadcasts. */
  #push() {
    if (this.#pushTimer) return;
    this.#pushTimer = setTimeout(() => {
      this.#pushTimer = 0;
      chrome.runtime
        .sendMessage({ target: 'background', type: MSG.STATE_UPDATE, payload: this.snapshot() })
        .catch(() => {});
    }, PROGRESS_INTERVAL_MS);
  }

  /** Immediate, unthrottled snapshot — used before a task leaves the map. */
  #pushNow() {
    clearTimeout(this.#pushTimer);
    this.#pushTimer = 0;
    chrome.runtime
      .sendMessage({ target: 'background', type: MSG.STATE_UPDATE, payload: this.snapshot() })
      .catch(() => {});
  }

  /**
   * Message traffic resets the service worker idle timer. Without this the
   * worker dies mid-download and cannot hand the finished blob to
   * chrome.downloads.
   */
  #updateKeepalive() {
    const busy = this.#activeCount() > 0;
    if (busy && !this.#keepaliveTimer) {
      this.#keepaliveTimer = setInterval(() => {
        chrome.runtime
          .sendMessage({ target: 'background', type: MSG.STATE_UPDATE, payload: this.snapshot() })
          .catch(() => {});
      }, KEEPALIVE_INTERVAL_MS);
    } else if (!busy && this.#keepaliveTimer) {
      clearInterval(this.#keepaliveTimer);
      this.#keepaliveTimer = 0;
      pruneOrphans([...this.#tasks.keys()]).catch(() => {});
    }
  }
}
