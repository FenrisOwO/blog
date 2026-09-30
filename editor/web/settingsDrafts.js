// What the settings form thinks the user changed, and what it sends.
//
// Kept out of the component for the same reason `fieldDrafts.js` is: these rules decide
// whether a save happens at all, so they get tested directly against the real settings
// service rather than by clicking through the UI.
//
// The one rule that matters here is "changed", and it is not "the text differs": a box that
// shows a theme default must not be sent just because the user looked at it, and clearing a
// box must not write an empty value where Hugo expects a number.

export function sourceLabel(source) {
  return {
    site: '本站配置',
    language: '本站配置',
    theme: '主题默认',
    unset: '未设置',
  }[source] ?? source;
}

export function valueText(value) {
  if (value === null || value === undefined) return '（未设置）';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.length === 0 ? '（空列表）' : value.map((item) => (typeof item === 'object' ? item.type ?? '…' : String(item))).join(', ');
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key} = ${item}`).join(', ');
  return String(value);
}

export function displayValue(row) {
  if (row.type === 'boolean') return row.value === true;
  if (row.value === null || row.value === undefined) return '';
  return String(row.value);
}

// The draft state for one row, which is also the shape of the payload key it maps to.
export function initialDrafts(described) {
  const drafts = {};
  const widgets = {};
  for (const row of Object.values(described.settings ?? {})) {
    if (row.kind === 'value') {
      drafts[row.id] = displayValue(row);
      for (const language of row.languageRows ?? []) {
        drafts[language.id] = language.present ? String(language.value ?? '') : '';
      }
    } else if (row.kind === 'widgets') {
      widgets[row.id] = (row.values ?? []).map((widget) => ({ ...widget, ...(widget.params ? { params: { ...widget.params } } : {}) }));
    } else if (row.kind === 'menu-list' && row.editable !== false) {
      for (const entry of row.entries) {
        for (const field of row.fields) {
          // The descriptor's menu entries are flat (`icon`, `newTab`); the field keys are
          // the TOML paths (`params.icon`, `params.newTab`).
          const value = entry[field.key.replace('params.', '')];
          drafts[`${row.id}[${entry.index}].${field.key}`] =
            field.type === 'boolean' ? value === true : value === null || value === undefined ? '' : String(value);
        }
      }
    } else if (row.kind === 'language-list') {
      for (const entry of row.entries) {
        for (const field of row.fields) {
          const value = entry.values[field.key];
          drafts[`${row.id}.${entry.code}.${field.key}`] = value === null || value === undefined ? '' : String(value);
        }
      }
    }
  }
  return { drafts, widgets, menu: { add: [], remove: [] } };
}

function changedValue(row, draft) {
  if (row.type === 'boolean') return draft !== (row.value === true);
  if (row.type === 'number') {
    if (draft === '') return false;
    return Number(draft) !== row.value;
  }
  const text = draft === null || draft === undefined ? '' : String(draft);
  return text !== (row.value === null || row.value === undefined ? '' : String(row.value));
}

function coerced(row, draft) {
  if (row.type === 'boolean') return draft === true;
  if (row.type === 'number') return Number(draft);
  return String(draft ?? '');
}

function sameWidgets(left, right) {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

function fieldChanged(field, current, draft) {
  if (field.type === 'boolean') return (draft === true) !== (current === true);
  const text = draft === null || draft === undefined ? '' : String(draft);
  const now = current === null || current === undefined ? '' : String(current);
  return text !== now;
}

function fieldValue(field, draft) {
  if (field.type === 'boolean') return draft === true;
  if (field.type === 'number') return Number(draft);
  return String(draft ?? '');
}

// The payload: only what the user actually changed, in the ids the API understands.
export function editsFromDrafts(described, state) {
  const set = {};
  const menu = { add: [], remove: [] };

  for (const row of Object.values(described.settings ?? {})) {
    if (row.kind === 'value') {
      if (row.editable === false) continue;
      if (state.drafts[row.id] !== undefined && changedValue(row, state.drafts[row.id])) {
        set[row.id] = coerced(row, state.drafts[row.id]);
      }
      for (const language of row.languageRows ?? []) {
        const draft = state.drafts[language.id];
        // A language override is written, never removed: an empty box means "leave the
        // language layer alone", not "delete the override".
        if (draft === undefined || String(draft).trim() === '') continue;
        if (language.present && String(language.value ?? '') === String(draft)) continue;
        set[language.id] = String(draft);
      }
    } else if (row.kind === 'widgets') {
      const draft = state.widgets[row.id];
      if (draft !== undefined && !sameWidgets(draft, row.values)) set[row.id] = draft;
    } else if (row.kind === 'menu-list') {
      if (row.editable === false) continue;
      for (const entry of row.entries) {
        for (const field of row.fields) {
          const id = `${row.id}[${entry.index}].${field.key}`;
          const draft = state.drafts[id];
          if (draft === undefined) continue;
          const current = entry[field.key.replace('params.', '')];
          if (!fieldChanged(field, current, draft)) continue;
          set[id] = fieldValue(field, draft);
        }
      }
      for (const index of state.menu.remove) menu.remove.push(index);
      for (const draft of state.menu.add) {
        if (!draft.identifier || !draft.name || !draft.url) continue;
        menu.add.push({
          identifier: draft.identifier,
          name: draft.name,
          url: draft.url,
          ...(draft.icon ? { 'params.icon': draft.icon } : {}),
          ...(draft.newTab ? { 'params.newTab': true } : {}),
        });
      }
    } else if (row.kind === 'language-list') {
      for (const entry of row.entries) {
        for (const field of row.fields) {
          const id = `${row.id}.${entry.code}.${field.key}`;
          const draft = state.drafts[id];
          if (draft === undefined || draft === '') continue;
          if (!fieldChanged(field, entry.values[field.key], draft)) continue;
          set[id] = fieldValue(field, draft);
        }
      }
    }
  }

  return { set, menu };
}

export function editCount(edits) {
  return Object.keys(edits.set ?? {}).length + (edits.menu?.remove?.length ?? 0) + (edits.menu?.add?.length ?? 0);
}

// The rows the user touched, so the form can mark them without re-diffing in the template.
export function editedIds(described, state) {
  const { set } = editsFromDrafts(described, state);
  return Object.keys(set);
}

export function widgetTypesAvailable(row, described) {
  return row.widgetTypes?.length ? row.widgetTypes : (described.theme?.widgetTypes ?? []);
}

export function addWidget(list, type) {
  return [...list, { type }];
}

export function removeWidget(list, index) {
  return list.filter((_, position) => position !== index);
}

export function setWidgetLimit(list, index, limit) {
  return list.map((widget, position) => {
    if (position !== index) return widget;
    if (limit === '' || limit === null) {
      const { params, ...rest } = widget;
      return rest;
    }
    return { ...widget, params: { ...(widget.params ?? {}), limit: Number(limit) } };
  });
}

export function widgetDisplay(row, widget) {
  return {
    type: widget.type,
    limit: widget.params?.limit ?? '',
    icon: widget.params?.icon ?? '',
  };
}
