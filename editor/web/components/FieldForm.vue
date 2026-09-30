<script setup>
// The front-matter form.
//
// It edits fields one at a time and reports what the user typed; it never renders YAML and
// never assembles a document. Everything here is a *request*: the server decides what will
// actually change, and says so before anything is written.
//
// Fields the engine cannot rewrite losslessly are shown read-only with the engine's own
// reason, so the form never quietly drops part of a document.

import { computed, reactive, ref, watch } from 'vue';

import { asList, asText, collectEdits } from '../fieldDrafts.js';

const props = defineProps({
  model: { type: Object, default: null }, // the /api/documents/fields payload
  disabled: { type: Boolean, default: false },
});

const emit = defineEmits(['edits']);

const drafts = reactive({});
const listDrafts = reactive({});
const added = ref([]);
const removed = ref([]);

function fill(model) {
  for (const key of Object.keys(drafts)) delete drafts[key];
  for (const key of Object.keys(listDrafts)) delete listDrafts[key];
  added.value = [];
  removed.value = [];

  if (!model) return;
  for (const field of model.fields) {
    if (!field.editable) continue;
    if (field.editor === 'list') listDrafts[field.path] = asList(field.value);
    else drafts[field.path] = asText(field);
  }
}

watch(() => props.model, fill, { immediate: true, deep: false });

const editableFields = computed(() => (props.model?.fields ?? []).filter((field) => field.editable));
const lockedFields = computed(() => (props.model?.fields ?? []).filter((field) => !field.editable));
const addableFields = computed(() =>
  (props.model?.missing ?? []).filter((field) => field.creatable && !added.value.includes(field.key)),
);

function addField(field) {
  added.value = [...added.value, field.key];
  if (field.editor === 'list') listDrafts[field.key] = '';
  else drafts[field.key] = '';
}

function dropField(path) {
  // Two different ✕ buttons: one removes a field the user just added, the other marks an
  // existing field for deletion. The document decides which.
  if (added.value.includes(path)) added.value = added.value.filter((key) => key !== path);
  else removed.value = [...removed.value, path];
  delete listDrafts[path];
  delete drafts[path];
}

function restoreField(field) {
  removed.value = removed.value.filter((path) => path !== field.path);
  if (field.editor === 'list') listDrafts[field.path] = asList(field.value);
  else drafts[field.path] = asText(field);
}

function isRemoved(path) {
  return removed.value.includes(path);
}

const edits = computed(() =>
  collectEdits(props.model, { drafts, listDrafts, added: added.value, removed: removed.value }),
);

watch(edits, (next) => emit('edits', next), { deep: true });
</script>

