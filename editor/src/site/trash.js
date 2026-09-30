// The trash: deletion as a reversible operation (P3.4).
//
// Deleting an article is the one content operation that cannot be expressed as a diff, so
// it is not implemented as `rm`. A deletion MOVES the file - or the whole bundle directory,
// resources included - into `.backups/trash/<id>/`, writes a manifest next to it, and can
// put it back byte for byte. Nothing in this module ever deletes anything.
//
// The move is a rename on the same filesystem (so a bundle with images costs nothing and
// cannot half-fail), with a copy-and-remove fallback only for EXDEV - the case of a mount
// boundary between the site and the editor's own directories.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function trashDir(backupRoot) {
  return join(backupRoot, 'trash');
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function uniqueId(root) {
  const base = stamp();
  let candidate = base;
  let counter = 1;
  while (existsSync(join(root, candidate))) {
    counter += 1;
    candidate = `${base}-${counter}`;
  }
  return candidate;
}

// Every file under a path, relative to it: a bundle is one deletion but many files, and
// the user is entitled to see the list before confirming.
export function listFiles(absPath, base = absPath) {
  const stat = statSync(absPath);
  if (!stat.isDirectory()) {
    return [{ absPath, relPath: relative(base, absPath).split(sep).join('/'), size: stat.size }];
  }

  const out = [];
  for (const entry of readdirSync(absPath, { withFileTypes: true })) {
    const child = join(absPath, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(child, base));
    else out.push({ absPath: child, relPath: relative(base, child).split(sep).join('/'), size: statSync(child).size });
  }
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

// Files and bytes, measured recursively.
export function measure(absPath) {
  const files = listFiles(absPath);
  return { files: files.length, bytes: files.reduce((total, file) => total + file.size, 0) };
}

export function relocate(from, to, { rename = renameSync } = {}) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    rename(from, to);
    return { method: 'rename' };
  } catch (error) {
    // Only a mount boundary justifies copying: a rename that fails inside one filesystem
    // is a real error and must not be papered over by a slower, partial copy.
    if (error.code !== 'EXDEV') throw error;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
    return { method: 'copy', reason: error.code };
  }
}

export class TrashEntryNotFoundError extends Error {
  constructor(id) {
    super(`trash entry not found: ${id}`);
    this.name = 'TrashEntryNotFoundError';
    this.id = id;
  }
}

// One trash entry can hold several paths, because one deletion sometimes is several paths.
//
// A file and a leaf bundle are a single path (the bundle directory carries its own resources
// with it). A BRANCH bundle is not: its page is the `_index.md` file of each language and its
// resources sit beside them, while the directory itself may hold child pages that must stay.
// Those are separate moves that belong to one deletion, so they share one entry, one
// manifest, and therefore one restore.
export function moveToTrash({ absPath = null, relPath = null, paths = null, backupRoot, reason = 'manual' }) {
  const requested = paths && paths.length > 0 ? paths : [{ absPath, relPath }];
  if (requested.some((item) => !item?.absPath || !item?.relPath)) {
    throw new Error('moveToTrash needs absPath+relPath, or paths: [{ absPath, relPath }]');
  }

  // Every source is checked before the first move: a delete must not start and then discover
  // that half of what it promised is missing.
  for (const item of requested) {
    if (!existsSync(item.absPath)) throw new Error(`nothing to delete: ${item.absPath}`);
  }

  const root = trashDir(backupRoot);
  mkdirSync(root, { recursive: true });
  const id = uniqueId(root);
  const entryDir = join(root, id);
  mkdirSync(join(entryDir, 'files'), { recursive: true });

  const moved = [];
  for (const item of requested) {
    const destination = join(entryDir, 'files', item.relPath);
    const kind = statSync(item.absPath).isDirectory() ? 'directory' : 'file';
    const { files, bytes } = measure(item.absPath);
    const { method } = relocate(item.absPath, destination);
    moved.push({ relPath: item.relPath, kind, files, bytes, transport: method });
  }

  const primary = moved[0];
  const manifest = {
    id,
    // The primary path is what the trash list shows; `entries` is the full truth.
    relPath: primary.relPath,
    kind: moved.length > 1 ? 'files' : primary.kind,
    reason,
    deletedAt: new Date().toISOString(),
    files: moved.reduce((total, item) => total + item.files, 0),
    bytes: moved.reduce((total, item) => total + item.bytes, 0),
    transport: primary.transport,
    entries: moved,
    restoredAt: null,
  };
  writeFileSync(join(entryDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return {
    ...manifest,
    entryDir,
    trashPath: join(entryDir, 'files', primary.relPath),
  };
}

export function readManifest(backupRoot, id) {
  const manifestPath = join(trashDir(backupRoot), id, 'manifest.json');
  if (!existsSync(manifestPath)) throw new TrashEntryNotFoundError(id);
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

export function listTrash({ backupRoot }) {
  const root = trashDir(backupRoot);
  if (!existsSync(root)) return [];

  const entries = [];
  for (const name of readdirSync(root)) {
    try {
      entries.push(readManifest(backupRoot, name));
    } catch {
      // A directory without a readable manifest is not a trash entry; ignore it rather
      // than failing the whole listing.
    }
  }
  return entries.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
}

// Where one trashed path goes back to. A Markdown document goes back through the write
// guard (that is where the "only .md is writable" rule lives); a directory and a non-Markdown
// resource go back through the removal guard, because a resource is moved, not written.
function restoreTarget({ guard, entry }) {
  if (entry.kind === 'file' && entry.relPath.endsWith('.md')) return guard.resolveForWrite(entry.relPath);
  return guard.resolveForRemoval(entry.relPath);
}

export function restoreFromTrash({ backupRoot, id, guard }) {
  const manifest = readManifest(backupRoot, id);
  if (manifest.restoredAt) throw new Error(`该条目已经恢复过（${manifest.restoredAt}）`);

  const filesRoot = join(trashDir(backupRoot), id, 'files');
  // Older entries (and every single-path delete) describe themselves without `entries`.
  const entries = manifest.entries ?? [{ relPath: manifest.relPath, kind: manifest.kind }];

  const planned = entries.map((entry) => {
    const source = resolve(filesRoot, entry.relPath);
    if (!source.startsWith(filesRoot) || isAbsolute(entry.relPath)) {
      throw new Error(`manifest path escapes the trash: ${entry.relPath}`);
    }
    if (!existsSync(source)) throw new Error(`回收站中已找不到该内容: ${entry.relPath}`);
    const target = restoreTarget({ guard, entry });
    if (existsSync(target)) throw new Error(`目标已存在，拒绝覆盖: ${entry.relPath}`);
    return { source, target };
  });

  // Everything is resolved and checked before anything moves: a restore that cannot finish
  // must not leave the content tree half-restored.
  for (const item of planned) relocate(item.source, item.target);

  const updated = { ...manifest, restoredAt: new Date().toISOString() };
  writeFileSync(
    join(trashDir(backupRoot), id, 'manifest.json'),
    `${JSON.stringify(updated, null, 2)}\n`,
    'utf8',
  );
  return updated;
}

export function trashRelativePath(backupRoot, manifest) {
  return relative(backupRoot, join(trashDir(backupRoot), manifest.id, 'files', manifest.relPath));
}
