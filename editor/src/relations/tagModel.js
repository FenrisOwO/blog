// The Tag domain model.
//
// A tag in Hugo front matter is just a string, but three different things are easily confused
// and the whole point of this module is to keep them apart:
//
//   * the tag NAME as written          `Hugo`, `hugo editor`, `隐私`
//   * its taxonomical IDENTITY         what Hugo actually groups by (it lowercases the term)
//   * its metadata PAGE                `content/tags/<term>/_index.md`, which may not exist
//
// On this site the difference is visible: `markdown` and `Markdown` are two strings but one
// Hugo term (`/en/tags/markdown/`), and `content/tags/` does not exist at all - so no tag has
// a metadata page, and none of them is "missing" one.

import { parseFrontMatter } from '../frontmatter/parse.js';
import { parseSequenceBlock, scalarValues } from '../frontmatter/sequence.js';

// What Hugo groups by: the term, case-folded. NFC first, so two spellings of the same
// character (a common way to get two visually identical tags) are one tag, and whitespace
// collapsed because `Hugo  Editor` and `Hugo Editor` are the same term to a reader.
export function normalizeTagIdentity(name) {
  return String(name ?? '')
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// A term directory is a real path, and a tag name is user input: `../foo` must never become
// `content/tags/../foo/`. The name is used as written (that is what Hugo's own convention
// does) but only after it is proven to be a single, ordinary path segment.
export function validateTagDirectoryName(name) {
  if (typeof name !== 'string' || name.trim() === '') return { ok: false, reason: '标签名为空' };
  if (name !== name.trim()) return { ok: false, reason: '标签名首尾不能有空白' };
  if (name.includes('/') || name.includes('\\')) return { ok: false, reason: '标签名不能包含路径分隔符' };
  if (name === '.' || name === '..' || name.startsWith('.')) return { ok: false, reason: '标签名不能以点开头' };
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, reason: '标签名不能包含控制字符' };
  if (name.normalize('NFC') !== name) return { ok: false, reason: '标签名不是 NFC 规范形式' };
  return { ok: true, reason: null };
}

// A URL-style fallback for a name that cannot be a directory (`a/b`): lower case, spaces to
// hyphens, everything else that is not a letter, digit, hyphen or CJK character dropped.
export function suggestTagSlug(name) {
  return String(name ?? '')
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}\-_.]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');
}

// The `tags:` list of one document, with the block it lives in so an edit can be spliced
// back instead of re-serialised.
export function readTagSequence(frontMatterRaw) {
  const parsed = parseFrontMatter(frontMatterRaw);
  const entry = parsed.byKey.get('tags');
  if (!entry) return { present: false, key: 'tags', entry: null, block: null, parsed: null, values: [] };
  const block = frontMatterRaw.slice(entry.start, entry.end);
  const sequence = parseSequenceBlock(block);
  return { present: true, key: 'tags', entry, block, parsed: sequence, values: scalarValues(sequence) };
}

// Every tag a document declares, in file order.
export function tagsOf(document) {
  const tags = document?.meta?.tags;
  if (Array.isArray(tags)) return tags.map((tag) => String(tag));
  if (typeof tags === 'string' && tags !== '') return [tags];
  return [];
}

// The whole site's tags, from the document descriptions the content walk already produced.
// No file is read here: `meta.tags` comes from the walk that listing the editor performs
// anyway, which is what keeps opening the Tags view off the disk.
export function buildTagIndex(documents = []) {
  const byIdentity = new Map();

  for (const document of documents) {
    const seen = new Set();
    for (const name of tagsOf(document)) {
      const identity = normalizeTagIdentity(name);
      if (identity === '') continue;
      if (!byIdentity.has(identity)) {
        byIdentity.set(identity, {
          identity,
          names: new Map(),
          documents: [],
          languages: new Set(),
          translationKeys: new Set(),
          kinds: new Set(),
        });
      }
      const tag = byIdentity.get(identity);
      tag.names.set(name, (tag.names.get(name) ?? 0) + 1);
      if (!seen.has(identity)) {
        tag.documents.push(document.path);
        seen.add(identity);
      }
      if (document.language) tag.languages.add(document.language);
      if (document.translationKey) tag.translationKeys.add(document.translationKey);
      if (document.contentKind) tag.kinds.add(document.contentKind);
    }
  }

  return [...byIdentity.values()]
    .map((tag) => {
      const names = [...tag.names.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
      return {
        identity: tag.identity,
        // The most used spelling, then the first alphabetically: a stable display name that is
        // one of the spellings the site actually uses.
        name: [...names].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))[0].name,
        names,
        usage: tag.documents.length,
        documents: [...tag.documents].sort(),
        languages: [...tag.languages].sort(),
        translationKeys: [...tag.translationKeys].sort(),
        kinds: [...tag.kinds].sort(),
        // Several spellings that share one identity: Hugo merges them in the taxonomy, so a
        // rename or a merge has to see them together instead of silently treating them as two.
        conflicts: names.length > 1
          ? [{ type: 'spelling', names: names.map((entry) => entry.name), reason: '大小写或空白不同，Hugo 会合并为同一个 term' }]
          : [],
      };
    })
    .sort((a, b) => b.usage - a.usage || a.name.localeCompare(b.name));
}

// The tag list a document should have after an operation, plus an account of what changed and
// what was refused. This is where "do not create `New Tag: New Tag`" lives: a value that is
// already present under the same identity is never added twice.
export function planTagListChanges(values, { replace = [], remove = [], add = [] } = {}) {
  const next = [];
  const applied = [];
  const skipped = [];
  const seen = new Set();

  const replaceMap = new Map(replace.map((entry) => [normalizeTagIdentity(entry.from), entry.to]));
  const removeIds = new Set(remove.map((name) => normalizeTagIdentity(name)));

  for (const value of values) {
    const identity = normalizeTagIdentity(value);
    if (removeIds.has(identity)) {
      applied.push({ action: 'remove', value });
      continue;
    }
    const target = replaceMap.has(identity) ? replaceMap.get(identity) : value;
    const targetIdentity = normalizeTagIdentity(target);
    if (seen.has(targetIdentity)) {
      // The document already carries the destination tag: the duplicate line is dropped
      // rather than written twice.
      applied.push({ action: 'dedupe', value, replacedBy: target });
      continue;
    }
    seen.add(targetIdentity);
    if (target !== value) applied.push({ action: 'replace', from: value, to: target });
    next.push(target);
  }

  for (const name of add) {
    const identity = normalizeTagIdentity(name);
    if (identity === '') {
      skipped.push({ value: name, reason: '标签名为空' });
      continue;
    }
    if (seen.has(identity)) {
      skipped.push({ value: name, reason: '该标签已存在（或与已有标签等价）' });
      continue;
    }
    // An `add` of a tag that is being removed in the same plan is refused instead of applied
    // in an order the user cannot see.
    if (removeIds.has(identity)) {
      skipped.push({ value: name, reason: '同一计划里既删除又新增该标签' });
      continue;
    }
    seen.add(identity);
    next.push(name);
    applied.push({ action: 'add', value: name });
  }

  for (const entry of replace) {
    if (!values.some((value) => normalizeTagIdentity(value) === normalizeTagIdentity(entry.from))) {
      skipped.push({ value: entry.from, reason: '该文档没有这个标签' });
    }
  }
  return { values: next, applied, skipped, changed: next.join('\u0000') !== values.join('\u0000') };
}
