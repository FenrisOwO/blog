// Phase 8: the Markdown command engine.
//
// Every modern-editor action is a pure text transform, so it can be tested exactly the way
// the editor uses it: give it text + selection, get text + selection back. The properties
// that matter are (a) only the selected text changes, (b) the result is the Markdown a user
// expects, (c) a second press undoes the first (toggles), and (d) the selection still points
// at the text the user selected.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMANDS,
  SLASH_COMMANDS,
  TOOLBAR_GROUPS,
  changed,
  continueBlock,
  findLink,
  indentLines,
  insertCodeBlock,
  insertHorizontalRule,
  insertImage,
  insertLink,
  insertTable,
  matchSlashCommands,
  minimalChange,
  runCommand,
  runSlashCommand,
  selectionRange,
  setList,
  slashQuery,
  tableText,
  toggleBold,
  toggleHeading,
  toggleInlineCode,
  toggleItalic,
  toggleQuote,
  toggleStrike,
} from '../src/editorCore/markdown.js';

const sel = (anchor, head = anchor) => ({ anchor, head });

function wrap(mark, inner) {
  return `${mark}${inner}${mark}`;
}

// --- inline marks -----------------------------------------------------------

test('bold wraps the selection and leaves the rest of the line alone', () => {
  const text = 'hello world\n';
  const out = toggleBold(text, sel(0, 5));
  assert.equal(out.text, '**hello** world\n');
  assert.deepEqual(selectionRange(out.selection), { from: 2, to: 7 });
});

test('pressing bold again on the same words removes the marks', () => {
  const once = toggleBold('hello world\n', sel(0, 5));
  const twice = toggleBold(once.text, once.selection);
  assert.equal(twice.text, 'hello world\n');
  assert.deepEqual(selectionRange(twice.selection), { from: 0, to: 5 });
});

test('italic toggles on the selection and does not mistake **bold** for two italics', () => {
  const italic = toggleItalic('hello', sel(0, 5));
  assert.equal(italic.text, '*hello*');
  const bold = toggleBold('hello', sel(0, 5));
  const inside = toggleItalic(bold.text, sel(2, 7));
  assert.equal(inside.text, '***hello***');
  const back = toggleBold(inside.text, sel(3, 8));
  assert.equal(back.text, '*hello*');
});

test('strikethrough and inline code wrap, and inline code widens its backticks', () => {
  assert.equal(toggleStrike('gone', sel(0, 4)).text, '~~gone~~');
  assert.equal(toggleInlineCode('code', sel(0, 4)).text, '`code`');
  assert.equal(toggleInlineCode('a `b` c', sel(0, 7)).text, '``a `b` c``');
  assert.equal(toggleInlineCode('code', sel(0, 4)).text, '`code`');
});

test('a bare cursor inside a wrapped word unwraps it, and an empty selection elsewhere inserts a pair', () => {
  const unwrapped = toggleBold('**bold**', sel(3));
  assert.equal(unwrapped.text, 'bold');
  assert.deepEqual(selectionRange(unwrapped.selection), { from: 0, to: 4 });

  const inserted = toggleBold('text', sel(2));
  assert.equal(inserted.text, 'te****xt');
  assert.deepEqual(selectionRange(inserted.selection), { from: 4, to: 4 });
});

// --- headings, quotes, lists ------------------------------------------------

test('heading toggles on the line under the cursor and only the marks change', () => {
  const once = toggleHeading('intro paragraph\nrest\n', sel(3), 2);
  assert.equal(once.text, '## intro paragraph\nrest\n');
  const twice = toggleHeading(once.text, sel(5), 2);
  assert.equal(twice.text, 'intro paragraph\nrest\n');
});

test('heading level switches instead of stacking', () => {
  const h1 = toggleHeading('title', sel(0), 1);
  assert.equal(h1.text, '# title');
  const h3 = toggleHeading(h1.text, sel(3), 3);
  assert.equal(h3.text, '### title');
});

test('line commands apply to every selected line and remap the selection', () => {
  const text = 'alpha\nbravo\ncharlie\n';
  const out = setList(text, sel(0, 15), 'ul');
  assert.equal(out.text, '- alpha\n- bravo\n- charlie\n');
  assert.deepEqual(selectionRange(out.selection), { from: 2, to: 21 });
});

test('ordered lists number themselves and task lists keep their own marker', () => {
  assert.equal(setList('a\nb\nc\n', sel(0, 5), 'ol').text, '1. a\n2. b\n3. c\n');
  assert.equal(setList('a\nb\n', sel(0, 3), 'task').text, '- [ ] a\n- [ ] b\n');
});

test('switching list styles replaces the marker instead of nesting it', () => {
  const ul = setList('a\nb\n', sel(0, 3), 'ul');
  assert.equal(setList(ul.text, sel(0, 7), 'ol').text, '1. a\n2. b\n');
  assert.equal(setList(ul.text, sel(0, 7), [] && null).text, 'a\nb\n');
});

test('pressing the same list style again removes the list', () => {
  const ul = setList('a\n', sel(0, 1), 'ul');
  assert.equal(setList(ul.text, sel(0, 3), 'ul').text, 'a\n');
});

