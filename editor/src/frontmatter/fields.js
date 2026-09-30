// Field model behind the front-matter form (P3.2).
//
// The raw text stays the source of truth. Nothing here re-serialises YAML: every operation
// rewrites the exact lines that carry the value, so unknown keys, comments, ordering and
// indentation survive - the same property the P1 engine has.
//
// The rules are deliberately narrow, because the alternative is silently rewriting files
// the user cannot see:
//
//   top-level scalar / list   create, rewrite, remove
//   nested scalar             rewrite IN PLACE only - never created, never removed
//   map                       never written by the form; shown, edited in the raw text
//   sequence of maps          never written by the form (this is what `links` is)
//
// The last two matter on this site: `menu` is a three-level map, `style` is a map and
// `links` is a sequence of maps. A naive form would flatten each of them into a scalar and
// destroy it, which is exactly what this module exists to prevent.

import { parseFrontMatter, readEntryValue } from './parse.js';
import { appendFrontMatterKeys, formatScalar, formatString, isKeyName, patchFrontMatter } from './patch.js';
import { splitDocument } from './split.js';

// How deep the form is willing to look inside a map. Real site data needs three levels
// (`menu.main.params.icon`), so that is the bound rather than "arbitrary depth".
export const MAX_NESTED_DEPTH = 3;

// Fields the form renders as first-class inputs. Anything else present in a file is still
// shown - and scalar ones stay editable - but is marked as non-standard.
export const FIELD_CATALOG = [
  { key: 'title', label: '标题', type: 'text' },
  { key: 'subtitle', label: '副标题', type: 'text' },
  { key: 'description', label: '描述', type: 'text' },
  { key: 'date', label: '发布日期', type: 'date' },
  { key: 'lastmod', label: '更新日期', type: 'date' },
  { key: 'slug', label: 'URL slug', type: 'text' },
  { key: 'draft', label: '草稿', type: 'boolean' },
  { key: 'author', label: '作者', type: 'text' },
  { key: 'categories', label: '分类', type: 'list' },
  { key: 'tags', label: '标签', type: 'list' },
  { key: 'image', label: '封面图', type: 'text' },
  { key: 'toc', label: '目录', type: 'boolean' },
  { key: 'math', label: '数学公式', type: 'boolean' },
  { key: 'readingTime', label: '阅读时长', type: 'boolean' },
  { key: 'comments', label: '评论', type: 'boolean' },
  // `false` switches the licence off; any other value is Markdown text.
  { key: 'license', label: '许可', type: 'booleanOrText' },
  { key: 'layout', label: '页面模板', type: 'text' },
  { key: 'outputs', label: '输出格式', type: 'list' },
  { key: 'menu', label: '菜单', type: 'map' },
];

const CATALOG_BY_KEY = new Map(FIELD_CATALOG.map((field) => [field.key, field]));

const KEY_LINE = /^([A-Za-z0-9_][A-Za-z0-9_-]*):(.*)$/;
// Nested keys are indented, so their pattern has to tolerate leading whitespace.
const NESTED_KEY_LINE = /^[ \t]*([A-Za-z0-9_][A-Za-z0-9_-]*):(.*)$/;
const ITEM_LINE = /^([ \t]*)-[ \t]*(.*)$/;
const MAP_ITEM_INNER = /^[A-Za-z0-9_][A-Za-z0-9_-]*:(\s|$)/;

function indentText(line) {
  return /^([ \t]*)/.exec(line)[1];
}

// Flat view of every nested `key:` line inside one top-level entry, addressed by dotted
// path. Sequence items are skipped on purpose: `- title: x` is data belonging to a list
// item, not a key of the document.
function nestedNodes(entry) {
  const nodes = new Map();
  // Seeded with the top-level key so every path is absolute ('menu.main.weight') - the
  // same form the caller sends back, and the reason a nested child can never be mistaken
  // for a top-level key.
  const stack = [{ name: entry.key, indent: '' }];

  for (let i = 1; i < entry.lines.length; i += 1) {
    const line = entry.lines[i];
    if (line.text.trim() === '') continue;
    if (ITEM_LINE.test(line.text)) continue;

    const key = NESTED_KEY_LINE.exec(line.text);
    if (!key) continue;

    const indent = indentText(line.text);
    while (stack.length > 0 && stack[stack.length - 1].indent.length >= indent.length) stack.pop();

    const path = [...stack.map((node) => node.name), key[1]];
    const depth = path.length - 1;
    if (depth <= MAX_NESTED_DEPTH) {
      nodes.set(path.join('.'), {
        name: key[1],
        path: path.join('.'),
        depth,
        indent,
        start: line.start,
        end: line.end,
        inline: key[2].trim(),
      });
      stack.push({ name: key[1], indent });
    }
  }

  for (const node of nodes.values()) {
    node.hasChildren = [...nodes.keys()].some((other) => other.startsWith(`${node.path}.`));
  }
  return nodes;
}

