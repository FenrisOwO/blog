// P4 acceptance tests: the four content types this site actually has, and the three bundle
// forms they are written in.
//
// The point of Phase 4 is that a Page and a Category are not "the rest" of the editor: they
// are found, classified, edited, created, deleted and restored by the same rules as an
// Article. So each test below walks one whole sentence of that promise, on a copy of the
// fixture corpus (test/fixtures/README.md), and checks the bytes on disk rather than a summary
// of them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createDocumentService } from '../src/site/documentService.js';
import { contentKindLabel, formLabel, formatUpdated, titleOf } from '../web/contentLabels.js';
import { FIXTURE, makeFixtureSandbox } from './fixtures/harness.js';

const ABOUT = FIXTURE.page;
const ABOUT_EN = FIXTURE.pageEn;
const LINKS = FIXTURE.links;
const CATEGORY = FIXTURE.category;
const POST = FIXTURE.article;

// The fixture category has two languages; the tests below compare "the other language" against
// the one they edited instead of listing a whole language set.
const CATEGORY_OTHER_LANGUAGES = [FIXTURE.categoryEn];
const ABOUT_OTHER_LANGUAGES = [ABOUT];

function makeSandbox(t) {
  return makeFixtureSandbox(t, { prefix: 'hve-p4-' });
}

function makeService(sandbox) {
  return createDocumentService({
    contentRoot: sandbox.contentRoot,
    siteRoot: sandbox.siteRoot,
    sections: [''],
    backupRoot: sandbox.backupRoot,
  });
}

function disk(sandbox, path) {
  return readFileSync(join(sandbox.contentRoot, path), 'utf8');
}

test('the site has all four types, and each row knows which one it is', async (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);
  const documents = await service.listDocuments();

  const counts = {};
  for (const doc of documents) counts[doc.contentKind] = (counts[doc.contentKind] ?? 0) + 1;
  // The fixture's own shape: 9 articles, 5 pages, 3 taxonomy term pages (2 category + 1 tag)
  // and 3 "other" files (the two home pages and misc/fixture-note.md).
  assert.deepEqual(counts, { article: 9, page: 5, category: 3, other: 3 });

  // Bundle forms are a separate axis: an article can be a file or a bundle, and so can a page.
  const byPath = new Map(documents.map((doc) => [doc.path, doc]));
  assert.equal(byPath.get(POST).contentKind, 'article');
  assert.equal(byPath.get(POST).kind, 'standalone');
  assert.equal(byPath.get(ABOUT).contentKind, 'page');
  assert.equal(byPath.get(ABOUT).kind, 'leaf-bundle');
  assert.equal(byPath.get(CATEGORY).contentKind, 'category');
  assert.equal(byPath.get(CATEGORY).kind, 'branch-bundle');
  assert.equal(byPath.get('_index.md').contentKind, 'other');
  assert.equal(byPath.get('_index.md').kind, 'branch-bundle');

  // The list can name every row without inventing anything: title, language, timestamp.
  for (const doc of documents) {
    assert.ok(doc.translationKey, doc.path);
    assert.ok(doc.language, doc.path);
    assert.ok(doc.updatedAt, doc.path);
  }
});

test('a page is opened, edited and saved, and a save that changes nothing does nothing', async (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  const opened = service.read(ABOUT);
  assert.equal(opened.doc.contentKind, 'page');
  assert.equal(opened.doc.kind, 'leaf-bundle');
  assert.match(opened.text, /title: 关于/);

  // The front-matter form describes a page exactly as it describes an article.
  const form = service.fields(ABOUT);
  assert.equal(form.contentKind, 'page');
  assert.equal(form.editable, true);
  assert.equal(form.fields.find((field) => field.path === 'title').value, '关于');

  // Editing the body: dry run first, then the write.
  const edited = `${opened.text}\n本页面由测试编辑。\n`;
  const preview = service.previewEdit({ path: ABOUT, text: edited });
  assert.equal(preview.status, 'preview');
  assert.equal(preview.contentKind, 'page');
  assert.equal(disk(sandbox, ABOUT), opened.text, 'the dry run wrote nothing');

  const saved = service.saveEdit({ path: ABOUT, text: edited });
  assert.equal(saved.status, 'written');
  assert.equal(saved.onDiskMatchesTarget, true);
  assert.match(disk(sandbox, ABOUT), /本页面由测试编辑。/);
  assert.ok(saved.backupPath, 'a page save is backed up');

  // Re-saving the same bytes is a no-op, so nothing is rewritten and nothing is backed up.
  const noop = service.saveEdit({ path: ABOUT, text: edited });
  assert.equal(noop.status, 'noop');
  assert.equal(noop.backupPath, null);
  assert.equal(noop.diff, null);
  assert.equal(noop.shaAfter, noop.shaBefore);

  // Front matter only: the body must survive untouched.
  const fieldSave = service.saveFields({ path: ABOUT, set: { description: '关于本站的说明' } });
  assert.equal(fieldSave.status, 'written');
  assert.match(disk(sandbox, ABOUT), /description: 关于本站的说明/);
  assert.match(disk(sandbox, ABOUT), /本页面由测试编辑。/, 'the body the form never edits is still there');
});

