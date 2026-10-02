// Phase 8: git, without touching the real repository.
//
// Every test here runs against a throwaway repository created under the OS temp directory.
// That is a hard rule (see also the acceptance run): testing a git integration must never
// init, commit to, or otherwise disturb the user's project - /projects is itself a repository
// and is treated as read-only by every test in this file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GitCommandError,
  GitNotARepositoryError,
  GitPushError,
  GitValidationError,
  assertCommitMessage,
  assertSitePath,
  classifyPushFailure,
  classifyRepositoryFailure,
  classifyStatus,
  createGitService,
  parseNumstat,
  parsePushPorcelain,
  parseStatus,
  parseUpstream,
  redactCredentials,
} from '../src/git/index.js';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Editor Test',
  GIT_AUTHOR_EMAIL: 'editor@example.test',
  GIT_COMMITTER_NAME: 'Editor Test',
  GIT_COMMITTER_EMAIL: 'editor@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function makeRepo({ branch = 'main' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'editor-git-'));
  git(dir, ['init', '-q', `--initial-branch=${branch}`]);
  // The throwaway repository configures its own identity locally: the real environment's git
  // config is never read (`GIT_CONFIG_GLOBAL=/dev/null`) and never written.
  git(dir, ['config', 'user.name', 'Editor Test']);
  git(dir, ['config', 'user.email', 'editor@example.test']);
  writeFileSync(join(dir, 'README.md'), '# temp\n');
  git(dir, ['add', '--', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'initial commit']);
  return dir;
}

const repos = [];
function repo(options) {
  const dir = makeRepo(options);
  repos.push(dir);
  return dir;
}

// A remote that is a real repository: a bare one in the same temp directory. A push to it exercises
// everything a push to GitHub exercises - refs, objects, a rejection when the branch moved on -
// with no network and no credential, which is what makes it testable here at all.
function makeOrigin() {
  const dir = mkdtempSync(join(tmpdir(), 'editor-origin-'));
  git(dir, ['init', '-q', '--bare', '--initial-branch=main']);
  repos.push(dir);
  return dir;
}

// A second working copy of the same origin, so a test can move the remote's branch behind the
// editor's back - the situation a push must refuse to resolve by force.
function makePeer(origin) {
  const dir = mkdtempSync(join(tmpdir(), 'editor-peer-'));
  git(dir, ['clone', '-q', origin, dir]);
  git(dir, ['config', 'user.name', 'Someone Else']);
  git(dir, ['config', 'user.email', 'else@example.test']);
  repos.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
});

// --- pure parsing -----------------------------------------------------------

test('status records are parsed as NUL separated fields, so spaces and Unicode are data', () => {
  // A `-z` rename record is `to\0from`, which is the reverse of the human-readable form.
  const output = ' M content/post/a b.md\0?? 图片 相册/新图.webp\0R  content/new.md\0content/old.md\0';
  const entries = parseStatus(output);
  assert.deepEqual(entries[0], { index: ' ', worktree: 'M', path: 'content/post/a b.md', originalPath: null });
  assert.deepEqual(entries[1], { index: '?', worktree: '?', path: '图片 相册/新图.webp', originalPath: null });
  assert.deepEqual(entries[2], { index: 'R', worktree: ' ', path: 'content/new.md', originalPath: 'content/old.md' });
});

test('status codes are classified into the categories the UI shows', () => {
  assert.equal(classifyStatus({ index: '?', worktree: '?' }), 'untracked');
  assert.equal(classifyStatus({ index: ' ', worktree: 'M' }), 'modified');
  assert.equal(classifyStatus({ index: 'A', worktree: ' ' }), 'added');
  assert.equal(classifyStatus({ index: ' ', worktree: 'D' }), 'deleted');
  assert.equal(classifyStatus({ index: 'R', worktree: ' ' }), 'renamed');
  assert.equal(classifyStatus({ index: 'U', worktree: 'U' }), 'conflicted');
});

test('numstat reports binary files instead of fake line counts', () => {
  const parsed = parseNumstat('3\t1\tcontent/a.md\n-\t-\tstatic/img/photo.webp\n');
  assert.equal(parsed.additions, 3);
  assert.equal(parsed.deletions, 1);
  assert.equal(parsed.binary, true);
  assert.deepEqual(parsed.files[1], { path: 'static/img/photo.webp', binary: true, additions: 0, deletions: 0 });
});

// --- path and message validation -------------------------------------------

test('paths are validated before git ever sees them', () => {
  assert.equal(assertSitePath('content/post/a.md'), 'content/post/a.md');
  assert.equal(assertSitePath('./content/a.md'), 'content/a.md');
  assert.throws(() => assertSitePath('/etc/passwd'), /relative to the site root/);
  assert.throws(() => assertSitePath('../../etc/passwd'), /escape the site root/);
  assert.throws(() => assertSitePath('--upload-pack=evil'), /must not start with "-"/);
  assert.throws(() => assertSitePath(''), /path is required/);
});

