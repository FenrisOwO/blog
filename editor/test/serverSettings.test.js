// The Phase 5 HTTP surface: read the site's settings, dry-run a change, confirm it, and read
// a config file back - with the same rules every other write in this editor follows.
//
// The build service is injected, so these tests assert the wiring (a real save schedules a
// build, a no-op save does not) rather than Hugo. The real build is exercised in
// `settingsHugo.test.js` and by acceptance T13/T14.

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { readToml } from '../src/settings/toml/index.js';

import { createEditorServer } from '../server/index.js';

const ROOT = join(import.meta.dirname, '..');
const SITE_ROOT = '/projects/site';
const CONFIG_FILES = ['hugo.toml', 'languages.toml', 'markup.toml', 'menu.toml', 'params.toml', 'related.toml'];

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

// A whole temp site root, so a settings save can be exercised without ever writing into
// /projects/site. Only config is copied: the settings API never reads content.
function tempSite() {
  const root = mkdtempSync(join(tmpdir(), 'hve-settings-http-'));
  cpSync(join(SITE_ROOT, 'config'), join(root, 'config'), { recursive: true });
  cpSync(join(SITE_ROOT, 'themes'), join(root, 'themes'), { recursive: true });
  return {
    root,
    configRoot: join(root, 'config', '_default'),
    backupRoot: join(root, 'backups'),
    read: (file) => readFileSync(join(root, 'config', '_default', file), 'utf8'),
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

test('GET /api/settings describes the real site without writing anything', async () => {
  await withServer(async (base) => {
    const before = readFileSync(join(SITE_ROOT, 'config', '_default', 'params.toml'), 'utf8');
    const response = await fetch(`${base}/api/settings`);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.configRoot, join(SITE_ROOT, 'config', '_default'));
    assert.deepEqual(body.files.map((file) => file.file), CONFIG_FILES);
    assert.ok(body.files.every((file) => file.sha256.length === 64 && file.editable));
    // The real site's own values, read from the same file: this config belongs to the user,
    // so the payload is checked against it rather than against the shipped defaults.
    const realParams = readToml(before).values;
    assert.equal(body.settings['params.footer.since'].value, realParams['footer.since']);
    assert.equal(
      body.settings['params.colorScheme.default'].source,
      realParams['colorScheme.default'] === undefined ? 'theme' : 'site',
    );
    assert.equal(body.settings['params.sidebar.subtitle'].languageRows.length, 4);
    assert.equal(body.settings['menu.social'].entries.length, 2);
    assert.equal(body.settings['params.widgets.homepage'].widgetTypes.includes('search'), true);
    assert.ok(body.unmanaged['params.toml'].some((leaf) => leaf.path === 'mainSections'));
    // The payload never carries the file text.
    assert.equal('docs' in body, false);
    assert.equal('targetIndex' in body, false);
    assert.equal(readFileSync(join(SITE_ROOT, 'config', '_default', 'params.toml'), 'utf8'), before);
  });
});

test('a dry run changes nothing, and a save without confirm is refused', async () => {
  const site = tempSite();
  try {
    await withServer(
      async (base, buildService) => {
        const before = site.read('params.toml');
        const next = readToml(before).values['footer.since'] + 1;

        const preview = await postJson(base, '/api/settings/preview', { set: { 'params.footer.since': next } });
        assert.equal(preview.status, 200);
        const plan = await preview.json();
        assert.equal(plan.status, 'preview');
        assert.deepEqual(plan.changedFiles, ['params.toml']);
        assert.match(plan.files[0].diffText, new RegExp(`since = ${next}`));
        assert.equal(site.read('params.toml'), before);
        assert.equal(buildService.scheduled.length, 0);

        const refused = await postJson(base, '/api/settings/save', { set: { 'params.footer.since': next } });
        assert.equal(refused.status, 400);
        assert.match((await refused.json()).error, /confirmation required/);
        assert.equal(site.read('params.toml'), before);
        assert.equal(buildService.scheduled.length, 0);
      },
      { siteRoot: site.root, configRoot: site.configRoot, backupRoot: site.backupRoot },
    );
  } finally {
    site.cleanup();
  }
});

test('a confirmed save writes the file, reports the scope and schedules a settings build', async () => {
  const site = tempSite();
  try {
    await withServer(
      async (base, buildService) => {
        const next = readToml(site.read('params.toml')).values['footer.since'] + 1;
        const response = await postJson(base, '/api/settings/save', {
          confirm: true,
          set: { 'params.footer.since': next, 'hugo.title': 'Changed Title' },
        });
        assert.equal(response.status, 200);
        const result = await response.json();

        assert.equal(result.status, 'written');
        assert.deepEqual([...result.touched].sort(), ['hugo.toml', 'params.toml']);
        assert.equal(result.buildScheduled, true);
        assert.equal(result.files.every((file) => file.status === 'written' && existsSync(file.backupPath)), true);
        assert.equal(site.read('params.toml').includes(`since = ${next}`), true);
        assert.equal(site.read('hugo.toml').includes('"Changed Title"'), true);

        // The build is scheduled once, and it is a settings save, not a content save.
        assert.equal(buildService.scheduled.length, 1);
        assert.equal(buildService.scheduled[0].trigger, 'settings');

        // The response carries the fresh descriptor, so the form does not have to re-fetch.
        assert.equal(result.description.settings['params.footer.since'].value, next);
        assert.equal(result.description.settings['hugo.title'].value, 'Changed Title');
      },
      { siteRoot: site.root, configRoot: site.configRoot, backupRoot: site.backupRoot },
    );
  } finally {
    site.cleanup();
  }
});

test('a no-op save is reported as one and starts no build', async () => {
  const site = tempSite();
  try {
    await withServer(
      async (base, buildService) => {
        const response = await postJson(base, '/api/settings/save', {
          confirm: true,
          set: { 'params.footer.since': readToml(site.read('params.toml')).values['footer.since'] },
        });
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.status, 'noop');
        assert.equal(result.buildScheduled, false);
        assert.equal(buildService.scheduled.length, 0);
      },
      { siteRoot: site.root, configRoot: site.configRoot, backupRoot: site.backupRoot },
    );
  } finally {
    site.cleanup();
  }
});

