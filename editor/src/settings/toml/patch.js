// Minimal TOML patching: the only place a TOML file is ever rewritten.
//
// Every operation here turns into a small set of character-range splices over the original
// text, applied from the end so earlier offsets stay valid. That is what keeps the
// guarantees the settings layer promises and the tests assert:
//
//   * only the value of a key the user changed is replaced - its key, its alignment, its
//     trailing comment and its indentation are all left exactly as they were;
//   * a key that has to be created is inserted at the end of its table's own body, so
//     nothing above it moves;
//   * a table that has to be created is appended at the end of the file;
//   * a key or an array-of-tables entry that has to be removed takes its own lines with it,
//     and nothing else.
//
// `applyTomlEdits` also reports which line ranges it touched, which is how
// `verifyMinimalRewrite` proves that a save changed those lines and no others.

import { entryAt, lineIndexAt, parseTargetPath } from './parse.js';
import { formatValue } from './values.js';

const KEY_INDENT = /^([ \t]*)/;

// The file's own habits: how deep a table body is indented, and whether keys are aligned
// with padding before the `=`. Both are copied from what is already in the file rather than
// configured, so a new line looks like it was typed by the same person.
export function detectTomlStyle(parsed) {
  const indents = new Map();
  for (const entry of parsed.leaves) {
    const line = parsed.lines[entry.firstLine];
    const indent = KEY_INDENT.exec(line.text)[1];
    if (indent === '') continue;
    indents.set(indent, (indents.get(indent) ?? 0) + 1);
  }
  let indent = '';
  let best = 0;
  for (const [candidate, count] of indents) {
    if (count > best || (count === best && candidate.length < indent.length)) {
      indent = candidate;
      best = count;
    }
  }
  return { indent: indent || '    ', alignsKeys: alignmentFor(parsed, '').pad > 1 };
}

// How wide the keys of one table are padded. Recomputing it from the table's own entries
// means an inserted key lines up with its neighbours instead of with a hardcoded guess.
function alignmentFor(parsed, tableKey) {
  let pad = 0;
  for (const entry of parsed.leaves) {
    if (entry.tableKey !== tableKey) continue;
    pad = Math.max(pad, entry.key.length);
  }
  return { pad };
}

function indentOf(parsed, tableKey, style) {
  for (const entry of parsed.leaves) {
    if (entry.tableKey !== tableKey) continue;
    return KEY_INDENT.exec(parsed.lines[entry.firstLine].text)[1];
  }
  const table = parsed.tables.get(tableKey);
  if (table) {
    const header = parsed.lines[table.headerLine].text;
    const headerIndent = KEY_INDENT.exec(header)[1];
    return headerIndent + style.indent;
  }
  return '';
}

function renderKeyLine({ indent, key, pad, valueText }) {
  const padding = pad > key.length ? ' '.repeat(pad - key.length) : '';
  const lines = valueText.split('\n');
  if (lines.length === 1) return `${indent}${key}${padding} = ${valueText}`;
  // A multi-line value keeps its own indentation, which `formatValue` derived from `indent`.
  return `${indent}${key}${padding} = ${valueText}`;
}

function trailingContentEnd(parsed, table) {
  let end = parsed.lines[table.headerLine].end;
  for (const path of table.entries) {
    const entry = parsed.entries.get(path);
    if (entry) end = Math.max(end, parsed.lines[entry.lastLine].end);
  }
  return end;
}

// The root table has no header line, so it is not in `parsed.tables`. A new top-level key
// belongs among the other top-level keys: above the first `[table]` header, because the end of
// the file is inside whichever table happens to be written last (writing `SortBy = "x"` after
// `[colorScheme]` puts it in `colorScheme`, which is not what the caller asked for).
function rootInsertionOffset(parsed) {
  let offset = null;
  for (const [path, entry] of parsed.entries) {
    // A top-level key: no table prefix and no array index.
    if (path.includes('.') || path.includes('[')) continue;
    const end = parsed.lines[entry.lastLine].end;
    offset = offset === null ? end : Math.max(offset, end);
  }
  if (offset !== null) return offset;
  for (const table of parsed.tables.values()) {
    const start = parsed.lines[table.headerLine].start;
    offset = offset === null ? start : Math.min(offset, start);
  }
  return offset ?? parsed.text.length;
}

