// The Links domain model.
//
// On this site `links` is a sequence of maps in the front matter of `content/page/links/`,
// one per language:
//
//   links:
//     - title: GitHub
//       description: ...
//       website: https://github.com
//       image: https://.../GitHub-Mark.png
//
// The Phase 3-5 form refuses this shape on purpose ("值是一组映射（例如 links），表单不重写"),
// because flattening it into scalars and writing it back would destroy the structure. This
// module is the alternative: it reads the sequence as items with key order, edits one field or
// one item, and leaves every other line of the file - including the other items and everything
// outside the block - exactly as it was.
//
// The schema is learned from the document, not declared here: a key that an item already has
// can be edited, and a new item is rendered in the key order the document's own items use.
// LINK_KEYS is only the minimum the theme reads (title and website are what it renders).

import { parseFrontMatter } from '../frontmatter/parse.js';
import { formatString } from '../frontmatter/patch.js';
import {
  insertItem,
  moveItem,
  parseSequenceBlock,
  removeItem,
  renderMapItem,
  setMapItemField,
} from '../frontmatter/sequence.js';

// What the Stack theme's links partial renders: title, description, website, and an image that
// goes through the same resource resolver an article's cover image does.
export const LINK_KEYS = ['title', 'description', 'website', 'image'];
export const REQUIRED_LINK_KEYS = ['title', 'website'];

export class LinkModelError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LinkModelError';
  }
}

// The `links:` block of one document, as items the UI can render and edit.
export function readLinks(frontMatterRaw) {
  const parsedFrontMatter = parseFrontMatter(frontMatterRaw);
  const entry = parsedFrontMatter.byKey.get('links');
  if (!entry) {
    return { present: false, style: null, block: null, parsed: null, items: [], keyOrder: [...LINK_KEYS], malformed: [] };
  }

  const block = frontMatterRaw.slice(entry.start, entry.end);
  const sequence = parseSequenceBlock(block);
  const malformed = [];
  const items = [];

  for (const item of sequence.items) {
    if (item.kind !== 'map') {
      // A scalar in a list of links is data this model does not understand. It is reported and
      // left alone: guessing that `- https://example.com` meant a website would be invention.
      malformed.push({ index: item.index, reason: '这一项不是键值映射（title/website/...）', text: item.text.trimEnd() });
      continue;
    }
    const fields = {};
    for (const field of item.fields) fields[field.key] = field.value;
    items.push({
      index: item.index,
      title: fields.title ?? null,
      description: fields.description ?? null,
      website: fields.website ?? null,
      image: fields.image ?? null,
      keys: item.fields.map((field) => field.key),
      fields,
      missing: REQUIRED_LINK_KEYS.filter((key) => !(key in fields)),
      extraKeys: item.fields.map((field) => field.key).filter((key) => !LINK_KEYS.includes(key)),
    });
  }

  // The key order the document itself uses, which a new item copies so it looks hand-written.
  // The first item's order wins, with anything it lacks appended in the declared order.
  const keyOrder = [];
  for (const item of sequence.items) {
    for (const field of item.fields) if (!keyOrder.includes(field.key)) keyOrder.push(field.key);
  }
  for (const key of LINK_KEYS) if (!keyOrder.includes(key)) keyOrder.push(key);

  return { present: true, style: sequence.style, block, parsed: sequence, items, keyOrder, malformed, key: 'links', entry };
}

// Where a link's `image` points. `ts-logo-128.jpg` is a page resource of the same bundle (Hugo
// resolves it through the theme's image helper); an absolute URL is fetched or linked as is.
// The distinction matters because a resource reference is a Phase 6 relationship: deleting that
// file would break the link, so the asset browser has to know about it.
export function classifyLinkImage(value, { resourceNames = [], resourcePaths = [] } = {}) {
  if (typeof value !== 'string' || value.trim() === '') return { kind: 'empty', value: value ?? null };
  const trimmed = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith('//')) return { kind: 'external', value: trimmed };
  if (trimmed.startsWith('/')) return { kind: 'absolute-path', value: trimmed };
  const name = trimmed.split('/').pop();
  if (resourceNames.includes(name)) {
    return {
      kind: 'resource',
      value: trimmed,
      resourcePath: resourcePaths[resourceNames.indexOf(name)] ?? null,
      reason: '同 bundle 里的页面资源',
    };
  }
  return { kind: 'missing-resource', value: trimmed, reason: '没有找到同名资源（Hugo 会当成外部路径处理）' };
}

