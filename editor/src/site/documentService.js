// Application layer: turns an edit from the editor into a reviewed, safe, verified save.
//
// Layering it enforces:
//   editor core  -> produces text only, never knows a file path
//   Vue page     -> talks HTTP only, never touches the filesystem
//   this module  -> composes ContentReader + FrontMatterEngine + SafeWriter
//
// Preview and commit are deliberately separate calls. Preview is always a dry run, and
// commit is the only thing that writes - so "先 dry-run、用户确认后再保存" is expressed
// in the API shape rather than in UI discipline.
//
// Phase 3 adds three things on top of that shape, all through the same write path:
//   * the front-matter form  surgical field edits, never a YAML re-serialisation
//   * creating a document    path planned and shown before anything is written
//   * deleting a document    plan + trash, so every delete is reversible

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyFieldEdits, compareFrontMatter, describeFields, hasUnterminatedFrontMatter, missingFields, splitDocument } from '../frontmatter/index.js';

import {
  describeDocument,
  groupByTranslationKey,
  normalizeContentKinds,
  readSection,
  readSiteLanguages,
  readTaxonomies,
} from './contentReader.js';
import { DEFAULT_CREATE_SECTIONS, planCreate } from './documentCreate.js';
import { deleteDocument as deleteDocumentFile, planDelete } from './documentDelete.js';
import { PathGuard } from './paths.js';
import { DocumentExistsError, createSafely, diffLines, formatDiff, saveSafely } from './safeWrite.js';
import { listTrash, restoreFromTrash } from './trash.js';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export class DocumentNotFoundError extends Error {
  constructor(path) {
    super(`document not found: ${path}`);
    this.name = 'DocumentNotFoundError';
    this.path = path;
  }
}

// A raw save that would leave the front matter open. Hugo refuses to build such a file
// ("EOF looking for end YAML front matter delimiter") and the editor's own model then reads it
// as a document with no front matter, so it is always damage, never an edit.
export class UnterminatedFrontMatterError extends Error {
  constructor(path) {
    super('front matter 缺少结尾的 ---，Hugo 无法解析这个文件；保存已取消，没有写入任何字节');
    this.name = 'UnterminatedFrontMatterError';
    this.path = path;
  }
}

function summarizeDiff(diff) {
  return { added: diff.added.length, removed: diff.removed.length, changed: diff.changed };
}

// The scope is a list of content sections; '' means the content root, i.e. everything.
// The default is still the Phase 1 value (post only), so nothing that was narrow becomes
// wide by accident - the server opts in explicitly.
function normalizeScope(sections) {
  const list = (Array.isArray(sections) ? sections : [sections]).filter((value) => typeof value === 'string');
  return [...new Set(list.length > 0 ? list : ['post'])];
}

