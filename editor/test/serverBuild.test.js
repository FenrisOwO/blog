// The Phase 2 HTTP surface: the layer map, build status, manual build, and the rule that
// closing the edit loop is tied to a REAL save (a no-op must not start a build).
//
// The build service is injected so these tests assert the wiring, not Hugo.

import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEditorServer } from '../server/index.js';

const ROOT = join(import.meta.dirname, '..');
const SITE_ROOT = '/projects/site';
const CONTENT_ROOT = join(SITE_ROOT, 'content');

function fakeBuildService() {
  const scheduled = [];
  const started = [];
  let status = {
    state: 'idle',
    activity: 'idle',
    generation: 0,
    queued: false,
    preview: { url: '/', generation: 0 },
    lastBuild: null,
    history: [],
    config: { siteRoot: SITE_ROOT },
  };

  return {
    scheduled,
    started,
    getStatus: () => status,
    subscribe: () => () => {},
    scheduleBuild: (options = {}) => {
      scheduled.push(options);
      return status;
    },
    build: (options = {}) => {
      started.push(options);
      return Promise.resolve(status);
    },
    stop: () => {},
    setStatus(next) {
      status = { ...status, ...next };
    },
  };
}

function makeSandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'hve-buildhttp-'));
  const contentRoot = join(root, 'content');
  cpSync(CONTENT_ROOT, contentRoot, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { contentRoot, backupRoot: join(root, 'backups') };
}

async function withServer(run, overrides = {}) {
  const buildService = overrides.buildService ?? fakeBuildService();
  const server = createEditorServer({
    siteRoot: SITE_ROOT,
    contentRoot: CONTENT_ROOT,
    // These tests describe the Phase 1/2 content API, so they pin the Phase 1 scope
    // explicitly. The editor itself runs with the wider scope (server/index.js
    // EDITOR_SECTIONS); that is asserted in test/serverPhase3.test.js.
    sections: ['post'],
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

test('/api/site names the source, build, output and preview layers explicitly', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/site`);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.siteRoot, SITE_ROOT);
    assert.deepEqual(
      Object.keys(body.layers).sort(),
      ['backups', 'build', 'config', 'editor', 'output', 'preview', 'source', 'trash'],
    );
    // Phase 5 added the config layer: the site's own TOML files, and the list of the ones the
    // settings screen is allowed to write.
    assert.equal(body.layers.config.path, join(SITE_ROOT, 'config', '_default'));
    assert.deepEqual(body.layers.config.files, ['hugo.toml', 'languages.toml', 'markup.toml', 'menu.toml', 'params.toml', 'related.toml']);
    assert.equal(body.layers.output.path, join(SITE_ROOT, 'public'));
    assert.equal(body.layers.preview.path, '/');
    // Deleted documents live in the editor's own tree, never inside the site.
    assert.equal(body.layers.trash.path.startsWith(SITE_ROOT), false);
    assert.ok(body.layers.trash.path.startsWith(ROOT));

    // The scope the editor manages is part of the contract, not an implementation detail.
    assert.deepEqual(body.sections, ['post']);
    assert.deepEqual(body.createSections, ['post', 'page', 'categories']);

    // The build must never be told to write inside the project.
    assert.equal(body.layers.build.path.startsWith(SITE_ROOT), false);
    // Nor may it read the site in place: the build runs against a mirror on a local
    // filesystem, because reading ~950 files from the site's mount costs ~8s per build.
    assert.equal(body.layers.build.sourceMirror.startsWith(SITE_ROOT), false);
    assert.ok(body.layers.build.sourceMirror.endsWith('source'));
    assert.ok(body.layers.build.workRoot, 'the build work directory is reported, not inferred');

    assert.equal(body.hugo.version !== null, true);
    assert.equal(body.hugo.extended, true);
  });
});

test('/api/build/status reports the service state and the preview generation', async () => {
  await withServer(async (base, buildService) => {
    buildService.setStatus({ state: 'success', generation: 7, preview: { url: '/', generation: 7 } });

    const body = await (await fetch(`${base}/api/build/status`)).json();

    assert.equal(body.state, 'success');
    assert.equal(body.generation, 7);
    assert.equal(body.preview.url, '/');
  });
});

test('POST /api/build accepts a manual build without blocking on it', async () => {
  await withServer(async (base, buildService) => {
    const response = await postJson(base, '/api/build', { trigger: 'manual' });

    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.accepted, true);
    assert.deepEqual(buildService.started, [{ trigger: 'manual' }]);
  });
});

test('a real save schedules a build so the preview follows the edit', async (t) => {
  const sandbox = makeSandbox(t);
  await withServer(
    async (base, buildService) => {
      const path = 'post/shortcodes/index.md';
      const original = readFileSync(join(sandbox.contentRoot, path), 'utf8');
      const edited = original.replace('---\n', '---\nupdated: true\n');

      const response = await postJson(base, '/api/documents/save', { path, text: edited, confirm: true });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.status, 'written');
      assert.equal(body.buildScheduled, true);
      assert.deepEqual(buildService.scheduled, [{ trigger: 'save' }]);
    },
    { contentRoot: sandbox.contentRoot, backupRoot: sandbox.backupRoot },
  );
});

test('a no-op save schedules nothing - it does not even touch the disk', async (t) => {
  const sandbox = makeSandbox(t);
  await withServer(
    async (base, buildService) => {
      const path = 'post/shortcodes/index.md';
      const original = readFileSync(join(sandbox.contentRoot, path), 'utf8');

      const response = await postJson(base, '/api/documents/save', { path, text: original, confirm: true });
      const body = await response.json();

      assert.equal(body.status, 'noop');
      assert.equal(body.backupPath, null);
      assert.equal(body.buildScheduled, false);
      assert.deepEqual(buildService.scheduled, []);
    },
    { contentRoot: sandbox.contentRoot, backupRoot: sandbox.backupRoot },
  );
});

test('a save without confirmation neither writes nor builds', async (t) => {
  const sandbox = makeSandbox(t);
  await withServer(
    async (base, buildService) => {
      const response = await postJson(base, '/api/documents/save', {
        path: 'post/shortcodes/index.md',
        text: 'changed',
      });

      assert.equal(response.status, 400);
      assert.deepEqual(buildService.scheduled, []);
    },
    { contentRoot: sandbox.contentRoot, backupRoot: sandbox.backupRoot },
  );
});

test('a missing output directory schedules a startup build', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hve-startup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const buildService = fakeBuildService();

  await withServer(
    async () => {
      assert.equal(existsSync(join(root, 'index.html')), false);
      assert.deepEqual(buildService.scheduled, [{ trigger: 'startup', delay: 0 }]);
    },
    { publishDir: root, buildService, buildOnStart: true },
  );
});

test('an existing output directory is left alone at startup', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hve-startup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const buildService = fakeBuildService();
  writeFileSync(join(root, 'index.html'), '<html></html>');

  await withServer(
    async () => {
      assert.deepEqual(buildService.scheduled, []);
    },
    { publishDir: root, buildService, buildOnStart: true },
  );
});