test('quote toggles on and off for the selected lines', () => {
  const quoted = toggleQuote('one\ntwo\n', sel(0, 8));
  assert.equal(quoted.text, '> one\n> two\n');
  assert.equal(toggleQuote(quoted.text, sel(0, 12)).text, 'one\ntwo\n');
});

test('indent and outdent shift whole lines by two spaces', () => {
  assert.equal(indentLines('a\nb\n', sel(0, 3), 'in').text, '  a\n  b\n');
  assert.equal(indentLines('  a\n  b\n', sel(0, 7), 'out').text, 'a\nb\n');
  assert.equal(indentLines('  a\n', sel(0, 3), 'out').text, 'a\n');
});

test('line commands leave blank lines and the text after the selection alone', () => {
  const text = 'before\n\nkeep me as is\nafter\n';
  const out = toggleHeading(text, sel(7, 20), 1);
  assert.equal(out.text, 'before\n\n# keep me as is\nafter\n');
});

// --- Enter ------------------------------------------------------------------

test('Enter continues a bullet list, a numbered list, a task list and a quote', () => {
  const bullet = continueBlock('- first', sel(7));
  assert.equal(bullet.text, '- first\n- ');
  assert.deepEqual(selectionRange(bullet.selection), { from: 10, to: 10 });

  const ordered = continueBlock('1. first', sel(8));
  assert.equal(ordered.text, '1. first\n2. ');

  const task = continueBlock('- [ ] first', sel(11));
  assert.equal(task.text, '- [ ] first\n- [ ] ');

  const quote = continueBlock('> said', sel(6));
  assert.equal(quote.text, '> said\n> ');

  const nested = continueBlock('  - deep', sel(8));
  assert.equal(nested.text, '  - deep\n  - ');
});

test('Enter on an empty list item ends the list instead of leaving the marker behind', () => {
  const bullet = continueBlock('- ', sel(2));
  assert.equal(bullet.text, '');
  const task = continueBlock('- [ ] ', sel(6));
  assert.equal(task.text, '');
  const quote = continueBlock('> ', sel(2));
  assert.equal(quote.text, '');
});

test('Enter outside a list or quote is left to the editor', () => {
  assert.equal(continueBlock('plain text', sel(10)), null);
  assert.equal(continueBlock('- item', sel(2)), null, 'not at the end of the line');
  assert.equal(continueBlock('a - b', sel(5)), null);
});

// --- link, image, table, code, rule -----------------------------------------

test('a link wraps the selection and keeps it selected for the next edit', () => {
  const out = insertLink('see the docs here', sel(13, 17), { url: 'https://example.com/' });
  assert.equal(out.text, 'see the docs [here](https://example.com/)');
  // The same words are still selected, so a second Ctrl+K edits the link in place.
  assert.equal(findLink(out.text, out.selection).url, 'https://example.com/');
});

test('Ctrl+K on an existing link replaces the URL instead of nesting a second link', () => {
  const text = 'see [the docs](https://old.example/) now';
  const existing = findLink(text, sel(6, 10));
  assert.equal(existing.text, 'the docs');
  const out = insertLink(text, sel(6, 10), { url: 'https://new.example/' });
  assert.equal(out.text, 'see [the docs](https://new.example/) now');
});

test('a link with an explicit label puts the caret after it', () => {
  const out = insertLink('', sel(0), { url: 'https://example.com', text: 'Example' });
  assert.equal(out.text, '[Example](https://example.com)');
  assert.deepEqual(selectionRange(out.selection), { from: 30, to: 30 });
});

test('an image is a Markdown reference, never a resource format', () => {
  const out = insertImage('', sel(0), { src: 'photo.webp', alt: 'a cat' });
  assert.equal(out.text, '![a cat](photo.webp)');
});

test('a table is a GFM table and the caret lands in the first body cell', () => {
  const out = insertTable('', sel(0), { cols: 3, rows: 2 });
  const lines = out.text.split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^\| Column 1 +\| Column 2 +\| Column 3 +\|$/);
  assert.equal(lines[1], '| -------- | -------- | -------- |');
  assert.equal(lines[2], lines[3]);
  // The caret is in the first body cell: line 3 (index 2), just after the leading "| ".
  const before = out.text.slice(0, selectionRange(out.selection).from);
  assert.equal(before.split('\n').length - 1, 2);
  assert.equal(before.split('\n')[2], '| ');
});

test('a code block fences the selection and keeps the language', () => {
  const out = insertCodeBlock('let x = 1;', sel(0, 10), { language: 'javascript' });
  assert.equal(out.text, '```javascript\nlet x = 1;\n```');
  const empty = insertCodeBlock('', sel(0), { language: 'python' });
  assert.equal(empty.text, '```python\n\n```');
  assert.deepEqual(selectionRange(empty.selection), { from: 10, to: 10 });
});

test('a horizontal rule goes on its own line', () => {
  assert.equal(insertHorizontalRule('', sel(0)).text, '---');
  assert.equal(insertHorizontalRule('text', sel(4)).text, 'text\n\n---\n\n');
});

