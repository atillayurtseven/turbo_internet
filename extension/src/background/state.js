import { MAX_HISTORY, PERSIST_INTERVAL_MS, STATUS, TERMINAL_STATUSES } from '../shared/constants.js';

const KEY = 'tasks';

let tasks = [];
let loaded = false;

/**
 * Ids the user removed. The engine's progress snapshots arrive on a timer and
 * carry every task it still holds, so without this a removed row reappeared a
 * moment later and looked impossible to delete.
 */
const removed = new Set();
const MAX_TOMBSTONES = 300;

function tombstone(id) {
  if (!id) return;
  removed.add(id);
  while (removed.size > MAX_TOMBSTONES) removed.delete(removed.values().next().value);
}

export async function loadState() {
  if (loaded) return tasks;
  const stored = await chrome.storage.local.get(KEY);
  tasks = Array.isArray(stored[KEY]) ? stored[KEY] : [];
  loaded = true;
  return tasks;
}

export function getTasks() {
  return tasks;
}

async function persist() {
  await chrome.storage.local.set({ [KEY]: tasks });
}

/**
 * Progress arrives twice a second and carries every segment of every task.
 * Writing that to storage each time serialises megabytes of JSON for a stream
 * with thousands of segments, so progress writes are coalesced; anything the
 * user would lose on a crash is at most a few seconds of counters.
 */
let persistTimer = 0;
function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = 0;
    persist().catch(() => {});
  }, PERSIST_INTERVAL_MS);
}

/** Writes now and drops any pending coalesced write. */
async function persistNow() {
  clearTimeout(persistTimer);
  persistTimer = 0;
  await persist();
}

/** Replaces the mirror with a snapshot coming from the offscreen engine. */
export async function replaceState(snapshot) {
  const live = new Map(snapshot.map((task) => [task.id, task]));
  // Merged, not replaced: the engine does not know about fields this side owns,
  // such as the Chrome download id assigned at delivery.
  const merged = tasks.map((task) => {
    const update = live.get(task.id);
    return update ? { ...task, ...update } : task;
  });
  // A status change must not wait for the coalescing timer: a download that
  // finishes inside that window was recorded as completed with zero bytes.
  let statusChanged = snapshot.some((task) => {
    const before = tasks.find((existing) => existing.id === task.id);
    return !before || before.status !== task.status;
  });

  const known = new Set(merged.map((task) => task.id));
  for (const task of snapshot) {
    if (removed.has(task.id) || known.has(task.id)) continue;
    known.add(task.id);
    merged.push(task);
    statusChanged = true;
  }
  tasks = trim(merged);
  // Terminal snapshots are written straight away even when the status itself
  // did not change: the final byte counts arrive after delivery has already
  // marked the task completed, and coalescing them lost the numbers entirely.
  const finalising = snapshot.some((task) => TERMINAL_STATUSES.has(task.status));
  if (statusChanged || finalising) await persistNow();
  else persistSoon();
  return tasks;
}

export async function upsert(task) {
  if (!task?.id || removed.has(task.id)) return tasks;
  const index = tasks.findIndex((existing) => existing.id === task.id);
  if (index >= 0) tasks[index] = { ...tasks[index], ...task };
  else tasks.unshift(task);
  tasks = trim(tasks);
  await persistNow();
  return tasks;
}

export async function remove(id) {
  tombstone(id);
  tasks = tasks.filter((task) => task.id !== id);
  await persistNow();
  return tasks;
}

export async function clearCompleted(all = false) {
  const dropped = all ? tasks : tasks.filter((task) => TERMINAL_STATUSES.has(task.status));
  for (const task of dropped) tombstone(task.id);
  tasks = all ? [] : tasks.filter((task) => !TERMINAL_STATUSES.has(task.status));
  await persistNow();
  return tasks;
}

/**
 * A browser restart kills in-flight downloads; their partial data survives in
 * OPFS, so they are surfaced as paused rather than silently lost.
 */
export async function markInterrupted() {
  let changed = false;
  for (const task of tasks) {
    if (!TERMINAL_STATUSES.has(task.status) && task.status !== STATUS.PAUSED) {
      task.status = STATUS.PAUSED;
      task.speed = 0;
      changed = true;
    }
  }
  if (changed) await persistNow();
  return tasks;
}

function trim(list) {
  const active = list.filter((task) => !TERMINAL_STATUSES.has(task.status));
  const done = list.filter((task) => TERMINAL_STATUSES.has(task.status));
  return [...active, ...done.slice(0, MAX_HISTORY)];
}
