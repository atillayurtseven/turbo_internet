import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../shared/settings.js';
import { applyI18n, initI18n, t, SUPPORTED_LOCALES } from '../shared/i18n.js';

const MB = 1024 * 1024;
let settings = null;
let saveTimer = 0;

/**
 * Settings persist as soon as they are touched. Requiring a Save click meant a
 * changed dropdown looked applied while storage still held the old value.
 */
function commit() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 250);
}

init();

async function init() {
  settings = await loadSettings();
  await initI18n(settings.language);
  applyI18n();
  renderRules();
  renderGeneral();

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  }
  document.getElementById('add-rule').addEventListener('click', addRule);
  document.getElementById('reset').addEventListener('click', async () => {
    settings = structuredClone(DEFAULT_SETTINGS);
    renderRules();
    renderGeneral();
    await save();
  });
}

function selectTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.tab === name);
  }
  document.getElementById('types').hidden = name !== 'types';
  document.getElementById('general').hidden = name !== 'general';
}

// ---- rules ------------------------------------------------------------------

function renderRules() {
  const body = document.getElementById('rules');
  body.replaceChildren(...settings.rules.map(renderRuleRow));
}

function renderRuleRow(rule) {
  const tr = document.createElement('tr');

  const match = document.createElement('td');
  const exts = textInput(rule.extensions.map((e) => `.${e}`).join(' '), (value) => {
    rule.extensions = value.split(/[\s,]+/).map((e) => e.replace(/^\./, '').toLowerCase()).filter(Boolean);
  });
  exts.className = 'exts';
  exts.title = t('options.rules.extensions');
  const mimes = textInput(rule.mimePatterns.join(', '), (value) => {
    rule.mimePatterns = value.split(/[\s,]+/).map((m) => m.toLowerCase()).filter(Boolean);
  });
  mimes.className = 'mimes';
  mimes.placeholder = t('options.rules.mime');
  match.append(exts, mimes);

  const capture = document.createElement('td');
  capture.append(toggle(rule.capture, (value) => { rule.capture = value; }));

  const connections = document.createElement('td');
  connections.className = 'narrow';
  connections.append(
    numberInput(rule.connections, 1, 32, (value) => { rule.connections = value; }),
  );

  const minSize = document.createElement('td');
  minSize.className = 'narrow';
  minSize.append(
    numberInput(Math.round(rule.minSizeBytes / MB), 0, 100000, (value) => {
      rule.minSizeBytes = value * MB;
    }),
    unit('unit.mb'),
  );

  const folder = document.createElement('td');
  folder.append(textInput(rule.subfolder, (value) => { rule.subfolder = value; }));

  const remove = document.createElement('td');
  const removeButton = document.createElement('button');
  removeButton.textContent = t('action.remove');
  removeButton.addEventListener('click', () => {
    settings.rules = settings.rules.filter((item) => item !== rule);
    renderRules();
    commit();
  });
  remove.append(removeButton);

  tr.append(match, capture, connections, minSize, folder, remove);
  return tr;
}

function addRule() {
  settings.rules.push({
    id: `rule-${crypto.randomUUID().slice(0, 8)}`,
    label: '',
    extensions: [],
    mimePatterns: [],
    capture: true,
    connections: 4,
    minSizeBytes: 10 * MB,
    subfolder: '',
  });
  renderRules();
}

// ---- general ----------------------------------------------------------------

