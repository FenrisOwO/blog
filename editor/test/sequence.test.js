// Phase 7 groundwork: the structured view of a YAML block sequence.
//
// The promise this module makes is narrow and testable: it can find each item of a list and
// each field of a list item, and it can change one of them without touching a single other
// byte. Every test below therefore checks the *whole* document, not just the changed value -
// a rewrite that is correct but not minimal would pass a naive test and fail the user.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { formatString } from '../src/frontmatter/patch.js';
import { parseFrontMatter } from '../src/frontmatter/parse.js';
import { joinDocument, splitDocument } from '../src/frontmatter/split.js';
import {
  insertItem,
  moveItem,
  parseSequenceBlock,
  removeItem,
  renderMapItem,
  rewriteInlineItems,
  rewriteScalarItems,
  scalarValues,
  setMapItemField,
  setScalarItem,
} from '../src/frontmatter/sequence.js';

const SITE_ROOT = '/projects/site';
const LINKS = join(SITE_ROOT, 'content', 'page', 'links', 'index.md');
const MARKDOWN_EN = join(SITE_ROOT, 'content', 'post', 'Markdown Syntax', 'index.en.md');
const PAGINATION = join(SITE_ROOT, 'content', 'post', 'pagination-test-01.en.md');

function blockOf(text, key) {
  const parts = splitDocument(text);
  const entry = parseFrontMatter(parts.frontMatterRaw).byKey.get(key);
  assert.ok(entry, `front matter has no ${key}`);
  return { parts, entry, block: parts.frontMatterRaw.slice(entry.start, entry.end) };
}

function replaceBlock(parts, entry, block) {
  return joinDocument({
    frontMatterRaw: `${parts.frontMatterRaw.slice(0, entry.start)}${block}${parts.frontMatterRaw.slice(entry.end)}`,
    separator: parts.separator,
    bodyRaw: parts.bodyRaw,
  });
}

test('parses a real list of maps with its own indentation', () => {
  const { block } = blockOf(readFileSync(LINKS, 'utf8'), 'links');
  const parsed = parseSequenceBlock(block);

  assert.equal(parsed.key, 'links');
  assert.equal(parsed.style, 'block');
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.itemIndent, '  ');
  assert.equal(parsed.fieldIndent, '    ');
  assert.equal(parsed.items[0].kind, 'map');
  assert.deepEqual(
    parsed.items[0].fields.map((field) => `${field.key}=${field.value}`),
    [
      'title=GitHub',
      'description=GitHub 是世界上最大的软件开发平台。',
      'website=https://github.com',
      'image=https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png',
    ],
  );
  assert.equal(parsed.items[1].fields.find((field) => field.key === 'image').value, 'ts-logo-128.jpg');
});

test('editing a link field changes one line and nothing else', () => {
  const original = readFileSync(LINKS, 'utf8');
  const { parts, entry, block } = blockOf(original, 'links');
  const parsed = parseSequenceBlock(block);
  const next = setMapItemField(block, parsed.items[1], 'description', 'TypeScript 是 JavaScript 的超集。', { format: formatString });
  const saved = replaceBlock(parts, entry, next);

  const before = original.split('\n');
  const after = saved.split('\n');
  assert.equal(before.length, after.length);
  const changed = before.map((line, index) => (line === after[index] ? null : index)).filter((index) => index !== null);
  assert.equal(changed.length, 1);
  assert.match(after[changed[0]], /^ {4}description: TypeScript 是 JavaScript 的超集。$/);

  // The body, the delimiter and every other key are byte-identical.
  const reparsed = splitDocument(saved);
  assert.equal(reparsed.bodyRaw, parts.bodyRaw);
  assert.equal(reparsed.delimiter, parts.delimiter);
  assert.equal(
    reparsed.frontMatterRaw.replace('TypeScript 是 JavaScript 的超集。', 'TypeScript 是 JavaScript 的一个超集，它可以编译成纯 JavaScript。'),
    parts.frontMatterRaw,
  );
});

test('a sequence keeps its own list indentation when an item is rewritten', () => {
  const fourSpaces = blockOf(readFileSync(MARKDOWN_EN, 'utf8'), 'tags');
  const parsedFour = parseSequenceBlock(fourSpaces.block);
  assert.equal(parsedFour.itemIndent, '    ');
  assert.deepEqual(scalarValues(parsedFour), ['markdown', 'css', 'html', 'themes']);

  const twoSpaces = blockOf(readFileSync(PAGINATION, 'utf8'), 'tags');
  const parsedTwo = parseSequenceBlock(twoSpaces.block);
  assert.equal(parsedTwo.itemIndent, '  ');
  assert.deepEqual(scalarValues(parsedTwo), ['pagination', 'test']);
});

test('adding a tag appends one line and reuses every existing line byte-for-byte', () => {
  const { block } = blockOf(readFileSync(MARKDOWN_EN, 'utf8'), 'tags');
  const parsed = parseSequenceBlock(block);
  const next = rewriteScalarItems(block, parsed, [...scalarValues(parsed), 'acceptance'], { format: formatString });

  assert.equal(next, `${block}    - acceptance\n`);
});

