// Hugo-native content identification layer (P1.3).
//
// This is a READER, not an importer. It walks a content section and describes what is
// already on disk: path-based document IDs, detected language, bundle form and the
// resources that sit next to a bundle's index file.
//
// Guarantees:
//   * strictly read-only - nothing is created, moved, renamed or rewritten;
//   * original paths are preserved and are the document ID;
//   * standalone files, leaf bundles and multilingual variants are all first-class;
//   * resources are only *discovered and recorded*;
//   * missing title/date/draft is normal, never an error;
//   * front matter we do not understand stays untouched and is still reported
//     (frontMatterRaw + frontMatterKeys), so the metadata model cannot drop it.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import { readDocument } from '../frontmatter/index.js';
import { createLimiter } from '../util/pool.js';
import { describeResource } from './resourceModel.js';

// A listing touches every file under a section: ~50 stats and reads for this site. Serially
// on the site's mount that is ~300ms (measured: 49 reads 84ms, 49 stats 57ms, plus one
// readdir per directory), which is the whole of what an editor list view waits for. The
// same operations run concurrently cost a fraction of that, so the walk goes through a
// limiter that keeps at most this many operations in flight - enough to hide the latency,
// few enough not to bury the mount or exhaust handles.
const IO_CONCURRENCY = 32;
const io = createLimiter(IO_CONCURRENCY);

// Filename-based fallback used only when the project's language list is unavailable.
const LANGUAGE_CODE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

// The content TYPES the editor distinguishes, as opposed to the bundle FORMS (standalone /
// leaf / branch) that `kind` describes. Both come from the real tree: a type is the meaning
// of a top-level section, not a second database entry.
//
//   article   the site's article section (content/post)
//   page      ordinary Markdown pages (content/page): about, archives, links, search
//   category  a taxonomy term page (content/categories/<term>/_index.md)
//   other     anything else, including the content root's own _index.md (the home page)
//
// Names live here as data rather than as branches in the code, so a site whose article
// section is not `post` is configured, not patched.
export const CONTENT_KINDS = ['article', 'page', 'category', 'other'];
export const DEFAULT_CONTENT_KINDS = {
  article: ['post'],
  page: ['page'],
  // Hugo's own defaults; read from config.toml's [taxonomies] when the site declares its own.
  taxonomy: ['categories', 'tags'],
};

export function normalizeContentKinds(kinds) {
  return {
    article: kinds?.article ?? DEFAULT_CONTENT_KINDS.article,
    page: kinds?.page ?? DEFAULT_CONTENT_KINDS.page,
    taxonomy: kinds?.taxonomy ?? DEFAULT_CONTENT_KINDS.taxonomy,
  };
}

// The type of one document, from its section and nothing else. A taxonomy term page is
// recognised by its section alone, so a new category needs no code: `categories/<anything>`
// is a category page the moment it exists.
export function deriveContentKind({ section, kinds = DEFAULT_CONTENT_KINDS } = {}) {
  const name = typeof section === 'string' ? section : '';
  const config = normalizeContentKinds(kinds);
  if (config.taxonomy.includes(name)) return 'category';
  if (config.article.includes(name)) return 'article';
  if (config.page.includes(name)) return 'page';
  return 'other';
}

export function sectionOf(relPath) {
  const slash = relPath.indexOf('/');
  return slash === -1 ? '' : relPath.slice(0, slash);
}

// Hugo's [taxonomies] either names them itself or falls back to categories/tags. Reading the
// table (rather than assuming) is what keeps `tags/foo/_index.md` a category-style term page
// if this site ever adds tags content.
export function readTaxonomies({ siteRoot }) {
  const configPath = join(siteRoot, 'config', '_default', 'hugo.toml');
  if (!existsSync(configPath)) return [...DEFAULT_CONTENT_KINDS.taxonomy];
  const text = readFileSync(configPath, 'utf8');
  const table = /\[taxonomies\]([\s\S]*?)(?:\n\[|$)/.exec(text);
  if (!table) return [...DEFAULT_CONTENT_KINDS.taxonomy];
  const names = [...table[1].matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)].map((match) => match[1]);
  return names.length > 0 ? [...new Set(names)] : [...DEFAULT_CONTENT_KINDS.taxonomy];
}

export function isLikelyLanguageCode(value) {
  return LANGUAGE_CODE_PATTERN.test(value);
}

