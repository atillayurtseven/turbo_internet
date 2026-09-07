import {
  ACTIVE_STATUSES,
  KEEPALIVE_INTERVAL_MS,
  KIND,
  MSG,
  PROGRESS_INTERVAL_MS,
  STATUS,
  TERMINAL_STATUSES,
} from '../shared/constants.js';
import { planSegments, segmentCount } from '../background/rules.js';
import { sanitizeFilename } from '../shared/filetypes.js';
import { HttpError, probe } from './probe.js';
import { loadPlaylist } from './hls.js';
import {
  MAX_PART_BYTES,
  assemble,
  deleteParts,
  pruneOrphans,
  quota,
  requestPersistence,
} from './opfs.js';

/**
 * Owns every live download. Runs in the offscreen document so it is not killed
 * by the service worker idle timeout.
 */
export class Engine {
  #tasks = new Map();
  #workers = new Map();
  #probes = new Map();
  #blobs = new Map();
  // Playlist parts live here, never on the task: they hold CryptoKey objects
  // that must not travel into persisted state.
  #hlsParts = new Map();
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
    // The service worker marks a task paused before the engine has stopped, so
    // a quick Resume could otherwise start a second worker on the same files.
    if (this.#workers.has(task.id)) return;
    const existing = this.#tasks.get(task.id) ?? task;
    this.#tasks.set(task.id, { ...existing, status: STATUS.QUEUED, error: '', speed: 0 });
    this.#push();
    this.#pump();
  }

  async retry(task) {
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
    this.#hlsParts.delete(task.id);
    // Awaited, and after the worker is gone: a pending delete used to race the
    // restarted worker and remove part files it had just created.
    this.#terminate(task.id);
    await deleteParts(task.id);
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
    await deleteParts(id);
    // Parsed playlists hold CryptoKey objects; dropping the task alone left
    // them alive for as long as the offscreen document lived.
    this.#hlsParts.delete(id);
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
    // Safe now: Chrome has finished reading the parts through the blob.
    this.#tasks.delete(id);
    this.#hlsParts.delete(id);
    deleteParts(id).catch((error) => console.warn('[dlman/engine] cleanup failed', error));
    this.#pump();
  }

  // ---- internals -----------------------------------------------------------

