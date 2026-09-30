// Entry point the host application imports.
//
// Importing this module registers the available cores. The host only ever sees the
// adapter contract from here on, so no Vue component or business module needs to know
// that CodeMirror exists.

import './cores/codeMirrorCore.js';

export {
  CORE_CAPABILITY_KEYS,
  OPTIONAL_CORE_CAPABILITY_KEYS,
  SELECTION_METHODS,
  assertEditorCore,
  createEditorCore,
  listCores,
  registerCore,
  supports,
  supportsSelection,
} from './adapter.js';
export * from './markdown.js';

export const DEFAULT_CORE = 'codemirror';
