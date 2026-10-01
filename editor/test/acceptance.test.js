// P1.6 acceptance, as part of the regular suite.
//
// The exhaustive pass over the fixture corpus (test/fixtures/README.md) runs here: every
// document round-trips, every writable document is a no-op save, every read-only one is
// refused, and the corpus itself is proven untouched afterwards. `npm run accept` runs the
// same gate end to end against the real site plus a Hugo build - that script is the one place
// the real corpus is used on purpose. Everything in this file is side-effect free.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { readDocument, saveDocument } from '../src/frontmatter/index.js';
import { FIXTURE_CONTENT, FIXTURE_SITE, REAL_SITE, makeFixtureSandbox } from './fixtures/harness.js';
import { createDocumentService } from '../src/site/documentService.js';
import { PathGuard } from '../src/site/paths.js';
import { saveSafely } from '../src/site/safeWrite.js';

const EDITOR_ROOT = join(import.meta.dirname, '..');
const SITE_ROOT = FIXTURE_SITE;
const CONTENT_ROOT = FIXTURE_CONTENT;
const SECTION = 'post';

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function treeHashes(root) {
  const map = new Map();
  for (const file of walk(root)) map.set(relative(root, file), sha256(readFileSync(file, 'utf8')));
  return map;
}

const ALL_MARKDOWN = walk(CONTENT_ROOT).filter((file) => file.endsWith('.md')).sort();
const WRITABLE = ALL_MARKDOWN.filter((file) => relative(CONTENT_ROOT, file).startsWith(`${SECTION}/`));
const READ_ONLY = ALL_MARKDOWN.filter((file) => !WRITABLE.includes(file));

const REAL_TREE_BEFORE = treeHashes(CONTENT_ROOT);

function makeSandbox(t) {
  const sandbox = makeFixtureSandbox(t, { prefix: 'hve-accept-' });
  return { siteRoot: sandbox.siteRoot, contentRoot: sandbox.contentRoot, backupRoot: sandbox.backupRoot };
}

test('the corpus is the size Phase 1 was specified against', () => {
  // The counts exist to notice that a document silently disappeared from a section the sweep
  // is supposed to cover: 20 documents, 9 of them in the writable section.
  assert.equal(ALL_MARKDOWN.length, 20);
  assert.equal(WRITABLE.length, 9);
  assert.equal(READ_ONLY.length, 11);
});

test('every Markdown file in the fixture round-trips through the front matter engine byte-identically', () => {
  const broken = [];
  for (const file of ALL_MARKDOWN) {
    const text = readFileSync(file, 'utf8');
    const { values } = readDocument(text);
    // Re-saving the values that were just read must reproduce the file exactly.
    if (saveDocument(text, values) !== text) broken.push(relative(CONTENT_ROOT, file));
  }
  assert.deepEqual(broken, []);
});

test('a no-op save is a true no-op for every writable document', (t) => {
  const sandbox = makeSandbox(t);
  const service = createDocumentService({
    contentRoot: sandbox.contentRoot,
    siteRoot: sandbox.siteRoot,
    section: SECTION,
    backupRoot: sandbox.backupRoot,
  });

  for (const file of WRITABLE) {
    const relPath = relative(CONTENT_ROOT, file);
    const before = readFileSync(join(sandbox.contentRoot, relPath), 'utf8');
    const mtimeBefore = statSync(join(sandbox.contentRoot, relPath)).mtimeMs;

    const preview = service.previewEdit({ path: relPath, text: before });
    const result = service.saveEdit({ path: relPath, text: before });

    assert.equal(preview.status, 'noop', `${relPath} preview`);
    assert.equal(preview.diff.changed, 0, relPath);
    assert.equal(result.status, 'noop', `${relPath} status`);
    assert.equal(result.backupPath, null, `${relPath} backup`);
    assert.equal(sha256(readFileSync(join(sandbox.contentRoot, relPath), 'utf8')), sha256(before), relPath);
    assert.equal(statSync(join(sandbox.contentRoot, relPath)).mtimeMs, mtimeBefore, `${relPath} mtime`);
  }

  assert.equal(existsSync(sandbox.backupRoot), false, 'no backup may be created by a no-op run');
});

test('every read-only document is refused by SafeWriter', (t) => {
  const sandbox = makeSandbox(t);
  const guard = new PathGuard({ contentRoot: sandbox.contentRoot });

  for (const file of READ_ONLY) {
    const relPath = relative(CONTENT_ROOT, file);
    assert.throws(
      () => saveSafely({ guard, relPath, nextText: 'x', backupRoot: sandbox.backupRoot }),
      /outside|absolute path|only \.md/i,
      relPath,
    );
  }
  assert.equal(existsSync(sandbox.backupRoot), false);
});

test('the fixture content tree is untouched by the whole suite', () => {
  const after = treeHashes(CONTENT_ROOT);
  assert.deepEqual([...after.entries()].sort(), [...REAL_TREE_BEFORE.entries()].sort());
});

test('the editor build and its backups live outside the site', () => {
  // The one deliberate look at the real site: whatever the tests do, the editor's own files
  // must never be installed inside the site Hugo builds.
  assert.ok(!join(EDITOR_ROOT, 'dist').startsWith(`${REAL_SITE}/`), 'editor dist must not be inside site/');

  const named = walk(REAL_SITE).filter(
    (file) => /editor/i.test(relative(REAL_SITE, file)) && !relative(REAL_SITE, file).startsWith('themes/'),
  );
  assert.deepEqual(named, []);
});
