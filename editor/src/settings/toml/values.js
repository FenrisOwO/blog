// TOML values: reading what a value means, and writing a value back the way this site
// writes it.
//
// This is deliberately not a general TOML implementation. It covers the value shapes a Hugo
// config uses - strings, booleans, numbers, datetimes, arrays, inline tables - and it never
// rewrites anything it did not fully understand: `decodeValue` answers `ok: false` instead
// of guessing, and the settings layer turns that into a read-only field.
//
// The text-level helpers (where a value ends, where its comment starts, splitting a list)
// are what the minimal-rewrite engine is built on, so they are tested on their own.

const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

export const BARE_KEY = /^[A-Za-z0-9_-]+$/;

// A key may be bare, or quoted (basic/literal). Bare keys are what this site uses; quoted
// ones are supported so a file that has them is still read correctly.
export function parseKeyPath(text) {
  const segments = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /[\s.]/.test(text[i])) i += 1;
    if (i >= text.length) break;

    const quote = text[i];
    if (quote === '"' || quote === "'") {
      const end = text.indexOf(quote, i + 1);
      if (end === -1) return null;
      segments.push({ value: text.slice(i + 1, end), quoted: true });
      i = end + 1;
      continue;
    }

    let end = i;
    while (end < text.length && !/[\s.]/.test(text[end])) end += 1;
    const value = text.slice(i, end);
    if (!BARE_KEY.test(value)) return null;
    segments.push({ value, quoted: false });
    i = end;
  }
  return segments.length > 0 ? segments : null;
}

export function keyPathToString(segments) {
  return segments.map((segment) => segment.value).join('.');
}

// Where does the value that starts at `start` end, and where does its trailing comment
// begin? Quotes, arrays and inline tables are tracked; a `#` inside a string is data, and a
// comment inside a multi-line array ends its line but not the value.
export function scanValue(text, start) {
  let i = start;
  let depth = 0;
  let quote = null;
  let triple = false;
  let commentAt = -1;

  while (i < text.length) {
    const char = text[i];

    if (quote) {
      if (triple) {
        if (char === '\\' && quote === '"') {
          i += 2;
          continue;
        }
        if (text.startsWith(quote.repeat(3), i)) {
          i += 3;
          quote = null;
          triple = false;
          continue;
        }
        i += 1;
        continue;
      }
      if (char === '\\' && quote === '"') {
        i += 2;
        continue;
      }
      if (char === quote) {
        quote = null;
        i += 1;
        continue;
      }
      if (char === '\n') return { end: i, commentAt, unfinished: true };
      i += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      triple = text.startsWith(char.repeat(3), i);
      quote = char;
      i += triple ? 3 : 1;
      continue;
    }

    if (char === '#') {
      if (commentAt === -1 && depth === 0) commentAt = i;
      // A comment runs to the end of its line; inside an array the value continues.
      const newline = text.indexOf('\n', i);
      if (newline === -1) return { end: text.length, commentAt, unfinished: false };
      if (depth === 0) return { end: i, commentAt, unfinished: false };
      i = newline + 1;
      continue;
    }

    if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth = Math.max(0, depth - 1);
    else if (char === '\n' && depth === 0) return { end: i, commentAt, unfinished: false };

    i += 1;
  }

  return { end: text.length, commentAt, unfinished: false };
}