test('a commit needs a real message', () => {
  assert.equal(assertCommitMessage('Update article metadata'), 'Update article metadata');
  assert.throws(() => assertCommitMessage('   '), /needs a message/);
  assert.throws(() => assertCommitMessage('x'.repeat(5000)), /longer than/);
});

test('the two ways a repository probe fails are told apart, because the advice differs', () => {
  // The real text from `git`, so the classifier is checked against what git actually prints.
  const ownership = classifyRepositoryFailure(
    "fatal: detected dubious ownership in repository at '/projects'\n" +
      'To add an exception for this directory, call:\n\n\tgit config --global --add safe.directory /projects',
  );
  assert.deepEqual(ownership, { code: 'dubious-ownership', directory: '/projects' });
  assert.deepEqual(classifyRepositoryFailure('fatal: not a git repository (or any parent): .git'), {
    code: 'not-a-repository',
    directory: null,
  });
  assert.equal(classifyRepositoryFailure('').code, 'unknown');
});

test('only allow-listed subcommands can be run, so no destructive git command exists', async () => {
  const dir = repo();
  const service = createGitService({ siteRoot: dir });
  // `push` joined the allow-list in Phase 10, but only behind `push()`, which validates the remote
  // against the ones that exist and builds its own argument vector. Everything that could rewrite
  // history, discard work or reach the network unbidden is still absent.
  for (const forbidden of [
    'reset',
    'clean',
    'checkout',
    'restore',
    'stash',
    'fetch',
    'pull',
    'merge',
    'rebase',
    'gc',
    'init',
  ]) {
    await assert.rejects(() => service.run([forbidden, '--hard']), /is not allowed by the git service/);
  }
});

// --- repository detection ---------------------------------------------------

test('a directory that is not a repository is reported as such, and never initialised', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'editor-norepo-'));
  repos.push(dir);
  const service = createGitService({ siteRoot: dir, cacheMs: 0 });
  const status = await service.status();
  assert.equal(status.repository, null);
  assert.equal(status.clean, true);
  assert.equal(status.reason.length > 0, true);
  await assert.rejects(() => service.log({}), GitNotARepositoryError);
  assert.equal(existsSync(join(dir, '.git')), false, 'the editor must not run git init');
});

test('a site inside a larger repository reports only the site, site-relative', async () => {
  const repoRoot = repo();
  const siteRoot = join(repoRoot, 'site');
  mkdirSync(join(siteRoot, 'content'), { recursive: true });
  writeFileSync(join(siteRoot, 'content', 'a.md'), 'hello\n');
  writeFileSync(join(repoRoot, 'outside.txt'), 'not this editor\n');

  const service = createGitService({ siteRoot, cacheMs: 0 });
  const status = await service.status();
  assert.equal(status.repository.root, repoRoot);
  assert.equal(status.repository.prefix, 'site');
  assert.deepEqual(status.changes.map((change) => change.path), ['content/a.md']);
  assert.equal(status.branch, 'main');
});

// --- status, diff, log, show ------------------------------------------------

test('status separates the change categories the UI shows', async () => {
  const dir = repo();
  const service = createGitService({ siteRoot: dir, cacheMs: 0 });

  writeFileSync(join(dir, 'README.md'), '# changed\n');
  writeFileSync(join(dir, 'added with space.md'), 'new\n');
  writeFileSync(join(dir, '已删除文档.md'), 'doomed\n');
  git(dir, ['add', '--', '已删除文档.md']);
  git(dir, ['commit', '-q', '-m', 'add a file to delete']);
  rmSync(join(dir, '已删除文档.md'));

  const status = await service.status();
  const byPath = Object.fromEntries(status.changes.map((change) => [change.path, change.kind]));
  assert.equal(byPath['README.md'], 'modified');
  assert.equal(byPath['added with space.md'], 'untracked');
  assert.equal(byPath['已删除文档.md'], 'deleted');
  assert.equal(status.counts.modified, 1);
  assert.equal(status.counts.untracked, 1);
  assert.equal(status.counts.deleted, 1);
  assert.equal(status.clean, false);
  assert.equal(status.branch, 'main');
  assert.match(status.head, /^[0-9a-f]{7,}$/);
});

test('a rename is reported as a rename with both paths', async () => {
  const dir = repo();
  const service = createGitService({ siteRoot: dir, cacheMs: 0 });
  git(dir, ['mv', 'README.md', 'manual.md']);
  const status = await service.status();
  const change = status.changes.find((entry) => entry.kind === 'renamed');
  assert.ok(change, 'expected a rename');
  assert.equal(change.path, 'manual.md');
  assert.equal(change.originalPath, 'README.md');
  assert.equal(change.staged, true);
});

