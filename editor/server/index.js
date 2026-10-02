// Local server for the editor (Phase 2).
//
// One process on port 1313 serves four things, which is what lets us reuse the port
// Docker already maps:
//
//   /api/...     content access (ContentReader + DocumentService) and build control
//   /editor/...  the Vue editor page (built into editor/dist)
//   /...         the Hugo preview, served from site/public
//
// The four layers stay distinct, and that distinction is the whole point of Phase 2:
//
//   SOURCE    site/content, site/config, site/layouts ...  canonical truth, edited here
//   BUILD     a Hugo process reading a mirror of SOURCE and writing into the build work
//             directory (never into site/); the mirror exists because reading ~950 small
//             files from the source mount costs ~8s per build and ~0.9s from local disk
//   OUTPUT    site/public  - only ever written by publishing a SUCCESSFUL build
//   PREVIEW   what the browser loads: the OUTPUT, via this server
//
// Of the whole API only POST /api/documents/save writes source files, it writes only
// through SafeWriter, and it refuses to run without `confirm: true`. Builds never write
// source files at all. The editor bundle lives outside site/, so it cannot end up in the
// Hugo output.

import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

import { createBuildService, createSourceWatcher, defaultBuildPaths, defaultHugoBin, probeNativeWatch, readHugoVersion } from '../src/build/index.js';
import { readSiteLanguages } from '../src/site/contentReader.js';
import { AssetNotFoundError, AssetValidationError, createAssetService } from '../src/site/assetService.js';
import { DocumentNotFoundError, createDocumentService } from '../src/site/documentService.js';
import { DocumentExistsError } from '../src/site/safeWrite.js';
import { TrashEntryNotFoundError } from '../src/site/trash.js';
import { ConfigFileNotFoundError } from '../src/settings/configGuard.js';
import { createSettingsService, SettingsValidationError } from '../src/settings/settingsService.js';
import { LinkModelError } from '../src/relations/linkModel.js';
import { RelationError, TagConflictError, createRelationService } from '../src/relations/relationService.js';
import { ChangeSetRejectedError, TransactionError } from '../src/relations/transaction.js';
import { ChangeSetError } from '../src/relations/changeSet.js';
import {
  GitCommandError,
  GitNotARepositoryError,
  GitUnknownCommitError,
  GitUnavailableError,
  GitValidationError,
  createGitService,
} from '../src/git/index.js';

const EDITOR_ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_BUILD_PATHS = defaultBuildPaths({ editorRoot: EDITOR_ROOT, siteRoot: join(EDITOR_ROOT, '..', 'site')});

// Oct. 10th:
// const DEFAULT_BUILD_PATHS = defaultBuildPaths({ editorRoot: EDITOR_ROOT, siteRoot: '/projects/site' });

// The sections this editor manages, in navigation order; '' is the content root, i.e. the
// home page and anything else sitting at the top level. Phase 1 wrote only to post/; Phase 3
// brings the site's real Markdown pages (content/page/*, taxonomy _index.md, the home page)
// into the same reviewed edit -> build -> preview loop, so the scope is now the whole tree.
export const EDITOR_SECTIONS = ['post', 'page', 'categories', ''];
export const CREATE_SECTIONS = ['post', 'page', 'categories'];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

const DEFAULTS = {
//  siteRoot: '/projects/site',
//  contentRoot: '/projects/site/content',
//  // Phase 5: the site's own Hugo config. Only the files already in there are writable, and
//  // only through the TOML engine.
//  configRoot: '/projects/site/config/_default',
  siteRoot: join(EDITOR_ROOT, '..', 'site'),
  contentRoot: join(EDITOR_ROOT, '..', 'site', 'content'),
  configRoot: join(EDITOR_ROOT, '..', 'site', 'config', '_default'),
  
  editorDist: join(EDITOR_ROOT, 'dist'),
  backupRoot: join(EDITOR_ROOT, '.backups'),
  section: 'post',
  sections: EDITOR_SECTIONS,
  createSections: CREATE_SECTIONS,
  // Optional override of the section -> type mapping (article / page / taxonomy). Left null
  // so the service derives it from the site's own config rather than from the editor's.
  contentKinds: null,
  port: 1314,
  host: '0.0.0.0',
  // Phase 2
  autoBuildOnSave: true,
  watchSources: true,
  buildSuppressMs: 1_500,
  watchPollMs: 1_500,
  requestLog: false,
  stagingDir: DEFAULT_BUILD_PATHS.stagingDir,
  sourceBuildDir: DEFAULT_BUILD_PATHS.sourceDir,
  cacheDir: DEFAULT_BUILD_PATHS.cacheDir,
  publishManifest: DEFAULT_BUILD_PATHS.publishManifest,
  publishDir: join('/projects/site', 'public'),
  hugoBin: defaultHugoBin(),
  buildTimeoutMs: 180_000,
  buildDebounceMs: 700,
  cleanDestination: false,
  // Phase 6: a deleted resource must also disappear from the preview. The publisher only
  // removes outputs it published itself, so this cannot delete anything hand-made.
  pruneOutputs: true,
  // Phase 8: the repository is read, never initialised. `gitBin` exists so a test can point
  // the service at a throwaway repository without touching the user's project.
  gitBin: 'git',
};

