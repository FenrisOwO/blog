// Performance harness for the editor (Phase Insert A).
//
// Everything here MEASURES; nothing here optimizes. Three independent views of the same
// system, because they disagree in interesting ways:
//
//   http   - what the browser actually waits for (network + server + disk, as observed)
//   index  - the server's own service calls, in-process, no HTTP in the way
//   hugo   - the build/publish chain, standalone, with no editor involved
//
// Usage:
//   node scripts/bench.mjs                 # http against http://127.0.0.1:1313 + hugo + index
//   node scripts/bench.mjs --http-only
//   node scripts/bench.mjs --runs 5 --base http://127.0.0.1:1313

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const ix = args.indexOf(name);
  return ix >= 0 && args[ix + 1] ? args[ix + 1] : fallback;
};

const BASE = value('--base', 'http://127.0.0.1:1313');
const RUNS = Number(value('--runs', '5'));
const EDITOR_ROOT = '/projects/editor';
const SITE_ROOT = '/projects/site';
const CONTENT_ROOT = join(SITE_ROOT, 'content');

const sections = { http: !flag('--index-only') && !flag('--hugo-only'), index: !flag('--http-only') && !flag('--hugo-only'), hugo: !flag('--http-only') && !flag('--index-only') };

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = sorted.reduce((sum, n) => sum + n, 0) / sorted.length;
  return { min: sorted[0], median, mean, max: sorted[sorted.length - 1] };
}

function row(label, samples, note = '') {
  const s = stats(samples);
  console.log(
    `  ${label.padEnd(34)} min ${s.min.toFixed(0).padStart(6)}  med ${s.median.toFixed(0).padStart(6)}  max ${s.max.toFixed(0).padStart(6)} ms   ${note}`,
  );
  return s;
}

async function timeRequest(path, { runs = RUNS } = {}) {
  const samples = [];
  let last = null;
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    const response = await fetch(`${BASE}${path}`, { headers: { 'cache-control': 'no-cache' } });
    const text = await response.text();
    samples.push(performance.now() - t0);
    last = { status: response.status, bytes: text.length, cacheControl: response.headers.get('cache-control'), type: response.headers.get('content-type') };
  }
  return { samples, last };
}

function human(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

// ---------------------------------------------------------------- HTTP

async function benchHttp() {
  console.log(`\n=== HTTP (${BASE}) — ${RUNS} runs each ===`);

  let overview = null;
  try {
    const first = await timeRequest('/api/documents', { runs: 1 });
    overview = JSON.parse(await (await fetch(`${BASE}/api/documents`)).text());
    console.log(`  payload: ${human(first.last.bytes)}, ${overview.count} documents, ${overview.resources?.length ?? 0} resources, cache-control: ${first.last.cacheControl}`);
  } catch (error) {
    console.log(`  server not reachable (${error.message}) — start it with: npm start`);
    return;
  }

  row('GET /editor/ (html+bundle)', (await timeRequest('/editor/')).samples);
  row('GET /api/site', (await timeRequest('/api/site')).samples);
  row('GET /api/documents', (await timeRequest('/api/documents')).samples, 'the list request');
  row('GET /api/build/status (trivial)', (await timeRequest('/api/build/status', { runs: 20 })).samples, 'event-loop stall probe');

  const sample = overview.documents[0];
  const a = overview.documents.find((d) => d.section === 'page' && d.kind === 'leaf-bundle') ?? sample;
  const b = overview.documents.find((d) => d.section === 'post' && d.kind === 'leaf-bundle') ?? sample;
  const c = overview.documents.find((d) => d.section === 'categories') ?? sample;
  const q = (p) => encodeURIComponent(p);

  row(`GET raw (${a.path.slice(0, 14)}…)`, (await timeRequest(`/api/documents/raw?path=${q(a.path)}`)).samples);
  row(`GET fields (${a.path.slice(0, 11)}…)`, (await timeRequest(`/api/documents/fields?path=${q(a.path)}`)).samples);
  row(`GET fields (${b.path.slice(0, 11)}…)`, (await timeRequest(`/api/documents/fields?path=${q(b.path)}`)).samples);
  row(`GET fields category`, (await timeRequest(`/api/documents/fields?path=${q(c.path)}`)).samples);
  row('GET /api/trash', (await timeRequest('/api/trash')).samples);

  // Fonts and preview assets are served from site/public through the same server: the
  // editor's own headers decide whether the browser can reuse them across reloads.
  const fonts = collectFontUrls();
  if (fonts.length) {
    console.log('  --- fonts / static assets ---');
    for (const url of fonts.slice(0, 8)) {
      const { samples, last } = await timeRequest(url, { runs: 3 });
      row(`${url.slice(0, 30)}`, samples, `${human(last.bytes)}  cache-control: ${last.cacheControl}`);
    }
  }
  const previewPage = await fetch(`${BASE}/`).then((r) => r.text());
  const css = [...previewPage.matchAll(/href="([^"]+\.css)"/g)].map((m) => m[1]);
  for (const href of css.slice(0, 3)) {
    const { samples, last } = await timeRequest(href, { runs: 3 });
    row(`css ${href.slice(0, 28)}`, samples, `${human(last.bytes)}  cache-control: ${last.cacheControl}`);
  }
}

// Which font files does the built site actually reference, and how big are they?
function collectFontUrls() {
  const urls = new Set();
  const candidates = [
    join(SITE_ROOT, 'public'),
  ];
  for (const root of candidates) {
    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true, recursive: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.(woff2?|ttf|otf)$/i.test(entry.name)) continue;
      const parent = entry.parentPath ?? entry.path ?? root;
      const rel = join(parent, entry.name).slice(root.length);
      urls.add(rel.split('\\').join('/'));
    }
  }
  return [...urls];
}

