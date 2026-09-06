/**
 * Runtime i18n. Chrome's own _locales only covers manifest strings and cannot
 * be switched without changing the browser language, so UI strings live in
 * src/locales/<lang>.json and are swappable from the settings page.
 */
export const SUPPORTED_LOCALES = ['en', 'tr'];
export const FALLBACK_LOCALE = 'en';

const cache = new Map();
let current = FALLBACK_LOCALE;
let strings = {};
let fallbackStrings = {};

function normalize(tag) {
  const base = String(tag || '').toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_LOCALES.includes(base) ? base : FALLBACK_LOCALE;
}

/** Resolves the locale to use: an explicit setting, or the browser UI language. */
export function resolveLocale(preference) {
  if (preference && preference !== 'auto') return normalize(preference);
  return normalize(chrome.i18n?.getUILanguage?.() ?? navigator.language);
}

async function load(locale) {
  if (cache.has(locale)) return cache.get(locale);
  const url = chrome.runtime.getURL(`src/locales/${locale}.json`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Missing locale file: ${locale}`);
  const data = await response.json();
  cache.set(locale, data);
  return data;
}

/** Must be awaited once before t() is used. */
export async function initI18n(preference) {
  current = resolveLocale(preference);
  fallbackStrings = await load(FALLBACK_LOCALE);
  strings = current === FALLBACK_LOCALE ? fallbackStrings : await load(current);
  return current;
}

export function getLocale() {
  return current;
}

/** Translates a key, substituting {placeholders}. Unknown keys return the key. */
export function t(key, params) {
  const template = strings[key] ?? fallbackStrings[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/**
 * Applies translations to a document: data-i18n sets text content,
 * data-i18n-attr="placeholder:key,title:key" sets attributes.
 */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(',')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }
  root.documentElement?.setAttribute('lang', current);
}
