// P1.3 acceptance tests.
//
// Runs against the project's real content tree. ContentReader is read-only, so the
// suite also asserts that the tree hash is identical before and after scanning.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  DEFAULT_CONTENT_KINDS,
  deriveContentKind,
  normalizeContentKinds,
  parseFileName,
  readSection,
  readSiteLanguages,
  readTaxonomies,
} from '../src/site/contentReader.js';

const SITE_ROOT = process.env.HUGO_SITE_ROOT ?? '/projects/site';
const CONTENT_ROOT = join(SITE_ROOT, 'content');
const LANGS = ['en', 'zh', 'zh-hant-tw', 'ja'];

function walkAll(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walkAll(abs, out);
    else out.push(abs);
  }
  return out;
}

function treeHash(root) {
  const hash = createHash('sha256');
  for (const file of walkAll(root).sort()) {
    hash.update(relative(root, file));
    hash.update(readFileSync(file));
  }
  return hash.digest('hex');
}

test('filenames are parsed from their suffix, not from a hardcoded language list', () => {
  const opts = { languages: LANGS, defaultLanguage: 'zh' };

  assert.deepEqual(parseFileName('index.md', opts), {
    base: 'index', language: 'zh', languageSuffix: null, role: 'leaf-index',
  });
  assert.deepEqual(parseFileName('index.en.md', opts), {
    base: 'index', language: 'en', languageSuffix: 'en', role: 'leaf-index',
  });
  assert.deepEqual(parseFileName('index.zh-hant-tw.md', opts), {
    base: 'index', language: 'zh-hant-tw', languageSuffix: 'zh-hant-tw', role: 'leaf-index',
  });
  assert.deepEqual(parseFileName('_index.ja.md', opts), {
    base: '_index', language: 'ja', languageSuffix: 'ja', role: 'branch-index',
  });
  assert.deepEqual(parseFileName('pagination-test-01.en.md', opts), {
    base: 'pagination-test-01', language: 'en', languageSuffix: 'en', role: 'standalone',
  });

  // An unknown suffix is treated as part of the name, not as a language. The file is
  // unsuffixed, so it belongs to the default content language.
  assert.equal(parseFileName('notes.article.md', opts).base, 'notes.article');
  assert.equal(parseFileName('notes.article.md', opts).languageSuffix, null);
  assert.equal(parseFileName('notes.article.md', opts).language, 'zh');
});

test('without a configured language list, the suffix is inferred from the filename', () => {
  const opts = { languages: [], defaultLanguage: null };

  assert.equal(parseFileName('notes.pt-br.md', opts).language, 'pt-br');
  assert.equal(parseFileName('notes.pt-br.md', opts).base, 'notes');

  // A long dotted segment is treated as part of the name, not as a language.
  assert.equal(parseFileName('notes.article.md', opts).language, null);
  assert.equal(parseFileName('notes.article.md', opts).base, 'notes.article');
});

test('the site language list is read from the project config', () => {
  const { languages, defaultLanguage } = readSiteLanguages({ siteRoot: SITE_ROOT });

  assert.equal(defaultLanguage, 'zh');
  assert.deepEqual([...languages].sort(), [...LANGS].sort());
});