// Sub-paths seen anywhere in the file, so a caller that sends `background` instead of
// `style.background` is told the right path instead of quietly gaining a new top-level key.
// Both the path without its top-level key ('main.weight') and the bare leaf name
// ('weight') are registered: on this site the leaf name is the likelier mistake, because
// that is what the form's own labels show. A key the document really does have at the top
// level is found before this map is consulted, so a legitimate field is never redirected.
function nestedSubPaths(parsed) {
  const bare = new Map();
  const register = (name, path) => {
    if (name && !bare.has(name)) bare.set(name, path);
  };

  for (const entry of parsed.entries) {
    for (const node of nestedNodes(entry).values()) {
      const segments = node.path.split('.');
      register(node.path.slice(entry.key.length + 1), node.path);
      register(segments[segments.length - 1], node.path);
    }
  }
  return bare;
}

function entryShape(entry) {
  const items = entry.lines.slice(1).filter((line) => ITEM_LINE.test(line.text));
  if (items.length > 0) {
    const mapsInside = items.some((line) => MAP_ITEM_INNER.test(ITEM_LINE.exec(line.text)[2].trim()));
    return mapsInside ? 'list-of-maps' : 'list';
  }

  if (nestedNodes(entry).size > 0) return 'map';

  const inlineMatch = /^[^:]*:(.*)$/.exec(entry.lines[0].text);
  const inline = inlineMatch ? inlineMatch[1].trim() : '';
  return inline === '' ? 'empty' : 'scalar';
}

function entryRaw(frontMatterRaw, entry) {
  return frontMatterRaw.slice(entry.start, entry.end);
}

// YAML would read these back as numbers, and so does Hugo. Decoding them here keeps the
// descriptor, the "did it change" comparison and the re-rendered line in agreement -
// otherwise `weight: -100` would be echoed back as the string "-100" and re-quoted.
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)$/;

function decodeInline(name, inline) {
  const value = readEntryValue({ lines: [{ text: `${name}: ${inline}` }] });
  if (typeof value === 'string' && NUMBER.test(value.trim())) return Number(value);
  return value;
}

function decodeEntry(entry) {
  const value = readEntryValue(entry);
  if (typeof value === 'string' && NUMBER.test(value.trim())) return Number(value);
  return value;
}

function typeOfValue(value) {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'text';
}

function declaredType(key, shape) {
  const declared = CATALOG_BY_KEY.get(key);
  if (declared) return declared.type;
  if (shape === 'list') return 'list';
  if (shape === 'map' || shape === 'list-of-maps') return 'readonly';
  return 'text';
}

function editorFor(type, shape) {
  if (shape === 'map' || shape === 'list-of-maps' || type === 'map') return 'readonly';
  if (type === 'list') return 'list';
  if (type === 'boolean' || type === 'booleanOrText') return 'boolean';
  if (type === 'date') return 'date';
  return 'text';
}

function shapeReason(shape) {
  if (shape === 'list-of-maps') return '值是一组映射（例如 links），表单不重写，请在原文中编辑';
  if (shape === 'map') return '值是嵌套映射（例如 menu / style），请在原文中编辑，或使用下方的子字段';
  return null;
}

function valueOf(shape, entry) {
  if (shape === 'map' || shape === 'list-of-maps') return null;
  if (shape === 'empty') return '';
  return decodeEntry(entry);
}

