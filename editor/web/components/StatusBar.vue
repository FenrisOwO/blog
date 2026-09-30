<script setup>
// The status bar: the application's state, in one line.
//
// It answers the three questions a user of this editor actually has - "is my text on disk?",
// "did the site build?", "does git see it?" - and every item is also a button to the place
// where that state can be acted on.

import { computed } from 'vue';

const props = defineProps({
  save: { type: Object, default: () => ({ state: 'clean' }) },
  build: { type: Object, default: null },
  git: { type: Object, default: null },
  preview: { type: String, default: '/' },
  theme: { type: String, default: 'light' },
  themePreference: { type: String, default: 'system' },
  core: { type: String, default: '' },
  autoBuildOnSave: { type: Boolean, default: true },
});

const emit = defineEmits(['build', 'open-preview', 'theme', 'git', 'save', 'toggle-inspector']);

const SAVE_LABELS = {
  clean: '未修改',
  dirty: '未保存',
  saving: '正在保存',
  saved: '已保存',
  error: '保存失败',
};

const SAVE_GLYPHS = { clean: '·', dirty: '●', saving: '↻', saved: '✓', error: '⚠' };

const saveLabel = computed(() => SAVE_LABELS[props.save?.state] ?? '未修改');
const saveClass = computed(() => {
  const state = props.save?.state ?? 'clean';
  if (state === 'error') return 'is-error';
  if (state === 'saving') return 'is-busy';
  if (state === 'dirty') return 'is-warn';
  return 'is-ok';
});

const buildState = computed(() => props.build?.state ?? 'idle');
const buildLabel = computed(() => {
  if (buildState.value === 'running' || buildState.value === 'queued') return '正在构建…';
  if (buildState.value === 'failed' || buildState.value === 'error') return '构建失败';
  const last = props.build?.lastBuild;
  if (last?.state === 'success') {
    const seconds = last.durationMs ? (last.durationMs / 1000).toFixed(1) : null;
    return seconds ? `构建成功 ${seconds}s` : '构建成功';
  }
  return props.build?.generation ? '构建就绪' : '等待首次构建';
});
const buildClass = computed(() => {
  if (buildState.value === 'running' || buildState.value === 'queued') return 'is-busy';
  if (buildState.value === 'failed' || buildState.value === 'error') return 'is-error';
  return 'is-ok';
});

const gitLabel = computed(() => {
  if (!props.git) return 'git: 未知';
  if (props.git.repository === null) return 'Git 未初始化';
  const branch = props.git.branch ?? '(detached)';
  const total = props.git.counts?.total ?? 0;
  return total === 0 ? `${branch} · 干净` : `${branch} · ${total} 处变更`;
});
const gitClass = computed(() => {
  if (!props.git) return '';
  if (props.git.repository === null) return 'is-warn';
  return (props.git.counts?.total ?? 0) > 0 ? 'is-warn' : 'is-ok';
});

function cycleTheme() {
  const order = ['light', 'dark', 'system'];
  const next = order[(order.indexOf(props.themePreference) + 1) % order.length];
  emit('theme', next);
}
</script>

<template>
  <footer class="statusbar">
    <button
      type="button"
      class="status-item"
      :class="saveClass"
      :title="`编辑器状态：${saveLabel}（Ctrl+S 保存）`"
      @click="emit('save')"
    >
      <span class="dot-state" aria-hidden="true"></span>
      <span>{{ SAVE_GLYPHS[save.state] ?? '·' }} {{ saveLabel }}</span>
    </button>

    <button type="button" class="status-item" :class="buildClass" :title="buildLabel" @click="emit('build')">
      <span>{{ buildLabel }}</span>
      <span v-if="build?.generation" class="badge">#{{ build.generation }}</span>
      <span v-if="autoBuildOnSave === false" class="badge warn">手动构建</span>
    </button>

    <button type="button" class="status-item" title="打开预览（构建输出）" @click="emit('open-preview')">
      <span>预览</span>
      <code>{{ preview }}</code>
    </button>

    <span class="spacer"></span>

    <button type="button" class="status-item" :class="gitClass" title="Git 变更" @click="emit('git')">
      <span class="dot-state" aria-hidden="true"></span>
      <span>{{ gitLabel }}</span>
    </button>

    <button
      type="button"
      class="status-item"
      :title="`主题：${themePreference === 'system' ? '跟随系统' : themePreference === 'dark' ? '深色' : '浅色'}`"
      @click="cycleTheme"
    >
      <span>{{ theme === 'dark' ? '🌙' : '☀️' }}</span>
      <span>{{ themePreference === 'system' ? '系统' : theme === 'dark' ? '深色' : '浅色' }}</span>
    </button>

    <button type="button" class="status-item" title="显示 / 隐藏检查器" @click="emit('toggle-inspector')">
      <span>检查器</span>
    </button>

    <span v-if="core" class="status-item" title="编辑器内核（可通过适配器替换）">
      <span class="badge">core: {{ core }}</span>
    </span>
  </footer>
</template>

<style scoped>
.statusbar code {
  font-size: var(--text-xs);
}

.badge {
  padding: 0 4px;
  font-size: 10px;
}
</style>
