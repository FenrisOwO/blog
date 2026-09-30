// Phase 7 over HTTP: the plan/apply shape for cross-document edits.
//
// Same contract as every other write in this editor - a plan the user can read (which writes
// nothing), then a write behind `confirm: true` - plus the two things that only a multi-file
// change has: a per-file diff in the plan, and a 409 when a rename would silently merge two
// tags. The server runs against a throwaway copy of the real site.

import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEditorServer } from '../server/index.js';

const ROOT = join(import.meta.dirname, '..');
const SITE_ROOT = '/projects/site';
const SECTIONS = ['post', 'page', 'categories', ''];

function stubBuildService() {
  const builds = [];
  return {
    builds,
    getStatus: () => ({ state: 'idle', activity: 'idle', generation: 0, queued: false, preview: { url: '/', generation: 0 }, lastBuild: null, history: [], config: {} }),
    subscribe: () => () => {},
    scheduleBuild: (options) => builds.push(options?.trigger ?? 'unknown'),
    build: () => Promise.resolve(),
    stop: () => {},
  };
}

async function withSite(run) {
  const root = mkdtempSync(join(tmpdir(), 'hve-rel-'));
  cpSync(join(SITE_ROOT, 'content'), join(root, 'content'), { recursive: true });
  cpSync(join(SITE_ROOT, 'config'), join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'backups'), { recursive: true });
  const buildService = stubBuildService();
  const server = createEditorServer({
    siteRoot: root,
    contentRoot: join(root, 'content'),
    configRoot: join(root, 'config', '_default'),
    backupRoot: join(root, 'backups'),
    sections: SECTIONS,
    editorDist: join(ROOT, 'dist'),
    buildService,
    watchSources: false,
    buildOnStart: false,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run({ base: `http://127.0.0.1:${port}`, root, contentRoot: join(root, 'content'), buildService });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}

function postJson(base, route, payload) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

test('GET /api/tags returns the site tag index without reading any document body', async () => {
  await withSite(async ({ base }) => {
    const response = await fetch(`${base}/api/tags`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.tagTaxonomy, 'tags');
    assert.equal(body.tags.length, 13);
    assert.equal(body.tags.flatMap((tag) => tag.names).length, 14);

    const pagination = body.tags.find((tag) => tag.name === 'pagination');
    assert.equal(pagination.usage, 12);
    assert.equal(pagination.documents.length, 12);
    assert.equal(pagination.metadataPages.length, 0);

    const markdown = body.tags.find((tag) => tag.name === 'markdown');
    assert.equal(markdown.names.length, 2);
    assert.equal(markdown.conflicts[0].type, 'spelling');
  });
});

test('GET /api/tags/detail groups a tag\'s documents by translation key', async () => {
  await withSite(async ({ base }) => {
    const response = await fetch(`${base}/api/tags/detail?name=${encodeURIComponent('隐私')}`);
    const body = await response.json();
    assert.equal(body.usage, 3);
    assert.deepEqual(body.languages, ['ja', 'zh', 'zh-hant-tw']);
    assert.equal(body.groups.length, 1);
    assert.equal(body.groups[0].members.every((member) => member.tag === '隐私'), true);
  });
});

test('a rename onto an existing tag is refused with 409 and what a merge would affect', async () => {
  await withSite(async ({ base, contentRoot }) => {
    const before = readFileSync(join(contentRoot, 'post', 'pagination-test-01.en.md'), 'utf8');
    const response = await postJson(base, '/api/tags/plan', { action: 'rename', from: 'test', to: 'pagination' });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.match(body.error, /合并/);
    assert.equal(body.conflict.destination, 'pagination');
    assert.equal(body.conflict.destinationInUse, true);
    assert.equal(body.conflict.affected.length, 12);
    assert.equal(readFileSync(join(contentRoot, 'post', 'pagination-test-01.en.md'), 'utf8'), before);
  });
});

test('POST /api/tags/plan is a dry run that names every file and shows every diff', async () => {
  await withSite(async ({ base, contentRoot }) => {
    const before = readFileSync(join(contentRoot, 'post', 'pagination-test-01.en.md'), 'utf8');
    const response = await postJson(base, '/api/tags/plan', { action: 'merge', from: 'test', to: 'testing' });
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.planned, true);
    assert.equal(body.operation, '合并标签 test → testing');
    assert.equal(body.counts.modify, 12);
    assert.equal(body.counts.total, 12);
    assert.equal(body.review.ok, true);
    assert.equal(body.changes.length, 12);
    assert.equal(body.changes[0].kind, 'modify');
    assert.match(body.changes[0].diffText, /^- {3}- test$/m);
    // The full before/after texts never leave the server.
    assert.equal(body.changes[0].before, undefined);
    assert.equal(body.changes[0].after, undefined);
    assert.equal(body.touched.length, 12);
    // The plan is advisory only.
    assert.equal(readFileSync(join(contentRoot, 'post', 'pagination-test-01.en.md'), 'utf8'), before);
  });
});