function fontInventory() {
  console.log('\n=== font inventory (from the source tree, not the built output) ===');
  const roots = [join(SITE_ROOT, 'static', 'fonts'), join(SITE_ROOT, 'themes')];
  const found = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true, recursive: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.(woff2?|ttf|otf)$/i.test(entry.name)) continue;
      const parent = entry.parentPath ?? entry.path ?? root;
      const abs = join(parent, entry.name);
      found.push({ abs, size: statSync(abs).size });
    }
  }
  found.sort((a, b) => b.size - a.size);
  let total = 0;
  for (const file of found) total += file.size;
  for (const file of found.slice(0, 12)) console.log(`  ${human(file.size).padStart(9)}  ${file.abs.replace(SITE_ROOT, '')}`);
  console.log(`  ${human(total).padStart(9)}  total (${found.length} files)`);
  return { total, count: found.length };
}

// ---------------------------------------------------------------- index (in-process)

async function benchIndex() {
  const { createDocumentService } = await import(`${EDITOR_ROOT}/src/site/documentService.js`);
  const { readSection } = await import(`${EDITOR_ROOT}/src/site/contentReader.js`);
  const { scanTree } = await import(`${EDITOR_ROOT}/src/build/watcher.js`);
  const { readSiteLanguages } = await import(`${EDITOR_ROOT}/src/site/contentReader.js`);

  const { languages, defaultLanguage } = readSiteLanguages({ siteRoot: SITE_ROOT });
  const scope = ['post', 'page', 'categories', ''];
  const service = createDocumentService({
    contentRoot: CONTENT_ROOT,
    siteRoot: SITE_ROOT,
    sections: scope,
    backupRoot: join(EDITOR_ROOT, '.backups'),
  });

  console.log('\n=== service layer (in-process) ===');
  row('contentOverview() cold-ish', [await timeIt(() => service.contentOverview())]);
  const repeat = async (times, fn) => {
    const samples = [];
    for (let i = 0; i < times; i += 1) samples.push(await timeIt(fn));
    return samples;
  };
  row('contentOverview() warm', await repeat(3, () => service.contentOverview()));
  row('listDocuments()', await repeat(3, () => service.listDocuments()));
  row('listSections()', await repeat(3, () => service.listSections()));
  row('listResources()', await repeat(3, () => service.listResources()));
  for (const section of scope) {
    row(`readSection('${section}')`, await repeat(2, () => readSection({ contentRoot: CONTENT_ROOT, section, languages, defaultLanguage })));
  }
  const one = (await service.listDocuments()).find((d) => d.kind === 'leaf-bundle');
  row('read(one doc)', await repeat(3, () => service.read(one.path)));
  row('fields(one doc)', await repeat(3, () => service.fields(one.path)));

  console.log('  --- raw IO floor (what a perfect implementation pays) ---');
  row('scanTree(site) [watcher]', await repeat(3, () => scanTree(SITE_ROOT)));
  const files = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith('.md')) files.push(abs);
    }
  })(CONTENT_ROOT);
  row(`read all ${files.length} md files`, await repeat(3, () => { for (const f of files) readFileSync(f, 'utf8'); }));
  row('stat all md files', await repeat(3, () => { for (const f of files) statSync(f); }));

  const { defaultBuildPaths: stagingPaths } = await import(`${EDITOR_ROOT}/src/build/index.js`);
  row(
    'scanTree(:work) [publish size]',
    await repeat(3, () => {
      try {
        scanTree(stagingPaths({ editorRoot: EDITOR_ROOT, siteRoot: SITE_ROOT }).stagingDir, ['.']);
      } catch {
        return 0;
      }
    }),
  );
}