// --- dispatch, slash commands ----------------------------------------------

test('every toolbar and slash command is dispatchable and reports whether it changed anything', () => {
  const text = 'hello\n';
  const out = runCommand('bold', text, sel(0, 5));
  assert.equal(out.text, '**hello**\n');
  assert.equal(changed({ text }, out), true);
  for (const group of TOOLBAR_GROUPS) {
    for (const id of group.commands) assert.ok(COMMANDS[id], `missing command ${id}`);
  }
});

test('unknown commands are refused loudly', () => {
  assert.throws(() => runCommand('nope', '', sel(0)), /unknown markdown command/);
});

test('the slash query only opens after whitespace or at the start of a line', () => {
  assert.deepEqual(slashQuery('/he', 3), { query: 'he', from: 0, to: 3 });
  assert.deepEqual(slashQuery('text /ta', 8), { query: 'ta', from: 5, to: 8 });
  assert.equal(slashQuery('https://example.com/', 20), null);
  assert.equal(slashQuery('a/b', 3), null);
});

test('slash commands are matched by name and by keyword', () => {
  assert.equal(matchSlashCommands('head')[0].id, 'heading1');
  assert.equal(matchSlashCommands('表格')[0].id, 'table');
  assert.equal(matchSlashCommands('')[0].id, SLASH_COMMANDS[0].id);
  assert.deepEqual(matchSlashCommands('zzzz'), []);
});

test('running a slash command removes the typed trigger and applies the command', () => {
  const typed = '## note\n\n/quote';
  const out = runSlashCommand('quote', typed, sel(typed.length));
  assert.equal(out.text, '## note\n\n> ');
  assert.deepEqual(selectionRange(out.selection), { from: 11, to: 11 });
});

// --- a body that opens with a blank line ------------------------------------
//
// A document body usually starts with an empty line (the one right after the front matter), so
// "the caret is at offset 0" means "an empty first line" and NOT "the start of line 2". Getting
// that wrong produced an inverted line range, and replacing an inverted range appends the
// rewritten line instead of substituting it - a silently duplicated paragraph.

test('a line command at offset 0 edits the blank first line, not the paragraph below it', () => {
  const text = '\nhello world\n\nsecond\n';
  assert.equal(setList(text, sel(0), 'ul').text, '- \nhello world\n\nsecond\n');
  assert.equal(toggleQuote(text, sel(0)).text, '> \nhello world\n\nsecond\n');
  assert.equal(toggleHeading(text, sel(0), 1).text, '# \nhello world\n\nsecond\n');
});

test('no line command can duplicate text when the caret sits at offset 0', () => {
  const bodies = ['\nhello\n', '\n\nhello\n', '# title\n\nhello\n', '\n'];
  // Strips *all* leading markers: a list marker placed in front of a heading line is legal input.
  const stripMarker = (line) =>
    line.replace(/^(?:(?:#{1,6}|[-*+]|\d+[.)]|>)\s+(?:\[[ xX]\]\s+)?|\s{1,2})*/, '').trim();
  const tail = (text) => text.split('\n').slice(1).join('\n');

  for (const text of bodies) {
    for (const id of ['ul', 'ol', 'task', 'list', 'quote', 'heading1', 'indent', 'outdent', 'hr']) {
      const out = runCommand(id, text, sel(0));
      if (id === 'hr') {
        // A rule is an insertion, not a line rewrite: it goes on its own line and pushes the
        // document down, so the invariant is that the document is preserved as a suffix.
        assert.ok(
          out.text.endsWith(text),
          `hr on ${JSON.stringify(text)} did not keep the document: ${JSON.stringify(out.text)}`,
        );
        continue;
      }
      const original = stripMarker(text.split('\n')[0]);
      const produced = stripMarker(out.text.split('\n')[0]);
      assert.ok(
        original === '' || produced === original,
        `${id} on ${JSON.stringify(text)} rewrote the body of the first line: ${JSON.stringify(out.text)}`,
      );
      assert.equal(
        tail(out.text),
        tail(text),
        `${id} on ${JSON.stringify(text)} touched a line outside the selection: ${JSON.stringify(out.text)}`,
      );
      assert.deepEqual(selectionRange(out.selection), { from: out.selection.anchor, to: out.selection.head });
      assert.ok(out.selection.anchor <= out.text.length && out.selection.head <= out.text.length);
    }
  }
});

test('a selection that covers only the leading newline still lands on a real line', () => {
  const text = '\nhello\n';
  const out = setList(text, sel(0, 1), 'ul');
  assert.equal(out.text, '- \nhello\n');
  assert.equal(
    runCommand('ul', text, sel(0, 1)).selection.anchor <= out.text.length,
    true,
    'the remapped selection stays inside the text',
  );
});

// --- minimal change --------------------------------------------------------

test('the minimal change is the byte range the command really touched', () => {
  const change = minimalChange('one\ntwo\n', 'one\nTWO\n');
  assert.deepEqual(change, { from: 4, to: 7, insert: 'TWO' });
  assert.equal(minimalChange('same', 'same'), null);
});
