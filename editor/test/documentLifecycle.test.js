// P3.3 / P3.4 / P3.6 acceptance tests: the wider content scope, creation, and deletion.
//
// Everything runs on a sandbox copy of the real content tree. Deletion is the operation
// that could lose an article, so the tests here are written to prove the opposite: the
// bytes come back.

import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDocumentService } from '../src/site/documentService.js';
import { slugify } from '../src/site/documentCreate.js';
import { PathGuard } from '../src/site/paths.js';
import { listTrash, relocate } from '../src/site/trash.js';

const SITE_ROOT = '/projects/site';
const REAL_CONTENT = join(SITE_ROOT, 'content');

const GALLERY = 'post/Image Gallery/index.md';
const STANDALONE = 'post/pagination-test-01.en.md';
const CATEGORY = 'categories/Documentation/_index.md';
const ABOUT = 'page/about/index.md';

function makeSandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'hve-p3-'));
  const contentRoot = join(root, 'content');
  cpSync(REAL_CONTENT, contentRoot, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, contentRoot, backupRoot: join(root, 'backups') };
}

function makeService(sandbox, options = {}) {
  return createDocumentService({
    contentRoot: sandbox.contentRoot,
    siteRoot: SITE_ROOT,
    sections: [''],
    backupRoot: sandbox.backupRoot,
    ...options,
  });
}

function disk(sandbox, path) {
  return readFileSync(join(sandbox.contentRoot, path), 'utf8');
}

function treeOf(sandbox, relativePath) {
  const out = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out[abs.slice(sandbox.contentRoot.length + 1)] = readFileSync(abs, 'utf8');
    }
  };
  walk(join(sandbox.contentRoot, relativePath));
  return out;
}

test('the scope is what decides how much of the site the editor can see and write', async (t) => {
  const sandbox = makeSandbox(t);

  const narrow = createDocumentService({
    contentRoot: sandbox.contentRoot,
    siteRoot: SITE_ROOT,
    section: 'post',
    backupRoot: sandbox.backupRoot,
  });
  assert.equal((await narrow.listDocuments()).length, 27);
  assert.deepEqual(await narrow.listSections(), [{ section: 'post', label: 'post', count: 27 }]);
  assert.throws(() => narrow.read(ABOUT), /document not found/);

  const wide = makeService(sandbox);
  assert.equal((await wide.listDocuments()).length, 51);

  // Sections are reported in the order the scope declares them, root last.
  const sections = await wide.listSections();
  assert.deepEqual(sections, [
    { section: 'categories', label: 'categories', count: 4 },
    { section: 'page', label: 'page', count: 16 },
    { section: 'post', label: 'post', count: 27 },
    { section: '', label: '(根)', count: 4 },
  ]);

  // Every document says which section it belongs to.
  const about = (await wide.listDocuments()).find((doc) => doc.path === ABOUT);
  assert.equal(about.section, 'page');
  assert.equal(about.kind, 'leaf-bundle');
  assert.equal(about.language, 'zh');

  // The real site pages are now readable and writable through the same service.
  assert.match(wide.read(ABOUT).text, /title: 关于/);
  const home = wide.read('_index.md');
  assert.equal(home.doc.kind, 'branch-bundle');
  assert.equal(home.doc.section, '');
});

test('the wider scope still refuses everything it should', (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);
  const guard = service.guard;

  for (const path of ['../hugo.toml', '/etc/passwd', '', 'post/notes.txt']) {
    assert.throws(() => service.saveEdit({ path, text: 'x' }), /document not found|empty path|absolute|only \.md/i, path);
  }

  // Deletion may target a directory, but never a section root or anything outside content.
  assert.throws(() => guard.resolveForRemoval('post'), /section root/);
  assert.throws(() => guard.resolveForRemoval(''), /empty path/);
  assert.throws(() => guard.resolveForRemoval('/etc'), /absolute path/);
  assert.throws(() => guard.resolveForRemoval('../hugo.toml'), /outside content root/);
  assert.doesNotThrow(() => guard.resolveForRemoval('post/Image Gallery'));
});

