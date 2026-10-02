// The Resource model: a binary asset as its own domain object.
//
// A resource is NOT a document that happens to be binary. It has a different identity (bytes,
// not text), a different owner (a bundle, not a language), and different capabilities (replace
// /delete, never "edit front matter"). The model is derived from the Hugo content tree, so
// where a file lives decides what it is:
//
//   content/<bundle>/<file>   a page resource, owned by the bundle it sits in
//   static/<file>             a site-wide static asset: published as-is, referenced by URL
//   assets/<file>             a Hugo asset-pipeline input: processed by the theme, referenced
//                             by templates/config - its lifecycle is not content's (deferred)
//
// Only classification and metadata live here; nothing in this module touches file contents.

import { basename, extname } from 'node:path';

import { isPreviewableMime, mimeForExtension, typeForMime } from './bytes.js';
import { referenceForResource, referenceForStatic } from './referenceModel.js';

export const ASSET_LOCATIONS = ['content', 'static', 'assets'];

export const LOCATION_LABELS = {
  content: '内容资源',
  static: '站点静态文件',
  assets: 'Hugo 管线资源',
};

// Deleting and replacing a resource moves real bytes in the site, so both are gated on the
// same rule the write path uses: the file must sit inside one of the guard's writable roots.
// `static/` and `assets/` are listed (and previewed) but never written in this phase.
export const READ_ONLY_LOCATIONS = new Set(['static', 'assets']);

export function assetId({ location, path }) {
  return `${location}:${path}`;
}

function toPosix(value) {
  return String(value ?? '').split('\\').join('/');
}

export function extensionOfName(name) {
  return extname(String(name ?? '')).toLowerCase();
}

export function baseOfName(name) {
  const ext = extensionOfName(name);
  return ext ? name.slice(0, -ext.length) : name;
}

// One resource, from a path and a stat. `bundle` carries what the content tree already knows
// about the owning page (leaf or branch bundle, its primary document, its kind and section);
// `writable` comes from PathGuard, so the model never decides safety on its own.
export function describeResource({
  location = 'content',
  path,
  relativePath = null,
  filename = null,
  size = null,
  mtimeMs = null,
  bundle = null,
  writable = false,
}) {
  const name = filename ?? basename(path);
  const extension = extensionOfName(name);
  const mimeType = mimeForExtension(extension);
  const readOnly = READ_ONLY_LOCATIONS.has(location);
  const canWrite = writable && !readOnly;
  const relative = toPosix(relativePath ?? name);
  // How a document should name this file. A content resource is only addressable from the
  // document that owns its bundle, so the reference is bundle-relative; a static file is
  // addressed by URL. This is what the UI copies, so no one has to assemble a path again.
  const reference = referenceFor(location, path, relative, bundle);

  return {
    id: assetId({ location, path }),
    path: toPosix(path),
    relativePath: relative,
    filename: name,
    base: baseOfName(name),
    extension,
    size,
    updatedAt: mtimeMs === null ? null : new Date(mtimeMs).toISOString(),
    mimeType,
    type: typeForMime(mimeType),
    location,
    locationLabel: LOCATION_LABELS[location] ?? location,
    // Ownership: a resource belongs to a bundle, and through it to the page the bundle is.
    bundlePath: bundle?.bundlePath ?? null,
    bundleKind: bundle?.kind ?? null,
    ownerDocument: bundle?.documentPath ?? null,
    contentKind: bundle?.contentKind ?? null,
    section: bundle?.section ?? null,
    reference,
    // Reference hints are filled in by the reader, from the documents it already parsed.
    referenced: false,
    referencedBy: [],
    capabilities: {
      preview: isPreviewableMime(mimeType),
      replace: canWrite,
      delete: canWrite,
      upload: false,
    },
  };
}

function referenceFor(location, path, relative, bundle) {
  if (location === 'static') {
    const { reference } = referenceForStatic(relative);
    return { kind: 'site-url', value: reference, usableFrom: 'any document', reason: null };
  }
  if (location === 'assets') {
    return {
      kind: 'pipeline-asset',
      value: null,
      usableFrom: null,
      reason: 'assets/ 是 Hugo 管线资源；Markdown 与 front matter 都引用不到它。',
    };
  }
  if (!bundle || !bundle.bundlePath) {
    return {
      kind: 'no-bundle',
      value: null,
      usableFrom: null,
      reason: '这个文件不在任何 bundle 里，Hugo 不会把它当成页面资源。',
    };
  }
  // One implementation answers "what is this page resource called", for the listing and for
  // the check the editor runs on a value someone typed. The listing cannot offer a reference
  // the check would refuse.
  const verdict = referenceForResource({ bundlePath: bundle.bundlePath, resourcePath: path });
  return {
    kind: verdict.kind,
    value: verdict.reference ?? null,
    usableFrom: verdict.ok ? bundle.bundlePath : null,
    reason: verdict.reason ?? null,
  };
}

// The static and assets trees are mirrored into the same model, with no bundle and no write
// capability: they are listed so the boundary is visible, not so they can be edited.
export function describeSiteAsset({ location, path, size = null, mtimeMs = null }) {
  return describeResource({ location, path, relativePath: path, size, mtimeMs, bundle: null, writable: false });
}

const RESERVED_NAMES = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'lpt1', 'lpt2', 'lpt3']);
const ILLEGAL_CHARS = /[/\\:*?"<>|\u0000-\u001f]/;

// A filename the editor will accept: no path separators (uploads are flat in this phase), no
// control characters, no hidden files, nothing that Windows or a URL would reinterpret.
export function validateAssetFileName(name) {
  const value = String(name ?? '');
  if (value === '') return { ok: false, reason: '文件名不能为空' };
  if (value !== value.trim()) return { ok: false, reason: '文件名不能以空格开头或结尾' };
  if (value.length > 100) return { ok: false, reason: '文件名过长（上限 100 字符）' };
  if (value.startsWith('.')) return { ok: false, reason: '文件名不能以 . 开头' };
  if (value.endsWith('.')) return { ok: false, reason: '文件名不能以 . 结尾' };
  if (value.includes('..')) return { ok: false, reason: '文件名不能包含 ..' };
  if (ILLEGAL_CHARS.test(value)) return { ok: false, reason: '文件名不能包含 / \\ : * ? " < > | 或控制字符' };
  const base = baseOfName(value);
  if (RESERVED_NAMES.has(base.toLowerCase())) return { ok: false, reason: '该文件名被系统保留' };
  const extension = extensionOfName(value);
  if (extension === '') return { ok: false, reason: '文件名缺少扩展名' };
  return { ok: true, reason: null, extension };
}

// The bytes and the name must agree. An upload that claims `.png` but starts with JPEG bytes
// is rejected rather than stored: the extension is what Hugo, the browser and the reference
// in the Markdown all believe.
export function explainByteMismatch({ filename, sniff }) {
  const extension = extensionOfName(filename);
  if (!sniff) return null;
  if (sniff.extensions.includes(extension)) return null;
  return `文件内容看起来是 ${sniff.mime}，但与扩展名 ${extension} 不符（允许：${sniff.extensions.join(', ')}）`;
}

// The name to offer when the requested one is taken - never a silent overwrite.
export function suggestAvailableName(name, taken = []) {
  const used = new Set(taken.map((entry) => String(entry).toLowerCase()));
  if (!used.has(String(name).toLowerCase())) return name;
  const extension = extensionOfName(name);
  const base = baseOfName(name);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}${extension}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${base}-${Date.now()}${extension}`;
}
