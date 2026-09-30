// Source watching, and specifically the three ways it could go wrong:
//   - reacting to generated output (infinite rebuild loop)
//   - dropping a real edit during the quiet window that follows a build
//   - silently never firing at all, because inotify is unavailable on the mount
//
// The last one is not hypothetical: this project's site is on a v9fs (9p) mount where
// fs.watch registers fine and then never delivers anything, including for a single
// non-recursive directory. Polling is therefore the mechanism under test here, and the
// tests deliberately run with nativeWatch disabled so a passing suite means the
// guarantee holds, not that the accelerator happened to work on this filesystem.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSourceWatcher, diffFingerprints, probeNativeWatch, scanTree, scanTreeAsync, shouldIgnore } from '../src/build/watcher.js';

test('generated output, caches and editor temp files are ignored', () => {
  const ignored = [
    'public/index.html',
    'public/post/a/index.html',
    'resources/_gen/assets/scss/a.css',
    'assets/jsconfig.json',
    '.hugo_build.lock',
    'content/post/.a.md.tmp-1234-5678',
    'content/post/a.md.tmp-99-100',
    'content/post/a.md~',
    'content/post/.a.md.swp',
    'node_modules/whatever/index.js',
    'themes/hugo-theme-stack/layouts/baseof.html',
    '.backups/2026/a.md',
    '',
  ];

  for (const path of ignored) {
    assert.equal(shouldIgnore(path), true, `${path} should be ignored`);
  }
});

test('real source files are watched', () => {
  const watched = [
    'content/post/a.md',
    'content/post/some-bundle/index.en.md',
    'config/_default/params.toml',
    'config/_default/languages.toml',
    'layouts/_partials/footer/custom.html',
    'assets/img/avatar.png',
    'static/fonts/a.woff2',
  ];

  for (const path of watched) {
    assert.equal(shouldIgnore(path), false, `${path} should be watched`);
  }
});

function makeSite(t) {
  const root = mkdtempSync(join(tmpdir(), 'hve-watch-'));
  for (const dir of ['content/post', 'assets', 'config', 'public', 'resources/_gen']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, 'content', 'post', 'a.md'), '---\ntitle: a\n---\n');
  writeFileSync(join(root, 'assets', 'jsconfig.json'), '{}');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function collector() {
  const events = [];
  return { events, onChange: (event) => events.push(event) };
}

