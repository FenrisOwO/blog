// Watch the Hugo SOURCE tree so changes made outside the editor still reach the preview.
//
// Two mechanisms, and the reason there are two is worth stating plainly:
//
//   polling  - stat the source tree on an interval and diff a fingerprint. Works on every
//              filesystem. This is the GUARANTEE.
//   fs.watch - inotify-backed, near-instant. Only an ACCELERATOR: this project's site
//              lives on a v9fs (9p) mount where inotify delivers nothing at all, not even
//              for a single non-recursive directory. Polling is what actually works here.
//
// The other hard part is not looping: Hugo writes into the source tree on every build
// (`assets/jsconfig.json`, `resources/_gen/**`, `.hugo_build.lock`). Those are filtered
// out, and a window right after each build DEFERS events rather than dropping them, so a
// real edit made during that window still triggers a build.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { readdir as readdirAsync, stat as statAsync } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createLimiter } from '../util/pool.js';

export const DEFAULT_WATCH_ROOTS = ['content', 'config', 'layouts', 'static', 'assets', 'data', 'i18n'];
export const DEFAULT_POLL_MS = 1500;

// Roots that are large and almost never edited by hand (191 font chunks live in static/).
// They are still watched - a change there must still rebuild - but on a slower cadence,
// because stat-ing every one of them on every poll costs about a second on this mount, and
// that second is taken from the editor's own disk work: serving a page, listing documents,
// opening an article. Content, templates and config stay on the fast cadence.
const SLOW_ROOTS = new Set(['static', 'assets']);
const SLOW_POLL_EVERY = 4;

// Never watched: generated output, caches, the read-only theme, and our own artifacts.
const IGNORED_SEGMENTS = new Set(['public', 'resources', 'node_modules', '.git', '.backups', '.build', 'themes']);
const IGNORED_BASENAMES = new Set(['jsconfig.json', 'hugo_stats.json', 'hugo_build.lock']);
const IGNORED_SUFFIXES = ['.tmp', '~', '.swp', '.swx'];
// SafeWriter writes `.name.md.tmp-<pid>-<ts>` next to the target before renaming.
const TEMP_PATTERN = /\.tmp-\d+-\d+$/;

export function shouldIgnore(relPath) {
  if (typeof relPath !== 'string' || relPath === '') return true;
  const segments = relPath.split('/').filter(Boolean);
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return true;

  const base = segments[segments.length - 1] ?? '';
  if (base.startsWith('.')) return true;
  if (IGNORED_BASENAMES.has(base)) return true;
  if (TEMP_PATTERN.test(base)) return true;
  return IGNORED_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

// One pass over the source tree: path -> "mtime:size". Cheap enough (a few hundred stats
// on this site) to repeat on an interval.
export function scanTree(siteRoot, roots = DEFAULT_WATCH_ROOTS) {
  const fingerprint = new Map();

  function walkInto(absDir, relDir) {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (shouldIgnore(rel)) continue;
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        walkInto(abs, rel);
      } else if (entry.isFile()) {
        try {
          const stats = statSync(abs);
          fingerprint.set(rel, `${stats.mtimeMs}:${stats.size}`);
        } catch {
          // vanished between readdir and stat - the next scan will settle it
        }
      }
    }
  }

  for (const root of roots) {
    const abs = join(siteRoot, root);
    if (existsSync(abs)) walkInto(abs, root);
  }
  return fingerprint;
}

// The polling equivalent of scanTree(), for the interval. The synchronous version blocks
// the event loop for the whole walk - on this mount (~2ms per stat, ~450 files) that is
// roughly a second, every poll, during which the editor serves nothing: opening a site
// page in the preview stalled behind it. Same fingerprint, same semantics, no blocking.
//
// Every readdir and stat also goes through the limiter and is issued concurrently: await
// one syscall after another is what made a poll cost 155-460ms of the mount's latency on
// the fast roots (490-599ms with static/) every 1.5s, and that time is taken from the
// editor's own disk work - the same contention the synchronous walk caused, just spread
// out instead of blocking. A Map tolerates concurrent writers, and the fingerprint is a
// set of per-path signatures, so nothing here depends on the order files are visited in.
export async function scanTreeAsync(siteRoot, roots = DEFAULT_WATCH_ROOTS) {
  const fingerprint = new Map();
  await Promise.all(roots.map((root) => walkIntoAsync(join(siteRoot, root), root, fingerprint)));
  return fingerprint;
}

const SCAN_CONCURRENCY = 32;
const scanLimiter = createLimiter(SCAN_CONCURRENCY);

async function readdirOrNone(absDir) {
  try {
    return await scanLimiter.run(() => readdirAsync(absDir, { withFileTypes: true }));
  } catch {
    return [];
  }
}

async function walkIntoAsync(absDir, relDir, fingerprint) {
  const entries = await readdirOrNone(absDir);
  const files = [];
  const subdirs = [];

  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (shouldIgnore(rel)) continue;
    if (entry.isDirectory()) subdirs.push({ abs: join(absDir, entry.name), rel });
    else if (entry.isFile()) files.push({ abs: join(absDir, entry.name), rel });
  }

  await Promise.all(
    files.map(async ({ abs, rel }) => {
      try {
        const stats = await scanLimiter.run(() => statAsync(abs));
        fingerprint.set(rel, `${stats.mtimeMs}:${stats.size}`);
      } catch {
        // vanished between readdir and stat - the next scan will settle it
      }
    }),
  );

  await Promise.all(subdirs.map(({ abs, rel }) => walkIntoAsync(abs, rel, fingerprint)));
}

export function diffFingerprints(previous, next) {
  const changed = [];
  for (const [path, signature] of next) {
    if (previous.get(path) !== signature) changed.push(path);
  }
  for (const path of previous.keys()) {
    if (!next.has(path)) changed.push(path);
  }
  return changed.sort();
}

