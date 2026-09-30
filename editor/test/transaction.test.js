// Phase 7: the transaction - a change set that either happens completely or not at all.
//
// The failures that matter cannot be produced honestly from a test (a disk that fills up, a
// write that lands wrong), so the transaction takes its filesystem calls from one injectable
// object. Everything else is real: real paths, real PathGuard, real atomic writes, real trash.
// Each test asserts the same two things - what the tree looks like when it works, and that a
// failure leaves it exactly as it was.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { PathGuard } from '../src/site/paths.js';
import { atomicWrite, diffLines } from '../src/site/safeWrite.js';
import { listTrash } from '../src/site/trash.js';
import { ChangeSetError, createChangeSet } from '../src/relations/changeSet.js';
import { ChangeSetRejectedError, TransactionError, createTransaction } from '../src/relations/transaction.js';

const SITE_ROOT = '/projects/site';
const SECTIONS = ['post', 'page', 'categories'];

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'tx-'));
  cpSync(join(SITE_ROOT, 'content'), join(root, 'content'), { recursive: true });
  const backupRoot = join(root, '.backups');
  mkdirSync(backupRoot, { recursive: true });
  // No '' in the writable roots here: this file is about the guard's refusals, and a scope that
  // includes the content root would make every Markdown file inside it writable. The editor's
  // own configuration is the server's business (see server.test.js / acceptance).
  const guard = new PathGuard({ contentRoot: join(root, 'content'), writableRoots: ['post', 'page', 'categories'], taxonomies: ['categories', 'tags'] });
  return { root, backupRoot, guard, contentRoot: join(root, 'content'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fingerprint(dir, base = dir, out = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) fingerprint(abs, base, out);
    else out[abs.slice(base.length + 1)] = sha(readFileSync(abs));
  }
  return out;
}

function diff(before, after) {
  const changed = [];
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[path] !== after[path]) changed.push(path);
  }
  return changed.sort();
}

const A = 'post/pagination-test-01.en.md';
const B = 'post/pagination-test-02.en.md';

function editText(text, from, to) {
  return text.replace(from, to);
}

test('a change set describes itself: counts, diffs, moves and touched paths', () => {
  const set = createChangeSet({ operation: 'example' });
  set.modify({ relPath: A, before: 'a\nb\n', after: 'a\nc\n' });
  set.create({ relPath: 'post/new.md', text: '---\ntitle: new\n---\n' });
  set.delete({ relPath: B, kind: 'file' });
  set.move({ from: 'tags/Old/_index.md', to: 'tags/New/_index.md', location: 'taxonomy' });
  set.unchanged({ relPath: 'post/other.md' });

  const built = set.build();
  assert.deepEqual(built.counts, { modify: 1, create: 1, delete: 1, move: 1, total: 4, files: 4 });
  assert.equal(built.noop, false);
  assert.deepEqual(built.unchanged, [{ relPath: 'post/other.md' }]);
  assert.deepEqual(built.touched.sort(), [A, 'post/new.md', 'tags/New/_index.md', 'tags/Old/_index.md', B].sort());

  const modify = built.changes.find((change) => change.kind === 'modify');
  assert.deepEqual(modify.diff, { added: 1, removed: 1, changed: 2 });
  assert.match(modify.diffText, /- b\n\+ c/);
  const move = built.changes.find((change) => change.kind === 'move');
  assert.match(move.diffText, /MOVE tags\/Old\/_index\.md\n {2}→ tags\/New\/_index\.md/);
  assert.match(built.text, /将修改 1 个文件，新增 1 个，删除 1 个，移动 1 个/);
  assert.match(built.text, /（1 个文件已经是目标状态，不写入）/);
});

test('a change set refuses plans that cannot be executed', () => {
  assert.throws(() => createChangeSet({ operation: 'x' }).modify({ relPath: A, before: 'a', after: 'a' }), ChangeSetError);

  const same = createChangeSet({ operation: 'x' });
  same.modify({ relPath: A, before: 'a', after: 'b' });
  same.modify({ relPath: A, before: 'b', after: 'c' });
  assert.throws(() => same.build(), /被多个步骤同时写入或移动/);

  const writeAndDelete = createChangeSet({ operation: 'x' });
  writeAndDelete.delete({ relPath: A });
  writeAndDelete.create({ relPath: A, text: 'x' });
  assert.throws(() => writeAndDelete.build(), /同时被写入和删除或移动/);

  const collidingMoves = createChangeSet({ operation: 'x' });
  collidingMoves.move({ from: 'tags/A/_index.md', to: 'tags/C/_index.md' });
  collidingMoves.move({ from: 'tags/B/_index.md', to: 'tags/C/_index.md' });
  assert.throws(() => collidingMoves.build(), ChangeSetError);
});

