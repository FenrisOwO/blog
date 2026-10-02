// Phase 8: modern editing must not damage Hugo Markdown.
//
// The command engine is pure text, so preservation is testable exactly: apply a command in
// one paragraph and assert that every byte outside it - front matter, comments, raw HTML,
// shortcodes, Mermaid, math, footnotes, fenced code, `<!--more-->` - came back untouched.
// Two fixtures are used: a document that contains one of everything, and the fixture
// corpus's Markdown document, which is where those constructs actually live.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readDocument, splitDocument } from '../src/frontmatter/index.js';
import { continueBlock, minimalChange, runCommand, runSlashCommand, toggleBold } from '../src/editorCore/markdown.js';
import { FIXTURE as FIXTURE_DOCS, FIXTURE_SITE } from './fixtures/harness.js';

const MARKDOWN_DOC = join(FIXTURE_SITE, 'content', FIXTURE_DOCS.markdown);

const FIXTURE = `---
title: "Everything"
description: A document with one of every construct
date: 2026-01-02
tags:
  - markdown
  - test
categories:
  - Documentation
slug: everything
draft: false
custom_unknown_field:
  nested: true
  list: [1, 2, 3]
---

# Heading with a {{< myshortcode >}} inside

Paragraph one has the words we will edit.

<!--more-->

## Code

\`\`\`javascript
const bold = '**not markdown**';
\`\`\`

## Math

Inline $E = mc^2$ and a block:

$$
\\int_0^1 x^2 dx
$$

## Raw HTML

<div class="custom" data-x="1">
  <span>keep me byte-identical</span>
</div>

## Mermaid

\`\`\`mermaid
graph TD;
  A-->B;
\`\`\`

## Footnote

A claim with a footnote[^1].

[^1]: The footnote text.

## Table and shortcode

| a | b |
| - | - |
| 1 | 2 |

{{< figure src="photo.webp" title="A figure" >}}
`;

function paragraphRange(text, needle) {
  const from = text.indexOf(needle);
  assert.notEqual(from, -1, `fixture is missing ${needle}`);
  return { from, to: from + needle.length };
}

test('a body edit leaves the whole document byte-identical except for the marked words', () => {
  const before = FIXTURE;
  const { from, to } = paragraphRange(before, 'the words we will edit');
  const out = toggleBold(before, { anchor: from, head: to });
  assert.equal(out.text.slice(0, from), before.slice(0, from));
  // `**` before and `**` after the selection: the untouched suffix starts four characters
  // later in the new text than it did in the old one.
  assert.equal(out.text.slice(to + 4), before.slice(to), 'everything after the edit is untouched');
  assert.equal(out.text.slice(from, to + 4), '**the words we will edit**');

  const change = minimalChange(before, out.text);
  assert.deepEqual(
    { from: change.from, to: change.to },
    { from, to },
    'the reported change is exactly the selected words',
  );
});

test('the front matter is never part of a body command', () => {
  const { from, to } = paragraphRange(FIXTURE, 'the words we will edit');
  const out = runCommand('italic', FIXTURE, { anchor: from, head: to });
  const before = splitDocument(FIXTURE);
  const after = splitDocument(out.text);
  assert.equal(after.frontMatterRaw, before.frontMatterRaw);
  assert.equal(after.frontMatterRaw.includes('custom_unknown_field'), true);
  assert.equal(after.bodyRaw.startsWith('\n# Heading'), true);
});

test('the document still parses and keeps every construct it had', () => {
  const { from, to } = paragraphRange(FIXTURE, 'Paragraph one');
  const out = runCommand('heading2', FIXTURE, { anchor: from, head: to });
  const parsed = readDocument(out.text);
  assert.equal(parsed.values.title, 'Everything');
  assert.deepEqual(parsed.values.tags, ['markdown', 'test']);
  assert.equal(
    parsed.frontMatterRaw.includes('custom_unknown_field'),
    true,
    'unknown fields survive',
  );
  for (const marker of ['{{< myshortcode >}}', '<!--more-->', '```mermaid', '$$', '[^1]', '<div class="custom"', '{{< figure']) {
    assert.equal(out.text.includes(marker), true, `lost ${marker}`);
  }
});

test('every command is confined to the lines the user selected', () => {
  // The real preservation property: whatever happens to the paragraph the caret is in, no
  // byte before it and no byte after it moves. This is what keeps front matter, shortcodes,
  // Mermaid, math, footnotes, raw HTML and fenced code safe from a toolbar button.
  const { from, to } = paragraphRange(FIXTURE, 'Paragraph one has the words we will edit.');
  const lineFrom = FIXTURE.lastIndexOf('\n', from) + 1;
  const lineTo = FIXTURE.indexOf('\n', to);
  const prefix = FIXTURE.slice(0, lineFrom);
  const suffix = FIXTURE.slice(lineTo);

  const cases = [
    ['bold', { anchor: from, head: to }, undefined],
    ['italic', { anchor: from, head: to }, undefined],
    ['strike', { anchor: from, head: to }, undefined],
    ['inlineCode', { anchor: from, head: to }, undefined],
    ['heading1', { anchor: from, head: from }, undefined],
    ['heading3', { anchor: from, head: from }, undefined],
    ['quote', { anchor: from, head: from }, undefined],
    ['ul', { anchor: from, head: from }, undefined],
    ['ol', { anchor: from, head: from }, undefined],
    ['task', { anchor: from, head: from }, undefined],
    ['hr', { anchor: from, head: from }, undefined],
    ['link', { anchor: from, head: to }, { url: 'https://example.com' }],
    ['image', { anchor: from, head: to }, { src: 'photo.webp', alt: 'photo' }],
    ['table', { anchor: from, head: from }, { cols: 2, rows: 1 }],
    ['codeBlock', { anchor: from, head: to }, { language: 'text' }],
    ['indent', { anchor: from, head: from }, undefined],
    ['outdent', { anchor: from, head: from }, undefined],
  ];

  for (const [id, selection, arg] of cases) {
    const out = runCommand(id, FIXTURE, selection, arg);
    assert.equal(out.text.startsWith(prefix), true, `${id} changed a byte before the line`);
    assert.equal(out.text.endsWith(suffix), true, `${id} changed a byte after the line`);
    assert.equal(
      splitDocument(out.text).frontMatterRaw,
      splitDocument(FIXTURE).frontMatterRaw,
      `${id} touched the front matter`,
    );
    if (id !== 'outdent') assert.notEqual(out.text, FIXTURE, `${id} did nothing at all`);
  }
});