<template>
  <div class="form">
    <p v-if="model && !model.editable" class="notice">表单不可用：{{ model.reason }}。请在“原文”标签中编辑。</p>

    <template v-else-if="model">
      <section v-if="editableFields.length > 0" class="group">
        <h4>字段</h4>
        <p class="rule">留空表示不修改；要删除某个字段，请点该行右侧的 ✕。</p>
        <div v-for="field in editableFields" :key="field.path" class="row" :class="{ gone: isRemoved(field.path) }">
          <label :for="`f-${field.path}`">
            <span class="label">{{ field.label }}</span>
            <code class="path">{{ field.path }}</code>
          </label>

          <div class="input">
            <template v-if="isRemoved(field.path)">
              <span class="gone-note">保存后将删除该字段</span>
              <button type="button" class="mini" :disabled="disabled" @click="restoreField(field)">撤销</button>
            </template>

            <template v-else-if="field.editor === 'list'">
              <textarea
                :id="`f-${field.path}`"
                v-model="listDrafts[field.path]"
                :disabled="disabled"
                rows="3"
                spellcheck="false"
                placeholder="每行一个"
              ></textarea>
            </template>

            <template v-else-if="field.editor === 'boolean'">
              <select :id="`f-${field.path}`" v-model="drafts[field.path]" :disabled="disabled">
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </template>

            <template v-else>
              <input
                :id="`f-${field.path}`"
                v-model="drafts[field.path]"
                :disabled="disabled"
                :type="field.editor === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text'"
                spellcheck="false"
              />
            </template>
          </div>

          <button
            v-if="field.level === 0 && !isRemoved(field.path)"
            type="button"
            class="mini danger"
            :disabled="disabled"
            title="删除该字段"
            @click="dropField(field.path)"
          >
            ✕
          </button>
          <span v-else class="spacer-cell"></span>
        </div>
      </section>

      <section v-if="addableFields.length > 0" class="group">
        <h4>可添加字段</h4>
        <div class="chips">
          <button
            v-for="field in addableFields"
            :key="field.key"
            type="button"
            class="chip"
            :disabled="disabled"
            :title="`新增 ${field.key}（${field.type}）`"
            @click="addField(field)"
          >
            + {{ field.label }} <code>{{ field.key }}</code>
          </button>
        </div>
      </section>

      <section v-if="added.length > 0" class="group">
        <h4>将新增</h4>
        <div v-for="key in added" :key="key" class="row">
          <label :for="`n-${key}`"><span class="label">{{ key }}</span><code class="path">新字段</code></label>
          <div class="input">
            <textarea
              v-if="listDrafts[key] !== undefined"
              :id="`n-${key}`"
              v-model="listDrafts[key]"
              :disabled="disabled"
              rows="3"
              spellcheck="false"
              placeholder="每行一个"
            ></textarea>
            <input v-else :id="`n-${key}`" v-model="drafts[key]" :disabled="disabled" spellcheck="false" />
          </div>
          <button type="button" class="mini danger" :disabled="disabled" @click="dropField(key)">✕</button>
        </div>
      </section>

      <section v-if="lockedFields.length > 0" class="group">
        <h4>只读</h4>
        <div v-for="field in lockedFields" :key="field.path" class="locked">
          <code>{{ field.path }}</code>
          <span class="reason">{{ field.reason }}</span>
        </div>
      </section>
    </template>

    <p v-else class="notice">未选择文档。</p>
  </div>
</template>

<style scoped>
.form {
  overflow: auto;
  padding: 10px 14px 16px;
  font-size: 12px;
}

.notice {
  margin: 6px 0;
  color: var(--warning);
}

.group {
  margin-bottom: 14px;
}

.rule {
  margin: 0 0 6px;
  color: var(--faint);
  font-size: 11px;
}

h4 {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--muted);
  font-weight: 600;
}

.row {
  display: grid;
  grid-template-columns: 190px 1fr 28px;
  gap: 8px;
  align-items: start;
  padding: 4px 0;
}

.row.gone .label {
  text-decoration: line-through;
  color: var(--faint);
}

label {
  display: grid;
  gap: 2px;
}

.label {
  color: var(--text);
}

.path {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 10.5px;
  color: var(--faint);
}

.input {
  display: flex;
  gap: 6px;
  align-items: center;
}

input,
select,
textarea {
  width: 100%;
  padding: 4px 7px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  font: inherit;
  font-size: 12px;
  color: var(--text);
  background: var(--surface);
}

textarea {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  resize: vertical;
}

.mini {
  padding: 2px 7px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface);
  color: var(--muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.mini.danger {
  color: var(--error);
}

.mini:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.spacer-cell {
  display: block;
}

.gone-note {
  color: var(--error);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  padding: 3px 9px;
  border: 1px dashed var(--border-strong);
  border-radius: 12px;
  background: var(--surface-2);
  color: var(--muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.chip:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.chip code {
  color: var(--faint);
}

.locked {
  display: flex;
  gap: 8px;
  padding: 2px 0;
  color: var(--muted);
}

.locked code {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px;
}

.reason {
  font-size: 11px;
  color: var(--faint);
}
</style>