const MAX_BODY_BYTES = 4 * 1024 * 1024;
// A base64 upload carries 4/3 of the file's bytes, so the transport limit is larger than the
// asset limit the service enforces on the decoded bytes.
const MAX_ASSET_BODY_BYTES = 8 * 1024 * 1024;

function readJsonBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    request.on('error', reject);
  });
}

function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload, null, 2), MIME_TYPES['.json']);
}

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const abs = resolve(root, decoded.replace(/^\/+/, ''));
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

// Browser-facing caching for the preview. `no-store` on every asset was the single
// biggest reason a site page took seconds here: a Hugo page references ~47 font chunks,
// and with no caching at all every navigation re-downloaded ~2.5 MB. Hugo's own server
// serves the very same files in ~200 ms, so the preview must not be slower than the thing
// it is previewing.
//
// Rules:
//   * fingerprinted assets (style.min.<hash>.css, main.<hash>.js) can never change under
//     the same URL -> immutable, fetched once;
//   * everything else (site HTML, fonts, images, search index) revalidates with a cheap
//     304 instead of a full body: correct after every rebuild, fast on every reload;
//   * API responses stay uncached.
const IMMUTABLE = /[.-][0-9a-f]{8,}\.[a-z0-9]+$/i;

function cacheControlFor(abs) {
  if (IMMUTABLE.test(abs)) return 'public, max-age=31536000, immutable';
  // Site HTML, fonts, images: always revalidated, so a rebuild is visible immediately but
  // an unchanged file costs a 304 instead of its body.
  return 'no-cache';
}

