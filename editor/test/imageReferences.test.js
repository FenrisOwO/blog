// Phase Insert E: the acceptance that matters for references. `referenceModel.test.js` proves
// the model is self-consistent; this file proves the model agrees with Hugo - every reference
// the editor calls resolvable is a reference the real build fetches, and the values the editor
// refuses are the values a real build turns into 404s.
//
// It runs against a temporary copy of the fixture corpus plus the installed theme, and reads
// the HTML the theme produced. The corpus and the user's site are only ever read.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAssetService } from '../src/site/assetService.js';
import { createDocumentService } from '../src/site/documentService.js';
import { createBuildService } from '../src/build/buildService.js';
import { FIXTURE_SITE, INSTALLED_THEME } from './fixtures/harness.js';

// A real 1x1 PNG: Hugo reads the bytes to build its resource, so the fixtures cannot be empty.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

const FRONT_MATTER = (lines) => `---\n${lines.join('\n')}\n---\n`;

function writeDoc(siteRoot, relPath, text) {
  const abs = join(siteRoot, 'content', relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

function writePng(siteRoot, relPath, bytes = PNG) {
  const abs = join(siteRoot, 'content', relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
}

// The corpus ships no `admonition` shortcode and no related-content config; the theme needs
// both to render, and neither is the subject here (test/fixtures/README.md).
function makeBuildable(siteRoot) {
  mkdirSync(join(siteRoot, 'layouts', '_shortcodes'), { recursive: true });
  writeFileSync(join(siteRoot, 'layouts', '_shortcodes', 'admonition.html'), '{{ .Inner }}\n');
  writeFileSync(
    join(siteRoot, 'config', '_default', 'related.toml'),
    'includeNewer = true\nthreshold    = 100\ntoLower      = false\nindices      = []\n',
  );
}

// The corpus paginates two posts per list page; every case below is asserted on the section
// list, so the sandbox shows them all on one page instead of depending on post dates.
function raisePagerSize(siteRoot) {
  const configPath = join(siteRoot, 'config', '_default', 'hugo.toml');
  const text = readFileSync(configPath, 'utf8');
  assert.match(text, /pagerSize = 2/);
  writeFileSync(configPath, text.replace('pagerSize = 2', 'pagerSize = 50'));
}

// Every `src` of every `<img>` whose tag mentions `needle`, in document order. The theme emits
// both `src` and `srcset`, and a processor variant (`..._hu_<hash>.jpg`) for images it resizes.
function imgSrcs(html, needle) {
  const srcs = [];
  for (const tag of html.match(/<img\b[^>]*>/g) ?? []) {
    if (!tag.includes(needle)) continue;
    const match = tag.match(/\bsrc=(?:"([^"]*)"|([^ >]+))/);
    if (match) srcs.push(match[1] ?? match[2]);
  }
  return srcs;
}

test('every reference the editor allows is one a real Hugo build fetches', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hve-image-refs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const siteRoot = join(root, 'site');
  cpSync(FIXTURE_SITE, siteRoot, {
    recursive: true,
    filter: (source) => !/(\/public|\/resources|\/\.hugo_build\.lock)$/.test(source),
  });
  cpSync(INSTALLED_THEME, join(siteRoot, 'themes', 'hugo-theme-stack'), { recursive: true });
  makeBuildable(siteRoot);
  raisePagerSize(siteRoot);

  // C1: a page resource, referenced by its name inside the bundle.
  writePng(siteRoot, 'post/case-flat/flat.png');
  writeDoc(
    siteRoot,
    'post/case-flat/index.md',
    FRONT_MATTER(['title: "Case Flat"', 'date: 2026-06-01', 'slug: "case-flat"', 'image: flat.png']) +
      '\n正文图片：![扁平图片](flat.png)\n',
  );

  // C2: a resource in a subdirectory keeps that subdirectory - `deep.png` is NOT the name.
  writePng(siteRoot, 'post/case-nested/images/deep.png');
  writeDoc(
    siteRoot,
    'post/case-nested/index.md',
    FRONT_MATTER([
      'title: "Case Nested"',
      'date: 2026-06-02',
      'slug: "case-nested"',
      'image: images/deep.png',
    ]) + '\n正文图片：![深层图片](images/deep.png)\n',
  );

  // C4: names that need care - CJK characters and a space.
  writePng(siteRoot, 'post/case-names/中文图片.png');
  writePng(siteRoot, 'post/case-names/two words.png');
  writeDoc(
    siteRoot,
    'post/case-names/index.md',
    FRONT_MATTER(['title: "Case Names"', 'date: 2026-06-03', 'slug: "case-names"', 'image: 中文图片.png']) +
      '\n中文名：![中文](中文图片.png)\n\n空格名：![空格](<two words.png>)\n',
  );

  // C5: one bundle, two languages. The bundle's resources belong to the page, not to a file.
  writePng(siteRoot, 'post/case-i18n/flat.png');
  const i18nFrontMatter = (title) =>
    FRONT_MATTER([`title: "${title}"`, 'date: 2026-06-04', 'slug: "case-i18n"', 'image: flat.png']);
  writeDoc(siteRoot, 'post/case-i18n/index.md', `${i18nFrontMatter('案例多语言')}\n正文：![图](flat.png)\n`);
  writeDoc(siteRoot, 'post/case-i18n/index.en.md', `${i18nFrontMatter('Case I18n')}\nBody: ![img](flat.png)\n`);

  // C6: the other reference families - a static site URL, another page's published URL (the
  // only way a single-file post can show a branch bundle's resource), and (as the control) a
  // source path, which is the value the editor refuses and which must therefore really break.
  writeDoc(
    siteRoot,
    'post/case-static/index.md',
    FRONT_MATTER([
      'title: "Case Static"',
      'date: 2026-06-05',
      'slug: "case-static"',
      'image: /img/logo.png',
    ]) + '\n正文：![logo](/img/logo.png)\n',
  );
  writeDoc(
    siteRoot,
    'post/case-foreign-url/index.md',
    FRONT_MATTER([
      'title: "Case Foreign Url"',
      'date: 2026-06-05',
      'slug: "case-foreign-url"',
      'image: /categories/fixture-category/fixture-banner.png',
    ]) + '\n正文：没有图片。\n',
  );
  writeDoc(
    siteRoot,
    'post/case-broken/index.md',
    FRONT_MATTER([
      'title: "Case Broken"',
      'date: 2026-06-06',
      'slug: "case-broken"',
      'image: categories/fixture-category/fixture-banner.png',
    ]) + '\n正文：没有图片。\n',
  );

  const buildService = createBuildService({
    siteRoot,
    stagingDir: join(root, 'staging'),
    cacheDir: join(root, 'cache'),
    publishDir: join(root, 'public'),
    publishRoot: root,
    timeoutMs: 180_000,
  });
  const record = await buildService.build({ trigger: 'manual' });
  assert.equal(record.state, 'success', `build failed: ${record.message ?? '(no message)'}`);

  const publishRoot = join(root, 'public');
  const html = (relPath) => readFileSync(join(publishRoot, relPath), 'utf8');
  const published = (url) => existsSync(join(publishRoot, decodeURIComponent(url.replace(/^\//, ''))));

  const documents = createDocumentService({
    contentRoot: join(siteRoot, 'content'),
    siteRoot,
    sections: ['post', 'page', 'categories', ''],
    backupRoot: join(root, 'backups'),
  });
  const assets = createAssetService({
    siteRoot,
    contentRoot: join(siteRoot, 'content'),
    staticRoot: join(siteRoot, 'static'),
    assetRoot: join(siteRoot, 'assets'),
    publishDir: join(root, 'public'),
    backupRoot: join(root, 'backups'),
    guard: documents.guard,
    documents,
    defaultLanguage: documents.defaultLanguage,
  });

  await t.test('C1/C3: a bundle resource resolves in the body, the cover and the list card', () => {
    const list = imgSrcs(html('post/index.html'), 'Case Flat');
    assert.equal(list.length, 1, 'the section list shows one card for the post');
    assert.equal(list[0], '/p/case-flat/flat.png', 'the card uses the published URL');
    assert.ok(published(list[0]), 'and that URL exists in the published site');

    const article = imgSrcs(html('p/case-flat/index.html'), 'flat.png');
    assert.ok(article.length >= 2, 'the hero and the body image are both rendered');
    for (const src of article) {
      assert.match(src, /^\//, `reference stays resolved: ${src}`);
      assert.ok(published(src), `published file exists for ${src}`);
    }
    // C3 is the point of the pair: the card and the article agree on one URL.
    assert.equal(new Set([...article, ...list]).size, 1);
  });

  await t.test('C2: a nested resource keeps its directory', async () => {
    const srcs = imgSrcs(html('p/case-nested/index.html'), 'deep.png');
    assert.ok(srcs.length >= 2, 'hero and body image');
    for (const src of srcs) {
      assert.match(src, /\/images\/deep\.png$/, `the path inside the bundle is kept: ${src}`);
      assert.ok(published(src), `published file exists for ${src}`);
    }
    // The dialog used to assemble `deep.png` from the file name, which the build then treated as
    // a URL relative to the page instead of the resource.
    assert.ok(!srcs.some((src) => src.endsWith('/case-nested/deep.png')), 'no file-name-only URL');

    const bundle = (await assets.listAssets()).bundles.find((entry) => entry.bundlePath === 'post/case-nested');
    const deep = bundle.resources.find((resource) => resource.filename === 'deep.png');
    assert.equal(deep.relativePath, 'images/deep.png');
    assert.equal(deep.reference.kind, 'page-resource');
    assert.equal(deep.reference.value, 'images/deep.png', 'the editor offers the bundle-relative name');
  });

  await t.test('C4: a CJK name and a name with a space both resolve', () => {
    const srcs = imgSrcs(html('p/case-names/index.html'), '.png');
    assert.equal(srcs.length, 3, 'cover, CJK image and spaced image');
    for (const src of srcs) {
      assert.match(src, /^\//, `reference stays resolved: ${src}`);
      assert.ok(published(src), `published file exists for ${src}`);
    }
    assert.ok(
      srcs.some((src) => decodeURIComponent(src).endsWith('中文图片.png')),
      'the CJK name survives the round trip',
    );
    assert.ok(
      srcs.some((src) => decodeURIComponent(src).endsWith('two words.png')),
      'the spaced name survives as an encoded URL',
    );
  });

  await t.test('C4: the editor spells the spaced name the way the build needs it', async () => {
    const bundle = (await assets.listAssets()).bundles.find((entry) => entry.bundlePath === 'post/case-names');
    const spaced = bundle.resources.find((resource) => resource.filename === 'two words.png');
    assert.equal(spaced.reference.kind, 'page-resource');
    assert.equal(spaced.reference.value, '<two words.png>', 'angle brackets, or Hugo stops resolving');

    const missing = await assets.referenceVerdict({ documentPath: 'post/case-names/index.md', value: 'nope.png' });
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /没有这个文件/);
  });

  await t.test('C5: one bundle serves every language of the page', () => {
    for (const relPath of ['p/case-i18n/index.html', 'en/p/case-i18n/index.html']) {
      const srcs = imgSrcs(html(relPath), 'flat.png');
      assert.ok(srcs.length >= 2, `${relPath}: hero and body image`);
      for (const src of srcs) {
        assert.equal(src, '/p/case-i18n/flat.png', `${relPath}: the shared resource URL`);
        assert.ok(published(src), `${relPath}: published file exists`);
      }
    }
  });

  await t.test('C6: a static site URL resolves, and a source path really does not', async () => {
    const staticSrcs = imgSrcs(html('p/case-static/index.html'), 'logo.png');
    assert.ok(staticSrcs.length >= 2, 'hero and body image');
    for (const src of staticSrcs) {
      assert.equal(src, '/img/logo.png', 'static/ files are addressed from the site root');
      assert.ok(published(src), 'published file exists');
    }
    const verdict = await assets.referenceVerdict({
      documentPath: 'post/case-static/index.md',
      value: '/img/logo.png',
    });
    assert.equal(verdict.ok, true, verdict.reason);

    // Another page's published URL: resolvable, and the build really does publish it there.
    const foreignUrl = '/categories/fixture-category/fixture-banner.png';
    const foreignSrcs = imgSrcs(html('p/case-foreign-url/index.html'), 'fixture-banner.png');
    assert.deepEqual(foreignSrcs, [foreignUrl]);
    assert.ok(published(foreignUrl), 'the branch bundle publishes its resource at its own URL');
    const foreignVerdict = await assets.referenceVerdict({
      documentPath: 'post/case-foreign-url/index.md',
      value: foreignUrl,
    });
    assert.equal(foreignVerdict.ok, true, foreignVerdict.reason);
    assert.equal(foreignVerdict.kind, 'site-url', 'a URL that the build publishes is not a source path');

    // The control: the value the editor refuses is exactly the value that reaches the browser
    // as a document-relative URL, so it 404s (both here and on the live site).
    const broken = imgSrcs(html('post/index.html'), 'Case Broken');
    assert.deepEqual(broken, ['categories/fixture-category/fixture-banner.png']);
    assert.doesNotMatch(broken[0], /^\//, 'the build leaves a source path relative');
    assert.ok(!published(`/p/case-broken/${broken[0]}`), 'so the browser asks for a file that is not there');

    const refused = await assets.referenceVerdict({
      documentPath: 'post/case-broken/index.md',
      value: 'categories/fixture-category/fixture-banner.png',
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.kind, 'foreign-resource');
    assert.match(refused.reason, /内容树/);
    assert.ok(refused.suggestion, 'the editor tells the user what would work instead');
  });
});