test('creating a standalone article writes one file and refuses to overwrite', async (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  const plan = service.planForCreate({ kind: 'standalone', section: 'post', title: 'My New Post', language: 'en' });
  assert.equal(plan.path, 'post/my-new-post.en.md');
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.languageSuffix, 'en');

  const created = service.createDocument({ kind: 'standalone', section: 'post', title: 'My New Post', language: 'en' });
  assert.equal(created.created, true);
  assert.equal(existsSync(join(sandbox.contentRoot, 'post/my-new-post.en.md')), true);

  const text = disk(sandbox, 'post/my-new-post.en.md');
  assert.match(text, /^---\ntitle: My New Post\ndate: \d{4}-\d{2}-\d{2}\ndraft: true\n---\n$/);

  // The new document is immediately part of the site.
  assert.ok((await service.listDocuments()).some((doc) => doc.path === 'post/my-new-post.en.md'));

  // Same title again: a conflict, reported rather than silently overwritten.
  const again = service.planForCreate({ kind: 'standalone', section: 'post', title: 'My New Post', language: 'en' });
  assert.equal(again.conflicts.length, 1);
  assert.match(again.conflicts[0].reason, /已存在/);
  assert.throws(() => service.createDocument({ kind: 'standalone', section: 'post', title: 'My New Post', language: 'en' }), /already exists/);
});

test('creating a leaf bundle makes a directory that owns its index file', async (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  const created = service.createDocument({ kind: 'leaf-bundle', section: 'page', title: 'Team', language: 'zh' });
  assert.equal(created.path, 'page/team/index.md');
  assert.equal(created.directory, 'page/team');
  assert.equal(statSync(join(sandbox.contentRoot, 'page/team')).isDirectory(), true);

  // The default language takes no suffix, matching every other file in this site.
  assert.match(disk(sandbox, 'page/team/index.md'), /title: Team/);

  const doc = (await service.listDocuments()).find((candidate) => candidate.path === 'page/team/index.md');
  assert.equal(doc.kind, 'leaf-bundle');
  assert.equal(doc.language, 'zh');

  // Adding a second language to the same bundle is a warning, not a conflict.
  const second = service.planForCreate({ kind: 'leaf-bundle', section: 'page', title: 'Team', language: 'ja' });
  assert.deepEqual(second.conflicts, []);
  assert.equal(second.path, 'page/team/index.ja.md');
  assert.ok(second.warnings.some((warning) => warning.includes('index.md')));
});

test('creation refuses sections, shapes and languages it does not know', (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  assert.throws(() => service.planForCreate({ kind: 'standalone', section: 'nowhere', title: 'x' }), /不能在该目录下新建/);
  assert.throws(() => service.planForCreate({ kind: 'inner-page', section: 'post', title: 'x' }), /unknown document kind/);
  assert.throws(() => service.planForCreate({ kind: 'standalone', section: 'post', title: 'x', language: 'de' }), /未知语言/);

  // An empty title still has to produce a usable name.
  assert.equal(service.planForCreate({ kind: 'standalone', section: 'post', title: '' }).path, 'post/untitled.md');
});

