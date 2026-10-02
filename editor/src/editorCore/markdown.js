// Markdown command engine.
//
// Everything the modern editing experience offers - the toolbar, the slash menu, the
// keyboard shortcuts, the link / image / table / code helpers - is a *pure text transform*
// in here: it takes the document text plus a selection ({anchor, head} offsets, CodeMirror
// style) and returns the new text plus the new selection. Nothing in this file knows about
// CodeMirror, the DOM, Vue, the filesystem or Hugo.
//
// Two rules make it safe for the lossless pipeline:
//
//   1. Only the selected text changes. A command never reformats the whole document, so
//      front matter, raw HTML, shortcodes, Mermaid, math, footnotes, fenced code and
//      `<!--more-->` are bytes the user did not touch - and therefore bytes that come back
//      unchanged.
//   2. A command that would change nothing returns the input unchanged, which is what keeps
//      a no-op all the way down to a byte-identical file.
//
// Rule 1 has one hard edge the rest of the file cannot express by itself: the front matter is
// YAML, so a Markdown command that runs there does not merely "change the selected text", it
// changes the document's language. `image: ![](x.jpg)` and a list marker inside a `links:`
// item are what that looks like, and the next Hugo build refuses the file. The commands below
// therefore decline to run inside the front matter and report `blocked` instead.
//
// The entry points the UI uses are `COMMANDS` (the toolbar table), `runCommand`,
// `continueBlock` (Enter inside a list or quote), `slashQuery` + `matchSlashCommands` +
// `runSlashCommand` (the `/` menu) and `minimalChange` (turning a text+selection result
// into the smallest editor change, so undo history stays meaningful).

import { splitDocument } from '../frontmatter/split.js';

const HEADING_MAX = 6;

export const LIST_STYLES = Object.freeze(['ul', 'ol', 'task']);

export const CODE_LANGUAGES = Object.freeze([
  'text', 'bash', 'c', 'cpp', 'css', 'diff', 'go', 'html', 'java', 'javascript', 'json',
  'kotlin', 'lua', 'markdown', 'php', 'python', 'ruby', 'rust', 'shell', 'sql', 'swift',
  'toml', 'typescript', 'xml', 'yaml',
]);

// --- selection helpers ------------------------------------------------------

function clamp(value, max) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), max);
}

export function normalizeSelection(selection, length) {
  const anchor = clamp(selection?.anchor ?? 0, length);
  const head = clamp(selection?.head ?? anchor, length);
  return { anchor, head };
}

export function selectionRange(selection) {
  const anchor = selection?.anchor ?? 0;
  const head = selection?.head ?? anchor;
  return { from: Math.min(anchor, head), to: Math.max(anchor, head) };
}

// The front-matter region of a document as offsets, or null when the document has none.
// The region is the opener, the YAML and the closer - the bytes `splitDocument` calls
// `frontMatterRaw`.
export function frontMatterRange(text) {
  const source = String(text ?? '');
  const parts = splitDocument(source);
  return parts.hasFrontMatter ? { from: 0, to: parts.frontMatterRaw.length } : null;
}

// True when a selection would put Markdown into YAML: the caret is inside the front matter,
// or the selection reaches into it from the body. Both are refusals, because either one would
// rewrite YAML with Markdown syntax.
export function insideFrontMatter(text, selection) {
  const range = frontMatterRange(text);
  if (!range) return false;
  const sel = normalizeSelection(selection, String(text ?? '').length);
  const { from, to } = selectionRange(sel);
  return from < range.to || to < range.to;
}

export const FRONT_MATTER_NOT_MARKDOWN =
  'Front Matter 是 YAML，不是 Markdown：标题、列表、图片、链接等命令只对正文生效，这里不会写入任何内容。';

function result(text, from, to = from) {
  return { text, selection: { anchor: from, head: to } };
}

// The answer to a command that would have written Markdown into YAML: the text comes back
// untouched (so the pipeline still sees a no-op) with the reason attached, which the UI turns
// into a message instead of a mystery.
function blockedResult(text, selection) {
  return { ...result(text, selectionRange(selection).from), blocked: 'front-matter' };
}

export function changed(before, after) {
  return before.text !== after.text;
}