// Can this filesystem deliver inotify events at all? Answered by writing a file into a
// directory we already own (the editor's build area, same mount as the site) and seeing
// whether the watcher notices. Purely diagnostic - polling works either way.
export function probeNativeWatch({ probeDir }) {
  return new Promise((resolvePromise) => {
    const dir = resolve(probeDir);
    let watcher;
    let timer;
    let settled = false;

    const done = (supported) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        watcher?.close();
      } catch {
        // already gone
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
      resolvePromise(supported);
    };

    try {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      watcher = watch(dir, { recursive: true }, () => done(true));
      watcher.on('error', () => done(false));
    } catch {
      done(false);
      return;
    }

    // Give inotify a moment to register, then poke the directory.
    setTimeout(() => {
      try {
        writeFileSync(join(dir, 'probe.txt'), 'probe');
      } catch {
        done(false);
      }
    }, 60);

    timer = setTimeout(() => done(false), 600);
  });
}

export function createSourceWatcher({
  siteRoot,
  roots = DEFAULT_WATCH_ROOTS,
  pollMs = DEFAULT_POLL_MS,
  debounceMs = 500,
  onChange,
  onError,
  nativeWatch = true,
} = {}) {
  const pending = new Set();
  const nativeWatchers = [];
  let fingerprint = scanTree(siteRoot, roots);
  let pollTimer = null;
  let debounceTimer = null;
  let suppressedUntil = 0;
  let nativeEvents = 0;
  let closed = false;
  let polls = 0;

  function flush() {
    debounceTimer = null;
    if (closed || pending.size === 0) return;
    if (Date.now() < suppressedUntil) {
      scheduleFlush();
      return;
    }
    const paths = [...pending];
    pending.clear();
    try {
      onChange?.({ paths, at: Date.now() });
    } catch (error) {
      onError?.(error);
    }
  }

  function scheduleFlush() {
    if (debounceTimer) clearTimeout(debounceTimer);
    // Defer instead of drop, so a real edit during the post-build window is not lost.
    const wait = Math.max(debounceMs, suppressedUntil - Date.now() + 50);
    debounceTimer = setTimeout(flush, wait);
    debounceTimer.unref?.();
  }

  function mark(paths) {
    if (paths.length === 0) return;
    for (const path of paths) pending.add(path);
    scheduleFlush();
  }

  // "This change was ours, don't report it." Used right after the editor saves a file:
  // without it, the save-triggered build and the watcher both fire, and every save costs
  // two full Hugo builds. Called synchronously with the save, so no poll can interleave.
  function absorb(paths) {
    for (const path of paths) {
      pending.delete(path);
      const abs = join(siteRoot, path);
      try {
        const stats = statSync(abs);
        fingerprint.set(path, `${stats.mtimeMs}:${stats.size}`);
      } catch {
        fingerprint.delete(path);
      }
    }
  }

  let polling = false;
  let pollCount = 0;

  async function poll() {
    // On a slow mount one walk can outlast the interval; overlap would stack scans and
    // starve the server, so a poll in flight simply wins and the next tick waits.
    if (closed || polling) return;
    polling = true;
    polls += 1;
    pollCount += 1;
    try {
      const includeSlow = pollCount % SLOW_POLL_EVERY === 1;
      const scanned = includeSlow ? roots : roots.filter((root) => !SLOW_ROOTS.has(root));
      const fresh = await scanTreeAsync(siteRoot, scanned);

      // Roots we skipped keep their previous entries, so a skipped pass reports no change
      // for them instead of reporting every file in them as deleted.
      const next = new Map();
      if (!includeSlow) {
        for (const [path, signature] of fingerprint) {
          const root = path.slice(0, path.indexOf('/'));
          if (SLOW_ROOTS.has(root) && !scanned.includes(root)) next.set(path, signature);
        }
      }
      for (const [path, signature] of fresh) next.set(path, signature);

      const changed = diffFingerprints(fingerprint, next);
      fingerprint = next;
      mark(changed);
    } catch {
      // a failed walk must not stop the loop; the next poll retries
    } finally {
      polling = false;
    }
  }

  if (nativeWatch) {
    for (const root of roots) {
      const abs = join(siteRoot, root);
      if (!existsSync(abs)) continue;
      try {
        const watcher = watch(abs, { recursive: true }, (_eventType, filename) => {
          if (closed) return;
          const rel = filename ? `${root}/${String(filename).split('\\').join('/')}` : root;
          if (shouldIgnore(rel)) return;
          nativeEvents += 1;
          mark([rel]);
        });
        // On filesystems without inotify this simply never fires; polling covers it.
        watcher.on('error', () => {});
        nativeWatchers.push(watcher);
      } catch {
        // same: polling is the guarantee
      }
    }
  }

  pollTimer = setInterval(() => { void poll(); }, Math.max(200, pollMs));
  pollTimer.unref?.();

  return {
    roots,
    pollMs,
    isWatching: () => !closed && pollTimer !== null,
    // "watch+poll" means native watchers are registered (they may still be silent);
    // "poll" means polling is the only mechanism.
    strategy: () => (nativeWatchers.length > 0 ? 'watch+poll' : 'poll'),
    stats: () => ({ polls, nativeEvents, pending: pending.size, roots: roots.length }),
    scan: () => scanTree(siteRoot, roots),
    absorb,
    suppress(ms) {
      suppressedUntil = Math.max(suppressedUntil, Date.now() + ms);
    },
    close() {
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = null;
      for (const watcher of nativeWatchers) {
        try {
          watcher.close();
        } catch {
          // already gone
        }
      }
      nativeWatchers.length = 0;
      pending.clear();
    },
  };
}
