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

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.target === 'ui' && message.type === MSG.STATE_BROADCAST) render(message.payload);
  });

  render(state?.tasks ?? []);
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

  if (task.status === STATUS.COMPLETED) add(t('status.completed'), 'chip ok');
  else if (task.connections > 1) add(t('popup.segments', { n: task.connections }), 'chip seg');
  else if (task.rangeSupported === false) {
    add(t('popup.singleConnection'), 'chip');
    add(t('popup.noRangeSupport'), 'warn');
  }

  if (task.status === STATUS.ERROR && task.error) add(task.error, 'err');

  return parts;
}

function barSegments(task) {
  const segments = task.segments?.length ? task.segments : [null];
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