// The smallest edit that turns `before` into `after`: everything outside it is already
// identical, which is exactly the "只改选中的文本" rule expressed as a byte range.
export function minimalChange(before, after) {
  if (before === after) return null;
  let from = 0;
  const shortest = Math.min(before.length, after.length);
  while (from < shortest && before[from] === after[from]) from += 1;
  let suffix = 0;
  while (
    suffix < shortest - from &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return { from, to: before.length - suffix, insert: after.slice(from, after.length - suffix) };
}

function lineStart(text, index) {
  // The explicit `index <= 0` case matters: `lastIndexOf('\n', -1)` is clamped to 0, so on a
  // document whose first character is a newline (a body that opens with a blank line) offset 0
  // would otherwise be reported as the start of line 2.
  if (index <= 0) return 0;
  const newline = text.lastIndexOf('\n', index - 1);
  return newline === -1 ? 0 : newline + 1;
}

function lineEnd(text, index) {
  const newline = text.indexOf('\n', index);
  return newline === -1 ? text.length : newline;
}

// Every line the selection touches, as absolute ranges. An empty selection means "the line
// the cursor is on", which is what a user expects from a line command like a heading.
export function selectedLines(text, selection) {
  const { from, to } = selectionRange(selection);
  const start = lineStart(text, from);
  const end = to > from && text[to - 1] === '\n' ? to - 1 : to;
  // Never let the block end before it starts: a caret at the very start of a document that opens
  // with a newline used to produce an inverted range, and replacing an inverted range inserts the
  // rewritten line *in addition* to the original text - a duplicated paragraph.
  const stop = Math.max(lineEnd(text, Math.max(end, from)), start);
  const lines = [];
  let cursor = start;
  for (;;) {
    const next = lineEnd(text, cursor);
    lines.push({ from: cursor, to: next, text: text.slice(cursor, next) });
    if (next >= stop) break;
    cursor = next + 1;
  }
  return { from: start, to: stop, lines };
}

function replaceRange(text, from, to, insert) {
  return text.slice(0, from) + insert + text.slice(to);
}

// Rewrites the selected lines by giving each one a new prefix (heading marks, list marker,
// quote mark, indentation) while keeping its body byte-identical. The selection is remapped
// by the prefix deltas so it keeps pointing at the same text.
function rewriteLines(text, selection, plan) {
  const block = selectedLines(text, selection);
  const spanned = block.lines.filter((line) => line.text.trim() !== '').length;
  const lines = [];
  const deltas = [];
  let index = 0;

  // A single empty line counts as content, so Ctrl+1 or `/quote` on an empty line starts the
  // structure instead of doing nothing; blank lines inside a multi-line selection stay blank.
  const blankIsContent = block.lines.length === 1 && block.lines[0].text.trim() === '';

  for (const line of block.lines) {
    const info = plan.analyze(line.text);
    const nextPrefix =
      line.text.trim() === '' && !blankIsContent ? info.prefix : plan.render(info, index, spanned);
    if ((line.text.trim() !== '' || blankIsContent) && plan.count !== false) index += 1;
    const rendered = info.indent + nextPrefix + info.body;
    lines.push(rendered);
    deltas.push({ from: line.from, delta: rendered.length - line.text.length });
  }

  const insert = lines.join('\n');
  const next = replaceRange(text, block.from, block.to, insert);
  const map = (offset) => offset + deltas.reduce((sum, entry) => (offset >= entry.from ? sum + entry.delta : sum), 0);
  return result(next, map(selection.anchor), map(selection.head));
}

// --- inline marks -----------------------------------------------------------

// The marker runs immediately around the selection decide whether a mark is already there.
// Runs are counted in characters, not in marker strings, because `*` and `**` overlap:
// `***bold italic***` is a bold pair with one extra `*` on each side, while `**bold**` with
// a single `*` on each side must not be mistaken for an italic pair.
function runBefore(text, index, char) {
  let count = 0;
  while (index - 1 - count >= 0 && text[index - 1 - count] === char) count += 1;
  return count;
}

function runAfter(text, index, char) {
  let count = 0;
  while (index + count < text.length && text[index + count] === char) count += 1;
  return count;
}

// A run is the mark when what is left over is another complete mark of the same character:
// `*x*` is italic, `**x**` is bold, `***x***` is italic inside bold. The leftover therefore
// has to come in pairs for a one-character mark, and may be a single extra `*` for bold
// (that is the italic half of a bold-italic pair). Anything else is a different mark and must
// not be eaten.
function runAllowed(runLength, wanted) {
  const extra = runLength - wanted;
  if (extra < 0) return false;
  if (wanted >= 3) return extra === 0;
  if (wanted === 2) return extra === 0 || extra === 1;
  return extra % 2 === 0;
}

// The marker characters to strip at each edge, or null when the selection is not wrapped.
function wrappedEdges(text, from, to, marker) {
  const char = marker[0];
  const wanted = marker.length;
  const left = runBefore(text, from, char);
  const right = runAfter(text, to, char);
  if (!runAllowed(left, wanted) || !runAllowed(right, wanted)) return null;
  if (wanted < 3 && left - wanted !== right - wanted) {
    // Half a mark on only one side is not a pair: leave it alone instead of mangling it.
    return null;
  }
  return { from: from - wanted, to: to + wanted };
}

function stripInline(text, edges, markerLength) {
  const inner = text.slice(edges.from + markerLength, edges.to - markerLength);
  const withoutClose = replaceRange(text, edges.to - markerLength, edges.to, '');
  const next = replaceRange(withoutClose, edges.from, edges.from + markerLength, '');
  return result(next, edges.from, edges.from + inner.length);
}

// The wrapper a bare cursor sits inside, so Ctrl+B on a cursor inside `**bold**` removes the
// marks instead of adding a second pair around them.
function enclosingSpan(text, cursor, marker) {
  const char = marker[0];
  const wanted = marker.length;
  for (let openFrom = cursor - wanted; openFrom >= 0; openFrom -= 1) {
    if (text.slice(openFrom, openFrom + wanted) !== marker) continue;
    if (!runAllowed(runBefore(text, openFrom + wanted, char), wanted)) continue;
    for (let closeFrom = cursor; closeFrom + wanted <= text.length; closeFrom += 1) {
      if (text.slice(closeFrom, closeFrom + wanted) !== marker) continue;
      if (!runAllowed(runAfter(text, closeFrom, char), wanted)) continue;
      return { from: openFrom, to: closeFrom + wanted };
    }
  }
  return null;
}

function wrapInline(text, selection, marker) {
  const { from, to } = selectionRange(selection);
  const edges = wrappedEdges(text, from, to, marker);
  if (edges) return stripInline(text, edges, marker.length);
  if (from === to) {
    const enclosing = enclosingSpan(text, from, marker);
    if (enclosing) return stripInline(text, enclosing, marker.length);
    // Nothing selected and nothing to unwrap: insert the empty pair and put the caret
    // between the two halves, so the user types inside the mark. (Undo brings the document
    // straight back.)
    const next = replaceRange(text, from, from, marker + marker);
    return result(next, from + marker.length);
  }
  const inner = text.slice(from, to);
  const next = replaceRange(text, from, to, marker + inner + marker);
  return result(next, from + marker.length, to + marker.length);
}

function codeMarker(inner) {
  const longest = (inner.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(longest + 1);
}

export function toggleBold(text, selection) {
  return wrapInline(text, normalizeSelection(selection, text.length), '**');
}

export function toggleItalic(text, selection) {
  return wrapInline(text, normalizeSelection(selection, text.length), '*');
}

export function toggleStrike(text, selection) {
  return wrapInline(text, normalizeSelection(selection, text.length), '~~');
}

export function toggleInlineCode(text, selection) {
  const sel = normalizeSelection(selection, text.length);
  const { from, to } = selectionRange(sel);
  return wrapInline(text, sel, codeMarker(text.slice(from, to)));
}

// --- line prefixes: headings, quotes, lists, indent -------------------------

const HEADING_ANALYZER = {
  count: true,
  analyze(line) {
    const match = /^(#{1,6}\s+)?/.exec(line);
    return { indent: '', prefix: match?.[1] ?? '', body: line.slice(match?.[1]?.length ?? 0) };
  },
};

const QUOTE_ANALYZER = {
  analyze(line) {
    const match = /^(\s*)(>\s?)?/.exec(line);
    return { indent: match[1], prefix: match[2] ?? '', body: line.slice(match[0].length) };
  },
};

const LIST_ANALYZER = {
  analyze(line) {
    const match = /^(\s*)((?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/.exec(line);
    return { indent: match[1], prefix: match[2] ?? '', body: line.slice(match[0].length) };
  },
};

function listKind(prefix) {
  const match = /^((?:[-*+]|\d+[.)]))\s+(\[[ xX]\]\s+)?$/.exec(prefix);
  if (!match) return { kind: null, marker: null, task: false };
  return {
    kind: /\d/.test(match[1]) ? 'ol' : 'ul',
    marker: match[1],
    task: Boolean(match[2]),
  };
}

export function setHeadingLevel(text, selection, level) {
  const sel = normalizeSelection(selection, text.length);
  const target = Math.min(Math.max(Number(level) || 0, 0), HEADING_MAX);
  const prefixFor = (info) => (target > 0 ? `${'#'.repeat(target)} ` : '');
  if (target > 0) {
    const block = selectedLines(text, sel);
    const meaningful = block.lines.filter((line) => line.text.trim() !== '');
    const already = meaningful.length > 0 && meaningful.every((line) => HEADING_ANALYZER.analyze(line.text).prefix === prefixFor());
    return rewriteLines(text, sel, {
      ...HEADING_ANALYZER,
      render: () => (already ? '' : prefixFor()),
    });
  }
  return rewriteLines(text, sel, { ...HEADING_ANALYZER, render: () => '' });
}

export function toggleHeading(text, selection, level = 1) {
  return setHeadingLevel(text, selection, level);
}

export function toggleQuote(text, selection) {
  const sel = normalizeSelection(selection, text.length);
  const block = selectedLines(text, sel);
  const meaningful = block.lines.filter((line) => line.text.trim() !== '');
  const already = meaningful.length > 0 && meaningful.every((line) => QUOTE_ANALYZER.analyze(line.text).prefix !== '');
  return rewriteLines(text, sel, { ...QUOTE_ANALYZER, render: () => (already ? '' : '> ') });
}

export function setList(text, selection, style = null) {
  const sel = normalizeSelection(selection, text.length);
  const block = selectedLines(text, sel);
  const meaningful = block.lines.filter((line) => line.text.trim() !== '');
  const matches = (line) => {
    const { kind, task } = listKind(LIST_ANALYZER.analyze(line.text).prefix);
    if (style === 'task') return task;
    if (style === null) return kind !== null;
    return kind === style && !task;
  };
  const already = style !== null && meaningful.length > 0 && meaningful.every(matches);
  let counter = 0;

  return rewriteLines(text, sel, {
    ...LIST_ANALYZER,
    render: (info) => {
      const existing = listKind(info.prefix);
      if (style === null) return '';
      if (already) return ''; // pressing the same style again takes the list away
      if (style === 'ol') {
        const next = `${counter + 1}. `;
        counter += 1;
        return next;
      }
      if (style === 'task') return '- [ ] ';
      return `${existing.kind === 'ul' ? existing.marker : '-'} `;
    },
  });
}

export function indentLines(text, selection, direction = 'in') {
  const sel = normalizeSelection(selection, text.length);
  const block = selectedLines(text, sel);
  if (block.lines.filter((line) => line.text.trim() !== '').length === 0) {
    return result(text, sel.anchor, sel.head);
  }
  const lines = block.lines.map((line) => {
    if (line.text.trim() === '') return line.text;
    if (direction === 'out') {
      if (line.text.startsWith('  ')) return line.text.slice(2);
      if (line.text.startsWith(' ')) return line.text.slice(1);
      return line.text;
    }
    return `  ${line.text}`;
  });
  const insert = lines.join('\n');
  const next = replaceRange(text, block.from, block.to, insert);
  const shift = insert.length - (block.to - block.from);
  return result(next, sel.anchor + shift, sel.head + shift);
}

// --- Enter inside a list or a quote -----------------------------------------
//
// The only "smart input" the editor performs, and deliberately the kind a Markdown user
// already expects: Enter continues the current list item or quote, and an empty item ends
// the list by removing its marker instead of leaving it behind. It never reformats text
// that already exists, and it is one ordinary edit the user can undo.

const LIST_LINE = /^(\s*)((?:[-*+]|\d+[.)]))\s+(\[[ xX]\]\s+)?(.*)$/;

export function continueBlock(text, selection, { indent = '  ' } = {}) {
  const sel = normalizeSelection(selection, text.length);
  // Enter inside the front matter is a plain newline: continuing a YAML line as if it were a
  // Markdown list would add the `- ` of a list item to the user's YAML.
  if (insideFrontMatter(text, sel)) return null;
  const { from, to } = selectionRange(sel);
  if (from !== to) return null;
  const start = lineStart(text, from);
  const end = lineEnd(text, from);
  const line = text.slice(start, end);
  if (from !== end) return null; // only at the end of a line, like every other editor

  const quote = /^(\s*)(>\s?)(.*)$/.exec(line);
  if (quote) {
    if (quote[3].trim() === '') {
      const next = replaceRange(text, start, end, quote[1]);
      return result(next, start + quote[1].length);
    }
    const insert = `\n${quote[1]}> `;
    const next = replaceRange(text, from, from, insert);
    return result(next, from + insert.length);
  }

  const match = LIST_LINE.exec(line);
  if (!match) return null;
  const [, lineIndent, marker, task = '', body] = match;

  if (body.trim() === '') {
    const next = replaceRange(text, start, end, lineIndent);
    return result(next, start + lineIndent.length);
  }

  const ordered = /\d/.test(marker);
  const nextMarker = ordered ? `${Number.parseInt(marker, 10) + 1}${marker.endsWith(')') ? ')' : '.'}` : marker;
  void indent; // the next item starts at the same indentation as the one it continues
  const insert = `\n${lineIndent}${nextMarker} ${task}`;
  const next = replaceRange(text, from, from, insert);
  return result(next, from + insert.length);
}

// --- link, image, table, code, rule -----------------------------------------

export const LINK_PATTERN = /\[([^\]]*)\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)(?:\s+"([^"]*)")?\)/;

// The link the selection sits in or on, if any: what Ctrl+K edits instead of nesting a
// second link inside the first.
export function findLink(text, selection) {
  const sel = normalizeSelection(selection, text.length);
  const { from, to } = selectionRange(sel);
  const pattern = new RegExp(LINK_PATTERN.source, 'g');
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (end < from || start > to) continue;
    return { from: start, to: end, text: match[1], url: match[2], title: match[3] ?? null };
  }
  return null;
}

