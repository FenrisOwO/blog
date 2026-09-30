// Publishing a finished build into the site's output directory.
//
// The guard tests matter more than the happy path: this is the only code in the project
// that deletes anything, and only when explicitly asked to.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PublishTargetError, publishDirectory } from '../src/build/publisher.js';

function makeTree(t) {
  const root = mkdtempSync(join(tmpdir(), 'hve-publish-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const staging = join(root, 'staging');
  const output = join(root, 'public');
  mkdirSync(join(staging, 'nested'), { recursive: true });
  writeFileSync(join(staging, 'index.html'), '<html>v1</html>');
  writeFileSync(join(staging, 'nested', 'page.html'), '<html>nested</html>');
  return { root, staging, output };
}

test('a published build overwrites and adds files', async (t) => {
  const { root, staging, output } = makeTree(t);
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'index.html'), '<html>stale</html>');
  writeFileSync(join(output, 'leftover.html'), '<html>old</html>');

  const result = await publishDirectory({ from: staging, to: output, allowedRoot: root });

  assert.equal(result.files, 2);
  assert.equal(result.added, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.removed, 0);
  assert.equal(readFileSync(join(output, 'index.html'), 'utf8'), '<html>v1</html>');
  assert.equal(readFileSync(join(output, 'nested', 'page.html'), 'utf8'), '<html>nested</html>');
  // Without `clean`, stale output survives - the same default Hugo has.
  assert.equal(existsSync(join(output, 'leftover.html')), true);
});

test('clean removes files the build no longer produces', async (t) => {
  const { root, staging, output } = makeTree(t);
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'leftover.html'), '<html>old</html>');

  const result = await publishDirectory({ from: staging, to: output, allowedRoot: root, clean: true });

  assert.equal(result.removed, 1);
  assert.equal(existsSync(join(output, 'leftover.html')), false);
});

// Phase 6: a deleted resource has to disappear from the preview too, but `clean` is far too
// blunt for that (it would also delete whatever the user put in the output by hand). The
// manifest answers the narrower question: which outputs did *this* publisher write last time,
// and which of those did it not write now?
test('prune removes an output whose source is gone, and nothing else', async (t) => {
  const { root, staging, output } = makeTree(t);
  const manifest = join(root, 'manifest.json');
  mkdirSync(join(staging, 'p', 'gallery'), { recursive: true });
  writeFileSync(join(staging, 'p', 'gallery', 'keep.jpg'), 'jpeg-1');
  writeFileSync(join(staging, 'p', 'gallery', 'gone.jpg'), 'jpeg-2');

  // First build: both images are published and recorded.
  const first = await publishDirectory({ from: staging, to: output, allowedRoot: root, manifest });
  assert.equal(first.added, 4);

  // The source of one of them is deleted, and the user drops a file of their own into the
  // output directory.
  rmSync(join(staging, 'p', 'gallery', 'gone.jpg'));
  writeFileSync(join(output, 'notes.txt'), 'mine');

  const second = await publishDirectory({ from: staging, to: output, allowedRoot: root, manifest, prune: true });

  assert.equal(second.removed, 1);
  assert.equal(existsSync(join(output, 'p', 'gallery', 'gone.jpg')), false, 'the stale image is gone');
  assert.equal(existsSync(join(output, 'p', 'gallery', 'keep.jpg')), true, 'the rest is untouched');
  assert.equal(existsSync(join(output, 'notes.txt')), true, 'a file the manifest never saw is not pruned');

  // Without `prune` the stale output survives, exactly as it did before this phase.
  writeFileSync(join(staging, 'p', 'gallery', 'gone.jpg'), 'jpeg-2-again');
  await publishDirectory({ from: staging, to: output, allowedRoot: root, manifest });
  rmSync(join(staging, 'p', 'gallery', 'gone.jpg'));
  const third = await publishDirectory({ from: staging, to: output, allowedRoot: root, manifest });
  assert.equal(third.removed, 0);
  assert.equal(existsSync(join(output, 'p', 'gallery', 'gone.jpg')), true);
});

