<script setup>
// The Markdown toolbar.
//
// Every button is a `runCommand` id from the same table the keyboard shortcuts use, so bold
// here and Ctrl+B there are literally the same function. The toolbar only ever asks the editor
// to change the selection; it never touches the document itself.

import { COMMANDS, TOOLBAR_GROUPS } from '../../src/editorCore/markdown.js';

defineProps({
  disabled: { type: Boolean, default: false },
  focus: { type: String, default: '' },
});

const emit = defineEmits(['run']);

const GLYPHS = {
  heading1: 'H1',
  heading2: 'H2',
  heading3: 'H3',
  bold: 'B',
  italic: 'I',
  strike: 'S',
  inlineCode: '</>',
  quote: '❝',
  ul: '•—',
  ol: '1.',
  task: '☑',
  link: '🔗',
  image: '🖼',
  table: '▦',
  codeBlock: '{ }',
  hr: '―',
};

const groups = TOOLBAR_GROUPS.map((group) => ({
  id: group.id,
  commands: group.commands.map((id) => ({
    id,
    label: COMMANDS[id].label,
    shortcut: COMMANDS[id].shortcut ?? null,
    glyph: GLYPHS[id] ?? id,
  })),
}));
</script>

<template>
  <div class="md-toolbar" role="toolbar" aria-label="Markdown 工具栏">
    <span v-for="group in groups" :key="group.id" class="group">
      <button
        v-for="command in group.commands"
        :key="command.id"
        type="button"
        class="icon-btn"
        :disabled="disabled"
        :aria-label="command.label"
        :title="command.shortcut ? `${command.label} (${command.shortcut})` : command.label"
        :data-command="command.id"
        @click="emit('run', command.id)"
      >
        <span class="glyph">{{ command.glyph }}</span>
      </button>
    </span>
    <span class="md-toolbar-hint hint">
      只改选中的文字 · <kbd>/</kbd> 插入结构 · <kbd>Ctrl+B</kbd> 粗体 · <kbd>Ctrl+K</kbd> 链接
    </span>
  </div>
</template>

<style scoped>
.md-toolbar-hint {
  margin-left: auto;
  white-space: nowrap;
  padding-right: var(--space-2);
}

.icon-btn {
  width: 26px;
  height: 24px;
}

.glyph {
  font-size: var(--text-xs);
  font-weight: 600;
}
</style>