export function insertLink(text, selection, { url = '', title = null, text: label = null } = {}) {
  const sel = normalizeSelection(selection, text.length);
  const { from, to } = selectionRange(sel);
  if (!url) return result(text, from, to);
  const suffix = title ? ` "${title}"` : '';
  const existing = findLink(text, sel);

  if (existing) {
    const rendered = `[${existing.text}](${url}${suffix})`;
    const next = replaceRange(text, existing.from, existing.to, rendered);
    return result(next, existing.from + rendered.length);
  }

  const inner = label ?? text.slice(from, to);
  const rendered = `[${inner}](${url}${suffix})`;
  const next = replaceRange(text, from, to, rendered);
  // With an explicit label the caret goes after the link; otherwise the original words stay
  // selected, so a second Ctrl+K still edits the link the user just made.
  if (label !== null) return result(next, from + rendered.length);
  return result(next, from + 1, from + 1 + inner.length);
}

export function insertImage(text, selection, { src = '', alt = '' } = {}) {
  const sel = normalizeSelection(selection, text.length);
  const { from, to } = selectionRange(sel);
  if (!src) return result(text, from, to);
  const label = alt || text.slice(from, to);
  const rendered = `![${label}](${src})`;
  const next = replaceRange(text, from, to, rendered);
  return result(next, from + rendered.length);
}

