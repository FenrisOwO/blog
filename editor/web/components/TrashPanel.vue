<script setup>
// The trash. Deletion in this editor is a move, not a destroy, and this is where that
// promise becomes visible - and undoable.

import { computed, ref } from 'vue';

import ModalShell from './ModalShell.vue';

defineProps({
  open: { type: Boolean, default: false },
  entries: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
  error: { type: String, default: null },
});

const emit = defineEmits(['close', 'refresh', 'restore']);

const pending = ref(null);

function when(entry) {
  const stamp = entry.deletedAt ?? entry.createdAt;
  return stamp ? new Date(stamp).toLocaleString() : '';
}

// The manifest counts files and bytes, but does not list them: what was moved is one path
// (a document or a whole bundle directory), and that is what `relPath` already shows.
function size(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
</script>

<template>
  <ModalShell v-if="open" title="回收站" :busy="busy" @close="emit('close')">
    <p class="lead">
      删除的文档保存在编辑器目录下的回收站里，不在 <code>site/</code> 内。恢复会把每个文件按原路径放回。
    </p>

    <p v-if="error" class="error-line">{{ error }}</p>
    <p v-if="entries.length === 0" class="empty">回收站是空的。</p>

    <ul v-else class="list">
      <li v-for="entry in entries" :key="entry.id" class="list-item">
        <span class="body">
          <span class="title mono">{{ entry.relPath }}</span>
          <span class="meta">{{ entry.kind }} · {{ entry.files }} 个文件 · {{ size(entry.bytes) }} · {{ when(entry) }}</span>
        </span>
        <span v-if="entry.restoredAt" class="badge ok">已恢复</span>
        <span class="spacer"></span>
        <span class="actions">
          <button
            v-if="!entry.restoredAt"
            type="button"
            class="mini"
            :class="{ danger: pending === entry.id }"
            :disabled="busy"
            @click="pending === entry.id ? emit('restore', entry.id) : (pending = entry.id)"
          >
            {{ pending === entry.id ? '确认恢复' : '恢复' }}
          </button>
        </span>
      </li>
    </ul>

    <template #footer>
      <button type="button" class="btn mini" :disabled="busy" @click="emit('refresh')">刷新</button>
      <span class="spacer"></span>
      <span class="hint">恢复同样会触发一次构建</span>
    </template>
  </ModalShell>
</template>

<style scoped>
/* Modal body only: the shell, the list rows, the buttons and the banners come
   from the design system. */

.lead {
  margin: 0 0 var(--space-md);
  color: var(--muted);
  font-size: var(--text-sm);
}

.lead code {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
</style>