  #activeCount() {
    // Remuxing and assembling count as busy: otherwise the concurrency limit is
    // exceeded and the keepalive stops during a long conversion.
    let active = 0;
    for (const task of this.#tasks.values()) {
      if (ACTIVE_STATUSES.has(task.status)) active += 1;
    }
    return active;
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
    if (task.kind === KIND.HLS) {
      // The parsed playlist is lost whenever the offscreen document restarts,
      // so it is re-read rather than trusted from persisted state. The status
      // check belongs inside: a resumed task still holds its parts, and
      // checking unconditionally left it stuck in the queue forever.
      if (!this.#hlsParts.has(task.id)) {
        await this.#prepareHls(task);
        if (task.status !== STATUS.PROBING) return;
      }
    } else {
      const hasPlan = Array.isArray(task.segments) && task.segments.length > 0;
      if (!hasPlan) {
        await this.#probeTask(task);
        if (task.status !== STATUS.PROBING) return; // paused or canceled mid-probe
      }
    }
    this.#setStatus(task, STATUS.DOWNLOADING);
    this.#spawn(task);
  }

  async #probeTask(task) {
    this.#setStatus(task, STATUS.PROBING);
    const controller = new AbortController();
    this.#probes.set(task.id, controller);

    try {
      // Retried like a segment is: a transient 5xx on the very first request
      // used to kill the download outright, even though every later request
      // would have been retried.
      const result = await this.#retry(() =>
        probe(task.url, { referrer: task.referrer, signal: controller.signal }),
      );
      // The original URL is kept: it is what the duplicate guards match on,
      // and overwriting it here let a redirected file be downloaded twice.
      task.resolvedUrl = result.url;
      task.totalBytes = result.totalBytes || task.totalBytes;
      task.mime = task.mime || result.mime;
      if (result.filename) task.filename = sanitizeFilename(result.filename);
      task.rangeSupported = result.rangeSupported;
      console.info('[dlman/engine] probe', task.filename, {
        totalBytes: result.totalBytes,
        rangeSupported: result.rangeSupported,
      });

      if (!result.rangeSupported && !this.#settings.fallbackSingleConnection) {
        throw new Error('range-unsupported');
      }

      // Parts are staged on disk before being handed to Chrome, so the file
      // has to fit in the origin's storage quota on top of its final location.
      const { free } = await quota();
      if (task.totalBytes > 0 && task.totalBytes > free) {
        throw new Error(`not enough browser storage: needs ${task.totalBytes}, free ${free}`);
      }

      if (!result.rangeSupported && task.totalBytes > MAX_PART_BYTES) {
        throw new Error('file too large to download over a single connection');
      }

      const count =
        result.rangeSupported && this.#settings.probeRanges
          ? segmentCount(
              { connections: task.connections },
              task.totalBytes,
              this.#settings.minSegmentSizeBytes,
              MAX_PART_BYTES,
            )
          : 1;
      task.segments = planSegments(task.totalBytes, count);
      task.connections = task.segments.length;
    } finally {
      this.#probes.delete(task.id);
    }
  }

  /**
   * MPEG-TS plays in few things outside VLC, so a stream that came down as TS
   * is rewrapped as MP4 before delivery. Nothing is re-encoded.
   */
  async #afterDownload(task) {
    const needsRemux =
      task.kind === KIND.HLS && task.container === 'ts' && this.#settings.remuxToMp4;
    if (!needsRemux) {
      await this.#finish(task);
      return;
    }

    this.#setStatus(task, STATUS.REMUXING);
    const worker = new Worker(new URL('./remux-worker.js', import.meta.url), { type: 'module' });
    this.#workers.set(task.id, worker);

    worker.onmessage = (event) => {
      const message = event.data ?? {};
      if (message.type === 'progress') return;
      if (message.type === 'done') {
        this.#onWorkerMessage(task.id, { type: 'remuxed', parts: message.parts });
      } else if (message.type === 'stopped') {
        // Aborted by the user: pausing must not deliver a half-converted file.
        this.#terminate(task.id);
        this.#setStatus(task, STATUS.PAUSED);
      } else if (message.type === 'error') {
        this.#terminate(task.id);
        // The segments are still on disk, so the stream is delivered as TS
        // rather than lost.
        console.warn('[dlman/engine] remux failed, delivering TS', message.message);
        this.#finish(task).catch((error) => this.#fail(task, error));
      }
    };
    worker.onerror = (event) => {
      console.warn('[dlman/engine] remux worker failed, delivering TS', event.message);
      this.#terminate(task.id);
      this.#finish(task).catch((error) => this.#fail(task, error));
    };

    worker.postMessage({
      type: 'start',
      payload: {
        id: task.id,
        count: task.segments.length,
        seconds: task.durationSeconds ?? 0,
        segmentSeconds: (this.#hlsParts.get(task.id) ?? []).map((part) => part.seconds ?? 0),
      },
    });
  }

  /** Reads the playlist and turns it into the task's segment plan. */
  async #prepareHls(task) {
    this.#setStatus(task, STATUS.PROBING);
    const controller = new AbortController();
    this.#probes.set(task.id, controller);

    try {
      const playlist = await this.#retry(() =>
        loadPlaylist(task.url, { referrer: task.referrer, signal: controller.signal }),
      );

      const parts = [];
      if (playlist.init) {
        parts.push({ index: 0, url: playlist.init.url, byteRange: playlist.init.byteRange, key: null, iv: null });
      }
      for (const part of playlist.parts) {
        parts.push({
          index: parts.length,
          url: part.url,
          seconds: part.seconds ?? 0,
          byteRange: part.byteRange,
          key: part.key,
          iv: part.iv,
        });
      }

      this.#hlsParts.set(task.id, parts);
      task.segments = parts.map((part) => ({
        index: part.index,
        start: part.index,
        end: part.index,
        received: 0,
      }));
      task.connections = Math.max(1, Math.min(task.connections, 8));
      task.container = playlist.container;
      task.mime = playlist.container === 'mp4' ? 'video/mp4' : 'video/mp2t';
      task.filename = withExtension(task.filename, playlist.container);
      task.totalBytes = 0;
      task.durationSeconds = playlist.duration;

      console.info('[dlman/engine] playlist', task.filename, {
        segments: parts.length,
        container: playlist.container,
        encrypted: playlist.encrypted,
      });
    } finally {
      this.#probes.delete(task.id);
    }
  }

  /** Runs `attempt` until it succeeds, a retry is pointless, or budget runs out. */
  async #retry(attempt) {
    const tries = this.#settings.segmentRetries + 1;
    let last = null;
    for (let i = 0; i < tries; i += 1) {
      try {
        return await attempt();
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        // A 404 or 403 will not become a 200 by asking again.
        if (error instanceof HttpError && !error.retryable) throw error;
        last = error;
        await delay(Math.min(this.#settings.retryBackoffMs * 2 ** i, 15000));
      }
    }
    throw last;
  }

  #spawn(task) {
    if (this.#workers.has(task.id)) return;
    if (task.kind === KIND.HLS) {
      this.#spawnHls(task);
      return;
    }
    console.info('[dlman/engine] spawning worker', task.filename, `${task.segments.length} segments`);
    const worker = new Worker(new URL('./segment-worker.js', import.meta.url), { type: 'module' });
    this.#workers.set(task.id, worker);

    worker.onmessage = (event) => this.#onWorkerMessage(task.id, event.data);
    worker.onerror = (event) => {
      console.error('[dlman/engine] worker failed to load', event.message, event.filename);
      this.#fail(this.#tasks.get(task.id), new Error(event.message || 'worker-error'));
      this.#terminate(task.id);
    };

    worker.postMessage({
      type: 'start',
      payload: {
        id: task.id,
        url: task.resolvedUrl ?? task.url,
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

  #spawnHls(task) {
    const parts = this.#hlsParts.get(task.id) ?? [];
    console.info('[dlman/engine] spawning hls worker', task.filename, `${parts.length} segments`);
    const worker = new Worker(new URL('./hls-worker.js', import.meta.url), { type: 'module' });
    this.#workers.set(task.id, worker);

    worker.onmessage = (event) => this.#onWorkerMessage(task.id, event.data);
    worker.onerror = (event) => {
      console.error('[dlman/engine] hls worker failed to load', event.message);
      this.#fail(this.#tasks.get(task.id), new Error(event.message || 'worker-error'));
      this.#terminate(task.id);
    };

    worker.postMessage({
      type: 'start',
      payload: {
        id: task.id,
        referrer: task.referrer,
        playlistUrl: task.url,
        connections: task.connections,
        retries: this.#settings.segmentRetries,
        backoffMs: this.#settings.retryBackoffMs,
        segments: parts.map((part) => ({
          index: part.index,
          start: part.index,
          end: part.index,
          received: 0,
          url: part.url,
          byteRange: part.byteRange,
          key: part.key,
          iv: part.iv,
        })),
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
        task.receivedBytes = message.receivedBytes ?? task.receivedBytes;
        this.#terminate(id);
        this.#afterDownload(task).catch((error) => this.#fail(task, error));
        break;

      case 'remuxed':
        this.#terminate(id);
        task.partPrefix = `${task.id}-mux`;
        task.segments = Array.from({ length: message.parts }, (_, index) => ({
          index,
          start: index,
          end: index,
          received: 1,
        }));
        task.container = 'mp4';
        task.mime = 'video/mp4';
        task.filename = withExtension(task.filename, 'mp4');
        this.#finish(task).catch((error) => this.#fail(task, error));
        break;

      case 'error':
        console.error('[dlman/engine] worker error', task.filename, message.message);
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
    const blob = await assemble(task.partPrefix ?? task.id, task.segments, task.mime);

    if (task.totalBytes > 0 && blob.size !== task.totalBytes) {
      throw new Error(`size mismatch: got ${blob.size}, expected ${task.totalBytes}`);
    }
    // A stream's size is only known once every segment is in.
    if (task.totalBytes === 0) task.totalBytes = blob.size;

    // The Blob references the part files on disk; it is not read into memory.
    const blobUrl = URL.createObjectURL(blob);
    this.#blobs.set(task.id, blobUrl);

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        target: 'background',
        type: MSG.DELIVER,
        payload: {
          id: task.id,
          blobUrl,
          filename: task.filename,
          subfolder: task.subfolder,
        },
      });
    } catch (error) {
      // The service worker may be gone; release the URL rather than leak it.
      URL.revokeObjectURL(blobUrl);
      this.#blobs.delete(task.id);
      throw error;
    }

    if (response?.ok) {
      // Handed off: the file is Chrome's to write now, and the service worker
      // flips the task to completed (or failed) when the write actually ends.
      // The task stays here until then -- the blob is backed by the OPFS parts,
      // and dropping it early let the orphan sweep delete them mid-write.
      task.speed = 0;
      task.chromeDownloadId = response.downloadId ?? 0;
      this.#pushNow();
    } else {
      throw new Error(response?.error || 'delivery-failed');
    }
    this.#pump();
  }

  #fail(task, error, detail) {
    if (!task) return;
    this.#hlsParts.delete(task.id);
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
    console.info('[dlman/engine]', task.filename, task.status, '->', status);
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

/** Gives a stream's filename the extension its container actually needs. */
function withExtension(filename, container) {
  const base = String(filename || 'video').replace(/\.(m3u8|mpd|ts|mp4)$/i, '');
  return `${base}.${container === 'mp4' ? 'mp4' : 'ts'}`;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
