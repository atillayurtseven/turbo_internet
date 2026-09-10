# turbo_internet

**Turbo Internet Download Manager** — a Chrome (MV3) download manager that
recognises file types and, where the server allows it, downloads them over
several connections at once. It also downloads video that a page plays —
HLS streams and direct media files — and saves streams as a plain MP4.
Site: <https://turbointernet.com>

Not affiliated with Tonec Inc. or its product Internet Download Manager (IDM).

## Install

`chrome://extensions` → Developer mode → **Load unpacked** → pick `extension/`.

## Architecture

    ┌─ service worker ─────────┐   coordinator
    │ interceptor  rules       │   • takes downloads over via
    │ settings     state       │     chrome.downloads.onDeterminingFilename
    │ referer      delivery    │   • hands the finished blob back to Chrome
    └───────────┬──────────────┘
                │ chrome.runtime messages
    ┌───────────┴──────────────┐   offscreen document
    │ engine  probe  opfs      │   • queue, concurrency, rate, progress
    └───────────┬──────────────┘   • not subject to the 30 s idle timeout
                │ one worker per download
    ┌───────────┴──────────────────────────────┐
    │ segment-worker   parallel Range fetches  │
    │ hls-worker       playlist segments       │
    │ remux-worker     MPEG-TS → plain MP4     │
    │ hash-worker      SHA-256                 │
    └──────────────────────────────────────────┘

**Why an offscreen document?** An MV3 service worker is killed after roughly
30 seconds idle, and `URL.createObjectURL` does not exist there. The offscreen
document solves both.

**Why one OPFS file per part?** Measured: growing a single OPFS file past about
2 GB fails *silently* — `truncate()` reports no error and leaves the file empty,
even with 11 GB of quota available. Each part is therefore capped at 1 GB and
the finished file is joined with `new Blob([...])`, which references the parts
on disk rather than loading them into memory.

## How a download runs

1. `onDeterminingFilename` fires → rules decide → if matched, Chrome's own
   download is cancelled and erased
2. `GET Range: bytes=0-0` probes the server. This is preferred over HEAD, which
   many CDNs answer with a different status or no `Content-Length`; one round
   trip yields both range support and the total size
3. The file is split into parts, each part downloaded on its own connection,
   with per-part retry and exponential backoff
4. Parts are size-checked, optionally hashed, joined, and written to disk

`If-Range` carries the file's `ETag`/`Last-Modified` on every part request, so a
mirror serving a different build cannot be stitched into the middle of a file.

## Work stealing

A connection that finishes early takes over the half of whichever part has the
most left to do. Guards, so splitting cannot chase its own tail:

- nothing is split when under 2 MB remains
- a part already 90 % done is left alone
- at most 32 parts

## Streams

Requests are watched for playable media; HLS streams and large progressive files
found on a page are offered in the popup. A playlist is only offered once it has
been fetched successfully and starts with `#EXTM3U` — offering something that
cannot be downloaded reads as a broken extension rather than a server saying no.

Supported: TS and fMP4 segments, `EXT-X-MAP`, `EXT-X-BYTERANGE`, and AES-128
(transport encryption whose key is served openly, not DRM). `SAMPLE-AES` and
anything Widevine-backed are refused.

TS streams are converted to a **plain, seekable MP4**: mux.js does the codec
work and emits fragmented MP4, then the fragments are unwrapped and a real
sample table (`stts`/`ctts`/`stsc`/`stsz`/`co64`/`stss`) is built. Fragmented
MP4 is a streaming format — it plays from the start and nothing else, and many
desktop players refuse it. Nothing is re-encoded. If conversion fails the
download is still delivered, as `.ts`.

Stream links on CDNs are usually signed and rotated every few minutes, so a
stored playlist URL starts answering 404 soon after the page loaded. A failed
stream therefore reports that its link expired rather than offering a Retry
that can only hit the same dead URL. Re-download looks the stream up again in
the tab's current media list and uses that page as the new `Referer`.

**Out of scope:** YouTube and comparable platforms. Downloading from them breaks
their terms of service, and Chrome Web Store policy forbids extensions that do.

## Sessions

Downloads carry the browser's own cookies, so a file behind a login works.
`Referer` is set through a declarative session rule rather than `fetch`, which
cannot set it: it is a forbidden header, and the `referrer` option is silently
dropped cross-origin, which made hotlink-protected servers answer 403.

## Clipboard

Chrome has no background clipboard event. Three paths are used instead: a copy
listener on pages (only short http(s) URLs ever leave the page), a clipboard
read when the popup opens, and a paste field. Both can be switched off.

## Settings

Changes save immediately; there is no Save button. Note the **minimum size**
column: by default disk images under 20 MB, archives under 10 MB, video under
5 MB and installers under 2 MB are left to Chrome. If nothing is being taken
over, check that first — the service worker console logs
`[dlman] skipped below-min-size`.

Optional SHA-256 after downloading, for comparing against a published checksum.
Reading the file back takes a while on large downloads, so it is off by default.

## Verification

Driven through the Chrome DevTools Protocol against a local server
(`--load-extension` needs `--disable-features=DisableLoadExtensionCommandLineSwitch`
on Chrome 137+).

- ten scenarios: ranged, no-range fallback, 1 KB, zero bytes, 404, transient
  500, pause, resume, cancel, duplicate suppression
- 10 GB local download: SHA-256 identical to the reference, 32 parts, work
  stealing active
- 6 GB Ubuntu ISO: SHA-256 identical to the checksum Ubuntu publishes
- HLS: TS stream (64 segments) and fMP4 stream (101 segments) both produce
  valid, seekable output
- `Referer`: a download blocked with 403 without it completes with it

## Known limits

- Falling back to a single connection caps a file at 1 GB
- A copy of the file lives in browser storage until it reaches disk, so a 6 GB
  download temporarily needs about 12 GB
- Resuming is unavailable on servers that ignore `Range`; resume restarts

## Adding a language

Add `src/locales/<code>.json` and list the code in `SUPPORTED_LOCALES` in
`src/shared/i18n.js`. `_locales/` only covers manifest strings.

## Third party

`extension/vendor/mux.min.js` — mux.js 7.0.3, Apache-2.0.
