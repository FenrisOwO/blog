<script setup>
// Notifications, in one stack, with one lifetime rule.
//
// Nothing in the editor calls alert(): a save, a build, a commit and a failure all land here,
// and an error says what happened, why, and what to do next.

import { onBeforeUnmount, onMounted, ref } from 'vue';

const props = defineProps({
  store: { type: Object, required: true },
});

const items = ref([...props.store.items]);
const timers = new Map();

function arm(entry) {
  if (!entry.timeout) return;
  const timer = setTimeout(() => dismiss(entry.id), entry.timeout);
  timers.set(entry.id, timer);
}

function dismiss(id) {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  props.store.dismiss(id);
}

let unsubscribe = null;

onMounted(() => {
  unsubscribe = props.store.subscribe((next) => {
    items.value = next;
    for (const entry of next) if (!timers.has(entry.id)) arm(entry);
  });
  for (const entry of items.value) arm(entry);
});

onBeforeUnmount(() => {
  unsubscribe?.();
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
});

const glyph = { success: '✓', info: 'ℹ', warning: '⚠', error: '✕' };
</script>

<template>
  <div class="toast-stack" role="status" aria-live="polite">
    <div v-for="entry in items" :key="entry.id" class="toast" :class="entry.kind">
      <span class="toast-glyph" aria-hidden="true">{{ glyph[entry.kind] ?? 'ℹ' }}</span>
      <div class="toast-body">
        <div class="toast-title">{{ entry.title }}</div>
        <div v-if="entry.text" class="toast-text">{{ entry.text }}</div>
      </div>
      <button type="button" class="icon-btn" aria-label="关闭通知" title="关闭" @click="dismiss(entry.id)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.toast-glyph {
  width: 16px;
  text-align: center;
  font-weight: 700;
}

.toast.success .toast-glyph { color: var(--success); }
.toast.info .toast-glyph { color: var(--accent); }
.toast.warning .toast-glyph { color: var(--warning); }
.toast.error .toast-glyph { color: var(--error); }
</style>