// The insertion point for a new key in `tableKey`: right after the table's own last line, so
// comments below it keep their place. Creating the table is a separate case (below).
function insertionOffset(parsed, tableKey) {
  if (tableKey === '') return rootInsertionOffset(parsed);
  const table = parsed.tables.get(tableKey);
  if (!table) return null;
  return trailingContentEnd(parsed, table);
}

function tableHeaderLine(table) {
  return table.kind === 'array-table' ? `[[${table.path}]]` : `[${table.path}]`;
}

// `social[0]` -> the `[[social]]` block that owns it, including the sub-tables written
// underneath it (`[social.params]`), because those belong to that entry.
export function arrayEntryRange(parsed, arrayPath, index) {
  const memberKeys = [...parsed.tables.values()]
    .filter((table) => table.arrayPath === arrayPath && table.arrayIndex === index)
    .map((table) => table.key);
  if (memberKeys.length === 0) return null;

  const keys = parsed.arrayTables.get(arrayPath) ?? [];
  const nextKey = keys[index + 1];
  const members = memberKeys.map((key) => parsed.tables.get(key));
  const start = Math.min(...members.map((table) => parsed.lines[table.headerLine].start));
  const end = nextKey
    ? parsed.tables.get(nextKey).start
    : Math.max(...members.map((table) => table.bodyEnd));
  return { start, end, memberKeys };
}

// -- edits -------------------------------------------------------------------------------

// Replace the value of an existing key. `format` decides how the new value is written; the
// default is the plain TOML renderer, and the widget list passes its own so the array keeps
// the site's one-inline-table-per-line style.
export function planValueEdit(parsed, path, value, { format = null, formatOptions = {} } = {}) {
  const entry = entryAt(parsed, path);
  if (!entry) return null;

  const indent = KEY_INDENT.exec(parsed.lines[entry.firstLine].text)[1];
  const rendered = format
    ? format(value, { indent, ...formatOptions })
    : formatValue(value, { indent, ...formatOptions });

  return {
    kind: 'value',
    path,
    value,
    checks: [{ path, value }],
    start: entry.valueStart,
    end: entry.valueEnd,
    text: rendered,
    beforeLines: [entry.firstLine, entry.lastLine],
  };
}

// Create a key. Inside an existing table the new line goes at the end of that table's body;
// if the table itself is missing, the whole `[table]` block is appended to the file.
export function planInsertKey(parsed, fullPath, value, { format = null, formatOptions = {} } = {}) {
  const target = parseTargetPath(fullPath);
  if (!target) return null;
  if (entryAt(parsed, fullPath)) return planValueEdit(parsed, fullPath, value, { format, formatOptions });

  const style = detectTomlStyle(parsed);
  const table = parsed.tables.get(target.tableKey);
  const atRoot = target.tableKey === '';

  if (table || atRoot) {
    const indent = indentOf(parsed, target.tableKey, style);
    const { pad } = alignmentFor(parsed, target.tableKey);
    const rendered = format
      ? format(value, { indent, ...formatOptions })
      : formatValue(value, { indent, ...formatOptions });
    const line = renderKeyLine({ indent, key: target.key, pad: Math.max(pad, target.key.length), valueText: rendered });
    const offset = insertionOffset(parsed, target.tableKey);
    return {
      kind: 'insert-key',
      path: fullPath,
      value,
      checks: [{ path: fullPath, value }],
      start: offset,
      end: offset,
      text: `\n${line}`,
      afterInsertedLines: line.split('\n').length,
    };
  }

  // A new table. Nested paths are written as a full header (`[cookies.categories]`), which
  // is what this site's files already do and what TOML allows without declaring the parents.
  const indent = style.indent;
  const header = target.arrayIndex === null ? `[${target.tablePath}]` : `[[${target.arrayPath}]]`;
  const rendered = format
    ? format(value, { indent, ...formatOptions })
    : formatValue(value, { indent, ...formatOptions });
  const line = renderKeyLine({ indent, key: target.key, pad: target.key.length, valueText: rendered });
  const text = `${parsed.text.endsWith('\n') ? '' : '\n'}\n${header}\n${line}\n`;
  return {
    kind: 'insert-table',
    path: fullPath,
    value,
    checks: [{ path: fullPath, value }],
    start: parsed.text.length,
    end: parsed.text.length,
    text,
    afterInsertedLines: line.split('\n').length + 2,
  };
}