export function createDocumentService({
  contentRoot,
  siteRoot,
  section = 'post',
  sections = null,
  backupRoot,
  createSections = DEFAULT_CREATE_SECTIONS,
  contentKinds = null,
  // Phase 6: the site's non-content trees. The guard resolves reads inside them (the asset
  // browser shows them), but they are never writable here - see resolveSiteAssetForRead.
  staticRoot = join(siteRoot, 'static'),
  assetRoot = join(siteRoot, 'assets'),
  // Phase 7: the taxonomy roots whose term pages (`<taxonomy>/<term>/_index.md`) a tag rename
  // has to be able to move. Read from the site's own config unless the caller knows better.
  taxonomies = null,
}) {
  const { languages, defaultLanguage } = readSiteLanguages({ siteRoot });
  const scope = normalizeScope(sections ?? [section]);
  const taxonomyNames = taxonomies ?? readTaxonomies({ siteRoot });
  const guard = new PathGuard({ contentRoot, writableRoots: scope, staticRoot, assetRoot, taxonomies: taxonomyNames });

  // What a section MEANS (article / page / category / other). Taxonomy names come from the
  // site's own config, so a term page is recognised as a category because Hugo says so, not
  // because the editor keeps a list of known category names.
  const kinds = normalizeContentKinds({
    taxonomy: contentKinds?.taxonomy ?? taxonomyNames,
    ...(contentKinds ?? {}),
  });

  // Descriptions of individual documents, keyed by path and validated against the file's own
  // mtime:size. Reusing a description skips re-reading and re-parsing that file, which is
  // where most of a listing's cost sits on this mount.
  //
  // Correctness rests on two things. An edit made outside the editor is caught by the
  // signature changing, so a listing is never further than one stat from the truth. An edit
  // made through this service drops that file's entry outright, which covers the one case a
  // signature cannot see: a rewrite of the same byte count inside the same clock tick.
  // Structural writes (create, delete, restore) drop the whole cache, since they move
  // resources around under paths the caller never named.
  const descriptions = new Map();
  const forget = (...paths) => {
    for (const path of paths) {
      if (typeof path === 'string') descriptions.delete(path);
    }
  };

  // One walk of the content tree per call. Everything below - documents, resources, section
  // counts, translation groups, warnings - is derived from that single pass, because asking
  // each of them to walk separately (as GET /api/documents used to) read all 49 Markdown
  // files five times over, and that was most of the multi-second wait when opening the
  // editor. Descriptions that are still valid are served from the cache above, so a walk with
  // nothing new to see is a few dozen stats rather than half a second of file reads.
  // Async because the walk reads the filesystem in parallel: on this mount a listing spends
  // its whole time on per-file latency, so the sections are read concurrently rather than one
  // after another (see contentReader.js).
  async function walkContent() {
    const results = await Promise.all(
      scope.map((name) =>
        readSection({
          contentRoot,
          section: name,
          languages,
          defaultLanguage,
          kinds,
          cache: descriptions,
          // Phase 6: a resource in a writable section is replaceable/deletable; anywhere else
          // it is listed and read-only. The reader asks; the guard decides.
          writableAssets: (relPath) => guard.isWritableAsset(relPath),
        }),
      ),
    );
    return new Map(scope.map((name, index) => [name, results[index]]));
  }

  function documentsIn(byName) {
    const byPath = new Map();
    for (const name of scope) {
      for (const doc of byName.get(name)?.documents ?? []) byPath.set(doc.path, doc);
    }
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  // Counts per section, in the order the scope declares - so the navigation order is a
  // configuration decision rather than something the UI has to hardcode. The content root
  // is listed last, because it is a place, not a section.
  function sectionsIn(documents) {
    const counts = new Map();
    for (const doc of documents) counts.set(doc.section, (counts.get(doc.section) ?? 0) + 1);

    const named = [...counts.keys()].filter((name) => name !== '').sort();
    const ordered = [];
    for (const name of scope) {
      if (name === '') continue;
      if (!ordered.includes(name)) ordered.push(name);
    }
    for (const name of named) if (!ordered.includes(name)) ordered.push(name);
    if (counts.has('')) ordered.push('');

    return ordered
      .filter((name) => counts.has(name))
      .map((name) => ({ section: name, label: name === '' ? '(根)' : name, count: counts.get(name) }));
  }

  function resourcesIn(byName) {
    const byPath = new Map();
    for (const name of scope) {
      for (const resource of byName.get(name)?.resources ?? []) byPath.set(resource.path, resource);
    }
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  async function listDocuments() {
    return documentsIn(await walkContent());
  }

  async function listSections() {
    return sectionsIn(await listDocuments());
  }

  async function listResources() {
    return resourcesIn(await walkContent());
  }

  // One document by path. This deliberately does NOT list the tree first: the walk exists to
  // enumerate, and enumerating every file to open one of them is what made opening an
  // article take most of a second. Everything the descriptor needs is in the path itself.
  function locate(path) {
    // Anything that is not a known in-scope document is a 404, exactly as when the path was
    // matched against a listing - a path escaping the content root must not turn into a 403
    // and leak that it exists.
    try {
      guard.resolveForRead(path);
    } catch {
      throw new DocumentNotFoundError(path);
    }
    if (!guard.isWritable(path)) throw new DocumentNotFoundError(path);

    const doc = describeDocument({ contentRoot, relPath: path, languages, defaultLanguage, kinds, cache: descriptions });
    if (!doc) throw new DocumentNotFoundError(path);
    return doc;
  }

  // One call for the list view: documents, resources, translation groups and any warning
  // about a scope entry that does not exist on disk - all from the same walk.
  async function contentOverview() {
    const byName = await walkContent();
    const documents = documentsIn(byName);
    return {
      sections: sectionsIn(documents),
      documents,
      resources: resourcesIn(byName),
      groups: groupByTranslationKey(documents),
      contentKinds: kinds,
      warnings: scope
        .filter((name) => name !== '')
        .flatMap((name) => byName.get(name)?.warnings ?? []),
    };
  }

  function read(path) {
    const doc = locate(path);
    return { doc, text: readFileSync(join(contentRoot, doc.path), 'utf8') };
  }

  // Always a dry run: computes the diff and the front matter report, writes nothing.
  function previewEdit({ path, text }) {
    const { doc, text: originalText } = read(path);
    const diff = diffLines(originalText, text);
    const frontMatter = compareFrontMatter(originalText, text);

    const warnings = [];
    // An open-but-never-closed front matter is not "the front matter will be removed" - the
    // document is not parseable at all, and saveEdit refuses it. Say which one it is.
    const unterminated = splitDocument(originalText).hasFrontMatter && hasUnterminatedFrontMatter(text);
    if (unterminated) {
      warnings.push('front matter 有开始没有结尾（Hugo 会报 EOF），保存会被拒绝');
    } else if (frontMatter.hasFrontMatter.original && !frontMatter.hasFrontMatter.target) {
      warnings.push('front matter 将被移除');
    }
    if (frontMatter.unknownChangedKeys.length > 0) {
      warnings.push(`未知字段将被修改: ${frontMatter.unknownChangedKeys.join(', ')}`);
    }

    return {
      path,
      status: originalText === text ? 'noop' : 'preview',
      kind: doc.kind,
      contentKind: doc.contentKind,
      language: doc.language,
      section: doc.section,
      diff: summarizeDiff(diff),
      diffText: formatDiff(diff, path),
      frontMatter,
      shaBefore: sha256(originalText),
      warnings,
    };
  }

  // The only write path. SafeWriter supplies the path whitelist, the backup, the atomic
  // write, the no-op guard and the read-back check.
  function saveEdit({ path, text }) {
    const { text: originalText } = read(path);
    // The raw path writes whatever the editor buffer holds, which is the point (the raw text
    // stays the source of truth) - except when the buffer lost the closing delimiter, because
    // that is not an edit the user can mean: it is a file Hugo cannot parse.
    if (splitDocument(originalText).hasFrontMatter && hasUnterminatedFrontMatter(text)) {
      throw new UnterminatedFrontMatterError(path);
    }
    const result = saveSafely({ guard, relPath: path, nextText: text, backupRoot, dryRun: false });
    forget(path);
    const onDisk = readFileSync(join(contentRoot, path), 'utf8');

    return {
      path,
      status: result.status,
      backupPath: result.backupPath,
      diff: result.diff ? summarizeDiff(result.diff) : null,
      diffText: result.diff ? formatDiff(result.diff, path) : null,
      shaBefore: sha256(originalText),
      shaAfter: sha256(onDisk),
      onDiskMatchesTarget: onDisk === text,
    };
  }

  // Re-read from disk and compare, so the UI can confirm editor == disk after a save.
  function verify(path, text) {
    const { text: originalText } = read(path);
    return { path, matches: originalText === text, sha: sha256(originalText) };
  }

  // --- P3.2: the front-matter form -----------------------------------------

  function describeEditable(text) {
    const parts = splitDocument(text);
    const { fields: descriptors } = describeFields(parts.frontMatterRaw);
    return {
      delimiter: parts.delimiter,
      hasFrontMatter: parts.hasFrontMatter,
      // The form refuses anything it cannot rewrite losslessly (TOML front matter, or a
      // document with no front matter at all), and says so instead of failing at save time.
      editable: parts.hasFrontMatter && parts.delimiter === '---',
      reason: !parts.hasFrontMatter
        ? '该文档没有 front matter'
        : parts.delimiter === '---'
          ? null
          : `表单只编辑 YAML front matter（当前分隔符 ${parts.delimiter}）`,
      frontMatterRaw: parts.frontMatterRaw,
      fields: descriptors,
      missing: missingFields(parts.frontMatterRaw),
      bodyBytes: Buffer.byteLength(parts.bodyRaw, 'utf8'),
    };
  }

  function fields(path) {
    const { doc, text } = read(path);
    return {
      path: doc.path,
      kind: doc.kind,
      contentKind: doc.contentKind,
      section: doc.section,
      language: doc.language,
      translationKey: doc.translationKey,
      updatedAt: doc.updatedAt,
      ...describeEditable(text),
    };
  }

  // Dry run, exactly like previewEdit: the field edits are computed, shown, and discarded.
  function previewFields({ path, set = {}, remove = [] }) {
    const { text } = read(path);
    const result = applyFieldEdits(text, { set, remove });
    const diff = diffLines(text, result.text);
    const before = splitDocument(text);
    const after = splitDocument(result.text);

    const warnings = [];
    for (const entry of result.applied.filter((item) => item.action === 'create')) {
      warnings.push(`将新增字段 ${entry.path}`);
    }
    for (const entry of result.applied.filter((item) => item.action === 'remove')) {
      warnings.push(`将删除字段 ${entry.path}`);
    }
    for (const entry of result.skipped) warnings.push(`${entry.path} 未应用：${entry.reason}`);

    return {
      path,
      status: result.changed ? 'preview' : 'noop',
      changed: result.changed,
      applied: result.applied,
      skipped: result.skipped,
      diff: summarizeDiff(diff),
      diffText: formatDiff(diff, path),
      // The form never touches the body; proving that here means a bug in the field layer
      // cannot silently eat an article.
      bodyUnchanged: before.bodyRaw === after.bodyRaw,
      frontMatterChanged: before.frontMatterRaw !== after.frontMatterRaw,
      shaBefore: sha256(text),
      shaAfter: sha256(result.text),
      warnings,
    };
  }

  function saveFields({ path, set = {}, remove = [] }) {
    const { text } = read(path);
    const result = applyFieldEdits(text, { set, remove });

    if (!result.changed) {
      return {
        path,
        status: 'noop',
        applied: result.applied,
        skipped: result.skipped,
        saved: null,
        fields: fields(path),
      };
    }

    // Same write path as a raw text save: backup, atomic write, read-back check.
    const saved = saveEdit({ path, text: result.text });
    return { path, status: saved.status, applied: result.applied, skipped: result.skipped, saved, fields: fields(path) };
  }

  // --- P3.3: creating a document -------------------------------------------

  function planForCreate(input = {}) {
    return planCreate({
      guard,
      section: input.section ?? createSections[0],
      kind: input.kind ?? 'standalone',
      title: input.title ?? null,
      base: input.base ?? null,
      language: input.language ?? defaultLanguage,
      defaultLanguage,
      languages,
      sections: createSections,
      contentKinds: kinds,
      today: input.today ?? null,
    });
  }

  function createDocument(input = {}) {
    const plan = planForCreate(input);
    if (plan.conflicts.length > 0) throw new DocumentExistsError(plan.path);

    const result = createSafely({
      guard,
      relPath: plan.path,
      text: input.text ?? plan.text,
      dryRun: input.dryRun === true,
    });
    if (result.status === 'created') forget(plan.path);
    return { ...plan, created: result.status === 'created', bytes: result.bytes };
  }

  // --- P3.4: deleting a document -------------------------------------------

  function planForDelete({ path, scope: deleteScope = null }) {
    return planDelete({ guard, doc: locate(path), scope: deleteScope });
  }

  function removeDocument({ path, scope: deleteScope = null }) {
    const result = deleteDocumentFile({ guard, doc: locate(path), scope: deleteScope, backupRoot });
    descriptions.clear();
    return result;
  }

  // Phase 7: a cross-document write names the paths it touched, so the cache can drop exactly
  // those descriptions instead of everything.
  function invalidate(paths = null) {
    if (paths === null) descriptions.clear();
    else forget(...paths);
  }

  function trash() {
    return listTrash({ backupRoot });
  }

  function restore({ id }) {
    const result = restoreFromTrash({ backupRoot, id, guard });
    descriptions.clear();
    return result;
  }

  return {
    contentRoot,
    sections: scope,
    section,
    createSections,
    contentKinds: kinds,
    backupRoot,
    languages,
    defaultLanguage,
    guard,
    taxonomies: taxonomyNames,
    listDocuments,
    listSections,
    listResources,
    contentOverview,
    read,
    previewEdit,
    saveEdit,
    verify,
    fields,
    previewFields,
    saveFields,
    planForCreate,
    createDocument,
    planForDelete,
    removeDocument,
    invalidate,
    trash,
    restore,
  };
}
