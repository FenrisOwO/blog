// P1.2 acceptance tests.
//
// All writes happen inside a throwaway sandbox in the OS temp dir, seeded with a copy
// of a real article. The project's own content tree is never modified by tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PathGuard } from '../src/site/paths.js';
import { diffLines, formatDiff, saveSafely } from '../src/site/safeWrite.js';
import { saveDocument } from '../src/frontmatter/index.js';

const REAL_CONTENT = process.env.HUGO_CONTENT_ROOT ?? '/projects/site/content';
const SAMPLE_REL = 'post/pagination-test-01.en.md';

function makeSandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'hve-'));
  const contentRoot = join(root, 'content');
  mkdirSync(join(contentRoot, 'post'), { recursive: true });
  mkdirSync(join(contentRoot, 'page', 'about'), { recursive: true });

  const sample = readFileSync(join(REAL_CONTENT, SAMPLE_REL), 'utf8');
  writeFileSync(join(contentRoot, SAMPLE_REL), sample);
  writeFileSync(join(contentRoot, 'page', 'about', 'index.md'), '---\ntitle: About\n---\n\nhi\n');

  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, contentRoot, sample, backupRoot: join(root, 'backups') };
}

test('PathGuard only allows writes inside content/post', (t) => {
  const { contentRoot } = makeSandbox(t);
  const guard = new PathGuard({ contentRoot });

  assert.throws(() => guard.resolveForWrite('../hugo.toml'), /only \.md|outside/i);
  assert.throws(() => guard.resolveForWrite('page/about/index.md'), /outside/i);
  assert.throws(() => guard.resolveForWrite('/etc/passwd'), /absolute/i);
  assert.throws(() => guard.resolveForWrite('post/not-markdown.txt'), /only \.md/i);
  assert.throws(() => guard.resolveForWrite('post/../page/about/index.md'), /outside/i);

  assert.ok(guard.resolveForWrite(SAMPLE_REL).endsWith(SAMPLE_REL));
});

test('a no-op save leaves the file (and its mtime) untouched', (t) => {
  const { contentRoot, backupRoot, sample } = makeSandbox(t);
  const guard = new PathGuard({ contentRoot });
  const abs = join(contentRoot, SAMPLE_REL);

  const mtimeBefore = statSync(abs).mtimeMs;
  const result = saveSafely({ guard, relPath: SAMPLE_REL, nextText: sample, backupRoot });

  assert.equal(result.status, 'noop');
  assert.equal(result.backupPath, null);
  assert.equal(readFileSync(abs, 'utf8'), sample);
  assert.equal(statSync(abs).mtimeMs, mtimeBefore);
});

test('dry run previews the diff without writing or backing up', (t) => {
  const { contentRoot, backupRoot, sample } = makeSandbox(t);
  const guard = new PathGuard({ contentRoot });
  const abs = join(contentRoot, SAMPLE_REL);
  const nextText = saveDocument(sample, { title: '预览标题' });

  const result = saveSafely({ guard, relPath: SAMPLE_REL, nextText, backupRoot, dryRun: true });

  assert.equal(result.status, 'preview');
  assert.equal(result.backupPath, null);
  assert.equal(result.diff.changed, 2); // one removed line + one added line
  assert.equal(readFileSync(abs, 'utf8'), sample); // disk unchanged
});

test('a real edit writes atomically, backs up, and restores losslessly', (t) => {
  const { contentRoot, backupRoot, sample } = makeSandbox(t);
  const guard = new PathGuard({ contentRoot });
  const abs = join(contentRoot, SAMPLE_REL);

  const nextText = saveDocument(sample, { title: '端到端标题' });
  const result = saveSafely({ guard, relPath: SAMPLE_REL, nextText, backupRoot });

  assert.equal(result.status, 'written');
  assert.equal(result.diff.changed, 2);
  assert.equal(readFileSync(abs, 'utf8'), nextText);
  assert.equal(readFileSync(result.backupPath, 'utf8'), sample);

  // Restore from the backup content -> must return to the exact original bytes.
  saveSafely({ guard, relPath: SAMPLE_REL, nextText: sample, backupRoot });
  assert.equal(readFileSync(abs, 'utf8'), sample);
});

test('diffLines / formatDiff report the minimal change', () => {
  const before = '---\ntitle: A\nslug: x\n---\n\nbody\n';
  const after = '---\ntitle: B\nslug: x\n---\n\nbody\n';
  const diff = diffLines(before, after);

  assert.equal(diff.prefix, 1);
  assert.deepEqual(diff.removed, ['title: A']);
  assert.deepEqual(diff.added, ['title: B']);
  assert.equal(diff.changed, 2);

  const text = formatDiff(diff, 'post/x.md');
  assert.match(text, /- title: A/);
  assert.match(text, /\+ title: B/);
});
