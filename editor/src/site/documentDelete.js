// Deleting a document: what exactly goes, what stays, and how to get it back (P3.4, P4).
//
// Two deletion scopes, because "the article" means different things in Hugo:
//
//   document   remove one file - one language of a bundle, or a standalone article
//   bundle     remove the page and everything that belongs to it
//
// What "belongs to it" depends on the bundle FORM, and this is the part that is easy to get
// wrong in a Hugo editor:
//
//   leaf bundle    the directory IS the page - index*.md plus its resources, nothing else is
//                  ever in there, so the whole directory moves
//   branch bundle  the page is the `_index.md` file of each language, its resources are the
//                  non-Markdown files beside them, and the directory may ALSO hold child
//                  pages and child sections. Those children are content in their own right:
//                  they stay, and the plan says so.
//   standalone     one file, and only one file
//
// Nothing here deletes anything. The plan is produced for confirmation, and the delete
// itself goes through the trash store - as one entry, even when it moves several paths, so a
// single restore puts the page back together.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { isBranchIndexName } from './contentReader.js';
import { listFiles, moveToTrash } from './trash.js';

export const DELETE_SCOPES = ['document', 'bundle'];

function toPosix(value) {
  return value.split('\\').join('/');
}

// The paths one deletion covers, and the sibling content it deliberately leaves alone.
function deleteTargets({ guard, doc, scope }) {
  if (scope === 'bundle' && doc.kind === 'leaf-bundle') {
    return { targets: [{ path: doc.bundlePath, type: 'directory' }], kept: [] };
  }

  if (scope === 'bundle' && doc.kind === 'branch-bundle') {
    // The directory is only LISTED here - it is never the thing being removed. Each file
    // that does move is validated as a removal target on its own below, so a section root
    // (whose `_index.md` is being deleted while its children stay) is not a special case.
    const absDir = guard.resolveForRead(doc.bundlePath);
    const entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

    const targets = [];
    const kept = [];
    for (const entry of entries) {
      const rel = toPosix(`${doc.bundlePath}/${entry.name}`);
      if (entry.isDirectory()) {
        kept.push(`${rel}/`);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isBranchIndexName(entry.name) || !entry.name.endsWith('.md')) targets.push({ path: rel, type: 'file' });
      else kept.push(rel);
    }
    return { targets, kept };
  }

  return { targets: [{ path: doc.path, type: 'file' }], kept: [] };
}

