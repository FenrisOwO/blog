<script setup>
// The content tree, grouped by section.
//
// Phase 1 showed one section; the site has four places Markdown lives (post, page,
// categories and the content root), so the list is grouped and each group carries its
// count. Translation groups are marked so "this article also exists in 3 other languages"
// is visible before anything is edited.
//
// The rows use the shell's list primitive (`.list-item` in base.css) and the shared badge:
// the type, the form, the language and the translation count are the same badge as everywhere
// else, so a badge cannot drift from the ones in the workspace head or the inspector.
// The draft marker used to be an inline span inside the title, which is why it sat half a
// pixel off the baseline; it is a badge in the title's own flex row now.

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

const SECTION_ICONS = { post: '📝', page: '📄', categories: '🏷' };

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
        icon: SECTION_ICONS[name] ?? '🏠',
        kinds: [...(groupKind.value.get(name) ?? [])].map(contentKindLabel).join(' / '),
        count: bySection.get(name).length,
        documents: bySection.get(name),
      };
    });
});
</script>

<template>
  <div class="tree">
    <section v-for="group in grouped" :key="group.section || '(root)'" class="doc-section">
      <header class="section-head">
        <span class="icon sm" aria-hidden="true">{{ group.icon }}</span>
        <span class="section-label">{{ group.label }}</span>
        <span v-if="group.kinds" class="section-kind">{{ group.kinds }}</span>
        <span class="spacer"></span>
        <span class="count">{{ group.count }}</span>
      </header>

      <ul class="list docs">
        <li v-for="doc in group.documents" :key="doc.path">
          <button
            type="button"
            class="list-item selectable doc-row"
            :class="{ selected: doc.path === selectedPath }"
            :aria-current="doc.path === selectedPath ? 'true' : undefined"
            :title="doc.path"
            @click="emit('select', doc)"
          >
            <span class="body">
              <span class="row-titles">
                <span class="title">{{ titleOf(doc) }}</span>
                <span v-if="doc.meta?.draft" class="badge warn">草稿</span>
              </span>
              <span class="meta">
                {{ doc.path }}
                <template v-if="doc.updatedAt"> · {{ formatUpdated(doc.updatedAt) }}</template>
              </span>
            </span>

            <span class="badges">
              <span class="badge accent">{{ contentKindLabel(doc.contentKind) }}</span>
              <span class="badge info">{{ formLabel(doc.kind) }}</span>
              <span class="badge">{{ doc.language }}</span>
              <span
                v-if="translationsOf.get(doc.translationKey) > 1"
                class="badge ok"
                :title="`该页面有 ${translationsOf.get(doc.translationKey)} 个语言版本`"
              >
                ×{{ translationsOf.get(doc.translationKey) }}
              </span>
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
/* The scroll container of the article selector. Rows, badges and the selected
   state come from base.css; only this pane's own rhythm is set here. */

.tree {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.section-head {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  min-height: var(--control-h);
  padding: 0 var(--panel-pad-x);
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--muted);
}

.section-label {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text);
}

.section-kind {
  color: var(--faint);
  font-size: var(--text-2xs);
}

.docs .doc-row {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--panel-pad-x);
  border-radius: 0;
  border-bottom: 1px solid var(--border);
}

.docs .doc-row:hover {
  background: var(--surface-2);
}

.docs .doc-row.selected {
  background: var(--accent-soft);
  box-shadow: inset 2px 0 0 var(--accent);
}

.row-titles {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  min-width: 0;
}

.badges {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  flex: 0 0 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
}

@media (max-width: 1200px) {
  .badges {
    display: none;
  }
}
</style>
