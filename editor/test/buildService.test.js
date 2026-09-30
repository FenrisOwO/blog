// The build state machine.
//
// Most of this file tests the scheduling contract (one build at a time, bursts coalesced,
// debounce honoured) with a scripted runner, because that contract is what stops a save
// plus its watcher echo from building the site twice. The last test is a real Hugo build
// of the real site - slow on purpose, and the only place the two are wired together.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createBuildService } from '../src/build/buildService.js';

const SITE_ROOT = '/projects/site';

function okResult(extra = {}) {
  return {
    ok: true,
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnError: null,
    stdout: 'Start building sites …\n\nTotal in 12 ms\n',
    stderr: '',
    truncated: false,
    durationMs: 12,
    command: 'hugo',
    ...extra,
  };
}

// A runner that records its calls and materialises a fake build output, so the publish
// step has something real to copy.
function scriptedRunner({ results = [], materialise = true, destination } = {}) {
  const calls = [];
  const runner = async (options) => {
    calls.push(options);
    const scripted = results[calls.length - 1] ?? results.at(-1) ?? okResult();
    if (scripted.ok && materialise) {
      const dir = destination ?? options.args[options.args.indexOf('--destination') + 1];
      mkdirSync(join(dir, 'nested'), { recursive: true });
      writeFileSync(join(dir, 'index.html'), `<html>build ${calls.length}</html>`);
      writeFileSync(join(dir, 'nested', 'page.html'), `<html>nested ${calls.length}</html>`);
    }
    return scripted;
  };
  runner.calls = calls;
  return runner;
}

function makeService(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hve-build-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const stagingDir = overrides.stagingDir ?? join(root, 'staging');
  const publishDir = overrides.publishDir ?? join(root, 'public');
  const runner = overrides.runner ?? scriptedRunner({ destination: stagingDir });

  const service = createBuildService({
    siteRoot: SITE_ROOT,
    stagingDir,
    cacheDir: join(root, 'cache'),
    publishDir,
    publishRoot: root,
    debounceMs: 20,
    runner,
    ...overrides,
  });

  return { service, root, stagingDir, publishDir, runner };
}

test('a successful build publishes and advances the preview generation', async (t) => {
  const { service, publishDir, runner } = makeService(t);

  assert.equal(service.getStatus().state, 'idle');
  const record = await service.build({ trigger: 'manual' });

  assert.equal(record.state, 'success');
  assert.equal(record.exitCode, 0);
  assert.equal(record.errorCount, 0);
  assert.equal(record.published.files, 2);
  assert.ok(record.published.bytes > 0);
  assert.equal(existsSync(join(publishDir, 'index.html')), true);
  assert.equal(service.getStatus().generation, 1);
  assert.equal(service.getStatus().preview.url, '/');
  assert.equal(runner.calls.length, 1);
});

// Hugo reads every file it builds from. On the site's mount that is ~8s per build, so the
// service reads a mirror on local disk instead; these two tests pin the contract: the mirror
// is what Hugo is pointed at, and a mirror that fails to update stops the build rather than
// letting Hugo render stale content.
test('a configured source mirror is what Hugo builds from', async (t) => {
  const sourceBuildDir = join(mkdtempSync(join(tmpdir(), 'hve-work-')), 'source');
  t.after(() => rmSync(dirname(sourceBuildDir), { recursive: true, force: true }));

  const { service, runner, stagingDir } = makeService(t, { sourceBuildDir });
  const record = await service.build({ trigger: 'manual' });

  assert.equal(record.state, 'success');
  const call = runner.calls[0];
  assert.equal(call.cwd, sourceBuildDir);
  assert.equal(call.args[call.args.indexOf('--source') + 1], sourceBuildDir);
  assert.equal(call.args[call.args.indexOf('--destination') + 1], stagingDir);

  const mirrored = readdirSync(sourceBuildDir);
  assert.ok(mirrored.includes('content'), 'the mirror is a copy of the site');
  assert.equal(mirrored.includes('.git'), false, 'repository metadata is not source');
  assert.equal(typeof record.mirrorMs, 'number');
  assert.ok(record.mirror.files > 0);
});

test('a mirror that cannot be prepared fails the build instead of building stale content', async (t) => {
  const { root } = makeService(t);
  const blocker = join(root, 'not-a-directory');
  writeFileSync(blocker, 'file');
  const { service, runner } = makeService(t, { sourceBuildDir: join(blocker, 'source') });

  const record = await service.build({ trigger: 'manual' });

  assert.equal(record.state, 'error');
  assert.match(record.message, /同步源目录失败/);
  assert.equal(runner.calls.length, 0, 'Hugo must not run against a stale mirror');
});