export function planDelete({ guard, doc, scope = null }) {
  const resolvedScope = scope ?? (doc.kind === 'leaf-bundle' ? 'bundle' : 'document');
  if (!DELETE_SCOPES.includes(resolvedScope)) {
    throw new Error(`unknown delete scope: ${scope}`);
  }
  if (resolvedScope === 'bundle' && doc.kind === 'standalone') {
    throw new Error('单文件文档只有它自己一个文件，请用 document 作用域删除');
  }
  if (resolvedScope === 'bundle' && !doc.bundlePath) {
    // The home page's `_index.md` sits directly in the content root: its "bundle" is the
    // whole site's content, so it can only ever be deleted one file at a time.
    throw new Error('这是内容根目录下的页面（其目录即内容根），不能整体删除；请按文件删除');
  }

  const { targets, kept } = deleteTargets({ guard, doc, scope: resolvedScope });
  const primary = resolvedScope === 'bundle' ? doc.bundlePath : doc.path;

  // Every file that would move, so "delete the page" is never a surprise about what the page
  // turned out to include. A file target is one entry - not a directory listing of itself,
  // which is what used to make a single file look like a resource it does not have.
  const files = [];
  for (const target of targets) {
    const abs = guard.resolveForRemoval(target.path);
    if (target.type === 'directory') {
      for (const file of listFiles(abs)) {
        files.push({ path: toPosix(`${target.path}/${file.relPath}`), size: file.size });
      }
    } else {
      const stats = statSync(abs);
      files.push({ path: toPosix(target.path), size: stats.size });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  const documents = files.filter((file) => file.path.endsWith('.md'));
  const resources = files.filter((file) => !file.path.endsWith('.md'));
  const warnings = [];

  if (resolvedScope === 'bundle' && doc.kind === 'leaf-bundle') {
    if (documents.length > 1) {
      warnings.push(`该 bundle 含 ${documents.length} 个语言版本，会一并删除：${documents.map((file) => basename(file.path)).join(', ')}`);
    }
    if (resources.length > 0) {
      warnings.push(`该 bundle 含 ${resources.length} 个资源文件，会一并移入回收站`);
    }
  }

  if (resolvedScope === 'bundle' && doc.kind === 'branch-bundle') {
    if (documents.length > 1) {
      warnings.push(`该栏目页含 ${documents.length} 个语言版本，会一并删除：${documents.map((file) => basename(file.path)).join(', ')}`);
    }
    if (resources.length > 0) {
      warnings.push(`该栏目页的 ${resources.length} 个资源文件会一并移入回收站`);
    }
    if (kept.length > 0) {
      warnings.push(`目录下还有 ${kept.length} 项子内容不属于这个页面，会保留：${kept.join(', ')}`);
    }
  }

  if (resolvedScope === 'document' && doc.kind === 'leaf-bundle') {
    // Deleting one language leaves its siblings behind, and the user is entitled to see
    // that before confirming - so the bundle directory is inspected, not just the file.
    const targetName = basename(doc.path);
    const siblings = listFiles(dirname(guard.resolveForRemoval(doc.path)))
      .map((file) => basename(file.relPath))
      .filter((name) => name.endsWith('.md') && name !== targetName);
    if (siblings.length > 0) {
      warnings.push(`只删除这一个语言版本；同一 bundle 的 ${siblings.join(', ')} 会保留`);
    }
  }

  if (resolvedScope === 'document' && doc.kind === 'branch-bundle') {
    // A branch bundle page's files are its `_index.md` of each language and its resources.
    // Deleting one file leaves the rest of them in place, and that is worth saying out loud.
    const absDir = guard.resolveForRead(doc.bundlePath);
    const name = basename(doc.path);
    const others = readdirSync(absDir)
      .filter((entry) => entry !== name)
      .sort();
    if (others.length > 0) {
      warnings.push(`只删除这一个文件；目录 ${doc.bundlePath}/ 下另外 ${others.length} 项会保留：${others.join(', ')}`);
    }
  }

  return {
    path: doc.path,
    target: toPosix(primary),
    targets: targets.map((target) => ({ path: toPosix(target.path), type: target.type })),
    scope: resolvedScope,
    kind: doc.kind,
    contentKind: doc.contentKind,
    bundlePath: doc.bundlePath,
    language: doc.language,
    files,
    kept: kept.map(toPosix),
    documentCount: documents.length,
    resourceCount: resources.length,
    totalFiles: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
    recoverable: true,
    warnings,
    // The user is told what "delete" costs before it happens; nothing is inferred.
    confirmHint: `将把 ${files.length} 个文件移入回收站（可恢复）`,
  };
}

export function deleteDocument({ guard, doc, scope = null, backupRoot, reason = 'delete' }) {
  const plan = planDelete({ guard, doc, scope });
  const paths = plan.targets.map((target) => {
    const absPath = guard.resolveForRemoval(target.path);
    if (!existsSync(absPath)) throw new Error(`找不到要删除的内容: ${target.path}`);
    return { absPath, relPath: target.path };
  });

  // One trash entry for the whole deletion, however many paths it turned out to be.
  const entry = moveToTrash({ paths, backupRoot, reason });

  return {
    ...plan,
    deleted: true,
    trashId: entry.id,
    trashPath: entry.trashPath,
    deletedAt: entry.deletedAt,
    transport: entry.transport,
  };
}