async function waitFor(predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// nativeWatch: false on purpose - polling must be sufficient on its own.
function startWatcher(siteRoot, onChange, extra = {}) {
  return createSourceWatcher({
    siteRoot,
    roots: ['content', 'assets', 'config', 'public'],
    pollMs: 120,
    debounceMs: 40,
    nativeWatch: false,
    onChange,
    ...extra,
  });
}

test('the fingerprint covers the source tree but not the generated output', (t) => {
  const siteRoot = makeSite(t);

  const marks = scanTree(siteRoot, ['content', 'assets', 'public', 'resources']);

  assert.ok(marks.has('content/post/a.md'));
  assert.equal(marks.has('assets/jsconfig.json'), false, "Hugo's jsconfig is not source");
  assert.equal([...marks.keys()].some((path) => path.startsWith('public/')), false);
  assert.equal([...marks.keys()].some((path) => path.startsWith('resources/')), false);
});

test('diffFingerprints reports changes, additions and deletions', () => {
  const before = new Map([
    ['a', '1:1'],
    ['b', '1:1'],
    ['c', '1:1'],
  ]);
  const after = new Map([
    ['a', '1:1'],
    ['b', '2:1'],
    ['d', '1:1'],
  ]);

  assert.deepEqual(diffFingerprints(before, after), ['b', 'c', 'd']);
  assert.deepEqual(diffFingerprints(before, before), []);
});

test('editing a source file triggers one debounced callback', async (t) => {
  const siteRoot = makeSite(t);
  const { events, onChange } = collector();
  const watcher = startWatcher(siteRoot, onChange);
  t.after(() => watcher.close());

  writeFileSync(join(siteRoot, 'content', 'post', 'a.md'), '---\ntitle: a changed\n---\n');

  assert.equal(await waitFor(() => events.length > 0), true, 'polling must notice the edit');
  await settle(200);

  assert.equal(events.length, 1, 'several polls of the same change must collapse into one callback');
  assert.ok(events[0].paths.includes('content/post/a.md'));
});

test('creating and deleting a file are both reported', async (t) => {
  const siteRoot = makeSite(t);
  const { events, onChange } = collector();
  const watcher = startWatcher(siteRoot, onChange);
  t.after(() => watcher.close());

  const probe = join(siteRoot, 'content', 'post', 'probe.md');
  writeFileSync(probe, '---\ntitle: probe\n---\n');
  assert.equal(await waitFor(() => events.some((e) => e.paths.includes('content/post/probe.md'))), true);

  const before = events.length;
  rmSync(probe, { force: true });
  assert.equal(await waitFor(() => events.length > before), true, 'a deletion is a change too');
  assert.ok(events.at(-1).paths.includes('content/post/probe.md'));
});

test('writing to public/ never triggers a rebuild', async (t) => {
  const siteRoot = makeSite(t);
  const { events, onChange } = collector();
  const watcher = startWatcher(siteRoot, onChange);
  t.after(() => watcher.close());

  writeFileSync(join(siteRoot, 'public', 'index.html'), '<html></html>');
  await settle(400);

  assert.deepEqual(events, [], 'generated output is not source');
});

test("Hugo's own side-effect files never trigger a rebuild", async (t) => {
  const siteRoot = makeSite(t);
  const { events, onChange } = collector();
  const watcher = startWatcher(siteRoot, onChange);
  t.after(() => watcher.close());

  writeFileSync(join(siteRoot, 'assets', 'jsconfig.json'), '{"changed":true}');
  writeFileSync(join(siteRoot, '.hugo_build.lock'), '');
  await settle(400);

  assert.deepEqual(events, []);
});

test('an edit made during the post-build quiet window is deferred, not dropped', async (t) => {
  const siteRoot = makeSite(t);
  const { events, onChange } = collector();
  const watcher = startWatcher(siteRoot, onChange);
  t.after(() => watcher.close());

  watcher.suppress(800);
  writeFileSync(join(siteRoot, 'content', 'post', 'b.md'), '---\ntitle: b\n---\n');
  await settle(300);

  assert.deepEqual(events, [], 'the quiet window must hold the event back');
  assert.equal(await waitFor(() => events.length > 0), true, 'but the edit must still be delivered');
  assert.ok(events[0].paths.includes('content/post/b.md'));
});

test('closing the watcher stops polling and releases the handles', async (t) => {
  const siteRoot = makeSite(t);
  const { events, onChange } = collector();
  const watcher = startWatcher(siteRoot, onChange);

  watcher.close();
  assert.equal(watcher.isWatching(), false);
  writeFileSync(join(siteRoot, 'content', 'post', 'c.md'), '---\ntitle: c\n---\n');
  await settle(500);

  assert.deepEqual(events, []);
});

test('absorbing a write the editor itself made stops it being reported back', async (t) => {
  const siteRoot = makeSite(t);
  const { events, onChange } = collector();
  const watcher = startWatcher(siteRoot, onChange);
  t.after(() => watcher.close());

  const target = join(siteRoot, 'content', 'post', 'a.md');
  writeFileSync(target, '---\ntitle: a\n---\n\nsaved by the editor\n');
  // The editor saves the file and immediately says "that was me".
  watcher.absorb(['content/post/a.md']);

  await settle(400);
  assert.deepEqual(events, [], 'our own write must not look like an external edit');

  // A later, genuinely external change still gets through.
  writeFileSync(target, '---\ntitle: a\n---\n\nedited outside the editor\n');
  assert.equal(await waitFor(() => events.length > 0), true);
  assert.ok(events.at(-1).paths.includes('content/post/a.md'));
});

test('absorb also cancels a change the watcher had already noticed', async (t) => {
  const siteRoot = makeSite(t);
  const { events, onChange } = collector();
  const watcher = startWatcher(siteRoot, onChange, { debounceMs: 600 });
  t.after(() => watcher.close());

  writeFileSync(join(siteRoot, 'content', 'post', 'a.md'), '---\ntitle: a2\n---\n');
  await settle(150); // a poll has run: the change is pending but not yet flushed

  watcher.absorb(['content/post/a.md']);
  await settle(900);

  assert.deepEqual(events, [], 'an absorbed pending change must be dropped, not flushed');
});

test('the strategy is reported honestly when native watching is off', (t) => {
  const siteRoot = makeSite(t);
  const watcher = startWatcher(siteRoot, () => {});
  t.after(() => watcher.close());

  assert.equal(watcher.strategy(), 'poll');
  assert.equal(watcher.pollMs, 120);
});

test('probing this filesystem for inotify support returns a definite answer', async () => {
  // Informational, but it must not throw and must clean up after itself: the answer
  // differs between overlayfs (works) and the v9fs mount this project's site lives on.
  const supported = await probeNativeWatch({ probeDir: join(tmpdir(), 'hve-watch-probe') });
  assert.equal(typeof supported, 'boolean');
});

// --- Phase Insert A: tiered polling -----------------------------------------
//
// static/ and assets/ are large and almost never edited by hand, so they are polled on a
// slower cadence than content/. Slower must not mean unwatched: a change there still has to
// reach the build. These tests hold both halves of that.

function makeTieredSite(t) {
  const root = mkdtempSync(join(tmpdir(), 'hve-watch-tier-'));
  for (const dir of ['content/post', 'static', 'config']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'content', 'post', 'a.md'), '---\ntitle: a\n---\n');
  writeFileSync(join(root, 'static', 'a.css'), 'body{}\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a content change is reported promptly, and only for the file that changed', async (t) => {
  const siteRoot = makeTieredSite(t);
  const { events, onChange } = collector();
  const watcher = startWatcher(siteRoot, onChange, { roots: ['content', 'static', 'config'] });
  t.after(() => watcher.close());

  writeFileSync(join(siteRoot, 'content', 'post', 'a.md'), '---\ntitle: a changed\n---\n');
  assert.equal(await waitFor(() => events.some((e) => e.paths.includes('content/post/a.md')), 1500), true);
  assert.equal(
    events.some((e) => e.paths.some((path) => path.startsWith('static/'))),
    false,
    'a fast poll that skips static/ must not report static/ files as changed or deleted',
  );
});

test('a change under static/ is still reported, one slow poll later', async (t) => {
  const siteRoot = makeTieredSite(t);
  const { events, onChange } = collector();
  const watcher = startWatcher(siteRoot, onChange, { roots: ['content', 'static', 'config'] });
  t.after(() => watcher.close());

  writeFileSync(join(siteRoot, 'static', 'a.css'), 'body{color:red}\n');
  // pollMs is 120ms and the slow tier is scanned every fourth poll, so this budget is
  // generous on purpose: the point is that the slow tier is never skipped forever.
  assert.equal(await waitFor(() => events.some((e) => e.paths.includes('static/a.css')), 4000), true);
});

test('a deletion under static/ is reported too, not silently forgotten', async (t) => {
  const siteRoot = makeTieredSite(t);
  const { events, onChange } = collector();
  const watcher = startWatcher(siteRoot, onChange, { roots: ['content', 'static', 'config'] });
  t.after(() => watcher.close());

  rmSync(join(siteRoot, 'static', 'a.css'));
  assert.equal(await waitFor(() => events.some((e) => e.paths.includes('static/a.css')), 4000), true);
});

// Phase Insert A: the poll walk is concurrent (every stat is issued through the shared
// limiter instead of one after another), because on this mount a serial walk spent
// 155-460ms of the interval doing nothing but waiting, and that latency was taken from the
// editor's own disk work. Parallelism is an implementation detail, so what is pinned here
// is the fingerprint itself: it must be exactly what the synchronous walk returns.

test('the concurrent scan produces the same fingerprint as the synchronous one', async (t) => {
  const siteRoot = makeSite(t);
  mkdirSync(join(siteRoot, 'content', 'post', 'nested'), { recursive: true });
  writeFileSync(join(siteRoot, 'content', 'post', 'nested', 'deep.md'), '---\ntitle: deep\n---\n');
  writeFileSync(join(siteRoot, 'assets', 'style.css'), 'a{}');
  writeFileSync(join(siteRoot, 'public', 'index.html'), '<html></html>');
  writeFileSync(join(siteRoot, 'config', 'hugo.toml'), 'baseURL = "/"\n');

  const roots = ['content', 'assets', 'config', 'public', 'resources'];
  const sync = scanTree(siteRoot, roots);
  const concurrent = await scanTreeAsync(siteRoot, roots);

  assert.deepEqual([...concurrent.entries()].sort(), [...sync.entries()].sort());
  assert.ok(concurrent.has('content/post/nested/deep.md'), 'nested files are covered');
  assert.ok(concurrent.has('assets/style.css'));
  assert.equal(concurrent.has('assets/jsconfig.json'), false, 'the same ignore rules apply');
  assert.equal([...concurrent.keys()].some((path) => path.startsWith('public/')), false);
});

test('the concurrent scan sees an edit, and tolerates a root that does not exist', async (t) => {
  const siteRoot = makeSite(t);
  const before = await scanTreeAsync(siteRoot, ['content', 'missing-root']);

  writeFileSync(join(siteRoot, 'content', 'post', 'a.md'), '---\ntitle: a changed\n---\n');
  const after = await scanTreeAsync(siteRoot, ['content', 'missing-root']);

  assert.notEqual(after.get('content/post/a.md'), before.get('content/post/a.md'));
  assert.deepEqual(diffFingerprints(before, after), ['content/post/a.md']);
});
