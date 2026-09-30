// The front-matter form's own rule: what counts as "the user changed something".
//
// The descriptors come from the real engine reading a real document, and the payload the
// form produces is fed straight back into the real editor path - so this checks the form
// against the code it actually talks to, not against a hand-written stand-in.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { applyFieldEdits, describeFields, missingFields, splitDocument } from '../src/frontmatter/index.js';
import { collectEdits } from '../web/fieldDrafts.js';

const ABOUT = '/projects/site/content/page/about/index.md';
const GALLERY = '/projects/site/content/post/Image Gallery/index.md';
const POST = '/projects/site/content/post/pagination-test-01.en.md';

function modelFor(file) {
  const text = readFileSync(file, 'utf8');
  const raw = splitDocument(text).frontMatterRaw;
  return {
    text,
    fields: describeFields(raw).fields,
    missing: missingFields(raw),
  };
}

// Exactly what FieldForm.vue does when a document is opened: one box per editable field,
// pre-filled with what the document says.
function stateFor(model) {
  const drafts = {};
  const listDrafts = {};
  for (const field of model.fields) {
    if (!field.editable) continue;
    if (field.editor === 'list') listDrafts[field.path] = Array.isArray(field.value) ? field.value.join('\n') : '';
    else drafts[field.path] = field.value === null || field.value === undefined ? '' : String(field.value);
  }
  return { drafts, listDrafts, added: [], removed: [] };
}

test('opening the form and saving nothing is a no-op on the real corpus', () => {
  for (const file of [ABOUT, GALLERY, POST]) {
    const model = modelFor(file);
    const edits = collectEdits(model, stateFor(model));
    assert.deepEqual(edits, { set: {}, remove: [] }, file);

    const result = applyFieldEdits(model.text, edits);
    assert.equal(result.text, model.text, `${file} must be byte-identical`);
    assert.equal(result.changed, false, file);
  }
});

test('an empty box means "never mind", not "blank the field"', () => {
  const model = modelFor(ABOUT);
  const state = stateFor(model);

  // A date field emptied by hand would otherwise become `lastmod: ""`, which Hugo cannot
  // parse as a date; a list emptied would become a key with nothing under it.
  state.drafts.lastmod = '';
  assert.deepEqual(collectEdits(model, state), { set: {}, remove: [] });

  const listModel = modelFor(GALLERY);
  const listState = stateFor(listModel);
  listState.listDrafts.tags = '\n   \n';
  assert.deepEqual(collectEdits(listModel, listState), { set: {}, remove: [] });
});

test('a typed value is sent with the shape its field declares', () => {
  const listModel = modelFor(GALLERY);
  const listState = stateFor(listModel);
  listState.listDrafts.tags = '  alpha\n\n  beta  \n';
  listState.drafts.toc = 'true';

  const listEdits = collectEdits(listModel, listState);
  assert.deepEqual(listEdits.set.tags, ['alpha', 'beta'], 'one item per line, blanks dropped');
  assert.equal(listEdits.set.toc, true, 'a boolean field is sent as a boolean');

  const listApplied = applyFieldEdits(listModel.text, listEdits);
  assert.match(listApplied.text, /tags:\n {4}- alpha\n {4}- beta\n/);
  assert.match(listApplied.text, /toc: true\n/);

  const numberModel = modelFor(ABOUT);
  const numberState = stateFor(numberModel);
  const weight = numberModel.fields.find((field) => field.path === 'menu.main.weight');
  assert.equal(weight.type, 'number');
  numberState.drafts['menu.main.weight'] = '7';

  const numberEdits = collectEdits(numberModel, numberState);
  assert.equal(numberEdits.set['menu.main.weight'], 7, 'a number field is sent as a number');
  assert.match(applyFieldEdits(numberModel.text, numberEdits).text, /weight: 7\n/);
});

test('a field the user clears out of existence is sent as a removal, not a blank', () => {
  const model = modelFor(ABOUT);
  const state = stateFor(model);
  state.removed.push('lastmod');

  const edits = collectEdits(model, state);
  assert.deepEqual(edits, { set: {}, remove: ['lastmod'] });

  const applied = applyFieldEdits(model.text, edits);
  assert.equal(applied.changed, true);
  assert.ok(!applied.text.includes('lastmod'), 'the key is gone');
  assert.equal(applied.text.split('\n').length, model.text.split('\n').length - 1);
});

test('a field the user adds is only added once it has a value', () => {
  const model = modelFor(GALLERY);
  const state = stateFor(model);
  assert.ok(model.missing.some((field) => field.key === 'author' && field.creatable));

  state.added.push('author');
  state.drafts.author = '';
  assert.deepEqual(collectEdits(model, state), { set: {}, remove: [] }, 'nothing typed yet');

  state.drafts.author = 'Jimmy';
  const edits = collectEdits(model, state);
  assert.deepEqual(edits, { set: { author: 'Jimmy' }, remove: [] });

  const applied = applyFieldEdits(model.text, edits);
  assert.match(applied.text, /author: Jimmy\n/);
  assert.ok(applied.text.includes('title: 相册\n'), 'the existing fields are untouched');
});

test('a value typed exactly as the document has it is not an edit', () => {
  const model = modelFor(ABOUT);
  const state = stateFor(model);

  // Typing spaces around a title is a real change: YAML would have to quote the string to
  // keep them, so the form must not treat it as "the same value".
  state.drafts.title = `  ${state.drafts.title}  `;
  assert.deepEqual(collectEdits(model, state), { set: { title: '  关于  ' }, remove: [] });

  const applied = applyFieldEdits(model.text, collectEdits(model, state));
  const reread = describeFields(splitDocument(applied.text).frontMatterRaw).fields;
  assert.equal(reread.find((field) => field.path === 'title').value, '  关于  ', 'the spaces survive');

  state.drafts.title = '关于本站';
  assert.deepEqual(collectEdits(model, state), { set: { title: '关于本站' }, remove: [] });
});
