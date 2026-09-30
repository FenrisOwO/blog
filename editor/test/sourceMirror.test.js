// Mirroring the site into the build work directory.
//
// This exists because Hugo reads every file it builds from, and the site's mount answers a
// small-file read in ~15ms. The contract worth testing is that the mirror is a faithful
// copy - including deletions - and that it never copies the output directory back into
// itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mirrorSource } from '../src/build/sourceMirror.js';

function mirrorHas(mirror, rel) {
  try {
    readFileSync(join(mirror, rel));
    return true;
  } catch {
    return false;
  }
}

function makeSite(t) {
  const root = mkdtempSync(join(tmpdir(), 'hve-mirror-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const site = join(root, 'site');
  mkdirSync(join(site, 'content', 'post', 'hello'), { recursive: true });
  mkdirSync(join(site, 'themes', 'stack', 'layouts'), { recursive: true });
  mkdirSync(join(site, 'public'), { recursive: true });
  writeFileSync(join(site, 'hugo.toml'), 'title = "t"\n');
  writeFileSync(join(site, 'content', 'post', 'hello', 'index.md'), '# hello\n');
  writeFileSync(join(site, 'content', 'post', 'hello', 'photo.jpg'), 'jpeg-bytes');
  writeFileSync(join(site, 'themes', 'stack', 'layouts', 'single.html'), '<html></html>');
  writeFileSync(join(site, 'public', 'index.html'), '<html>published</html>');

  return { root, site, mirror: join(root, 'work', 'source') };
}

test('mirroring copies the source tree, contents included', async (t) => {
  const { site, mirror } = makeSite(t);

  const result = await mirrorSource({ from: site, to: mirror });

  // The caller decides what counts as source; without a skip list, everything is mirrored.
  assert.equal(result.files, 5);
  assert.equal(readFileSync(join(mirror, 'content', 'post', 'hello', 'index.md'), 'utf8'), '# hello\n');
  assert.equal(readFileSync(join(mirror, 'content', 'post', 'hello', 'photo.jpg'), 'utf8'), 'jpeg-bytes');
  assert.equal(readFileSync(join(mirror, 'hugo.toml'), 'utf8'), 'title = "t"\n');
  assert.equal(result.removed, 0);
});

test('the output directory is skipped so a build cannot mirror its own result', async (t) => {
  const { site, mirror } = makeSite(t);

  await mirrorSource({ from: site, to: mirror, skip: [join(site, 'public')] });

  assert.equal(readFileSync(join(mirror, 'content', 'post', 'hello', 'index.md'), 'utf8'), '# hello\n');
  assert.equal(mirrorHas(mirror, 'public/index.html'), false, 'public/ must not be mirrored');
});

test('a later mirror follows edits and deletions in the source', async (t) => {
  const { site, mirror } = makeSite(t);
  await mirrorSource({ from: site, to: mirror });

  writeFileSync(join(site, 'content', 'post', 'hello', 'index.md'), '# hello again\n');
  rmSync(join(site, 'themes', 'stack', 'layouts', 'single.html'));
  const result = await mirrorSource({ from: site, to: mirror });

  assert.equal(readFileSync(join(mirror, 'content', 'post', 'hello', 'index.md'), 'utf8'), '# hello again\n');
  assert.equal(result.removed, 1, 'a deleted article must not survive in the build');
  assert.equal(mirrorHas(mirror, 'themes/stack/layouts/single.html'), false);
});

test('mirroring a tree onto itself is refused', async (t) => {
  const { site } = makeSite(t);
  await assert.rejects(() => mirrorSource({ from: site, to: site }), /same directory/);
});