export function parseFileName(fileName, { languages = [], defaultLanguage = null } = {}) {
  if (!fileName.endsWith('.md')) return null;
  const stem = fileName.slice(0, -3);

  const known = languages.map((language) => language.toLowerCase());
  let base = stem;
  let language = defaultLanguage;
  let languageSuffix = null;

  // A configured language suffix wins, longest first (so zh-hant-tw beats zh).
  const matches = known
    .filter((code) => stem.toLowerCase().endsWith(`.${code}`))
    .sort((a, b) => b.length - a.length);

  if (matches.length > 0) {
    languageSuffix = stem.slice(stem.length - matches[0].length);
    base = stem.slice(0, stem.length - matches[0].length - 1);
    language = languages[known.indexOf(matches[0])];
  } else if (known.length === 0) {
    // No configured languages: derive the suffix from the filename itself.
    const match = /^(.*)\.([A-Za-z][A-Za-z0-9-]*)$/.exec(stem);
    if (match && isLikelyLanguageCode(match[2])) {
      base = match[1];
      languageSuffix = match[2];
      language = match[2];
    }
  }

  let role = 'standalone';
  if (base === 'index') role = 'leaf-index';
  else if (base === '_index') role = 'branch-index';

  return { base, language, languageSuffix, role };
}

export function readSiteLanguages({ siteRoot }) {
  const result = { languages: [], defaultLanguage: null };

  const hugoConfig = join(siteRoot, 'config', '_default', 'hugo.toml');
  if (existsSync(hugoConfig)) {
    const text = readFileSync(hugoConfig, 'utf8');
    const match = /^\s*defaultContentLanguage\s*=\s*"([^"]+)"/m.exec(text);
    if (match) result.defaultLanguage = match[1];
  }

  const languageConfig = join(siteRoot, 'config', '_default', 'languages.toml');
  if (existsSync(languageConfig)) {
    const text = readFileSync(languageConfig, 'utf8');
    const codes = [...text.matchAll(/^\s*\[([A-Za-z][A-Za-z0-9-]*)\]\s*$/gm)].map((match) => match[1]);
    result.languages = [...new Set(codes)];
  }

  return result;
}

