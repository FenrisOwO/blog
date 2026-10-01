// P1.1 acceptance tests.
//
// The corpus is the fixture site (test/fixtures/README.md), which no editor wrote by hand and
// which the tests own, so "no-op save is byte-identical" is measured on documents the test
// suite controls.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { splitDocument, readDocument, saveDocument } from '../src/frontmatter/index.js';
import { FIXTURE, FIXTURE_CONTENT } from './fixtures/harness.js';

const CONTENT_ROOT = FIXTURE_CONTENT;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

const FILES = walk(CONTENT_ROOT);
const SAMPLE = join(CONTENT_ROOT, FIXTURE.article);

function changedLines(before, after) {
  const left = before.split('\n');
  const right = after.split('\n');
  if (left.length !== right.length) return Number.POSITIVE_INFINITY;
  let count = 0;
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) count += 1;
  return count;
}

test('T1: split -> join is byte-identical for every existing file', () => {
  assert.ok(FILES.length >= 20, `corpus too small: ${FILES.length}`);
  for (const file of FILES) {
    const text = readFileSync(file, 'utf8');
    const parts = splitDocument(text);
    assert.ok(parts.hasFrontMatter, `missing front matter: ${file}`);
    assert.equal(joinDocumentFor(parts), text, `round-trip failed: ${file}`);
  }
});

function joinDocumentFor(parts) {
  return parts.frontMatterRaw + parts.separator + parts.bodyRaw;
}

test('T1b: a no-op save returns the original bytes', () => {
  for (const file of FILES) {
    const text = readFileSync(file, 'utf8');
    assert.equal(saveDocument(text, {}), text, `empty change set: ${file}`);
    assert.equal(saveDocument(text, readDocument(text).values), text, `echo decoded values: ${file}`);
  }
});

test('T7: saving the same change twice is idempotent', () => {
  const text = readFileSync(SAMPLE, 'utf8');
  const title = readDocument(text).values.title;
  const once = saveDocument(text, { title: `${title} (edited)` });
  const twice = saveDocument(once, { title: `${title} (edited)` });
  assert.equal(twice, once);
});

test('T2: editing only the title touches exactly one line', () => {
  const text = readFileSync(SAMPLE, 'utf8');
  const next = saveDocument(text, { title: '改过的标题' });

  const slug = readDocument(text).values.slug;
  assert.equal(changedLines(text, next), 1);
  assert.match(next, /title: 改过的标题\n/);
  assert.match(next, new RegExp(`slug: ${slug}\\n`), 'the slug line is untouched');
  assert.equal(splitDocument(next).bodyRaw, splitDocument(text).bodyRaw);
  assert.equal(changedLines(splitDocument(text).frontMatterRaw, splitDocument(next).frontMatterRaw), 1);
});

test('T2b: unknown keys, nested maps, comments and order are preserved', () => {
  const original = [
    '---',
    'title: 原文',
    'date: 2026-01-26',
    'custom_field: keep-me',
    'params:',
    '  nested:',
    '    deep: value',
    '# a comment line',
    'draft: false',
    'tags:',
    '    - alpha',
    '    - beta',
    '---',
    '',
    'Body line with {{< quote >}} shortcode and $x^2$.',
    '',
  ].join('\n');

  const next = saveDocument(original, { title: '新标题' });

  assert.match(next, /^---\ntitle: 新标题\n/);
  assert.match(next, /custom_field: keep-me\n/);
  assert.match(next, /params:\n  nested:\n    deep: value\n/);
  assert.match(next, /# a comment line\n/);
  assert.match(next, /tags:\n    - alpha\n    - beta\n/);
  assert.match(next, /\{\{< quote >\}\} shortcode and \$x\^2\$\./);
  assert.equal(changedLines(original, next), 1);
});

test('list fields keep their original indentation and leave siblings alone', () => {
  const text = readFileSync(SAMPLE, 'utf8');
  const { title, categories } = readDocument(text).values;
  const next = saveDocument(text, { tags: ['pagination', 'test', '新增'] });

  // The fixture article writes its lists with two spaces, and the rewrite keeps that.
  assert.match(next, /tags:\n  - pagination\n  - test\n  - 新增\n/);
  assert.match(next, new RegExp(`title: ${title}\\n`));
  assert.match(next, new RegExp(`categories:\\n  - ${categories[0]}\\n`));
  assert.equal(splitDocument(next).bodyRaw, splitDocument(text).bodyRaw);
});

test('missing keys are never invented (P1 stays conservative)', () => {
  const original = ['---', 'title: Only Title', '---', '', 'body', ''].join('\n');
  const next = saveDocument(original, { tags: ['a'] });
  assert.equal(next, original);
});

test('editing the body keeps front matter untouched', () => {
  const text = readFileSync(SAMPLE, 'utf8');
  const parts = splitDocument(text);
  const next = saveDocument(text, {}, `${parts.bodyRaw}\nnew paragraph\n`);
  assert.equal(splitDocument(next).frontMatterRaw, parts.frontMatterRaw);
  assert.match(next, /new paragraph/);
});