test('a diff carries the hunks, and an untracked file shows up as additions', async () => {
  const dir = repo();
  const service = createGitService({ siteRoot: dir, cacheMs: 0 });
  writeFileSync(join(dir, 'README.md'), '# temp\nsecond line\n');

  const tracked = await service.diff({ path: 'README.md' });
  assert.equal(tracked.additions, 1);
  assert.equal(tracked.deletions, 0);
  assert.equal(tracked.hunks, 1);
  assert.match(tracked.text, /^diff --git/m);
  assert.match(tracked.text, /^\+second line$/m);

  writeFileSync(join(dir, 'brand new.md'), 'one\ntwo\n');
  const untracked = await service.diff({ path: 'brand new.md' });
  assert.equal(untracked.kind, 'untracked');
  assert.equal(untracked.additions, 2);
  assert.equal(untracked.binary, false);
});

test('a binary file is flagged rather than dumped as mojibake', async () => {
  const dir = repo();
  const service = createGitService({ siteRoot: dir, cacheMs: 0 });
  // A real PNG signature followed by NUL bytes: git's binary heuristic looks for those.
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 0)]);
  writeFileSync(join(dir, 'image.png'), bytes);
  git(dir, ['add', '--', 'image.png']);
  git(dir, ['commit', '-q', '-m', 'add an image']);
  writeFileSync(join(dir, 'image.png'), Buffer.concat([bytes, Buffer.alloc(32, 0xfe)]));

  const diff = await service.diff({ path: 'image.png' });
  assert.equal(diff.binary, true);
  assert.equal(diff.text, '');
  assert.equal(diff.numstat.binary, true);
});

test('log and show describe the history without needing a pager', async () => {
  const dir = repo();
  const service = createGitService({ siteRoot: dir, cacheMs: 0 });
  writeFileSync(join(dir, 'a.md'), 'a\n');
  await service.commit({ message: 'Add a.md', paths: ['a.md'] });

  const history = await service.log({ limit: 10 });
  assert.equal(history.commits.length, 2);
  assert.equal(history.commits[0].subject, 'Add a.md');
  assert.equal(history.commits[0].author, 'Editor Test');
  assert.match(history.commits[0].date, /^\d{4}-\d{2}-\d{2}T/);

  const shown = await service.show({ sha: history.commits[0].sha, path: 'a.md' });
  assert.equal(shown.commit.subject, 'Add a.md');
  assert.deepEqual(shown.files.map((file) => file.path), ['a.md']);
  assert.match(shown.text, /^\+a$/m);
  await assert.rejects(() => service.show({ sha: 'not a sha; rm -rf /' }), GitValidationError);
  await assert.rejects(() => service.show({ sha: 'deadbeefdeadbeef' }), GitCommandError);
});

test('an empty repository (no commits yet) is not an error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'editor-empty-'));
  repos.push(dir);
  git(dir, ['init', '-q', '--initial-branch=main']);
  const service = createGitService({ siteRoot: dir, cacheMs: 0 });
  const history = await service.log({});
  assert.equal(history.empty, true);
  const status = await service.status();
  assert.equal(status.repository.branch, 'main');
});

// --- commit -----------------------------------------------------------------

test('a commit takes exactly the ticked paths and nothing else', async () => {
  const dir = repo();
  const service = createGitService({ siteRoot: dir, cacheMs: 0 });
  writeFileSync(join(dir, 'one.md'), 'one\n');
  writeFileSync(join(dir, 'two.md'), 'two\n');

  const result = await service.commit({ message: 'Add one.md\n\nPhase 8 acceptance.', paths: ['one.md'] });
  assert.match(result.sha, /^[0-9a-f]{40}$/);
  assert.deepEqual(result.files, ['one.md']);

  const status = await service.status();
  assert.deepEqual(status.changes.map((change) => change.path), ['two.md'], 'the unticked file is still uncommitted');
  const shown = await service.show({ sha: result.sha });
  assert.deepEqual(shown.files.map((file) => file.path), ['one.md']);
  assert.equal(shown.commit.subject, 'Add one.md');
  assert.match(shown.commit.body, /Phase 8 acceptance/);
});

test('a commit refuses to run without a message or without files', async () => {
  const dir = repo();
  const service = createGitService({ siteRoot: dir, cacheMs: 0 });
  await assert.rejects(() => service.commit({ message: '  ', paths: ['README.md'] }), /needs a message/);
  await assert.rejects(() => service.commit({ message: 'ok', paths: [] }), /at least one file/);
  await assert.rejects(() => service.commit({ message: 'ok', paths: ['../outside.md'] }), /escape the site root/);
});

