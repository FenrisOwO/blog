// Structured view of a YAML block sequence - a `key:` whose value is a list.
//
// Two shapes matter in real Hugo front matter, and they are the two this module models:
//
//   tags:                links:
//     - Hugo               - title: GitHub
//     - Editor               website: https://github.com
//
// A sequence is never re-serialised as a whole. Parsing records where every item and every
// item field lives, so an edit can splice one line and leave the rest of the block - quotes,
// indentation, key order, comments, blank lines - byte-for-byte as the author wrote it. An
// item that was not touched is an item whose bytes did not move.
//
// Offsets are local to the block text handed in (the entry's own slice of the front matter),
// and callers splice the result back at `entry.start`.

const ITEM_LINE = /^([ \t]*)-[ \t]?(.*)$/;
const FIELD_LINE = /^([ \t]*)([A-Za-z0-9_][A-Za-z0-9_-]*):(.*)$/;
const MAP_ITEM_INNER = /^[A-Za-z0-9_][A-Za-z0-9_-]*:(\s|$)/;
// A comment that is not inside a quoted scalar. Values with a '#' in the middle of a word
// (`a#b`, a URL fragment) are not comments.
const TRAILING_COMMENT = /(\s+#.*)$/;

function splitLines(text) {
  const lines = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    if (newline === -1) {
      lines.push({ start, end: text.length, text: text.slice(start) });
      break;
    }
    lines.push({ start, end: newline + 1, text: text.slice(start, newline) });
    start = newline + 1;
  }
  return lines;
}

function splitComment(raw) {
  const text = raw.replace(/\r$/, '');
  if (text.trim().startsWith('#')) return { value: '', comment: raw };
  const match = TRAILING_COMMENT.exec(text);
  if (!match) return { value: raw, comment: '' };
  const valueEnd = match.index;
  return { value: raw.slice(0, valueEnd), comment: raw.slice(valueEnd) };
}

function stripQuotes(value) {
  const text = value.trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      if (first === '"') {
        try {
          return JSON.parse(text);
        } catch {
          return text.slice(1, -1);
        }
      }
      return text.slice(1, -1);
    }
  }
  return text;
}

function indentText(line) {
  return /^([ \t]*)/.exec(line)[1];
}

// One value as it is written: the whitespace after the `:` or `-`, the scalar itself and any
// trailing comment are kept apart, so an edit can re-emit the separators byte-for-byte and
// only the value moves.
function decodeValue(raw, base) {
  const clean = raw.replace(/\r$/, '');
  const { value: beforeComment, comment } = splitComment(clean);
  const match = /^([ \t]*)(.*)$/.exec(beforeComment);
  const sep = match[1];
  const body = match[2].trimEnd();
  const start = base + sep.length;
  // The whole value, comment included, is the region an edit replaces; the comment is
  // re-emitted from `comment`, so it survives at exactly one place.
  return { sep, body, value: stripQuotes(body), comment, start, end: base + clean.length };
}

// `blockText` is the entry's text: the `key:` line first, then the list.
export function parseSequenceBlock(blockText) {
  const lines = splitLines(blockText);
  const keyLine = lines[0]?.text.replace(/\r$/, '') ?? '';
  const keyMatch = /^([A-Za-z0-9_][A-Za-z0-9_-]*):(.*)$/.exec(keyLine);
  const key = keyMatch ? keyMatch[1] : null;
  const inline = keyMatch ? splitComment(keyMatch[2]).value.trim() : '';

  if (inline.startsWith('[') && inline.endsWith(']')) {
    return {
      key,
      style: 'inline',
      inline,
      itemIndent: '',
      fieldIndent: '',
      items: inlineValues(inline).map((value, index) => ({ index, kind: 'scalar', value, start: 0, end: 0, text: '', fields: [] })),
      trailing: { start: lines[0].end, end: blockText.length },
    };
  }

  const items = [];
  let itemIndent = null;
  let fieldIndent = null;
  let cursor = 1;
  while (cursor < lines.length) {
    const line = lines[cursor];
    const item = ITEM_LINE.exec(line.text.replace(/\r$/, ''));
    if (!item) {
      cursor += 1;
      continue;
    }
    if (itemIndent === null) itemIndent = item[1];
    const inner = item[2];
    const isMap = MAP_ITEM_INNER.test(inner);
    const start = line.start;
    let end = line.end;
    const fields = [];
    let next = cursor + 1;
    let inline = null;

    if (isMap) {
      const head = FIELD_LINE.exec(inner);
      const decoded = decodeValue(head[3], start + line.text.indexOf(inner) + head[0].length - head[3].length);
      fields.push({ key: head[2], ...decoded, raw: head[3], lineStart: start, lineEnd: line.end });
      while (next < lines.length) {
        const child = lines[next];
        const text = child.text.replace(/\r$/, '');
        // A blank line or a line at the item's own indent ends the item.
        if (text.trim() === '' || indentText(text).length <= (itemIndent ?? '').length) break;
        const field = FIELD_LINE.exec(text);
        if (field) {
          if (fieldIndent === null) fieldIndent = field[1];
          const fieldBase = child.start + field[0].length - field[3].length;
          fields.push({ key: field[2], ...decodeValue(field[3], fieldBase), raw: field[3], lineStart: child.start, lineEnd: child.end });
        }
        end = child.end;
        next += 1;
      }
    } else {
      inline = decodeValue(inner, start + line.text.indexOf(inner));
    }

    items.push({
      index: items.length,
      kind: isMap ? 'map' : 'scalar',
      value: isMap ? undefined : inline.value,
      raw: isMap ? undefined : inline.body,
      sep: isMap ? undefined : inline.sep,
      comment: isMap ? '' : inline.comment,
      valueStart: isMap ? undefined : inline.start,
      valueEnd: isMap ? undefined : inline.end,
      start,
      end,
      text: blockText.slice(start, end),
      fields,
    });
    cursor = next;
  }

  return {
    key,
    style: items.length > 0 ? 'block' : 'empty',
    inline,
    itemIndent: itemIndent ?? '  ',
    fieldIndent: fieldIndent ?? `${itemIndent ?? '  '}    `,
    items,
    trailing: { start: items.length > 0 ? items[items.length - 1].end : lines[0].end, end: blockText.length },
  };
}