test('content/post is identified into standalone files, bundles and languages', async () => {
  const { languages, defaultLanguage } = readSiteLanguages({ siteRoot: SITE_ROOT });
  const result = await readSection({ contentRoot: CONTENT_ROOT, section: 'post', languages, defaultLanguage });

  assert.deepEqual(result.warnings, []);
  assert.equal(result.documents.length, 26);
  assert.equal(result.documents.filter((doc) => doc.kind === 'standalone').length, 13);
  assert.equal(result.documents.filter((doc) => doc.kind === 'leaf-bundle').length, 13);

  const bundlePaths = new Set(result.documents.map((doc) => doc.bundlePath).filter(Boolean));
  assert.equal(bundlePaths.size, 5);
  assert.equal(result.groups.length, 18); // 13 standalone + 5 bundles

  const byId = new Map(result.documents.map((doc) => [doc.id, doc]));
  assert.equal(byId.get('post/Image Gallery/index.md').language, 'zh');
  assert.equal(byId.get('post/Image Gallery/index.md').languageSuffix, null);
  assert.equal(byId.get('post/Image Gallery/index.en.md').language, 'en');
  assert.equal(byId.get('post/Image Gallery/index.ja.md').language, 'ja');
  assert.equal(byId.get('post/Image Gallery/index.zh-hant-tw.md').language, 'zh-hant-tw');
  assert.equal(byId.get('post/mermaid-diagrams/index.en.md').kind, 'leaf-bundle');
  assert.equal(byId.get('post/mermaid-diagrams/index.en.md').language, 'en');
  assert.equal(byId.get('post/pagination-test-01.en.md').kind, 'standalone');

  // IDs are the original relative paths.
  for (const doc of result.documents) {
    assert.equal(doc.id, doc.path);
    assert.match(doc.path, /^post\//);
  }
});

test('bundle resources are discovered and classified, never modified', async () => {
  const { languages, defaultLanguage } = readSiteLanguages({ siteRoot: SITE_ROOT });
  const result = await readSection({ contentRoot: CONTENT_ROOT, section: 'post', languages, defaultLanguage });

  assert.equal(result.resources.length, 5);
  assert.ok(result.resources.every((resource) => resource.type === 'image'));
  assert.ok(result.resources.every((resource) => resource.mimeType === 'image/jpeg'));
  assert.ok(result.resources.every((resource) => resource.size > 0));

  const gallery = result.resources.filter((resource) => resource.path.startsWith('post/Image Gallery/'));
  assert.equal(gallery.length, 4);
  assert.ok(gallery.every((resource) => resource.extension === '.jpg'));
  // A resource knows which bundle owns it, and through it which page it belongs to.
  assert.ok(gallery.every((resource) => resource.bundlePath === 'post/Image Gallery'));
  assert.ok(gallery.every((resource) => resource.bundleKind === 'leaf-bundle'));
  assert.ok(gallery.every((resource) => resource.ownerDocument === 'post/Image Gallery/index.md'));
  // A plain reader call decides nothing about safety: without a write predicate the
  // capabilities are closed. The service passes the guard's answer (see contentTypes).
  assert.ok(gallery.every((resource) => resource.capabilities.delete === false));
  // The reference hint comes from the documents already parsed, not from a second scan.
  assert.ok(gallery.every((resource) => resource.referenced === true));
  assert.ok(gallery.every((resource) => resource.referencedBy.includes('post/Image Gallery/index.md')));
});

test('the whole content tree can be read, and branch bundles are recognised', async () => {
  const { languages, defaultLanguage } = readSiteLanguages({ siteRoot: SITE_ROOT });
  const result = await readSection({ contentRoot: CONTENT_ROOT, section: '', languages, defaultLanguage });

  assert.equal(result.documents.length, 50);

  const byId = new Map(result.documents.map((doc) => [doc.id, doc]));
  assert.equal(byId.get('_index.md').kind, 'branch-bundle');
  assert.equal(byId.get('_index.en.md').language, 'en');
  assert.equal(byId.get('categories/Documentation/_index.zh-hant-tw.md').kind, 'branch-bundle');
  assert.equal(byId.get('page/about/index.md').kind, 'leaf-bundle');
});

test('missing title/date/draft is normal and never rewritten', async () => {
  const { languages, defaultLanguage } = readSiteLanguages({ siteRoot: SITE_ROOT });
  const result = await readSection({ contentRoot: CONTENT_ROOT, section: '', languages, defaultLanguage });

  const rootIndex = result.documents.find((doc) => doc.id === '_index.md');
  assert.equal(rootIndex.meta.title, null);
  assert.equal(rootIndex.meta.date, null);
  assert.equal(rootIndex.meta.draft, null);
  assert.ok(rootIndex.hasFrontMatter);
});

test('unknown front matter keys stay unknown but are never dropped', async () => {
  const { languages, defaultLanguage } = readSiteLanguages({ siteRoot: SITE_ROOT });
  const result = await readSection({ contentRoot: CONTENT_ROOT, section: 'post', languages, defaultLanguage });

  const gallery = result.documents.find((doc) => doc.id === 'post/Image Gallery/index.md');

  // `image` and `toc` are not part of the managed field set...
  assert.ok(gallery.frontMatterKeys.includes('image'));
  assert.ok(gallery.frontMatterKeys.includes('toc'));
  assert.equal('image' in gallery.meta, false);
  assert.equal('toc' in gallery.meta, false);

  // ...yet they survive verbatim in the raw front matter.
  assert.match(gallery.frontMatterRaw, /image: helena-hertz-wWZzXlDpMog-unsplash\.jpg/);
  assert.match(gallery.frontMatterRaw, /toc: false/);
});

test('scanning does not modify the content tree', async () => {
  const before = treeHash(CONTENT_ROOT);

  const { languages, defaultLanguage } = readSiteLanguages({ siteRoot: SITE_ROOT });
  await readSection({ contentRoot: CONTENT_ROOT, section: 'post', languages, defaultLanguage });
  await readSection({ contentRoot: CONTENT_ROOT, section: '', languages, defaultLanguage });

  assert.equal(treeHash(CONTENT_ROOT), before);
});

// Phase Insert A: a listing does not have to re-read what it already knows. The cache is
// validated per file, so it may only reuse a description while that file is untouched.

test('a cached scan reuses unchanged descriptions and never invents them', async () => {
  const before = treeHash(CONTENT_ROOT);
  const cache = new Map();
  const opts = { contentRoot: CONTENT_ROOT, section: 'post', languages: LANGS, defaultLanguage: 'zh', cache };

  const first = await readSection(opts);
  const second = await readSection(opts);

  assert.ok(first.documents.length > 0);
  assert.equal(cache.size > 0, true, 'the scan filled the cache');
  assert.deepEqual(
    second.documents.map((doc) => doc.id),
    first.documents.map((doc) => doc.id),
  );
  for (const [index, doc] of second.documents.entries()) {
    assert.equal(doc, first.documents[index], `${doc.id} came from the cache, not a fresh read`);
  }

  // Reading is still read-only, cache or no cache.
  assert.equal(treeHash(CONTENT_ROOT), before, 'scanning left the content tree untouched');
});

test('the content type is derived from the section, and the taxonomy list from the site', () => {
  // This site declares no [taxonomies] table, so Hugo's own defaults are what applies.
  assert.deepEqual(readTaxonomies({ siteRoot: SITE_ROOT }), ['categories', 'tags']);
  assert.deepEqual(DEFAULT_CONTENT_KINDS, {
    article: ['post'],
    page: ['page'],
    taxonomy: ['categories', 'tags'],
  });

  // A section is a type because the site says so, not because the code knows the name.
  assert.equal(deriveContentKind({ section: 'post' }), 'article');
  assert.equal(deriveContentKind({ section: 'page' }), 'page');
  assert.equal(deriveContentKind({ section: 'categories' }), 'category');
  assert.equal(deriveContentKind({ section: 'tags' }), 'category');
  assert.equal(deriveContentKind({ section: '' }), 'other');
  assert.equal(deriveContentKind({ section: 'notes' }), 'other');

  // A site whose article section is called something else is configured, not patched.
  const configured = { article: ['blog'], page: ['pages'], taxonomy: ['topics'] };
  assert.equal(deriveContentKind({ section: 'blog', kinds: configured }), 'article');
  assert.equal(deriveContentKind({ section: 'post', kinds: configured }), 'other');
  assert.equal(deriveContentKind({ section: 'topics', kinds: configured }), 'category');
  assert.equal(deriveContentKind({ section: 'categories', kinds: configured }), 'other');
  assert.deepEqual(normalizeContentKinds({ article: ['blog'] }), {
    article: ['blog'],
    page: ['page'],
    taxonomy: ['categories', 'tags'],
  });
});

test('every document says what it is: type, bundle form, language, and when it changed', async () => {
  const { languages, defaultLanguage } = readSiteLanguages({ siteRoot: SITE_ROOT });
  const kinds = { ...DEFAULT_CONTENT_KINDS, taxonomy: readTaxonomies({ siteRoot: SITE_ROOT }) };
  const { documents } = await readSection({ contentRoot: CONTENT_ROOT, section: '', languages, defaultLanguage, kinds });

  const byPath = new Map(documents.map((doc) => [doc.path, doc]));
  assert.equal(byPath.get('post/pagination-test-01.en.md').contentKind, 'article');
  assert.equal(byPath.get('post/pagination-test-01.en.md').kind, 'standalone');
  assert.equal(byPath.get('page/about/index.md').contentKind, 'page');
  assert.equal(byPath.get('page/about/index.md').kind, 'leaf-bundle');
  assert.equal(byPath.get('categories/Documentation/_index.md').contentKind, 'category');
  assert.equal(byPath.get('categories/Documentation/_index.md').kind, 'branch-bundle');
  assert.equal(byPath.get('_index.md').contentKind, 'other');

  for (const doc of documents) {
    assert.ok(['article', 'page', 'category', 'other'].includes(doc.contentKind), doc.path);
    assert.ok(['standalone', 'leaf-bundle', 'branch-bundle'].includes(doc.kind), doc.path);
    assert.equal(doc.contentKind, deriveContentKind({ section: doc.section, kinds }), doc.path);
    assert.ok(doc.updatedAt && !Number.isNaN(Date.parse(doc.updatedAt)), `${doc.path} has a timestamp`);
    assert.ok(doc.size > 0, `${doc.path} has a size`);
  }
});

test('a branch bundle owns the files beside its index, but not its child pages', async () => {
  const { languages, defaultLanguage } = readSiteLanguages({ siteRoot: SITE_ROOT });
  const kinds = { ...DEFAULT_CONTENT_KINDS, taxonomy: readTaxonomies({ siteRoot: SITE_ROOT }) };

  // categories/Documentation holds `_index.md` in four languages plus the image the page
  // uses. The image is a resource of THAT page; the sibling `_index.md` files are the page.
  const categories = await readSection({ contentRoot: CONTENT_ROOT, section: 'categories', languages, defaultLanguage, kinds });
  assert.equal(categories.documents.length, 4);
  assert.deepEqual(categories.resources.map((resource) => resource.path), [
    'categories/Documentation/hutomo-abrianto-l2jk-uxb1BY-unsplash.jpg',
  ]);
  assert.ok(categories.resources.every((resource) => resource.type === 'image'));
  // A branch bundle's image is owned by the term page, not by a leaf bundle.
  assert.equal(categories.resources[0].bundleKind, 'branch-bundle');
  assert.equal(categories.resources[0].ownerDocument, 'categories/Documentation/_index.md');
  assert.equal(categories.resources[0].referenced, true, 'the page image is referenced from its own _index files');

  // A leaf bundle's resources are still found exactly as before.
  const pages = await readSection({ contentRoot: CONTENT_ROOT, section: 'page', languages, defaultLanguage, kinds });
  assert.deepEqual(pages.resources.map((resource) => resource.path), ['page/links/ts-logo-128.jpg']);
});
