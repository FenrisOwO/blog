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
    <p v-if="model && !model.editable" class="warn-line">表单不可用：{{ model.reason }}。请在“原文”标签中编辑。</p>

    <template v-else-if="model">
      <section v-if="editableFields.length > 0" class="group">
        <h4>字段</h4>
        <p class="rule">留空表示不修改；要删除某个字段，请点该行右侧的 ✕。</p>
        <div v-for="field in editableFields" :key="field.path" class="form-row" :class="{ gone: isRemoved(field.path) }">
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

            <p v-if="field.reference && !field.reference.ok" class="ref-warn">
              当前值 <code>{{ field.value }}</code> 无法被 Hugo 解析：{{ field.reference.reason }}
              <button
                v-if="field.reference.suggestion"
                type="button"
                class="mini"
                :disabled="disabled"
                @click="drafts[field.path] = field.reference.suggestion"
              >
                用建议值 {{ field.reference.suggestion }}
              </button>
            </p>
            <p v-else-if="field.reference" class="ref-ok">这个引用可以被 Hugo 解析（{{ field.reference.kind }}）。</p>
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
            class="chip-add"
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

    <p v-else class="warn-line">未选择文档。</p>
  </div>
</template>

<style scoped>
/* The front-matter form is a three-column grid: label + path, control, action.
   Everything else - controls, buttons, banners, type - comes from base.css. */

.form {
  overflow: auto;
  padding: var(--panel-pad-x);
}

.form-row {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr) 28px;
  gap: var(--space-md);
  align-items: start;
  padding: var(--space-xs) 0;
}

.form-row.gone .label {
  text-decoration: line-through;
  color: var(--faint);
}

.group {
  margin-bottom: var(--space-lg);
}

.group h4 {
  margin: 0 0 var(--space-sm);
  color: var(--muted);
  font-size: var(--text-sm);
  font-weight: var(--weight-bold);
  text-transform: none;
}

.rule {
  margin: 0 0 var(--space-sm);
  color: var(--faint);
  font-size: var(--text-xs);
}

label {
  display: grid;
  gap: 2px;
}

.label {
  color: var(--text);
}

.path {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--faint);
}

.input,
.locked {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-sm);
  align-items: center;
}

/* The reference verdict is about the value, not a control, so it takes the whole row. */
.ref-warn,
.ref-ok {
  flex: 0 0 100%;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-sm);
  align-items: center;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--warning);
}

.ref-ok {
  color: var(--success);
}

.input > input,
.input > select,
.input > textarea {
  flex: 1 1 auto;
  min-width: 0;
}

textarea {
  font-family: var(--font-mono);
}

.gone-note {
  color: var(--error);
}

/* The "add a field" affordance is deliberately dashed: it is a suggestion, not
   a value that exists yet. */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-sm);
}

.chip-add {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  height: var(--control-h-sm);
  padding: 0 var(--space-md);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  color: var(--muted);
  font: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
}

.chip-add:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.chip-add:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.chip-add code {
  color: var(--faint);
}

.locked {
  flex-wrap: wrap;
  padding: var(--space-xs) 0;
  color: var(--muted);
}

.locked code {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.reason {
  color: var(--faint);
  font-size: var(--text-xs);
}
</style>
