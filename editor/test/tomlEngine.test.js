// The TOML engine, on its own (Phase 5.1).
//
// The engine's whole job is to change one value and leave everything else alone, so the
// tests are mostly about what did NOT change: comments, blank lines, ordering, alignment,
// inline tables, arrays of tables, and files the editor has no opinion about.
//
// The fixture corpus's own config is used as the corpus, because that is where the awkward
// shapes are (multi-line arrays of inline tables, `[social.params]` inside `[[social]]`).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { readSiteLanguages } from '../src/site/contentReader.js';
import { FIXTURE_SITE } from './fixtures/harness.js';
import {
  applyAndVerify,
  applyTomlEdits,
  decodeValue,
  entryAt,
  formatValue,
  parseToml,
  planInsertArrayEntry,
  planInsertKey,
  planRemoveArrayEntry,
  planRemoveKey,
  planValueEdit,
  readToml,
  readValue,
  sameValue,
  scanValue,
  splitTopLevel,
  verifyMinimalRewrite,
} from '../src/settings/toml/index.js';

const CONFIG_DIR = join(FIXTURE_SITE, 'config', '_default');
const readConfig = (file) => readFileSync(join(CONFIG_DIR, file), 'utf8');

const CONFIG_FILES = ['hugo.toml', 'params.toml', 'menu.toml', 'languages.toml', 'markup.toml', 'related.toml'];

test('every fixture config file parses and reads back byte-identical', () => {
  for (const file of CONFIG_FILES) {
    const text = readConfig(file);
    const doc = readToml(text);
    assert.ok(doc.leaves.length > 0, `${file} should expose leaves`);
    // No edits: the file cannot have moved.
    const result = applyAndVerify(text, []);
    assert.equal(result.changed, false);
    assert.equal(result.text, text, `${file} must be untouched`);
  }
});

test('every value in the fixture config files decodes', () => {
  const undecodable = [];
  for (const file of CONFIG_FILES) {
    for (const leaf of readToml(readConfig(file)).leaves) {
      if (!leaf.ok) undecodable.push(`${file}:${leaf.path} (${leaf.reason})`);
    }
  }
  assert.deepEqual(undecodable, []);
});

test('scalars, tables and array-of-table entries are addressed the way the API says', () => {
  // The fixture's params.toml holds one of each shape this test names: a number, a string
  // and a boolean; the arrays live in related.toml and the arrays-of-tables in menu.toml.
  const params = readToml(readConfig('params.toml'));
  assert.equal(typeof params.values['footer.since'], 'number');
  assert.ok(params.values['sidebar.emoji'].length > 0);
  assert.equal(params.values['comments.enabled'], false);
  assert.deepEqual(readToml(readConfig('related.toml')).values['indices'], [
    { name: 'tags', weight: 100 },
    { name: 'categories', weight: 200 },
  ]);

  const menu = readToml(readConfig('menu.toml'));
  assert.equal(menu.values['social[0].identifier'], 'github');
  assert.equal(menu.values['social[1].params.icon'], 'rss');

  const languages = readToml(readConfig('languages.toml'));
  assert.ok(languages.values['en.params.sidebar.subtitle'].length > 0);
  assert.equal(languages.values['en.weight'], 2);
});

test('types are reported, including arrays and inline tables', () => {
  const byPath = new Map(readToml(readConfig('params.toml')).leaves.map((leaf) => [leaf.path, leaf]));
  assert.equal(byPath.get('footer.since').type, 'integer');
  assert.equal(byPath.get('rssFullContent').type, 'boolean');
  assert.equal(byPath.get('sidebar.emoji').type, 'string');

  // The fixture's only array-of-inline-tables lives in related.toml.
  const related = new Map(readToml(readConfig('related.toml')).leaves.map((leaf) => [leaf.path, leaf]));
  assert.equal(related.get('indices').type, 'array');
  assert.deepEqual(related.get('indices').value[1], { name: 'categories', weight: 200 });
});

test('decoding covers the value shapes Hugo configs use', () => {
  assert.deepEqual(decodeValue('"a\\nb"'), { ok: true, type: 'string', value: 'a\nb' });
  assert.deepEqual(decodeValue("'raw\\n'"), { ok: true, type: 'string', value: 'raw\\n' });
  assert.deepEqual(decodeValue('true'), { ok: true, type: 'boolean', value: true });
  assert.deepEqual(decodeValue('42'), { ok: true, type: 'integer', value: 42 });
  assert.deepEqual(decodeValue('-1.5e3'), { ok: true, type: 'float', value: -1500 });
  assert.deepEqual(decodeValue('[]'), { ok: true, type: 'array', value: [] });
  assert.deepEqual(decodeValue('[1, 2]'), { ok: true, type: 'array', value: [1, 2] });
  assert.deepEqual(decodeValue('[["a"], ["b", "c"]]'), { ok: true, type: 'array', value: [['a'], ['b', 'c']] });
  assert.deepEqual(decodeValue('{ a = 1, b = "x" }'), { ok: true, type: 'inline-table', value: { a: 1, b: 'x' } });
  assert.equal(decodeValue('1979-05-27').type, 'datetime');
  // A value the engine does not understand is reported, never guessed.
  assert.equal(decodeValue('@@@').ok, false);
  assert.equal(decodeValue('"unterminated').ok, false);
});

