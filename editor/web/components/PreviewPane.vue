<script setup>
// The preview pane: an iframe onto the real site output, served by the same server.
//
// The editor never injects scripts into the preview and never writes into public/ - it
// just re-points the iframe when a build produces a new generation. That keeps what the
// user sees in the preview byte-identical to the Hugo output.

import { computed, ref, watch } from 'vue';

const props = defineProps({
  url: { type: String, default: '/' },
  generation: { type: Number, default: 0 },
  autoRefresh: { type: Boolean, default: true },
});

const emit = defineEmits(['update:autoRefresh']);

const pinned = ref(props.generation);
const frameKey = ref(0);

watch(
  () => props.generation,
  (generation) => {
    if (props.autoRefresh) pinned.value = generation;
  },
);

const stale = computed(() => props.generation !== pinned.value);

const src = computed(() => {
  const base = props.url || '/';
  const separator = base.includes('?') ? '&' : '?';
  return pinned.value > 0 ? `${base}${separator}__hve=${pinned.value}` : base;
});

function refresh() {
  pinned.value = props.generation;
  frameKey.value += 1;
}
</script>

<template>
  <section class="preview">
    <header class="preview-head">
      <b>预览</b>
      <code class="url">{{ url }}</code>
      <span class="badge">generation {{ pinned }}</span>
      <span v-if="stale" class="badge warn">有新构建</span>
      <span class="spacer"></span>
      <label class="toggle">
        <input
          type="checkbox"
          :checked="autoRefresh"
          @change="emit('update:autoRefresh', $event.target.checked)"
        />
        自动刷新
      </label>
      <button class="btn" :class="{ highlight: stale }" @click="refresh">刷新</button>
      <a class="btn" :href="url" target="_blank" rel="noopener">新窗口</a>
    </header>
    <iframe :key="frameKey" class="frame" :src="src" title="站点预览"></iframe>
  </section>
</template>

<style scoped>
.preview {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-left: 1px solid var(--border);
  background: var(--surface);
}

.preview-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  font-size: 12px;
  color: var(--muted);
}

.preview-head .url {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--muted);
}

.preview-head .spacer {
  flex: 1;
}

.badge {
  padding: 1px 7px;
  border-radius: 8px;
  background: var(--surface-3);
  color: var(--muted);
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px;
}

.badge.warn {
  background: var(--warning-soft);
  color: var(--warning);
}

.toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  cursor: pointer;
}

.btn {
  padding: 4px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 11px;
  text-decoration: none;
  cursor: pointer;
}

.btn:hover {
  background: var(--surface-3);
}

.btn.highlight {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
}

.frame {
  flex: 1;
  min-height: 0;
  width: 100%;
  border: 0;
  background: var(--surface);
}
</style>