test('creating a category page makes a branch bundle, because that is what a term page is', async (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  const plan = service.planForCreate({ kind: 'branch-bundle', section: 'categories', title: 'Release Notes' });
  assert.equal(plan.path, 'categories/release-notes/_index.md');
  assert.equal(plan.directory, 'categories/release-notes');
  assert.equal(plan.contentKind, 'category');
  assert.deepEqual(plan.conflicts, []);

  const created = service.createDocument({ kind: 'branch-bundle', section: 'categories', title: 'Release Notes' });
  assert.equal(created.created, true);
  assert.equal(existsSync(join(sandbox.contentRoot, 'categories/release-notes/_index.md')), true);
  assert.equal(statSync(join(sandbox.contentRoot, 'categories/release-notes')).isDirectory(), true);
  assert.match(disk(sandbox, 'categories/release-notes/_index.md'), /^---\ntitle: Release Notes\n/);

  // Hugo reads it as the term page, so the editor has to see it as one.
  const doc = (await service.listDocuments()).find((candidate) => candidate.path === 'categories/release-notes/_index.md');
  assert.equal(doc.kind, 'branch-bundle');
  assert.equal(doc.contentKind, 'category');

  // A second language joins the same directory instead of conflicting with it.
  const second = service.planForCreate({ kind: 'branch-bundle', section: 'categories', title: 'Release Notes', language: 'en' });
  assert.deepEqual(second.conflicts, []);
  assert.equal(second.path, 'categories/release-notes/_index.en.md');
  assert.ok(second.warnings.some((warning) => warning.includes('语言版本')));

  // A branch bundle elsewhere is a section page, and it says so.
  const sectionPage = service.planForCreate({ kind: 'branch-bundle', section: 'page', title: 'Team' });
  assert.equal(sectionPage.path, 'page/team/_index.md');
  assert.equal(sectionPage.contentKind, 'page');
});

test('slugify keeps the characters this site actually uses in filenames', () => {
  assert.equal(slugify('My New Post'), 'my-new-post');
  assert.equal(slugify('  Hello   World  '), 'hello-world');
  assert.equal(slugify('相册'), '相册');
  assert.equal(slugify('日本語の記事'), '日本語の記事');
  assert.equal(slugify('a/b:c*d?e"f<g>h|i'), 'abcdefghi');
  assert.equal(slugify('...'), 'untitled');
  assert.equal(slugify('', { fallback: 'untitled' }), 'untitled');
  assert.equal(slugify('Multi—Dash--Name'), 'multi—dash-name');
});

test('deleting a leaf bundle takes its languages and resources, and can put them back', (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);
  const before = treeOf(sandbox, 'post/Image Gallery');

  const plan = service.planForDelete({ path: GALLERY });
  assert.equal(plan.scope, 'bundle');
  assert.equal(plan.target, 'post/Image Gallery');
  assert.equal(plan.documentCount, 4);
  assert.equal(plan.resourceCount, 4);
  assert.equal(plan.totalFiles, 8);
  assert.equal(plan.recoverable, true);
  assert.ok(plan.warnings.some((warning) => warning.includes('语言版本')));
  assert.ok(plan.warnings.some((warning) => warning.includes('资源文件')));
  assert.ok(plan.files.every((file) => file.path.startsWith('post/Image Gallery/')));

  // Planning is a dry run: nothing has moved.
  assert.equal(existsSync(join(sandbox.contentRoot, 'post/Image Gallery')), true);

  const result = service.removeDocument({ path: GALLERY });
  assert.equal(result.deleted, true);
  assert.equal(existsSync(join(sandbox.contentRoot, 'post/Image Gallery')), false);
  assert.ok(result.trashId);

  // Nothing was destroyed: every byte is in the trash.
  const trashPath = join(sandbox.backupRoot, 'trash', result.trashId, 'files', 'post/Image Gallery');
  assert.equal(existsSync(trashPath), true);
  assert.equal(Object.keys(treeOf({ contentRoot: sandbox.backupRoot }, `trash/${result.trashId}/files/post/Image Gallery`)).length, 8);

  const restored = service.restore({ id: result.trashId });
  assert.equal(restored.relPath, 'post/Image Gallery');
  assert.deepEqual(treeOf(sandbox, 'post/Image Gallery'), before, 'the bundle comes back byte for byte');
  assert.deepEqual(before, treeOf(sandbox, 'post/Image Gallery'));
});

test('deleting one language of a bundle leaves its siblings alone', (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  const plan = service.planForDelete({ path: 'post/Image Gallery/index.ja.md', scope: 'document' });
  assert.equal(plan.scope, 'document');
  assert.equal(plan.totalFiles, 1);
  assert.ok(plan.warnings.some((warning) => warning.includes('会保留')));

  service.removeDocument({ path: 'post/Image Gallery/index.ja.md', scope: 'document' });

  assert.equal(existsSync(join(sandbox.contentRoot, 'post/Image Gallery/index.ja.md')), false);
  assert.equal(existsSync(join(sandbox.contentRoot, 'post/Image Gallery/index.md')), true);
  assert.equal(existsSync(join(sandbox.contentRoot, 'post/Image Gallery/index.en.md')), true);
});