test('a comment after a value is not part of the value', () => {
  const text = 'key = "value" # keep me\n';
  const parsed = parseToml(text);
  const entry = entryAt(parsed, 'key');
  assert.equal(entry.rawValue, '"value"');
  assert.equal(entry.comment, '# keep me');

  const result = applyAndVerify(text, [planValueEdit(parsed, 'key', 'changed')]);
  assert.equal(result.text, 'key = "changed" # keep me\n');
});

test('changing one scalar leaves blank lines, ordering and the rest of the file alone', () => {
  const text = readConfig('params.toml');
  const before = text.split('\n');
  const parsed = parseToml(text);
  const result = applyAndVerify(text, [planValueEdit(parsed, 'sidebar.emoji', 'New emoji')]);

  assert.equal(readValue(result.text, 'sidebar.emoji'), 'New emoji');
  // Exactly one line differs, and it is the line that carries the value.
  const after = result.text.split('\n');
  assert.equal(after.length, before.length);
  const changed = before.filter((line, index) => line !== after[index]);
  assert.equal(changed.length, 1);
  assert.equal(after.find((line) => line.includes('emoji =')), '    emoji = "New emoji"');
  // The other keys and the blank lines between tables are byte-identical.
  const sinceLine = before.find((line) => line.trimStart().startsWith('since'));
  assert.ok(sinceLine !== undefined);
  assert.ok(result.text.split('\n').includes(sinceLine));
  assert.equal(
    after.filter((line) => line === '').length,
    before.filter((line) => line === '').length,
    'the blank lines between tables stay put',
  );
});

test('a no-op save returns the original string and writes nothing', () => {
  const text = readConfig('menu.toml');
  const parsed = parseToml(text);
  const edit = planValueEdit(parsed, 'social[0].name', 'GitHub');
  const result = applyAndVerify(text, [edit]);
  // The value did not change, so the edit rewrote the identical bytes.
  assert.equal(result.text, text);
  assert.equal(readValue(result.text, 'social[0].name'), 'GitHub');
});

test('numbers, booleans and string quoting are written the way TOML reads them back', () => {
  const text = readConfig('params.toml');
  const parsed = parseToml(text);

  const number = applyAndVerify(text, [planValueEdit(parsed, 'footer.since', 2019)]);
  assert.equal(readValue(number.text, 'footer.since'), 2019);
  assert.ok(number.text.includes('    since = 2019'));

  const bool = applyAndVerify(text, [planValueEdit(parseToml(number.text), 'rssFullContent', false)]);
  assert.equal(readValue(bool.text, 'rssFullContent'), false);

  // A string that looks like a boolean must stay a string.
  const tricky = applyAndVerify(text, [planValueEdit(parsed, 'comments.provider', 'true')]);
  assert.equal(readValue(tricky.text, 'comments.provider'), 'true');
  assert.ok(tricky.text.includes('provider = "true"'));

  const quoted = applyAndVerify(text, [planValueEdit(parsed, 'sidebar.emoji', 'He said "hi" \\ done')]);
  assert.equal(readValue(quoted.text, 'sidebar.emoji'), 'He said "hi" \\ done');
});

test('a multi-line array of inline tables is rewritten in the file\'s own style', () => {
  // related.toml is the fixture's multi-line array of inline tables.
  const text = readConfig('related.toml');
  const parsed = parseToml(text);
  const indices = [
    { name: 'tags', weight: 100 },
    { name: 'categories', weight: 300 },
  ];
  const result = applyAndVerify(text, [
    planValueEdit(parsed, 'indices', indices, { format: (value) => `[\n${value.map((i) => `    { ${Object.entries(i).map(([k, v]) => `${k} = ${formatValue(v)}`).join(', ')} },`).join('\n')}\n]` }),
  ]);

  assert.deepEqual(readValue(result.text, 'indices'), [
    { name: 'tags', weight: 100 },
    { name: 'categories', weight: 300 },
  ]);
  assert.ok(result.text.includes('indices      = [\n    { name = "tags", weight = 100 },\n'), 'keeps the one-per-line style');
  // The rest of the file is untouched.
  assert.ok(result.text.includes('threshold    = 60'));
  assert.ok(result.text.includes('toLower      = false'));
});