test('committing a mixed change set applies every step and reads every step back', () => {
  const fixture = makeFixture();
  try {
    const textA = readFileSync(join(fixture.contentRoot, A), 'utf8');
    const textB = readFileSync(join(fixture.contentRoot, B), 'utf8');
    mkdirSync(join(fixture.contentRoot, 'tags', 'Old'), { recursive: true });
    writeFileSync(join(fixture.contentRoot, 'tags', 'Old', '_index.md'), '---\ntitle: Old\n---\n');
    const before = fingerprint(fixture.contentRoot);

    const set = createChangeSet({ operation: 'mixed' });
    set.modify({ relPath: A, before: textA, after: editText(textA, '- pagination', '- Pagination') });
    set.create({ relPath: 'post/created.md', text: '---\ntitle: created\n---\n\nbody\n' });
    set.delete({ relPath: B, kind: 'file' });
    set.move({ from: 'tags/Old/_index.md', to: 'tags/New/_index.md', location: 'taxonomy' });

    const transaction = createTransaction({ guard: fixture.guard, backupRoot: fixture.backupRoot, reason: 'test' });
    const built = set.build();
    const review = transaction.review(built);
    assert.equal(review.ok, true);

    const result = transaction.commit(built);
    assert.equal(result.status, 'committed');
    assert.equal(result.applied.length, 4);

    assert.equal(readFileSync(join(fixture.contentRoot, A), 'utf8'), editText(textA, '- pagination', '- Pagination'));
    assert.equal(readFileSync(join(fixture.contentRoot, 'post/created.md'), 'utf8'), '---\ntitle: created\n---\n\nbody\n');
    assert.equal(existsSync(join(fixture.contentRoot, B)), false);
    assert.equal(existsSync(join(fixture.contentRoot, 'tags', 'Old', '_index.md')), false);
    assert.equal(readFileSync(join(fixture.contentRoot, 'tags', 'New', '_index.md'), 'utf8'), '---\ntitle: Old\n---\n');

    // The backups and the trash are the durable record of what happened.
    const applied = result.applied.find((entry) => entry.kind === 'modify');
    assert.equal(readFileSync(applied.backupPath, 'utf8'), textA);
    const trash = listTrash({ backupRoot: fixture.backupRoot });
    assert.equal(trash.length, 1);
    assert.equal(trash[0].relPath, B);

    const changed = diff(before, fingerprint(fixture.contentRoot));
    assert.deepEqual(changed, [A, 'post/created.md', 'tags/New/_index.md', 'tags/Old/_index.md', B].sort());
  } finally {
    fixture.cleanup();
  }
});

test('a plan that the guard or the disk refuses writes nothing at all', () => {
  const fixture = makeFixture();
  try {
    const transaction = createTransaction({ guard: fixture.guard, backupRoot: fixture.backupRoot });
    const before = fingerprint(fixture.contentRoot);

    const existing = createChangeSet({ operation: 'create over an existing file' });
    existing.create({ relPath: A, text: 'x' });
    assert.equal(transaction.review(existing.build()).ok, false);
    assert.throws(() => transaction.commit(existing.build()), ChangeSetRejectedError);

    const outside = createChangeSet({ operation: 'write outside the writable roots' });
    outside.create({ relPath: 'tags/x/other.md', text: 'x' });
    assert.throws(() => transaction.commit(outside.build()), ChangeSetRejectedError);

    const traversal = createChangeSet({ operation: 'traversal' });
    traversal.create({ relPath: '../escape.md', text: 'x' });
    assert.throws(() => transaction.commit(traversal.build()), ChangeSetRejectedError);

    const disappear = createChangeSet({ operation: 'modify something that is not there' });
    disappear.modify({ relPath: 'post/does-not-exist.md', before: 'a', after: 'b' });
    assert.throws(() => transaction.commit(disappear.build()), ChangeSetRejectedError);

    const deleteSectionRoot = createChangeSet({ operation: 'delete a section root' });
    deleteSectionRoot.delete({ relPath: 'post', kind: 'directory' });
    assert.throws(() => transaction.commit(deleteSectionRoot.build()), ChangeSetRejectedError);

    assert.deepEqual(diff(before, fingerprint(fixture.contentRoot)), []);
  } finally {
    fixture.cleanup();
  }
});