// Split a bracketed body on top-level commas, so a nested array or inline table stays whole.
// Comments are dropped rather than carried into the part they follow: `"a", # first` has to
// split into `"a"`, not into `"a"` and `# first\n "b"`.
export function splitTopLevel(body, delimiter = ',') {
  const parts = [];
  let current = '';
  let depth = 0;
  let quote = null;
  let i = 0;

  while (i < body.length) {
    const char = body[i];
    if (quote) {
      current += char;
      if (char === '\\' && quote === '"') {
        current += body[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (char === quote) quote = null;
      i += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      i += 1;
      continue;
    }
    if (char === '#') {
      const newline = body.indexOf('\n', i);
      if (newline === -1) break;
      i = newline;
      continue;
    }
    if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth -= 1;
    else if (char === delimiter && depth === 0) {
      parts.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += char;
    i += 1;
  }

  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

// The `=` that separates a key from its value, ignoring any inside a quoted key.
export function findEquals(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '=') return i;
  }
  return -1;
}

function decodeBasicString(body) {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = body[i + 1];
    if (next === 'u' || next === 'U') {
      const length = next === 'u' ? 4 : 8;
      const hex = body.slice(i + 2, i + 2 + length);
      if (!/^[0-9A-Fa-f]+$/.test(hex)) return null;
      out += String.fromCodePoint(Number.parseInt(hex, 16));
      i += 1 + length;
      continue;
    }
    if (next in ESCAPES) {
      out += ESCAPES[next];
      i += 1;
      continue;
    }
    return null;
  }
  return out;
}

const INTEGER = /^[+-]?\d(?:_?\d)*$/;
const FLOAT = /^[+-]?(?:\d(?:_?\d)*(?:\.\d(?:_?\d)*)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d+)?$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/;
const LOCALTIME = /^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

// Decode one value. `ok: false` means "this editor does not understand it", which is a
// first-class answer: the caller shows the raw text instead of inventing a meaning.
export function decodeValue(raw) {
  const text = raw.trim();
  if (text === '') return { ok: false, reason: 'empty value', type: 'unknown', value: null };

  if (text.startsWith('"""')) {
    const body = text.slice(3, text.endsWith('"""') && text.length > 5 ? -3 : undefined);
    return { ok: true, type: 'string', value: body.replace(/^\n/, '') };
  }
  if (text.startsWith("'''")) {
    const body = text.slice(3, text.endsWith("'''") && text.length > 5 ? -3 : undefined);
    return { ok: true, type: 'string', value: body.replace(/^\n/, '') };
  }
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) {
      return { ok: false, reason: 'unterminated string', type: 'string', value: null };
    }
    const decoded = decodeBasicString(text.slice(1, -1));
    if (decoded === null) return { ok: false, reason: 'unsupported escape', type: 'string', value: null };
    return { ok: true, type: 'string', value: decoded };
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) {
      return { ok: false, reason: 'unterminated string', type: 'string', value: null };
    }
    return { ok: true, type: 'string', value: text.slice(1, -1) };
  }
  if (text === 'true' || text === 'false') return { ok: true, type: 'boolean', value: text === 'true' };
  if (INTEGER.test(text)) return { ok: true, type: 'integer', value: Number(text.replace(/_/g, '')) };
  if (text === 'inf' || text === '+inf') return { ok: true, type: 'float', value: Number.POSITIVE_INFINITY };
  if (text === '-inf') return { ok: true, type: 'float', value: Number.NEGATIVE_INFINITY };
  if (text === 'nan' || text === '+nan' || text === '-nan') {
    return { ok: true, type: 'float', value: Number.NaN };
  }
  if (FLOAT.test(text)) return { ok: true, type: 'float', value: Number(text.replace(/_/g, '')) };
  if (DATETIME.test(text)) return { ok: true, type: 'datetime', value: text };
  if (LOCALTIME.test(text)) return { ok: true, type: 'time', value: text };

  if (text.startsWith('[')) {
    if (!text.endsWith(']')) return { ok: false, reason: 'unterminated array', type: 'array', value: null };
    const items = [];
    for (const part of splitTopLevel(text.slice(1, -1))) {
      const decoded = decodeValue(part);
      if (!decoded.ok) return { ok: false, reason: `array item: ${decoded.reason}`, type: 'array', value: null };
      items.push(decoded.value);
    }
    return { ok: true, type: 'array', value: items };
  }

  if (text.startsWith('{')) {
    if (!text.endsWith('}')) {
      return { ok: false, reason: 'unterminated inline table', type: 'inline-table', value: null };
    }
    const object = {};
    for (const part of splitTopLevel(text.slice(1, -1))) {
      const eq = findEquals(part);
      if (eq === -1) return { ok: false, reason: 'inline table entry without =', type: 'inline-table', value: null };
      const key = parseKeyPath(part.slice(0, eq));
      if (!key || key.length !== 1) {
        return { ok: false, reason: 'inline table key', type: 'inline-table', value: null };
      }
      const decoded = decodeValue(part.slice(eq + 1));
      if (!decoded.ok) {
        return { ok: false, reason: `inline table value: ${decoded.reason}`, type: 'inline-table', value: null };
      }
      object[key[0].value] = decoded.value;
    }
    return { ok: true, type: 'inline-table', value: object };
  }

  return { ok: false, reason: 'unrecognised value', type: 'unknown', value: null };
}

export function formatString(value) {
  const text = String(value);
  let out = '"';
  for (const char of text) {
    if (char === '"' || char === '\\') out += `\\${char}`;
    else if (char === '\n') out += '\\n';
    else if (char === '\t') out += '\\t';
    else if (char === '\r') out += '\\r';
    else if (char === '\b') out += '\\b';
    else if (char === '\f') out += '\\f';
    else if (char.codePointAt(0) < 0x20) {
      out += `\\u${char.codePointAt(0).toString(16).padStart(4, '0').toUpperCase()}`;
    } else out += char;
  }
  return `${out}"`;
}

export function formatInlineTable(object) {
  return Object.entries(object)
    .map(([key, value]) => `${key} = ${formatValue(value)}`)
    .join(', ');
}

// One value, as this file would write it. `indent` is the indentation of the line the value
// starts on, so a multi-line array lines up with the file's own style.
export function formatValue(value, { indent = '', arrayStyle = 'inline', itemIndent = null } = {}) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return Number.isNaN(value) ? 'nan' : value > 0 ? 'inf' : '-inf';
    return String(value);
  }
  if (typeof value === 'string') return formatString(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const inner = itemIndent ?? `${indent}    `;
    if (arrayStyle === 'multiline') {
      const items = value.map((item) => `${inner}${formatValue(item)},`);
      return `[\n${items.join('\n')}\n${indent}]`;
    }
    return `[${value.map((item) => formatValue(item)).join(', ')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => `${key} = ${formatValue(item)}`);
    return `{ ${entries.join(', ')} }`;
  }
  return formatString(String(value));
}

// `{ type = "search" }` and its neighbours, one per line, exactly like the site writes its
// widget list: same indentation, same trailing comma, same inline-table style.
export function formatWidgetList(widgets, { indent = '', itemIndent = null } = {}) {
  if (!Array.isArray(widgets) || widgets.length === 0) return '[]';
  const inner = itemIndent ?? `${indent}    `;
  const lines = widgets.map((widget) => `${inner}{ ${formatInlineTable(widget)} },`);
  return `[\n${lines.join('\n')}\n${indent}]`;
}

// The value a TOML file would have to contain for `decodeValue` to give `value` back. Used
// by the min-rewrite check to prove the written file decodes to what the user asked for.
export function sameValue(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => sameValue(a[key], b[key]));
  }
  return a === b;
}
