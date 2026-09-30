// Cross-document relations: Tags and Links, and the change sets that carry them.
//
// This is the layer that turns "rename this tag" into "these eleven files, this one move, this
// warning about the metadata page - confirm or don't". It owns no security decisions (PathGuard
// does), no diffing (the change set does) and no writing (the transaction does); it owns the
// analysis, the plan, and the invalidation of what it changed.
//
// Cost: the tag index comes from the document walk the editor already performs, so opening the
// Tags view costs no extra reads. Only a *plan* reads files, and only the files it will change,
// through the same bounded pool the walks use.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { formatString } from '../frontmatter/patch.js';
import { joinDocument, splitDocument } from '../frontmatter/split.js';
import { rewriteInlineItems, rewriteScalarItems } from '../frontmatter/sequence.js';
import { parseFileName } from '../site/contentReader.js';
import { inPool } from '../util/pool.js';
import { createChangeSet } from './changeSet.js';
import { createTransaction } from './transaction.js';
import { buildTagIndex, normalizeTagIdentity, planTagListChanges, readTagSequence, suggestTagSlug, tagsOf, validateTagDirectoryName } from './tagModel.js';
import {
  LINK_KEYS,
  REQUIRED_LINK_KEYS,
  classifyLinkImage,
  planLinkEdits as planLinkItemEdits,
  readLinks,
  renderNewLinksBlock,
} from './linkModel.js';

export class TagConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'TagConflictError';
    this.details = details;
  }
}

export class RelationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RelationError';
  }
}

export const TERM_PAGE_PATTERN = /^_index(\.[A-Za-z0-9-]+)?\.md$/;

