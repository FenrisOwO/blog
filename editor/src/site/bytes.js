// Binary primitives for asset handling.
//
// The text write path (safeWrite.js) cannot be reused for an image: it round-trips through
// utf8, which silently rewrites every byte sequence that is not valid UTF-8. Everything here
// works on Buffers, and an asset's identity is its sha256 - "did this file change" for a PNG
// is a digest comparison, never a string comparison.
//
// Nothing in this module reads a file unless it is asked for bytes: an extension is enough to
// classify a resource for listing, and the magic numbers are only consulted when a file is
// about to be written or served.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { createHash } from 'node:crypto';

// An asset the editor will accept is small: this site's largest content resource is 56 KB.
// The limit is enforced on the decoded bytes, and the server's JSON body limit is sized for
// the base64 form of it.
export const ASSET_MAX_BYTES = 4 * 1024 * 1024;

export const IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/svg+xml',
]);

const MIME_BY_EXTENSION = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
  ['.svg', 'image/svg+xml'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.json', 'application/json'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
  ['.wav', 'audio/wav'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.zip', 'application/zip'],
]);

const TYPE_BY_MIME_FAMILY = [
  ['image/', 'image'],
  ['font/', 'font'],
  ['video/', 'media'],
  ['audio/', 'media'],
];

// Formats the editor will write into a bundle. Narrow on purpose: these are the formats this
// site uses (JPEG) plus the ones a browser can actually preview, all of which are inert once
// served. Extensions that are recognized but not writable (fonts, archive, text, and - see
// below - SVG) are still listed and classified.
export const UPLOAD_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.pdf']);

// SVG is deliberately absent from UPLOAD_EXTENSIONS: it is a scriptable document served from
// the site's own origin, and this phase has no sanitizer. Existing SVG files are recognized,
// listed and previewed; uploading one is deferred rather than allowed without a sanitiser.
export const RECOGNIZED_EXTENSIONS = new Set([
  ...UPLOAD_EXTENSIONS,
  '.svg',
  '.txt',
  '.json',
  '.mp4',
  '.webm',
  '.mp3',
  '.ogg',
  '.wav',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.zip',
]);

const SNIFFERS = [
  { mime: 'image/png', extensions: ['.png'], test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', extensions: ['.jpg', '.jpeg'], test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', extensions: ['.gif'], test: (b) => b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a' },
  { mime: 'image/webp', extensions: ['.webp'], test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { mime: 'image/avif', extensions: ['.avif'], test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && b.subarray(8, 12).toString('latin1').startsWith('avif') },
  { mime: 'image/bmp', extensions: ['.bmp'], test: (b) => b[0] === 0x42 && b[1] === 0x4d },
  { mime: 'image/x-icon', extensions: ['.ico'], test: (b) => b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00 },
  { mime: 'application/pdf', extensions: ['.pdf'], test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'application/zip', extensions: ['.zip'], test: (b) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) },
  { mime: 'font/woff2', extensions: ['.woff2'], test: (b) => b.subarray(0, 4).toString('latin1') === 'wOF2' },
  { mime: 'font/woff', extensions: ['.woff'], test: (b) => b.subarray(0, 4).toString('latin1') === 'wOFF' },
  { mime: 'font/ttf', extensions: ['.ttf'], test: (b) => b.subarray(0, 4).equals(Buffer.from([0x00, 0x01, 0x00, 0x00])) },
  { mime: 'font/otf', extensions: ['.otf'], test: (b) => b.subarray(0, 4).toString('latin1') === 'OTTO' },
];

export function mimeForExtension(extension) {
  return MIME_BY_EXTENSION.get(String(extension ?? '').toLowerCase()) ?? null;
}

// Content sniffing, restricted to the signatures above. A match also carries the extensions
// that are allowed to describe it, which is what makes "an .exe renamed to .png" impossible
// to upload: the bytes and the name have to agree.
export function sniffBytes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  for (const sniffer of SNIFFERS) {
    if (sniffer.test(buffer)) return { mime: sniffer.mime, extensions: sniffer.extensions };
  }
  const head = buffer.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return { mime: 'image/svg+xml', extensions: ['.svg'] };
  }
  return null;
}

export function sha256Bytes(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sha256File(absPath) {
  return sha256Bytes(readFileSync(absPath));
}

// Byte-exact atomic write: temp file in the same directory, fsync, rename over the target.
// The original file is never truncated in place, so an interrupted write leaves it intact.
export function atomicWriteBytes(absPath, buffer) {
  mkdirSync(dirname(absPath), { recursive: true });
  const tmp = join(dirname(absPath), `.${basename(absPath)}.tmp-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, buffer);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, absPath);
}

export function typeForMime(mimeType) {
  if (!mimeType) return 'other';
  for (const [prefix, type] of TYPE_BY_MIME_FAMILY) {
    if (mimeType.startsWith(prefix)) return type;
  }
  if (mimeType === 'application/pdf') return 'document';
  if (mimeType.startsWith('text/') || mimeType === 'application/json') return 'text';
  if (mimeType === 'application/zip') return 'archive';
  return 'other';
}

export function isPreviewableMime(mimeType) {
  return IMAGE_MIME_TYPES.has(mimeType);
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function extensionOf(name) {
  return extname(String(name ?? '')).toLowerCase();
}