export function padCell(value, width) {
  return value + ' '.repeat(Math.max(0, width - value.length));
}

export function tableText(cols, rows, { header = null } = {}) {
  const columns = Math.max(1, Math.min(Number(cols) || 2, 12));
  const bodyRows = Math.max(0, Math.min(Number(rows) || 0, 50));
  const head = Array.from({ length: columns }, (_, index) => header?.[index] ?? `Column ${index + 1}`);
  const rowsOut = Array.from({ length: bodyRows }, () => Array.from({ length: columns }, () => ''));
  const widths = head.map((cell, index) => Math.max(3, cell.length, ...rowsOut.map((row) => row[index].length)));
  const render = (cells) => `| ${cells.map((cell, index) => padCell(cell, widths[index])).join(' | ')} |`;
  const separator = `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`;
  return [render(head), separator, ...rowsOut.map(render)].join('\n');
}

export function insertTable(text, selection, { cols = 3, rows = 2, header = null } = {}) {
  const sel = normalizeSelection(selection, text.length);
  const { from, to } = selectionRange(sel);
  const block = selectedLines(text, sel);
  const onOwnLine = from === to && from === block.from && block.lines.length === 1 && block.lines[0].text.trim() === '';
  const table = tableText(cols, rows, { header });
  const rendered = onOwnLine ? table : `\n\n${table}\n\n`;
  const next = replaceRange(text, from, to, rendered);
  // The caret lands in the first body cell, so the user can type straight into the table.
  const [head, separator] = table.split('\n');
  const caret = from + rendered.indexOf(table) + head.length + 1 + separator.length + 1 + 2;
  return result(next, caret);
}

