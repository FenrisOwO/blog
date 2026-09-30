// CodeMirror 6 implementation of the Editor Core contract.
//
// This is the ONLY file in the project that imports CodeMirror. Everything else talks to
// `src/editorCore/adapter.js`. Replacing CodeMirror therefore means replacing this file (plus
// its registration below) and touching nothing else.
//
// Phase 8 makes the core editable and adds the selection half of the contract, plus a Markdown
// keymap. The keymap runs the same pure transforms the toolbar and the slash menu run
// (`../markdown.js`) through the same `applyEdit` path, so a keyboard shortcut and a button
// produce byte-identical results. The document never leaves source-text form: there is no HTML
// or DOM representation of the Markdown anywhere in this file, and no text is touched that the
// user did not select.

import { EditorState } from '@codemirror/state';
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, redo, undo } from '@codemirror/commands';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';

import { registerCore } from '../adapter.js';
import { continueBlock, indentLines, minimalChange, runCommand, selectionRange } from '../markdown.js';

const capabilities = Object.freeze({
  source: true,
  wysiwyg: false,
  splitPreview: false,
  readOnly: true,
  selection: true,
  markdownCommands: true,
});

const baseTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13.5px' },
  '.cm-scroller': {
    fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    lineHeight: '1.65',
  },
  '.cm-content': { padding: '14px 0' },
  '.cm-gutters': { border: 'none', background: 'transparent', color: 'var(--muted, #8a8f98)' },
  '.cm-activeLine': { background: 'var(--editor-active-line, rgba(90,120,180,0.07))' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    background: 'var(--editor-selection, rgba(76,141,255,0.22))',
  },
  '&.cm-focused': { outline: 'none' },
});

// The transforms the keyboard drives. Each entry is an id from the same command table the
// toolbar uses, so "what bold means" is defined once for the whole application.
const KEY_COMMANDS = [
  { key: 'Mod-b', id: 'bold' },
  { key: 'Mod-i', id: 'italic' },
  { key: 'Shift-Mod-x', id: 'strike' },
  { key: 'Mod-`', id: 'inlineCode' },
];

const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s+|\s*>/;

export function createCodeMirrorCore() {
  let view = null;
  let changeHandler = null;
  let selectionHandler = null;

  function currentSelection() {
    const main = view.state.selection.main;
    return { anchor: main.anchor, head: main.head };
  }

  function applyResult(transform) {
    if (!view) return false;
    const text = view.state.doc.toString();
    const out = transform(text, currentSelection());
    if (!out || out.text === text) return true;
    const change = minimalChange(text, out.text);
    view.dispatch({
      changes: { from: change.from, to: change.to, insert: change.insert },
      selection: out.selection,
      scrollIntoView: true,
      userEvent: 'input.markdownCommand',
    });
    return true;
  }

  function markdownKeymap() {
    return [
      ...KEY_COMMANDS.map(({ key, id }) => ({
        key,
        run: () => applyResult((text, selection) => runCommand(id, text, selection)),
      })),
      {
        // Enter continues a list item or a quote, and ends the structure when the item is
        // empty. Anywhere else it returns false and CodeMirror inserts its own newline.
        key: 'Enter',
        run: () => {
          if (!view) return false;
          const out = continueBlock(view.state.doc.toString(), currentSelection());
          if (!out) return false;
          return applyResult(() => out);
        },
      },
      {
        key: 'Tab',
        run: () => {
          if (!view) return false;
          const line = view.state.doc.lineAt(view.state.selection.main.head).text;
          if (LIST_LINE.test(line)) {
            return applyResult((text, selection) => indentLines(text, selection, 'in'));
          }
          return applyResult((text, selection) => {
            const { from, to } = selectionRange(selection);
            void to;
            return { text: `${text.slice(0, from)}  ${text.slice(from)}`, selection: { anchor: from + 2, head: from + 2 } };
          });
        },
      },
      {
        key: 'Shift-Tab',
        run: () => applyResult((text, selection) => indentLines(text, selection, 'out')),
      },
      { key: 'Mod-z', run: undo },
      { key: 'Shift-Mod-z', run: redo },
    ];
  }

  return {
    capabilities,

    mount(
      element,
      { initialValue = '', readOnly = true, markdown: withMarkdown = true, onSelectionChange = null } = {},
    ) {
      if (view) this.destroy();
      selectionHandler = typeof onSelectionChange === 'function' ? onSelectionChange : null;

      view = new EditorView({
        parent: element,
        state: EditorState.create({
          doc: initialValue,
          extensions: [
            lineNumbers(),
            history(),
            highlightActiveLine(),
            markdown(),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            EditorView.lineWrapping,
            keymap.of([...(withMarkdown ? markdownKeymap() : []), ...defaultKeymap, ...historyKeymap]),
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
            EditorView.updateListener.of((update) => {
              if (!update.docChanged && !update.selectionSet) return;
              if (update.docChanged && changeHandler) changeHandler(update.state.doc.toString());
              if (selectionHandler) {
                const main = update.state.selection.main;
                selectionHandler({ anchor: main.anchor, head: main.head });
              }
            }),
            baseTheme,
          ],
        }),
      });
    },

    onChange(handler) {
      if (typeof handler !== 'function') return () => {};
      changeHandler = handler;
      return () => {
        if (changeHandler === handler) changeHandler = null;
      };
    },

    onSelectionChange(handler) {
      if (typeof handler !== 'function') return () => {};
      selectionHandler = handler;
      return () => {
        if (selectionHandler === handler) selectionHandler = null;
      };
    },

    // --- selection half of the contract -------------------------------------

    getSelection() {
      return view ? currentSelection() : null;
    },

    applyEdit(edit) {
      if (!view || !edit) return false;
      const { from, to = from, insert = '', selection = null } = edit;
      view.dispatch({
        changes: { from, to, insert },
        selection: selection ?? undefined,
        scrollIntoView: true,
      });
      return true;
    },

    getValue() {
      return view ? view.state.doc.toString() : '';
    },

    setValue(text) {
      if (!view) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text ?? '' } });
    },

    // Where the caret is on screen, so a popup (the slash menu) can sit next to it. Optional:
    // a core without it simply gets a popup in a fixed corner.
    caretRect() {
      if (!view) return null;
      const head = view.state.selection.main.head;
      const rect = view.coordsAtPos(head);
      if (!rect) return null;
      return { top: rect.top, bottom: rect.bottom, left: rect.left, lineHeight: rect.bottom - rect.top };
    },

    focus() {
      if (view) view.focus();
    },

    destroy() {
      if (view) {
        view.destroy();
        view = null;
      }
      changeHandler = null;
      selectionHandler = null;
    },
  };
}

registerCore('codemirror', createCodeMirrorCore);