function inlineValues(inline) {
  return inline
    .slice(1, -1)
    .split(',')
    .map((item) => stripQuotes(item))
    .filter((item) => item !== '');
}

// --- rendering ------------------------------------------------------------

export function renderScalarItem(value, { indent = '  ', format = String } = {}) {
  return `${indent}- ${format(value)}`;
}

// New items follow the shape of the items already in the block: a list of maps renders its
// keys in the given order, one per line, at the indentation the block already uses.
export function renderMapItem(fields, { itemIndent = '  ', fieldIndent = '    ', format = String } = {}) {
  const lines = [];
  fields.forEach((field, index) => {
    const prefix = index === 0 ? `${itemIndent}- ` : fieldIndent;
    lines.push(`${prefix}${field.key}: ${format(field.value)}`);
  });
  return lines.join('\n');
}

export function renderItems(values, { itemIndent = '  ', format = String } = {}) {
  return values.map((value) => renderScalarItem(value, { indent: itemIndent, format })).join('\n');
}

// --- splicing -------------------------------------------------------------

// Local offsets, applied from the end so earlier ones stay valid.
function applyLocalEdits(blockText, edits) {
  let out = blockText;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

// Rewrite one scalar item's value in place: the `- ` prefix, the indentation and any trailing
// comment keep their exact bytes.
export function setScalarItem(blockText, item, value, { format = String } = {}) {
  return applyLocalEdits(blockText, [
    { start: item.valueStart, end: item.valueEnd, text: `${format(value)}${item.comment}` },
  ]);
}

// Rewrite one field of one map item in place, keeping the key order and every other line.
export function setMapItemField(blockText, item, key, value, { format = String } = {}) {
  const field = item.fields.find((candidate) => candidate.key === key);
  if (!field) throw new Error(`item has no field ${key}`);
  return applyLocalEdits(blockText, [
    { start: field.start, end: field.end, text: `${format(value)}${field.comment}` },
  ]);
}

// Insert rendered item text at `index` (0..items.length), on its own line.
export function insertItem(blockText, parsed, index, renderedText) {
  const at = index >= parsed.items.length ? parsed.trailing.start : parsed.items[index].start;
  return `${blockText.slice(0, at)}${renderedText}\n${blockText.slice(at)}`;
}

export function removeItem(blockText, item) {
  return applyLocalEdits(blockText, [{ start: item.start, end: item.end, text: '' }]);
}

export function moveItem(blockText, parsed, from, to) {
  const item = parsed.items[from];
  if (!item) throw new Error(`no item at index ${from}`);
  const without = removeItem(blockText, item);
  const reparsed = parseSequenceBlock(without);
  const at = to >= reparsed.items.length ? reparsed.trailing.start : reparsed.items[to].start;
  return `${without.slice(0, at)}${item.text}${without.slice(at)}`;
}

// Rewrite a whole scalar sequence while keeping the bytes of every item that survives, and
// everything between the items: comments, blank lines, the file's own indentation.
//
// The change is expressed as one contiguous run of items that differs (the common prefix and
// suffix stay untouched). A run of the same length - a rename, a re-cased tag - is written in
// place, so the item keeps its own quotes and trailing comment; anything else removes the old
// run and inserts the new one where it stood.
export function rewriteScalarItems(blockText, parsed, nextValues, { format = String } = {}) {
  const current = parsed.items.map((item) => item.value);

  let prefix = 0;
  while (prefix < current.length && prefix < nextValues.length && current[prefix] === nextValues[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < current.length - prefix &&
    suffix < nextValues.length - prefix &&
    current[current.length - 1 - suffix] === nextValues[nextValues.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removed = current.slice(prefix, current.length - suffix);
  const added = nextValues.slice(prefix, nextValues.length - suffix);
  if (removed.length === 0 && added.length === 0) return blockText;

  if (removed.length === added.length) {
    let out = blockText;
    for (let i = 0; i < removed.length; i += 1) {
      const item = parseSequenceBlock(out).items[prefix + i];
      if (!item) break;
      out = setScalarItem(out, item, added[i], { format });
    }
    return out;
  }

  let out = blockText;
  for (let i = 0; i < removed.length; i += 1) {
    const item = parseSequenceBlock(out).items[prefix];
    if (!item) break;
    out = removeItem(out, item);
  }
  if (added.length === 0) return out;

  const reparsed = parseSequenceBlock(out);
  const rendered = added.map((value) => renderScalarItem(value, { indent: parsed.itemIndent, format })).join('\n');
  return insertItem(out, reparsed, Math.min(prefix, reparsed.items.length), rendered);
}

// An inline sequence (`tags: [a, b]`) cannot be spliced line by line; it is rewritten whole,
// which changes exactly one line of the file and nothing else.
export function rewriteInlineItems(blockText, parsed, nextValues, { format = String } = {}) {
  const keyLine = splitLines(blockText)[0];
  const line = keyLine.text.replace(/\r$/, '');
  const colon = line.indexOf(':');
  return `${line.slice(0, colon + 1)} [${nextValues.map((value) => format(value)).join(', ')}]\n${blockText.slice(keyLine.end)}`;
}

// Values of a scalar sequence, in file order.
export function scalarValues(parsed) {
  return parsed.items.map((item) => item.value);
}