test('applying a tag change set requires confirmation, then rewrites and schedules a build', async () => {
  await withSite(async ({ base, contentRoot, buildService }) => {
    const unconfirmed = await postJson(base, '/api/tags/apply', { action: 'merge', from: 'test', to: 'testing' });
    assert.equal(unconfirmed.status, 400);
    assert.match((await unconfirmed.json()).error, /confirmation/);
    assert.equal(readFileSync(join(contentRoot, 'post', 'pagination-test-01.en.md'), 'utf8').includes('- test'), true);

    const response = await postJson(base, '/api/tags/apply', { action: 'merge', from: 'test', to: 'testing', confirm: true });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'committed');
    assert.equal(body.counts.modify, 12);
    assert.equal(body.buildScheduled, true);
    assert.deepEqual(buildService.builds, ['save']);
    assert.equal(readFileSync(join(contentRoot, 'post', 'pagination-test-01.en.md'), 'utf8').includes('- testing'), true);
    assert.equal(existsSync(join(contentRoot, 'post', 'pagination-test-01.en.md')), true);

    // The trashed nothing, but backed up everything it modified.
    const trash = await (await fetch(`${base}/api/trash`)).json();
    assert.equal(trash.entries.length, 0);
  });
});

test('a tag page name that cannot be a directory is refused as a validation error', async () => {
  await withSite(async ({ base, contentRoot }) => {
    const response = await postJson(base, '/api/tags/apply', { action: 'page', name: '../evil', confirm: true });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /目录名/);
    assert.equal(existsSync(join(contentRoot, 'evil', '_index.md')), false);

    const created = await postJson(base, '/api/tags/apply', { action: 'page', name: 'Hugo Editor', title: 'Hugo 编辑器', confirm: true });
    assert.equal(created.status, 200);
    assert.equal(readFileSync(join(contentRoot, 'tags', 'Hugo Editor', '_index.md'), 'utf8'), '---\ntitle: Hugo 编辑器\n---\n');
  });
});

test('GET /api/links describes the links page, images included', async () => {
  await withSite(async ({ base }) => {
    const response = await fetch(`${base}/api/links?path=${encodeURIComponent('page/links/index.md')}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.present, true);
    assert.equal(body.items.length, 2);
    assert.deepEqual(body.items.map((item) => item.title), ['GitHub', 'TypeScript']);
    assert.equal(body.items[0].imageRef.kind, 'external');
    assert.equal(body.items[1].imageRef.kind, 'resource');
    assert.equal(body.items[1].imageRef.resourcePath, 'page/links/ts-logo-128.jpg');
    assert.deepEqual(body.requiredKeys, ['title', 'website']);
  });
});

test('a links plan edits one item, and an unknown key is refused with a reason', async () => {
  await withSite(async ({ base, contentRoot }) => {
    const response = await postJson(base, '/api/links/plan', {
      path: 'page/links/index.md',
      edit: [{ index: 0, set: { description: '代码托管平台' } }],
      add: [{ title: 'nope' }],
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.counts.modify, 1);
    assert.deepEqual(body.applied, [{ action: 'edit', index: 0, key: 'description', value: '代码托管平台' }]);
    assert.equal(body.skipped[0].reason.includes('必填字段'), true);
    assert.equal(body.changes[0].diff.changed, 2);

    const confirmed = await postJson(base, '/api/links/apply', {
      path: 'page/links/index.md',
      edit: [{ index: 0, set: { description: '代码托管平台' } }],
      confirm: true,
    });
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json()).status, 'committed');
    const text = readFileSync(join(contentRoot, 'page', 'links', 'index.md'), 'utf8');
    assert.match(text, /description: 代码托管平台/);
    // The other language of the same page was not touched by a per-file edit.
    assert.equal(readFileSync(join(contentRoot, 'page', 'links', 'index.en.md'), 'utf8').includes('代码托管平台'), false);
  });
});

test('a links plan for a missing file is a 404 and a no-op', async () => {
  await withSite(async ({ base }) => {
    const response = await postJson(base, '/api/links/plan', { path: 'page/links/does-not-exist.md', add: [{ title: 'x', website: 'y' }] });
    assert.equal(response.status, 404);
  });
});

test('the tag plan endpoint answers honestly for a tag nothing uses', async () => {
  await withSite(async ({ base }) => {
    const response = await postJson(base, '/api/tags/plan', { action: 'rename', from: 'no-such-tag', to: 'x' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /没有文档使用/);
  });
});