test('committing an unchanged file reports the failure instead of inventing a commit', async () => {
  const dir = repo();
  const service = createGitService({ siteRoot: dir, cacheMs: 0 });
  await assert.rejects(() => service.commit({ message: 'nothing to do', paths: ['README.md'] }), GitCommandError);
});

// --- Phase 9: the two halves of a change, and what a history row shows ------

test('the staged and unstaged halves of a change are told apart, and each has its own diff', async () => {
  const dir = repo();
  const service = createGitService({ siteRoot: dir, cacheMs: 0 });
  writeFileSync(join(dir, 'staged.md'), 'one\n');
  git(dir, ['add', '--', 'staged.md']); // 'A ': in the index, nothing left in the worktree
  writeFileSync(join(dir, 'README.md'), '# temp\nsecond\n'); // ' M': worktree only

  const status = await service.status();
  const byPath = Object.fromEntries(status.changes.map((change) => [change.path, change]));
  assert.deepEqual([byPath['staged.md'].staged, byPath['staged.md'].unstaged], [true, false]);
  assert.deepEqual([byPath['README.md'].staged, byPath['README.md'].unstaged], [false, true]);
  assert.equal(status.counts.staged, 1);
  assert.equal(status.counts.unstaged, 1);
  assert.equal(status.counts.total, 2);

  // A file that is only in the index has no worktree diff - which is exactly why the panel has
  // to be able to ask for the staged one, or the row would open an empty page.
  const plain = await service.diff({ path: 'staged.md' });
  assert.equal(plain.text.trim(), '');
  const cached = await service.diff({ path: 'staged.md', staged: true });
  assert.equal(cached.staged, true);
  assert.equal(cached.additions, 1);
  assert.match(cached.text, /^\+one$/m);

  // `MM`: staged and modified again. The two diffs are different questions and get different
  // answers - the index against HEAD, and the worktree against the index.
  writeFileSync(join(dir, 'README.md'), '# temp\nsecond\nthird\n');
  git(dir, ['add', '--', 'README.md']);
  writeFileSync(join(dir, 'README.md'), '# temp\nsecond\nthird\nfourth\n');
  const both = (await service.status()).changes.find((change) => change.path === 'README.md');
  assert.deepEqual([both.staged, both.unstaged], [true, true]);
  const stagedHalf = await service.diff({ path: 'README.md', staged: true });
  const worktreeHalf = await service.diff({ path: 'README.md' });
  assert.match(stagedHalf.text, /^\+second$/m);
  assert.doesNotMatch(stagedHalf.text, /fourth/);
  assert.match(worktreeHalf.text, /^\+fourth$/m);
  assert.doesNotMatch(worktreeHalf.text, /^\+second$/m);
});

test('committing everything leaves a clean status with nothing staged', async () => {
  const dir = repo();
  const service = createGitService({ siteRoot: dir, cacheMs: 0 });
  writeFileSync(join(dir, 'a.md'), 'a\n');
  writeFileSync(join(dir, 'b.md'), 'b\n');

  await service.commit({ message: 'Add two files', paths: ['a.md', 'b.md'] });

  const status = await service.status();
  assert.equal(status.clean, true);
  assert.deepEqual(status.changes, []);
  assert.equal(status.counts.total, 0);
  assert.equal(status.counts.staged, 0);
  assert.equal(status.counts.unstaged, 0);
});

test('a history row is one patch, and a file outside the site is marked instead of faked', async () => {
  const repoRoot = repo();
  const siteRoot = join(repoRoot, 'site');
  mkdirSync(join(siteRoot, 'content'), { recursive: true });
  writeFileSync(join(siteRoot, 'content', 'a.md'), 'alpha\n');
  writeFileSync(join(siteRoot, 'content', 'b.md'), 'beta\n');
  writeFileSync(join(repoRoot, 'outside.txt'), 'not the editor\'s business\n');
  git(repoRoot, ['add', '--', 'site/content', 'outside.txt']);
  git(repoRoot, ['commit', '-q', '-m', 'two inside, one outside']);

  const service = createGitService({ siteRoot, cacheMs: 0 });
  const shown = await service.show({ sha: git(repoRoot, ['rev-parse', 'HEAD']) });

  // One patch for the whole commit: clicking a history row must not need a second click.
  assert.match(shown.text, /^\+alpha$/m);
  assert.match(shown.text, /^\+beta$/m);
  assert.match(shown.text, /content\/a\.md/);

  const byRepoPath = Object.fromEntries(shown.files.map((file) => [file.repoPath, file]));
  assert.deepEqual(Object.keys(byRepoPath).sort(), ['outside.txt', 'site/content/a.md', 'site/content/b.md']);
  assert.equal(byRepoPath['site/content/a.md'].path, 'content/a.md');
  assert.equal(byRepoPath['site/content/a.md'].outside, false);
  assert.equal(byRepoPath['outside.txt'].path, null);
  assert.equal(byRepoPath['outside.txt'].outside, true);
  assert.equal(shown.files.every((file) => file.outside === (file.path === null)), true);

  // Narrowing to one file still works, and yields only that file's patch.
  const narrowed = await service.show({ sha: shown.commit.sha, path: 'content/a.md' });
  assert.match(narrowed.text, /^\+alpha$/m);
  assert.doesNotMatch(narrowed.text, /beta/);
});

