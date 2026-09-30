// Mirror the site into the build work directory before Hugo runs.
//
// Why: Hugo reads every content file, template, i18n file and static asset on its way through
// a build. On this machine's source mount each of those reads costs roughly 10-15ms of
// latency (measured: a build of this site spends ~5.5s waiting on the filesystem and ~2.7s
// computing, while the identical build from a local copy finishes in 0.86s). Copying the tree
// to a local directory first - in parallel, ~0.6s for ~480 files - moves that latency off the
// critical path of every single build.
//
// The mirror is rebuilt in full on each build rather than synced incrementally: finding what
// changed would mean stat-ing every source file, which is the latency we are avoiding, and a
// mirror that misses a change shows the user a stale preview. Copying a small tree is cheaper
// than being wrong about it.

import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

export const DEFAULT_MIRROR_CONCURRENCY = 32;
const ALWAYS_SKIP = ['.git', 'node_modules'];

async function listFiles(root, skip, dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return out;
    throw error;
  }

  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (skip.has(abs) || ALWAYS_SKIP.includes(entry.name)) continue;
    if (entry.isDirectory()) await listFiles(root, skip, abs, out);
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

async function listTargetFiles(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return out;
    throw error;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) await listTargetFiles(abs, out);
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

// Drop mirror files whose source is gone, so a deleted article cannot survive in the build.
async function removeStale(targetRoot, wanted, concurrency) {
  const existing = await listTargetFiles(targetRoot);
  const stale = existing.filter((file) => !wanted.has(relative(targetRoot, file)));
  await inPool(stale, concurrency, (file) => rm(file, { force: true }));
  return stale.length;
}

async function inPool(items, concurrency, work) {
  const width = Math.max(1, Math.min(concurrency, items.length || 1));
  let index = 0;
  const workers = Array.from({ length: width }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await work(item);
    }
  });
  await Promise.all(workers);
}

export async function mirrorSource({ from, to, skip = [], concurrency = DEFAULT_MIRROR_CONCURRENCY }) {
  const sourceRoot = resolve(from);
  const targetRoot = resolve(to);
  if (sourceRoot === targetRoot) throw new Error('mirrorSource: source and target are the same directory');

  const skipped = new Set([targetRoot, ...skip.filter(Boolean).map((entry) => resolve(entry))]);
  const files = await listFiles(sourceRoot, skipped, sourceRoot);
  const wanted = new Set(files.map((file) => relative(sourceRoot, file)));

  await mkdir(targetRoot, { recursive: true });
  let bytes = 0;
  await inPool(files, concurrency, async (file) => {
    const dest = join(targetRoot, relative(sourceRoot, file));
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(file, dest);
    bytes += (await stat(dest)).size;
  });

  const removed = await removeStale(targetRoot, wanted, concurrency);
  return { from: sourceRoot, to: targetRoot, files: files.length, bytes, removed };
}

// The mirror is a build artifact, so its directory can be cleared without consequence.
export async function clearMirror(dir) {
  await rm(dir, { recursive: true, force: true });
}