// One directory listing, through the limiter: on this mount a readdir is a network round
// trip, so the walk issues as many as it can at once rather than one after another.
async function listDir(absDir) {
  const entries = await io.run(() => readdir(absDir, { withFileTypes: true }));
  return entries
    .filter((entry) => !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function statOrNull(absPath) {
  try {
    return await io.run(() => stat(absPath));
  } catch {
    return null;
  }
}

async function readOrNull(absPath) {
  try {
    return await io.run(() => readFile(absPath, 'utf8'));
  } catch {
    return null;
  }
}

function isIndexFile(name) {
  return name === 'index.md' || /^index\.[A-Za-z]/.test(name);
}

function isBranchIndexFile(name) {
  return name === '_index.md' || /^_index\.[A-Za-z]/.test(name);
}

// Exported because the delete path makes the same judgement from a directory listing: a
// `_index.md` is the page, a sibling `.md` is a child page, and a non-Markdown file is a
// resource the page owns.
export function isBranchIndexName(name) {
  return isBranchIndexFile(name);
}

function toPosix(path) {
  return path.split(sep).join('/');
}

// Every resource is described from a stat alone: size, extension and owner. Reading the
// bytes here would mean reading every image of the site on every listing, which is exactly
// what a listing must not do - the bytes are only touched for a preview or a write.
async function describeFiles(dir, names, contentRoot, bundle = null, ctx = {}) {
  const described = await Promise.all(
    names.map(async (name) => {
      const abs = join(dir, name);
      const stats = await statOrNull(abs);
      if (!stats) return null;
      const path = toPosix(relative(contentRoot, abs));
      return describeResource({
        location: 'content',
        path,
        relativePath: bundle?.root ? toPosix(relative(bundle.root, abs)) : name,
        filename: name,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        bundle,
        writable: ctx.writableAssets ? ctx.writableAssets(path) : false,
      });
    }),
  );
  return described.filter(Boolean);
}

async function collectResources(dir, contentRoot, documentNames, bundle = null, ctx = {}) {
  const entries = await listDir(dir);

  const files = [];
  const subdirs = [];
  for (const entry of entries) {
    if (documentNames.has(entry.name)) continue;
    if (entry.isDirectory()) subdirs.push(entry.name);
    else if (entry.isFile()) files.push(entry.name);
  }

  const described = await describeFiles(dir, files, contentRoot, bundle, ctx);

  // Subdirectories are visited one after another: a bundle's resources are almost always
  // flat, and this keeps the recursion from fanning out into an unbounded tree. A resource in
  // a subdirectory is still a resource of the same bundle, so `bundle` is carried down.
  for (const name of subdirs) {
    described.push(...(await collectResources(join(dir, name), contentRoot, new Set(), bundle, ctx)));
  }
  return described;
}

// A branch bundle's resources are the non-Markdown files it keeps next to `_index.md`. They
// are the only assets a taxonomy term page owns: a sibling `.md` is a child page and a
// subdirectory is a child section, so this deliberately does not recurse.
async function collectBranchResources(dir, contentRoot, bundle = null, ctx = {}) {
  const entries = await listDir(dir);
  const files = entries.filter((entry) => entry.isFile() && !entry.name.endsWith('.md')).map((entry) => entry.name);
  return describeFiles(dir, files, contentRoot, bundle, ctx);
}

// Describe one document from its path alone - no directory walk.
//
// The listing and the "open one article" path must agree on kind/bundle/language, so both
// go through here rather than through a second copy of the rules. Opening an article used
// to locate it by listing the whole tree first (a full scan of 49 files just to find one
// path); everything it needs is derivable from the path.
export function describeDocument({
  contentRoot,
  relPath,
  languages = [],
  defaultLanguage = null,
  kinds = DEFAULT_CONTENT_KINDS,
  cache = null,
}) {
  const absPath = join(contentRoot, relPath);
  const stats = statSync(absPath, { throwIfNoEntry: false });
  if (!stats?.isFile()) return null;

  const fileName = basename(relPath);
  const parsed = parseFileName(fileName, { languages, defaultLanguage });
  if (!parsed) return null;

  const kind =
    parsed.role === 'leaf-index' ? 'leaf-bundle' : parsed.role === 'branch-index' ? 'branch-bundle' : 'standalone';
  const parent = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
  const bundleDir = kind === 'standalone' ? null : join(contentRoot, parent);

  // One file at a time: two stats, and a read only when the description is not cached.
  const signature = cache ? signatureSync(absPath, bundleDir) : null;
  const cached = signature === null ? null : cache.get(relPath);
  if (cached?.signature === signature) return cached.document;

  const described = describeText({
    contentRoot,
    absPath,
    fileName,
    languages,
    defaultLanguage,
    kinds,
    kind,
    bundleDir,
    text: readFileSync(absPath, 'utf8'),
    stats,
  });
  if (signature !== null) cache.set(relPath, { signature, document: described });
  return described;
}

// What a document's description depends on: the bytes of its index file, and - for a bundle
// - the directory listing its resources come from. "mtime:size" of both is enough to tell
// whether a cached description may be reused, and is cheap on a mount where reading 49
// files costs half a second.
async function signatureFor(absPath, bundleDir, fileStats) {
  const file = fileStats ?? (await statOrNull(absPath));
  if (!file) return null;
  const dir = bundleDir ? await statOrNull(bundleDir) : null;
  return `${file.mtimeMs}:${file.size}:${dir ? `${dir.mtimeMs}:${dir.size}` : '-'}`;
}

function signatureSync(absPath, bundleDir) {
  const file = statSync(absPath, { throwIfNoEntry: false });
  if (!file) return null;
  const dir = bundleDir ? statSync(bundleDir, { throwIfNoEntry: false }) : null;
  return `${file.mtimeMs}:${file.size}:${dir ? `${dir.mtimeMs}:${dir.size}` : '-'}`;
}

// The one place a document descriptor is built, so a file read by the listing walk and a file
// read on its own produce exactly the same description.
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Candidate asset references in a document: any token that looks like a file with a known
// extension, in the front matter OR the body. Scanning the raw text is deliberate - a
// reference is not always a Markdown image (`image:` in front matter, a nested `links[].image`,
// an HTML `src`), and the front-matter engine only surfaces the keys it manages. This is a
// hint for the asset list ("this file may still be referenced"), never a rewrite.
const REFERENCE_TOKEN = /[\w\u4e00-\u9fff@.\-]+\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico|pdf|mp4|webm|mp3|ogg|wav|woff2?|ttf|otf|zip)\b/gi;

function extractReferences(text) {
  const found = new Set();
  for (const match of String(text ?? '').matchAll(REFERENCE_TOKEN)) {
    if (found.size >= 200) break;
    found.add(safeDecode(match[0]));
  }
  return [...found];
}

// A resource counts as referenced when a sibling document names its filename or its
// bundle-relative path. Basenames are enough to warn the user; they are never enough to
// rewrite anything.
function annotateReferences(resources, documents) {
  if (resources.length === 0) return resources;
  const annotated = resources.map((resource) => ({ ...resource }));
  for (const doc of documents) {
    const refs = doc?.references ?? [];
    if (refs.length === 0) continue;
    for (const resource of annotated) {
      const hit = refs.some((ref) => {
        if (ref === resource.relativePath || ref === resource.filename) return true;
        const base = ref.slice(ref.lastIndexOf('/') + 1);
        return base === resource.filename;
      });
      if (hit) {
        resource.referenced = true;
        if (!resource.referencedBy.includes(doc.path)) resource.referencedBy.push(doc.path);
      }
    }
  }
  return annotated;
}

function describeText({
  contentRoot,
  absPath,
  fileName,
  languages,
  defaultLanguage,
  kinds = DEFAULT_CONTENT_KINDS,
  kind,
  bundleDir,
  text,
  stats = null,
}) {
  const relPath = toPosix(relative(contentRoot, absPath));
  const parsed = parseFileName(fileName, { languages, defaultLanguage });
  const document = readDocument(text);

  const parent = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
  const translationKey = parent ? `${parent}/${parsed.base}` : parsed.base;
  const section = sectionOf(relPath);

  const values = document.values;
  return {
    id: relPath,
    path: relPath,
    // `kind` is the bundle FORM (standalone / leaf-bundle / branch-bundle); `contentKind` is
    // what the file means in the site (article / page / category / other).
    kind,
    contentKind: deriveContentKind({ section, kinds }),
    section,
    bundlePath: bundleDir ? toPosix(relative(contentRoot, bundleDir)) : null,
    fileName,
    base: parsed.base,
    language: parsed.language,
    languageSuffix: parsed.languageSuffix,
    translationKey,
    updatedAt: stats ? new Date(stats.mtimeMs).toISOString() : null,
    size: stats ? stats.size : null,
    hasFrontMatter: document.hasFrontMatter,
    frontMatterRaw: document.frontMatterRaw,
    frontMatterKeys: document.frontMatter.entries.map((entry) => entry.key),
    // What the document points at, collected once here because the text is already in hand.
    // The asset list uses it to say "this image may still be referenced" without re-reading
    // any document; it is never used to rewrite a reference (that is deferred).
    references: extractReferences(text),
    meta: {
      title: values.title ?? null,
      date: values.date ?? null,
      draft: values.draft ?? null,
      description: values.description ?? null,
      slug: values.slug ?? null,
      tags: values.tags ?? null,
      categories: values.categories ?? null,
    },
  };
}

// A document as read by the walk: stat, read and describe, with the cache written back.
// Returns null when the file disappeared between the listing and the read, so one vanishing
// file cannot fail a whole listing.
async function makeDocument({ contentRoot, absPath, fileName, languages, defaultLanguage, kinds, kind, bundleDir, cache = null }) {
  const relPath = toPosix(relative(contentRoot, absPath));
  const stats = await statOrNull(absPath);
  if (!stats?.isFile()) return null;

  const signature = await signatureFor(absPath, bundleDir, stats);
  const cached = signature === null ? null : cache?.get(relPath);
  if (cached?.signature === signature) return cached.document;

  const text = await readOrNull(absPath);
  if (text === null) return null;

  const described = describeText({
    contentRoot,
    absPath,
    fileName,
    languages,
    defaultLanguage,
    kinds,
    kind,
    bundleDir,
    text,
    stats,
  });
  if (cache && signature !== null) cache.set(relPath, { signature, document: described });
  return described;
}

async function walkDir(dir, ctx, out) {
  const children = await listDir(dir);
  const bundleDocs = children.filter((child) => child.isFile() && isIndexFile(child.name));

  if (bundleDocs.length > 0) {
    // Leaf bundle: index*.md are the translations, everything else is a resource.
    const documents = (
      await Promise.all(
        bundleDocs.map((child) =>
          makeDocument({
            contentRoot: ctx.contentRoot,
            absPath: join(dir, child.name),
            fileName: child.name,
            languages: ctx.languages,
            defaultLanguage: ctx.defaultLanguage,
            kinds: ctx.kinds,
            kind: 'leaf-bundle',
            bundleDir: dir,
            cache: ctx.cache,
          }),
        ),
      )
    ).filter(Boolean);
    const bundle = bundleContext({ dir, documents, contentRoot: ctx.contentRoot, kind: 'leaf-bundle', defaultLanguage: ctx.defaultLanguage });
    const resources = await collectResources(
      dir,
      ctx.contentRoot,
      new Set(bundleDocs.map((child) => child.name)),
      bundle,
      ctx,
    );
    out.documents.push(...documents);
    out.resources.push(...annotateReferences(resources, documents));
    return;
  }

  const files = children.filter((child) => child.isFile() && child.name.endsWith('.md'));
  const documents = await Promise.all(
    files.map((child) => {
      const kind = isBranchIndexFile(child.name) ? 'branch-bundle' : 'standalone';
      return makeDocument({
        contentRoot: ctx.contentRoot,
        absPath: join(dir, child.name),
        fileName: child.name,
        languages: ctx.languages,
        defaultLanguage: ctx.defaultLanguage,
        kinds: ctx.kinds,
        kind,
        bundleDir: kind === 'branch-bundle' ? dir : null,
        cache: ctx.cache,
      });
    }),
  );
  const described = documents.filter(Boolean);
  out.documents.push(...described);

  // A branch bundle directory (`_index.md`, i.e. a section or taxonomy term page) may hold
  // page resources next to its index file - the category image on this site is exactly that.
  if (files.some((child) => isBranchIndexFile(child.name))) {
    const bundle = bundleContext({ dir, documents: described, contentRoot: ctx.contentRoot, kind: 'branch-bundle', defaultLanguage: ctx.defaultLanguage });
    out.resources.push(...annotateReferences(await collectBranchResources(dir, ctx.contentRoot, bundle, ctx), described));
  }

  // Subdirectories are walked concurrently: on this mount each readdir is a round trip, and
  // doing them one at a time was most of what a listing spent its time on.
  const subdirs = children.filter((child) => child.isDirectory());
  const nested = subdirs.map(() => ({ documents: [], resources: [] }));
  await Promise.all(
    subdirs.map((child, index) => walkDir(join(dir, child.name), ctx, nested[index])),
  );
  for (const part of nested) {
    out.documents.push(...part.documents);
    out.resources.push(...part.resources);
  }
}

// What the resources of a bundle need to know about it: which directory owns them, which
// document is the page (the default language's, so a link from the asset list opens a
// readable page), and what that page is.
function bundleContext({ dir, documents, contentRoot, kind, defaultLanguage }) {
  const list = documents.filter(Boolean);
  const primary = list.find((doc) => doc.language === defaultLanguage) ?? list[0] ?? null;
  return {
    root: dir,
    bundlePath: toPosix(relative(contentRoot, dir)),
    kind,
    documentPath: primary?.path ?? null,
    contentKind: primary?.contentKind ?? null,
    section: primary?.section ?? '',
  };
}

export async function readSection({
  contentRoot,
  section = 'post',
  languages = [],
  defaultLanguage = null,
  kinds = DEFAULT_CONTENT_KINDS,
  cache = null,
  writableAssets = null,
}) {
  const sectionDir = join(contentRoot, section);
  if (!existsSync(sectionDir)) {
    return { section, documents: [], resources: [], groups: [], warnings: [`section not found: ${sectionDir}`] };
  }

  const out = { documents: [], resources: [] };
  await walkDir(sectionDir, { contentRoot, languages, defaultLanguage, kinds, cache, writableAssets }, out);

  const documents = out.documents.sort((a, b) => a.id.localeCompare(b.id));
  const resources = out.resources.sort((a, b) => a.path.localeCompare(b.path));

  return { section, documents, resources, groups: groupByTranslationKey(documents), warnings: [] };
}

// Translations of one article share a translationKey (their path minus the language
// suffix). Grouping them is what lets the UI say "this article exists in 4 languages".
export function groupByTranslationKey(documents) {
  const grouped = new Map();
  for (const document of documents) {
    if (!grouped.has(document.translationKey)) grouped.set(document.translationKey, []);
    grouped.get(document.translationKey).push(document);
  }

  return [...grouped.entries()].map(([key, docs]) => ({
    translationKey: key,
    languages: docs.map((doc) => doc.language),
    documents: docs.map((doc) => doc.id),
  }));
}
