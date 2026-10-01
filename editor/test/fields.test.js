// P3.2 acceptance tests: the front-matter field model and its surgical edits.
//
// The corpus is the fixture site (test/fixtures/README.md), which the tests own. The
// load-bearing test is the last one:
// feeding every field back with the value it already has must reproduce the file byte for
// byte, which is what proves the form cannot reformat a document nobody edited.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { applyFieldEdits, describeFields, missingFields, splitDocument } from '../src/frontmatter/index.js';
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

const FILES = walk(CONTENT_ROOT).sort();
const read = (relPath) => readFileSync(join(CONTENT_ROOT, relPath), 'utf8');

const ABOUT = FIXTURE.page;
const LINKS = FIXTURE.links;
const CATEGORY = FIXTURE.category;
const GALLERY = FIXTURE.bundle;
const HOME = FIXTURE.home;

function changedLines(before, after) {
  const left = before.split('\n');
  const right = after.split('\n');
  if (left.length !== right.length) return Number.POSITIVE_INFINITY;
  let count = 0;
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) count += 1;
  return count;
}

function fieldByPath(frontMatterRaw, path) {
  return describeFields(frontMatterRaw).fields.find((field) => field.path === path);
}

test('a map-valued key is never offered for writing, and its scalar children are', () => {
  const raw = splitDocument(read(HOME)).frontMatterRaw;
  const menu = fieldByPath(raw, 'menu');
  assert.equal(menu.shape, 'map');
  assert.equal(menu.editable, false);
  assert.equal(menu.editor, 'readonly');
  assert.match(menu.reason, /嵌套映射/);

  // The home page has nothing but menu, and its real leaves are reachable one by one.
  const paths = describeFields(raw).fields.map((field) => field.path);
  assert.ok(paths.includes('menu.main.name'));
  assert.ok(paths.includes('menu.main.weight'));
  assert.ok(paths.includes('menu.main.params'));
  assert.ok(paths.includes('menu.main.params.icon'));

  assert.equal(fieldByPath(raw, 'menu.main.weight').editable, true);
  assert.equal(fieldByPath(raw, 'menu.main.weight').value, -100);
  assert.equal(fieldByPath(raw, 'menu.main.params.icon').value, 'home');
  assert.equal(fieldByPath(raw, 'menu.main.params').editable, false);
});

test('a sequence of maps (links) is shown but never rewritten by the form', () => {
  const raw = splitDocument(read(LINKS)).frontMatterRaw;
  const links = fieldByPath(raw, 'links');
  assert.equal(links.shape, 'list-of-maps');
  assert.equal(links.editable, false);
  assert.match(links.reason, /一组映射/);

  const result = applyFieldEdits(read(LINKS), { set: { links: ['GitHub'] } });
  assert.equal(result.changed, false);
  assert.equal(result.text, read(LINKS), 'refusing to write must leave the file untouched');
  assert.deepEqual(result.skipped.map((entry) => entry.path), ['links']);
});

test('a nested map of scalars (style) exposes exactly its scalar children', () => {
  const raw = splitDocument(read(CATEGORY)).frontMatterRaw;
  assert.equal(fieldByPath(raw, 'style').shape, 'map');
  // The fixture's style map: two scalars, exposed one by one.
  assert.equal(fieldByPath(raw, 'style.background').value, '#2a9d8f');
  assert.equal(fieldByPath(raw, 'style.color').value, '#fff');

  const next = applyFieldEdits(read(CATEGORY), { set: { 'style.background': '#123456' } });
  assert.equal(changedLines(read(CATEGORY), next.text), 1);
  assert.match(next.text, /    background: "#123456"/);
  assert.match(next.text, /    color: "#fff"/);
  assert.equal(splitDocument(next.text).bodyRaw, splitDocument(read(CATEGORY)).bodyRaw);
});

test('editing one field rewrites one line and leaves every sibling byte-identical', () => {
  const before = read(GALLERY);
  const image = before.match(/^image: (.+)$/m)[1];
  const next = applyFieldEdits(before, { set: { title: '相册（改名）' } });

  assert.equal(changedLines(before, next.text), 1);
  assert.match(next.text, /title: 相册（改名）\n/);
  assert.match(next.text, new RegExp(`image: ${image}\\n`), 'the image field is untouched');
  assert.match(next.text, /toc: false\n/);
  assert.equal(splitDocument(next.text).bodyRaw, splitDocument(before).bodyRaw);
  assert.deepEqual(next.applied, [{ path: 'title', action: 'update' }]);
  assert.deepEqual(next.skipped, []);
});

