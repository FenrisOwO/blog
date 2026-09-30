// Process runner for the Hugo build.
//
// Deliberately dumb and generic: it spawns a binary, captures output, enforces a
// timeout, and always RESOLVES with a result object instead of throwing on a non-zero
// exit. A failing Hugo build is a normal outcome the UI has to display, not an
// exception - only genuine programming errors should reject.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export const DEFAULT_TIMEOUT_MS = 180_000;
export const DEFAULT_MAX_OUTPUT_CHARS = 200_000;
const KILL_GRACE_MS = 3_000;

// The site ships its own Hugo (extended) outside the project so the site tree stays
// clean; fall back to PATH, and let the environment override.
export function defaultHugoBin() {
  if (process.env.HUGO_BIN) return process.env.HUGO_BIN;
  return existsSync('/projects/.bin/hugo') ? '/projects/.bin/hugo' : 'hugo';
}

export function hugoArgs({ siteRoot, destination, cacheDir, cleanDestination = false, extraArgs = [] }) {
  const args = ['--source', siteRoot, '--destination', destination];
  if (cacheDir) args.push('--cacheDir', cacheDir);
  if (cleanDestination) args.push('--cleanDestinationDir');
  args.push(...extraArgs);
  return args;
}

function keepTail(current, chunk, maxChars) {
  const combined = current + chunk;
  if (combined.length <= maxChars) return { text: combined, truncated: false };
  return { text: combined.slice(combined.length - maxChars), truncated: true };
}

export function runCommand({ bin, args = [], cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(bin, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({
        ok: false,
        exitCode: null,
        signal: null,
        timedOut: false,
        spawnError: error.message,
        stdout: '',
        stderr: '',
        truncated: false,
        durationMs: 0,
        startedAt,
        finishedAt: Date.now(),
        command: [bin, ...args].join(' '),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const next = keepTail(stdout, chunk, maxOutputChars);
      stdout = next.text;
      truncated = truncated || next.truncated;
    });
    child.stderr.on('data', (chunk) => {
      const next = keepTail(stderr, chunk, maxOutputChars);
      stderr = next.text;
      truncated = truncated || next.truncated;
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // A build that ignores SIGTERM must not keep the service wedged.
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref?.();
    }, timeoutMs);
    killTimer.unref?.();

    const finish = (exitCode, signal, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({
        ok: exitCode === 0 && !timedOut && !spawnError,
        exitCode,
        signal,
        timedOut,
        spawnError: spawnError ?? null,
        stdout,
        stderr,
        truncated,
        durationMs: Date.now() - startedAt,
        startedAt,
        finishedAt: Date.now(),
        command: [bin, ...args].join(' '),
      });
    };

    child.on('error', (error) => finish(null, null, error.message));
    child.on('close', (code, signal) => finish(code, signal, null));
  });
}

export async function readHugoVersion(hugoBin) {
  const result = await runCommand({ bin: hugoBin, args: ['version'], timeoutMs: 15_000 });
  if (!result.ok) return null;
  const line = result.stdout.trim().split('\n')[0] ?? '';
  const version = line.match(/v[\d.]+/)?.[0] ?? null;
  return { line, version, extended: /extended/.test(line) };
}
