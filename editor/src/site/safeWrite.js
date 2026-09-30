// Safe write path for content files.
//
// Every save goes through: path guard -> no-op guard -> optional dry-run preview ->
// timestamped backup -> atomic write (temp file + rename) -> read-back verification.
// The original file is never truncated in place, so an interrupted save cannot leave
// a half-written article behind.

import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function atomicWrite(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = join(dirname(filePath), `.${basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, filePath);
}

// Common prefix/suffix trim: enough for the minimal edits P1 performs, and it makes
// "how many lines changed" trivially checkable.
export function diffLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removed = a.slice(prefix, a.length - suffix);
  const added = b.slice(prefix, b.length - suffix);
  return { prefix, removed, added, changed: removed.length + added.length };
}

export function formatDiff(diff, relPath) {
  const lines = [`--- ${relPath} (original)`, `+++ ${relPath} (saved)`];
  for (const line of diff.removed) lines.push(`- ${line}`);
  for (const line of diff.added) lines.push(`+ ${line}`);
  return lines.join('\n');
}

export function createBackup(filePath, backupRoot, relPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(backupRoot, stamp, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(filePath, dest);
  return dest;
}

export function saveSafely({ guard, relPath, nextText, backupRoot, dryRun = false }) {
  const abs = guard.resolveForWrite(relPath);
  const exists = existsSync(abs);
  const before = exists ? readFileSync(abs, 'utf8') : null;

  if (exists && before === nextText) {
    return { status: 'noop', abs, relPath, backupPath: null, diff: null };
  }

  const diff = exists ? diffLines(before, nextText) : null;

  if (dryRun) {
    return { status: 'preview', abs, relPath, backupPath: null, diff };
  }

  const backupPath = exists ? createBackup(abs, backupRoot, relPath) : null;
  atomicWrite(abs, nextText);

  const after = readFileSync(abs, 'utf8');
  if (after !== nextText) {
    throw new Error(`write verification failed for ${relPath}`);
  }

  return { status: exists ? 'written' : 'created', abs, relPath, backupPath, diff };
}

export class DocumentExistsError extends Error {
  constructor(relPath) {
    super(`document already exists: ${relPath}`);
    this.name = 'DocumentExistsError';
    this.path = relPath;
  }
}

// Creation is deliberately stricter than save: it refuses to overwrite, so "new article"
// can never silently become "clobber an existing one". The guard has already proved the
// path is inside the writable roots and is Markdown.
export function createSafely({ guard, relPath, text, dryRun = false }) {
  const abs = guard.resolveForWrite(relPath);
  if (existsSync(abs)) throw new DocumentExistsError(relPath);

  if (dryRun) {
    return { status: 'preview', abs, relPath, bytes: Buffer.byteLength(text, 'utf8') };
  }

  atomicWrite(abs, text);

  const after = readFileSync(abs, 'utf8');
  if (after !== text) throw new Error(`write verification failed for ${relPath}`);

  return { status: 'created', abs, relPath, bytes: Buffer.byteLength(text, 'utf8') };
}
