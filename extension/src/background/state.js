import { MAX_HISTORY, STATUS, TERMINAL_STATUSES } from '../shared/constants.js';

const KEY = 'tasks';

let tasks = [];
let loaded = false;

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

/** Replaces the mirror with a snapshot coming from the offscreen engine. */
export async function replaceState(snapshot) {
  const live = new Map(snapshot.map((task) => [task.id, task]));
  const merged = tasks.map((task) => live.get(task.id) ?? task);
  for (const task of snapshot) {
    if (!merged.some((existing) => existing.id === task.id)) merged.push(task);
  }
  tasks = trim(merged);
  await persist();
  return tasks;
}

export async function upsert(task) {
  const index = tasks.findIndex((existing) => existing.id === task.id);
  if (index >= 0) tasks[index] = { ...tasks[index], ...task };
  else tasks.unshift(task);
  tasks = trim(tasks);
  await persist();
  return tasks;
}

export async function remove(id) {
  tasks = tasks.filter((task) => task.id !== id);
  await persist();
  return tasks;
}

export async function clearCompleted(all = false) {
  tasks = all ? [] : tasks.filter((task) => !TERMINAL_STATUSES.has(task.status));
  await persist();
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
  if (changed) await persist();
  return tasks;
}

function trim(list) {
  const active = list.filter((task) => !TERMINAL_STATUSES.has(task.status));
  const done = list.filter((task) => TERMINAL_STATUSES.has(task.status));
  return [...active, ...done.slice(0, MAX_HISTORY)];
}