// Everything the form needs in order to render, decided from the file rather than from a
// schema: which fields exist, what shape each one has, and what the form may do to it.
export function describeFields(frontMatterRaw) {
  const parsed = parseFrontMatter(frontMatterRaw);
  const fields = [];

  for (const entry of parsed.entries) {
    const shape = entryShape(entry);
    const type = declaredType(entry.key, shape);
    const declared = CATALOG_BY_KEY.get(entry.key) ?? null;
    const reason = shapeReason(shape);

    fields.push({
      key: entry.key,
      path: entry.key,
      label: declared?.label ?? entry.key,
      managed: Boolean(declared),
      group: null,
      level: 0,
      shape,
      type,
      editor: editorFor(type, shape),
      value: valueOf(shape, entry),
      raw: entryRaw(frontMatterRaw, entry),
      editable: reason === null,
      reason,
    });

    if (shape !== 'map') continue;

    for (const node of nestedNodes(entry).values()) {
      if (node.hasChildren) {
        fields.push({
          key: entry.key,
          path: node.path,
          label: node.path.slice(entry.key.length + 1),
          managed: Boolean(declared),
          group: entry.key,
          level: node.depth,
          shape: 'map',
          type: 'map',
          editor: 'readonly',
          value: null,
          raw: null,
          editable: false,
          reason: '嵌套映射，仅作展示',
        });
        continue;
      }

      fields.push({
        key: entry.key,
        path: node.path,
        label: node.path.slice(entry.key.length + 1),
        managed: Boolean(declared),
        group: entry.key,
        level: node.depth,
        shape: node.inline === '' ? 'empty' : 'scalar',
        type: node.inline === '' ? 'text' : typeOfValue(decodeInline(node.name, node.inline)),
        editor: 'text',
        value: node.inline === '' ? '' : decodeInline(node.name, node.inline),
        raw: null,
        editable: true,
        reason: null,
      });
    }
  }

  return { fields, presentKeys: parsed.entries.map((entry) => entry.key) };
}

// Catalogue entries the file does not have yet, so the form can offer to add them.
export function missingFields(frontMatterRaw) {
  const { presentKeys } = describeFields(frontMatterRaw);
  return FIELD_CATALOG.filter((field) => !presentKeys.includes(field.key)).map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    editor: editorFor(field.type, 'empty'),
    creatable: field.type !== 'map',
  }));
}

function formatterFor(type) {
  if (type === 'booleanOrText') {
    return (value) => {
      if (value === true || value === 'true') return formatScalar(true);
      if (value === false || value === 'false') return formatScalar(false);
      return formatString(value);
    };
  }
  if (type === 'boolean') return (value) => formatScalar(typeof value === 'string' ? value === 'true' : Boolean(value));
  if (type === 'number') {
    return (value) => {
      const text = String(value).trim();
      return NUMBER.test(text) ? text : formatString(text);
    };
  }
  if (type === 'date') {
    return (value) => {
      const text = String(value);
      // The site writes plain dates unquoted; anything else is quoted so it stays a string.
      return /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(text) ? text : formatString(text);
    };
  }
  return (value) => formatString(value);
}

function sameValue(current, next) {
  if (Array.isArray(current) && Array.isArray(next)) {
    return current.length === next.length && current.every((item, index) => item === next[index]);
  }
  return current === next;
}

function applyOffsets(frontMatterRaw, offsets) {
  let out = frontMatterRaw;
  for (const offset of [...offsets].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, offset.start) + offset.text + out.slice(offset.end);
  }
  return out;
}