test('a page bundle is created, given a resource, deleted whole and restored whole', async (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  service.createDocument({ kind: 'leaf-bundle', section: 'page', title: 'Team' });
  assert.equal(existsSync(join(sandbox.contentRoot, 'page/team/index.md')), true);

  // A bundle owns its assets simply by having them next to the index file.
  const resourcePath = join(sandbox.contentRoot, 'page/team/team.png');
  writeFileSync(resourcePath, 'not really a png', 'utf8');

  const created = (await service.listDocuments()).find((doc) => doc.path === 'page/team/index.md');
  assert.equal(created.contentKind, 'page');
  assert.equal(created.kind, 'leaf-bundle');

  const resources = await service.listResources();
  assert.ok(resources.some((resource) => resource.path === 'page/team/team.png'));

  const plan = service.planForDelete({ path: 'page/team/index.md' });
  assert.equal(plan.scope, 'bundle', 'a leaf bundle is deleted as a whole by default');
  assert.equal(plan.documentCount, 1);
  assert.equal(plan.resourceCount, 1);

  const removed = service.removeDocument({ path: 'page/team/index.md' });
  assert.equal(existsSync(join(sandbox.contentRoot, 'page/team')), false);

  service.restore({ id: removed.trashId });
  assert.equal(disk(sandbox, 'page/team/index.md').includes('title: Team'), true);
  assert.equal(disk(sandbox, 'page/team/team.png'), 'not really a png', 'the resource comes back too');
});

test('a category page is edited in place, and only the language that was edited changes', async (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  const beforeOthers = CATEGORY_OTHER_LANGUAGES.map((path) => disk(sandbox, path));

  // What the file says, not what a calendar of demo content said: the form must report it back.
  const title = disk(sandbox, CATEGORY).match(/^title: (.+)$/m)[1];
  const image = disk(sandbox, CATEGORY).match(/^image: (.+)$/m)[1];

  const opened = service.read(CATEGORY);
  assert.equal(opened.doc.contentKind, 'category');
  assert.equal(opened.doc.kind, 'branch-bundle');
  assert.match(opened.text, new RegExp(`^---\ntitle: ${title}\n`));

  const form = service.fields(CATEGORY);
  assert.equal(form.contentKind, 'category');
  assert.equal(form.fields.find((field) => field.path === 'title').value, title);
  assert.equal(form.fields.find((field) => field.path === 'image').value, image);
  // A nested map the form cannot flatten is still reported, never silently dropped.
  assert.equal(form.fields.find((field) => field.path === 'style').editable, false);

  const saved = service.saveFields({ path: CATEGORY, set: { description: '关于如何使用 Stack 主题的文章（已更新）' } });
  assert.equal(saved.status, 'written');
  assert.match(disk(sandbox, CATEGORY), /已更新/);

  const noop = service.saveFields({ path: CATEGORY, set: { description: '关于如何使用 Stack 主题的文章（已更新）' } });
  assert.equal(noop.status, 'noop');

  // Editing one language of a term page is editing one file.
  const others = CATEGORY_OTHER_LANGUAGES.map((path) => disk(sandbox, path));
  assert.deepEqual(others, beforeOthers);
  assert.deepEqual(
    ['en', 'zh'].sort(),
    [...(await service.contentOverview()).groups.find((group) => group.translationKey === 'categories/fixture-category/_index').languages].sort(),
  );
});

test('a category page can be created, then deleted and restored as one entry', async (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  const created = service.createDocument({ kind: 'branch-bundle', section: 'categories', title: 'Release Notes' });
  assert.equal(created.path, 'categories/release-notes/_index.md');
  assert.equal(created.contentKind, 'category');

  // The new term page is part of the type's count straight away.
  const overview = await service.contentOverview();
  assert.equal(overview.documents.filter((doc) => doc.contentKind === 'category').length, 4);

  service.saveFields({
    path: 'categories/release-notes/_index.md',
    set: { description: '每个版本的改动' },
  });
  assert.match(disk(sandbox, 'categories/release-notes/_index.md'), /description: 每个版本的改动/);

  const plan = service.planForDelete({ path: 'categories/release-notes/_index.md' });
  assert.equal(plan.scope, 'document', 'a branch bundle deletes one file unless asked for more');

  const whole = service.planForDelete({ path: 'categories/release-notes/_index.md', scope: 'bundle' });
  assert.deepEqual(whole.files.map((file) => file.path), ['categories/release-notes/_index.md']);

  const removed = service.removeDocument({ path: 'categories/release-notes/_index.md', scope: 'bundle' });
  assert.equal(existsSync(join(sandbox.contentRoot, 'categories/release-notes/_index.md')), false);

  service.restore({ id: removed.trashId });
  assert.match(disk(sandbox, 'categories/release-notes/_index.md'), /description: 每个版本的改动/);
});

