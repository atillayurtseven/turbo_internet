import { MSG, STATUS, TERMINAL_STATUSES } from '../shared/constants.js';
import { applyI18n, initI18n, t } from '../shared/i18n.js';
import { formatBytes, formatEta, formatSpeed, percent } from '../shared/format.js';
import { extensionOf } from '../shared/filetypes.js';

const list = document.getElementById('list');
const template = document.getElementById('row-template');
let tasks = [];

init();

async function init() {
  const state = await send(MSG.GET_STATE);
  await initI18n(state?.settings?.language);
  applyI18n();

  document.getElementById('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  // Shift-click wipes the whole list, stuck entries included.
  document.getElementById('clear').addEventListener('click', async (event) => {
    await send(MSG.CLEAR_COMPLETED, { all: event.shiftKey });
  });

  document.getElementById('paste-go').addEventListener('click', submitPaste);
  document.getElementById('paste-url').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitPaste();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.target !== 'ui' || message.type !== MSG.STATE_BROADCAST) return;
    render(message.payload);
    renderSources();
  });

  render(state?.tasks ?? []);
  renderSources();
}

async function submitPaste() {
  const input = document.getElementById('paste-url');
  const url = input.value.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return;
  input.value = '';
  await send(MSG.DOWNLOAD_URL, { url, kind: /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'file' });
}

/**
 * Everything the user can start by hand: media spotted on the page, and the
 * last copied link. Chrome cannot watch the clipboard in the background, so
 * the OS clipboard is read here, when the popup opens and has focus.
 */
async function renderSources() {
  const box = document.getElementById('sources');
  const [media, copied] = await Promise.all([
    send(MSG.GET_MEDIA).then((r) => r?.media ?? []),
    readClipboard(),
  ]);

  // Same reasoning as the task list: rebuilding eats clicks on the buttons.
  const key = JSON.stringify([copied?.url ?? '', media.map((item) => item.url)]);
  if (key === box.dataset.key) return;
  box.dataset.key = key;

  const rows = [];
  if (copied) rows.push(sourceRow({ ...copied, heading: t('popup.clipboard') }));
  for (const item of media) rows.push(sourceRow({ ...item, heading: t('popup.mediaFound') }));

  box.replaceChildren();
  let heading = '';
  for (const { node, group } of rows) {
    if (group !== heading) {
      heading = group;
      const title = document.createElement('h2');
      title.textContent = group;
      if (group === t('popup.mediaFound')) {
        const clear = document.createElement('button');
        clear.className = 'clear-media';
        clear.textContent = t('popup.clearMedia');
        clear.addEventListener('click', async () => {
          box.dataset.key = '';
          await send(MSG.CLEAR_MEDIA);
          renderSources();
        });
        title.append(clear);
      }
      box.append(title);
    }
    box.append(node);
  }
  box.hidden = rows.length === 0;
}

function sourceRow(item) {
  const node = document.createElement('div');
  node.className = 'source';
  if (item.unsupported) node.classList.add('off');

  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = item.label ?? 'URL';

  const who = document.createElement('div');
  who.className = 'who';
  const name = document.createElement('b');
  name.textContent = item.name ?? item.url;
  const sub = document.createElement('small');
  sub.textContent = item.unsupported
    ? t('popup.unsupported')
    : item.bytes > 0
      ? formatBytes(item.bytes)
      : hostOf(item.url);
  who.append(name, sub);
  who.title = item.url;

  const button = document.createElement('button');
  button.className = 'primary';
  button.textContent = t('popup.download');
  button.disabled = Boolean(item.unsupported);
  button.addEventListener('click', async () => {
    button.disabled = true;
    await send(MSG.DOWNLOAD_MEDIA, { url: item.url, name: item.name, kind: item.kind });
  });

  node.append(tag, who, button);
  return { node, group: item.heading };
}

