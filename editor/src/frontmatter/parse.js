// Read-only view of YAML front matter.
//
// This deliberately never re-serialises. It only records where each top-level key
// lives (start/end offsets into frontMatterRaw) plus a best-effort decoded value for
// the fields the P1 form understands. Every byte of the original front matter is left
// untouched, so unknown keys, comments and ordering survive a save.

const KEY_PATTERN = /^([A-Za-z0-9_][A-Za-z0-9_-]*):(.*)$/;
const INDENT_PATTERN = /^[ \t]/;

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

function stripQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function parseFrontMatter(frontMatterRaw) {
  const entries = [];
  const byKey = new Map();
  if (!frontMatterRaw) return { entries, byKey };

  const lines = splitLines(frontMatterRaw);
  // By construction the last line is the closing delimiter (see splitDocument).
  const closerIndex = lines.length - 1;

  let i = 1;
  while (i < closerIndex) {
    const line = lines[i].text;
    const match = KEY_PATTERN.exec(line);
    if (!match || INDENT_PATTERN.test(line)) {
      i += 1;
      continue;
    }

    // A key owns the following indented lines (block sequences / nested maps).
    let last = i;
    for (let j = i + 1; j < closerIndex; j += 1) {
      const next = lines[j].text;
      if (next.length === 0 || !INDENT_PATTERN.test(next)) break;
      last = j;
    }

    const entry = {
      key: match[1],
      start: lines[i].start,
      end: lines[last].end,
      lines: lines.slice(i, last + 1),
    };
    entries.push(entry);
    if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
    i = last + 1;
  }

  return { entries, byKey };
}

export function readEntryValue(entry) {
  const inlineMatch = /^[^:]*:(.*)$/.exec(entry.lines[0].text);
  const inline = inlineMatch ? inlineMatch[1].trim() : '';

  const items = [];
  for (const line of entry.lines.slice(1)) {
    const match = /^[ \t]*-[ \t]*(.*)$/.exec(line.text);
    if (match) items.push(stripQuotes(match[1].trim()));
  }
  if (items.length > 0) return items;

  if (inline === '') return '';
  if (inline.startsWith('[') && inline.endsWith(']')) {
    return inline
      .slice(1, -1)
      .split(',')
      .map((item) => stripQuotes(item.trim()))
      .filter((item) => item !== '');
  }
  if (inline === 'true') return true;
  if (inline === 'false') return false;
  return stripQuotes(inline);
}

export function readValues(parsed, keys) {
  const values = {};
  for (const key of keys) {
    const entry = parsed.byKey.get(key);
    if (entry) values[key] = readEntryValue(entry);
  }
  return values;
}
