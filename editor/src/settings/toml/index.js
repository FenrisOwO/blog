// Public API of the TOML engine.
//
// The shape mirrors `src/frontmatter/index.js` on purpose: the raw text is the source of
// truth, helpers locate and rewrite the smallest possible span, and an unchanged file comes
// back byte-for-byte identical.
//
//   TOML source -> parseToml (locate) -> plan* (edit) -> applyTomlEdits (minimal rewrite)
//
// `applyAndVerify` is the one call the settings layer uses, because it cannot forget the
// check that makes the whole thing safe: with the edited spans masked out, the file before
// and the file after must be identical.

import { parseToml, entryAt, entryPathFor, parseTargetPath, tableKeys, arrayTableKeys, splitLines } from './parse.js';
import {
  applyTomlEdits,
  arrayEntryRange,
  detectTomlStyle,
  planInsertArrayEntry,
  planInsertKey,
  planInsertKeys,
  planRemoveArrayEntry,
  planRemoveKey,
  planValueEdit,
  verifyMinimalRewrite,
} from './patch.js';
import { decodeValue, formatInlineTable, formatValue, formatWidgetList, sameValue, scanValue, splitTopLevel } from './values.js';

export function readToml(text) {
  const parsed = parseToml(text);
  const values = {};
  for (const leaf of parsed.leaves) values[leaf.path] = leaf.value;
  return { parsed, values, leaves: parsed.leaves, tables: tableKeys(parsed), arrays: arrayTableKeys(parsed) };
}

export function readValue(text, path) {
  return entryAt(parseToml(text), path)?.value ?? undefined;
}

// Plan + apply + prove, in one step. Returns the new text and, when nothing differs, says so
// instead of rewriting an identical file.
export function applyAndVerify(text, edits, { requireAll = true } = {}) {
  const applicable = edits.filter(Boolean);
  if (requireAll && applicable.length !== edits.length) {
    throw new Error('a planned edit could not be built');
  }
  if (applicable.length === 0) return { text, changed: false, edits: [] };

  const applied = applyTomlEdits(text, applicable);
  if (!applied.changed) return { text, changed: false, edits: [] };

  const check = verifyMinimalRewrite({ beforeText: text, afterText: applied.text, edits: applied.edits });
  if (!check.ok) throw new Error(`minimal rewrite check failed: ${check.reason}`);

  // Read the values back through the parser: the file must mean what the caller asked for,
  // not merely contain the characters the formatter produced.
  const parsed = parseToml(applied.text);
  const beforeParsed = parseToml(text);
  for (const edit of applied.edits) {
    if (edit.kind === 'remove-key') {
      if (parsed.entries.has(edit.path)) throw new Error(`edit did not remove ${edit.path}`);
      continue;
    }
    if (edit.kind === 'remove-array-entry' || edit.kind === 'insert-array-entry') {
      // Array lengths are checked in one pass below: a save can remove one entry and add
      // another, and then no single edit's own expectation holds on its own.
      continue;
    }
    for (const check of edit.checks ?? [{ path: edit.path, value: edit.value }]) {
      const landed = parsed.entries.get(check.path);
      if (!landed) throw new Error(`edit did not land: ${check.path}`);
      if (!landed.ok) throw new Error(`written value is unreadable: ${check.path} (${landed.reason})`);
      if (!sameValue(landed.value, check.value)) {
        throw new Error(`written value does not decode back: ${check.path}`);
      }
    }
  }

  return { text: applied.text, changed: true, edits: applied.edits };
}

export {
  parseToml,
  entryAt,
  entryPathFor,
  parseTargetPath,
  tableKeys,
  arrayTableKeys,
  splitLines,
  applyTomlEdits,
  arrayEntryRange,
  detectTomlStyle,
  planInsertArrayEntry,
  planInsertKey,
  planInsertKeys,
  planRemoveArrayEntry,
  planRemoveKey,
  planValueEdit,
  verifyMinimalRewrite,
  decodeValue,
  formatInlineTable,
  formatValue,
  formatWidgetList,
  sameValue,
  scanValue,
  splitTopLevel,
};
