<script setup>
// Deleting a document: the plan is shown first, because "the article" can turn out to be
// four language files plus four images, and that is exactly the moment to find out.
//
// Nothing is ever removed outright - the delete moves the files to the editor's trash.
//
// Phase 4: a branch bundle (a category page) can be deleted too, but "the whole thing" means
// something different there - the `_index.md` files and the page's own resources go, while
// child pages inside the same directory stay. The dialog never decides that; the server's
// plan states it and this shows it.

import { computed, ref, watch } from 'vue';

import { contentKindLabel, formLabel } from '../contentLabels.js';
import ModalShell from './ModalShell.vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  doc: { type: Object, default: null },
  plan: { type: Object, default: null },
  busy: { type: Boolean, default: false },
  error: { type: String, default: null },
  confirmWord: { type: Boolean, default: true },
});

const emit = defineEmits(['close', 'plan', 'delete']);

const typed = ref('');

watch(
  () => props.open,
  (open) => {
    if (open) typed.value = '';
  },
);

const isLeaf = computed(() => props.doc?.kind === 'leaf-bundle');
const isBranch = computed(() => props.doc?.kind === 'branch-bundle');
const canDeleteBundle = computed(() => isLeaf.value || isBranch.value);
const bundleLabel = computed(() =>
  isBranch.value ? '删除该栏目页（各语言 _index.md 与资源，保留子页面）' : '删除整个 bundle（含各语言与资源）',
);
// The dry run starts from the NARROW scope on purpose, whatever the row is: the row the user
// clicked is one file, and widening it by itself - especially to the other languages of the
// same page - is the accident this dialog exists to prevent. The wide scope is the button
// whose label spells out what comes with it.
const scope = 'document';
const ready = computed(() => !props.confirmWord || typed.value.trim() === '删除');

function bytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}
</script>

<template>
  <ModalShell v-if="open" title="删除文档" :busy="busy" @close="emit('close')">
    <p class="target">
      目标：<code>{{ doc?.path }}</code>
      <span class="kind">{{ contentKindLabel(doc?.contentKind) }} · {{ formLabel(doc?.kind) }}</span>
    </p>

    <div class="scopes">
      <button
        type="button"
        class="btn"
        :disabled="busy"
        @click="emit('plan', { path: doc.path, scope: 'document' })"
      >
        只删这一个文件
      </button>
      <button
        type="button"
        class="btn"
        :disabled="busy || !canDeleteBundle"
        :title="canDeleteBundle ? '' : '单文件文档只有它自己一个文件'"
        @click="emit('plan', { path: doc.path, scope: 'bundle' })"
      >
        {{ bundleLabel }}
      </button>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="plan" class="plan">
      <div class="facts">
        <div><span>类型</span><code>{{ contentKindLabel(plan.contentKind) }}</code></div>
        <div><span>范围</span><code>{{ plan.scope }}</code></div>
        <div><span>目标</span><code>{{ plan.target }}</code></div>
        <div><span>Markdown</span><code>{{ plan.documentCount }} 个</code></div>
        <div><span>资源文件</span><code>{{ plan.resourceCount }} 个</code></div>
        <div><span>合计</span><code>{{ plan.totalFiles }} 个文件 · {{ bytes(plan.totalBytes) }}</code></div>
      </div>

      <p v-for="warning in plan.warnings" :key="warning" class="warn">⚠ {{ warning }}</p>

      <details>
        <summary>将移动的文件（{{ plan.files.length }}）</summary>
        <ul class="files">
          <li v-for="file in plan.files" :key="file.path"><code>{{ file.path }}</code></li>
        </ul>
      </details>

      <details v-if="plan.kept?.length">
        <summary>会保留的内容（{{ plan.kept.length }}）</summary>
        <ul class="files kept">
          <li v-for="path in plan.kept" :key="path"><code>{{ path }}</code></li>
        </ul>
      </details>

      <p class="recoverable">
        {{ plan.recoverable ? '可恢复：文件会移入回收站，之后可以还原。' : '不可恢复。' }}
      </p>

      <label v-if="confirmWord" class="confirm">
        <span>输入“删除”以确认</span>
        <input v-model="typed" :disabled="busy" placeholder="删除" />
      </label>
    </div>

    <template #footer>
      <button type="button" class="btn" :disabled="busy" @click="emit('plan', { path: doc.path, scope })">
        生成计划（dry-run）
      </button>
      <button
        type="button"
        class="btn danger"
        :disabled="!plan || !ready || busy"
        @click="emit('delete', { path: doc.path, scope: plan.scope })"
      >
        确认删除（移入回收站）
      </button>
      <span class="hint">{{ plan?.confirmHint ?? '' }}</span>
    </template>
  </ModalShell>
</template>

<style scoped>
.target {
  margin: 0 0 10px;
  font-size: 12px;
}

.target code,
.facts code,
.files code {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11.5px;
}

.kind {
  margin-left: 8px;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--info-soft);
  color: var(--info);
  font-size: 11px;
}

.scopes {
  display: flex;
  gap: 8px;
}

.facts {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  margin-top: 12px;
}

.files.kept code {
  color: var(--success);
}

.facts div {
  display: grid;
  gap: 2px;
}

.facts span {
  color: var(--muted);
}

.plan {
  margin-top: 10px;
}

.warn {
  margin: 8px 0 0;
  color: var(--warning);
}

.files {
  margin: 6px 0 0;
  padding-left: 18px;
  max-height: 160px;
  overflow: auto;
}

.recoverable {
  margin: 10px 0 0;
  color: var(--success);
}

.confirm {
  display: grid;
  gap: 3px;
  margin-top: 10px;
  font-size: 12px;
  color: var(--error);
}

.confirm input {
  width: 160px;
  padding: 5px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  font: inherit;
  font-size: 12px;
}

.error {
  margin: 8px 0 0;
  color: var(--error);
}

.btn {
  padding: 5px 12px;
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

.btn.danger {
  border-color: var(--error);
  background: var(--error);
  color: var(--on-accent);
}

.hint {
  margin-left: auto;
  font-size: 11px;
  color: var(--faint);
}
</style>