export function insertHorizontalRule(text, selection) {
  const sel = normalizeSelection(selection, text.length);
  const { from, to } = selectionRange(sel);
  const block = selectedLines(text, sel);
  const onOwnLine = from === to && from === block.from && block.lines.length === 1 && block.lines[0].text.trim() === '';
  const rendered = onOwnLine ? '---' : '\n\n---\n\n';
  const next = replaceRange(text, from, to, rendered);
  return result(next, from + rendered.length);
}

export function insertCodeBlock(text, selection, { language = '', code = null } = {}) {
  const sel = normalizeSelection(selection, text.length);
  const { from, to } = selectionRange(sel);
  const inner = code ?? text.slice(from, to);
  const info = language && language !== 'text' ? language : '';
  const body = inner === '' ? '\n' : `${inner}${inner.endsWith('\n') ? '' : '\n'}`;
  const fence = `\`\`\`${info}\n${body}\`\`\``;
  const inline = text.slice(lineStart(text, from), from).trim() !== '';
  const rendered = inline ? `\n${fence}\n` : fence;
  const next = replaceRange(text, from, to, rendered);
  if (inner === '') return result(next, from + (inline ? 1 : 0) + 3 + info.length + 1);
  return result(next, from + rendered.length);
}

// --- slash commands ---------------------------------------------------------