test('a field the file does not have yet is appended, and nothing above it moves', () => {
  const before = read(HOME);
  const next = applyFieldEdits(before, { set: { title: '主页', draft: false } });

  // Appended after the original front matter, before the closing delimiter.
  assert.match(
    next.text,
    /^---\nmenu:\n {4}main:\n {8}name: 主页\n {8}weight: -100\n {8}params:\n {12}icon: home\ntitle: 主页\ndraft: false\n---/,
  );
  assert.ok(next.text.includes('menu:\n    main:\n        name: 主页\n        weight: -100\n        params:\n            icon: home\n'));
  assert.equal(splitDocument(next.text).bodyRaw, splitDocument(before).bodyRaw);
  assert.deepEqual(
    next.applied.map((entry) => entry.action),
    ['create', 'create'],
  );

  const again = applyFieldEdits(next.text, { set: { title: '主页' } });
  assert.equal(again.changed, false, 're-applying the same value is a no-op');
});

test('a new list uses the file\'s own indentation', () => {
  const before = read(GALLERY);
  assert.match(before, /categories:\n {4}- Fixture/);

  const next = applyFieldEdits(before, { set: { tags: ['相册', 'gallery'] } });
  // The file already uses a four-space list indent, so the rewrite keeps it.
  assert.match(next.text, /tags:\n {4}- 相册\n {4}- gallery\n/);
});

test('a text field keeps string meaning, a booleanOrText field does not', () => {
  const before = ['---', 'title: x', 'license: false', '---', '', 'body', ''].join('\n');

  const text = applyFieldEdits(before, { set: { title: 'false' } });
  assert.match(text.text, /title: "false"\n/, 'typing false into a text field must stay a string');

  const license = applyFieldEdits(before, { set: { license: 'false' } });
  assert.match(license.text, /license: false\n/, 'license=false is the theme\'s switch');

  const licenseText = applyFieldEdits(before, { set: { license: 'CC BY 4.0' } });
  assert.match(licenseText.text, /license: CC BY 4\.0\n/);
});

test('numbers and other YAML-shaped strings are quoted where the shape says string', () => {
  const before = ['---', 'title: x', 'slug: y', '---', '', 'body', ''].join('\n');
  const next = applyFieldEdits(before, { set: { slug: '123' } });
  assert.match(next.text, /slug: "123"\n/);
});

test('a nested path is only ever rewritten in place, never created or removed', () => {
  const before = read(HOME);

  const missing = applyFieldEdits(before, { set: { 'menu.footer.weight': 10 } });
  assert.equal(missing.changed, false);
  assert.match(missing.skipped[0].reason, /嵌套路径不存在/);

  const deep = applyFieldEdits(before, { set: { 'menu.main.params.icon.deep.deeper': 'x' } });
  assert.equal(deep.changed, false);
  assert.equal(deep.skipped.length, 1);

  const removal = applyFieldEdits(before, { remove: ['menu.main.weight'] });
  assert.equal(removal.changed, false);
  assert.match(removal.skipped[0].reason, /只能删除顶层字段/);
});

test('a bare leaf name is corrected to its full path instead of becoming a top-level key', () => {
  const before = read(HOME);

  // `weight` exists as menu.main.weight; creating a second top-level `weight` would be a
  // silent misunderstanding of what was asked for.
  for (const typed of ['weight', 'name', 'main.weight', 'main.params.icon']) {
    const result = applyFieldEdits(before, { set: { [typed]: 1 } });
    assert.equal(result.changed, false, typed);
    assert.equal(result.skipped.length, 1, typed);
    assert.match(result.skipped[0].reason, /完整路径/, typed);
  }

  // The full path the hint names is accepted.
  const correct = applyFieldEdits(before, { set: { 'menu.main.weight': 7 } });
  assert.deepEqual(correct.applied, [{ path: 'menu.main.weight', action: 'update' }]);
  assert.match(correct.text, /weight: 7\n/);

  // A key the document really has is never redirected.
  const topLevel = applyFieldEdits(before, { set: { draft: true } });
  assert.deepEqual(topLevel.applied, [{ path: 'draft', action: 'create' }]);
});

