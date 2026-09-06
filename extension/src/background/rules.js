import { extensionOf, mimeMatches } from '../shared/filetypes.js';

/**
 * Finds the first rule matching a candidate download.
 * `size` may be unknown (0 or negative) at interception time; the size gate is
 * then deferred to the probe, which knows the real Content-Length.
 */
export function matchRule(rules, { filename, url, mime }) {
  const ext = extensionOf(filename) || extensionOf(url);
  for (const rule of rules) {
    const byExt = ext && rule.extensions.includes(ext);
    const byMime = rule.mimePatterns.some((pattern) => mimeMatches(mime, pattern));
    if (byExt || byMime) return rule;
  }
  return null;
}

/**
 * Decides whether this extension should take a download over.
 * Returns { capture: boolean, rule, reason }.
 */
export function decide(settings, candidate) {
  if (settings.captureMode === 'off') return { capture: false, rule: null, reason: 'capture-disabled' };

  const url = candidate.url || '';
  if (!/^https?:/i.test(url)) return { capture: false, rule: null, reason: 'unsupported-scheme' };

  const rule = matchRule(settings.rules, candidate);
  if (!rule) return { capture: false, rule: null, reason: 'no-rule' };
  if (!rule.capture) return { capture: false, rule, reason: 'rule-disabled' };

  const size = Number(candidate.size);
  const sizeKnown = Number.isFinite(size) && size > 0;
  if (sizeKnown && size < rule.minSizeBytes) {
    return { capture: false, rule, reason: 'below-min-size' };
  }

  return { capture: true, rule, reason: 'matched' };
}

/**
 * Number of segments for a file of `size` bytes under `rule`.
 * `maxPartBytes` is a hard floor on the count: OPFS files must stay small
 * enough to be written reliably, so a large file is split further than the
 * rule alone would ask for.
 */
export function segmentCount(rule, size, minSegmentSizeBytes, maxPartBytes = Infinity) {
  if (!Number.isFinite(size) || size <= 0) return 1;
  const byRule = Math.max(1, rule.connections);
  const bySize = Math.max(1, Math.floor(size / Math.max(1, minSegmentSizeBytes)));
  const required = Math.ceil(size / maxPartBytes);
  return Math.max(required, Math.min(byRule, bySize));
}

/** Splits a byte range into `count` inclusive [start, end] segments. */
export function planSegments(size, count) {
  if (!Number.isFinite(size) || size <= 0) {
    return [{ index: 0, start: 0, end: null, received: 0 }];
  }
  const segments = [];
  const chunk = Math.floor(size / count);
  for (let i = 0; i < count; i += 1) {
    const start = i * chunk;
    const end = i === count - 1 ? size - 1 : start + chunk - 1;
    segments.push({ index: i, start, end, received: 0 });
  }
  return segments;
}