test('deleting one file counts as one document, not as a resource', (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  const standalone = service.planForDelete({ path: STANDALONE });
  assert.equal(standalone.scope, 'document');
  assert.equal(standalone.totalFiles, 1);
  assert.equal(standalone.documentCount, 1);
  assert.equal(standalone.resourceCount, 0);
  assert.deepEqual(standalone.files.map((file) => file.path), [STANDALONE]);
  assert.deepEqual(standalone.targets, [{ path: STANDALONE, type: 'file' }]);

  service.removeDocument({ path: STANDALONE });
  assert.equal(existsSync(join(sandbox.contentRoot, STANDALONE)), false);

  // The same for one language of a bundle: one file in, one file out.
  const language = service.planForDelete({ path: 'page/about/index.ja.md', scope: 'document' });
  assert.equal(language.documentCount, 1);
  assert.equal(language.resourceCount, 0);
});

test('a category page is deleted as its _index files plus its resources, and nothing else', (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  // One language only: the file goes, the directory and the page's own image stay.
  const single = service.planForDelete({ path: CATEGORY, scope: 'document' });
  assert.equal(single.scope, 'document');
  assert.equal(single.documentCount, 1);
  assert.deepEqual(single.files.map((file) => file.path), [CATEGORY]);
  assert.ok(single.warnings.some((warning) => warning.includes('会保留')));

  // The whole term page: every language of `_index.md`, plus the image it points at.
  const whole = service.planForDelete({ path: CATEGORY, scope: 'bundle' });
  assert.equal(whole.scope, 'bundle');
  assert.equal(whole.target, 'categories/Documentation');
  assert.equal(whole.documentCount, 4);
  assert.equal(whole.resourceCount, 1);
  assert.deepEqual(whole.files.map((file) => file.path), [
    'categories/Documentation/_index.en.md',
    'categories/Documentation/_index.ja.md',
    'categories/Documentation/_index.md',
    'categories/Documentation/_index.zh-hant-tw.md',
    'categories/Documentation/hutomo-abrianto-l2jk-uxb1BY-unsplash.jpg',
  ]);
  assert.deepEqual(whole.kept, []);

  // Planning is a dry run.
  assert.equal(existsSync(join(sandbox.contentRoot, 'categories/Documentation/_index.md')), true);

  const result = service.removeDocument({ path: CATEGORY, scope: 'bundle' });
  assert.equal(result.deleted, true);
  // The page's files are gone; the directory itself was never a target, so an emptied one
  // stays where it was - which is also what makes the restore below conflict-free.
  assert.deepEqual(readdirSync(join(sandbox.contentRoot, 'categories/Documentation')), []);

  // One deletion, one trash entry, however many paths it moved.
  const entries = listTrash({ backupRoot: sandbox.backupRoot });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, result.trashId);
  assert.equal(entries[0].files, 5);
  assert.equal(entries[0].entries.length, 5);

  const restored = service.restore({ id: result.trashId });
  assert.equal(restored.restoredAt != null, true);
  for (const path of [
    'categories/Documentation/_index.md',
    'categories/Documentation/_index.en.md',
    'categories/Documentation/_index.ja.md',
    'categories/Documentation/_index.zh-hant-tw.md',
    'categories/Documentation/hutomo-abrianto-l2jk-uxb1BY-unsplash.jpg',
  ]) {
    assert.equal(existsSync(join(sandbox.contentRoot, path)), true, `${path} came back`);
  }
});