test('a write that fails rolls the whole set back and leaves no partial state', () => {
  const fixture = makeFixture();
  try {
    const before = fingerprint(fixture.contentRoot);
    const textA = readFileSync(join(fixture.contentRoot, A), 'utf8');
    const textB = readFileSync(join(fixture.contentRoot, B), 'utf8');

    const set = createChangeSet({ operation: 'failing write' });
    set.modify({ relPath: A, before: textA, after: editText(textA, '- pagination', '- Pagination') });
    set.modify({ relPath: B, before: textB, after: editText(textB, '- pagination', '- Pagination') });
    const built = set.build();

    // The second write fails, after the first has already been applied.
    let writes = 0;
    const transaction = createTransaction({
      guard: fixture.guard,
      backupRoot: fixture.backupRoot,
      io: {
        atomicWrite: (path, text) => {
          writes += 1;
          if (writes === 2) throw new Error('ENOSPC: no space left on device');
          atomicWrite(path, text);
        },
      },
    });

    assert.throws(
      () => transaction.commit(built),
      (error) => {
        assert.ok(error instanceof TransactionError);
        assert.equal(error.details.rollback.ok, true);
        assert.match(error.message, /已回滚/);
        return true;
      },
    );

    // Two attempts were made (the failing one included); the rollback write is a third call.
    assert.ok(writes >= 2);
    // The first file is back to what it was, and nothing else moved.
    assert.deepEqual(diff(before, fingerprint(fixture.contentRoot)), []);
    assert.equal(readFileSync(join(fixture.contentRoot, A), 'utf8'), textA);
  } finally {
    fixture.cleanup();
  }
});

test('a write that lands wrong is caught by the read-back and rolled back', () => {
  const fixture = makeFixture();
  try {
    const before = fingerprint(fixture.contentRoot);
    const textA = readFileSync(join(fixture.contentRoot, A), 'utf8');
    const textB = readFileSync(join(fixture.contentRoot, B), 'utf8');

    const set = createChangeSet({ operation: 'silent corruption' });
    set.modify({ relPath: A, before: textA, after: editText(textA, '- pagination', '- Pagination') });
    set.modify({ relPath: B, before: textB, after: editText(textB, '- pagination', '- Pagination') });
    const built = set.build();

    // The second write "succeeds" but writes something else - the failure a read-back exists for.
    let writes = 0;
    const transaction = createTransaction({
      guard: fixture.guard,
      backupRoot: fixture.backupRoot,
      io: {
        atomicWrite: (path, text) => {
          writes += 1;
          atomicWrite(path, writes === 2 ? `${text}\ntruncated by a bug\n` : text);
        },
      },
    });

    assert.throws(
      () => transaction.commit(built),
      (error) => error instanceof TransactionError && /回读不一致/.test(error.details.cause),
    );

    assert.deepEqual(diff(before, fingerprint(fixture.contentRoot)), []);
  } finally {
    fixture.cleanup();
  }
});

test('a delete is undone from the trash when a later step fails', () => {
  const fixture = makeFixture();
  try {
    const before = fingerprint(fixture.contentRoot);
    const textA = readFileSync(join(fixture.contentRoot, A), 'utf8');
    const textB = readFileSync(join(fixture.contentRoot, B), 'utf8');

    const set = createChangeSet({ operation: 'delete then fail' });
    set.delete({ relPath: B, kind: 'file' });
    set.modify({ relPath: A, before: textA, after: editText(textA, '- pagination', '- Pagination') });
    const built = set.build();

    const transaction = createTransaction({
      guard: fixture.guard,
      backupRoot: fixture.backupRoot,
      io: {
        atomicWrite: () => {
          throw new Error('EIO: i/o error');
        },
      },
    });

    assert.throws(() => transaction.commit(built), TransactionError);
    // The deleted file is back, byte for byte, and the trash entry was restored (not duplicated).
    assert.deepEqual(diff(before, fingerprint(fixture.contentRoot)), []);
    assert.equal(readFileSync(join(fixture.contentRoot, B), 'utf8'), textB);
  } finally {
    fixture.cleanup();
  }
});