// The whole form save, expressed as surgical edits. Returns the next document text plus a
// per-path account of what was and was not applied - nothing is ever applied silently.
export function applyFieldEdits(originalText, edits = {}) {
  const applied = [];
  const skipped = [];
  const setEntries = Object.entries(edits.set ?? {});
  const removals = edits.remove ?? [];

  const { hasFrontMatter, delimiter, frontMatterRaw, separator, bodyRaw } = splitDocument(originalText);
  if (!hasFrontMatter || delimiter !== '---') {
    const reason = hasFrontMatter
      ? `表单只编辑 YAML front matter（当前分隔符 ${delimiter}）`
      : '该文档没有 front matter';
    for (const [path] of setEntries) skipped.push({ path, reason });
    for (const path of removals) skipped.push({ path, reason });
    return { text: originalText, applied, skipped, changed: false };
  }

  const parsed = parseFrontMatter(frontMatterRaw);
  const subPaths = nestedSubPaths(parsed);
  const rewrites = [];
  const creations = [];
  const offsets = [];
  const types = new Map();

  for (const [path, value] of setEntries) {
    if (value === undefined) continue;
    const segments = path.split('.');
    if (!segments.every(isKeyName)) {
      skipped.push({ path, reason: '字段名不合法' });
      continue;
    }

    if (segments.length === 1) {
      const entry = parsed.byKey.get(path);
      const shape = entry ? entryShape(entry) : 'empty';
      const type = declaredType(path, shape);
      const reason = shapeReason(shape);

      if (!entry) {
        if (type === 'map') {
          skipped.push({ path, reason: '嵌套结构不能被表单创建' });
          continue;
        }
        const correction = subPaths.get(path);
        if (correction) {
          skipped.push({ path, reason: `该字段是嵌套子字段，请使用完整路径 ${correction}` });
          continue;
        }
        creations.push({ key: path, value, type });
        applied.push({ path, action: 'create' });
        continue;
      }
      if (reason) {
        skipped.push({ path, reason });
        continue;
      }
      if (Array.isArray(value) !== (shape === 'list')) {
        skipped.push({ path, reason: shape === 'list' ? '该字段是列表，不能写成标量' : '该字段是标量，不能写成列表' });
        continue;
      }
      if (sameValue(decodeEntry(entry), value)) {
        applied.push({ path, action: 'unchanged' });
        continue;
      }
      types.set(path, type);
      rewrites.push({ key: path, value });
      applied.push({ path, action: 'update' });
      continue;
    }

    const head = parsed.byKey.get(segments[0]);
    if (!head) {
      // A path typed relative to the wrong root ('main.weight' instead of
      // 'menu.main.weight') is answered with the path that works; a genuinely unknown
      // parent is refused, because the form does not invent nested structure.
      const correction = subPaths.get(path);
      skipped.push({
        path,
        reason: correction ? `该字段是嵌套子字段，请使用完整路径 ${correction}` : '上层字段不存在；表单不会创建嵌套结构',
      });
      continue;
    }
    const node = nestedNodes(head).get(segments.join('.'));
    if (!node || node.hasChildren) {
      skipped.push({ path, reason: '嵌套路径不存在，或它本身是映射' });
      continue;
    }
    if (sameValue(decodeInline(node.name, node.inline), value)) {
      applied.push({ path, action: 'unchanged' });
      continue;
    }
    const suffix = frontMatterRaw[node.end - 1] === '\n' ? '\n' : '';
    offsets.push({
      start: node.start,
      end: node.end,
      text: `${node.indent}${node.name}: ${formatterFor(typeOfValue(value))(value)}${suffix}`,
    });
    applied.push({ path, action: 'update' });
  }

  for (const path of removals) {
    if (!isKeyName(path)) {
      skipped.push({ path, reason: path.includes('.') ? '只能删除顶层字段' : '字段名不合法' });
      continue;
    }
    const entry = parsed.byKey.get(path);
    if (!entry) {
      skipped.push({ path, reason: '字段不存在' });
      continue;
    }
    offsets.push({ start: entry.start, end: entry.end, text: '' });
    applied.push({ path, action: 'remove' });
  }

  // Offset edits first: they were computed against the original text, and the patcher
  // re-parses whatever it is handed, so it must run on the already-shifted string.
  let nextFrontMatter = applyOffsets(frontMatterRaw, offsets);

  if (rewrites.length > 0) {
    nextFrontMatter = patchFrontMatter(
      nextFrontMatter,
      Object.fromEntries(rewrites.map((rewrite) => [rewrite.key, rewrite.value])),
      { format: (value, key) => formatterFor(types.get(key) ?? 'text')(value) },
    );
  }

  if (creations.length > 0) {
    nextFrontMatter = appendFrontMatterKeys(nextFrontMatter, creations, {
      format: (value, type) => formatterFor(type ?? 'text')(value),
    });
  }

  if (nextFrontMatter === frontMatterRaw) {
    return { text: originalText, applied, skipped, changed: false };
  }
  return { text: nextFrontMatter + separator + bodyRaw, applied, skipped, changed: true };
}