test('a failed build changes nothing on disk and does not advance the generation', async (t) => {
  const failing = scriptedRunner({
    materialise: false,
    results: [
      {
        ...okResult(),
        ok: false,
        exitCode: 1,
        stderr:
          'ERROR error building site: assemble: failed to create page from pageMetaSource /post/x: ' +
          `"${SITE_ROOT}/content/post/x/index.md:4:7": [3:7] sequence end token ']' not found\n`,
      },
    ],
  });
  const { service, publishDir } = makeService(t, { runner: failing });

  const record = await service.build({ trigger: 'save' });

  assert.equal(record.state, 'error');
  assert.equal(record.exitCode, 1);
  assert.equal(record.errorCount, 1);
  assert.equal(record.diagnostics[0].file, 'content/post/x/index.md');
  assert.equal(record.message, "content/post/x/index.md:4:7: [3:7] sequence end token ']' not found");
  assert.equal(record.published, null);
  assert.equal(existsSync(publishDir), false, 'a failing build must not create the output directory');
  assert.equal(service.getStatus().generation, 0);
});

test('a build that cannot even start Hugo is reported, not thrown', async (t) => {
  const { service } = makeService(t, {
    runner: scriptedRunner({ results: [{ ...okResult(), ok: false, exitCode: null, spawnError: 'spawn hugo ENOENT' }] }),
  });

  const record = await service.build({ trigger: 'manual' });

  assert.equal(record.state, 'error');
  assert.match(record.message, /无法启动 Hugo/);
});

test('a timed out build is reported as such', async (t) => {
  const { service } = makeService(t, {
    runner: scriptedRunner({ results: [{ ...okResult(), ok: false, exitCode: null, timedOut: true }] }),
  });

  const record = await service.build({ trigger: 'manual' });

  assert.equal(record.state, 'error');
  assert.match(record.message, /超时/);
});

test('concurrent requests collapse into one build plus one follow-up', async (t) => {
  const { service, runner } = makeService(t);

  const first = service.build({ trigger: 'manual' });
  const second = service.build({ trigger: 'save' });
  const third = service.build({ trigger: 'watch' });

  assert.equal(first, second, 'callers join the in-flight build');
  assert.equal(second, third);

  await first;
  await service.waitForIdle();

  assert.equal(runner.calls.length, 2, 'three requests must produce at most two builds');
});

test('a burst of scheduled builds is debounced into one', async (t) => {
  const { service, runner } = makeService(t);

  service.scheduleBuild({ trigger: 'watch' });
  service.scheduleBuild({ trigger: 'watch' });
  service.scheduleBuild({ trigger: 'save' });
  assert.equal(service.getStatus().state, 'queued');

  await service.waitForIdle();

  assert.equal(runner.calls.length, 1);
  assert.equal(service.getStatus().state, 'success');
});

test('stop() cancels a scheduled build so shutdown does not trigger one', async (t) => {
  const { service, runner } = makeService(t);

  service.scheduleBuild({ trigger: 'watch' });
  service.stop();
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(runner.calls.length, 0);
});

test('the history is capped and the newest build is first', async (t) => {
  const { service } = makeService(t);

  for (let i = 0; i < 12; i += 1) await service.build({ trigger: 'manual' });
  const status = service.getStatus();

  assert.equal(status.history.length, 10);
  assert.equal(status.history[0].buildNumber, 12);
  assert.equal(status.generation, 12);
});

test('subscribers are notified across the build lifecycle', async (t) => {
  const { service } = makeService(t);
  const seen = [];
  const unsubscribe = service.subscribe((status) => seen.push(status.state));

  await service.build({ trigger: 'manual' });
  unsubscribe();

  assert.ok(seen.includes('running'));
  assert.equal(seen[seen.length - 1], 'success');
});

test('a real Hugo build of the real site publishes a real site', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hve-realbuild-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const service = createBuildService({
    siteRoot: SITE_ROOT,
    stagingDir: join(root, 'staging'),
    cacheDir: join(root, 'cache'),
    publishDir: join(root, 'public'),
    publishRoot: root,
    timeoutMs: 180_000,
  });

  const record = await service.build({ trigger: 'manual' });

  assert.equal(record.state, 'success', record.message);
  assert.equal(record.exitCode, 0);
  assert.equal(record.timedOut, false);
  assert.ok(record.published.files > 100, `expected a full site, published ${record.published?.files}`);
  assert.equal(record.errorCount, 0);
  assert.ok(existsSync(join(root, 'public', 'index.html')));
  assert.ok(readdirSync(join(root, 'public')).includes('post'));
  assert.equal(service.getStatus().generation, 1);
});
