<script setup>
// The content tree, grouped by section.
//
// Phase 1 showed one section; the site has four places Markdown lives (post, page,
// categories and the content root), so the list is grouped and each group carries its
// count. Translation groups are marked so "this article also exists in 3 other languages"
// is visible before anything is edited.

import { computed } from 'vue';

import { contentKindLabel, formLabel, formatUpdated, titleOf } from '../contentLabels.js';

const props = defineProps({
  documents: { type: Array, default: () => [] },
  sections: { type: Array, default: () => [] },
  groups: { type: Array, default: () => [] },
  selectedPath: { type: String, default: null },
  // Reading the whole tree takes seconds on this mount, so "nothing here yet" and "nothing
  // here" must not look the same.
  loading: { type: Boolean, default: false },
});

const emit = defineEmits(['select']);

const translationsOf = computed(() => {
  const map = new Map();
  for (const group of props.groups) {
    if (group.documents.length > 1) map.set(group.translationKey, group.languages.length);
  }
  return map;
});

// Each group is a section, and a section has one meaning in this site (post is where
// articles live, page where the ordinary pages live, categories where the taxonomy terms
// live), so the header can name the type instead of leaving the user to infer it.
const groupKind = computed(() => {
  const map = new Map();
  for (const doc of props.documents) {
    if (!map.has(doc.section)) map.set(doc.section, new Set());
    map.get(doc.section).add(doc.contentKind);
  }
  return map;
});

// The order comes from the server's scope declaration, then any section it did not name.
const grouped = computed(() => {
  const bySection = new Map();
  for (const doc of props.documents) {
    if (!bySection.has(doc.section)) bySection.set(doc.section, []);
    bySection.get(doc.section).push(doc);
  }

  const order = props.sections.map((entry) => entry.section);
  const extra = [...bySection.keys()].filter((name) => !order.includes(name));
  return [...order, ...extra]
    .filter((name) => bySection.has(name))
    .map((name) => {
      const declared = props.sections.find((entry) => entry.section === name);
      return {
        section: name,
        label: declared?.label ?? (name === '' ? '(根)' : name),
        kinds: [...(groupKind.value.get(name) ?? [])].map(contentKindLabel).join(' / '),
        count: bySection.get(name).length,
        documents: bySection.get(name),
      };
    });
});
</script>

<template>
  <div class="tree">
    <section v-for="group in grouped" :key="group.section || '(root)'" class="section">
      <header class="section-head">
        <code>{{ group.label }}</code>
        <span v-if="group.kinds" class="section-kind">{{ group.kinds }}</span>
        <span class="count">{{ group.count }}</span>
      </header>

      <ul class="doc-list">
        <li v-for="doc in group.documents" :key="doc.path">
          <button type="button" :class="{ active: doc.path === selectedPath }" @click="emit('select', doc)">
            <span class="title">
              {{ titleOf(doc) }}
              <span v-if="doc.meta?.draft" class="draft">草稿</span>
            </span>
            <span class="badges">
              <span class="badge type">{{ contentKindLabel(doc.contentKind) }}</span>
              <span class="badge kind">{{ formLabel(doc.kind) }}</span>
              <span class="badge">{{ doc.language }}</span>
              <span
                v-if="translationsOf.get(doc.translationKey) > 1"
                class="badge tr"
                :title="`该页面有 ${translationsOf.get(doc.translationKey)} 个语言版本`"
              >
                ×{{ translationsOf.get(doc.translationKey) }}
              </span>
            </span>
            <span class="path">
              {{ doc.path }}
              <span v-if="doc.updatedAt" class="when">· {{ formatUpdated(doc.updatedAt) }}</span>
            </span>
          </button>
        </li>
      </ul>
    </section>

    <p v-if="loading" class="empty">正在读取内容树…</p>
    <p v-else-if="grouped.length === 0" class="empty">没有可编辑的文档。</p>
  </div>
</template>

<style scoped>
.tree {
  overflow-y: auto;
  flex: 1;
}

.section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px 4px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--surface-3);
  font-size: 11px;
  color: var(--muted);
}

.section-head code {
  font-family: ui-monospace, Menlo, Consolas, monospace;
}

.count {
  padding: 0 6px;
  border-radius: 8px;
  background: var(--surface-3);
  color: var(--muted);
}

.doc-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.doc-list button {
  display: grid;
  gap: 3px;
  width: 100%;
  padding: 7px 14px;
  border: 0;
  border-bottom: 1px solid var(--surface-3);
  background: transparent;
  text-align: left;
  cursor: pointer;
  font: inherit;
}

.doc-list button:hover {
  background: var(--surface-2);
}

.doc-list button.active {
  background: var(--accent-soft);
}

.title {
  font-size: 13px;
  color: var(--text);
}

.draft {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 7px;
  background: var(--warning-soft);
  color: var(--warning);
  font-size: 10.5px;
}

.badges {
  display: flex;
  gap: 6px;
}

.badge {
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--surface-3);
  color: var(--muted);
  font-size: 11px;
}

.badge.kind {
  background: var(--info-soft);
  color: var(--info);
}

.badge.type {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.section-kind {
  color: var(--faint);
  font-size: 10.5px;
}

.when {
  color: var(--border-strong);
}

.badge.tr {
  background: var(--success-soft);
  color: var(--success);
}

.path {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty {
  padding: 12px 14px;
  font-size: 12px;
  color: var(--faint);
}
</style>
