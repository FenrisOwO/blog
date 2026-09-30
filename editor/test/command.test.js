// The process runner. Mechanics are tested with `node` so the assertions are about the
// runner (exit codes, timeouts, missing binaries), not about Hugo.

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultHugoBin, hugoArgs, readHugoVersion, runCommand } from '../src/build/command.js';

const NODE = process.execPath;

test('hugoArgs builds a hugo invocation that never touches the source tree', () => {
  const args = hugoArgs({ siteRoot: '/s', destination: '/out', cacheDir: '/cache' });
  assert.deepEqual(args, ['--source', '/s', '--destination', '/out', '--cacheDir', '/cache']);

  const cleaned = hugoArgs({ siteRoot: '/s', destination: '/out', cleanDestination: true, extraArgs: ['--contentDir', '/c'] });
  assert.deepEqual(cleaned, ['--source', '/s', '--destination', '/out', '--cleanDestinationDir', '--contentDir', '/c']);
});

test('the hugo binary is configurable and defaults to the one the project ships', () => {
  assert.equal(defaultHugoBin(), process.env.HUGO_BIN ?? '/projects/.bin/hugo');
});

test('a successful command resolves with its output', async () => {
  const result = await runCommand({ bin: NODE, args: ['-e', 'process.stdout.write("hello"); process.stderr.write("warn")'] });

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'hello');
  assert.equal(result.stderr, 'warn');
  assert.equal(result.timedOut, false);
  assert.equal(result.spawnError, null);
});

test('a non-zero exit is a result, not a thrown error', async () => {
  const result = await runCommand({ bin: NODE, args: ['-e', 'process.exit(3)'] });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
  assert.equal(result.timedOut, false);
});

test('a hung command is killed and reported as timed out', async () => {
  const started = Date.now();
  const result = await runCommand({
    bin: NODE,
    args: ['-e', 'setTimeout(() => {}, 60000)'],
    timeoutMs: 300,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.ok(Date.now() - started < 10_000, 'must not wait for the child to finish on its own');
});

test('a missing binary is reported instead of crashing the caller', async () => {
  const result = await runCommand({ bin: '/nope/definitely-not-a-binary', args: [] });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, null);
  assert.ok(typeof result.spawnError === 'string' && result.spawnError.length > 0);
});

test('output is capped, keeping the tail where the errors are', async () => {
  const result = await runCommand({
    bin: NODE,
    args: ['-e', 'process.stdout.write("A".repeat(500) + "END")'],
    maxOutputChars: 64,
  });

  assert.equal(result.truncated, true);
  assert.equal(result.stdout.length, 64);
  assert.ok(result.stdout.endsWith('END'));
});

test('the real Hugo reports its version', async () => {
  const version = await readHugoVersion(defaultHugoBin());

  assert.ok(version, 'expected to find the hugo binary');
  assert.match(version.line, /^hugo v\d+/);
  assert.equal(version.extended, true, 'the theme needs the extended build');
});
