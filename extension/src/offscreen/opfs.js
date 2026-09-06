import { OPFS_DIR } from '../shared/constants.js';

async function dir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create: true });
}

export function partName(taskId) {
  return `${taskId}.part`;
}

/** The finished part file as a File — backed by disk, not copied into memory. */
export async function openPartFile(taskId) {
  const handle = await (await dir()).getFileHandle(partName(taskId), { create: false });
  return handle.getFile();
}

export async function deletePart(taskId) {
  try {
    await (await dir()).removeEntry(partName(taskId));
  } catch {
    // Already gone.
  }
}

/** Removes part files with no matching task, e.g. after a crash. */
export async function pruneOrphans(knownTaskIds) {
  const known = new Set(knownTaskIds.map(partName));
  const handle = await dir();
  for await (const [name] of handle.entries()) {
    if (!known.has(name)) {
      try {
        await handle.removeEntry(name);
      } catch {
        // In use by a worker; it will be cleaned up on the next pass.
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