test('ignored paths are never reported as user changes', async () => {
  const dir = repo();
  writeFileSync(join(dir, '.gitignore'), 'public/\nresources/\n*.tmp\n');
  git(dir, ['add', '--', '.gitignore']);
  git(dir, ['commit', '-q', '-m', 'ignore what the build writes']);
  mkdirSync(join(dir, 'public'), { recursive: true });
  writeFileSync(join(dir, 'public', 'index.html'), '<html></html>\n');
  mkdirSync(join(dir, 'resources'), { recursive: true });
  writeFileSync(join(dir, 'resources', '_gen'), 'cache\n');
  writeFileSync(join(dir, 'scratch.tmp'), 'noise\n');
  writeFileSync(join(dir, 'article.md'), 'a real edit\n');

  const service = createGitService({ siteRoot: dir, cacheMs: 0 });
  const status = await service.status();
  assert.deepEqual(status.changes.map((change) => change.path), ['article.md']);
  assert.equal(status.counts.untracked, 1);
});

test('reading the repository moves neither HEAD nor the index', async () => {
  const dir = repo();
  const service = createGitService({ siteRoot: dir, cacheMs: 0 });
  writeFileSync(join(dir, 'new.md'), 'new\n');
  writeFileSync(join(dir, 'other.md'), 'other\n');
  writeFileSync(join(dir, 'README.md'), '# temp\nedited\n');

  const headBefore = git(dir, ['rev-parse', 'HEAD']);
  const indexBefore = readFileSync(join(dir, '.git', 'index'));

  // Every read the panel can make, including the untracked branch that diffs against /dev/null, and
  // the remotes/upstream probe the push box reads.
  await service.status();
  await service.diff({ path: 'README.md' });
  await service.diff({ path: 'new.md' });
  await service.diff({ path: 'README.md', staged: true });
  await service.diff({});
  await service.log({ limit: 5 });
  await service.show({ sha: headBefore });
  await service.remoteStatus();
  await service.detectRepository({ force: true });

  assert.equal(git(dir, ['rev-parse', 'HEAD']), headBefore, 'HEAD moved while only reading');
  assert.deepEqual(readFileSync(join(dir, '.git', 'index')), indexBefore, 'the index moved while only reading');
  const staged = git(dir, ['diff', '--cached', '--name-only']);
  assert.equal(staged, '', 'reading staged something');
});


// --- Phase 10: the push ----------------------------------------------------
//
// Everything here runs against repositories in the temp directory: a real bare `origin` next to a
// real working copy. A push to GitHub differs from a push to `mkdtemp` in exactly one way - the
// transport - so proving the refs, the upstream, the refusal and the argument vector here is the
// honest test, and it never touches the user's repository or the network.

test('the remote status is read from the repository, and a branch with no upstream says so', async () => {
  const origin = makeOrigin();
  const dir = repo();
  git(dir, ['remote', 'add', 'origin', origin]);
  const service = createGitService({ siteRoot: dir, cacheMs: 0 });

  const state = await service.remoteStatus();
  assert.deepEqual(state.remotes.map((entry) => entry.name), ['origin']);
  assert.equal(state.remotes[0].url, origin, 'the URL is what git has, not a guess');
  assert.equal(state.branch, 'main');
  assert.equal(state.detached, false);
  assert.equal(state.remote, 'origin');
  assert.equal(state.upstream, null);
  assert.equal(state.hasUpstream, false);
  assert.equal(state.setUpstream, true, 'a first push is the one that records the upstream');
  assert.equal(state.ahead, null, 'nothing here fetches, so the other side is unknown until a push');
  assert.equal(state.behind, null);

  // With no remote at all the same read answers differently, and `remote` is null rather than 'origin'.
  const lonely = createGitService({ siteRoot: repo(), cacheMs: 0 });
  const lonelyState = await lonely.remoteStatus();
  assert.deepEqual(lonelyState.remotes, []);
  assert.equal(lonelyState.remote, null);
});