test('one language of a page is edited and deleted without touching its siblings', async (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  const siblings = ABOUT_OTHER_LANGUAGES.map((path) => disk(sandbox, path));

  const opened = service.read(ABOUT_EN);
  assert.equal(opened.doc.language, 'en');
  assert.equal(opened.doc.contentKind, 'page');

  service.saveEdit({ path: ABOUT_EN, text: `${opened.text}\n追記。\n` });
  assert.match(disk(sandbox, ABOUT_EN), /追記。/);

  const after = ABOUT_OTHER_LANGUAGES.map((path) => disk(sandbox, path));
  assert.deepEqual(after, siblings, 'editing the English page left the other language byte for byte');

  // Deleting that one language leaves the page itself in place.
  const plan = service.planForDelete({ path: ABOUT_EN, scope: 'document' });
  assert.equal(plan.scope, 'document');
  assert.ok(plan.warnings.some((warning) => warning.includes('会保留')));

  const removed = service.removeDocument({ path: ABOUT_EN, scope: 'document' });
  assert.equal(existsSync(join(sandbox.contentRoot, ABOUT_EN)), false);
  assert.equal(existsSync(join(sandbox.contentRoot, ABOUT)), true);

  service.restore({ id: removed.trashId });
  assert.match(disk(sandbox, ABOUT_EN), /追記。/);
});

test('the pages a deletion does not own are the pages it does not move', async (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  // Links is a leaf bundle with an image; About is a different bundle entirely.
  const beforeAbout = disk(sandbox, ABOUT);
  const removed = service.removeDocument({ path: LINKS });

  assert.equal(existsSync(join(sandbox.contentRoot, 'page/links')), false);
  assert.equal(disk(sandbox, ABOUT), beforeAbout, 'the neighbouring page was never involved');
  assert.equal(existsSync(join(sandbox.contentRoot, FIXTURE.linksResource)), false, 'its own resource went with it');
  assert.equal(existsSync(join(sandbox.contentRoot, POST)), true);

  service.restore({ id: removed.trashId });
  assert.equal(disk(sandbox, LINKS).includes(`title: ${disk(sandbox, LINKS).match(/^title: (.+)$/m)[1]}`), true);
  assert.equal(existsSync(join(sandbox.contentRoot, FIXTURE.linksResource)), true);
});

test('every row can be named in the list, including the ones with no title', () => {
  assert.equal(contentKindLabel('article'), '文章');
  assert.equal(contentKindLabel('page'), '页面');
  assert.equal(contentKindLabel('category'), '分类');
  assert.equal(contentKindLabel('other'), '其它');
  assert.equal(contentKindLabel('something-new'), 'something-new', 'an unknown type is shown, not swallowed');
  assert.equal(formLabel('standalone'), '单文件');
  assert.equal(formLabel('leaf-bundle'), 'leaf bundle');
  assert.equal(formLabel('branch-bundle'), 'branch bundle');

  // A title wins; a bundle falls back to its directory, because `index.md` names nothing.
  assert.equal(titleOf({ path: 'post/hello.md', base: 'hello', meta: { title: '你好' } }), '你好');
  assert.equal(titleOf({ path: 'page/about/index.md', base: 'index', bundlePath: 'page/about', meta: {} }), 'page/about');
  assert.equal(titleOf({ path: '_index.md', base: '_index', bundlePath: '', meta: { title: null } }), '(站点首页)');
  assert.equal(titleOf({ path: 'post/hello.en.md', base: 'hello', meta: {} }), 'hello');

  const now = Date.parse('2026-09-30T12:00:00Z');
  assert.equal(formatUpdated('2026-09-30T11:59:30Z', now), '刚刚');
  assert.equal(formatUpdated('2026-09-30T11:30:00Z', now), '30 分钟前');
  assert.equal(formatUpdated('2026-09-30T06:00:00Z', now), '6 小时前');
  assert.equal(formatUpdated('2026-09-27T12:00:00Z', now), '3 天前');
  assert.equal(formatUpdated('2026-01-02T12:00:00Z', now), '2026-01-02');
  assert.equal(formatUpdated(null, now), '');
});
