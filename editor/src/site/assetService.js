// Application layer for binary resources: list, preview, upload, replace, delete, restore.
//
// It composes what Phase 1-5 already built rather than copying it:
//
//   PathGuard       every path in and out (resolveAssetForWrite / resolveSiteAssetForRead)
//   bytes.js        digests, content sniffing, byte-exact atomic writes
//   safeWrite.js    the backup every overwrite takes first
//   trash.js        deletion as a reversible move (one entry per deletion)
//   documentService the content walk that already knows which bundle owns what
//
// Every operation has the shape the rest of the editor uses: a plan the user can read (dry
// run, nothing written), then a write that requires explicit confirmation. No listing reads a
// binary: size and extension come from a stat, and bytes are touched only for a preview, an
// upload, a replace, or a delete that has to move them.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { ASSET_MAX_BYTES, UPLOAD_EXTENSIONS, atomicWriteBytes, formatBytes, mimeForExtension, sha256Bytes, sniffBytes } from './bytes.js';
import { describeSiteAsset, suggestAvailableName, validateAssetFileName } from './resourceModel.js';
import { bundleOfDocument, classifyReference } from './referenceModel.js';
import { createBackup } from './safeWrite.js';
import { moveToTrash } from './trash.js';

export class AssetValidationError extends Error {
  constructor(message, { path = null, suggestion = null } = {}) {
    super(message);
    this.name = 'AssetValidationError';
    this.path = path;
    this.suggestion = suggestion;
  }
}

export class AssetNotFoundError extends Error {
  constructor(path) {
    super(`asset not found: ${path}`);
    this.name = 'AssetNotFoundError';
    this.path = path;
  }
}

function toPosix(value) {
  return String(value ?? '').split(sep).join('/');
}

// A resource URL the browser may load. Built in one place, so no UI code ever assembles a
// filesystem path into a request.
export function assetPreviewUrl({ location = 'content', path }) {
  return `/api/assets/raw?location=${encodeURIComponent(location)}&path=${encodeURIComponent(path)}`;
}

function withPreviewUrl(asset) {
  return { ...asset, previewUrl: asset.capabilities.preview ? assetPreviewUrl(asset) : null };
}

function walkFilesSync(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const abs = join(current, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) out.push(abs);
    }
  }
  return out;
}