test('prune leaves a published file alone once somebody else has edited it', async (t) => {
  const { root, staging, output } = makeTree(t);
  const manifest = join(root, 'manifest.json');
  writeFileSync(join(staging, 'extra.html'), '<html>v1</html>');
  await publishDirectory({ from: staging, to: output, allowedRoot: root, manifest });

  // The build no longer produces it, but the copy in the output has been changed by hand:
  // that is somebody's work, not a stale output.
  rmSync(join(staging, 'extra.html'));
  writeFileSync(join(output, 'extra.html'), '<html>hand-edited</html>');

  const result = await publishDirectory({ from: staging, to: output, allowedRoot: root, manifest, prune: true });
  assert.equal(result.removed, 0);
  assert.equal(readFileSync(join(output, 'extra.html'), 'utf8'), '<html>hand-edited</html>');
});

// The point of the manifest: Hugo rewrites every output file on every build, but only the
// pages that actually changed may be written to the output directory. Writing all 474 files
// of this site costs seconds on its mount; skipping the unchanged ones costs nothing.
test('a second publish of unchanged output writes nothing', async (t) => {
  const { root, staging, output } = makeTree(t);
  const manifest = join(root, 'manifest.json');

  const first = await publishDirectory({ from: staging, to: output, allowedRoot: root, manifest });
  assert.equal(first.added, 2);
  assert.equal(first.skipped, 0);

  const second = await publishDirectory({ from: staging, to: output, allowedRoot: root, manifest });
  assert.equal(second.added, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.skipped, 2);
  assert.equal(second.bytes, 0);
});

test('a rebuilt page is published even when its size is unchanged', async (t) => {
  const { root, staging, output } = makeTree(t);
  const manifest = join(root, 'manifest.json');
  await publishDirectory({ from: staging, to: output, allowedRoot: root, manifest });

  // Same length, different content - the case a size comparison alone would miss.
  writeFileSync(join(staging, 'index.html'), '<html>v2</html>');
  const result = await publishDirectory({ from: staging, to: output, allowedRoot: root, manifest });

  assert.equal(result.updated, 1);
  assert.equal(result.skipped, 1);
  assert.equal(readFileSync(join(output, 'index.html'), 'utf8'), '<html>v2</html>');
});

test('a file deleted from the output by hand is restored, not skipped as unchanged', async (t) => {
  const { root, staging, output } = makeTree(t);
  const manifest = join(root, 'manifest.json');
  await publishDirectory({ from: staging, to: output, allowedRoot: root, manifest });

  rmSync(join(output, 'nested', 'page.html'));
  const result = await publishDirectory({ from: staging, to: output, allowedRoot: root, manifest });

  assert.equal(result.updated, 0);
  assert.equal(result.added, 1);
  assert.equal(existsSync(join(output, 'nested', 'page.html')), true);
});

test('publishing outside the allowed root is refused', (t) => {
  const { root, staging } = makeTree(t);

  assert.throws(
    () => publishDirectory({ from: staging, to: join(root, '..', 'escaped'), allowedRoot: root }),
    PublishTargetError,
  );
  assert.throws(() => publishDirectory({ from: staging, to: '/tmp', allowedRoot: root }), PublishTargetError);
});

test('publishing into the allowed root itself is refused', (t) => {
  const { root, staging } = makeTree(t);
  assert.throws(() => publishDirectory({ from: staging, to: root, allowedRoot: root }), PublishTargetError);
});

test('a missing build output is refused rather than creating an empty site', (t) => {
  const { root, output } = makeTree(t);
  assert.throws(
    () => publishDirectory({ from: join(root, 'nope'), to: output, allowedRoot: root }),
    PublishTargetError,
  );
  assert.equal(existsSync(output), false);
});