test('validation failures answer 400 with the setting id', async () => {
  const site = tempSite();
  try {
    await withServer(
      async (base) => {
        const response = await postJson(base, '/api/settings/save', {
          confirm: true,
          set: { 'params.comments.provider': 'twitter' },
        });
        assert.equal(response.status, 400);
        const body = await response.json();
        assert.match(body.error, /只能是/);
        assert.equal(body.id, 'params.comments.provider');

        const unknown = await postJson(base, '/api/settings/save', { confirm: true, set: { 'nope.nope': 1 } });
        assert.equal(unknown.status, 400);
        assert.match((await unknown.json()).error, /未知的设置项/);
      },
      { siteRoot: site.root, configRoot: site.configRoot, backupRoot: site.backupRoot },
    );
  } finally {
    site.cleanup();
  }
});

test('the raw view serves a config file and refuses anything else', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/settings/raw?file=params.toml`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.text, readFileSync(join(SITE_ROOT, 'config', '_default', 'params.toml'), 'utf8'));
    assert.ok(body.tables.includes('cookies.categories'));

    const traversal = await fetch(`${base}/api/settings/raw?file=../../hugo.toml`);
    assert.equal(traversal.status, 400);
    assert.match((await traversal.json()).error, /不可读取的配置文件/);

    const missing = await fetch(`${base}/api/settings/raw?file=missing.toml`);
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /not found/);
  });
});

test('the config layer is reported next to the content layers', async () => {
  await withServer(async (base) => {
    const body = await (await fetch(`${base}/api/site`)).json();
    assert.equal(body.layers.config.path, join(SITE_ROOT, 'config', '_default'));
    assert.deepEqual(body.layers.config.files, CONFIG_FILES);
    assert.match(body.layers.config.role, /TOML engine/);
  });
});

test('a settings save cannot reach outside the config directory', async () => {
  const site = tempSite();
  try {
    // A settings id resolves to a known file; a hand-made request cannot name one.
    await withServer(
      async (base) => {
        const response = await postJson(base, '/api/settings/save', { confirm: true, set: { 'hugo.title': 'x' } });
        assert.equal(response.status, 200);
        // The file that changed is hugo.toml inside the config directory, and nothing outside
        // it exists: the guard has no "create" path.
        assert.equal(existsSync(join(site.root, 'hugo.toml')), false);
        assert.equal(existsSync(join(site.root, 'config', '_default', 'hugo.toml')), true);
      },
      { siteRoot: site.root, configRoot: site.configRoot, backupRoot: site.backupRoot },
    );
  } finally {
    site.cleanup();
  }
});

test('a config save leaves the editor artifacts out of the site', async () => {
  const site = tempSite();
  const backupRoot = join(ROOT, '.backups');
  try {
    writeFileSync(join(site.root, 'config', '_default', 'related.toml'), readFileSync(join(site.root, 'config', '_default', 'related.toml')));
    await withServer(
      async (base) => {
        await postJson(base, '/api/settings/save', { confirm: true, set: { 'related.threshold': 55 } });
        assert.equal(site.read('related.toml').includes('threshold    = 55'), true);
      },
      { siteRoot: site.root, configRoot: site.configRoot, backupRoot },
    );
    // Backups live outside the site: the site tree gains no editor directory.
    assert.equal(existsSync(join(site.root, 'config', '_default', '.backups')), false);
    assert.equal(existsSync(join(site.root, '.backups')), false);
  } finally {
    site.cleanup();
  }
});