test('a push sends the branch, records the upstream, and says what moved', async () => {
  const origin = makeOrigin();
  const dir = repo();
  git(dir, ['remote', 'add', 'origin', origin]);
  const service = createGitService({ siteRoot: dir, cacheMs: 0 });

  const pushed = await service.push();
  assert.equal(pushed.pushed, true);
  assert.equal(pushed.upToDate, false);
  assert.equal(pushed.rejected, false);
  assert.equal(pushed.remote, 'origin');
  assert.equal(pushed.branch, 'main');
  assert.equal(pushed.setUpstream, true);
  assert.equal(pushed.upstream.full, 'origin/main');
  assert.equal(pushed.refs[0].flag, '*', 'a first push creates the ref');
  assert.equal(git(origin, ['rev-parse', 'refs/heads/main']), git(dir, ['rev-parse', 'HEAD']), 'the commit arrived');

  const after = await service.remoteStatus();
  assert.deepEqual(after.upstream, { remote: 'origin', branch: 'main', full: 'origin/main' });
  assert.equal(after.hasUpstream, true);
  assert.equal(after.setUpstream, false, 'the upstream is recorded, so no -u next time');
  assert.equal(after.ahead, 0);
  assert.equal(after.behind, 0);

  // Nothing to send is an outcome, not a failure: git says `=` and the panel says "already there".
  const again = await service.push();
  assert.equal(again.upToDate, true);
  assert.equal(again.pushed, false);
  assert.equal(again.refs[0].flag, '=');

  // One more commit: the count the panel shows before pushing has to be the commit that travels.
  writeFileSync(join(dir, 'article.md'), 'second\n');
  await service.commit({ message: 'second', paths: ['article.md'] });
  const ahead = await service.remoteStatus();
  assert.equal(ahead.ahead, 1);
  assert.equal(ahead.behind, 0);
  assert.equal(ahead.setUpstream, false);

  const second = await service.push();
  assert.equal(second.pushed, true);
  assert.equal(second.setUpstream, false, 'an existing upstream is not rewritten');
  assert.equal(git(origin, ['rev-list', '--count', 'refs/heads/main']), '2');
});

test('a push never forces: a remote that moved on is refused, and nothing is rewritten', async () => {
  const origin = makeOrigin();
  const dir = repo();
  git(dir, ['remote', 'add', 'origin', origin]);
  const service = createGitService({ siteRoot: dir, cacheMs: 0 });
  await service.push();

  // Someone else pushes to the same branch - the case a "just force it" button would destroy.
  const peer = makePeer(origin);
  writeFileSync(join(peer, 'their.md'), 'their work\n');
  git(peer, ['add', '-A']);
  git(peer, ['commit', '-q', '-m', 'their commit']);
  git(peer, ['push', '-q', 'origin', 'main']);
  const remoteHead = git(origin, ['rev-parse', 'refs/heads/main']);

  writeFileSync(join(dir, 'article.md'), 'local work\n');
  await service.commit({ message: 'local', paths: ['article.md'] });
  const localHead = git(dir, ['rev-parse', 'HEAD']);
  // What the local repository believes about the remote, before the refusal.
  const trackingBefore = git(dir, ['rev-parse', 'refs/remotes/origin/main']);

  await assert.rejects(
    () => service.push(),
    (error) => {
      assert.equal(error.name, 'GitPushError');
      assert.equal(error.reason, 'rejected-non-fast-forward');
      assert.match(error.stderr, /rejected/i, "git's own words travel with the refusal");
      return true;
    },
  );

  // The refusal is total: the local branch is where it was, the remote still holds the other commit,
  // and nothing was fetched to find that out - the local tracking ref is exactly as stale as it was.
  assert.equal(git(dir, ['rev-parse', 'HEAD']), localHead);
  assert.equal(git(origin, ['rev-parse', 'refs/heads/main']), remoteHead);
  assert.equal(git(dir, ['rev-parse', 'refs/remotes/origin/main']), trackingBefore);

  // Which is why the panel says the tracking ref may be out of date: the local repository still
  // believes it is ahead (there is no way to know otherwise without fetching), and the refusal is
  // what told the truth.
  const after = await service.remoteStatus();
  assert.equal(after.ahead, 1);
  assert.equal(after.behind, 0, 'a stale tracking ref cannot report being behind');
});

test('a push decision is read fresh, not served from the status cache', async () => {
  const origin = makeOrigin();
  const dir = repo();
  git(dir, ['remote', 'add', 'origin', origin]);
  // A long cache, and a status read that fills it: the push decision must ignore both, because a
  // branch switched in a terminal a moment ago is the branch the user means - and publishing the one
  // they just left is exactly the kind of surprise a push button must not produce.
  const service = createGitService({ siteRoot: dir, cacheMs: 60_000 });
  assert.equal((await service.remoteStatus()).branch, 'main');

  git(dir, ['checkout', '-q', '-b', 'other']);
  const moved = await service.remoteStatus();
  assert.equal(moved.branch, 'other', 'the branch read before the switch was served from the cache');
  const plan = await service.pushPlan();
  assert.deepEqual(plan.args, ['push', '--porcelain', '--no-verify', '--set-upstream', 'origin', 'other']);

  git(dir, ['checkout', '-q', '--detach']);
  const detached = await service.remoteStatus();
  assert.equal(detached.detached, true);
  assert.equal(detached.branch, null);
  await assert.rejects(
    () => service.push(),
    (error) => error.name === 'GitPushError' && error.reason === 'detached-head',
  );
});

