// Minimal front-matter patching.
//
// Only the keys present in `changes` are rewritten, and only when the new value
// actually differs from the decoded current value. Untouched keys, unknown keys,
// comments and key order are preserved byte-for-byte.

import { parseFrontMatter, readEntryValue } from './parse.js';

const NEEDS_QUOTE = /^[\s\-?:,[\]{}#&*!|>'"%@`]|:\s|\s#|[\n\r\t]|\s$/;

// Values that YAML would decode as something other than a string. A form that accepts free
// text has to quote these, or typing `false` into a text field would silently write a
// boolean - a change the user never asked for.
const NOT_A_STRING = /^(?:true|false|null|~|yes|no|on|off|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)$/i;

export function formatScalar(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  if (text === '') return '""';
  return NEEDS_QUOTE.test(text) ? JSON.stringify(text) : text;
}

// Same as formatScalar, but a value that would be decoded as a boolean/number/null keeps
// its string meaning.
export function formatString(value) {
  const text = String(value);
  if (NOT_A_STRING.test(text.trim())) return JSON.stringify(text);
  return formatScalar(value);
}

export function isKeyName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(value);
}

// The file's own indentation, so a key the form adds looks hand-written. A list nested one
// level takes the file's list indent if it has one, otherwise the indent its nested maps
// use - this site's map-heavy pages indent those by four spaces - and only a wholly flat
// file falls back to two.
export function detectListIndent(frontMatterRaw) {
  let nestedIndent = null;
  for (const line of frontMatterRaw.split('\n')) {
    const list = /^([ \t]+)-[ \t]/.exec(line);
    if (list) return list[1];
    if (nestedIndent === null) {
      const nested = /^([ \t]+)\S/.exec(line);
      if (nested) nestedIndent = nested[1];
    }
  }
  return nestedIndent ?? '  ';
}

function itemIndent(entry) {
  for (const line of entry.lines.slice(1)) {
    const match = /^([ \t]+)-/.exec(line.text);
    if (match) return match[1];
  }
  return '    ';
}

function renderEntry(entry, value, format) {
  if (Array.isArray(value)) {
    const indent = itemIndent(entry);
    const items = value.map((item) => `${indent}- ${format(item, entry.key)}`).join('\n');
    return `${entry.key}:\n${items}`;
  }
  return `${entry.key}: ${format(value, entry.key)}`;
}

function sameValue(current, next) {
  if (Array.isArray(current) && Array.isArray(next)) {
    return current.length === next.length && current.every((item, index) => item === next[index]);
  }
  return current === next;
}

// `format` is injectable so the P3 form can keep string values string-shaped; the default
// is the P1 renderer, so the raw-text path is byte-for-byte what it always was.
export function patchFrontMatter(frontMatterRaw, changes, { format = formatScalar } = {}) {
  if (!frontMatterRaw || !changes) return frontMatterRaw;

  const parsed = parseFrontMatter(frontMatterRaw);
  const edits = [];

  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    const entry = parsed.byKey.get(key);
    // P1 never invents keys; it only rewrites keys that already exist in the file.
    if (!entry) continue;
    if (sameValue(readEntryValue(entry), value)) continue;

    const suffix = frontMatterRaw[entry.end - 1] === '\n' ? '\n' : '';
    edits.push({ start: entry.start, end: entry.end, text: renderEntry(entry, value, format) + suffix });
  }

  if (edits.length === 0) return frontMatterRaw;

  // Apply from the end so earlier offsets stay valid.
  edits.sort((a, b) => b.start - a.start);
  let out = frontMatterRaw;
  for (const edit of edits) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

// Adding a key is a Phase 3 capability and is kept separate from patchFrontMatter on
// purpose: the P1 raw-text path must keep refusing to invent keys (that is a tested
// guarantee), while the form needs to be able to fill in a field that is not there yet.
// New keys are appended at the end of the front matter, using the file's own list indent,
// so nothing above them moves.
export function appendFrontMatterKeys(frontMatterRaw, entries, { format = formatScalar } = {}) {
  if (!frontMatterRaw || !Array.isArray(entries) || entries.length === 0) return frontMatterRaw;

  const listIndent = detectListIndent(frontMatterRaw);
  const lines = [];

  for (const { key, value, type } of entries) {
    if (!isKeyName(key) || value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`${listIndent}- ${format(item, type)}`);
      continue;
    }
    lines.push(`${key}: ${format(value, type)}`);
  }

  if (lines.length === 0) return frontMatterRaw;

  const at = frontMatterRaw.lastIndexOf('\n') + 1;
  return `${frontMatterRaw.slice(0, at)}${lines.join('\n')}\n${frontMatterRaw.slice(at)}`;
}
