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

function render(next) {
  tasks = next;
  list.replaceChildren();

  if (tasks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = t('popup.empty');
    list.append(empty);
  } else {
    for (const task of tasks) list.append(renderRow(task));
  }

  renderSummary();
}

function renderRow(task) {
  const node = template.content.firstElementChild.cloneNode(true);
  node.classList.add(`status-${task.status}`);

  node.querySelector('.badge').textContent = (extensionOf(task.filename) || '?')
    .slice(0, 4)
    .toUpperCase();
  node.querySelector('.filename').textContent = task.filename;
  node.querySelector('.filename').title = task.url;
  node.querySelector('.info').replaceChildren(...infoParts(task));
  node.querySelector('.bar').replaceChildren(...barSegments(task));
  node.querySelector('.actions').replaceChildren(...actions(task));
  return node;
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

function barSegments(task) {
  // By offset, not array order: work stealing appends split segments at the end.
  const segments = task.segments?.length
    ? [...task.segments].sort((a, b) => a.start - b.start)
    : [null];
  return segments.map((segment) => {
    const wrap = document.createElement('div');
    wrap.className = 'seg';
    wrap.style.flex = segment && segment.end !== null ? String(segment.end - segment.start + 1) : '1';

    const fill = document.createElement('i');
    const ratio = segment && segment.end !== null
      ? percent(segment.received, segment.end - segment.start + 1)
      : percent(task.receivedBytes, task.totalBytes);
    fill.style.width = `${ratio}%`;
    if (ratio >= 100) wrap.classList.add('done');

    wrap.append(fill);
    return wrap;
  });
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
