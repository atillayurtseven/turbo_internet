import { t } from '../shared/i18n.js';
import { formatBytes } from '../shared/format.js';

export const CHOICE_MANAGER = 'manager';
export const CHOICE_CHROME = 'chrome';

/**
 * Asks the user, in the top-right corner of the active tab, which downloader to
 * use. A page overlay is used rather than a system notification: notifications
 * can be silenced at the OS level, and this has to be answerable.
 *
 * Returns CHOICE_CHROME whenever the question cannot be put — an unanswerable
 * prompt must never strand the download.
 */
/** Asks about a stream spotted on a page, in that page's own tab. */
export async function askAboutMedia({ tabId, name, label, seconds = 15 }) {
  return inject(tabId, {
    title: t('prompt.title'),
    question: t('prompt.questionMedia'),
    filename: name,
    size: label,
    yes: t('prompt.yesMedia'),
    no: t('prompt.noMedia'),
    countdown: t('prompt.dismiss'),
    seconds,
    manager: CHOICE_MANAGER,
    chrome: CHOICE_CHROME,
  });
}

export async function askUser({ filename, sizeBytes, seconds = 20 }) {
  const args = [
    {
      title: t('prompt.title'),
      question: t('prompt.question'),
      filename,
      size: sizeBytes > 0 ? formatBytes(sizeBytes) : '',
      yes: t('prompt.yes'),
      no: t('prompt.no'),
      countdown: t('prompt.countdown'),
      seconds,
      manager: CHOICE_MANAGER,
      chrome: CHOICE_CHROME,
    },
  ];

  // The tab that started the download can be mid-navigation or be a restricted
  // page, so the question is offered to the next best tab instead of dropped.
  for (const tabId of await candidateTabs()) {
    const choice = await inject(tabId, args[0]);
    if (choice !== null) return choice;
  }

  console.warn('[dlman] nowhere to ask, leaving the download to Chrome');
  return CHOICE_CHROME;
}

/** Returns the user's choice, or null when the card could not be shown. */
async function inject(tabId, strings) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: overlay,
      args: [strings],
    });
    return injection?.result ?? null;
  } catch (error) {
    console.debug('[dlman] cannot ask in tab', tabId, error?.message || error);
    return null;
  }
}

/** Injectable tabs, most likely first: the active one, then most recent. */
async function candidateTabs() {
  try {
    const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
    return tabs
      .filter((tab) => tab.id >= 0 && /^https?:/i.test(tab.url || ''))
      .sort(
        (a, b) =>
          Number(b.active) - Number(a.active) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0),
      )
      .slice(0, 3)
      .map((tab) => tab.id);
  } catch {
    return [];
  }
}

/**
 * Runs inside the page. Self-contained by necessity: executeScript serializes
 * this function, so it can close over nothing but its argument.
 */
function overlay(s) {
  return new Promise((resolve) => {
    // Second line of defence against stacked cards: the service worker's
    // per-tab guard is lost when it restarts, but the page still knows.
    if (document.querySelector('[data-dlman-card]')) {
      resolve(null);
      return;
    }

    const host = document.createElement('div');
    host.setAttribute('data-dlman-card', '');
    // `all` must come first: as the last declaration it would reset the
    // positioning above it and drop the card to the bottom of the document.
    host.style.cssText =
      'all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;pointer-events:auto;';
    const root = host.attachShadow({ mode: 'closed' });

    root.innerHTML = `
      <style>
        .card {
          width: 320px; box-sizing: border-box; padding: 14px 16px;
          font: 13px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          color: #e6e9ef; background: #171a21;
          border: 1px solid #2a2f3a; border-radius: 12px;
          box-shadow: 0 12px 32px rgba(0,0,0,.35);
          animation: slide .18s ease-out;
        }
        @keyframes slide { from { opacity: 0; transform: translateY(-8px); } }
        .head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
        .dot { width: 22px; height: 22px; border-radius: 6px; flex: 0 0 auto;
               background: linear-gradient(135deg,#5B9BFF,#8B5CF6); }
        .title { font-weight: 600; font-size: 13px; }
        .q { color: #9aa3b2; font-size: 12px; margin-bottom: 6px; }
        .file { font-size: 12px; word-break: break-all; margin-bottom: 2px; }
        .size { color: #9aa3b2; font-size: 11px; }
        .row { display: flex; gap: 8px; margin-top: 12px; }
        button { flex: 1; font: inherit; font-size: 12px; cursor: pointer;
                 padding: 7px 10px; border-radius: 8px;
                 border: 1px solid #2a2f3a; background: #1e222b; color: #9aa3b2; }
        button.go { background: #1b2740; border-color: #33507e; color: #e6e9ef; font-weight: 600; }
        .tick { margin-top: 8px; color: #656d7a; font-size: 11px; text-align: center; }
      </style>
      <div class="card">
        <div class="head"><div class="dot"></div><div class="title"></div></div>
        <div class="q"></div>
        <div class="file"></div>
        <div class="size"></div>
        <div class="row">
          <button class="go"></button>
          <button class="skip"></button>
        </div>
        <div class="tick"></div>
      </div>`;

    const $ = (sel) => root.querySelector(sel);
    $('.title').textContent = s.title;
    $('.q').textContent = s.question;
    $('.file').textContent = s.filename;
    $('.size').textContent = s.size;
    $('.go').textContent = s.yes;
    $('.skip').textContent = s.no;

    let left = s.seconds;
    const tick = $('.tick');
    const paint = () => {
      tick.textContent = s.countdown.replace('{n}', String(left));
    };
    paint();

    const timer = setInterval(() => {
      left -= 1;
      if (left <= 0) done(s.chrome);
      else paint();
    }, 1000);

    function done(choice) {
      clearInterval(timer);
      host.remove();
      resolve(choice);
    }

    $('.go').addEventListener('click', () => done(s.manager));
    $('.skip').addEventListener('click', () => done(s.chrome));
    document.addEventListener('keydown', function onKey(event) {
      if (event.key !== 'Escape') return;
      document.removeEventListener('keydown', onKey);
      done(s.chrome);
    });

    (document.body ?? document.documentElement).append(host);
  });
}