function renderGeneral() {
  const panel = document.getElementById('general');
  panel.replaceChildren(
    captureModeRow(),
    switchRow('options.general.probe', 'options.general.probeDesc', 'probeRanges'),
    switchRow('options.general.fallback', 'options.general.fallbackDesc', 'fallbackSingleConnection'),
    numberRow('options.general.maxConcurrent', 'options.general.maxConcurrentDesc',
      settings.maxConcurrentDownloads, 1, 10, (value) => { settings.maxConcurrentDownloads = value; }),
    numberRow('options.general.speedLimit', 'options.general.speedLimitDesc',
      Math.round(settings.maxSpeedBytesPerSec / MB), 0, 1000,
      (value) => { settings.maxSpeedBytesPerSec = value * MB; }, 'unit.mbps'),
    numberRow('options.general.retries', 'options.general.retriesDesc',
      settings.segmentRetries, 0, 20, (value) => { settings.segmentRetries = value; }, 'unit.times'),
    numberRow('options.general.minSegmentSize', 'options.general.minSegmentSizeDesc',
      Math.round(settings.minSegmentSizeBytes / MB), 1, 512,
      (value) => { settings.minSegmentSizeBytes = value * MB; }, 'unit.mb'),
    languageRow(),
  );
}

function captureModeRow() {
  const select = document.createElement('select');
  const modes = [
    ['ask', 'options.general.modeAsk'],
    ['always', 'options.general.modeAlways'],
    ['off', 'options.general.modeOff'],
  ];
  for (const [value, key] of modes) {
    select.append(new Option(t(key), value, false, settings.captureMode === value));
  }
  select.addEventListener('change', () => {
    settings.captureMode = select.value;
    commit();
  });
  return row('options.general.captureMode', 'options.general.captureModeDesc', select);
}

function languageRow() {
  const select = document.createElement('select');
  const auto = new Option(t('options.general.languageAuto'), 'auto', false, settings.language === 'auto');
  select.append(auto);
  for (const locale of SUPPORTED_LOCALES) {
    select.append(new Option(locale.toUpperCase(), locale, false, settings.language === locale));
  }
  // The whole UI is re-rendered so the change is visible immediately.
  select.addEventListener('change', async () => {
    settings.language = select.value;
    commit();
    await initI18n(settings.language);
    applyI18n();
    renderRules();
    renderGeneral();
  });
  return row('options.general.language', '', select);
}

// ---- small builders ---------------------------------------------------------

function row(labelKey, descKey, ...controls) {
  const wrap = document.createElement('div');
  wrap.className = 'row';
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = t(labelKey);
  if (descKey) {
    const small = document.createElement('small');
    small.textContent = t(descKey);
    label.append(small);
  }
  wrap.append(label, ...controls);
  return wrap;
}

function switchRow(labelKey, descKey, key) {
  return row(labelKey, descKey, toggle(settings[key], (value) => { settings[key] = value; }));
}

function numberRow(labelKey, descKey, value, min, max, onChange, unitKey) {
  const controls = [numberInput(value, min, max, onChange)];
  if (unitKey) controls.push(unit(unitKey));
  return row(labelKey, descKey, ...controls);
}

function toggle(checked, onChange) {
  const button = document.createElement('button');
  button.className = 'switch';
  button.type = 'button';
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-checked', String(Boolean(checked)));
  button.addEventListener('click', () => {
    const next = button.getAttribute('aria-checked') !== 'true';
    button.setAttribute('aria-checked', String(next));
    onChange(next);
    commit();
  });
  return button;
}

function numberInput(value, min, max, onChange) {
  const input = document.createElement('input');
  input.type = 'number';
  input.value = String(value);
  input.min = String(min);
  input.max = String(max);
  input.style.width = '70px';
  input.addEventListener('change', () => {
    const parsed = Math.min(max, Math.max(min, Math.trunc(Number(input.value)) || 0));
    input.value = String(parsed);
    onChange(parsed);
    commit();
  });
  return input;
}

function textInput(value, onChange) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.addEventListener('change', () => {
    onChange(input.value.trim());
    commit();
  });
  return input;
}

function unit(key) {
  const span = document.createElement('span');
  span.className = 'unit';
  span.textContent = t(key);
  return span;
}

async function save() {
  settings = await saveSettings(settings);
  const badge = document.getElementById('saved');
  badge.hidden = false;
  clearTimeout(save.hide);
  save.hide = setTimeout(() => {
    badge.hidden = true;
  }, 1600);
}
