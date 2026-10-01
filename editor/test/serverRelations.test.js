// Phase 7 over HTTP: the plan/apply shape for cross-document edits.
//
// Same contract as every other write in this editor - a plan the user can read (which writes
// nothing), then a write behind `confirm: true` - plus the two things that only a multi-file
// change has: a per-file diff in the plan, and a 409 when a rename would silently merge two
// tags. The server runs against a throwaway copy of the fixture corpus (test/fixtures/README.md).

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createEditorServer } from '../server/index.js';
import { FIXTURE, makeFixtureSandbox } from './fixtures/harness.js';

const ROOT = join(import.meta.dirname, '..');
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

async function withSite(t, run) {
  const sandbox = makeFixtureSandbox(t, { prefix: 'hve-rel-' });
  const buildService = stubBuildService();
  const server = createEditorServer({
    siteRoot: sandbox.siteRoot,
    contentRoot: sandbox.contentRoot,
    configRoot: sandbox.configRoot,
    backupRoot: sandbox.backupRoot,
    sections: SECTIONS,
    editorDist: join(ROOT, 'dist'),
    buildService,
    watchSources: false,
    buildOnStart: false,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run({ base: `http://127.0.0.1:${port}`, contentRoot: sandbox.contentRoot, buildService });
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

test('GET /api/tags returns the fixture tag index without reading any document body', async (t) => {
  await withSite(t, async ({ base }) => {
    const response = await fetch(`${base}/api/tags`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.tagTaxonomy, 'tags');
    // The fixture's three used tags plus one orphan metadata page (tags/fixture-tag).
    assert.equal(body.tags.length, 4);
    assert.equal(body.tags.flatMap((tag) => tag.names).length, 6);

    const fixtureTag = body.tags.find((tag) => tag.name === 'fixture');
    assert.equal(fixtureTag.usage, 9);
    assert.equal(fixtureTag.documents.length, 9);
    assert.equal(fixtureTag.metadataPages.length, 0);

    const markdown = body.tags.find((tag) => tag.name === 'markdown');
    assert.equal(markdown.names.length, 2);
    assert.equal(markdown.conflicts[0].type, 'spelling');
  });
});

test('GET /api/tags/detail groups a tag\'s documents by translation key', async (t) => {
  await withSite(t, async ({ base }) => {
    const response = await fetch(`${base}/api/tags/detail?name=${encodeURIComponent('alpha')}`);
    const body = await response.json();
    assert.equal(body.usage, 2);
    assert.deepEqual(body.languages, ['en', 'zh']);
    assert.equal(body.groups.length, 1);
    assert.equal(body.groups[0].members.every((member) => member.tag === 'alpha'), true);
  });
});

test('a rename onto an existing tag is refused with 409 and what a merge would affect', async (t) => {
  await withSite(t, async ({ base, contentRoot }) => {
    const before = readFileSync(join(contentRoot, FIXTURE.article), 'utf8');
    const response = await postJson(base, '/api/tags/plan', { action: 'rename', from: 'alpha', to: 'fixture' });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.match(body.error, /合并/);
    assert.equal(body.conflict.destination, 'fixture');
    assert.equal(body.conflict.destinationInUse, true);
    assert.equal(body.conflict.affected.length, 2);
    assert.equal(readFileSync(join(contentRoot, FIXTURE.article), 'utf8'), before);
  });
});

test('POST /api/tags/plan is a dry run that names every file and shows every diff', async (t) => {
  await withSite(t, async ({ base, contentRoot }) => {
    const before = readFileSync(join(contentRoot, FIXTURE.article), 'utf8');
    const response = await postJson(base, '/api/tags/plan', { action: 'merge', from: 'alpha', to: 'beta' });
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.planned, true);
    assert.equal(body.operation, '合并标签 alpha → beta');
    assert.equal(body.counts.modify, 2);
    assert.equal(body.counts.total, 2);
    assert.equal(body.review.ok, true);
    assert.equal(body.changes.length, 2);
    assert.equal(body.changes[0].kind, 'modify');
    assert.match(body.changes[0].diffText, /^- {3}- alpha$/m);
    // The full before/after texts never leave the server.
    assert.equal(body.changes[0].before, undefined);
    assert.equal(body.changes[0].after, undefined);
    assert.equal(body.touched.length, 2);
    // The plan is advisory only.
    assert.equal(readFileSync(join(contentRoot, FIXTURE.article), 'utf8'), before);
  });
});

test('applying a tag change set requires confirmation, then rewrites and schedules a build', async (t) => {
  await withSite(t, async ({ base, contentRoot, buildService }) => {
    const unconfirmed = await postJson(base, '/api/tags/apply', { action: 'merge', from: 'alpha', to: 'beta' });
    assert.equal(unconfirmed.status, 400);
    assert.match((await unconfirmed.json()).error, /confirmation/);
    assert.equal(readFileSync(join(contentRoot, FIXTURE.article), 'utf8').includes('- alpha'), true);

    const response = await postJson(base, '/api/tags/apply', { action: 'merge', from: 'alpha', to: 'beta', confirm: true });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'committed');
    assert.equal(body.counts.modify, 2);
    assert.equal(body.buildScheduled, true);
    assert.deepEqual(buildService.builds, ['save']);
    assert.equal(readFileSync(join(contentRoot, FIXTURE.article), 'utf8').includes('- beta'), true);
    assert.equal(existsSync(join(contentRoot, FIXTURE.article)), true);

    // The trashed nothing, but backed up everything it modified.
    const trash = await (await fetch(`${base}/api/trash`)).json();
    assert.equal(trash.entries.length, 0);
  });
});

test('a tag page name that cannot be a directory is refused as a validation error', async (t) => {
  await withSite(t, async ({ base, contentRoot }) => {
    const response = await postJson(base, '/api/tags/apply', { action: 'page', name: '../evil', confirm: true });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /目录名/);
    assert.equal(existsSync(join(contentRoot, 'evil', '_index.md')), false);

    const created = await postJson(base, '/api/tags/apply', { action: 'page', name: 'Hugo Editor', title: 'Hugo 编辑器', confirm: true });
    assert.equal(created.status, 200);
    assert.equal(readFileSync(join(contentRoot, 'tags', 'Hugo Editor', '_index.md'), 'utf8'), '---\ntitle: Hugo 编辑器\n---\n');
  });
});

