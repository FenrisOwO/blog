// Phase Insert E at the HTTP surface: the cover verdict the front-matter form gets, the check
// the image dialog runs before it inserts a reference, and the promise that a save still
// returns everything it returned before (only with verdicts added).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { EDITOR_SECTIONS, createEditorServer } from '../server/index.js';
import { FIXTURE, makeFixtureSandbox } from './fixtures/harness.js';

const ROOT = join(import.meta.dirname, '..');

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

async function withServer(sandbox, run) {
  const buildService = fakeBuildService();
  const server = createEditorServer({
    siteRoot: sandbox.siteRoot,
    contentRoot: sandbox.contentRoot,
    configRoot: sandbox.configRoot,
    backupRoot: sandbox.backupRoot,
    publishDir: join(sandbox.siteRoot, 'public'),
    sections: EDITOR_SECTIONS,
    editorDist: join(ROOT, 'dist'),
    watchSources: false,
    buildOnStart: false,
    buildService,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const json = async (response) => ({ status: response.status, body: await response.json() });

test('the form and the image dialog get the same verdict for a cover', async (t) => {
  const sandbox = makeFixtureSandbox(t, { prefix: 'hve-server-refs-' });
  // A standalone article - no bundle - whose cover names a file in another page's bundle: the
  // value the editor used to accept silently and the build then published as a 404.
  const standalone = 'post/standalone-cover.md';
  mkdirSync(join(sandbox.contentRoot, 'post'), { recursive: true });
  writeFileSync(
    join(sandbox.contentRoot, standalone),
    '---\ntitle: 单文件\nimage: categories/fixture-category/fixture-banner.png\n---\n\n正文。\n',
  );

  await withServer(sandbox, async (base) => {
    // A bundle's own resource: resolvable, and the form says so without changing the value.
    const bundleForm = await json(await fetch(`${base}/api/documents/fields?path=${encodeURIComponent(FIXTURE.bundle)}`));
    assert.equal(bundleForm.status, 200);
    const cover = bundleForm.body.fields.find((field) => field.key === 'image');
    assert.equal(cover.value, 'fixture-photo.jpg');
    assert.equal(cover.reference.ok, true);
    assert.equal(cover.reference.kind, 'page-resource');

    // The refusal: a path in the content tree that belongs to another page's bundle.
    const form = await json(await fetch(`${base}/api/documents/fields?path=${encodeURIComponent(standalone)}`));
    assert.equal(form.status, 200);
    const broken = form.body.fields.find((field) => field.key === 'image');
    assert.equal(broken.value, 'categories/fixture-category/fixture-banner.png');
    assert.equal(broken.reference.ok, false);
    assert.equal(broken.reference.kind, 'foreign-resource');
    assert.match(broken.reference.reason, /内容树/);
    assert.ok(broken.reference.suggestion, 'the form can offer what would work instead');

    // The same question on demand, for a destination someone typed into the image dialog.
    const good = await json(await fetch(`${base}/api/documents/reference?path=${encodeURIComponent(FIXTURE.bundle)}&value=${encodeURIComponent('fixture-photo.jpg')}`));
    assert.equal(good.status, 200);
    assert.equal(good.body.verdict.ok, true);

    const staticUrl = await json(await fetch(`${base}/api/documents/reference?path=${encodeURIComponent(standalone)}&value=${encodeURIComponent('/img/logo.png')}`));
    assert.equal(staticUrl.body.verdict.kind, 'site-url');
    assert.equal(staticUrl.body.verdict.ok, true);

    const refused = await json(await fetch(`${base}/api/documents/reference?path=${encodeURIComponent(standalone)}&value=${encodeURIComponent('missing.png')}`));
    assert.equal(refused.body.verdict.ok, false);

    // No document, no answer: the caller always names the document the value would go into.
    const noPath = await json(await fetch(`${base}/api/documents/reference?value=fixture-photo.jpg`));
    assert.equal(noPath.status, 400);
    assert.match(noPath.body.error, /文档路径/);

    // Saving still answers the way it did, and the verdict is recomputed for the new value.
    const saved = await json(
      await fetch(`${base}/api/documents/fields/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: standalone, set: { image: '/img/logo.png' }, confirm: true }),
      }),
    );
    assert.equal(saved.status, 200);
    assert.equal(saved.body.status, 'written');
    assert.equal(saved.body.buildScheduled, true);
    assert.ok(saved.body.saved.onDiskMatchesTarget);
    const afterSave = saved.body.fields.fields.find((field) => field.key === 'image');
    assert.equal(afterSave.value, '/img/logo.png');
    assert.equal(afterSave.reference.ok, true, 'the form is honest about the value it just wrote');
  });
});
