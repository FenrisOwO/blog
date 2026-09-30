// Editor Core contract + registry.
//
// This module is the ONLY seam between the host application and a concrete editor
// implementation. It intentionally imports no editor library: a core registers itself
// from the outside, so swapping CodeMirror for something else means adding one file
// under `cores/` and nothing else in the app changes.
//
// Host code (Vue components, server, Hugo layers) must depend on this contract only:
//
//   const core = createEditorCore('codemirror')
//   core.mount(element, { initialValue: markdown, readOnly: true })
//   core.getValue()   core.setValue(next)   core.focus()   core.destroy()
//   const off = core.onChange((text) => {})   // off() unsubscribes
//
// `capabilities` lets the host adapt (e.g. hide a split-preview toggle) without
// knowing which core is installed.

const REQUIRED_METHODS = ['mount', 'getValue', 'setValue', 'focus', 'destroy', 'onChange'];

export const CORE_CAPABILITY_KEYS = ['source', 'wysiwyg', 'splitPreview', 'readOnly'];

// Phase 8 adds capabilities a core may declare on top of the original contract. They are
// optional on purpose: the host asks `supports(core, 'selection')` before using selection or
// command APIs, so a core written against the original contract keeps working (and the
// toolbar simply stays hidden).
export const OPTIONAL_CORE_CAPABILITY_KEYS = ['selection', 'markdownCommands'];

// The methods `capabilities.selection` promises. The toolbar, the slash menu and the
// Markdown keyboard shortcuts all go through these two.
export const SELECTION_METHODS = ['getSelection', 'applyEdit'];

const registry = new Map();

export function registerCore(name, factory) {
  if (typeof name !== 'string' || name === '') throw new Error('core name must be a non-empty string');
  if (typeof factory !== 'function') throw new Error(`core factory for "${name}" must be a function`);
  registry.set(name, factory);
}

export function listCores() {
  return [...registry.keys()];
}

export function assertEditorCore(core, name = 'unknown') {
  if (!core || typeof core !== 'object') {
    throw new Error(`editor core "${name}" did not return an object`);
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof core[method] !== 'function') {
      throw new Error(`editor core "${name}" is missing method: ${method}()`);
    }
  }
  const capabilities = core.capabilities;
  if (!capabilities || typeof capabilities !== 'object') {
    throw new Error(`editor core "${name}" is missing a capabilities object`);
  }
  for (const key of CORE_CAPABILITY_KEYS) {
    if (typeof capabilities[key] !== 'boolean') {
      throw new Error(`editor core "${name}" capabilities.${key} must be a boolean`);
    }
  }
  for (const key of OPTIONAL_CORE_CAPABILITY_KEYS) {
    if (key in capabilities && typeof capabilities[key] !== 'boolean') {
      throw new Error(`editor core "${name}" capabilities.${key} must be a boolean`);
    }
  }
  if (capabilities.selection === true) {
    for (const method of SELECTION_METHODS) {
      if (typeof core[method] !== 'function') {
        throw new Error(`editor core "${name}" declares capabilities.selection but is missing method: ${method}()`);
      }
    }
  }
  return core;
}

export function createEditorCore(name, options = {}) {
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(`unknown editor core "${name}" (registered: ${listCores().join(', ') || 'none'})`);
  }
  return assertEditorCore(factory(options), name);
}

// What the host asks instead of sniffing for methods itself.
export function supports(core, capability) {
  return core?.capabilities?.[capability] === true;
}

export function supportsSelection(core) {
  return supports(core, 'selection');
}