// The plan for one document's links: edit existing fields, add items, remove items, reorder.
//
// Index contract: every index, `from` and `to` the caller sends addresses the list as it was
// *read*. The steps run edits -> removals -> moves -> appends, and the move indexes are mapped
// through the surviving order in here, so a caller never has to work out how an earlier step
// shifted the indexes of a later one. Everything is a splice into the existing block, so an
// edit of item 0 cannot change a byte of item 1.
export function planLinkEdits({ block, parsed, keyOrder = LINK_KEYS, edit = [], add = [], remove = [], move = [] } = {}) {
  if (!parsed) throw new LinkModelError('该文档没有 links 字段');
  if (parsed.style === 'inline') throw new LinkModelError('links 是行内写法，结构化编辑只支持块序列');

  let next = block;
  const applied = [];
  const skipped = [];

  // 1. Field edits, on the list as it was read.
  for (const entry of edit) {
    const index = Number(entry.index);
    const current = parseSequenceBlock(next);
    const item = current.items[index];
    if (!item || item.kind !== 'map') {
      skipped.push({ action: 'edit', index, reason: '索引不存在或不是映射项' });
      continue;
    }
    for (const [key, value] of Object.entries(entry.set ?? {})) {
      const present = item.fields.some((field) => field.key === key);
      const learned = keyOrder.includes(key);
      if (!present && !learned) {
        skipped.push({ action: 'edit', index, key, reason: `该文档的 links 里没有 ${key} 字段` });
        continue;
      }
      if (value === undefined || value === null) {
        skipped.push({ action: 'edit', index, key, reason: '空值不写入' });
        continue;
      }
      if (present && String(item.fields.find((field) => field.key === key).value) === String(value)) {
        applied.push({ action: 'edit', index, key, value: String(value), unchanged: true });
        continue;
      }
      next = setMapItemField(next, item, key, value, { format: formatString });
      applied.push({ action: 'edit', index, key, value: String(value) });
    }
  }

  // 2. Removals, highest index first, so the indexes still address the list as it was read.
  const requested = [...new Set(remove.map(Number))];
  const readCount = parseSequenceBlock(next).items.length;
  const removed = new Set();
  for (const index of requested.sort((a, b) => b - a)) {
    const current = parseSequenceBlock(next);
    const item = current.items[index];
    if (!item) {
      skipped.push({ action: 'remove', index, reason: '索引不存在' });
      continue;
    }
    next = removeItem(next, item);
    removed.add(index);
    applied.push({ action: 'remove', index });
  }

  // 3. Moves, in the space that is left after the removals.
  const survivors = [];
  for (let index = 0; index < readCount; index += 1) if (!removed.has(index)) survivors.push(index);
  const rank = (index) => {
    const at = survivors.indexOf(index);
    if (at !== -1) return at;
    return survivors.filter((survivor) => survivor < index).length;
  };
  for (const entry of move) {
    const from = Number(entry.from);
    const to = Number(entry.to);
    if (!survivors.includes(from) || Number.isNaN(to)) {
      skipped.push({ action: 'move', from, to, reason: '索引不存在或已被删除' });
      continue;
    }
    const target = Number.isNaN(to) ? rank(from) : rank(to);
    const position = rank(from);
    if (position !== target) {
      const current = parseSequenceBlock(next);
      next = moveItem(next, current, position, target);
      applied.push({ action: 'move', from, to });
    }
  }

  // 4. Appends (or inserts at an explicit index, in the final list).
  for (const entry of add) {
    const missing = REQUIRED_LINK_KEYS.filter((key) => !entry[key]);
    if (missing.length > 0) {
      skipped.push({ action: 'add', reason: `缺少必填字段：${missing.join(', ')}` });
      continue;
    }
    if (entry.image !== undefined && entry.image !== null && entry.image !== '' && !isSafeImageReference(entry.image)) {
      skipped.push({ action: 'add', reason: `image 不是安全的引用：${entry.image}` });
      continue;
    }
    const fields = keyOrder
      .filter((key) => entry[key] !== undefined && entry[key] !== null && entry[key] !== '')
      .map((key) => ({ key, value: String(entry[key]) }));
    const rendered = renderMapItem(fields, {
      itemIndent: parsed.itemIndent,
      fieldIndent: parsed.fieldIndent,
      format: formatString,
    });
    const current = parseSequenceBlock(next);
    const at = entry.index === undefined ? current.items.length : Math.max(0, Math.min(Number(entry.index), current.items.length));
    next = insertItem(next, current, at, rendered);
    applied.push({ action: 'add', index: at, title: entry.title });
  }

  return { block: next, applied, skipped, changed: next !== block };
}

// A link image is a reference, never a path the editor writes: it must not escape the bundle.
export function isSafeImageReference(value) {
  const text = String(value).trim();
  if (text === '') return false;
  if (text.startsWith('/')) return !text.startsWith('//') && !text.includes('..');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || text.startsWith('//')) return true;
  return !text.split('/').includes('..') && !text.startsWith('~');
}

// The block for a document that has no `links:` yet, appended at the end of its front matter.
// The key order is the declared one, which is what the site's own pages use.
export function renderNewLinksBlock(items, { itemIndent = '  ', fieldIndent = '    ', keyOrder = LINK_KEYS } = {}) {
  const rendered = items.map((item) =>
    renderMapItem(
      keyOrder.filter((key) => item[key] !== undefined && item[key] !== null && item[key] !== '').map((key) => ({ key, value: String(item[key]) })),
      { itemIndent, fieldIndent, format: formatString },
    ),
  );
  return `links:\n${rendered.join('\n')}\n`;
}
