// Phase 6 HTTP surface: browse resources, read their bytes, and change them - with the same
// rules the rest of the editor follows (a plan first, `confirm: true` to write, a build
// scheduled only when something was really written).
//
// Reads run against the real site; every write runs against a temp copy of it, so a test can
// never damage the user's images. The build service is injected, so these tests assert the
// wiring rather than Hugo (the real build is exercised by acceptance T14).

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createEditorServer } from '../server/index.js';

const ROOT = join(import.meta.dirname, '..');
const SITE_ROOT = '/projects/site';
const CONTENT_ROOT = join(SITE_ROOT, 'content');
const GALLERY = 'post/Image Gallery';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');

function fakeBuildService() {
  const scheduled = [];
  return {
    scheduled,
    getStatus: () => ({ state: 'idle', activity: 'idle', generation: 0, queued: false, preview: { url: '/', generation: 0 }, lastBuild: null, history: [] }),
    subscribe: () => () => {},
    scheduleBuild: (options = {}) => {
      scheduled.push(options);
      return {};
    },
    build: () => Promise.resolve({}),
    stop: () => {},
  };
}

function tempSite() {
  const root = mkdtempSync(join(tmpdir(), 'hve-assets-http-'));
  cpSync(CONTENT_ROOT, join(root, 'content'), { recursive: true });
  cpSync(join(SITE_ROOT, 'config'), join(root, 'config'), { recursive: true });
  cpSync(join(SITE_ROOT, 'themes'), join(root, 'themes'), { recursive: true });
  return {
    root,
    read: (relPath) => readFileSync(join(root, 'content', relPath)),
    exists: (relPath) => existsSync(join(root, 'content', relPath)),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function withServer(run, overrides = {}) {
  const buildService = overrides.buildService ?? fakeBuildService();
  const server = createEditorServer({
    siteRoot: SITE_ROOT,
    contentRoot: join(SITE_ROOT, 'content'),
    configRoot: join(SITE_ROOT, 'config', '_default'),
    editorDist: join(ROOT, 'dist'),
    watchSources: false,
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

test('GET /api/assets lists the content resources, the site trees and the limits', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/assets`);
    assert.equal(response.status, 200);
    const body = await response.json();

    const gallery = body.bundles.find((bundle) => bundle.bundlePath === GALLERY);
    assert.ok(gallery);
    assert.equal(gallery.contentKind, 'article');
    assert.equal(gallery.canUpload, true);
    assert.equal(gallery.resources.length, 4);
    assert.equal(gallery.resources.every((resource) => resource.capabilities.replace && resource.capabilities.delete), true);
    assert.equal(gallery.resources.every((resource) => resource.referenced), true);
    assert.match(gallery.resources[0].previewUrl, /^\/api\/assets\/raw\?location=content&path=/);

    // The site's own trees are listed, read-only, and the boundary is honest about it.
    assert.equal(body.static.length > 100, true, 'static/ is mirrored');
    assert.equal(body.assets.length, 3, 'assets/ holds the theme inputs');
    assert.equal(body.static.every((asset) => !asset.capabilities.replace && !asset.capabilities.delete), true);
    assert.equal(body.assets.every((asset) => asset.location === 'assets'), true);
    assert.equal(body.summary.contentResources, 7);
    assert.equal(body.summary.replaceable, 7);
    assert.equal(body.limits.maxUploadBytes > 0, true);
    assert.deepEqual(body.limits.uploadExtensions.includes('.jpg'), true);
  });
});

test('GET /api/assets/raw serves the bytes of a listed resource, and nothing else', async () => {
  await withServer(async (base) => {
    const path = `${GALLERY}/luca-bravo-alS7ewQ41M8-unsplash.jpg`;
    const response = await fetch(`${base}/api/assets/raw?path=${encodeURIComponent(path)}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(sha(bytes), sha(readFileSync(join(CONTENT_ROOT, path))), 'the bytes are the file, byte for byte');

    // A conditional request is a 304, so a gallery does not re-download unchanged images.
    const revalidated = await fetch(`${base}/api/assets/raw?path=${encodeURIComponent(path)}`, {
      headers: { 'if-none-match': response.headers.get('etag') },
    });
    assert.equal(revalidated.status, 304);

    // The site's other trees are reachable through the location that owns them.
    const asset = await fetch(`${base}/api/assets/raw?location=assets&path=${encodeURIComponent('img/avatar.png')}`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('content-type'), 'image/png');

    // Everything else is a 404 - an unlisted file, a Markdown document, a climb out of the
    // tree. There is no "does this file exist" oracle behind this endpoint.
    for (const url of [
      `/api/assets/raw?path=${encodeURIComponent('post/not-listed.png')}`,
      `/api/assets/raw?path=${encodeURIComponent(`${GALLERY}/index.md`)}`,
      `/api/assets/raw?path=${encodeURIComponent('../../etc/passwd')}`,
      `/api/assets/raw?location=assets&path=${encodeURIComponent('../../config/_default/params.toml')}`,
      `/api/assets/raw?location=theme&path=${encodeURIComponent('x.png')}`,
    ]) {
      const denied = await fetch(`${base}${url}`);
      assert.equal(denied.status, 404, `${url} should not be served`);
    }

    // A listed file the browser cannot render is refused with a reason, not served blindly.
    const notPreviewable = await fetch(`${base}/api/assets/raw?location=assets&path=${encodeURIComponent('scss/custom.scss')}`);
    assert.equal(notPreviewable.status, 400);
    assert.match((await notPreviewable.json()).error, /无法在浏览器中预览/);
  });
});

test('an upload is a plan first, then a write that needs confirmation', async () => {
  const site = tempSite();
  try {
    await withServer(
      async (base, buildService) => {
        const payload = { bundlePath: GALLERY, filename: 'from-api.png', dataBase64: PNG.toString('base64') };

        const planned = await postJson(base, '/api/assets/upload', payload);
        assert.equal(planned.status, 200);
        const plan = await planned.json();
        assert.equal(plan.planned, true);
        assert.equal(plan.canWrite, true);
        assert.equal(plan.targetPath, `${GALLERY}/from-api.png`);
        assert.equal(site.exists(plan.targetPath), false, 'a plan writes nothing');
        assert.equal(buildService.scheduled.length, 0);

        const created = await postJson(base, '/api/assets/upload', { ...payload, confirm: true });
        assert.equal(created.status, 200);
        const result = await created.json();
        assert.equal(result.status, 'created');
        assert.equal(result.buildScheduled, true);
        assert.equal(buildService.scheduled.length, 1);
        assert.equal(buildService.scheduled[0].trigger, 'save');
        assert.equal(sha(site.read(result.path)), sha(PNG), 'the bytes on disk are the bytes uploaded');
        assert.equal(result.asset.bundlePath, GALLERY);

        // The same name again is a 400 with a suggestion, and nothing is overwritten.
        const duplicate = await postJson(base, '/api/assets/upload', { ...payload, confirm: true });
        assert.equal(duplicate.status, 400);
        assert.equal((await duplicate.json()).suggestion, 'from-api-2.png');

        // A file whose bytes are not what its name claims is refused before any write.
        const mismatch = await postJson(base, '/api/assets/upload', {
          bundlePath: GALLERY,
          filename: 'from-api.jpg',
          dataBase64: PNG.toString('base64'),
          confirm: true,
        });
        assert.equal(mismatch.status, 400);
        assert.match((await mismatch.json()).error, /与扩展名 .jpg 不符/);
        assert.equal(site.exists(`${GALLERY}/from-api.jpg`), false);
      },
      { siteRoot: site.root, contentRoot: join(site.root, 'content'), backupRoot: join(site.root, 'backups') },
    );
  } finally {
    site.cleanup();
  }
});

test('replace and delete write, back up, and schedule exactly one build each', async () => {
  const site = tempSite();
  try {
    await withServer(
      async (base, buildService) => {
        const path = `${GALLERY}/hudai-gayiran-3Od_VKcDEAA-unsplash.jpg`;
        const before = sha(site.read(path));
        const replacement = readFileSync(join(CONTENT_ROOT, GALLERY, 'luca-bravo-alS7ewQ41M8-unsplash.jpg'));

        // Replace: plan, then write. The path does not change, so the page's references stay.
        const plan = await (await postJson(base, '/api/assets/replace', { path })).json();
        assert.equal(plan.status, 'preview');
        assert.equal(plan.shaBefore, before);
        assert.equal(plan.referenced, true);

        const replaced = await (await postJson(base, '/api/assets/replace', { path, dataBase64: replacement.toString('base64'), confirm: true })).json();
        assert.equal(replaced.status, 'replaced');
        assert.equal(replaced.shaAfter, sha(replacement));
        assert.equal(sha(site.read(path)), sha(replacement));
        assert.ok(existsSync(replaced.backupPath), 'the overwrite took a backup');
        assert.equal(sha(readFileSync(replaced.backupPath)), before);
        assert.equal(buildService.scheduled.length, 1);

        // Replacing with what is already there is a no-op and schedules nothing.
        const noop = await (await postJson(base, '/api/assets/replace', { path, dataBase64: replacement.toString('base64'), confirm: true })).json();
        assert.equal(noop.status, 'noop');
        assert.equal(noop.buildScheduled, false);
        assert.equal(buildService.scheduled.length, 1);

        // Delete: a plan that names the references, then a reversible move.
        const removePlan = await (await postJson(base, '/api/assets/delete', { path })).json();
        assert.equal(removePlan.planned, true);
        assert.equal(removePlan.recoverable, true);
        assert.match(removePlan.warnings[0], /失效引用/);
        assert.equal(site.exists(path), true);

        const deleted = await (await postJson(base, '/api/assets/delete', { path, confirm: true })).json();
        assert.equal(deleted.status, 'deleted');
        assert.equal(site.exists(path), false);
        assert.equal(buildService.scheduled.length, 2);
        assert.equal(buildService.scheduled[1].trigger, 'save');

        // The trash lists it as an asset deletion, and the existing restore route brings the
        // identical bytes back.
        const trash = await (await fetch(`${base}/api/trash`)).json();
        const entry = trash.entries.find((candidate) => candidate.id === deleted.trashId);
        assert.equal(entry.reason, 'asset-delete');
        assert.equal(entry.relPath, path);

        const restored = await (await postJson(base, '/api/trash/restore', { id: deleted.trashId, confirm: true })).json();
        assert.equal(restored.relPath, path);
        assert.equal(site.exists(path), true);
        assert.equal(sha(site.read(path)), sha(replacement), 'restore is byte-for-byte');
        assert.equal(buildService.scheduled.length, 3);
      },
      { siteRoot: site.root, contentRoot: join(site.root, 'content'), backupRoot: join(site.root, 'backups') },
    );
  } finally {
    site.cleanup();
  }
});

test('the write endpoints only see what the editor manages, and refuse the rest', async () => {
  const site = tempSite();
  try {
    await withServer(
      async (base) => {
        // Uploading into the content root is not a bundle operation.
        const rootUpload = await postJson(base, '/api/assets/upload', {
          bundlePath: '',
          filename: 'x.png',
          dataBase64: PNG.toString('base64'),
          confirm: true,
        });
        assert.equal(rootUpload.status, 400);
        assert.match((await rootUpload.json()).error, /不是 bundle/);

        // A format this phase does not write is refused by name.
        const svg = await postJson(base, '/api/assets/upload', {
          bundlePath: GALLERY,
          filename: 'logo.svg',
          dataBase64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64'),
          confirm: true,
        });
        assert.equal(svg.status, 400);
        assert.match((await svg.json()).error, /不支持写入 .svg/);

        // Paths the editor does not manage are simply not part of the resource namespace:
        // the answer is 404 (there is no such resource here), not 403 (there is one, but you
        // may not touch it) - the same rule the document endpoints follow.
        for (const path of ['layouts/x.png', 'post/../_index.md', 'post/Image Gallery/missing.jpg']) {
          const missing = await postJson(base, '/api/assets/delete', { path, confirm: true });
          assert.equal(missing.status, 404, `${path} should not be a resource`);
        }
        assert.equal(site.exists('layouts/x.png'), false);
      },
      { siteRoot: site.root, contentRoot: join(site.root, 'content'), backupRoot: join(site.root, 'backups') },
    );
  } finally {
    site.cleanup();
  }
});
