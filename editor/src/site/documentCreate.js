// Creating a document: path planning first, writing second (P3.3).
//
// Hugo has three shapes a content file can take, and they are not interchangeable:
//
//   standalone      content/post/name.md             one file
//   leaf bundle     content/post/name/index.md       a directory that owns its resources
//   branch bundle   content/categories/Name/_index.md  a section/term page that owns a subtree
//
// Language is a filename suffix (`index.en.md`), so the same article in four languages is
// four files in one bundle. The plan says exactly which path will be written, whether it
// already exists, and what it sits next to - the caller shows that and only then writes.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { formatString } from '../frontmatter/index.js';

import { deriveContentKind } from './contentReader.js';

export const CREATE_KINDS = ['standalone', 'leaf-bundle', 'branch-bundle'];
// Sections a new document may be created in. `categories` is here because a category page is
// ordinary content the site really has (content/categories/<term>/_index.md); creating one is
// the only way to give a new term its own description and image.
export const DEFAULT_CREATE_SECTIONS = ['post', 'page', 'categories'];

const UNSAFE_FILENAME = /[\\/:*?"<>|\u0000-\u001f]/g;

// Hugo's own urlize keeps non-ASCII letters, and so does this site ('相册', '写真ギャラリー'),
// so a Chinese or Japanese title keeps its characters instead of collapsing to nothing.
export function slugify(input, { fallback = 'untitled' } = {}) {
  const cleaned = String(input ?? '')
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '-')
    .replace(UNSAFE_FILENAME, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  return cleaned || fallback;
}

function languageSuffixFor(language, defaultLanguage) {
  if (!language || language === defaultLanguage) return '';
  return `.${language}`;
}

function fileNameFor({ kind, base, language, defaultLanguage }) {
  const suffix = languageSuffixFor(language, defaultLanguage);
  if (kind === 'leaf-bundle') return `index${suffix}.md`;
  if (kind === 'branch-bundle') return `_index${suffix}.md`;
  return `${base}${suffix}.md`;
}

function siblingsOf(directory, contentRoot) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort();
}

function initialText({ title, date, draft }) {
  const lines = ['---'];
  if (title) lines.push(`title: ${formatString(title)}`);
  lines.push(`date: ${date}`);
  lines.push(`draft: ${draft ? 'true' : 'false'}`);
  lines.push('---', '');
  return lines.join('\n');
}

export function planCreate({
  guard,
  section,
  kind,
  title,
  base = null,
  language,
  defaultLanguage,
  languages = [],
  today = null,
  sections = DEFAULT_CREATE_SECTIONS,
  contentKinds = null,
}) {
  const warnings = [];
  const conflicts = [];

  if (!CREATE_KINDS.includes(kind)) {
    throw new Error(`unknown document kind: ${kind}（只支持 ${CREATE_KINDS.join(' / ')}）`);
  }
  if (!sections.includes(section)) {
    throw new Error(`不能在该目录下新建文章: ${section}（允许: ${sections.join(', ')}）`);
  }
  if (language && languages.length > 0 && !languages.includes(language)) {
    throw new Error(`未知语言: ${language}（站点语言: ${languages.join(', ')}）`);
  }

  const stem = slugify(base ?? title ?? '');
  if (!stem) throw new Error('无法从标题得到合法的文件名');

  const bundling = kind === 'leaf-bundle' || kind === 'branch-bundle';
  const fileName = fileNameFor({ kind, base: stem, language, defaultLanguage });
  const relPath = bundling ? `${section}/${stem}/${fileName}` : `${section}/${stem}${languageSuffixFor(language, defaultLanguage)}.md`;

  const absPath = guard.resolveForWrite(relPath);
  const bundleDir = bundling ? join(absPath, '..') : null;
  const sectionDir = join(guard.contentRoot, section, stem);

  if (existsSync(absPath)) {
    conflicts.push({ path: relPath, reason: '该文件已存在' });
  }

  if (bundling) {
    if (existsSync(bundleDir) && !existsSync(absPath)) {
      const others = siblingsOf(bundleDir).filter((name) => name.endsWith('.md'));
      warnings.push(
        others.length > 0
          ? `目录 ${section}/${stem}/ 已存在，将把本次新建作为该 bundle 的一个语言版本（已有: ${others.join(', ')}）`
          : `目录 ${section}/${stem}/ 已存在，将向其中添加文件`,
      );
    } else if (existsSync(bundleDir)) {
      warnings.push(`目录 ${section}/${stem}/ 将被复用`);
    }
  } else if (existsSync(sectionDir) && statSync(sectionDir).isDirectory()) {
    conflicts.push({ path: `${section}/${stem}/`, reason: '同名 bundle 目录已存在，文章会与它冲突' });
  }

  // The other shape at the same name would produce a second page for the same URL, and Hugo
  // silently prefers one of them, so the plan says so before anything is written.
  if (kind === 'standalone' && existsSync(join(sectionDir, 'index.md'))) {
    warnings.push(`同名 leaf bundle 已存在（${section}/${stem}/index.md），两篇会争夺同一个 URL`);
  }
  if (kind === 'leaf-bundle' && existsSync(join(sectionDir, '_index.md'))) {
    warnings.push(`同名 branch bundle 已存在（${section}/${stem}/_index.md），两篇会争夺同一个 URL`);
  }
  if (kind === 'branch-bundle' && existsSync(join(sectionDir, 'index.md'))) {
    warnings.push(`同名 leaf bundle 已存在（${section}/${stem}/index.md），Hugo 会优先把它当成 leaf bundle`);
  }

  const date = today ?? new Date().toISOString().slice(0, 10);

  return {
    kind,
    section,
    // What the caller is about to create, in the site's own terms - so the confirmation
    // dialog can say "分类页" rather than making the user read the section name.
    contentKind: deriveContentKind({ section, kinds: contentKinds }),
    base: stem,
    language: language ?? defaultLanguage ?? null,
    languageSuffix: (languageSuffixFor(language, defaultLanguage) || '').replace(/^\./, '') || null,
    path: relPath,
    directory: bundling ? `${section}/${stem}` : null,
    title: title ?? null,
    text: initialText({ title, date, draft: true }),
    conflicts,
    warnings,
    writable: true,
  };
}