export function createRelationService({
  documentService,
  backupRoot = documentService.backupRoot,
  readConcurrency = 8,
  taxonomies = documentService.taxonomies ?? [],
}) {
  const guard = documentService.guard;
  // Which taxonomy holds TAGS. Renaming a tag may move a `tags/<term>/_index.md`, and a
  // `categories/Documentation/_index.md` is the same shape but a different object: it is Phase
  // 4's category page and a tag rename must never move it.
  const tagTaxonomy = taxonomies.includes('tags') ? 'tags' : (taxonomies[0] ?? null);

  // --- term pages (metadata pages) -----------------------------------------
  //
  // Hugo looks for a taxonomy term's page at `content/<taxonomy>/<term>/_index[_<lang>].md`.
  // This site has none, so this map is usually empty - and it is only ever read from the
  // taxonomy roots themselves, never by walking the whole content tree: a rename must not
  // depend on the editor being able to enumerate everything.
  function readTermPages(taxon = tagTaxonomy) {
    const pages = new Map(); // directory name -> { taxonomy, dir, term, files: [{ relPath, file, language }] }
    for (const taxonomy of taxon ? [taxon] : []) {
      const root = join(documentService.contentRoot, taxonomy);
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(root, entry.name);
        const files = readdirSync(dir, { withFileTypes: true })
          .filter((child) => child.isFile() && TERM_PAGE_PATTERN.test(child.name))
          .map((child) => {
            const parsed = parseFileName(child.name, {
              languages: documentService.languages,
              defaultLanguage: documentService.defaultLanguage,
            });
            return {
              relPath: `${taxonomy}/${entry.name}/${child.name}`,
              file: child.name,
              language: parsed.language,
            };
          })
          .sort((a, b) => a.relPath.localeCompare(b.relPath));
        if (files.length === 0) continue;
        pages.set(`${taxonomy}/${entry.name}`, {
          taxonomy,
          dir: entry.name,
          identity: normalizeTagIdentity(entry.name),
          writable: guard.isWritableTaxonomyPage(files[0].relPath),
          files,
        });
      }
    }
    return pages;
  }

  function termPagesFor(name) {
    const identity = normalizeTagIdentity(name);
    return [...readTermPages().values()].filter((page) => page.identity === identity);
  }

  async function readTexts(paths) {
    return inPool(paths, readConcurrency, async (path) => {
      const abs = join(documentService.contentRoot, path);
      return { path, text: existsSync(abs) ? readFileSync(abs, 'utf8') : null };
    });
  }

  function applyTagValues(text, values) {
    const parts = splitDocument(text);
    if (!parts.hasFrontMatter || parts.delimiter !== '---') {
      throw new RelationError('该文档没有 YAML front matter，标签编辑只支持 YAML front matter');
    }
    const sequence = readTagSequence(parts.frontMatterRaw);
    if (!sequence.present) throw new RelationError('该文档没有 tags 字段');

    const block = sequence.parsed.style === 'inline'
      ? rewriteInlineItems(sequence.block, sequence.parsed, values, { format: formatString })
      : rewriteScalarItems(sequence.block, sequence.parsed, values, { format: formatString });

    return joinDocument({
      frontMatterRaw: `${parts.frontMatterRaw.slice(0, sequence.entry.start)}${block}${parts.frontMatterRaw.slice(sequence.entry.end)}`,
      separator: parts.separator,
      bodyRaw: parts.bodyRaw,
    });
  }

  // --- tag browsing ---------------------------------------------------------

  // Every tag the site uses, with the documents and languages that use it, the spellings that
  // share its identity, and whether a metadata page exists. Purely a view over the walk.
  async function listTags() {
    const documents = await documentService.listDocuments();
    const tags = buildTagIndex(documents);
    const pages = readTermPages();

    const withPages = tags.map((tag) => {
      const matching = [...pages.values()].filter((page) => page.identity === tag.identity);
      return {
        ...tag,
        metadataPages: matching.flatMap((page) => page.files.map((file) => ({ ...file, taxonomy: page.taxonomy, term: page.dir, writable: page.writable }))),
        metadataPath: matching.length > 0 ? matching[0].files[0].relPath : null,
        directoryName: validateTagDirectoryName(tag.name).ok ? tag.name : suggestTagSlug(tag.name),
      };
    });

    // A term page whose tag nothing uses any more: an orphan the user should see rather than a
    // page the editor silently keeps.
    const orphans = [...pages.values()]
      .filter((page) => !tags.some((tag) => tag.identity === page.identity))
      .map((page) => ({
        name: page.dir,
        identity: page.identity,
        usage: 0,
        documents: [],
        languages: [],
        names: [{ name: page.dir, count: 0 }],
        conflicts: [],
        metadataPages: page.files.map((file) => ({ ...file, taxonomy: page.taxonomy, term: page.dir, writable: page.writable })),
        metadataPath: page.files[0].relPath,
        orphan: true,
      }));

    return {
      tags: [...withPages, ...orphans].sort((a, b) => b.usage - a.usage || a.name.localeCompare(b.name)),
      termPages: [...pages.values()],
      taxonomies,
      tagTaxonomy,
      warnings: [],
    };
  }

  async function tagDetail({ name, language = null }) {
    const documents = await documentService.listDocuments();
    const identity = normalizeTagIdentity(name);
    if (identity === '') throw new RelationError('标签名为空');

    const matching = documents.filter((document) => tagsOf(document).some((tag) => normalizeTagIdentity(tag) === identity));
    const filtered = language ? matching.filter((document) => document.language === language) : matching;
    const pages = termPagesFor(name);

    const groups = new Map();
    for (const document of filtered) {
      const key = document.translationKey ?? document.path;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({
        path: document.path,
        title: document.meta?.title ?? null,
        language: document.language,
        contentKind: document.contentKind,
        bundlePath: document.bundlePath,
        tag: tagsOf(document).find((tag) => normalizeTagIdentity(tag) === identity),
      });
    }

    return {
      name,
      identity,
      spellings: [...new Set(matching.flatMap((document) => tagsOf(document).filter((tag) => normalizeTagIdentity(tag) === identity)))],
      usage: filtered.length,
      languages: [...new Set(filtered.map((document) => document.language).filter(Boolean))].sort(),
      documents: filtered.map((document) => ({
        path: document.path,
        title: document.meta?.title ?? null,
        language: document.language,
        contentKind: document.contentKind,
        tag: tagsOf(document).find((tag) => normalizeTagIdentity(tag) === identity),
      })),
      groups: [...groups.entries()].map(([translationKey, members]) => ({ translationKey, members })),
      metadataPages: pages.flatMap((page) => page.files.map((file) => ({ ...file, term: page.dir, writable: page.writable }))),
      conflicts: [],
    };
  }

  // --- tag planning ---------------------------------------------------------

  // A tag edit inside one document (add / remove / replace), which is still a change set so
  // the UI path is the same as a site-wide rename and the dry run is identical.
  async function planTagEdit({ path, add = [], remove = [], replace = [] }) {
    const { text: before } = documentService.read(path);
    const sequence = readTagSequence(splitDocument(before).frontMatterRaw);
    if (!sequence.present) throw new RelationError('该文档没有 tags 字段');

    const plan = planTagListChanges(sequence.values, { add, remove, replace });
    const changeSet = createChangeSet({ operation: `编辑标签 ${path}` });
    if (plan.changed) changeSet.modify({ relPath: path, before, after: applyTagValues(before, plan.values) });
    else changeSet.unchanged({ relPath: path, reason: '标签已经是目标状态' });

    return buildPlan(changeSet, { applied: plan.applied, skipped: plan.skipped });
  }

  // Renaming or merging a tag across the whole site. `mode: 'merge'` is the only mode that may
  // have an existing destination - a rename that would land on a tag the site already uses is a
  // conflict, never a silent overwrite.
  async function planTagRename({ from, to, mode = 'rename' }) {
    const identity = normalizeTagIdentity(from);
    const targetIdentity = normalizeTagIdentity(to);
    if (identity === '') throw new RelationError('源标签名为空');
    if (targetIdentity === '') throw new RelationError('目标标签名为空');
    if (identity === targetIdentity && from === to) throw new RelationError('源标签与目标标签相同');

    const documents = await documentService.listDocuments();
    const affected = documents.filter((document) => tagsOf(document).some((tag) => normalizeTagIdentity(tag) === identity));
    if (affected.length === 0) throw new RelationError(`没有文档使用标签 ${from}`);

    const destinationInUse = documents.some((document) => tagsOf(document).some((tag) => normalizeTagIdentity(tag) === targetIdentity));
    const operation = destinationInUse || mode === 'merge' ? 'merge' : 'rename';
    if (destinationInUse && mode !== 'merge') {
      throw new TagConflictError(
        `目标标签 ${to} 已被 ${documents.filter((document) => tagsOf(document).some((tag) => normalizeTagIdentity(tag) === targetIdentity)).length} 个文档使用；重命名会造成合并，请显式选择合并`,
        { destination: to, destinationInUse: true, affected: affected.map((document) => document.path) },
      );
    }

    const changeSet = createChangeSet({
      operation: operation === 'merge' ? `合并标签 ${from} → ${to}` : `重命名标签 ${from} → ${to}`,
    });
    if (operation === 'merge') {
      changeSet.warn(`合并：${from} 的引用将改为 ${to}，同一文档中重复的标签行会被去掉`);
    }

    const texts = await readTexts(affected.map((document) => document.path));
    const readers = new Map(texts.map((entry) => [entry.path, entry.text]));
    for (const document of affected) {
      const before = readers.get(document.path);
      if (typeof before !== 'string') continue;
      const sequence = readTagSequence(splitDocument(before).frontMatterRaw);
      if (!sequence.present) {
        changeSet.warn(`${document.path} 的 front matter 无法定位 tags 字段，已跳过`);
        continue;
      }
      const plan = planTagListChanges(sequence.values, { replace: [{ from, to }] });
      if (!plan.changed) {
        changeSet.unchanged({ relPath: document.path, reason: '标签已经是目标状态' });
        continue;
      }
      changeSet.modify({
        relPath: document.path,
        before,
        after: applyTagValues(before, plan.values),
        note: `tags: ${from} → ${to}`,
      });
    }

    // The metadata pages: moved with a rename, deferred (and said so) on a merge.
    const destinationPages = termPagesFor(to);
    for (const page of termPagesFor(from)) {
      const reason = describeMoveBlock(page, destinationPages, to);
      if (reason) {
        changeSet.warn(`标签元数据页 ${page.dir}/ 未迁移：${reason}`);
        continue;
      }
      for (const file of page.files) {
        changeSet.move({
          from: file.relPath,
          to: `${page.taxonomy}/${to}/${file.file}`,
          location: 'taxonomy',
          note: `标签元数据页 ${page.dir} → ${to}`,
        });
      }
    }

    return buildPlan(changeSet, { affected: affected.map((document) => document.path), merge: operation === 'merge', destination: to });
  }

  function describeMoveBlock(page, destinationPages, to) {
    if (destinationPages.length > 0) {
      return `目标标签已经有元数据页（${destinationPages[0].files.map((file) => file.relPath).join(', ')}），元数据页合并本阶段暂不支持，需要手工处理`;
    }
    const check = validateTagDirectoryName(to);
    if (!check.ok) {
      return `目标标签名不能作为目录名（${check.reason}）；建议的 slug 是 ${suggestTagSlug(to) || '(空)'}`;
    }
    if (!page.writable) return '元数据页不在可写范围内';
    return null;
  }

  // Creating a term page is its own operation, never a side effect of assigning a tag: the
  // site deliberately has no `content/tags/`, and inventing pages for every tag would hand
  // Hugo a taxonomy the author did not ask for.
  async function planTagPageCreate({ name, title = null, text = null, language = null }) {
    const check = validateTagDirectoryName(name);
    if (!check.ok) throw new RelationError(`标签名不能作为目录名：${check.reason}`);
    const taxonomy = tagTaxonomy;
    if (!taxonomy) throw new RelationError('站点没有配置 tags taxonomy，无法创建元数据页');
    const suffix = language && language !== documentService.defaultLanguage ? `.${language}` : '';
    const relPath = `${taxonomy}/${name}/_index${suffix}.md`;
    const page = text ?? `---\ntitle: ${title ?? name}\n---\n`;

    const changeSet = createChangeSet({ operation: `创建标签元数据页 ${relPath}` });
    changeSet.create({ relPath, text: page });
    return buildPlan(changeSet, {});
  }

  // --- links ----------------------------------------------------------------

  async function links({ path }) {
    const { doc, text } = documentService.read(path);
    const frontMatterRaw = splitDocument(text).frontMatterRaw;
    const model = readLinks(frontMatterRaw);
    const resources = await documentService.listResources();
    const bundleResources = resources.filter((resource) => resource.bundlePath === doc.bundlePath || (doc.bundlePath === null && resource.path.startsWith(`${path.split('/').slice(0, -1).join('/')}/`)));

    return {
      path: doc.path,
      bundlePath: doc.bundlePath,
      present: model.present,
      style: model.style,
      items: model.items.map((item) => ({
        ...item,
        imageRef: classifyLinkImage(item.image, {
          resourceNames: bundleResources.map((resource) => resource.filename ?? resource.path.split('/').pop()),
          resourcePaths: bundleResources.map((resource) => resource.path),
        }),
      })),
      malformed: model.malformed,
      keyOrder: model.keyOrder,
      declaredKeys: LINK_KEYS,
      requiredKeys: REQUIRED_LINK_KEYS,
    };
  }

  async function planLinkEdits({ path, edit = [], add = [], remove = [], move = [] }) {
    const { text: before } = documentService.read(path);
    const parts = splitDocument(before);
    if (!parts.hasFrontMatter || parts.delimiter !== '---') {
      throw new RelationError('该文档没有 YAML front matter，links 编辑只支持 YAML front matter');
    }
    const model = readLinks(parts.frontMatterRaw);
    const changeSet = createChangeSet({ operation: `编辑链接 ${path}` });

    if (!model.present) {
      if (add.length === 0) throw new RelationError('该文档没有 links 字段，且没有要新增的链接');
      const block = renderNewLinksBlock(add, { itemIndent: '  ', fieldIndent: '    ', keyOrder: LINK_KEYS });
      // The block goes inside the front matter, immediately above the closing delimiter: the
      // delimiter is the last line of `frontMatterRaw`, and nothing may be written after it.
      const closerStart = parts.frontMatterRaw.lastIndexOf('\n') + 1;
      const head = parts.frontMatterRaw.slice(0, closerStart);
      const closer = parts.frontMatterRaw.slice(closerStart);
      const after = joinDocument({
        frontMatterRaw: `${head}${block}${closer}`,
        separator: parts.separator,
        bodyRaw: parts.bodyRaw,
      });
      changeSet.modify({ relPath: path, before, after, note: '新增 links 字段' });
      return buildPlan(changeSet, { created: ['links'], applied: add.map((item) => ({ action: 'add', title: item.title })), skipped: [] });
    }

    const result = planLinkItemEdits({ block: model.block, parsed: model.parsed, keyOrder: model.keyOrder, edit, add, remove, move });
    if (result.changed) {
      const after = joinDocument({
        frontMatterRaw: `${parts.frontMatterRaw.slice(0, model.entry.start)}${result.block}${parts.frontMatterRaw.slice(model.entry.end)}`,
        separator: parts.separator,
        bodyRaw: parts.bodyRaw,
      });
      changeSet.modify({ relPath: path, before, after, note: 'links 条目变更' });
    } else {
      changeSet.unchanged({ relPath: path, reason: 'links 已经是目标状态' });
    }

    return buildPlan(changeSet, { applied: result.applied, skipped: result.skipped, malformed: model.malformed });
  }

  // --- applying -------------------------------------------------------------

  function buildPlan(changeSet, extra = {}) {
    const built = changeSet.build();
    const transaction = createTransaction({ guard, backupRoot, reason: built.operation });
    const review = transaction.review(built);
    return { changeSet: built, review, ...extra };
  }

  function apply(plan) {
    const changeSet = plan.changeSet ?? plan;
    const transaction = createTransaction({ guard, backupRoot, reason: changeSet.operation });
    const result = transaction.commit(changeSet);
    documentService.invalidate(changeSet.touched);
    return { ...result, counts: changeSet.counts, applied_changes: changeSet.changes.map((change) => ({ kind: change.kind, relPath: change.relPath, toPath: change.toPath ?? null, diffText: change.diffText })) };
  }

  return {
    listTags,
    tagDetail,
    planTagEdit,
    planTagRename,
    planTagPageCreate,
    links,
    planLinkEdits,
    apply,
    // Exposed for tests and for the trash view: the metadata pages the site actually has.
    readTermPages,
  };
}
