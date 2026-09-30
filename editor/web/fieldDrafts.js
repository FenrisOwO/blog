// What the form thinks the user changed, and what it sends.
//
// This is deliberately separate from the component: the rules below decide whether a save
// happens at all, so they belong somewhere they can be tested directly instead of only by
// clicking through the UI.

export function asText(field) {
  if (field.value === null || field.value === undefined) return '';
  return String(field.value);
}

export function asList(value) {
  return Array.isArray(value) ? value.join('\n') : '';
}

function itemsOf(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// The value the user has typed, shaped the way the field's type says it should be.
export function typedValue(field, state) {
  if (field.editor === 'list') return itemsOf(state.listDrafts[field.path]);
  const typed = state.drafts[field.path];
  if (field.editor === 'boolean') return String(typed) === 'true';
  if (field.type === 'number') {
    const number = Number(typed);
    return typed !== '' && !Number.isNaN(number) ? number : typed;
  }
  return typed;
}

export function draftMatchesDocument(field, state) {
  if (field.editor === 'list') return asList(field.value) === String(state.listDrafts[field.path] ?? '');
  return asText(field) === String(state.drafts[field.path] ?? '');
}

// A blank box is not a request to blank the field: `lastmod: ""` is not a date Hugo can
// parse, and a list with nothing under it is not a list. Emptying a box is how a user says
// "never mind"; deleting a field is done with ✕, which is explicit about it.
function isBlank(value) {
  return value === '' || (Array.isArray(value) && value.length === 0);
}

export function collectEdits(model, state) {
  const set = {};
  const remove = [];

  const submit = (path, field) => {
    const value = typedValue(field, state);
    if (!isBlank(value)) set[path] = value;
  };

  for (const field of (model?.fields ?? []).filter((candidate) => candidate.editable)) {
    if (state.removed.includes(field.path) || draftMatchesDocument(field, state)) continue;
    submit(field.path, field);
  }

  for (const key of state.added) {
    const declared = (model?.missing ?? []).find((field) => field.key === key);
    // `missingFields` describes a field by key; the form addresses it by path.
    const field = { editor: 'text', type: 'text', ...declared, path: key, value: null };
    submit(key, field);
  }

  for (const path of state.removed) remove.push(path);

  return { set, remove };
}