test('a key that does not exist is inserted at the end of its table, nothing above moving', () => {
  const text = readConfig('params.toml');
  const parsed = parseToml(text);
  const before = readToml(text).values;

  // Into a table that already exists: appended inside it, everything above untouched.
  const nested = applyAndVerify(text, [planInsertKey(parsed, 'sidebar.avatar', 'img/avatar.png')]);
  assert.equal(readValue(nested.text, 'sidebar.avatar'), 'img/avatar.png');
  assert.ok(nested.text.includes('    avatar = "img/avatar.png"'));
  // Inserted inside `[sidebar]`, which is not the last table: the file only gained the line.
  assert.equal(nested.text.replace('    avatar = "img/avatar.png"\n', ''), text);

  // A table the file does not have yet: created at the end of the file.
  const newTable = applyAndVerify(text, [planInsertKey(parsed, 'zzProbe.default', 'dark')]);
  assert.equal(readValue(newTable.text, 'zzProbe.default'), 'dark');
  assert.ok(newTable.text.includes('\n[zzProbe]\n    default = "dark"\n'));
  assert.ok(newTable.text.startsWith(text.trimEnd()));

  for (const result of [nested, newTable]) {
    const after = readToml(result.text).values;
    for (const [path, value] of Object.entries(before)) {
      assert.deepEqual(after[path], value, `${path} must not move`);
    }
  }
});

// The root table has no header line, so its keys are the one insertion the "append to the end
// of the file" rule cannot describe: the end of the file belongs to the last `[table]`.
test('a top-level key lands among the top-level keys, not inside the last table', () => {
  const text = readConfig('params.toml');
  const parsed = parseToml(text);
  const before = readToml(text).values;

  const result = applyAndVerify(text, [planInsertKey(parsed, 'SortBy', 'lastmod')]);
  assert.equal(readValue(result.text, 'SortBy'), 'lastmod');

  const lines = result.text.split('\n');
  const inserted = lines.findIndex((line) => line.startsWith('SortBy'));
  const firstHeader = lines.findIndex((line) => line.startsWith('['));
  assert.ok(inserted >= 0 && inserted < firstHeader, 'the new key sits above the first table header');

  // It joined the top-level keys with their own alignment, and nothing else moved.
  const after = readToml(result.text).values;
  assert.equal(after.SortBy, 'lastmod');
  for (const [path, value] of Object.entries(before)) {
    assert.deepEqual(after[path], value, `${path} must not move`);
  }
});

test('a key can be added to a table that already exists without creating a second header', () => {
  const text = readConfig('languages.toml');
  const parsed = parseToml(text);
  const result = applyAndVerify(text, [planInsertKey(parsed, 'en.params.sidebar.emoji', '🚀')]);

  assert.equal(readValue(result.text, 'en.params.sidebar.emoji'), '🚀');
  assert.equal((result.text.match(/\[en\.params\.sidebar\]/g) ?? []).length, 1);
  // The inserted line follows the table's own indentation and key alignment.
  assert.ok(result.text.includes('\n        emoji    = "🚀"\n'));
  assert.equal(
    readValue(result.text, 'zh.params.sidebar.subtitle'),
    readValue(text, 'zh.params.sidebar.subtitle'),
    'the neighbouring language is untouched',
  );
});

test('a key can be removed, and only its own line goes', () => {
  const text = 'a = 1\n\n[table]\n    keep = true\n    drop = "x"\n    alsoKeep = 2\n';
  const parsed = parseToml(text);
  const result = applyAndVerify(text, [planRemoveKey(parsed, 'table.drop')]);

  assert.equal(result.text, 'a = 1\n\n[table]\n    keep = true\n    alsoKeep = 2\n');
});

test('array-of-table entries can be removed and added', () => {
  const text = readConfig('menu.toml');
  const removed = applyAndVerify(text, [planRemoveArrayEntry(parseToml(text), 'social', 0)]);
  assert.equal(removed.text.includes('identifier = "github"'), false);
  // The fixture's other entry (rss) and its nested table survive in one piece.
  assert.equal(readValue(removed.text, 'social[0].identifier'), 'rss');
  assert.equal(readValue(removed.text, 'social[0].params.icon'), 'rss');

  const restored = applyAndVerify(removed.text, [
    planInsertArrayEntry(parseToml(removed.text), 'social', [
      '[[social]]',
      '    identifier = "github"',
      '    name       = "GitHub"',
      '    url        = "https://github.com/example"',
      '',
      '    [social.params]',
      '        icon = "brand-github"',
    ]),
  ]);
  // A new entry is appended: the surviving entry keeps its position, the new one follows it.
  assert.equal(readValue(restored.text, 'social[0].identifier'), 'rss');
  assert.equal(readValue(restored.text, 'social[1].identifier'), 'github');
  assert.equal(readValue(restored.text, 'social[1].params.icon'), 'brand-github');
  assert.deepEqual(readToml(restored.text).arrays, ['social']);
});