export const SLASH_COMMANDS = Object.freeze([
  { id: 'heading1', label: 'Heading 1', hint: '#', keywords: ['h1', 'heading', '标题'] },
  { id: 'heading2', label: 'Heading 2', hint: '##', keywords: ['h2', 'heading', '标题'] },
  { id: 'heading3', label: 'Heading 3', hint: '###', keywords: ['h3', 'heading', '标题'] },
  { id: 'bold', label: 'Bold', hint: '**', keywords: ['b', 'strong', '粗体'] },
  { id: 'italic', label: 'Italic', hint: '*', keywords: ['i', 'em', '斜体'] },
  { id: 'strike', label: 'Strikethrough', hint: '~~', keywords: ['s', 'strike', '删除线'] },
  { id: 'inlineCode', label: 'Inline code', hint: '`', keywords: ['code', '代码'] },
  { id: 'codeBlock', label: 'Code block', hint: '```', keywords: ['code', 'fence', '代码块'], dialog: 'code' },
  { id: 'quote', label: 'Quote', hint: '>', keywords: ['blockquote', '引用'] },
  { id: 'ul', label: 'Bullet list', hint: '-', keywords: ['list', 'bullet', '无序列表'] },
  { id: 'ol', label: 'Numbered list', hint: '1.', keywords: ['list', 'ordered', '有序列表'] },
  { id: 'task', label: 'Task list', hint: '- [ ]', keywords: ['todo', 'check', '任务'] },
  { id: 'link', label: 'Link', hint: '', keywords: ['url', '链接'], dialog: 'link' },
  { id: 'image', label: 'Image', hint: '', keywords: ['picture', '图片'], dialog: 'image' },
  { id: 'table', label: 'Table', hint: '', keywords: ['grid', '表格'], dialog: 'table' },
  { id: 'hr', label: 'Divider', hint: '---', keywords: ['rule', 'hr', '分隔线'] },
]);

// A slash trigger only counts after the start of a line or whitespace, so a URL that
// happens to contain a path like https://example.com/ never opens the menu.
export function slashQuery(text, position) {
  const at = clamp(position, text.length);
  const start = lineStart(text, at);
  const line = text.slice(start, at);
  const match = /(^|\s)\/([a-z0-9+-]*)$/i.exec(line);
  if (!match) return null;
  return { query: match[2].toLowerCase(), from: start + match.index + match[1].length, to: at };
}

