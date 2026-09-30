// A read-only structural view of a TOML file.
//
// This is the TOML twin of `frontmatter/parse.js`, and it exists for the same reason: the
// raw text is the source of truth, so the editor needs to know *where* each value lives and
// nothing else. Nothing here re-serialises a file, and every byte that is not part of a
// value the user changed survives a save - comments, blank lines, alignment, ordering,
// table order, inline tables, arrays of tables.
//
// What it understands: root keys, `[table]`, `[[array of tables]]`, nested tables written
// with their full path (what this site does), dotted keys, and multi-line values (arrays and
// inline tables split over several lines). A value it cannot decode is still located and
// preserved; it is only reported as `ok: false`.

import { decodeValue, findEquals, keyPathToString, parseKeyPath, scanValue } from './values.js';

const HEADER = /^\s*(\[\[?)(.*?)(\]\]?)\s*(#.*)?$/;
const BLANK_OR_COMMENT = /^\s*(#.*)?$/;

export function splitLines(text) {
  const lines = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    if (newline === -1) {
      lines.push({ start, end: text.length, text: text.slice(start) });
      break;
    }
    lines.push({ start, end: newline, text: text.slice(start, newline) });
    start = newline + 1;
  }
  return lines;
}

export function lineIndexAt(lines, offset) {
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (lines[mid].start <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

export function tableKeyFor({ tablePath, arrayPath = null, arrayIndex = null }) {
  if (tablePath === '') return '';
  const base = arrayPath ? `${arrayPath}[${arrayIndex}]${tablePath.slice(arrayPath.length)}` : tablePath;
  return base;
}

export function entryPathFor(tableKey, key) {
  return tableKey === '' ? key : `${tableKey}.${key}`;
}

// A path with `[n]` segments is the one form the API and the catalog both speak, so both
// directions (`social[0].name` <-> `social`, 0, `name`) have to work.
// `social[0].params.icon` -> { arrayPath: 'social', arrayIndex: 0, tablePath: 'social.params', key: 'icon' }
export function parseTargetPath(fullPath) {
  const lastDot = fullPath.lastIndexOf('.');
  const parent = lastDot === -1 ? '' : fullPath.slice(0, lastDot);
  const key = lastDot === -1 ? fullPath : fullPath.slice(lastDot + 1);
  if (key === '') return null;

  const match = /^(.*?)\[(\d+)\](.*)$/.exec(parent);
  if (!match) return { tablePath: parent, arrayPath: null, arrayIndex: null, tableKey: parent, key };

  const [, arrayPath, index, suffix] = match;
  const tablePath = suffix === '' ? arrayPath : `${arrayPath}${suffix}`;
  return {
    tablePath,
    arrayPath,
    arrayIndex: Number(index),
    tableKey: `${arrayPath}[${index}]${suffix}`,
    key,
  };
}

export function parentTableKey(tableKey) {
  if (tableKey === '') return null;
  const { arrayPath, arrayIndex } = parseTargetPath(`${tableKey}.x`);
  if (arrayPath !== null) return `${arrayPath}[${arrayIndex}]`;
  const dot = tableKey.lastIndexOf('.');
  return dot === -1 ? '' : tableKey.slice(0, dot);
}

export function parseToml(text) {
  const lines = splitLines(text);
  const tables = new Map();
  const entries = new Map();
  const leaves = [];
  const arrayTables = new Map();

  let currentTable = '';
  const arrayCounters = new Map();
  const currentArrayIndex = new Map();

  // Register a table scope; a repeated `[[x]]` header is a new entry in the same array.
  const openTable = ({ lineIndex, kind, path, headerEnd, insideHeaderStart }) => {
    let tableKey = path;
    let arrayPath = null;
    let arrayIndex = null;

    if (kind === 'array-table') {
      const next = arrayCounters.get(path) ?? 0;
      arrayCounters.set(path, next + 1);
      currentArrayIndex.set(path, next);
      arrayPath = path;
      arrayIndex = next;
      tableKey = `${path}[${next}]`;
      const list = arrayTables.get(path) ?? [];
      list.push(tableKey);
      arrayTables.set(path, list);
    } else {
      // A table nested inside an array of tables (`[social.params]`) belongs to that array's
      // most recent entry.
      let best = null;
      for (const [arrayPath_, index] of currentArrayIndex) {
        if (path === arrayPath_ || path.startsWith(`${arrayPath_}.`)) {
          if (best === null || arrayPath_.length > best.length) best = arrayPath_;
        }
      }
      if (best !== null) {
        arrayPath = best;
        arrayIndex = currentArrayIndex.get(best);
        tableKey = `${best}[${arrayIndex}]${path.slice(best.length)}`;
      }
    }

    const header = lines[lineIndex];
    const table = {
      key: tableKey,
      path,
      kind,
      arrayPath,
      arrayIndex,
      headerLine: lineIndex,
      start: insideHeaderStart,
      end: headerEnd,
      bodyStart: lines[lineIndex].end + 1,
      bodyEnd: text.length,
      lastContentEnd: lines[lineIndex].end,
      entries: [],
    };
    tables.set(tableKey, table);
    return table;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const header = HEADER.exec(line.text);
    if (!BLANK_OR_COMMENT.test(line.text) && header) {
      const isArray = header[1] === '[[';
      const segments = parseKeyPath(header[2]);
      if (!segments) {
        i += 1;
        continue;
      }
      const opened = openTable({
        lineIndex: i,
        kind: isArray ? 'array-table' : 'table',
        path: keyPathToString(segments),
        headerEnd: line.end,
        insideHeaderStart: line.start,
      });
      currentTable = opened.key;
      i += 1;
      continue;
    }

    if (BLANK_OR_COMMENT.test(line.text)) {
      i += 1;
      continue;
    }

    const eq = findEquals(line.text);
    if (eq === -1) {
      i += 1;
      continue;
    }

    const segments = parseKeyPath(line.text.slice(0, eq));
    if (!segments) {
      i += 1;
      continue;
    }

    const valueStartInLine = eq + 1 + (line.text.slice(eq + 1).match(/^\s*/)?.[0].length ?? 0);
    const valueStart = line.start + valueStartInLine;
    const scanned = scanValue(text, valueStart);

    // Trim the whitespace between the value and its comment so a rewrite replaces exactly
    // the value token and leaves the comment and its spacing alone.
    let valueEnd = scanned.end;
    while (valueEnd > valueStart && /\s/.test(text[valueEnd - 1])) valueEnd -= 1;

    const endLine = lineIndexAt(lines, Math.max(valueStart, valueEnd - 1));
    const key = keyPathToString(segments);
    const table = tables.get(currentTable);
    const tablePath = table ? table.path : '';
    const leafKey = key;
    const entryPath = entryPathFor(currentTable, leafKey);

    const rawValue = text.slice(valueStart, valueEnd);
    const decoded = decodeValue(rawValue);
    const comment = scanned.commentAt === -1 ? null : text.slice(scanned.commentAt, lines[endLine].end);

    const entry = {
      path: entryPath,
      key: leafKey,
      tableKey: currentTable,
      start: line.start,
      end: lines[endLine].end,
      firstLine: i,
      lastLine: endLine,
      eq,
      valueStart,
      valueEnd,
      rawValue,
      comment,
      multiLine: endLine > i,
      ok: decoded.ok,
      reason: decoded.ok ? null : decoded.reason,
      type: decoded.type,
      value: decoded.value,
      headerLine: table ? table.headerLine : null,
    };

    entries.set(entryPath, entry);
    if (table) {
      table.entries.push(entryPath);
      table.lastContentEnd = Math.max(table.lastContentEnd, lines[endLine].end);
    }
    leaves.push(entry);
    i = endLine + 1;
  }

  // A table's scope ends where the next table header starts, so an insertion can be placed
  // after the table's own last line without touching anything below it.
  const tableList = [...tables.values()];
  for (let index = 0; index < tableList.length; index += 1) {
    const next = tableList[index + 1];
    tableList[index].bodyEnd = next ? next.start : text.length;
  }

  return { text, lines, tables, entries, leaves, arrayTables };
}

export function entryAt(parsed, path) {
  return parsed.entries.get(path) ?? null;
}

// Every dotted path in the file, including parents, so a caller can tell "this table does
// not exist yet" from "this key does not exist yet".
export function tableKeys(parsed) {
  return [...parsed.tables.keys()];
}

export function arrayTableKeys(parsed) {
  return [...parsed.arrayTables.keys()];
}
