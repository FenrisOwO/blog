<script setup>
// The host component for the editor.
//
// It knows the adapter contract and the (pure) Markdown command engine - never CodeMirror,
// never a file path, never the filesystem. Everything the toolbar offers is `applyCommand`,
// which is: read the text and the selection from the core, run a pure transform, then ask the
// core for the smallest edit that produces the result. That is why Ctrl+B and the B button are
// the same operation, and why the document stays Markdown text the whole way through.

import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import {
  COMMANDS,
  DEFAULT_CORE,
  createEditorCore,
  matchSlashCommands,
  minimalChange,
  runCommand,
  runSlashCommand,
  selectionRange,
  slashQuery,
  supportsSelection,
} from '../../src/editorCore/index.js';
import MarkdownToolbar from './MarkdownToolbar.vue';
import SlashMenu from './SlashMenu.vue';

const SLASH_LIMIT = 8;

const props = defineProps({
  initialText: { type: String, default: '' },
  readOnly: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  coreName: { type: String, default: DEFAULT_CORE },
  showToolbar: { type: Boolean, default: true },
});

const emit = defineEmits(['ready', 'change', 'selection', 'dialog', 'command', 'blocked']);

const host = ref(null);
const wrap = ref(null);
const slashOpen = ref(false);
const slashItems = ref([]);
const slashIndex = ref(0);
const slashTop = ref(0);
const slashLeft = ref(0);
let core = null;
let unsubscribe = null;
let unsubscribeSelection = null;
let pendingDialog = null;

const selection = ref({ anchor: 0, head: 0 });
const hasSelection = computed(() => selectionRange(selection.value).from !== selectionRange(selection.value).to);

function currentText() {
  return core ? core.getValue() : '';
}

function currentSelection() {
  return core?.getSelection?.() ?? { anchor: 0, head: 0 };
}

// --- the one path every Markdown command goes through -----------------------

function applyCommand(id, arg = null) {
  if (!core || !supportsSelection(core)) return { changed: false, reason: 'the editor core has no selection support' };
  const text = currentText();
  const before = currentSelection();
  const out = runCommand(id, text, before, arg);
  if (out.blocked) {
    emit('blocked', out.blocked);
    return { changed: false, text: out.text, blocked: out.blocked };
  }
  const change = minimalChange(text, out.text);
  if (!change) {
    // A command that changes nothing (outdent on an unindented line, for instance) still
    // reports honestly instead of writing a byte-identical file.
    if (out.selection) core.applyEdit({ from: before.anchor, to: before.anchor, insert: '', selection: out.selection });
    return { changed: false, text: out.text };
  }
  core.applyEdit({ ...change, selection: out.selection });
  emit('command', { id, arg, changed: true });
  return { changed: true, text: out.text };
}

// A toolbar button that needs an argument (link, image, table, code block) opens a dialog
// instead of guessing; everything else runs immediately.
function runToolbar(id) {
  const command = COMMANDS[id];
  if (command?.needsArg) {
    pendingDialog = { id, text: currentText(), selection: currentSelection() };
    emit('dialog', { id, via: 'toolbar' });
    return;
  }
  applyCommand(id);
}

function applySlash(item) {
  if (!core || !item) return;
  closeSlash();
  const text = currentText();
  const before = currentSelection();
  if (item.dialog) {
    // Link / image / table / code need an argument, so the dialog opens and inserts later.
    pendingDialog = { id: item.id, text, selection: before };
    emit('dialog', { id: item.id, via: 'slash' });
    return;
  }
  const out = runSlashCommand(item.id, text, before);
  const change = minimalChange(text, out.text);
  if (change) core.applyEdit({ ...change, selection: out.selection });
  core.focus();
}