test('the fixture Markdown document survives every command, byte for byte', () => {
  const text = readFileSync(MARKDOWN_DOC, 'utf8');
  const frontMatter = splitDocument(text).frontMatterRaw;
  const anchor = text.indexOf('## ');
  assert.ok(anchor > 0);

  for (const id of ['heading1', 'heading2', 'bold', 'italic', 'quote', 'ul', 'ol', 'task', 'hr']) {
    const out = runCommand(id, text, { anchor, head: anchor });
    assert.equal(splitDocument(out.text).frontMatterRaw, frontMatter, `${id} touched the front matter`);
    // Only the line the caret was on may differ.
    const change = minimalChange(text, out.text);
    assert.ok(change === null || change.from >= anchor - 1, `${id} changed something before the caret`);
    assert.ok(change === null || change.to <= text.indexOf('\n', anchor) + 1, `${id} changed a later line`);
  }
});

// --- the front matter is YAML, so no command writes Markdown into it ---------
//
// This is the defect these tests exist for. The image helper used to write `![alt](src)`
// wherever the caret happened to be - and the caret can be inside the front matter, because the
// editor edits the whole document. That is how a links page came back with
// `image: ![](大号头像.jpg)` in its YAML and a Hugo build that refused to run.

const LINKS_LIKE = [
  '---',
  'title: "链接"',
  'links:',
  '  - title: QQ-主号',
  '    image: 大号头像.jpg',
  'menu:',
  '  main:',
  '    weight: -50',
  '---',
  '',
  '正文里的图片：![](keep-me.jpg)',
  '',
].join('\n');

test('every command is refused inside the front matter, and the YAML is untouched', () => {
  const caret = paragraphRange(LINKS_LIKE, '大号头像.jpg').from;
  const cases = [
    ['image', { src: 'example.jpg', alt: '' }],
    ['link', { url: 'https://example.com' }],
    ['table', { cols: 2, rows: 1 }],
    ['codeBlock', { language: 'text' }],
    ['heading1', undefined],
    ['ul', undefined],
    ['task', undefined],
    ['hr', undefined],
    ['bold', undefined],
  ];

  for (const [id, arg] of cases) {
    const out = runCommand(id, LINKS_LIKE, { anchor: caret, head: caret }, arg);
    assert.equal(out.blocked, 'front-matter', `${id} was not refused inside the front matter`);
    assert.equal(out.text, LINKS_LIKE, `${id} changed a byte inside the front matter`);
  }

  const out = runCommand('image', LINKS_LIKE, { anchor: caret, head: caret }, { src: 'example.jpg' });
  // The body's own `![](keep-me.jpg)` is still there - what must not appear is Markdown inside
  // the YAML, so the check is the front-matter region, not the whole file.
  assert.equal(splitDocument(out.text).frontMatterRaw.includes('!['), false, 'no Markdown may reach the YAML');
  assert.equal(splitDocument(out.text).hasFrontMatter, true, 'the document must still parse');
});

test('a selection that reaches into the front matter from the body is refused too', () => {
  const from = LINKS_LIKE.indexOf('menu:');
  const to = LINKS_LIKE.indexOf('正文');
  const out = runCommand('bold', LINKS_LIKE, { anchor: from, head: to + 2 });
  assert.equal(out.blocked, 'front-matter');
  assert.equal(out.text, LINKS_LIKE);
});

test('the body still gets Markdown: same helper, body caret', () => {
  const caret = paragraphRange(LINKS_LIKE, '正文里的图片').from;
  const out = runCommand('image', LINKS_LIKE, { anchor: caret, head: caret }, { src: 'example.jpg', alt: '' });
  assert.equal(out.blocked, undefined, 'the body is not the front matter');
  assert.equal(out.text.includes('![](example.jpg)'), true);
  // The front matter is still exactly what it was, and the body's own image stayed put.
  assert.equal(splitDocument(out.text).frontMatterRaw, splitDocument(LINKS_LIKE).frontMatterRaw);
  assert.equal(out.text.includes('![](keep-me.jpg)'), true);
});

test('the slash menu keeps the typed query when it refuses, and Enter is a plain newline', () => {
  const typed = LINKS_LIKE.replace('    image: 大号头像.jpg', '    image: 大号头像.jpg /im');
  const caret = typed.indexOf('/im') + 3;
  const slash = runSlashCommand('image', typed, { anchor: caret, head: caret }, { src: 'example.jpg' });
  assert.equal(slash.blocked, 'front-matter');
  assert.equal(slash.text, typed, 'the refused command must not eat the typed /im');

  // Enter inside a `- title:` line is a newline, not the `- ` of a Markdown list item.
  assert.equal(continueBlock(LINKS_LIKE, { anchor: caret, head: caret }), null);
});
