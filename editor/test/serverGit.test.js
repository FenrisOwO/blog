// Phase 8 over HTTP: the git routes.
//
// The server under test points at a throwaway repository in the OS temp directory, so nothing
// here reads or writes the user's project. What is being verified is the contract the UI
// depends on: status categories, a diff, a history, and one commit that needs `confirm: true`
// and touches only the paths it was given.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEditorServer } from '../server/index.js';

const ROOT = join(import.meta.dirname, '..');
const SECTIONS = ['post', 'page', 'categories', ''];

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function stubBuildService() {
  return {
    getStatus: () => ({
      state: 'idle',
      activity: 'idle',
      generation: 0,
      queued: false,
      preview: { url: '/', generation: 0 },
      lastBuild: null,
      history: [],
      config: {},
    }),
    subscribe: () => () => {},
    scheduleBuild: () => {},
    build: () => Promise.resolve(),
    stop: () => {},
  };
}

// The site lives in a subdirectory of the repository, which is the interesting case: git
// prints repository-relative paths and the API must answer with site-relative ones.
async function withRepo(run) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'hve-git-'));
  const root = join(repoRoot, 'site');
  mkdirSync(join(root, 'content', 'post'), { recursive: true });
  mkdirSync(join(root, 'config', '_default'), { recursive: true });
  writeFileSync(join(root, 'content', 'post', 'a.md'), '---\ntitle: A\n---\n\nhello\n');
  writeFileSync(join(repoRoot, 'outside.txt'), 'not part of the site\n');
  git(repoRoot, ['init', '-q', '--initial-branch=main']);
  git(repoRoot, ['config', 'user.name', 'Editor Test']);
  git(repoRoot, ['config', 'user.email', 'editor@example.test']);

  const server = createEditorServer({
    siteRoot: root,
    contentRoot: join(root, 'content'),
    configRoot: join(root, 'config', '_default'),
    backupRoot: join(root, 'backups'),
    sections: SECTIONS,
    editorDist: join(ROOT, 'dist'),
    buildService: stubBuildService(),
    watchSources: false,
    buildOnStart: false,
    gitBin: 'git',
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const base = `http://127.0.0.1:${port}`;
  const getJson = async (route) => {
    const response = await fetch(`${base}${route}`);
    return { status: response.status, body: await response.json() };
  };
  const postJson = async (route, payload) => {
    const response = await fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    await run({ base, root, repoRoot, getJson, postJson });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

test('the status route reports the branch, the categories and nothing outside the site', async () => {
  await withRepo(async ({ root, getJson }) => {
    writeFileSync(join(root, 'content', 'post', 'a.md'), '---\ntitle: A\n---\n\nhello again\n');
    writeFileSync(join(root, 'content', 'post', 'b.md'), '---\ntitle: B\n---\n\n');

    const { status, body } = await getJson('/api/git/status');
    assert.equal(status, 200);
    assert.equal(body.repository.branch, 'main');
    assert.equal(body.repository.prefix, 'site');
    assert.equal(body.clean, false);
    const byPath = Object.fromEntries(body.changes.map((change) => [change.path, change.kind]));
    assert.equal(byPath['content/post/a.md'], 'untracked');
    assert.equal(byPath['content/post/b.md'], 'untracked');
    assert.equal(body.changes.some((change) => change.path === 'outside.txt'), false);

    const scoped = await getJson('/api/git/status?path=content/post/a.md');
    assert.deepEqual(scoped.body.changes.map((change) => change.path), ['content/post/a.md']);
  });
});

test('the diff route shows a change, and refuses a path that leaves the site', async () => {
  await withRepo(async ({ root, getJson }) => {
    writeFileSync(join(root, 'content', 'post', 'a.md'), '---\ntitle: A\n---\n\nhello again\n');

    const untracked = await getJson('/api/git/diff?path=' + encodeURIComponent('content/post/a.md'));
    assert.equal(untracked.status, 200);
    assert.equal(untracked.body.kind, 'untracked');
    assert.equal(untracked.body.additions > 0, true);

    const escape = await getJson('/api/git/diff?path=' + encodeURIComponent('../../etc/passwd'));
    assert.equal(escape.status, 403);
    assert.match(escape.body.error, /escape the site root/);
  });
});

test('a commit needs confirmation, and only commits the paths it was given', async () => {
  await withRepo(async ({ root, getJson, postJson }) => {
    writeFileSync(join(root, 'content', 'post', 'a.md'), '---\ntitle: A\n---\n\nhello again\n');
    writeFileSync(join(root, 'content', 'post', 'b.md'), '---\ntitle: B\n---\n\n');

    const unconfirmed = await postJson('/api/git/commit', { message: 'Add a', paths: ['content/post/a.md'] });
    assert.equal(unconfirmed.status, 400);
    assert.match(unconfirmed.body.error, /confirmation required/);

    const empty = await postJson('/api/git/commit', { message: '  ', paths: ['content/post/a.md'], confirm: true });
    assert.equal(empty.status, 400);
    assert.match(empty.body.error, /needs a message/);

    const committed = await postJson('/api/git/commit', {
      message: 'Update a.md',
      paths: ['content/post/a.md'],
      confirm: true,
    });
    assert.equal(committed.status, 200);
    assert.match(committed.body.sha, /^[0-9a-f]{40}$/);
    assert.deepEqual(committed.body.files, ['content/post/a.md']);

    const history = await getJson('/api/git/log?limit=5');
    assert.equal(history.body.commits.length, 1);
    assert.equal(history.body.commits[0].subject, 'Update a.md');

    const shown = await getJson(`/api/git/show?sha=${history.body.commits[0].sha}`);
    assert.deepEqual(shown.body.files.map((file) => file.path), ['content/post/a.md']);

    const after = await getJson('/api/git/status');
    assert.deepEqual(after.body.changes.map((change) => change.path), ['content/post/b.md']);

    const cleanup = await postJson('/api/git/commit', { message: 'Add b', paths: ['content/post/b.md'], confirm: true });
    assert.equal(cleanup.status, 200);
    const clean = await getJson('/api/git/status');
    assert.equal(clean.body.clean, true);
  });
});

test('a site that is not a repository reports it instead of failing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hve-nogit-'));
  mkdirSync(join(root, 'content', 'post'), { recursive: true });
  const server = createEditorServer({
    siteRoot: root,
    contentRoot: join(root, 'content'),
    configRoot: join(root, 'config'),
    backupRoot: join(root, 'backups'),
    sections: SECTIONS,
    editorDist: join(ROOT, 'dist'),
    buildService: stubBuildService(),
    watchSources: false,
    buildOnStart: false,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const status = await fetch(`${base}/api/git/status`);
    const body = await status.json();
    assert.equal(status.status, 200);
    assert.equal(body.repository, null);
    assert.equal(body.clean, true);

    const log = await fetch(`${base}/api/git/log`);
    assert.equal(log.status, 409);
    assert.match((await log.json()).error, /not a git repository/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('the status route splits staged from unstaged, and the diff route answers for either half', async () => {
  await withRepo(async ({ root, repoRoot, getJson }) => {
    writeFileSync(join(root, 'content', 'post', 'a.md'), '---\ntitle: A\n---\n\nstaged line\n');
    git(repoRoot, ['add', '--', 'site/content/post/a.md']);

    const status = await getJson('/api/git/status');
    const change = status.body.changes.find((entry) => entry.path === 'content/post/a.md');
    assert.equal(change.staged, true);
    assert.equal(change.unstaged, false);
    assert.equal(status.body.counts.staged, 1);
    assert.equal(status.body.counts.unstaged, 0);

    // The worktree has nothing left to show for this file; the index does. The UI needs both
    // routes to answer honestly rather than opening an empty page.
    const worktree = await getJson('/api/git/diff?path=' + encodeURIComponent('content/post/a.md'));
    assert.equal(worktree.status, 200);
    assert.equal(worktree.body.text.trim(), '');

    const cached = await getJson('/api/git/diff?path=' + encodeURIComponent('content/post/a.md') + '&staged=true');
    assert.equal(cached.status, 200);
    assert.equal(cached.body.staged, true);
    assert.match(cached.body.text, /staged line/);
  });
});

test('a history entry is readable as one patch, and news about files outside the site is kept honest', async () => {
  await withRepo(async ({ root, getJson, postJson }) => {
    writeFileSync(join(root, 'content', 'post', 'a.md'), '---\ntitle: A\n---\n\nfirst line\n');
    writeFileSync(join(root, 'content', 'post', 'b.md'), '---\ntitle: B\n---\n\n');
    const committed = await postJson('/api/git/commit', {
      message: 'Add a and b',
      paths: ['content/post/a.md', 'content/post/b.md'],
      confirm: true,
    });
    assert.equal(committed.status, 200);

    const shown = await getJson(`/api/git/show?sha=${committed.body.sha}`);
    assert.equal(shown.status, 200);
    assert.match(shown.body.text, /^\+first line$/m, 'a history row has to carry its own diff');
    assert.deepEqual(shown.body.files.map((file) => file.path).sort(), [
      'content/post/a.md',
      'content/post/b.md',
    ]);
    assert.equal(shown.body.files.every((file) => file.outside === false), true);

    const narrowed = await getJson(
      `/api/git/show?sha=${committed.body.sha}&path=${encodeURIComponent('content/post/a.md')}`,
    );
    assert.match(narrowed.body.text, /^\+first line$/m);
    assert.doesNotMatch(narrowed.body.text, /content\/post\/b\.md/);

    const unknown = await getJson('/api/git/show?sha=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    assert.equal(unknown.status, 409);
  });
});

