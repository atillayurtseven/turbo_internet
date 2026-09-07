/**
 * Chrome has no background clipboard event, so the closest thing is watching
 * copy events on pages the user visits. Only short http(s) URLs are forwarded;
 * nothing else the user copies leaves the page.
 *
 * The setting is checked here rather than only in the service worker: with the
 * check downstream, copied links still left the page after the user had turned
 * the feature off.
 */
const MAX_LENGTH = 2048;
let watching = false;

function onCopy() {
  // The clipboard is only readable after the event has been applied.
  setTimeout(() => {
    if (!watching) return;
    const text = String(window.getSelection?.() ?? '').trim();
    if (!text || text.length > MAX_LENGTH || !/^https?:\/\/\S+$/i.test(text)) return;
    chrome.runtime
      .sendMessage({ target: 'background', type: 'clipboard-hit', payload: { url: text } })
      .catch(() => {});
  }, 0);
}

function apply(settings) {
  const next = settings?.clipboardWatch !== false;
  if (next === watching) return;
  watching = next;
  if (watching) document.addEventListener('copy', onCopy, true);
  else document.removeEventListener('copy', onCopy, true);
}

chrome.storage.sync.get('settings').then(
  (stored) => apply(stored?.settings),
  () => apply(null),
);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.settings) apply(changes.settings.newValue);
});
