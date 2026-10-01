// P1.4/P1.5: the HTTP API the Vue page consumes - reads, dry-run preview and confirmed save.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createEditorServer } from '../server/index.js';
import { FIXTURE, FIXTURE_CONTENT, FIXTURE_SITE, makeFixtureSandbox } from './fixtures/harness.js';

const ROOT = join(import.meta.dirname, '..');
// Read-only tests point straight at the fixture corpus (test/fixtures/README.md); tests that
// write get a writable copy from makeFixtureSandbox instead.
const SITE_ROOT = FIXTURE_SITE;
const CONTENT_ROOT = FIXTURE_CONTENT;

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
  const siteRoot = overrides.siteRoot ?? SITE_ROOT;
  const server = createEditorServer({
    siteRoot,
    contentRoot: CONTENT_ROOT,
    // These tests describe the Phase 1/2 content API, so they pin the Phase 1 scope
    // explicitly. The editor itself runs with the wider scope (server/index.js
    // EDITOR_SECTIONS); that is asserted in test/serverPhase3.test.js.
    sections: ['post'],
    editorDist: join(ROOT, 'dist'),
    buildService: stubBuildService(),
    watchSources: false,
    buildOnStart: false,
    // The settings layer is outside these tests' subject, but its config root must still be
    // the fixture's so no request can reach the user's own config.
    configRoot: join(siteRoot, 'config', '_default'),
    // The preview layer only reads a published output; it is never derived from the site
    // content, so a fixture server points it at the fixture's own (usually absent) public/.
    publishDir: join(siteRoot, 'public'),
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

test('/api/documents lists the fixture articles without their contents', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/documents`);
    assert.equal(response.status, 200);
    const body = await response.json();

    // The fixture's post section (test/fixtures/README.md): 9 Markdown documents - the
    // article, second article and markdown bundle in both languages, the bundle in both
    // languages, and the unsuffixed draft - plus the bundle's 2 image resources.
    assert.equal(body.count, 9);
    assert.equal(body.documents.length, 9);
    assert.equal(body.resources.length, 2);

    const doc = body.documents.find((candidate) => candidate.path === FIXTURE.bundleEn);
    assert.ok(doc);
    assert.equal(doc.kind, 'leaf-bundle');
    assert.equal(doc.language, 'en');
    assert.equal(doc.meta.title, 'Fixture Bundle');
    assert.equal('text' in doc, false);
    assert.equal('frontMatterRaw' in doc, false);
  });
});

test('/api/documents/raw returns the untouched Markdown source', async () => {
  await withServer(async (base) => {
    const path = FIXTURE.article;
    const response = await fetch(`${base}/api/documents/raw?path=${encodeURIComponent(path)}`);
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.path, path);
    assert.equal(body.text, readFileSync(join(CONTENT_ROOT, path), 'utf8'));
    // The fixture article's front matter opens with its own title, which is what a raw
    // read must hand back byte for byte.
    assert.match(body.text, /^---\ntitle: Fixture Article\n/);
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

test('/ still serves the Hugo preview, and unknown paths 404', async (t) => {
  // The preview is the published output, which is not site content: the test supplies its
  // own one-file "build" instead of reading the user's public/.
  const sandbox = makeFixtureSandbox(t, { prefix: 'hve-http-' });
  const publicRoot = join(sandbox.siteRoot, 'public');
  mkdirSync(publicRoot, { recursive: true });
  writeFileSync(join(publicRoot, 'index.html'), '<!doctype html><title>fixture preview</title>');

  await withServer(
    async (base) => {
      const response = await fetch(`${base}/`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /fixture preview/);

      const missing = await fetch(`${base}/definitely-not-here`);
      assert.equal(missing.status, 404);
    },
    { siteRoot: sandbox.siteRoot, contentRoot: sandbox.contentRoot, publishDir: publicRoot },
  );
});

test('POST /api/documents/preview is a dry run end to end', async (t) => {
  const sandbox = makeFixtureSandbox(t, { prefix: 'hve-http-' });
  const path = FIXTURE.article;
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
    { siteRoot: sandbox.siteRoot, contentRoot: sandbox.contentRoot, backupRoot: sandbox.backupRoot },
  );

  assert.equal(readFileSync(join(sandbox.contentRoot, path), 'utf8'), before);
  assert.equal(existsSync(sandbox.backupRoot), false);
});

test('POST /api/documents/save refuses to run without explicit confirmation', async (t) => {
  const sandbox = makeFixtureSandbox(t, { prefix: 'hve-http-' });
  const path = FIXTURE.article;
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
    { siteRoot: sandbox.siteRoot, contentRoot: sandbox.contentRoot, backupRoot: sandbox.backupRoot },
  );

  assert.equal(readFileSync(join(sandbox.contentRoot, path), 'utf8'), before);
  assert.equal(existsSync(sandbox.backupRoot), false);
});

test('POST /api/documents/save writes only after confirmation, with backup and read-back', async (t) => {
  const sandbox = makeFixtureSandbox(t, { prefix: 'hve-http-' });
  const path = FIXTURE.article;
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
    { siteRoot: sandbox.siteRoot, contentRoot: sandbox.contentRoot, backupRoot: sandbox.backupRoot },
  );

  assert.equal(readFileSync(join(sandbox.contentRoot, path), 'utf8'), target);
});

test('preview and save reject paths outside content/post', async (t) => {
  const sandbox = makeFixtureSandbox(t, { prefix: 'hve-http-' });

  await withServer(
    async (base) => {
      for (const path of ['../hugo.toml', 'page/about/index.md', '/etc/passwd']) {
        const preview = await postJson(base, '/api/documents/preview', { path, text: 'x' });
        assert.equal(preview.status, 404, `preview ${path}`);

        const save = await postJson(base, '/api/documents/save', { path, text: 'x', confirm: true });
        assert.equal(save.status, 404, `save ${path}`);
      }
    },
    { siteRoot: sandbox.siteRoot, contentRoot: sandbox.contentRoot, backupRoot: sandbox.backupRoot },
  );

  assert.equal(existsSync(sandbox.backupRoot), false);
});
