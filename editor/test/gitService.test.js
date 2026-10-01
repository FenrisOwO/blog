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
  GitValidationError,
  assertCommitMessage,
  assertSitePath,
  classifyRepositoryFailure,
  classifyStatus,
  createGitService,
  parseNumstat,
  parseStatus,
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
  for (const forbidden of ['reset', 'clean', 'checkout', 'restore', 'push', 'stash']) {
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

  // Every read the panel can make, including the untracked branch that diffs against /dev/null.
  await service.status();
  await service.diff({ path: 'README.md' });
  await service.diff({ path: 'new.md' });
  await service.diff({ path: 'README.md', staged: true });
  await service.diff({});
  await service.log({ limit: 5 });
  await service.show({ sha: headBefore });
  await service.detectRepository({ force: true });

  assert.equal(git(dir, ['rev-parse', 'HEAD']), headBefore, 'HEAD moved while only reading');
  assert.deepEqual(readFileSync(join(dir, '.git', 'index')), indexBefore, 'the index moved while only reading');
  const staged = git(dir, ['diff', '--cached', '--name-only']);
  assert.equal(staged, '', 'reading staged something');
});