test('a move is undone and its new directory removed when a later step fails', () => {
  const fixture = makeFixture();
  try {
    mkdirSync(join(fixture.contentRoot, 'tags', 'Old'), { recursive: true });
    writeFileSync(join(fixture.contentRoot, 'tags', 'Old', '_index.md'), '---\ntitle: Old\n---\n');
    const before = fingerprint(fixture.contentRoot);
    const textA = readFileSync(join(fixture.contentRoot, A), 'utf8');

    const set = createChangeSet({ operation: 'move then fail' });
    set.move({ from: 'tags/Old/_index.md', to: 'tags/New/_index.md', location: 'taxonomy' });
    set.modify({ relPath: A, before: textA, after: editText(textA, '- pagination', '- Pagination') });
    const built = set.build();

    const transaction = createTransaction({
      guard: fixture.guard,
      backupRoot: fixture.backupRoot,
      io: {
        atomicWrite: () => {
          throw new Error('EIO: i/o error');
        },
      },
    });

    assert.throws(() => transaction.commit(built), TransactionError);
    assert.equal(existsSync(join(fixture.contentRoot, 'tags', 'Old', '_index.md')), true);
    // The directory the move created is gone too: rolling back means the tree as it was.
    assert.equal(existsSync(join(fixture.contentRoot, 'tags', 'New')), false);
    assert.deepEqual(diff(before, fingerprint(fixture.contentRoot)), []);
  } finally {
    fixture.cleanup();
  }
});

test('a created file is removed again when a later step fails', () => {
  const fixture = makeFixture();
  try {
    const before = fingerprint(fixture.contentRoot);
    const textA = readFileSync(join(fixture.contentRoot, A), 'utf8');

    const set = createChangeSet({ operation: 'create then fail' });
    set.create({ relPath: 'post/temporary.md', text: '---\ntitle: temporary\n---\n' });
    set.modify({ relPath: A, before: textA, after: editText(textA, '- pagination', '- Pagination') });
    const built = set.build();

    const transaction = createTransaction({
      guard: fixture.guard,
      backupRoot: fixture.backupRoot,
      io: {
        atomicWrite: () => {
          throw new Error('EIO: i/o error');
        },
      },
    });

    assert.throws(() => transaction.commit(built), TransactionError);
    assert.equal(existsSync(join(fixture.contentRoot, 'post', 'temporary.md')), false);
    assert.deepEqual(diff(before, fingerprint(fixture.contentRoot)), []);
  } finally {
    fixture.cleanup();
  }
});

test('a rollback that cannot finish says so instead of pretending', () => {
  const fixture = makeFixture();
  try {
    const textA = readFileSync(join(fixture.contentRoot, A), 'utf8');
    const textB = readFileSync(join(fixture.contentRoot, B), 'utf8');
    const set = createChangeSet({ operation: 'rollback fails too' });
    set.modify({ relPath: A, before: textA, after: editText(textA, '- pagination', '- Pagination') });
    set.modify({ relPath: B, before: textB, after: editText(textB, '- pagination', '- Pagination') });
    const built = set.build();

    let writes = 0;
    const transaction = createTransaction({
      guard: fixture.guard,
      backupRoot: fixture.backupRoot,
      io: {
        atomicWrite: (path, text) => {
          writes += 1;
          if (writes >= 2) throw new Error('EIO: i/o error');
          atomicWrite(path, text);
        },
      },
    });

    assert.throws(
      () => transaction.commit(built),
      (error) => {
        assert.ok(error instanceof TransactionError);
        assert.equal(error.details.rollback.ok, false);
        assert.match(error.message, /回滚未能完全成功/);
        return true;
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test('the review reports the guard verdict before anything is offered for confirmation', () => {
  const fixture = makeFixture();
  try {
    const transaction = createTransaction({ guard: fixture.guard, backupRoot: fixture.backupRoot });
    const set = createChangeSet({ operation: 'ok' });
    set.create({ relPath: 'post/fine.md', text: 'x\n' });
    assert.deepEqual(transaction.review(set.build()), { ok: true, conflicts: [] });

    const bad = createChangeSet({ operation: 'not ok' });
    bad.move({ from: 'post/does-not-exist.md', to: 'post/other.md' });
    const review = transaction.review(bad.build());
    assert.equal(review.ok, false);
    assert.equal(review.conflicts.length, 1);
    assert.match(review.conflicts[0], /文件不存在/);
    assert.equal(existsSync(join(fixture.contentRoot, 'post', 'fine.md')), false);
  } finally {
    fixture.cleanup();
  }
});

test('diffLines is the diff a change set reports, so the preview cannot drift from the write', () => {
  const diffed = diffLines('a\nb\n', 'a\nc\n');
  assert.equal(diffed.changed, 2);
  assert.deepEqual(diffed.removed, ['b']);
  assert.deepEqual(diffed.added, ['c']);
  void statSync;
  void dirname;
});