test('GET /api/links describes the links page, images included', async (t) => {
  await withSite(t, async ({ base }) => {
    const response = await fetch(`${base}/api/links?path=${encodeURIComponent(FIXTURE.links)}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.present, true);
    assert.equal(body.items.length, 2);
    assert.deepEqual(body.items.map((item) => item.title), ['GitHub', 'Fixture']);
    assert.equal(body.items[0].imageRef.kind, 'external');
    assert.equal(body.items[1].imageRef.kind, 'resource');
    assert.equal(body.items[1].imageRef.resourcePath, FIXTURE.linksResource);
    assert.deepEqual(body.requiredKeys, ['title', 'website']);
  });
});

test('a links plan edits one item, and an unknown key is refused with a reason', async (t) => {
  await withSite(t, async ({ base, contentRoot }) => {
    const response = await postJson(base, '/api/links/plan', {
      path: FIXTURE.links,
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
      path: FIXTURE.links,
      edit: [{ index: 0, set: { description: '代码托管平台' } }],
      confirm: true,
    });
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json()).status, 'committed');
    const text = readFileSync(join(contentRoot, FIXTURE.links), 'utf8');
    assert.match(text, /description: 代码托管平台/);
    // The other language of the same page was not touched by a per-file edit.
    assert.equal(readFileSync(join(contentRoot, 'page', 'links', 'index.en.md'), 'utf8').includes('代码托管平台'), false);
  });
});

test('a links plan for a missing file is a 404 and a no-op', async (t) => {
  await withSite(t, async ({ base }) => {
    const response = await postJson(base, '/api/links/plan', { path: 'page/links/does-not-exist.md', add: [{ title: 'x', website: 'y' }] });
    assert.equal(response.status, 404);
  });
});

test('the tag plan endpoint answers honestly for a tag nothing uses', async (t) => {
  await withSite(t, async ({ base }) => {
    const response = await postJson(base, '/api/tags/plan', { action: 'rename', from: 'no-such-tag', to: 'x' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /没有文档使用/);
  });
});