test('a branch bundle keeps its child pages when the page itself is deleted', (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  // A section page whose directory really does hold content that belongs to other pages:
  // `page/` gets an `_index.md` and keeps its children.
  writeFileSync(join(sandbox.contentRoot, 'page/_index.md'), '---\ntitle: 页面\n---\n', 'utf8');

  const plan = service.planForDelete({ path: 'page/_index.md', scope: 'bundle' });
  assert.deepEqual(plan.files.map((file) => file.path), ['page/_index.md']);
  assert.ok(plan.kept.includes('page/about/'));
  assert.ok(plan.kept.includes('page/links/'));
  assert.ok(plan.warnings.some((warning) => warning.includes('会保留')));

  service.removeDocument({ path: 'page/_index.md', scope: 'bundle' });

  assert.equal(existsSync(join(sandbox.contentRoot, 'page/_index.md')), false);
  assert.equal(existsSync(join(sandbox.contentRoot, 'page/about/index.md')), true);
  assert.equal(existsSync(join(sandbox.contentRoot, 'page/links/ts-logo-128.jpg')), true);

  const restored = service.restore({ id: service.trash()[0].id });
  assert.equal(restored.relPath, 'page/_index.md');
  assert.equal(existsSync(join(sandbox.contentRoot, 'page/_index.md')), true);
});

test('the home page cannot be deleted as a bundle, only as a file', (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  const plan = service.planForDelete({ path: '_index.md' });
  assert.equal(plan.scope, 'document');
  assert.deepEqual(plan.files.map((file) => file.path), ['_index.md']);

  // Its "bundle" would be the whole content tree.
  assert.throws(() => service.planForDelete({ path: '_index.md', scope: 'bundle' }), /不能整体删除/);
  assert.throws(() => service.planForDelete({ path: STANDALONE, scope: 'bundle' }), /请用 document 作用域/);
});

test('the trash lists what was deleted and refuses to overwrite on restore', (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);
  const original = disk(sandbox, STANDALONE);

  assert.deepEqual(service.trash(), []);

  const result = service.removeDocument({ path: STANDALONE });
  const entries = service.trash();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, result.trashId);
  assert.equal(entries[0].relPath, STANDALONE);
  assert.equal(entries[0].kind, 'file');
  assert.equal(entries[0].files, 1);
  assert.equal(entries[0].restoredAt, null);

  // Something already sitting at the path: restoring must not clobber it.
  writeFileSync(join(sandbox.contentRoot, STANDALONE), 'a different article\n', 'utf8');
  assert.throws(() => service.restore({ id: result.trashId }), /目标已存在/);
  assert.equal(disk(sandbox, STANDALONE), 'a different article\n');

  rmSync(join(sandbox.contentRoot, STANDALONE));
  service.restore({ id: result.trashId });
  assert.equal(disk(sandbox, STANDALONE), original);
  assert.throws(() => service.restore({ id: result.trashId }), /已经.*恢复/);
  assert.throws(() => service.restore({ id: 'no-such-entry' }), /trash entry not found/);
});

test('a rename across a mount boundary falls back to copy and remove', (t) => {
  const sandbox = makeSandbox(t);
  const from = join(sandbox.root, 'from.md');
  const to = join(sandbox.root, 'nested', 'to.md');
  writeFileSync(from, 'content that must survive\n', 'utf8');

  const renameThatCrossesDevices = () => {
    const error = new Error('EXDEV: cross-device link not permitted');
    error.code = 'EXDEV';
    throw error;
  };

  const result = relocate(from, to, { rename: renameThatCrossesDevices });
  assert.equal(result.method, 'copy');
  assert.equal(existsSync(from), false);
  assert.equal(readFileSync(to, 'utf8'), 'content that must survive\n');

  // Any other failure is a real error and must surface rather than be worked around.
  const failed = () => {
    const error = new Error('EPERM: operation not permitted');
    error.code = 'EPERM';
    throw error;
  };
  writeFileSync(from, 'x', 'utf8');
  assert.throws(() => relocate(from, to, { rename: failed }), /EPERM/);
});

test('the trash store keeps its own directory out of the site', (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);
  service.removeDocument({ path: STANDALONE });

  assert.equal(existsSync(join(SITE_ROOT, '.backups')), false, 'the real site must never gain a backups directory');
  const entries = listTrash({ backupRoot: sandbox.backupRoot });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].transport, 'rename');
});
