/**
 * Chrome has no background clipboard event, so the closest thing is watching
 * copy events on pages the user visits. Only short http(s) URLs are forwarded;
 * nothing else the user copies leaves the page.
 */
const MAX_LENGTH = 2048;

document.addEventListener(
  'copy',
  () => {
    // The clipboard is only readable after the event has been applied.
    setTimeout(() => {
      const text = String(window.getSelection?.() ?? '').trim();
      if (!text || text.length > MAX_LENGTH || !/^https?:\/\/\S+$/i.test(text)) return;
      chrome.runtime.sendMessage({ target: 'background', type: 'clipboard-hit', payload: { url: text } }).catch(() => {});
    }, 0);
  },
  true,
);
