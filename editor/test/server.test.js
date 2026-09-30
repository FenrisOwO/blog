// P1.4/P1.5: the HTTP API the Vue page consumes - reads, dry-run preview and confirmed save.

import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEditorServer } from '../server/index.js';

const ROOT = join(import.meta.dirname, '..');
const SITE_ROOT = '/projects/site';
const CONTENT_ROOT = join(SITE_ROOT, 'content');

// Phase 2 added a build service and a source watcher to the server. These tests are
// about the content API, so the build layer is stubbed: otherwise a confirmed save would
// schedule a real 8 second Hugo build, and the watcher would react to whatever else runs
// in the suite.
function stubBuildService() {
  return {
    getStatus: () => ({ state: 'idle', activity: 'idle', generation: 0, queued: false, preview: { url: '/', generation: 0 }, lastBuild: null, history: [], config: {} }),
    subscribe: () => () => {},
    scheduleBuild: () => {},
    build: () => Promise.resolve(),
    stop: () => {},
  };
}

async function withServer(run, overrides = {}) {
  const server = createEditorServer({
    siteRoot: SITE_ROOT,
    contentRoot: CONTENT_ROOT,
    // These tests describe the Phase 1/2 content API, so they pin the Phase 1 scope
    // explicitly. The editor itself runs with the wider scope (server/index.js
    // EDITOR_SECTIONS); that is asserted in test/serverPhase3.test.js.
    sections: ['post'],
    editorDist: join(ROOT, 'dist'),
    buildService: stubBuildService(),
    watchSources: false,
    buildOnStart: false,
    ...overrides,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Save tests run against a throwaway copy so the real articles are never touched.
function makeSandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'hve-http-'));
  const contentRoot = join(root, 'content');
  cpSync(CONTENT_ROOT, contentRoot, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { contentRoot, backupRoot: join(root, 'backups') };
}

function postJson(base, route, payload) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

test('/api/health reports the section and languages', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.section, 'post');
    assert.equal(body.defaultLanguage, 'zh');
  });
});

test('/api/documents lists the real articles without their contents', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/documents`);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.count, 27);
    assert.equal(body.documents.length, 27);
    assert.equal(body.resources.length, 5);

    const doc = body.documents.find((candidate) => candidate.path === 'post/Image Gallery/index.en.md');
    assert.ok(doc);
    assert.equal(doc.kind, 'leaf-bundle');
    assert.equal(doc.language, 'en');
    assert.equal(doc.meta.title, 'Image Gallery');
    assert.equal('text' in doc, false);
    assert.equal('frontMatterRaw' in doc, false);
  });
});

test('/api/documents/raw returns the untouched Markdown source', async () => {
  await withServer(async (base) => {
    const path = 'post/pagination-test-01.en.md';
    const response = await fetch(`${base}/api/documents/raw?path=${encodeURIComponent(path)}`);
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.path, path);
    assert.equal(body.text, readFileSync(join(CONTENT_ROOT, path), 'utf8'));
    assert.match(body.text, /^---\ntitle: Pagination Test 01\n/);
  });
});

test('the raw endpoint refuses anything ContentReader did not identify', async () => {
  await withServer(async (base) => {
    for (const attempt of ['../hugo.toml', 'page/about/index.md', '/etc/passwd', '']) {
      const response = await fetch(`${base}/api/documents/raw?path=${encodeURIComponent(attempt)}`);
      assert.equal(response.status, 404, `expected 404 for: ${attempt}`);
    }
  });
});

test('/editor/ serves the built Vue app', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/editor/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), /<div id="app">/);
  });
});

test('/ still serves the Hugo preview, and unknown paths 404', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);

    const missing = await fetch(`${base}/definitely-not-here`);
    assert.equal(missing.status, 404);
  });
});

test('POST /api/documents/preview is a dry run end to end', async (t) => {
  const sandbox = makeSandbox(t);
  const path = 'post/pagination-test-01.en.md';
  const before = readFileSync(join(sandbox.contentRoot, path), 'utf8');
  const target = `${before}\n新增段落。\n`;

  await withServer(
    async (base) => {
      const response = await postJson(base, '/api/documents/preview', { path, text: target });
      assert.equal(response.status, 200);

      const body = await response.json();
      assert.equal(body.status, 'preview');
      assert.equal(body.path, path);
      assert.match(body.diffText, /\+ 新增段落。/);
      assert.deepEqual(body.frontMatter.changedKeys, []);
      assert.equal(body.frontMatter.bodyChanged, true);
    },
    { contentRoot: sandbox.contentRoot, backupRoot: sandbox.backupRoot },
  );

  assert.equal(readFileSync(join(sandbox.contentRoot, path), 'utf8'), before);
  assert.equal(existsSync(sandbox.backupRoot), false);
});

test('POST /api/documents/save refuses to run without explicit confirmation', async (t) => {
  const sandbox = makeSandbox(t);
  const path = 'post/pagination-test-01.en.md';
  const before = readFileSync(join(sandbox.contentRoot, path), 'utf8');

  await withServer(
    async (base) => {
      const payloads = [
        { path, text: `${before}\nX\n` },
        { path, text: `${before}\nX\n`, confirm: false },
      ];
      for (const payload of payloads) {
        const response = await postJson(base, '/api/documents/save', payload);
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /confirmation required/);
      }
    },
    { contentRoot: sandbox.contentRoot, backupRoot: sandbox.backupRoot },
  );

  assert.equal(readFileSync(join(sandbox.contentRoot, path), 'utf8'), before);
  assert.equal(existsSync(sandbox.backupRoot), false);
});

test('POST /api/documents/save writes only after confirmation, with backup and read-back', async (t) => {
  const sandbox = makeSandbox(t);
  const path = 'post/pagination-test-01.en.md';
  const before = readFileSync(join(sandbox.contentRoot, path), 'utf8');
  const target = `${before}\n确认保存的段落。\n`;

  await withServer(
    async (base) => {
      const response = await postJson(base, '/api/documents/save', { path, text: target, confirm: true });
      assert.equal(response.status, 200);

      const body = await response.json();
      assert.equal(body.status, 'written');
      assert.equal(body.onDiskMatchesTarget, true);
      assert.notEqual(body.shaAfter, body.shaBefore);
      assert.ok(body.backupPath, 'a backup path must be reported');
      assert.equal(readFileSync(body.backupPath, 'utf8'), before);

      // Re-read through the API: what the editor would show next must equal the target.
      const fresh = await fetch(`${base}/api/documents/raw?path=${encodeURIComponent(path)}`);
      assert.equal((await fresh.json()).text, target);
    },
    { contentRoot: sandbox.contentRoot, backupRoot: sandbox.backupRoot },
  );

  assert.equal(readFileSync(join(sandbox.contentRoot, path), 'utf8'), target);
});

test('preview and save reject paths outside content/post', async (t) => {
  const sandbox = makeSandbox(t);

  await withServer(
    async (base) => {
      for (const path of ['../hugo.toml', 'page/about/index.md', '/etc/passwd']) {
        const preview = await postJson(base, '/api/documents/preview', { path, text: 'x' });
        assert.equal(preview.status, 404, `preview ${path}`);

        const save = await postJson(base, '/api/documents/save', { path, text: 'x', confirm: true });
        assert.equal(save.status, 404, `save ${path}`);
      }
    },
    { contentRoot: sandbox.contentRoot, backupRoot: sandbox.backupRoot },
  );

  assert.equal(existsSync(sandbox.backupRoot), false);
});
