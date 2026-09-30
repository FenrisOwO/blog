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

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="entries.length === 0" class="empty">回收站是空的。</p>

    <ul v-else class="entries">
      <li v-for="entry in entries" :key="entry.id">
        <div class="row-head">
          <code class="rel">{{ entry.relPath }}</code>
          <span class="meta">{{ entry.kind }} · {{ entry.files }} 个文件 · {{ size(entry.bytes) }} · {{ when(entry) }}</span>
          <span v-if="entry.restoredAt" class="restored">已恢复</span>
          <button
            v-else
            type="button"
            class="btn"
            :disabled="busy"
            @click="pending === entry.id ? emit('restore', entry.id) : (pending = entry.id)"
          >
            {{ pending === entry.id ? '确认恢复' : '恢复' }}
          </button>
        </div>
      </li>
    </ul>

    <template #footer>
      <button type="button" class="btn" :disabled="busy" @click="emit('refresh')">刷新</button>
      <span class="hint">恢复同样会触发一次构建</span>
    </template>
  </ModalShell>
</template>

<style scoped>
.lead {
  margin: 0 0 10px;
  color: var(--muted);
}

.lead code,
.rel {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11.5px;
}

.entries {
  list-style: none;
  margin: 0;
  padding: 0;
}

.entries > li {
  padding: 8px 0;
  border-top: 1px solid var(--surface-3);
}

.row-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.rel {
  color: var(--text);
}

.meta {
  color: var(--faint);
  font-size: 11px;
}

.restored {
  margin-left: auto;
  color: var(--success);
  font-size: 11px;
}

.row-head .btn {
  margin-left: auto;
}

.empty {
  color: var(--faint);
}

.error {
  color: var(--error);
}

.btn {
  padding: 4px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.hint {
  margin-left: auto;
  font-size: 11px;
  color: var(--faint);
}
</style>
