/**
 * Sets the Referer header on our own download requests.
 *
 * fetch() cannot do this: Referer is a forbidden header, and the `referrer`
 * init option is silently dropped when the request comes from an extension
 * context to another origin. Hotlink-protected servers then answer 403, which
 * looks to the user like the extension is broken rather than the server saying
 * no. Declarative rules are the supported way to set it.
 */
const RULE_BASE = 9000;
const rules = new Map();
let nextId = RULE_BASE;

const available = () =>
  Boolean(chrome.declarativeNetRequest?.updateSessionRules);

export async function setReferer(taskId, url, referrer) {
  if (!available() || !referrer || !/^https?:/i.test(referrer)) return;

  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return;
  }

  await clearReferer(taskId);
  const id = (nextId = nextId >= RULE_BASE + 500 ? RULE_BASE : nextId + 1);
  rules.set(taskId, id);

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [
        {
          id,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'referer', operation: 'set', value: referrer }],
          },
          // Scoped to the host being downloaded from, and to the request types
          // the engine makes, so nothing else in the browser is touched.
          condition: {
            urlFilter: `|${origin}/`,
            resourceTypes: ['xmlhttprequest', 'other'],
          },
        },
      ],
    });
  } catch (error) {
    console.warn('[dlman] could not set referer', error?.message || error);
    rules.delete(taskId);
  }
}

export async function clearReferer(taskId) {
  const id = rules.get(taskId);
  if (!id || !available()) return;
  rules.delete(taskId);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
  } catch {
    // Session rules die with the browser anyway.
  }
}