// Create several keys at once, which is what a settings save usually needs. The batch matters
// because two keys can belong to the same table that does not exist yet: writing them as two
// separate edits would emit `[colorScheme]` twice, and a TOML file with a duplicate table is
// not a valid file. Keys of a missing table are therefore grouped into one inserted block,
// in the order the caller listed them.
export function planInsertKeys(parsed, entries) {
  const edits = [];
  const missingTables = new Map();

  for (const entry of entries) {
    if (!entry || entry.value === undefined) continue;
    const { path, value, format = null, formatOptions = {} } = entry;
    const existing = entryAt(parsed, path);
    if (existing) {
      edits.push(planValueEdit(parsed, path, value, { format, formatOptions }));
      continue;
    }

    const target = parseTargetPath(path);
    if (!target) throw new Error(`unusable setting path: ${path}`);
    // The root table always "exists": a top-level key is inserted among the top-level keys.
    if (target.tableKey === '' || parsed.tables.has(target.tableKey)) {
      edits.push(planInsertKey(parsed, path, value, { format, formatOptions }));
      continue;
    }

    const key = `${target.arrayPath ?? target.tablePath}[${target.arrayIndex ?? ''}]`;
    if (!missingTables.has(key)) missingTables.set(key, { target, lines: [] });
    missingTables.get(key).lines.push({ key: target.key, value, format, formatOptions });
  }

  const style = detectTomlStyle(parsed);
  for (const { target, lines } of missingTables.values()) {
    const header = target.arrayIndex === null ? `[${target.tablePath}]` : `[[${target.arrayPath}]]`;
    const indent = style.indent;
    const pad = lines.reduce((max, line) => Math.max(max, line.key.length), 0);
    const rendered = lines.map((line) => {
      const valueText = line.format
        ? line.format(line.value, { indent, ...line.formatOptions })
        : formatValue(line.value, { indent, ...line.formatOptions });
      return renderKeyLine({ indent, key: line.key, pad, valueText });
    });
    const text = `${parsed.text.endsWith('\n') ? '' : '\n'}\n${header}\n${rendered.join('\n')}\n`;
    edits.push({
      kind: 'insert-table',
      path: `${target.tablePath}.${lines[0].key}`,
      value: lines[0].value,
      start: parsed.text.length,
      end: parsed.text.length,
      text,
      afterInsertedLines: rendered.length + 2,
      // Every key in the block is part of this edit, so the read-back check has to look at
      // all of them, not just the first.
      checks: lines.map((line) => ({ path: `${target.tablePath}.${line.key}`, value: line.value })),
    });
  }

  return edits;
}

// Remove a key and the line(s) it owns. Trailing blank lines are left alone: this is about
// the key, not about tidying the file.
export function planRemoveKey(parsed, path) {
  const entry = entryAt(parsed, path);
  if (!entry) return null;
  const start = parsed.lines[entry.firstLine].start;
  const end = entry.lastLine + 1 < parsed.lines.length ? parsed.lines[entry.lastLine].end + 1 : parsed.lines[entry.lastLine].end;
  return { kind: 'remove-key', path, start, end, text: '', beforeLines: [entry.firstLine, entry.lastLine] };
}

// Remove one entry of an array of tables (`[[social]]` #0 and everything it owns).
export function planRemoveArrayEntry(parsed, arrayPath, index, { keepOneBlankLine = true } = {}) {
  const range = arrayEntryRange(parsed, arrayPath, index);
  if (!range) return null;

  let end = range.end;
  if (keepOneBlankLine) {
    // Take the blank line that separated the block from the next one, so removing an entry
    // does not leave two blank lines behind.
    const after = parsed.text.slice(end);
    const match = /^([ \t]*\r?\n)/.exec(after);
    if (match) end += match[0].length;
  }

  const firstLine = lineIndexAt(parsed.lines, range.start);
  const lastLine = lineIndexAt(parsed.lines, Math.max(range.start, end - 1));
  return {
    kind: 'remove-array-entry',
    path: `${arrayPath}[${index}]`,
    arrayPath,
    start: range.start,
    end,
    text: '',
    beforeLines: [firstLine, lastLine],
  };
}