// An argument dialog (started from the toolbar or from the slash menu) inserts here, using the
// text and selection captured when it opened, so an accidental click elsewhere cannot apply the
// dialog's result to the wrong place.
function applyDialog(id, arg) {
  const snapshot = pendingDialog?.id === id ? pendingDialog : null;
  pendingDialog = null;
  if (!core) return false;
  const text = snapshot?.text ?? currentText();
  const sel = snapshot?.selection ?? currentSelection();
  if (text !== currentText()) {
    core.setValue(text);
    core.applyEdit({ from: 0, to: 0, insert: '', selection: sel });
  }
  if (id === 'link' && !arg.url) return false;
  if (id === 'image' && !arg.src) return false;
  const out = runCommand(id, text, sel, arg);
  if (out.blocked) {
    // The dialog said "insert an image"; the front matter got nothing. Say why rather than
    // closing as if it had worked.
    emit('blocked', out.blocked);
    core.focus();
    return false;
  }
  const change = minimalChange(text, out.text);
  if (change) core.applyEdit({ ...change, selection: out.selection });
  core.focus();
  return Boolean(change);
}

function cancelDialog() {
  pendingDialog = null;
}

// --- slash menu ------------------------------------------------------------

function positionSlash() {
  const rect = wrap.value?.getBoundingClientRect();
  const caret = core?.caretRect?.();
  if (!rect || !caret) {
    slashTop.value = 8;
    slashLeft.value = 8;
    return;
  }
  const lineHeight = caret.lineHeight || 20;
  const below = caret.bottom - rect.top + 4;
  const above = caret.top - rect.top - 232;
  slashTop.value = Math.max(8, above > 0 ? above : Math.min(below, rect.height - 240));
  slashLeft.value = Math.max(8, Math.min(caret.left - rect.left, rect.width - 268));
}

function refreshSlash() {
  if (!core || props.readOnly || props.disabled) {
    closeSlash();
    return;
  }
  const text = currentText();
  const { head } = currentSelection();
  const query = slashQuery(text, head);
  if (!query) {
    closeSlash();
    return;
  }
  const items = matchSlashCommands(query.query, SLASH_LIMIT);
  if (items.length === 0) {
    closeSlash();
    return;
  }
  slashItems.value = items;
  slashIndex.value = Math.min(slashIndex.value, items.length - 1);
  if (!slashOpen.value) slashIndex.value = 0;
  slashOpen.value = true;
  positionSlash();
}

function closeSlash() {
  slashOpen.value = false;
  slashItems.value = [];
  slashIndex.value = 0;
}

function onKeydownCapture(event) {
  if (!slashOpen.value) return;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    event.stopPropagation();
    slashIndex.value = (slashIndex.value + 1) % slashItems.value.length;
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    event.stopPropagation();
    slashIndex.value = (slashIndex.value - 1 + slashItems.value.length) % slashItems.value.length;
    return;
  }
  if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault();
    event.stopPropagation();
    applySlash(slashItems.value[slashIndex.value]);
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeSlash();
  }
}

// --- mounting --------------------------------------------------------------

onMounted(() => {
  core = createEditorCore(props.coreName);
  core.mount(host.value, { initialValue: props.initialText, readOnly: props.readOnly });
  unsubscribe = core.onChange((text) => {
    emit('change', text);
    refreshSlash();
  });
  unsubscribeSelection = core.onSelectionChange?.((next) => {
    selection.value = next;
    emit('selection', next);
    refreshSlash();
  });
  emit('ready', { name: props.coreName, capabilities: core.capabilities, selection: supportsSelection(core) });
});

onBeforeUnmount(() => {
  unsubscribe?.();
  unsubscribeSelection?.();
  if (core) core.destroy();
  core = null;
});

defineExpose({
  getText: () => currentText(),
  setText: (text) => {
    if (core) core.setValue(text ?? '');
    closeSlash();
  },
  getSelection: () => currentSelection(),
  focus: () => core?.focus(),
  applyCommand,
  applyDialog,
  cancelDialog,
  closeSlash,
});
</script>

<template>
  <div ref="wrap" class="editor-wrap" @keydown.capture="onKeydownCapture">
    <MarkdownToolbar
      v-if="showToolbar"
      :disabled="readOnly || disabled"
      @run="runToolbar"
    />
    <div ref="host" class="editor-host"></div>
    <SlashMenu
      v-if="slashOpen"
      :items="slashItems"
      :index="slashIndex"
      :top="slashTop"
      :left="slashLeft"
      @select="applySlash"
      @hover="(position) => (slashIndex = position)"
    />
  </div>
</template>

<style scoped>
.editor-wrap {
  position: relative;
}
</style>