test('a push is refused before it runs when there is nowhere to push, or no branch to push', async () => {
  // No remote at all.
  const lonely = createGitService({ siteRoot: repo(), cacheMs: 0 });
  await assert.rejects(
    () => lonely.push(),
    (error) => error.name === 'GitPushError' && error.reason === 'no-remote',
  );

  // A remote name that does not exist is the interesting one: a name is matched against the remotes
  // git reports, so a remote that looks like a flag can never reach the command line.
  const origin = makeOrigin();
  const dir = repo();
  git(dir, ['remote', 'add', 'origin', origin]);
  const service = createGitService({ siteRoot: dir, cacheMs: 0 });
  for (const remote of ['--force', '-x', 'upstream', 'origin\n--force']) {
    await assert.rejects(() => service.push({ remote }), /unknown remote/);
  }
  assert.equal(git(origin, ['for-each-ref', '--format=%(refname)']), '', 'nothing reached the remote');

  // A detached HEAD has no branch to push.
  const detached = repo();
  git(detached, ['remote', 'add', 'origin', origin]);
  git(detached, ['checkout', '-q', '--detach']);
  const detachedService = createGitService({ siteRoot: detached, cacheMs: 0 });
  await assert.rejects(
    () => detachedService.push(),
    (error) => error.name === 'GitPushError' && error.reason === 'detached-head',
  );
});

test('the plan and the push are the same command, and it never carries a force, a delete or a token', async () => {
  // A repository that exists only as answers, so the exact argument vector can be asserted without
  // running anything. This is also the only honest way to test what happens to a token in a remote
  // URL: the runner hands back a URL that has one, and nothing that leaves the service may keep it.
  const TOKEN = 'ghp_deadbeefdeadbeef';
  const calls = [];
  function fakeService({ upstream = 'origin/main', ahead = 2, behind = 0 } = {}) {
    const runner = async (args) => {
      calls.push(args);
      const key = args.join(' ');
      const ok = (stdout) => ({ stdout, stderr: '', code: 0 });
      if (key === 'rev-parse --show-toplevel --absolute-git-dir') return ok('/tmp/fake-repo\n/tmp/fake-repo/.git\n');
      if (key === 'rev-parse --abbrev-ref HEAD') return ok('main\n');
      if (key === 'rev-parse --short HEAD') return ok('abc1234\n');
      if (key === 'remote') return ok('origin\n');
      if (key === 'remote get-url origin') return ok(`https://user:${TOKEN}@example.com/x.git\n`);
      if (key === 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}') {
        return upstream
          ? ok(`${upstream}\n`)
          : { stdout: '', stderr: 'fatal: no upstream configured for branch\n', code: 128 };
      }
      if (key === 'rev-list --left-right --count origin/main...HEAD') return ok(`${behind}\t${ahead}\n`);
      if (args[0] === 'push') {
        return ok(`To https://user:${TOKEN}@example.com/x.git\n*\trefs/heads/main:refs/heads/main\t[new branch]\nDone\n`);
      }
      throw new Error(`unexpected git call: ${key}`);
    };
    return createGitService({ siteRoot: '/tmp/fake-repo', cacheMs: 0, runner });
  }

  const service = fakeService();
  const plan = await service.pushPlan();
  assert.deepEqual(plan.args, ['push', '--porcelain', '--no-verify', 'origin', 'main']);
  assert.equal(plan.command, 'git push --porcelain --no-verify origin main');
  assert.equal(plan.ahead, 2);
  assert.equal(plan.setUpstream, false);
  assert.equal(plan.remote.url, 'https://example.com/x.git', 'the URL shown to the user carries no credential');

  const result = await service.push();
  const pushArgs = calls.filter((args) => args[0] === 'push');
  assert.equal(pushArgs.length, 1, 'a push is one git call');
  assert.deepEqual(pushArgs[0], plan.args, 'the push runs exactly the arguments the plan showed');
  assert.equal(result.pushed, true);
  assert.equal(result.remoteUrl, 'https://example.com/x.git');
  assert.doesNotMatch(result.output, new RegExp(TOKEN), "git's own output is scrubbed too");
  assert.doesNotMatch(result.target, new RegExp(TOKEN));

  // A branch with no upstream is the one case that adds `-u`, and it is still not a force.
  const fresh = fakeService({ upstream: null, ahead: null });
  const firstPlan = await fresh.pushPlan();
  assert.deepEqual(firstPlan.args, ['push', '--porcelain', '--no-verify', '--set-upstream', 'origin', 'main']);
  assert.equal(firstPlan.setUpstream, true);
  assert.equal(firstPlan.ahead, null, 'an unknown distance stays unknown');

  // Nothing this service can send may look like a history rewrite.
  for (const args of calls) {
    for (const forbidden of ['--force', '-f', '--delete', '--mirror', '--tags', '--all', '--prune', '--no-verify=false']) {
      assert.equal(args.includes(forbidden), false, `${args.join(' ')} must not carry ${forbidden}`);
    }
  }
});

