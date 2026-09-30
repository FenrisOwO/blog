<script setup>
// The `/` menu: Markdown input assistance, nothing more.
//
// It reads the text and the caret from the editor (through the adapter), asks the command
// engine which structures match what was typed, and on accept removes the typed `/query` and
// runs the command. No block model, no hidden state: the result is Markdown in the document.

defineProps({
  items: { type: Array, default: () => [] },
  index: { type: Number, default: 0 },
  top: { type: Number, default: 0 },
  left: { type: Number, default: 0 },
});

const emit = defineEmits(['select', 'hover']);
</script>

<template>
  <div class="slash-menu" role="listbox" aria-label="插入结构" :style="{ top: `${top}px`, left: `${left}px` }">
    <button
      v-for="(item, position) in items"
      :key="item.id"
      type="button"
      role="option"
      class="slash-item"
      :aria-selected="position === index"
      :data-slash="item.id"
      @mousemove="emit('hover', position)"
      @click="emit('select', item)"
    >
      <span>{{ item.label }}</span>
      <span v-if="item.hint" class="hint-mono">{{ item.hint }}</span>
    </button>
    <p v-if="items.length === 0" class="slash-empty">没有匹配的结构，继续输入即可。</p>
  </div>
</template>
