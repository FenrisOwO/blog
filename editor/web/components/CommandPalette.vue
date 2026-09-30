<script setup>
// Ctrl+K: the one place every action is reachable from, including the actions the current view
// does not show. The commands come from web/commands.js, which builds them from the same
// functions the buttons call, so the palette cannot drift from the UI.

import { computed, nextTick, ref, watch } from 'vue';

import { filterCommands, groupCommands } from '../commands.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  commands: { type: Array, default: () => [] },
});

const emit = defineEmits(['close', 'run']);

const query = ref('');
const index = ref(0);
const input = ref(null);

const matches = computed(() => filterCommands(props.commands, query.value));
const groups = computed(() => groupCommands(matches.value));
const flat = computed(() => groups.value.flatMap((group) => group.items));

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    query.value = '';
    index.value = 0;
    await nextTick();
    input.value?.focus();
  },
);

watch(matches, () => {
  index.value = 0;
});

function move(delta) {
  if (flat.value.length === 0) return;
  index.value = (index.value + delta + flat.value.length) % flat.value.length;
}

function run(command) {
  if (!command || command.enabled === false) return;
  emit('close');
  command.run?.();
}

function onKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
    return;
  }
  if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
    event.preventDefault();
    move(1);
    return;
  }
  if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
    event.preventDefault();
    move(-1);
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    run(flat.value[index.value]);
  }
}
</script>

<template>
  <div v-if="open" class="dialog-backdrop" @click.self="emit('close')">
    <div class="dialog narrow palette" role="dialog" aria-modal="true" aria-label="命令面板">
      <input
        ref="input"
        v-model="query"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-autocomplete="list"
        aria-label="输入命令名"
        placeholder="输入命令，例如 保存 / build / 主题 / git …"
        @keydown="onKeydown"
      />
      <div id="palette-list" class="palette-list" role="listbox">
        <template v-for="group in groups" :key="group.group">
          <div class="palette-group">{{ group.group }}</div>
          <button
            v-for="command in group.items"
            :key="command.id"
            type="button"
            class="palette-item"
            role="option"
            :aria-selected="flat.indexOf(command) === index"
            :disabled="command.enabled === false"
            @mousemove="index = flat.indexOf(command)"
            @click="run(command)"
          >
            <span class="label">{{ command.label }}</span>
            <span v-if="command.hint" class="where">{{ command.hint }}</span>
            <kbd v-else-if="command.shortcut">{{ command.shortcut }}</kbd>
            <span v-else-if="command.enabled === false" class="where">不可用</span>
          </button>
        </template>
        <p v-if="flat.length === 0" class="state">
          <strong>没有匹配的命令</strong>
          <span>换一个词试试，或者清空输入。</span>
        </p>
      </div>
      <footer class="dialog-foot">
        <span class="hint"><kbd>↑</kbd> <kbd>↓</kbd> 选择 · <kbd>Enter</kbd> 执行 · <kbd>Esc</kbd> 关闭</span>
        <span class="spacer"></span>
        <span class="hint">{{ flat.length }} 项</span>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.palette .state {
  padding: var(--space-6) var(--space-4);
}
</style>