test('a push failure is classified from what git actually prints', () => {
  // The real messages, captured from this machine's git - the classifier is checked against the
  // output it will really meet, not against what we imagine git says.
  assert.equal(
    classifyPushFailure('!\trefs/heads/main:refs/heads/main\t[rejected] (fetch first)'),
    'rejected-non-fast-forward',
  );
  assert.equal(
    classifyPushFailure(
      'remote: error: GH006: Protected branch update failed\n ! [remote rejected] main -> main (protected branch hook declined)',
    ),
    'rejected-by-remote',
  );
  assert.equal(
    classifyPushFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
    'no-credentials',
  );
  assert.equal(
    classifyPushFailure('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.'),
    'no-credentials',
  );
  assert.equal(
    classifyPushFailure(
      "fatal: unable to access 'https://127.0.0.1:9/x.git/': Failed to connect to 127.0.0.1 port 9 after 0 ms: Could not connect to server",
    ),
    'network',
  );
  assert.equal(classifyPushFailure('fatal: Could not resolve host: github.com'), 'network');
  assert.equal(
    classifyPushFailure(
      "fatal: '/tmp/nope.git' does not appear to be a git repository\nPlease make sure you have the correct access rights and the repository exists.",
    ),
    'remote-unreadable',
  );
  assert.equal(
    classifyPushFailure("remote: Repository not found.\nfatal: repository 'https://github.com/x/y.git/' not found"),
    'remote-unreadable',
  );
  assert.equal(classifyPushFailure('fatal: no configured push destination.'), 'no-remote');
  assert.equal(classifyPushFailure(''), 'unknown');
});

test('the porcelain output is parsed as ref updates, so "sent" and "already there" differ', () => {
  const created = parsePushPorcelain(
    'To https://example.com/x.git\n*\trefs/heads/main:refs/heads/main\t[new branch]\nDone\n',
  );
  assert.equal(created.pushed, true);
  assert.equal(created.upToDate, false);
  assert.deepEqual(created.refs, [
    { flag: '*', from: 'refs/heads/main', to: 'refs/heads/main', summary: '[new branch]' },
  ]);

  const current = parsePushPorcelain('To /tmp/origin.git\n=\trefs/heads/main:refs/heads/main\t[up to date]\nDone\n');
  assert.equal(current.upToDate, true);
  assert.equal(current.pushed, false);

  // A credential in the target line must not survive the parse either.
  const target = parsePushPorcelain('To https://user:ghp_x@example.com/x.git\nDone\n');
  assert.equal(target.target, 'https://example.com/x.git');
  assert.equal(parsePushPorcelain('').refs.length, 0);
  assert.equal(parsePushPorcelain(undefined).pushed, false);
});

test('an upstream name is split on its first slash, because a branch may contain one', () => {
  assert.deepEqual(parseUpstream('origin/main'), { remote: 'origin', branch: 'main', full: 'origin/main' });
  assert.deepEqual(parseUpstream('origin/feature/deep\n'), {
    remote: 'origin',
    branch: 'feature/deep',
    full: 'origin/feature/deep',
  });
  assert.equal(parseUpstream(''), null);
  assert.equal(parseUpstream('@{upstream}'), null);
  assert.equal(parseUpstream('no-slash'), null);
  assert.equal(parseUpstream('origin/'), null);
});

test('a credential in a URL never reaches the panel', () => {
  assert.equal(redactCredentials('https://user:ghp_secret@github.com/x/y.git'), 'https://github.com/x/y.git');
  assert.equal(redactCredentials('https://ghp_secret@github.com/x/y.git'), 'https://github.com/x/y.git');
  assert.equal(redactCredentials('http://user:pa ss@host/x'), 'http://user:pa ss@host/x', 'a space is not a URL');
  // The ssh form carries no secret, and rewriting it would mangle ordinary text this also runs over.
  assert.equal(redactCredentials('git@github.com:FenrisOwO/x.git'), 'git@github.com:FenrisOwO/x.git');
  assert.equal(redactCredentials(''), '');
  assert.equal(redactCredentials(null), '');
});
