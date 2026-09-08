import { REQUEST_TIMEOUT_MS } from '../shared/constants.js';
import { filenameFromDisposition, sanitizeFilename } from '../shared/filetypes.js';

/**
 * Asks the server what it supports. A ranged GET is used rather than HEAD:
 * many CDNs answer HEAD with a different status or no Content-Length, while a
 * `Range: bytes=0-0` request proves range support and reports the total size in
 * one round trip. The body is discarded immediately.
 */
export async function probe(url, { referrer = '', signal } = {}) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow',
      signal: deadline(controller.signal),
      ...referrerInit(referrer),
    });

    // Headers are in; the single probe byte is not needed.
    controller.abort();

    if (!response.ok && response.status !== 206) {
      throw new HttpError(response.status);
    }

    const acceptRanges = (response.headers.get('accept-ranges') || '').toLowerCase();
    const contentRange = response.headers.get('content-range') || '';
    const rangeSupported =
      response.status === 206 && acceptRanges !== 'none' && /\/\s*\d+$/.test(contentRange);

    const totalBytes = rangeSupported
      ? Number(contentRange.split('/').pop())
      : Number(response.headers.get('content-length')) || 0;

    return {
      url: response.url || url,
      // Identifies this exact version of the file. Sent back with every range
      // request so a mirror serving a different build cannot be stitched into
      // the middle of the download.
      validator: response.headers.get('etag') || response.headers.get('last-modified') || '',
      rangeSupported,
      totalBytes: Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0,
      mime: (response.headers.get('content-type') || '').split(';')[0].trim(),
      filename: pickFilename(response),
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * `Referer` is a forbidden header for fetch(), so it can only be influenced
 * through the referrer init option, and only with an explicit policy.
 */
export function referrerInit(referrer) {
  if (!referrer || !/^https?:/i.test(referrer)) return {};
  return { referrer, referrerPolicy: 'unsafe-url' };
}

/**
 * Sends the session the browser itself would send.
 *
 * Cookies are scoped to their own origin, so "include" on a CDN request carries
 * the CDN's cookies, not the site's -- it does not leak one host's session to
 * another. Withholding them broke the case that matters most: a user who has
 * signed in to a site and expects the file behind that login to download.
 * Non-http schemes get nothing.
 */
export function credentialsFor(url) {
  return /^https?:/i.test(String(url)) ? 'include' : 'omit';
}

/**
 * Adds a deadline to a request.
 *
 * A server that accepts the connection and then says nothing left downloads
 * sitting on "checking server" with nothing to cancel and no error, because
 * fetch on its own waits forever.
 */
export function deadline(signal, ms = REQUEST_TIMEOUT_MS) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    // 4xx other than 408/429 will not succeed on retry.
    this.retryable = status === 408 || status === 429 || status >= 500;
  }
}

function pickFilename(response) {
  const fromHeader = filenameFromDisposition(response.headers.get('content-disposition') || '');
  if (fromHeader) return sanitizeFilename(fromHeader.split(/[\\/]/).pop());
  try {
    const name = decodeURIComponent(new URL(response.url).pathname.split('/').pop() || '');
    return name ? sanitizeFilename(name) : '';
  } catch {
    return '';
  }
}
