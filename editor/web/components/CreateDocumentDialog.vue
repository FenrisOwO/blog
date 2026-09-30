<script setup>
// Creating a document, in two steps: ask, then show the plan, then confirm.
//
// The plan is the point. The filename comes from the title, the language decides the
// suffix, and a collision is reported before anything exists - so nothing is created under
// a name the user did not see.
//
// Phase 4 adds the third shape: a category page is a branch bundle
// (`content/categories/<term>/_index.md`), not a file called after the term. The dialog
// knows this because the taxonomy list comes from the server, which read it from the site's
// own Hugo config - not because `categories` is hardcoded here.

import { computed, ref, watch } from 'vue';

import { contentKindLabel, formLabel } from '../contentLabels.js';
import ModalShell from './ModalShell.vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  sections: { type: Array, default: () => [] },
  contentKinds: { type: Object, default: null },
  languages: { type: Array, default: () => [] },
  defaultLanguage: { type: String, default: null },
  plan: { type: Object, default: null },
  busy: { type: Boolean, default: false },
  error: { type: String, default: null },
});

const emit = defineEmits(['close', 'plan', 'create']);

const title = ref('');
const section = ref(props.sections[0] ?? 'post');
const language = ref(props.defaultLanguage ?? props.languages[0] ?? 'zh');
const kind = ref('standalone');

const taxonomySections = computed(() => props.contentKinds?.taxonomy ?? []);

// This site's own shape: a taxonomy section holds term pages, everything else holds files.
function defaultKindFor(name) {
  return taxonomySections.value.includes(name) ? 'branch-bundle' : 'standalone';
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    title.value = '';
    section.value = props.sections[0] ?? 'post';
    language.value = props.defaultLanguage ?? props.languages[0] ?? 'zh';
    kind.value = defaultKindFor(section.value);
  },
);

// Choosing a taxonomy section switches the shape to match, so the common mistake (writing a
// `categories/Name.md` that Hugo will never read as a term page) cannot be made by accident.
watch(section, (name) => {
  if (taxonomySections.value.includes(name)) kind.value = 'branch-bundle';
  else if (kind.value === 'branch-bundle') kind.value = 'standalone';
});

const request = computed(() => ({ kind: kind.value, section: section.value, title: title.value, language: language.value }));
const canPlan = computed(() => title.value.trim().length > 0 && !props.busy);
const hasConflict = computed(() => (props.plan?.conflicts?.length ?? 0) > 0);

const currentKindLabel = computed(() => contentKindLabel(props.plan?.contentKind ?? null));
const shapeHint = computed(() => {
  if (kind.value === 'branch-bundle') {
    return '会创建一个栏目/分类页：content/<目录>/<名称>/_index.md，目录下的子页面由 Hugo 管理';
  }
  if (kind.value === 'leaf-bundle') {
    return '会创建一个目录：content/<目录>/<名称>/index.md，可以放自己的图片等资源';
  }
  return '会创建一个文件：content/<目录>/<名称>.md';
});

function languageLabel(code) {
  return code === props.defaultLanguage ? `${code}（默认，无后缀）` : code;
}
</script>

<template>
  <ModalShell v-if="open" title="新建文档" :busy="busy" @close="emit('close')">
    <div class="form-grid">
      <label>
        <span>形态</span>
        <select v-model="kind" :disabled="busy">
          <option value="standalone">{{ formLabel('standalone') }}（content/&lt;目录&gt;/名称.md）</option>
          <option value="leaf-bundle">{{ formLabel('leaf-bundle') }}（content/&lt;目录&gt;/名称/index.md）</option>
          <option value="branch-bundle">{{ formLabel('branch-bundle') }}（content/&lt;目录&gt;/名称/_index.md）</option>
        </select>
      </label>
      <label>
        <span>目录</span>
        <select v-model="section" :disabled="busy">
          <option v-for="name in sections" :key="name" :value="name">
            {{ name }}<template v-if="taxonomySections.includes(name)">（分类页目录）</template>
          </option>
        </select>
      </label>
      <p class="shape wide">{{ shapeHint }}</p>
      <label>
        <span>语言</span>
        <select v-model="language" :disabled="busy">
          <option v-for="code in languages" :key="code" :value="code">{{ languageLabel(code) }}</option>
        </select>
      </label>
      <label class="wide">
        <span>标题</span>
        <input v-model="title" :disabled="busy" spellcheck="false" placeholder="会用来生成文件名" @keyup.enter="canPlan && emit('plan', request)" />
      </label>
    </div>

    <p v-if="error" class="error-line">{{ error }}</p>

    <div v-if="plan" class="plan">
      <div class="line"><span>路径</span><code>{{ plan.path }}</code></div>
      <div class="line"><span>类型</span><code>{{ currentKindLabel }} · {{ formLabel(plan.kind) }} · {{ plan.language }}</code></div>
      <p v-for="warning in plan.warnings" :key="warning" class="warn-line">⚠ {{ warning }}</p>
      <p v-if="hasConflict" class="error-line">
        该路径已存在：<code>{{ plan.conflicts.map((entry) => entry.path).join(', ') }}</code>
      </p>
      <pre class="preview">{{ plan.text }}</pre>
    </div>

    <template #footer>
      <button type="button" class="mini" :disabled="!canPlan" @click="emit('plan', request)">生成计划（dry-run）</button>
      <button
        type="button"
        class="btn primary"
        :disabled="!plan || hasConflict || busy"
        @click="emit('create', request)"
      >
        确认创建
      </button>
      <span class="hint">创建后是草稿（draft: true），会立即触发一次构建</span>
    </template>
  </ModalShell>
</template>

<style scoped>
/* The creation dialog: a two-column form grid. Inputs, buttons and banners come
   from base.css, so this dialog cannot drift from the delete dialog. */

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-lg);
}

label {
  display: grid;
  gap: var(--space-xs);
  color: var(--muted);
  font-size: var(--text-sm);
}

label.wide {
  grid-column: 1 / -1;
}

.shape {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--muted);
  font-size: var(--text-xs);
}

.plan {
  margin-top: var(--space-lg);
  padding-top: var(--space-md);
  border-top: 1px solid var(--border);
}

.line {
  display: flex;
  gap: var(--space-md);
  margin-bottom: var(--space-xs);
  font-size: var(--text-sm);
}

.line span {
  min-width: 60px;
  color: var(--muted);
}

.line code,
.error-line code {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.preview {
  margin: var(--space-md) 0 0;
  padding: var(--space-md);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-2);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  white-space: pre-wrap;
}
</style>