// Append a new entry to an array of tables, at the end of the last entry that exists.
export function planInsertArrayEntry(parsed, arrayPath, lines) {
  const keys = parsed.arrayTables.get(arrayPath) ?? [];
  const offset = keys.length === 0 ? parsed.text.length : arrayEntryRange(parsed, arrayPath, keys.length - 1).end;
  const block = lines.join('\n');
  const prefix = keys.length === 0 ? `${parsed.text.endsWith('\n') ? '' : '\n'}\n` : '\n\n';
  return {
    kind: 'insert-array-entry',
    path: `${arrayPath}[${keys.length}]`,
    arrayPath,
    start: offset,
    end: offset,
    text: `${prefix}${block}\n`,
    afterInsertedLines: lines.length + 2,
  };
}

// -- application -------------------------------------------------------------------------

// Apply non-overlapping edits, and remember where each one landed. Sorting ascending and
// carrying a running delta is what makes the "where did it end up" question answerable
// without re-parsing: an edit at a greater offset cannot move an earlier one, and an edit at
// a smaller offset is accounted for by the delta accumulated so far.
export function applyTomlEdits(text, edits) {
  const applicable = edits.filter(Boolean);
  if (applicable.length === 0) return { text, changed: false, edits: [], before: text, after: text };

  const ordered = [...applicable].sort((a, b) => a.start - b.start || (a.end - b.end));
  let out = '';
  let cursor = 0;
  let delta = 0;
  const applied = [];

  for (const edit of ordered) {
    const start = Math.max(cursor, edit.start);
    if (start > edit.end) {
      throw new Error(`overlapping TOML edits at ${edit.path}`);
    }
    out += text.slice(cursor, start) + edit.text;
    applied.push({ ...edit, appliedAt: start + delta, removedLength: edit.end - start });
    delta += edit.text.length - (edit.end - start);
    cursor = edit.end;
  }
  out += text.slice(cursor);

  return { text: out, changed: true, edits: applied, before: text, after: out };
}

// Rewrite a text so that the spans under edit are replaced by one placeholder each. Two
// files normalise to the same string exactly when they differ only inside those spans.
function normalize(text, spans) {
  const ordered = [...spans].sort((a, b) => b.start - a.start);
  let out = text;
  for (const span of ordered) {
    out = out.slice(0, span.start) + (span.placeholder ?? '') + out.slice(span.end);
  }
  return out;
}

// The hard guarantee, and the reason the engine can claim "minimal rewrite" instead of
// hoping: with the edited spans (and only them) masked out, the file before and the file
// after have to be byte-identical. A save that quietly reflowed a neighbouring table, or
// reordered keys, fails here instead of on the user's site.
export function verifyMinimalRewrite({ beforeText, afterText, edits }) {
  const beforeSpans = [];
  const afterSpans = [];

  for (const edit of edits) {
    if (edit.kind === 'value') {
      beforeSpans.push({ start: edit.start, end: edit.end, placeholder: '\u0000EDIT\u0000' });
      afterSpans.push({ start: edit.appliedAt, end: edit.appliedAt + edit.text.length, placeholder: '\u0000EDIT\u0000' });
      continue;
    }
    if (edit.kind === 'insert-key' || edit.kind === 'insert-table' || edit.kind === 'insert-array-entry') {
      afterSpans.push({ start: edit.appliedAt, end: edit.appliedAt + edit.text.length, placeholder: '' });
      continue;
    }
    // remove-key / remove-array-entry: the text exists only in the file as it was.
    beforeSpans.push({ start: edit.start, end: edit.end, placeholder: '' });
  }

  const normalizedBefore = normalize(beforeText, beforeSpans);
  const normalizedAfter = normalize(afterText, afterSpans);
  if (normalizedBefore === normalizedAfter) return { ok: true };

  const limit = Math.min(normalizedBefore.length, normalizedAfter.length);
  let index = 0;
  while (index < limit && normalizedBefore[index] === normalizedAfter[index]) index += 1;
  const line = normalizedBefore.slice(0, index).split('\n').length;
  return {
    ok: false,
    reason: `bytes changed outside the edited spans (first difference at line ${line})`,
    before: normalizedBefore.slice(index, index + 80),
    after: normalizedAfter.slice(index, index + 80),
  };
}
