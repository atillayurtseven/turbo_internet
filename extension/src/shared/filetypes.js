/**
 * Extracts a lower-case extension from a filename or URL path.
 * Handles multi-part extensions such as ".tar.gz".
 */
const COMPOUND = ['tar.gz', 'tar.bz2', 'tar.xz', 'tar.zst'];

export function extensionOf(nameOrUrl = '') {
  let name = nameOrUrl;
  try {
    if (/^https?:/i.test(nameOrUrl)) name = new URL(nameOrUrl).pathname;
  } catch {
    /* keep the raw string */
  }
  name = name.split('/').pop().split('?')[0].split('#')[0].toLowerCase();
  for (const compound of COMPOUND) {
    if (name.endsWith(`.${compound}`)) return compound;
  }
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : '';
}

/** Matches a MIME type against a pattern such as "video/*" or "application/zip". */
export function mimeMatches(mime = '', pattern = '') {
  if (!mime || !pattern) return false;
  const m = mime.split(';')[0].trim().toLowerCase();
  const p = pattern.trim().toLowerCase();
  if (p === '*' || p === '*/*') return true;
  if (!p.includes('*')) return m === p;
  const [pType, pSub] = p.split('/');
  const [mType, mSub] = m.split('/');
  return (pType === '*' || pType === mType) && (pSub === '*' || pSub === mSub);
}

const ILLEGAL = /[\x00-\x1f<>:"|?*\\]/g;

/** Makes a string safe to use as a file name on all desktop platforms. */
export function sanitizeFilename(name, fallback = 'download') {
  let clean = String(name || '')
    .replace(/[/]/g, '_')
    .replace(ILLEGAL, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();
  if (!clean) clean = fallback;
  // Windows caps a path segment at 255 characters; keep the extension intact.
  if (clean.length > 200) {
    const dot = clean.lastIndexOf('.');
    const ext = dot > 0 ? clean.slice(dot) : '';
    clean = clean.slice(0, 200 - ext.length) + ext;
  }
  return clean;
}

/** Builds the relative path handed to chrome.downloads.download(). */
export function joinPath(subfolder, filename) {
  const folder = String(subfolder || '')
    .split('/')
    .map((part) => sanitizeFilename(part, ''))
    .filter(Boolean)
    .join('/');
  return folder ? `${folder}/${filename}` : filename;
}

/** Parses a filename out of a Content-Disposition header. */
export function filenameFromDisposition(header = '') {
  if (!header) return '';
  const star = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (star) {
    const value = star[1].trim().replace(/^"|"$/g, '');
    const parts = value.split("''");
    const raw = parts.length > 1 ? parts[1] : value;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  return plain ? (plain[2] ?? plain[1]).trim() : '';
}

/** Common content types, for naming a file the URL did not name. */
const MIME_EXTENSIONS = new Map([
  ['application/zip', 'zip'],
  ['application/x-7z-compressed', '7z'],
  ['application/x-rar-compressed', 'rar'],
  ['application/gzip', 'gz'],
  ['application/pdf', 'pdf'],
  ['application/x-apple-diskimage', 'dmg'],
  ['application/x-msdownload', 'exe'],
  ['application/x-msi', 'msi'],
  ['application/vnd.debian.binary-package', 'deb'],
  ['application/x-iso9660-image', 'iso'],
  ['video/mp4', 'mp4'],
  ['video/x-matroska', 'mkv'],
  ['video/quicktime', 'mov'],
  ['video/webm', 'webm'],
  ['video/mp2t', 'ts'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp4', 'm4a'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
]);

/**
 * Gives an extensionless name one derived from the content type. A file saved
 * as plain "download" tells the user nothing and opens in nothing.
 */
export function nameWithExtension(filename, mime) {
  const name = sanitizeFilename(filename, 'download');
  if (extensionOf(name)) return name;
  const ext = MIME_EXTENSIONS.get(String(mime || '').split(';')[0].trim().toLowerCase());
  return ext ? `${name}.${ext}` : name;
}