export function createAssetService({
  siteRoot,
  contentRoot,
  staticRoot = null,
  assetRoot = null,
  publishDir = null,
  backupRoot,
  guard,
  documents,
  defaultLanguage = null,
  maxBytes = ASSET_MAX_BYTES,
  backupAssets = true,
}) {
  const bundleKey = (bundlePath) => (bundlePath === '' ? '(root)' : String(bundlePath));

  function decodePayload(dataBase64) {
    if (typeof dataBase64 !== 'string' || dataBase64.trim() === '') {
      throw new AssetValidationError('缺少文件内容');
    }
    const approximate = Math.floor((dataBase64.length * 3) / 4);
    if (approximate > maxBytes) {
      throw new AssetValidationError(`文件过大：约 ${formatBytes(approximate)}，上限 ${formatBytes(maxBytes)}`);
    }
    const bytes = Buffer.from(dataBase64, 'base64');
    if (bytes.length === 0) throw new AssetValidationError('文件内容为空');
    if (bytes.length > maxBytes) {
      throw new AssetValidationError(`文件过大：${formatBytes(bytes.length)}，上限 ${formatBytes(maxBytes)}`);
    }
    return bytes;
  }

  // The name and the bytes have to agree, and both have to be something this phase accepts.
  // Renaming an executable to `.png` fails here, before anything is written.
  function validateIncoming({ filename, bytes }) {
    const check = validateAssetFileName(filename);
    if (!check.ok) throw new AssetValidationError(check.reason);
    if (!UPLOAD_EXTENSIONS.has(check.extension)) {
      throw new AssetValidationError(`本阶段不支持写入 ${check.extension} 文件（支持：${[...UPLOAD_EXTENSIONS].join(' ')}）`);
    }
    const sniff = sniffBytes(bytes);
    if (!sniff) throw new AssetValidationError(`${filename} 不是可识别的图片或 PDF 内容`);
    if (!sniff.extensions.includes(check.extension)) {
      throw new AssetValidationError(
        `文件内容看起来是 ${sniff.mime}，与扩展名 ${check.extension} 不符（允许：${sniff.extensions.join(', ')}）`,
      );
    }
    return { extension: check.extension, sniff, sha256: sha256Bytes(bytes) };
  }

  // --- discovery ----------------------------------------------------------

  // static/ and assets/ are mirrored into the same model, read-only. They are listed so the
  // boundary is visible in the UI, not so they can be edited: replacing a font the theme
  // loads has no back-reference to check, and that lifecycle is deferred (see the report).
  async function siteAssets(location, root) {
    if (!root || !existsSync(root)) return [];
    const base = resolve(root);
    const described = await Promise.all(
      walkFilesSync(base).map(async (abs) => {
        const info = await stat(abs);
        if (!info.isFile()) return null;
        const path = toPosix(abs.slice(base.length + 1));
        return withPreviewUrl(describeSiteAsset({ location, path, size: info.size, mtimeMs: info.mtimeMs }));
      }),
    );
    return described.filter(Boolean).sort((a, b) => a.path.localeCompare(b.path));
  }

  // Content resources come from the walk the document list already performs, grouped by the
  // bundle that owns them - a resource without its page is a file without a meaning.
  async function listAssets() {
    const listed = await documents.listDocuments();
    const resources = await documents.listResources();

    const bundles = new Map();
    const ensureBundle = (bundlePath, seed = {}) => {
      const key = bundleKey(bundlePath);
      if (!bundles.has(key)) {
        bundles.set(key, {
          bundlePath,
          kind: seed.kind ?? seed.bundleKind ?? null,
          contentKind: seed.contentKind ?? null,
          section: seed.section ?? null,
          documentPath: null,
          documents: [],
          resources: [],
          canUpload: false,
          uploadBlockedReason: null,
        });
      }
      return bundles.get(key);
    };

    for (const doc of listed) {
      if (doc.kind !== 'leaf-bundle' && doc.kind !== 'branch-bundle') continue;
      if (doc.bundlePath === null || doc.bundlePath === undefined) continue;
      const bundle = ensureBundle(doc.bundlePath, doc);
      bundle.documents.push({ path: doc.path, language: doc.language, title: doc.meta?.title ?? null });
    }

    for (const resource of resources) {
      const bundle = ensureBundle(resource.bundlePath, resource);
      bundle.resources.push(withPreviewUrl(resource));
    }

    for (const bundle of bundles.values()) {
      bundle.documents.sort((a, b) => a.path.localeCompare(b.path));
      bundle.resources.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      // The page a resource is shown against is the default language's document, so opening it
      // from the asset list lands on a readable page rather than an arbitrary translation.
      bundle.documentPath =
        bundle.documents.find((doc) => doc.language === defaultLanguage)?.path ?? bundle.documents[0]?.path ?? null;
      // Uploads are flat into a bundle directory. The content root is not a bundle: its
      // "resources" would be site-wide content files, a separate decision (deferred).
      if (bundle.bundlePath === '' || bundle.bundlePath === null) {
        bundle.uploadBlockedReason = '内容根目录不是 bundle，本阶段不支持上传到此处';
      } else if (!guard.isWritableAsset(`${bundle.bundlePath}/probe.png`)) {
        bundle.uploadBlockedReason = `该 bundle 不在可写范围内（${bundle.bundlePath}）`;
      } else {
        bundle.canUpload = true;
      }
    }

    const content = [...bundles.values()].sort((a, b) => String(a.bundlePath).localeCompare(String(b.bundlePath)));
    const staticAssets = await siteAssets('static', staticRoot);
    const pipelineAssets = await siteAssets('assets', assetRoot);
    const allContentResources = content.flatMap((bundle) => bundle.resources);

    return {
      bundles: content,
      static: staticAssets,
      assets: pipelineAssets,
      summary: {
        bundles: content.length,
        contentResources: allContentResources.length,
        staticFiles: staticAssets.length,
        pipelineFiles: pipelineAssets.length,
        replaceable: allContentResources.filter((asset) => asset.capabilities.replace).length,
        referenced: allContentResources.filter((asset) => asset.referenced).length,
        totalBytes: [...allContentResources, ...staticAssets, ...pipelineAssets].reduce(
          (total, asset) => total + (asset.size ?? 0),
          0,
        ),
      },
      limits: { maxUploadBytes: maxBytes, uploadExtensions: [...UPLOAD_EXTENSIONS] },
    };
  }

  async function findContentAsset(path) {
    const resources = await documents.listResources();
    return resources.find((resource) => resource.path === path) ?? null;
  }

  async function findSiteAsset({ location, path }) {
    const list = await siteAssets(location, location === 'static' ? staticRoot : assetRoot);
    return list.find((asset) => asset.path === path) ?? null;
  }

  async function describe({ location = 'content', path }) {
    const asset = location === 'content' ? await findContentAsset(path) : await findSiteAsset({ location, path });
    if (!asset) throw new AssetNotFoundError(path);
    return withPreviewUrl(asset);
  }

  // The bytes the browser may see. The path goes through the guard for its location, and the
  // resource must be one the editor already listed - this endpoint cannot be pointed at an
  // arbitrary file, and there is deliberately no `readFile(userPath)` behind it.
  async function readBytes({ location = 'content', path, ifNoneMatch = null }) {
    const asset = await describe({ location, path });
    if (!asset.capabilities.preview) {
      throw new AssetValidationError(`${asset.filename} 无法在浏览器中预览（${asset.mimeType ?? '未知类型'}）`, { path });
    }
    const abs =
      location === 'content' ? guard.resolveAssetForRead(path) : guard.resolveSiteAssetForRead({ location, relPath: path });
    const info = statSync(abs);
    if (!info.isFile()) throw new AssetNotFoundError(path);
    const etag = `"${info.size}-${Math.round(info.mtimeMs)}"`;
    if (ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch === `W/${etag}`)) return { notModified: true, etag, asset };

    const bytes = readFileSync(abs);
    const sniff = sniffBytes(bytes);
    return {
      notModified: false,
      asset,
      bytes,
      etag,
      mimeType: sniff?.mime ?? mimeForExtension(asset.extension) ?? 'application/octet-stream',
    };
  }

  async function bundleTargets() {
    const listing = await listAssets();
    return listing.bundles.map((bundle) => ({
      bundlePath: bundle.bundlePath,
      kind: bundle.kind,
      contentKind: bundle.contentKind,
      section: bundle.section,
      documentPath: bundle.documentPath,
      canUpload: bundle.canUpload,
      reason: bundle.uploadBlockedReason,
      resourceCount: bundle.resources.length,
    }));
  }

  function resolveUploadTarget({ bundlePath, filename }) {
    if (typeof bundlePath !== 'string') throw new AssetValidationError('缺少目标 bundle');
    if (bundlePath === '') {
      throw new AssetValidationError('内容根目录不是 bundle，无法上传到此处；请把图片放进某个 bundle，或放进 static/ 后用 /路径 引用');
    }
    const check = validateAssetFileName(filename);
    if (!check.ok) throw new AssetValidationError(check.reason);
    const targetPath = toPosix(`${bundlePath}/${filename}`);
    return { targetPath, abs: guard.resolveAssetForWrite(targetPath), check };
  }

  // --- upload -------------------------------------------------------------

  async function planUpload({ bundlePath, filename, size = null }) {
    const { targetPath, abs, check } = resolveUploadTarget({ bundlePath, filename });
    const bundle = (await bundleTargets()).find((entry) => entry.bundlePath === bundlePath);
    if (!bundle) throw new AssetValidationError(`找不到目标 bundle: ${bundlePath}`);
    if (!bundle.canUpload) throw new AssetValidationError(bundle.reason ?? `不能写入 ${bundlePath}`);

    const extensionAccepted = UPLOAD_EXTENSIONS.has(check.extension);
    const exists = existsSync(abs);
    const taken = (await documents.listResources())
      .filter((resource) => String(resource.path).startsWith(`${bundlePath}/`))
      .map((resource) => resource.filename);

    return {
      status: 'preview',
      bundlePath,
      targetPath,
      filename,
      size,
      exists,
      extension: check.extension,
      extensionAccepted,
      extensionReason: extensionAccepted
        ? null
        : `本阶段不支持写入 ${check.extension} 文件（支持：${[...UPLOAD_EXTENSIONS].join(' ')}）`,
      suggestion: exists ? suggestAvailableName(filename, taken) : null,
      canWrite: extensionAccepted && !exists,
      warnings: exists ? [`${targetPath} 已存在；请改名，或对已有文件使用「替换」，编辑器不会默认覆盖`] : [],
      confirmHint: `将新建 ${targetPath}`,
    };
  }

  async function upload({ bundlePath, filename, dataBase64, confirm = false }) {
    const plan = await planUpload({ bundlePath, filename });
    if (!plan.extensionAccepted) throw new AssetValidationError(plan.extensionReason);
    // A dry run reports the collision (`exists: true`, a suggestion) rather than refusing it:
    // only a confirmed write is refused. Same shape as replace and remove below.
    if (confirm !== true) return { ...plan, status: 'awaiting-confirmation' };
    if (plan.exists) {
      throw new AssetValidationError(`${plan.targetPath} 已存在；建议使用 ${plan.suggestion}`, {
        path: plan.targetPath,
        suggestion: plan.suggestion,
      });
    }

    const bytes = decodePayload(dataBase64);
    const validated = validateIncoming({ filename, bytes });
    const { abs, targetPath } = resolveUploadTarget({ bundlePath, filename });
    if (existsSync(abs)) throw new AssetValidationError(`${targetPath} 在确认后出现了，拒绝覆盖`, { path: targetPath });

    atomicWriteBytes(abs, bytes);
    const sha256 = sha256Bytes(readFileSync(abs));
    if (sha256 !== validated.sha256) throw new Error(`写入校验失败：${targetPath}`);

    return {
      status: 'created',
      path: targetPath,
      filename,
      bytes: bytes.length,
      sha256,
      mimeType: validated.sniff.mime,
      asset: await describe({ path: targetPath }),
      confirmHint: `已写入 ${targetPath}`,
    };
  }

  // --- replace ------------------------------------------------------------

  async function planReplace({ path, size = null }) {
    const asset = await findContentAsset(path);
    if (!asset) throw new AssetNotFoundError(path);
    if (!asset.capabilities.replace) throw new AssetValidationError(`${path} 不可替换（只读资源）`, { path });
    const abs = guard.resolveAssetForWrite(path);
    const shaBefore = sha256Bytes(readFileSync(abs));
    return {
      status: 'preview',
      path,
      filename: asset.filename,
      extension: asset.extension,
      currentSize: asset.size,
      nextSize: size,
      shaBefore,
      referenced: asset.referenced,
      referencedBy: asset.referencedBy,
      warnings: asset.referenced
        ? [`该资源被 ${asset.referencedBy.length} 个文档引用；替换保持路径不变，引用继续有效`]
        : [],
      confirmHint: `将用新内容替换 ${path}（写入前先备份）`,
    };
  }

  async function replace({ path, dataBase64, confirm = false }) {
    const plan = await planReplace({ path });
    if (confirm !== true) return { ...plan, status: 'awaiting-confirmation' };

    const bytes = decodePayload(dataBase64);
    const validated = validateIncoming({ filename: plan.filename, bytes });
    if (validated.sha256 === plan.shaBefore) {
      // A no-op replace must not touch the disk: no backup of an identical file, no rewrite.
      return { ...plan, status: 'noop', asset: await describe({ path }) };
    }

    const abs = guard.resolveAssetForWrite(path);
    const backupPath = backupAssets ? createBackup(abs, backupRoot, path) : null;
    atomicWriteBytes(abs, bytes);
    const shaAfter = sha256Bytes(readFileSync(abs));
    if (shaAfter !== validated.sha256) throw new Error(`替换校验失败：${path}`);

    return {
      status: 'replaced',
      path,
      backupPath,
      bytes: bytes.length,
      shaBefore: plan.shaBefore,
      shaAfter,
      mimeType: validated.sniff.mime,
      asset: await describe({ path }),
      confirmHint: `已替换 ${path}`,
    };
  }

  // --- delete / restore ---------------------------------------------------

  async function planRemove({ path }) {
    const asset = await findContentAsset(path);
    if (!asset) throw new AssetNotFoundError(path);
    if (!asset.capabilities.delete) throw new AssetValidationError(`${path} 不可删除（只读资源）`, { path });
    const abs = guard.resolveAssetForRemoval(path);
    if (!existsSync(abs)) throw new AssetNotFoundError(path);

    const warnings = [];
    if (asset.referenced) {
      warnings.push(
        `该资源可能被 ${asset.referencedBy.length} 个文档引用（${asset.referencedBy.join(', ')}）；删除会留下失效引用，本阶段不会自动改写 Markdown`,
      );
    }

    return {
      status: 'preview',
      path,
      filename: asset.filename,
      bundlePath: asset.bundlePath,
      ownerDocument: asset.ownerDocument,
      files: [{ path, size: asset.size }],
      totalFiles: 1,
      totalBytes: asset.size ?? 0,
      referenced: asset.referenced,
      referencedBy: asset.referencedBy,
      recoverable: true,
      warnings,
      confirmHint: `将把 ${path} 移入回收站（可恢复）`,
    };
  }

  async function remove({ path, confirm = false }) {
    const plan = await planRemove({ path });
    if (confirm !== true) return { ...plan, status: 'awaiting-confirmation' };

    const absPath = guard.resolveAssetForRemoval(path);
    if (!existsSync(absPath)) throw new AssetNotFoundError(path);
    const entry = moveToTrash({ paths: [{ absPath, relPath: path }], backupRoot, reason: 'asset-delete' });
    return {
      ...plan,
      status: 'deleted',
      deleted: true,
      trashId: entry.id,
      deletedAt: entry.deletedAt,
      bytes: entry.bytes,
      confirmHint: `已把 ${path} 移入回收站`,
    };
  }

  // Restoring a resource is the trash restore the content tree already uses: the manifest
  // carries the real path and the bytes move back, they are never rebuilt from text.
  function restore({ id }) {
    return documents.restore({ id });
  }

  function trashEntries() {
    return documents.trash();
  }

  // --- the reference verdict (Phase Insert E: images) ----------------------

  // Is `/…` a file the last build actually published? The published tree is the evidence, so
  // the answer never comes from a rule the editor invented about Hugo's permalinks.
  function isPublished(url) {
    if (!publishDir) return null;
    const withoutQuery = String(url).split(/[?#]/)[0].replace(/^\/+/, '');
    let relative;
    try {
      relative = decodeURIComponent(withoutQuery);
    } catch {
      relative = withoutQuery;
    }
    if (relative === '' || relative.split('/').includes('..')) return false;
    return existsSync(join(publishDir, relative));
  }

  // The one place that answers "will Hugo resolve this string, in this document?" - used by
  // the front-matter form (covers) and by the Markdown image dialog.
  async function referenceVerdict({ documentPath, value }) {
    if (typeof documentPath !== 'string' || documentPath === '') {
      throw new AssetValidationError('缺少文档路径');
    }
    const listing = await listAssets();
    const bundlePath = bundleOfDocument(documentPath);
    const bundle = listing.bundles.find((entry) => entry.bundlePath === bundlePath) ?? null;
    return classifyReference(value, {
      documentPath,
      bundlePath,
      bundleResources: (bundle?.resources ?? []).map((resource) => resource.relativePath),
      contentResources: listing.bundles.flatMap((entry) => entry.resources.map((resource) => resource.path)),
      staticPaths: listing.static.map((asset) => asset.path),
      assetPaths: listing.assets.map((asset) => asset.path),
      isPublished,
    });
  }

  return {
    siteRoot,
    contentRoot,
    staticRoot,
    assetRoot,
    publishDir,
    backupRoot,
    maxBytes,
    listAssets,
    bundleTargets,
    describe,
    readBytes,
    planUpload,
    upload,
    planReplace,
    replace,
    planRemove,
    remove,
    restore,
    trashEntries,
    referenceVerdict,
    isPublished,
    assetPreviewUrl,
  };
}
