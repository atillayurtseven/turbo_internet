import { OPFS_DIR } from '../shared/constants.js';

/**
 * Each segment gets its own file.
 *
 * A single preallocated file looks tidier, but OPFS silently refuses to grow
 * one past roughly 2 GB: truncate() reports no error and leaves the file at
 * zero bytes, so a large download ends up empty. Per-segment files stay well
 * under that limit and are joined with a Blob at the end, which is backed by
 * the files on disk rather than by memory.
 */
export const MAX_PART_BYTES = 1024 * 1024 * 1024;

async function dir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create: true });
}

export function partName(taskId, index) {
  return `${taskId}.${index}.part`;
}

/**
 * Joins the segment files, in order, into one Blob.
 *
 * The MIME type matters: Chrome rewrites the extension of a downloaded blob to
 * match its type, so an untyped blob turns "disk.iso" into "disk.txt".
 */
export async function assemble(prefix, segments, type = 'application/octet-stream') {
  const handle = await dir();
  const parts = [];
  // Ordered by offset, not by index: work stealing appends split segments whose
  // index says nothing about where they belong in the file.
  for (const segment of [...segments].sort((a, b) => a.start - b.start)) {
    const file = await handle.getFileHandle(partName(prefix, segment.index), { create: false });
    parts.push(await file.getFile());
  }
  return new Blob(parts, { type: type || 'application/octet-stream' });
}

/** Bytes already on disk per segment, used to resume a paused download. */
export async function partSizes(taskId, segmentCount) {
  const handle = await dir();
  const sizes = [];
  for (let index = 0; index < segmentCount; index += 1) {
    try {
      const file = await handle.getFileHandle(partName(taskId, index), { create: false });
      sizes.push((await file.getFile()).size);
    } catch {
      sizes.push(0);
    }
  }
  return sizes;
}

export async function deleteParts(taskId) {
  const handle = await dir();
  for await (const [name] of handle.entries()) {
    if (name.startsWith(taskId)) {
      try {
        await handle.removeEntry(name);
      } catch {
        // Still held by a worker; the orphan sweep will catch it.
      }
    }
  }
}

/** Removes part files with no matching task, e.g. after a crash. */
export async function pruneOrphans(knownTaskIds) {
  const known = new Set(knownTaskIds);
  const handle = await dir();
  for await (const [name] of handle.entries()) {
    // Remuxed parts are stored under "<id>-mux"; they belong to the same task.
    if (!known.has(name.split('.')[0].replace(/-mux$/, ''))) {
      try {
        await handle.removeEntry(name);
      } catch {
        // In use; it will be cleaned up on the next pass.
      }
    }
  }
}

/** Asks for persistent storage so long downloads survive quota pressure. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
  } catch {
    // Not fatal.
  }
}

export async function quota() {
  try {
    const { quota: total = 0, usage = 0 } = await navigator.storage.estimate();
    return { total, usage, free: Math.max(0, total - usage) };
  } catch {
    return { total: 0, usage: 0, free: Number.POSITIVE_INFINITY };
  }
}