test('removing a top-level key is explicit and surgical', () => {
  const before = read(ABOUT);
  const next = applyFieldEdits(before, { remove: ['lastmod'] });

  const beforeLines = before.split('\n');
  const afterLines = next.text.split('\n');
  const lastmodLine = beforeLines.find((line) => line.startsWith('lastmod:'));
  assert.equal(afterLines.length, beforeLines.length - 1, 'exactly one line is gone');
  assert.deepEqual(afterLines, beforeLines.filter((line) => line !== lastmodLine));
  const dateLine = beforeLines.find((line) => line.startsWith('date:'));
  assert.ok(next.text.includes(`${dateLine}\n`), 'the sibling date is untouched');
  assert.deepEqual(next.applied, [{ path: 'lastmod', action: 'remove' }]);

  const missing = applyFieldEdits(before, { remove: ['nosuchkey'] });
  assert.equal(missing.changed, false);
  assert.match(missing.skipped[0].reason, /字段不存在/);
});

test('the form refuses to touch a document it cannot edit losslessly', () => {
  const toml = ['+++', 'title = "x"', '+++', '', 'body', ''].join('\n');
  const refused = applyFieldEdits(toml, { set: { title: 'y' } });
  assert.equal(refused.changed, false);
  assert.equal(refused.text, toml);
  assert.match(refused.skipped[0].reason, /只编辑 YAML/);

  const bare = 'no front matter at all\n';
  const bareResult = applyFieldEdits(bare, { set: { title: 'y' } });
  assert.equal(bareResult.changed, false);
  assert.match(bareResult.skipped[0].reason, /没有 front matter/);
});

test('a crafted key name cannot inject YAML structure', () => {
  const before = read(ABOUT);
  for (const path of ['x: 1\nhacked', 'a b', 'a.b.c.d.e', '../title', '']) {
    const result = applyFieldEdits(before, { set: { [path]: 'v' } });
    assert.equal(result.changed, false, path);
  }
  assert.equal(applyFieldEdits(before, { remove: ['title\nhacked: 1'] }).changed, false);
});

test('a field that is a scalar cannot be set to a list, or the other way round', () => {
  const before = read(GALLERY);

  const asList = applyFieldEdits(before, { set: { title: ['a', 'b'] } });
  assert.equal(asList.changed, false);
  assert.match(asList.skipped[0].reason, /不能写成列表/);

  const asScalar = applyFieldEdits(before, { set: { categories: 'Documentation' } });
  assert.equal(asScalar.changed, false);
  assert.match(asScalar.skipped[0].reason, /不能写成标量/);
});

test('the catalogue only offers to create what it can actually write', () => {
  const raw = splitDocument(read(HOME)).frontMatterRaw;
  const missing = missingFields(raw);

  assert.ok(missing.some((field) => field.key === 'title'));
  assert.ok(!missing.some((field) => field.key === 'menu'), 'menu is present');

  // A map key can never be created from a scalar input, so it must not be offered.
  const galleryMissing = missingFields(splitDocument(read(GALLERY)).frontMatterRaw);
  assert.equal(galleryMissing.find((field) => field.key === 'menu')?.creatable, false);
  assert.equal(galleryMissing.find((field) => field.key === 'author')?.creatable, true);
});

test('the field form is lossless on the fixture corpus', () => {
  // Every Markdown file of the fixture, so the test fails loudly if the corpus shrinks to
  // the point of proving nothing.
  assert.ok(FILES.length >= 20, `corpus too small: ${FILES.length}`);

  const broken = [];
  for (const file of FILES) {
    const text = readFileSync(file, 'utf8');
    const raw = splitDocument(text).frontMatterRaw;
    const { fields } = describeFields(raw);

    // Echo back every value the form just showed. Nothing may change.
    const set = {};
    for (const field of fields) {
      if (!field.editable || field.editor === 'readonly') continue;
      set[field.path] = field.value;
    }

    const result = applyFieldEdits(text, { set });
    if (result.text !== text) broken.push(`${file}: echoed values changed the file`);
    if (result.skipped.length > 0) broken.push(`${file}: unexpected skips ${result.skipped.map((s) => s.path).join(',')}`);
  }

  assert.deepEqual(broken, []);
});
