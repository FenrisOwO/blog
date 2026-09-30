// P3 HTTP surface: the wider content scope, the front-matter form, create and delete.
//
// The build service is injected, so these tests assert the wiring - in particular that a
// real write closes the edit loop and a no-op does not.

import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EDITOR_SECTIONS, createEditorServer } from '../server/index.js';

const ROOT = join(import.meta.dirname, '..');
const SITE_ROOT = '/projects/site';
const CONTENT_ROOT = join(SITE_ROOT, 'content');

const ABOUT = 'page/about/index.md';
const GALLERY = 'post/Image Gallery/index.md';

function fakeBuildService() {
  const scheduled = [];
  return {
    scheduled,
    getStatus: () => ({ state: 'idle', activity: 'idle', generation: 0, queued: false, preview: { url: '/', generation: 0 }, lastBuild: null, history: [], config: {} }),
    subscribe: () => () => {},
    scheduleBuild: (options = {}) => {
      scheduled.push(options);
      return {};
    },
    build: () => Promise.resolve({}),
    stop: () => {},
  };
}

function makeSandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'hve-p3http-'));
  const contentRoot = join(root, 'content');
  cpSync(CONTENT_ROOT, contentRoot, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, contentRoot, backupRoot: join(root, 'backups') };
}

async function withServer(run, sandbox, overrides = {}) {
  const buildService = overrides.buildService ?? fakeBuildService();
  const server = createEditorServer({
    siteRoot: SITE_ROOT,
    contentRoot: sandbox?.contentRoot ?? CONTENT_ROOT,
    backupRoot: sandbox?.backupRoot ?? join(ROOT, '.backups'),
    sections: EDITOR_SECTIONS,
    editorDist: join(ROOT, 'dist'),
    watchSources: false,
    buildOnStart: false,
    buildService,
    ...overrides,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`, buildService);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function postJson(base, route, payload) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function disk(sandbox, path) {
  return readFileSync(join(sandbox.contentRoot, path), 'utf8');
}

test('the editor scope covers the whole content tree and reports it per section', async () => {
  await withServer(async (base) => {
    const site = await (await fetch(`${base}/api/site`)).json();
    assert.deepEqual(site.sections, EDITOR_SECTIONS);
    assert.deepEqual(site.createSections, ['post', 'page', 'categories']);

    // What each section MEANS, decided from the site's own Hugo config: articles in `post`,
    // ordinary pages in `page`, taxonomy term pages in the taxonomies the site declares.
    assert.deepEqual(site.contentKinds, { article: ['post'], page: ['page'], taxonomy: ['categories', 'tags'] });

    const body = await (await fetch(`${base}/api/documents`)).json();
    assert.equal(body.count, 51);
    assert.deepEqual(body.sections, [
      { section: 'post', label: 'post', count: 27 },
      { section: 'page', label: 'page', count: 16 },
      { section: 'categories', label: 'categories', count: 4 },
      { section: '', label: '(根)', count: 4 },
    ]);

    // Every document carries its section, kind and translation key - the list view needs
    // all three to group articles rather than dump them in one flat list.
    const about = body.documents.find((doc) => doc.path === ABOUT);
    assert.equal(about.section, 'page');
    assert.equal(about.kind, 'leaf-bundle');
    assert.equal(about.contentKind, 'page');
    assert.equal(about.translationKey, 'page/about/index');
    assert.ok(about.updatedAt, 'the list can say when a document was last touched');

    // The four types the site actually has, each read from the tree rather than assumed.
    const types = new Map(body.documents.map((doc) => [doc.path, doc.contentKind]));
    assert.equal(types.get('post/pagination-test-01.en.md'), 'article');
    assert.equal(types.get('page/about/index.md'), 'page');
    assert.equal(types.get('categories/Documentation/_index.md'), 'category');
    assert.equal(types.get('_index.md'), 'other');

    // The category page's own image is a resource of that page, not an invisible file.
    assert.ok(body.resources.some((resource) => resource.path === 'categories/Documentation/hutomo-abrianto-l2jk-uxb1BY-unsplash.jpg'));

    const group = body.groups.find((candidate) => candidate.translationKey === 'page/about/index');
    assert.deepEqual([...group.languages].sort(), ['en', 'ja', 'zh', 'zh-hant-tw']);

    // The home page is editable too, and so is a taxonomy landing page.
    const home = await (await fetch(`${base}/api/documents/raw?path=${encodeURIComponent('_index.md')}`)).json();
    assert.equal(home.kind, 'branch-bundle');
    assert.equal(home.contentKind, 'other');
    assert.equal(home.section, '');
    assert.match(home.text, /menu:/);
  });
});

test('the front-matter form describes a document without rewriting it', async (t) => {
  const sandbox = makeSandbox(t);
  await withServer(async (base) => {
    const body = await (await fetch(`${base}/api/documents/fields?path=${encodeURIComponent(ABOUT)}`)).json();

    assert.equal(body.path, ABOUT);
    assert.equal(body.editable, true);
    assert.equal(body.delimiter, '---');
    assert.equal(body.language, 'zh');

    const byPath = new Map(body.fields.map((field) => [field.path, field]));
    assert.equal(byPath.get('title').value, '关于');
    assert.equal(byPath.get('date').value, '2026-01-26');
    assert.equal(byPath.get('menu').editable, false);
    assert.equal(byPath.get('menu.main.weight').value, -90);
    assert.equal(byPath.get('menu.main.params.icon').value, 'user');
    assert.ok(body.missing.some((field) => field.key === 'tags'));

    // Menu management is deliberately not part of this: no menu entries were invented.
    assert.ok(!body.fields.some((field) => field.path.startsWith('menu.footer')));
  }, sandbox);
});

test('the form previews a change, and the save is the only thing that writes', async (t) => {
  const sandbox = makeSandbox(t);
  await withServer(async (base, buildService) => {
    const before = disk(sandbox, ABOUT);
    const set = { title: '关于本站（改名）', tags: ['about', 'meta'] };

    const preview = await (await postJson(base, '/api/documents/fields/preview', { path: ABOUT, set })).json();
    assert.equal(preview.status, 'preview');
    assert.equal(preview.changed, true);
    assert.equal(preview.bodyUnchanged, true);
    assert.equal(preview.skipped.length, 0);
    assert.deepEqual(preview.applied, [
      { path: 'title', action: 'update' },
      { path: 'tags', action: 'create' },
    ]);
    assert.ok(preview.warnings.some((warning) => warning.includes('tags')));
    assert.match(preview.diffText, /\+ tags:/);

    // A dry run leaves the file, and the backup area, untouched.
    assert.equal(disk(sandbox, ABOUT), before);
    assert.equal(existsSync(sandbox.backupRoot), false);
    assert.deepEqual(buildService.scheduled, []);

    // Confirmation is still required in band.
    const refused = await postJson(base, '/api/documents/fields/save', { path: ABOUT, set });
    assert.equal(refused.status, 400);
    assert.equal(disk(sandbox, ABOUT), before);

    const saved = await (await postJson(base, '/api/documents/fields/save', { path: ABOUT, set, confirm: true })).json();
    assert.equal(saved.status, 'written');
    assert.equal(saved.buildScheduled, true);
    assert.equal(saved.saved.onDiskMatchesTarget, true);
    assert.ok(saved.saved.backupPath, 'a form save is backed up like any other write');
    assert.equal(buildService.scheduled.length, 1);

    const after = disk(sandbox, ABOUT);
    assert.match(after, /title: 关于本站（改名）\n/);
    assert.match(after, /tags:\n {4}- about\n {4}- meta\n/);
    // Everything the form did not touch is still there, byte for byte - down to the
    // trailing space after `main:` that Hugo's own template wrote.
    assert.match(after, /menu:\n {4}main: \n {8}weight: -90\n {8}params:\n {12}icon: user\n/);
    assert.match(after, /## 这是给谁看的？/);

    // Re-signing the same values is a no-op and does not start a build.
    const again = await (await postJson(base, '/api/documents/fields/save', { path: ABOUT, set: { title: '关于本站（改名）' }, confirm: true })).json();
    assert.equal(again.status, 'noop');
    assert.equal(again.buildScheduled, false);
    assert.equal(buildService.scheduled.length, 1);
  }, sandbox);
});

test('the form refuses to flatten a nested map and reports the right path', async (t) => {
  const sandbox = makeSandbox(t);
  await withServer(async (base) => {
    const before = disk(sandbox, ABOUT);

    const preview = await (
      await postJson(base, '/api/documents/fields/preview', {
        path: ABOUT,
        set: { menu: 'main', weight: 5, 'footer.left': 7 },
      })
    ).json();

    assert.equal(preview.changed, false);
    assert.equal(preview.skipped.length, 3);
    // A map is display-only: the form will not flatten it into a scalar.
    assert.match(preview.skipped[0].reason, /嵌套映射/);
    // A bare leaf name that lives under a map is answered with the path to use instead.
    assert.match(preview.skipped[1].reason, /完整路径 menu\.main\.weight/);
    // A nested path whose parent does not exist is refused rather than invented.
    assert.match(preview.skipped[2].reason, /上层字段不存在/);
    assert.equal(disk(sandbox, ABOUT), before);

    // The full path the hint points at does work.
    const nested = await (
      await postJson(base, '/api/documents/fields/preview', { path: ABOUT, set: { 'menu.main.weight': -91 } })
    ).json();
    assert.deepEqual(nested.applied, [{ path: 'menu.main.weight', action: 'update' }]);
  }, sandbox);
});

test('creating an article is planned before it is written', async (t) => {
  const sandbox = makeSandbox(t);
  await withServer(async (base, buildService) => {
    const request = { kind: 'standalone', section: 'post', title: 'HTTP Created Post', language: 'en' };

    const planned = await (await postJson(base, '/api/documents/create', request)).json();
    assert.equal(planned.planned, true);
    assert.equal(planned.path, 'post/http-created-post.en.md');
    assert.deepEqual(planned.conflicts, []);
    assert.match(planned.text, /^---\ntitle: HTTP Created Post\n/);
    assert.equal(existsSync(join(sandbox.contentRoot, planned.path)), false, 'planning writes nothing');
    assert.deepEqual(buildService.scheduled, []);

    const created = await postJson(base, '/api/documents/create', { ...request, confirm: true });
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.equal(body.created, true);
    assert.equal(body.buildScheduled, true);
    assert.equal(existsSync(join(sandbox.contentRoot, body.path)), true);
    assert.equal(buildService.scheduled.length, 1);

    // It shows up in the listing straight away, as a draft, in the section it was made in.
    const list = await (await fetch(`${base}/api/documents`)).json();
    const doc = list.documents.find((candidate) => candidate.path === 'post/http-created-post.en.md');
    assert.equal(doc.section, 'post');
    assert.equal(doc.language, 'en');
    assert.equal(doc.meta.title, 'HTTP Created Post');
    assert.equal(doc.meta.draft, true);

    const duplicate = await postJson(base, '/api/documents/create', { ...request, confirm: true });
    assert.equal(duplicate.status, 409);
    assert.match((await duplicate.json()).error, /already exists/);
  }, sandbox);
});

test('deleting and restoring go through the trash, and closing the loop is explicit', async (t) => {
  const sandbox = makeSandbox(t);
  await withServer(async (base, buildService) => {
    const request = { path: GALLERY };

    const planned = await (await postJson(base, '/api/documents/delete', request)).json();
    assert.equal(planned.planned, true);
    assert.equal(planned.scope, 'bundle');
    assert.equal(planned.totalFiles, 8);
    assert.equal(planned.documentCount, 4);
    assert.equal(planned.resourceCount, 4);
    assert.ok(planned.files.length === 8);
    assert.equal(existsSync(join(sandbox.contentRoot, 'post/Image Gallery')), true, 'planning deletes nothing');
    assert.deepEqual(buildService.scheduled, [], 'planning builds nothing');

    const deleted = await (await postJson(base, '/api/documents/delete', { ...request, confirm: true })).json();
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.buildScheduled, true);
    assert.equal(existsSync(join(sandbox.contentRoot, 'post/Image Gallery')), false);
    assert.equal(buildService.scheduled.length, 1);

    const trash = await (await fetch(`${base}/api/trash`)).json();
    assert.equal(trash.entries.length, 1);
    assert.equal(trash.entries[0].id, deleted.trashId);
    assert.equal(trash.entries[0].files, 8);

    // Restoring is a write too, so it also closes the loop.
    const restored = await (await postJson(base, '/api/trash/restore', { id: deleted.trashId, confirm: true })).json();
    assert.equal(restored.relPath, 'post/Image Gallery');
    assert.equal(restored.buildScheduled, true);
    assert.equal(existsSync(join(sandbox.contentRoot, 'post/Image Gallery/index.md')), true);
    assert.equal(existsSync(join(sandbox.contentRoot, 'post/Image Gallery/florian-klauer-nptLmg6jqDo-unsplash.jpg')), true);
    assert.equal(buildService.scheduled.length, 2);

    const missing = await postJson(base, '/api/trash/restore', { id: 'nope', confirm: true });
    assert.equal(missing.status, 404);
  }, sandbox);
});

test('a raw save on a site page goes through the same reviewed loop', async (t) => {
  const sandbox = makeSandbox(t);
  await withServer(async (base, buildService) => {
    const before = disk(sandbox, ABOUT);

    const preview = await (await postJson(base, '/api/documents/preview', { path: ABOUT, text: `${before}\n新增段落。\n` })).json();
    assert.equal(preview.status, 'preview');
    assert.equal(preview.section, 'page');
    assert.equal(disk(sandbox, ABOUT), before);

    const saved = await (await postJson(base, '/api/documents/save', { path: ABOUT, text: `${before}\n新增段落。\n`, confirm: true })).json();
    assert.equal(saved.status, 'written');
    assert.equal(saved.buildScheduled, true);
    assert.equal(buildService.scheduled.length, 1);
    assert.match(disk(sandbox, ABOUT), /新增段落。/);
  }, sandbox);
});
