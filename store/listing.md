# Chrome Web Store listing

Copy each block into the matching field in the developer dashboard. Keep the
wording specific. Vague justifications are the most common reason a submission
with broad permissions is sent back.

## Single purpose

Turbo Internet Download Manager downloads files. Where a server supports ranged
requests it fetches a file over several connections at once, resumes it after a
pause and checks that every part arrived before saving. Everything else in the
extension exists to serve that one purpose.

## Permission justifications

### downloads
Required to take a download over from Chrome and to save the finished file.
Chrome extensions cannot write to the file system directly. This API is the
only way to deliver a completed download to the user.

### storage
Stores the user's own settings: rules for each file type, the number of
connections each rule uses, the interface language and the list of downloads in
progress. No data is sent anywhere.

### unlimitedStorage
A download in progress is held in the browser's private storage until it is
written to disk. The default quota is far too small for a multi-gigabyte file,
which is exactly the case this extension exists for.

### offscreen
The download engine runs in an offscreen document. An MV3 service worker is
stopped after about thirty seconds of inactivity and cannot create blob URLs,
so a long download cannot run there. The offscreen document has no user
interface and does no work beyond running the engine.

### scripting
Used to show a single confirmation card inside the current page when a matching
download starts, asking whether the user wants this extension to handle it or
would rather Chrome did. Nothing else is injected and no page content is read.

### webRequest
Used only to observe response headers. This is how a video stream playing on
the page can be offered for download. It never blocks, redirects or modifies a
request. Nothing about the user's browsing is stored or transmitted.

### tabs
Used to know which tab a detected stream belongs to. The popup then shows the
media for the page the user is looking at. It also names a downloaded stream
after the page title, because stream URLs are usually meaningless. A common
example is master.m3u8.

### contextMenus
Adds one right-click entry on links. A user can then send a link to this
extension deliberately rather than waiting for a rule to match.

### declarativeNetRequestWithHostAccess
Sets the Referer header on the extension's own download requests. fetch cannot
set it because Referer is a forbidden header. Many servers refuse a download
without one. The rule is added when a download starts, targets only the host
being downloaded from and is removed when the download ends.

## Host permission justification

A download can come from any site. The extension cannot know in advance which
sites a user will download from. Access is used to fetch the file the user
asked for, to show the confirmation card on the page they are on and to notice
media playing on that page. The extension does not read page content, form input
or anything the user types.

## Content script justification

One small content script runs on http and https pages. It listens for the copy
event and, only when the copied text is a short http or https address, offers it
in the popup as something the user might want to download. It is disabled by
default and everything else the user copies is ignored.

## Remote code

No. All code ships inside the package. The only third-party library is mux.js
7.0.3 under Apache 2.0, included in the package at vendor/mux.min.js and never
fetched at runtime.

## Data usage disclosures

Tick nothing under "what data do you collect". The extension collects no data
and operates no server. The certifications to accept are the standard three:
data is not sold, not used for unrelated purposes and not used to determine
creditworthiness.

Privacy policy URL: https://turbointernet.com/privacy

## Short description (132 characters maximum)

Downloads files over several connections at once. Rules per file type, resume,
speed limit and an optional checksum.