async function readClipboard() {
  const stored = await send(MSG.GET_CLIPBOARD).then((r) => r?.clipboard ?? null);
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (/^https?:\/\/\S+$/i.test(text)) {
      return { url: text, name: nameOf(text), label: 'URL', kind: kindOf(text) };
    }
  } catch {
    // No clipboard permission or no focus; the copy listener still provides one.
  }
  return stored ? { ...stored, name: nameOf(stored.url), label: 'URL', kind: kindOf(stored.url) } : null;
}

const kindOf = (url) => (/\.m3u8(\?|$)/i.test(url) ? 'hls' : 'file');

function nameOf(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || url);
  } catch {
    return url;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function send(type, payload) {
  return chrome.runtime.sendMessage({ target: 'background', type, payload }).catch(() => null);
}

/**
 * Rows are updated in place rather than rebuilt.
 *
 * Rebuilding the whole list on every broadcast destroyed each button between
 * mousedown and mouseup, so clicks on Pause, Cancel and Remove were regularly
 * swallowed -- and broadcasts are frequent while media detection is running.
 */
const rows = new Map();
let emptyNode = null;

function render(next) {
  tasks = next;

  if (tasks.length === 0) {
    for (const entry of rows.values()) entry.node.remove();
    rows.clear();
    if (!emptyNode) {
      emptyNode = document.createElement('div');
      emptyNode.className = 'empty';
      emptyNode.textContent = t('popup.empty');
      list.append(emptyNode);
    }
    renderSummary();
    return;
  }

  emptyNode?.remove();
  emptyNode = null;

  const seen = new Set();
  for (const task of tasks) {
    seen.add(task.id);
    let entry = rows.get(task.id);
    if (!entry) {
      entry = createRow();
      rows.set(task.id, entry);
    }
    updateRow(entry, task);
    // Appending an element already in the DOM moves it, keeping its listeners.
    list.append(entry.node);
  }

  for (const [id, entry] of rows) {
    if (seen.has(id)) continue;
    entry.node.remove();
    rows.delete(id);
  }

  renderSummary();
}

function createRow() {
  const node = template.content.firstElementChild.cloneNode(true);
  return {
    node,
    badge: node.querySelector('.badge'),
    filename: node.querySelector('.filename'),
    info: node.querySelector('.info'),
    bar: node.querySelector('.bar'),
    actionBox: node.querySelector('.actions'),
    status: null,
  };
}

function updateRow(entry, task) {
  if (entry.status !== task.status) {
    entry.node.className = `dl status-${task.status}`;
    // Only the buttons depend on status, so they are the only part rebuilt.
    entry.actionBox.replaceChildren(...actions(task));
    entry.status = task.status;
  }

  const badge = (extensionOf(task.filename) || '?').slice(0, 4).toUpperCase();
  if (entry.badge.textContent !== badge) entry.badge.textContent = badge;
  if (entry.filename.textContent !== task.filename) {
    entry.filename.textContent = task.filename;
    entry.filename.title = task.url;
  }

  entry.info.replaceChildren(...infoParts(task));
  entry.bar.replaceChildren(...barSegments(task));
}

function infoParts(task) {
  const parts = [];
  const add = (text, className) => {
    const span = document.createElement('span');
    span.textContent = text;
    if (className) span.className = className;
    parts.push(span);
  };

  if (task.totalBytes > 0) {
    add(
      TERMINAL_STATUSES.has(task.status)
        ? formatBytes(task.totalBytes)
        : `${formatBytes(task.receivedBytes)} / ${formatBytes(task.totalBytes)}`,
    );
  } else if (task.receivedBytes > 0) {
    add(formatBytes(task.receivedBytes));
  }

  if (task.status === STATUS.DOWNLOADING) {
    add(formatSpeed(task.speed));
    if (task.speed > 0 && task.totalBytes > 0) {
      add(formatEta((task.totalBytes - task.receivedBytes) / task.speed));
    }
  } else if (task.status !== STATUS.COMPLETED) {
    add(t(`status.${task.status}`));
  }

  // Neither the segment count nor "completed" needs a chip: the progress bar
  // shows both, split into segments and filled green when it is done.
  if (task.status !== STATUS.COMPLETED && task.rangeSupported === false) {
    add(t('popup.singleConnection'), 'chip');
    add(t('popup.noRangeSupport'), 'warn');
  }

  if (task.status === STATUS.ERROR && task.error) add(task.error, 'err');

  return parts;
}

// Beyond this a per-segment bar reads as a comb rather than as progress, so
// segments are pooled into this many cells. An HLS stream easily has hundreds.
const MAX_CELLS = 16;

function barSegments(task) {
  // By offset, not array order: work stealing appends split segments at the end.
  const ordered = task.segments?.length
    ? [...task.segments].sort((a, b) => a.start - b.start)
    : [null];
  const segments = ordered.length > MAX_CELLS ? pool(ordered, MAX_CELLS) : ordered;

  return segments.map((segment) => {
    const wrap = document.createElement('div');
    wrap.className = 'seg';
    wrap.style.flex =
      segment && segment.end !== null
        ? String(segment.total ?? segment.end - segment.start + 1)
        : '1';

    const fill = document.createElement('i');
    const ratio = segment && segment.end !== null
      ? percent(segment.received, segment.total ?? segment.end - segment.start + 1)
      : percent(task.receivedBytes, task.totalBytes);
    fill.style.width = `${ratio}%`;
    if (ratio >= 100) wrap.classList.add('done');

    wrap.append(fill);
    return wrap;
  });
}

/** Merges consecutive segments into `cells` buckets, keeping their proportions. */
function pool(segments, cells) {
  const perCell = Math.ceil(segments.length / cells);
  const out = [];
  for (let i = 0; i < segments.length; i += perCell) {
    const group = segments.slice(i, i + perCell);
    out.push({
      start: group[0].start,
      end: group[group.length - 1].end,
      received: group.reduce((sum, part) => sum + part.received, 0),
      total: group.reduce((sum, part) => sum + (part.end - part.start + 1), 0),
    });
  }
  return out;
}

function actions(task) {
  const buttons = [];
  const add = (labelKey, type, primary) => {
    const button = document.createElement('button');
    button.textContent = t(labelKey);
    button.dataset.action = type;
    if (primary) button.className = 'primary';
    button.addEventListener('click', () => send(type, { id: task.id }));
    buttons.push(button);
  };

  switch (task.status) {
    case STATUS.QUEUED:
    case STATUS.PROBING:
    case STATUS.DOWNLOADING:
      add('action.pause', MSG.PAUSE, true);
      add('action.cancel', MSG.CANCEL);
      break;
    case STATUS.PAUSED:
      add('action.resume', MSG.RESUME, true);
      add('action.cancel', MSG.CANCEL);
      break;
    case STATUS.ERROR:
      add('action.retry', MSG.RETRY, true);
      add('action.remove', MSG.REMOVE);
      break;
    case STATUS.COMPLETED:
      add('action.showFile', MSG.SHOW_FILE, true);
      add('action.remove', MSG.REMOVE);
      break;
    default:
      break;
  }
  // Always available: a wedged task must never be impossible to get rid of.
  if (!buttons.some((button) => button.dataset.action === MSG.REMOVE)) {
    add('action.remove', MSG.REMOVE);
  }
  return buttons;
}

function renderSummary() {
  const active = tasks.filter((task) => task.status === STATUS.DOWNLOADING);
  const speed = active.reduce((sum, task) => sum + (task.speed || 0), 0);
  const queued = tasks.filter((task) => task.status === STATUS.QUEUED).length;

  const since = new Date().setHours(0, 0, 0, 0);
  const today = tasks
    .filter((task) => task.status === STATUS.COMPLETED && task.completedAt >= since)
    .reduce((sum, task) => sum + (task.totalBytes || 0), 0);

  document.getElementById('tagline').textContent = t('app.tagline', {
    active: active.length,
    speed: formatSpeed(speed),
  });
  document.getElementById('queue').textContent = t('popup.queue', { n: queued });
  document.getElementById('today').textContent = t('popup.today', { size: formatBytes(today) });
}