test('renaming a tag rewrites only that item', () => {
  const { block } = blockOf(readFileSync(MARKDOWN_EN, 'utf8'), 'tags');
  const parsed = parseSequenceBlock(block);
  const next = rewriteScalarItems(block, parsed, ['markdown', 'css', 'html', 'Themes'], { format: formatString });
  assert.equal(next, block.replace('    - themes\n', '    - Themes\n'));
});

test('removing a tag removes its line and keeps the rest', () => {
  const { block } = blockOf(readFileSync(PAGINATION, 'utf8'), 'tags');
  const parsed = parseSequenceBlock(block);
  const next = rewriteScalarItems(block, parsed, ['pagination'], { format: formatString });
  assert.equal(next, 'tags:\n  - pagination\n');
});

test('a no-op rewrite is byte-identical', () => {
  const { block } = blockOf(readFileSync(MARKDOWN_EN, 'utf8'), 'tags');
  const parsed = parseSequenceBlock(block);
  assert.equal(rewriteScalarItems(block, parsed, scalarValues(parsed), { format: formatString }), block);
  assert.equal(setScalarItem(block, parsed.items[0], 'markdown', { format: formatString }), block);
});

test('a scalar item keeps its comment, quotes and separator', () => {
  const block = 'tags:\n  - "Hugo" # the static site generator\n  - Editor\n';
  const parsed = parseSequenceBlock(block);
  assert.deepEqual(scalarValues(parsed), ['Hugo', 'Editor']);
  assert.equal(setScalarItem(block, parsed.items[0], 'Hugo Editor', { format: formatString }), 'tags:\n  - Hugo Editor # the static site generator\n  - Editor\n');
  // A value that YAML would read as a number keeps its string meaning.
  assert.equal(setScalarItem(block, parsed.items[1], '2024', { format: formatString }), 'tags:\n  - "Hugo" # the static site generator\n  - "2024"\n');
});

test('comments and blank lines inside the block survive an edit', () => {
  const block = 'tags:\n  # keep this note\n  - Hugo\n\n  - Editor\n';
  const parsed = parseSequenceBlock(block);
  assert.deepEqual(scalarValues(parsed), ['Hugo', 'Editor']);
  // The note, the blank line and the untouched item are all still there, in order.
  assert.equal(rewriteScalarItems(block, parsed, ['Hugo', 'Editor', 'Site'], { format: formatString }), `${block}  - Site\n`);
  assert.equal(rewriteScalarItems(block, parsed, ['Hugo Editor', 'Editor'], { format: formatString }), block.replace('- Hugo\n', '- Hugo Editor\n'));
  assert.equal(rewriteScalarItems(block, parsed, ['Editor'], { format: formatString }), 'tags:\n  # keep this note\n\n  - Editor\n');
});

test('an inline sequence is rewritten as one line', () => {
  const block = 'tags: [Hugo, Editor]\n';
  const parsed = parseSequenceBlock(block);
  assert.equal(parsed.style, 'inline');
  assert.deepEqual(scalarValues(parsed), ['Hugo', 'Editor']);
  assert.equal(rewriteInlineItems(block, parsed, ['Hugo Editor', 'Site'], { format: formatString }), 'tags: [Hugo Editor, Site]\n');
});

test('an empty sequence gains its first item at the block indentation', () => {
  const block = 'tags:\n';
  const parsed = parseSequenceBlock(block);
  assert.equal(parsed.style, 'empty');
  assert.equal(rewriteScalarItems(block, parsed, ['Hugo'], { format: formatString }), 'tags:\n  - Hugo\n');
});

test('items can be inserted, removed and moved without disturbing the others', () => {
  const { block } = blockOf(readFileSync(LINKS, 'utf8'), 'links');
  const parsed = parseSequenceBlock(block);
  const rendered = renderMapItem(
    [
      { key: 'title', value: 'Example' },
      { key: 'description', value: 'A new link' },
      { key: 'website', value: 'https://example.com' },
    ],
    { itemIndent: parsed.itemIndent, fieldIndent: parsed.fieldIndent, format: formatString },
  );

  const inserted = insertItem(block, parsed, 2, rendered);
  const insertedParsed = parseSequenceBlock(inserted);
  assert.equal(insertedParsed.items.length, 3);
  assert.equal(insertedParsed.items[2].fields[0].value, 'Example');
  assert.equal(inserted.slice(0, block.length - 1), block.slice(0, block.length - 1));

  const removed = removeItem(inserted, insertedParsed.items[1]);
  assert.ok(!removed.includes('TypeScript'));
  assert.ok(removed.includes('    description: GitHub 是世界上最大的软件开发平台。'));
  assert.deepEqual(parseSequenceBlock(removed).items.map((item) => item.fields[0].value), ['GitHub', 'Example']);

  const moved = moveItem(inserted, insertedParsed, 0, 2);
  const movedParsed = parseSequenceBlock(moved);
  assert.deepEqual(
    movedParsed.items.map((item) => item.fields[0].value),
    ['TypeScript', 'Example', 'GitHub'],
  );
  // The item that moved kept its bytes, including its description line.
  assert.ok(moved.includes('    description: GitHub 是世界上最大的软件开发平台。'));
});