test('multi-line arrays and comments inside them are located correctly', () => {
  const text = '# leading comment\nkeys = [\n    "a", # first\n    "b",\n]\nafter = 1\n';
  const parsed = parseToml(text);
  assert.deepEqual(readValue(text, 'keys'), ['a', 'b']);
  const result = applyAndVerify(text, [planValueEdit(parsed, 'keys', ['c'])]);
  assert.deepEqual(readValue(result.text, 'keys'), ['c']);
  assert.ok(result.text.includes('after = 1'));
  assert.ok(result.text.includes('# leading comment'));
});

test('the minimal-rewrite check fails when something outside the edit moved', () => {
  const before = 'a = 1\nb = 2\n';
  const edits = [planValueEdit(parseToml(before), 'a', 5)];
  const applied = applyTomlEdits(before, edits);
  assert.equal(verifyMinimalRewrite({ beforeText: before, afterText: applied.text, edits: applied.edits }).ok, true);

  // The same edits against a file that was rewritten elsewhere must not pass.
  const tampered = applied.text.replace('b = 2', 'b = 3');
  const check = verifyMinimalRewrite({ beforeText: before, afterText: tampered, edits: applied.edits });
  assert.equal(check.ok, false);
  assert.match(check.reason, /outside the edited spans/);
});

test('the engine refuses to invent a value it cannot read back', () => {
  const text = readConfig('hugo.toml');
  const parsed = parseToml(text);
  // `theme` is a string; writing a bare word would decode as a string too, but an array
  // where a string is expected is caught by the caller's type check, not silently written.
  const result = applyAndVerify(text, [planValueEdit(parsed, 'theme', 'other-theme')]);
  assert.equal(readValue(result.text, 'theme'), 'other-theme');
  assert.ok(result.text.includes('theme = "other-theme"'));
});

test('scanValue and splitTopLevel agree with the parser on nested structures', () => {
  const text = 'x = [[1, 2], ["a"]]\ny = 3\n';
  const scanned = scanValue(text, 4);
  assert.equal(text.slice(4, scanned.end), '[[1, 2], ["a"]]');
  assert.deepEqual(splitTopLevel('1, [2, 3], { a = "x,y" }'), ['1', '[2, 3]', '{ a = "x,y" }']);
  // A comment inside a list is dropped, not folded into the item after it.
  assert.deepEqual(splitTopLevel('"a", # first\n    "b"'), ['"a"', '"b"']);
});

test('the engine and the content layer agree about the site\'s languages', () => {
  // Cross-check: two independent readers of the same site must not disagree about it.
  const languages = readToml(readConfig('languages.toml'));
  const declared = Object.keys(languages.values)
    .filter((path) => path.endsWith('.locale'))
    .map((path) => path.slice(0, -'.locale'.length));
  const fromContent = readSiteLanguages({ siteRoot: FIXTURE_SITE });

  assert.deepEqual([...fromContent.languages].sort(), declared.sort());
  assert.ok(declared.includes(fromContent.defaultLanguage ?? 'zh'));
  for (const code of declared) {
    assert.equal(typeof languages.values[`${code}.label`], 'string', `${code} needs a label`);
    assert.equal(typeof languages.values[`${code}.weight`], 'number', `${code} needs a weight`);
  }
});

test('a TOML file with CRLF line endings keeps them', () => {
  const text = 'a = 1\r\n[table]\r\n    b = "x"\r\n';
  const result = applyAndVerify(text, [planValueEdit(parseToml(text), 'table.b', 'y')]);
  assert.equal(result.text, 'a = 1\r\n[table]\r\n    b = "y"\r\n');
  assert.equal(result.text.includes('\n\n'), false);
});

test('formatValue writes every shape the settings layer can produce', () => {
  assert.equal(formatValue(true), 'true');
  assert.equal(formatValue(12), '12');
  assert.equal(formatValue('x'), '"x"');
  assert.equal(formatValue([]), '[]');
  assert.equal(formatValue(['a', 'b']), '["a", "b"]');
  assert.equal(formatValue({ limit: 5 }), '{ limit = 5 }');
  assert.equal(sameValue({ a: [1, 2] }, { a: [1, 2] }), true);
  assert.equal(sameValue({ a: [1, 2] }, { a: [2, 1] }), false);
});
