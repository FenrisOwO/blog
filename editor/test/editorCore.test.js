// P1.4: the adapter contract.
//
// These tests import the adapter directly (never the CodeMirror core), and drive a
// throwaway stub core through the same interface the Vue host uses. That is the point:
// the host only needs the contract.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertEditorCore,
  createEditorCore,
  listCores,
  registerCore,
  supports,
  supportsSelection,
} from '../src/editorCore/adapter.js';
import { minimalChange } from '../src/editorCore/markdown.js';

function makeStubCore() {
  return {
    capabilities: { source: true, wysiwyg: false, splitPreview: false, readOnly: true },
    mounted: null,
    value: '',
    changeHandler: null,
    mount(element, { initialValue = '', readOnly = true } = {}) {
      this.mounted = { element, readOnly };
      this.value = initialValue;
    },
    getValue() {
      return this.value;
    },
    setValue(text) {
      this.value = text;
    },
    focus() {},
    destroy() {
      this.mounted = null;
    },
    onChange(handler) {
      this.changeHandler = handler;
      return () => {
        this.changeHandler = null;
      };
    },
  };
}

test('any core satisfying the contract can be driven by the host', () => {
  registerCore('stub', makeStubCore);
  assert.ok(listCores().includes('stub'));

  const core = createEditorCore('stub');
  core.mount({ nodeName: 'DIV' }, { initialValue: '---\ntitle: A\n---\n', readOnly: true });

  assert.equal(core.getValue(), '---\ntitle: A\n---\n');
  assert.equal(core.mounted.readOnly, true);

  core.setValue('changed');
  assert.equal(core.getValue(), 'changed');

  core.destroy();
  assert.equal(core.mounted, null);
});

test('a core without onChange is rejected', () => {
  registerCore('no-change', () => {
    const { onChange, ...withoutChange } = makeStubCore();
    return withoutChange;
  });
  assert.throws(() => createEditorCore('no-change'), /missing method: onChange\(\)/);
});

test('an unknown core is rejected with a helpful message', () => {
  assert.throws(() => createEditorCore('does-not-exist'), /unknown editor core "does-not-exist"/);
});

test('a core missing contract methods is rejected', () => {
  registerCore('broken', () => ({ capabilities: makeStubCore().capabilities }));
  assert.throws(() => createEditorCore('broken'), /missing method: mount\(\)/);
});

test('capabilities must be declared as booleans', () => {
  registerCore('bad-caps', () => ({
    ...makeStubCore(),
    capabilities: { source: 'yes', wysiwyg: false, splitPreview: false, readOnly: true },
  }));
  assert.throws(() => createEditorCore('bad-caps'), /capabilities\.source must be a boolean/);
});

test('assertEditorCore is usable directly', () => {
  assert.ok(assertEditorCore(makeStubCore(), 'inline'));
  assert.throws(() => assertEditorCore(null, 'nothing'), /did not return an object/);
});

// --- Phase 8: the optional selection half of the contract --------------------

test('a core that declares selection support must provide the selection methods', () => {
  registerCore('selection-without-methods', () => ({
    ...makeStubCore(),
    capabilities: { ...makeStubCore().capabilities, selection: true },
  }));
  assert.throws(() => createEditorCore('selection-without-methods'), /missing method: getSelection\(\)/);
});

test('optional capabilities are checked when a core declares them', () => {
  registerCore('bad-optional', () => ({
    ...makeStubCore(),
    capabilities: { ...makeStubCore().capabilities, selection: 'yes' },
  }));
  assert.throws(() => createEditorCore('bad-optional'), /capabilities\.selection must be a boolean/);
});

test('a core written before Phase 8 still works, and the host can ask what it supports', () => {
  const core = createEditorCore('stub');
  assert.equal(supports(core, 'selection'), false);
  assert.equal(supportsSelection(core), false);
  assert.equal(supports(core, 'source'), true);
});

test('a selection-capable core is driven through getSelection and applyEdit', () => {
  registerCore('selection-stub', () => ({
    ...makeStubCore(),
    selection: { anchor: 0, head: 0 },
    edits: [],
    getSelection() {
      return this.selection;
    },
    applyEdit(edit) {
      this.edits.push(edit);
      const { from, to = from, insert = '', selection = null } = edit;
      this.value = this.value.slice(0, from) + insert + this.value.slice(to);
      if (selection) this.selection = selection;
      return true;
    },
    capabilities: {
      source: true,
      wysiwyg: false,
      splitPreview: false,
      readOnly: true,
      selection: true,
      markdownCommands: true,
    },
  }));

  const core = createEditorCore('selection-stub');
  core.mount({ nodeName: 'DIV' }, { initialValue: 'hello', readOnly: false });
  assert.equal(supportsSelection(core), true);
  assert.deepEqual(core.getSelection(), { anchor: 0, head: 0 });

  const change = minimalChange('hello', '**hello**');
  core.applyEdit({ ...change, selection: { anchor: 2, head: 7 } });
  assert.equal(core.getValue(), '**hello**');
  assert.deepEqual(core.getSelection(), { anchor: 2, head: 7 });
});