async function timeIt(fn) {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

// ---------------------------------------------------------------- hugo

async function benchHugo() {
  const { createBuildService } = await import(`${EDITOR_ROOT}/src/build/buildService.js`);
  const { hugoArgs, defaultHugoBin } = await import(`${EDITOR_ROOT}/src/build/command.js`);
  const { runCommand } = await import(`${EDITOR_ROOT}/src/build/command.js`);

  const hugoBin = defaultHugoBin();
  const cacheDir = join(EDITOR_ROOT, '.build', 'cache');
  const scratch = join(EDITOR_ROOT, '.build', 'bench-staging');

  console.log('\n=== hugo ===');
  const version = await runCommand({ bin: hugoBin, args: ['version'], timeoutMs: 15_000 });
  console.log(`  ${version.stdout.trim()}`);

  // Direct: untouched site, warm cache, into a scratch destination.
  for (let i = 0; i < 3; i += 1) {
    const result = await runCommand({
      bin: hugoBin,
      args: hugoArgs({ siteRoot: SITE_ROOT, destination: scratch, cacheDir, cleanDestination: true }),
      cwd: SITE_ROOT,
      timeoutMs: 300_000,
    });
    console.log(`  direct hugo build            run ${i + 1}: ${result.durationMs.toFixed(0)} ms  ${result.ok ? '' : 'FAILED'}`);
  }

  const templated = await runCommand({
    bin: hugoBin,
    args: [...hugoArgs({ siteRoot: SITE_ROOT, destination: scratch, cacheDir, cleanDestination: true }), '--templateMetrics', '--templateMetricsHints'],
    cwd: SITE_ROOT,
    timeoutMs: 300_000,
  });
  console.log('  --- hugo --templateMetrics (top of the output) ---');
  for (const line of templated.stdout.split('\n').filter((l) => l.trim()).slice(0, 30)) console.log(`    ${line}`);

  // Through the editor's own service: build + publish (this is the save→preview chain,
  // minus the save).
  const { defaultBuildPaths } = await import(`${EDITOR_ROOT}/src/build/index.js`);
  const paths = defaultBuildPaths({ editorRoot: EDITOR_ROOT, siteRoot: SITE_ROOT });
  const buildService = createBuildService({
    siteRoot: SITE_ROOT,
    ...paths,
    cacheDir,
    publishDir: join(SITE_ROOT, 'public'),
    publishRoot: SITE_ROOT,
    hugoBin,
    autoBuildOnSave: false,
  });

  for (let i = 0; i < 2; i += 1) {
    const t0 = performance.now();
    const result = await buildService.build({ trigger: 'bench' });
    const total = performance.now() - t0;
    console.log(
      `  build + publish (service)    run ${i + 1}: ${total.toFixed(0)} ms` +
        `   mirror ${String(Math.round(result.mirrorMs ?? 0)).padStart(4)} ms` +
        `   hugo ${String(Math.round(result.hugoDurationMs ?? 0)).padStart(4)} ms` +
        `   publish ${String(Math.round(result.publishMs ?? 0)).padStart(4)} ms` +
        ` (${result.published?.files ?? '?'} files, ${result.published?.updated ?? '?'} rewritten)`,
    );
  }

  // What does the publish step alone cost? Measure the copy of staging -> public with the
  // same code path the service uses.
  const { publishDirectory } = await import(`${EDITOR_ROOT}/src/build/publisher.js`);
  const scratchOut = join(buildRootScratch(), 'public-copy');
  const copyMs = await timeIt(() => publishDirectory({ from: scratch, to: scratchOut, allowedRoot: EDITOR_ROOT, clean: true }));
  console.log(`  publishDirectory copy alone  : ${copyMs.toFixed(0)} ms`);
  rmSync(scratchOut, { recursive: true, force: true });
}

function buildRootScratch() {
  const dir = join(EDITOR_ROOT, '.build', 'bench-tmp');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------- main

const started = performance.now();
fontInventory();
if (sections.http) await benchHttp();
if (sections.index) await benchIndex();
if (sections.hugo) await benchHugo();
console.log(`\ntotal bench wall time: ${((performance.now() - started) / 1000).toFixed(1)} s`);