export function matchSlashCommands(query, limit = 8) {
  const needle = String(query ?? '').toLowerCase();
  const scored = [];
  for (const command of SLASH_COMMANDS) {
    const label = command.label.toLowerCase();
    let score = needle === '' ? 1 : 0;
    if (label.startsWith(needle)) score = 3;
    else if (label.includes(needle)) score = 2;
    else if (command.id.startsWith(needle)) score = 2;
    else if (command.keywords.some((keyword) => keyword.toLowerCase().startsWith(needle))) score = 2;
    if (score > 0) scored.push({ command, score });
  }
  return scored.slice(0, limit).map((entry) => entry.command);
}

// Removes the typed `/query` (it is UI, not content) and then runs the command.
export function runSlashCommand(id, text, selection, arg = {}) {
  const sel = normalizeSelection(selection, text.length);
  // Checked before the `/query` is removed: a refused command must not eat the user's slash
  // text either.
  if (insideFrontMatter(text, sel)) return blockedResult(text, sel);
  const query = slashQuery(text, selectionRange(sel).to);
  if (query) {
    const next = replaceRange(text, query.from, query.to, '');
    const shift = query.to - query.from;
    sel.anchor -= Math.min(shift, Math.max(0, sel.anchor - query.from));
    sel.head -= shift;
    text = next;
  }
  return runCommand(id, text, sel, arg);
}

// --- the command table ------------------------------------------------------

export const TOOLBAR_GROUPS = Object.freeze([
  { id: 'headings', commands: ['heading1', 'heading2', 'heading3'] },
  { id: 'marks', commands: ['bold', 'italic', 'strike', 'inlineCode'] },
  { id: 'blocks', commands: ['quote', 'ul', 'ol', 'task'] },
  { id: 'insert', commands: ['link', 'image', 'table', 'codeBlock', 'hr'] },
]);

export const COMMANDS = Object.freeze({
  bold: { label: 'Bold', shortcut: 'Ctrl+B', run: (text, sel) => toggleBold(text, sel) },
  italic: { label: 'Italic', shortcut: 'Ctrl+I', run: (text, sel) => toggleItalic(text, sel) },
  strike: { label: 'Strikethrough', shortcut: 'Ctrl+Shift+X', run: (text, sel) => toggleStrike(text, sel) },
  inlineCode: { label: 'Inline code', shortcut: 'Ctrl+`', run: (text, sel) => toggleInlineCode(text, sel) },
  heading1: { label: 'Heading 1', run: (text, sel) => toggleHeading(text, sel, 1) },
  heading2: { label: 'Heading 2', run: (text, sel) => toggleHeading(text, sel, 2) },
  heading3: { label: 'Heading 3', run: (text, sel) => toggleHeading(text, sel, 3) },
  quote: { label: 'Quote', run: (text, sel) => toggleQuote(text, sel) },
  ul: { label: 'Bullet list', run: (text, sel) => setList(text, sel, 'ul') },
  ol: { label: 'Numbered list', run: (text, sel) => setList(text, sel, 'ol') },
  task: { label: 'Task list', run: (text, sel) => setList(text, sel, 'task') },
  list: { label: 'Remove list', run: (text, sel) => setList(text, sel, null) },
  hr: { label: 'Divider', run: (text, sel) => insertHorizontalRule(text, sel) },
  link: { label: 'Link', shortcut: 'Ctrl+K', needsArg: true, run: (text, sel, arg) => insertLink(text, sel, arg ?? {}) },
  image: { label: 'Image', needsArg: true, run: (text, sel, arg) => insertImage(text, sel, arg ?? {}) },
  table: { label: 'Table', needsArg: true, run: (text, sel, arg) => insertTable(text, sel, arg ?? {}) },
  codeBlock: { label: 'Code block', needsArg: true, run: (text, sel, arg) => insertCodeBlock(text, sel, arg ?? {}) },
  indent: { label: 'Indent', run: (text, sel) => indentLines(text, sel, 'in') },
  outdent: { label: 'Outdent', run: (text, sel) => indentLines(text, sel, 'out') },
});

export function runCommand(id, text, selection, arg = null) {
  const command = COMMANDS[id];
  if (!command) throw new Error(`unknown markdown command: ${id}`);
  const sel = normalizeSelection(selection, text.length);
  if (insideFrontMatter(text, sel)) return blockedResult(text, sel);
  return command.run(text, sel, arg);
}