function etagFor(stats) {
  return `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
}

function serveStatic(root, urlPath, req, res) {
  if (!root || !existsSync(root)) return false;

  let abs = safeJoin(root, urlPath);
  if (abs === null) {
    send(res, 403, 'forbidden');
    return true;
  }

  let stats = statSync(abs, { throwIfNoEntry: false });
  if (stats?.isDirectory()) {
    abs = join(abs, 'index.html');
    stats = statSync(abs, { throwIfNoEntry: false });
  }
  if (!stats?.isFile()) return false;

  const ext = extname(abs).toLowerCase();
  const etag = etagFor(stats);
  const headers = {
    'content-type': MIME_TYPES[ext] ?? 'application/octet-stream',
    'cache-control': cacheControlFor(abs),
    etag,
    'last-modified': new Date(stats.mtimeMs).toUTCString(),
  };

  const inm = req?.headers?.['if-none-match'];
  if (inm && inm.split(',').some((candidate) => candidate.trim() === etag)) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }

  headers['content-length'] = stats.size;
  res.writeHead(200, headers);
  // Streamed rather than readFileSync: a synchronous read of every asset serialises the
  // whole page on the main thread, which is what made 47 font chunks take seconds.
  createReadStream(abs)
    .on('error', () => res.destroy())
    .pipe(res);
  return true;
}

// The list endpoint stays metadata-only; raw text is fetched per document so the list
// response does not carry the whole content tree.
function publicDocument(doc) {
  return {
    id: doc.id,
    path: doc.path,
    kind: doc.kind,
    contentKind: doc.contentKind,
    section: doc.section,
    bundlePath: doc.bundlePath,
    fileName: doc.fileName,
    base: doc.base,
    language: doc.language,
    languageSuffix: doc.languageSuffix,
    translationKey: doc.translationKey,
    updatedAt: doc.updatedAt,
    size: doc.size,
    hasFrontMatter: doc.hasFrontMatter,
    frontMatterKeys: doc.frontMatterKeys,
    meta: doc.meta,
  };
}

export function createEditorServer(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const { languages, defaultLanguage } = readSiteLanguages({ siteRoot: config.siteRoot });
  const sitePublic = config.publishDir ?? join(config.siteRoot, 'public');

  // All Hugo-aware composition lives behind this service; the HTTP layer stays thin.
  const staticRoot = config.staticRoot ?? join(config.siteRoot, 'static');
  const assetRoot = config.assetRoot ?? join(config.siteRoot, 'assets');

  const service = createDocumentService({
    contentRoot: config.contentRoot,
    siteRoot: config.siteRoot,
    staticRoot,
    assetRoot,
    section: config.section,
    sections: config.sections,
    createSections: config.createSections,
    contentKinds: config.contentKinds,
    backupRoot: config.backupRoot,
  });

  // Phase 6: the same content walk, plus a byte layer for the images it owns. The asset
  // service borrows the document service's guard and trash rather than owning paths itself.
  const assetService =
    config.assetService ??
    createAssetService({
      siteRoot: config.siteRoot,
      contentRoot: config.contentRoot,
      staticRoot,
      assetRoot,
      backupRoot: config.backupRoot,
      guard: service.guard,
      documents: service,
      defaultLanguage: service.defaultLanguage,
      maxBytes: config.assetMaxBytes,
    });

  // Phase 7: tags and links across documents. The relation service borrows the document
  // service's walk, cache and guard, so a cross-document write can never reach a path a
  // single-document write could not.
  const relationService =
    config.relationService ??
    createRelationService({
      documentService: service,
      backupRoot: config.backupRoot,
    });

  // Phase 8: git is a *reader* of the tree the editor writes. It is deliberately not part of
  // the save transaction: a save writes the file, and the next status/diff notices it.
  const gitService =
    config.gitService ??
    createGitService({
      siteRoot: config.siteRoot,
      gitBin: config.gitBin,
    });

  const settingsService = createSettingsService({
    siteRoot: config.siteRoot,
    configRoot: config.configRoot,
    backupRoot: config.backupRoot,
    themeInfo: config.themeInfo ?? null,
  });

  const buildService =
    config.buildService ??
    createBuildService({
      siteRoot: config.siteRoot,
      sourceBuildDir: config.sourceBuildDir,
      stagingDir: config.stagingDir,
      cacheDir: config.cacheDir,
      publishDir: sitePublic,
      publishManifest: config.publishManifest,
      hugoBin: config.hugoBin,
      timeoutMs: config.buildTimeoutMs,
      debounceMs: config.buildDebounceMs,
      cleanDestination: config.cleanDestination,
      pruneOutputs: config.pruneOutputs,
    });

  let watcher = null;
  let lastSeenBuildNumber = 0;

  if (config.watchSources && !config.buildService) {
    watcher = createSourceWatcher({
      siteRoot: config.siteRoot,
      pollMs: config.watchPollMs,
      debounceMs: config.buildDebounceMs,
      onChange: () => buildService.scheduleBuild({ trigger: 'watch' }),
      onError: () => {},
    });
    // After each build, defer watcher events briefly: Hugo writes into the source tree
    // and those writes are not edits.
    buildService.subscribe((status) => {
      const build = status.lastBuild;
      if (build && build.buildNumber !== lastSeenBuildNumber) {
        lastSeenBuildNumber = build.buildNumber;
        watcher?.suppress(config.buildSuppressMs);
      }
    });
  }

  let hugoVersionPromise = null;
  const hugoVersion = () => {
    if (!hugoVersionPromise) hugoVersionPromise = readHugoVersion(config.hugoBin).catch(() => null);
    return hugoVersionPromise;
  };

  // Whether this filesystem can deliver inotify events at all. Answered by probing a
  // directory the editor owns (same mount as the site), because on v9fs/9p mounts the
  // native watcher registers successfully and then never fires - a failure mode that is
  // invisible unless you ask.
  let nativeWatchPromise = null;
  const nativeWatchSupported = () => {
    if (!nativeWatchPromise) {
      const probeDir = join(EDITOR_ROOT, '.build', 'watch-probe');
      nativeWatchPromise = probeNativeWatch({ probeDir }).catch(() => false);
    }
    return nativeWatchPromise;
  };

  // --- P7 request shapes ---------------------------------------------------
  // Two small adapters keep the HTTP layer thin: they turn a request body into the call the
  // relation service expects, and turn a plan into JSON that carries the whole change set except
  // the full before/after texts (which are large and belong on this side of the wire).

  async function planTagRequest(body) {
    const action = body.action ?? 'edit';
    if (action === 'edit') {
      return relationService.planTagEdit({ path: body.path, add: body.add ?? [], remove: body.remove ?? [], replace: body.replace ?? [] });
    }
    if (action === 'rename' || action === 'merge') {
      return relationService.planTagRename({ from: body.from, to: body.to, mode: action });
    }
    if (action === 'page') {
      return relationService.planTagPageCreate({ name: body.name, title: body.title ?? null, language: body.language ?? null, text: body.text ?? null });
    }
    throw new RelationError(`unknown tag action: ${action}`);
  }

  async function planLinksRequest(body) {
    if (typeof body.path !== 'string') throw new RelationError('path is required');
    return relationService.planLinkEdits({
      path: body.path,
      edit: body.edit ?? [],
      add: body.add ?? [],
      remove: body.remove ?? [],
      move: body.move ?? [],
    });
  }

  function publicChangeSetPlan(plan) {
    const { changeSet, review, ...rest } = plan;
    return {
      review,
      operation: changeSet.operation,
      counts: changeSet.counts,
      noop: changeSet.noop,
      text: changeSet.text,
      warnings: changeSet.warnings,
      unchanged: changeSet.unchanged,
      touched: changeSet.touched,
      changes: changeSet.changes.map((change) => ({
        kind: change.kind,
        relPath: change.relPath,
        toPath: change.toPath ?? null,
        location: change.location ?? null,
        note: change.note ?? null,
        diff: change.diff ?? null,
        diffText: change.diffText,
      })),
      ...rest,
    };
  }

  function apiError(res, error) {
    if (error instanceof DocumentNotFoundError || error instanceof TrashEntryNotFoundError) {
      sendJson(res, 404, { error: error.message, path: error.path });
      return;
    }
    if (error instanceof DocumentExistsError) {
      sendJson(res, 409, { error: error.message, path: error.path });
      return;
    }
    if (error instanceof SettingsValidationError) {
      sendJson(res, 400, { error: error.message, id: error.id ?? null });
      return;
    }
    if (error instanceof AssetNotFoundError) {
      sendJson(res, 404, { error: error.message, path: error.path });
      return;
    }
    if (error instanceof AssetValidationError) {
      // A refusal that is about *where* the file is is a 403, the same as everywhere else;
      // a refusal about the file itself (size, type, name) is the caller's 400.
      const forbidden = /只读|不可写|不在可写范围|outside/.test(error.message);
      sendJson(res, forbidden ? 403 : 400, {
        error: error.message,
        path: error.path ?? null,
        suggestion: error.suggestion ?? null,
      });
      return;
    }
    if (error instanceof ConfigFileNotFoundError) {
      sendJson(res, 404, { error: error.message, path: error.path });
      return;
    }
    if (error instanceof TagConflictError) {
      // 409, with the numbers the caller needs to offer a merge instead: a rename onto an
      // existing tag is a conflict the user has to resolve, never a silent overwrite.
      sendJson(res, 409, { error: error.message, conflict: error.details });
      return;
    }
    if (error instanceof ChangeSetRejectedError) {
      const forbidden = /不允许|outside|absolute path/.test(error.message);
      const exists = /目标已存在|已经恢复过/.test(error.message);
      sendJson(res, exists ? 409 : forbidden ? 403 : 400, { error: error.message, conflicts: error.conflicts ?? [] });
      return;
    }
    if (error instanceof TransactionError) {
      // A failed change set was rolled back; the message says whether that succeeded, so a
      // caller never has to guess at the state of the tree.
      sendJson(res, 500, { error: error.message, transaction: error.details });
      return;
    }
    if (error instanceof RelationError || error instanceof LinkModelError || error instanceof ChangeSetError) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    if (/outside|absolute path|only \.md|section root|empty path|delete outside/i.test(error.message)) {
      sendJson(res, 403, { error: error.message });
      return;
    }
    if (/already exists|目标已存在|已经恢复过/i.test(error.message)) {
      sendJson(res, 409, { error: error.message });
      return;
    }
    if (/invalid JSON body|too large/.test(error.message)) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    if (error instanceof GitValidationError) {
      // A path that escapes the site, or a missing message: the caller's mistake, and the
      // message says which one.
      const forbidden = /relative to the site root|escape the site root|must not start with/.test(error.message);
      sendJson(res, forbidden ? 403 : 400, { error: error.message });
      return;
    }
    if (error instanceof GitNotARepositoryError) {
      // Not an error state so much as a state: the UI shows 未初始化仓库 and offers no actions.
      sendJson(res, 409, { error: error.message, repository: null });
      return;
    }
    if (error instanceof GitUnavailableError) {
      sendJson(res, 503, { error: error.message });
      return;
    }
    if (error instanceof GitUnknownCommitError) {
      // A history row that has since been rewritten: the panel refreshes, it does not crash.
      sendJson(res, 409, { error: error.message, stderr: error.stderr });
      return;
    }
    if (error instanceof GitCommandError) {
      sendJson(res, 500, { error: error.message, stderr: error.stderr, args: error.args });
      return;
    }
    if (/unknown document kind|不能在该目录下新建|未知语言|无法从标题|只有 leaf bundle|unknown delete scope|回收站中/.test(error.message)) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    sendJson(res, 500, { error: error.message });
  }

  // Every write the editor makes itself closes the loop the same way: tell the watcher the
  // change was ours (otherwise it reports the same edit as an external one, and one save
  // costs two builds), then schedule the build. No-ops never get here.
  // Config saves close the same loop, but the paths are relative to the config directory
  // rather than to content/.
  function afterConfigWrite(relPaths) {
    if (!config.autoBuildOnSave) return false;
    watcher?.absorb(
      relPaths.map((file) => relative(config.siteRoot, join(config.configRoot, file)).split(sep).join('/')),
    );
    buildService.scheduleBuild({ trigger: 'settings' });
    return true;
  }

  function afterSourceWrite(relPaths) {
    if (!config.autoBuildOnSave) return false;
    watcher?.absorb(
      relPaths.map((path) => relative(config.siteRoot, join(config.contentRoot, path)).split(sep).join('/')),
    );
    buildService.scheduleBuild({ trigger: 'save' });
    return true;
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const { pathname } = url;

    if (config.requestLog) console.log(`[req] ${req.method} ${pathname}${url.search}`);

    if (pathname === '/api/health') {
      const status = buildService.getStatus();
      sendJson(res, 200, {
        ok: true,
        section: config.section,
        sections: service.sections,
        createSections: config.createSections,
        contentKinds: service.contentKinds,
        languages,
        defaultLanguage,
        build: { state: status.state, generation: status.generation },
      });
      return;
    }

    // Makes the source / build / output / preview split explicit instead of implicit.
    if (pathname === '/api/site') {
      const version = await hugoVersion();
      sendJson(res, 200, {
        siteRoot: config.siteRoot,
        contentRoot: config.contentRoot,
        section: config.section,
        sections: service.sections,
        createSections: config.createSections,
        contentKinds: service.contentKinds,
        languages,
        defaultLanguage,
        hugo: { bin: config.hugoBin, version: version?.version ?? null, extended: version?.extended ?? null },
        layers: {
          source: { path: config.siteRoot, role: 'canonical truth — the only thing edited' },
          build: {
            path: config.stagingDir,
            role: 'Hugo runs here; never inside site/',
            sourceMirror: config.sourceBuildDir ?? null,
            workRoot: config.sourceBuildDir ? dirname(config.sourceBuildDir) : null,
          },
          output: { path: sitePublic, role: 'published only after a successful build' },
          preview: { path: '/', role: 'this server serving the output' },
          config: {
            path: config.configRoot,
            role: 'Hugo site config; only existing .toml files, edited through the TOML engine',
            files: settingsService.guard.listFiles(),
          },
          backups: { path: config.backupRoot, role: 'pre-save copies, outside site/' },
          trash: { path: join(config.backupRoot, 'trash'), role: 'deleted documents, recoverable' },
          editor: { path: config.editorDist, role: 'editor bundle, outside site/' },
        },
        watching: Boolean(watcher?.isWatching()),
        watchedRoots: watcher?.roots ?? [],
        watch: watcher
          ? {
              strategy: watcher.strategy(),
              pollMs: watcher.pollMs,
              nativeWatchSupported: await nativeWatchSupported(),
              stats: watcher.stats(),
            }
          : null,
        autoBuildOnSave: config.autoBuildOnSave,
      });
      return;
    }

    if (pathname === '/api/build/status') {
      const status = buildService.getStatus();
      sendJson(res, 200, {
        ...status,
        autoBuildOnSave: config.autoBuildOnSave,
        watching: Boolean(watcher?.isWatching()),
        outputPath: sitePublic,
      });
      return;
    }

    // Runtime toggle for the save->build loop, so the checkbox in the UI is real.
    if (pathname === '/api/build/auto' && req.method === 'POST') {
      const body = await readJsonBody(req).catch(() => ({}));
      if (typeof body.onSave !== 'boolean') {
        sendJson(res, 400, { error: 'onSave must be a boolean' });
        return;
      }
      config.autoBuildOnSave = body.onSave;
      sendJson(res, 200, { autoBuildOnSave: config.autoBuildOnSave });
      return;
    }

    if (pathname === '/api/build' && req.method === 'POST') {
      const body = await readJsonBody(req).catch(() => ({}));
      buildService.build({ trigger: typeof body.trigger === 'string' ? body.trigger : 'manual' });
      sendJson(res, 202, { accepted: true, status: buildService.getStatus() });
      return;
    }

    if (pathname === '/api/documents') {
      const overview = await service.contentOverview();
      sendJson(res, 200, {
        section: config.section,
        sections: overview.sections,
        count: overview.documents.length,
        documents: overview.documents.map(publicDocument),
        resources: overview.resources,
        groups: overview.groups,
        warnings: overview.warnings,
      });
      return;
    }

    if (pathname === '/api/documents/raw') {
      // Only paths ContentReader already identified are readable, so this endpoint
      // cannot be used to read arbitrary files.
      const { doc, text } = service.read(url.searchParams.get('path') ?? '');
      sendJson(res, 200, {
        path: doc.path,
        kind: doc.kind,
        contentKind: doc.contentKind,
        section: doc.section,
        language: doc.language,
        translationKey: doc.translationKey,
        updatedAt: doc.updatedAt,
        text,
        frontMatterRaw: doc.frontMatterRaw,
        frontMatterKeys: doc.frontMatterKeys,
        meta: doc.meta,
      });
      return;
    }

    // Always a dry run, never writes.
    if (pathname === '/api/documents/preview' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (typeof body.path !== 'string' || typeof body.text !== 'string') {
        sendJson(res, 400, { error: 'path and text are required' });
        return;
      }
      sendJson(res, 200, service.previewEdit({ path: body.path, text: body.text }));
      return;
    }

    // The only path that writes a source file, gated on explicit in-band confirmation.
    if (pathname === '/api/documents/save' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.confirm !== true) {
        sendJson(res, 400, { error: 'explicit confirmation required: send { confirm: true }' });
        return;
      }
      if (typeof body.path !== 'string' || typeof body.text !== 'string') {
        sendJson(res, 400, { error: 'path and text are required' });
        return;
      }
      const result = service.saveEdit({ path: body.path, text: body.text });

      // Close the loop: a real save schedules a build. A no-op save changes nothing, so
      // it does not get one - that keeps "空操作保存" free of side effects.
      const scheduled = result.status !== 'noop' && afterSourceWrite([body.path]);
      sendJson(res, 200, { ...result, buildScheduled: scheduled });
      return;
    }

    // --- P3.2: the front-matter form ---------------------------------------
    // Same shape as the raw-text path: a separate dry run, and a write that needs confirm.

    if (pathname === '/api/documents/fields' && req.method === 'GET') {
      sendJson(res, 200, service.fields(url.searchParams.get('path') ?? ''));
      return;
    }

    if (pathname === '/api/documents/fields/preview' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (typeof body.path !== 'string') {
        sendJson(res, 400, { error: 'path is required' });
        return;
      }
      sendJson(res, 200, service.previewFields({ path: body.path, set: body.set, remove: body.remove }));
      return;
    }

    if (pathname === '/api/documents/fields/save' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.confirm !== true) {
        sendJson(res, 400, { error: 'explicit confirmation required: send { confirm: true }' });
        return;
      }
      if (typeof body.path !== 'string') {
        sendJson(res, 400, { error: 'path is required' });
        return;
      }
      const result = service.saveFields({ path: body.path, set: body.set, remove: body.remove });
      const scheduled = result.status !== 'noop' && afterSourceWrite([body.path]);
      sendJson(res, 200, { ...result, buildScheduled: scheduled });
      return;
    }

    // --- P3.3: creating a document -----------------------------------------
    // Without `confirm` this only plans: the caller sees the path, the collisions and the
    // text before anything exists on disk.

    if (pathname === '/api/documents/create' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const plan = service.planForCreate(body);
      if (body.confirm !== true) {
        sendJson(res, 200, { planned: true, ...plan });
        return;
      }
      if (plan.conflicts.length > 0) {
        sendJson(res, 409, { error: 'path already exists', conflicts: plan.conflicts, path: plan.path });
        return;
      }
      const created = service.createDocument(body);
      const scheduled = afterSourceWrite([created.path]);
      sendJson(res, 201, { ...created, buildScheduled: scheduled });
      return;
    }

    // --- P3.4: deleting a document -----------------------------------------
    // The plan lists every file that would move, so "delete the article" is never a
    // surprise about what an article turned out to include.

    if (pathname === '/api/documents/delete' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const request = { path: body.path, scope: body.scope ?? null };
      const plan = service.planForDelete(request);
      if (body.confirm !== true) {
        sendJson(res, 200, { planned: true, ...plan });
        return;
      }
      const result = service.removeDocument(request);
      const scheduled = afterSourceWrite(plan.files.map((file) => file.path));
      sendJson(res, 200, { ...result, buildScheduled: scheduled });
      return;
    }

    // --- P6: binary resources ----------------------------------------------
    // The same shape as every other write here: a plan the user can read, then a write behind
    // `confirm: true`. Bytes leave this process only through /api/assets/raw, and only for a
    // resource the service already listed and the guard allows.

    if (pathname === '/api/assets' && req.method === 'GET') {
      sendJson(res, 200, await assetService.listAssets());
      return;
    }

    if (pathname === '/api/assets/raw' && req.method === 'GET') {
      const result = await assetService.readBytes({
        location: url.searchParams.get('location') ?? 'content',
        path: url.searchParams.get('path') ?? '',
        ifNoneMatch: req.headers['if-none-match'] ?? null,
      });
      const headers = { etag: result.etag, 'cache-control': 'no-cache' };
      if (result.notModified) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      res.writeHead(200, { ...headers, 'content-type': result.mimeType, 'content-length': result.bytes.length });
      res.end(result.bytes);
      return;
    }

    if (pathname === '/api/assets/upload' && req.method === 'POST') {
      const body = await readJsonBody(req, MAX_ASSET_BODY_BYTES);
      const request = { bundlePath: body.bundlePath, filename: body.filename, dataBase64: body.dataBase64 };
      if (body.confirm !== true) {
        sendJson(res, 200, { planned: true, ...(await assetService.planUpload(request)) });
        return;
      }
      const result = await assetService.upload({ ...request, confirm: true });
      const scheduled = afterSourceWrite([result.path]);
      sendJson(res, 200, { ...result, buildScheduled: scheduled });
      return;
    }

    if (pathname === '/api/assets/replace' && req.method === 'POST') {
      const body = await readJsonBody(req, MAX_ASSET_BODY_BYTES);
      const request = { path: body.path, dataBase64: body.dataBase64 };
      if (body.confirm !== true) {
        sendJson(res, 200, { planned: true, ...(await assetService.planReplace(request)) });
        return;
      }
      const result = await assetService.replace({ ...request, confirm: true });
      const scheduled = result.status !== 'noop' && afterSourceWrite([result.path]);
      sendJson(res, 200, { ...result, buildScheduled: scheduled });
      return;
    }

    if (pathname === '/api/assets/delete' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const request = { path: body.path };
      const plan = await assetService.planRemove(request);
      if (body.confirm !== true) {
        sendJson(res, 200, { planned: true, ...plan });
        return;
      }
      const result = await assetService.remove({ ...request, confirm: true });
      const scheduled = afterSourceWrite([result.path]);
      sendJson(res, 200, { ...result, buildScheduled: scheduled });
      return;
    }

    // --- P7: cross-document relations (tags, links) -------------------------
    // A relation write is a *change set*: a plan that names every file it will touch, with the
    // diff for each and the read-back that will verify each one. Planning writes nothing.
    // Applying requires `confirm: true` and then re-derives the plan from the same request, so
    // what is committed is what the server computed a moment before - never a plan that
    // travelled through a client, and never a merge nobody asked for: a rename onto an existing
    // tag is refused with 409 and the numbers needed to offer a merge instead.

    if (pathname === '/api/tags' && req.method === 'GET') {
      sendJson(res, 200, await relationService.listTags());
      return;
    }

    if (pathname === '/api/tags/detail' && req.method === 'GET') {
      sendJson(res, 200, await relationService.tagDetail({
        name: url.searchParams.get('name') ?? '',
        language: url.searchParams.get('language') ?? null,
      }));
      return;
    }

    if (pathname === '/api/tags/plan' && req.method === 'POST') {
      const body = await readJsonBody(req);
      sendJson(res, 200, { planned: true, ...publicChangeSetPlan(await planTagRequest(body)) });
      return;
    }

    if (pathname === '/api/tags/apply' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.confirm !== true) {
        sendJson(res, 400, { error: 'explicit confirmation required: send { confirm: true }' });
        return;
      }
      const plan = await planTagRequest(body);
      const result = relationService.apply(plan);
      const scheduled = result.counts.total > 0 && afterSourceWrite(plan.changeSet.touched);
      sendJson(res, 200, { ...result, buildScheduled: scheduled });
      return;
    }

    if (pathname === '/api/links' && req.method === 'GET') {
      sendJson(res, 200, await relationService.links({ path: url.searchParams.get('path') ?? '' }));
      return;
    }

    if (pathname === '/api/links/plan' && req.method === 'POST') {
      const body = await readJsonBody(req);
      sendJson(res, 200, { planned: true, ...publicChangeSetPlan(await planLinksRequest(body)) });
      return;
    }

    if (pathname === '/api/links/apply' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.confirm !== true) {
        sendJson(res, 400, { error: 'explicit confirmation required: send { confirm: true }' });
        return;
      }
      const plan = await planLinksRequest(body);
      const result = relationService.apply(plan);
      const scheduled = result.counts.total > 0 && afterSourceWrite(plan.changeSet.touched);
      sendJson(res, 200, { ...result, buildScheduled: scheduled });
      return;
    }

    // --- P5: site settings (config/_default/*.toml) ------------------------
    // The same shape as every other write in this editor: a dry run the user can read, then a
    // write that requires `confirm: true`.

    if (pathname === '/api/settings' && req.method === 'GET') {
      const settings = settingsService.list();
      sendJson(res, 200, { ...settings, autoBuildOnSave: config.autoBuildOnSave });
      return;
    }

    if (pathname === '/api/settings/raw' && req.method === 'GET') {
      sendJson(res, 200, settingsService.raw(url.searchParams.get('file') ?? ''));
      return;
    }

    if (pathname === '/api/settings/preview' && req.method === 'POST') {
      const body = await readJsonBody(req);
      sendJson(res, 200, settingsService.preview({ set: body.set, menu: body.menu }));
      return;
    }

    if (pathname === '/api/settings/save' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.confirm !== true) {
        sendJson(res, 400, { error: 'explicit confirmation required: send { confirm: true }' });
        return;
      }
      const result = settingsService.save({ set: body.set, menu: body.menu });
      const scheduled = result.status !== 'noop' && afterConfigWrite(result.touched ?? []);
      sendJson(res, 200, { ...result, buildScheduled: scheduled });
      return;
    }

    if (pathname === '/api/trash' && req.method === 'GET') {
      sendJson(res, 200, { entries: service.trash() });
      return;
    }

    if (pathname === '/api/trash/restore' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.confirm !== true) {
        sendJson(res, 400, { error: 'explicit confirmation required: send { confirm: true }' });
        return;
      }
      if (typeof body.id !== 'string') {
        sendJson(res, 400, { error: 'id is required' });
        return;
      }
      const restored = service.restore({ id: body.id });
      const scheduled = afterSourceWrite([restored.relPath]);
      sendJson(res, 200, { ...restored, buildScheduled: scheduled });
      return;
    }

    // --- Phase 8: git ------------------------------------------------------
    // Read-only except for one commit, which needs `confirm: true` like every other write.
    if (pathname === '/api/git/status' && req.method === 'GET') {
      const paths = url.searchParams.getAll('path').filter((value) => value !== '');
      sendJson(res, 200, await gitService.status({ paths: paths.length > 0 ? paths : null }));
      return;
    }

    if (pathname === '/api/git/diff' && req.method === 'GET') {
      const path = url.searchParams.get('path');
      const staged = url.searchParams.get('staged') === 'true';
      sendJson(res, 200, await gitService.diff({ path: path || null, staged }));
      return;
    }

    if (pathname === '/api/git/log' && req.method === 'GET') {
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '30', 10);
      const path = url.searchParams.get('path');
      sendJson(res, 200, await gitService.log({ limit, path: path || null }));
      return;
    }

    if (pathname === '/api/git/show' && req.method === 'GET') {
      const sha = url.searchParams.get('sha');
      const path = url.searchParams.get('path');
      sendJson(res, 200, await gitService.show({ sha, path: path || null }));
      return;
    }

    if (pathname === '/api/git/commit' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.confirm !== true) {
        sendJson(res, 400, { error: 'explicit confirmation required: send { confirm: true }' });
        return;
      }
      // The commit is the only write. There is no reset, clean, checkout or force anywhere in
      // the git service, so this route cannot lose work: it only records what is on disk.
      const result = await gitService.commit({ message: body.message, paths: body.paths });
      sendJson(res, 200, {
        sha: result.sha,
        message: result.message,
        files: result.files,
        repository: result.repository,
        output: result.output,
      });
      return;
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'unknown API route', path: pathname });
      return;
    }

    if (pathname === '/editor' || pathname.startsWith('/editor/')) {
      const sub = pathname.replace(/^\/editor/, '') || '/';
      if (serveStatic(config.editorDist, sub, req, res)) return;
      send(res, 404, 'editor bundle not found — build it with: npm run build:web');
      return;
    }

    if (serveStatic(sitePublic, pathname, req, res)) return;
    send(res, 404, 'not found');
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => apiError(res, error));
  });

  // The UI polls build status while a build runs. Keeping connections warm past the
  // default 5s avoids the client racing a server-side idle-socket close mid-request,
  // which surfaces as a stray ECONNRESET in the browser's polling loop.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  // The editor's first request asks for site info, which reports the Hugo version and whether
  // native watching works here. Both cost a probe, neither is needed for correctness, and the
  // editor blocks on that request when it opens - so answer them while nothing is waiting.
  server.on('listening', () => {
    hugoVersion();
    if (watcher) nativeWatchSupported();
  });

  // A stale or missing output directory would make the preview 404 for no good reason.
  if (config.buildOnStart !== false && !existsSync(join(sitePublic, 'index.html'))) {
    buildService.scheduleBuild({ trigger: 'startup', delay: 0 });
  }

  server.on('close', () => {
    watcher?.close();
    buildService.stop?.();
  });

  return server;
}

export function startEditorServer(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const server = createEditorServer(config);
  return new Promise((resolvePromise) => {
    server.listen(config.port, config.host, () => {
      const scope = config.sections.map((name) => (name === '' ? '(content root)' : name)).join(', ');
      console.log(`Hugo Visual Editor (Phase 3) on http://${config.host}:${config.port}`);
      console.log('  editor page  : /editor/');
      console.log(`  source       : ${config.siteRoot}   (writable sections: ${scope})`);
      console.log(`  build        : ${config.hugoBin} -> ${config.stagingDir}`);
      console.log(`  output       : ${config.publishDir}   (published only after a successful build)`);
      console.log('  preview      : /');
      console.log(`  backups      : ${config.backupRoot}`);
      console.log(
        `  watch        : ${config.watchSources ? `on (poll ${config.watchPollMs}ms; native watch is only an accelerator)` : 'off'}`,
      );
      console.log(`  auto build   : on save = ${config.autoBuildOnSave}`);
      console.log(`  git          : ${config.gitBin} (read + commit of selected paths only; never init/reset/clean)`);
      resolvePromise(server);
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  startEditorServer();
}
