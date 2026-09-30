<script setup>
// Phase 5.4: the Site Settings screen.
//
// It never writes TOML and never decides what a setting means. It reads `/api/settings`,
// shows each setting with the layer it came from (the language layer, the site's own config,
// or the theme's default), and sends back only what the user actually changed. The two steps
// every other write in this editor takes are here too: a dry run with a real diff, then an
// explicit save. A setting that only exists in the theme is shown as such, because saving it
// writes a site-level override - that is Hugo config layering, and hiding it would make the
// form lie.

import { computed, onMounted, ref } from 'vue';

import {
  addWidget,
  editCount,
  editsFromDrafts,
  initialDrafts,
  removeWidget,
  setWidgetLimit,
  sourceLabel,
  valueText,
  widgetTypesAvailable,
} from '../settingsDrafts.js';
import ModalShell from './ModalShell.vue';

const emit = defineEmits(['saved']);

const settings = ref(null);
const state = ref({ drafts: {}, widgets: {}, menu: { add: [], remove: [] } });
const groupId = ref('general');
const loading = ref(true);
const busy = ref(false);
const error = ref(null);
const plan = ref(null);
const planOpen = ref(false);
const saveResult = ref(null);
const rawOpen = ref(false);
const rawText = ref('');
const rawError = ref(null);
const openOverrides = ref({});
const newEntry = ref({ identifier: '', name: '', url: '', icon: '', newTab: false });

const groups = computed(() => settings.value?.groups ?? []);
const group = computed(() => groups.value.find((item) => item.id === groupId.value) ?? groups.value[0] ?? null);
const rows = computed(() => (group.value?.settings ?? []).map((id) => settings.value.settings[id]).filter(Boolean));
const edits = computed(() => (settings.value ? editsFromDrafts(settings.value, state.value) : { set: {}, menu: { add: [], remove: [] } }));
const pending = computed(() => editCount(edits.value));
const unmanaged = computed(() => {
  const out = [];
  for (const [file, leaves] of Object.entries(settings.value?.unmanaged ?? {})) out.push({ file, leaves });
  return out;
});

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  return body;
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    settings.value = await api('/api/settings');
    state.value = initialDrafts(settings.value);
    saveResult.value = null;
  } catch (cause) {
    error.value = cause.message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function rowEdited(row) {
  return edits.value.set[row.id] !== undefined;
}

function languageEdited(language) {
  return edits.value.set[language.id] !== undefined;
}

function markedForRemoval(index) {
  return state.value.menu.remove.includes(index);
}

function toggleRemoval(index) {
  const list = state.value.menu.remove;
  state.value.menu.remove = list.includes(index) ? list.filter((item) => item !== index) : [...list, index];
}

function queueEntry() {
  const entry = newEntry.value;
  if (!entry.identifier.trim() || !entry.name.trim() || !entry.url.trim()) return;
  state.value.menu.add.push({ ...entry });
  newEntry.value = { identifier: '', name: '', url: '', icon: '', newTab: false };
}

function dropQueued(index) {
  state.value.menu.add.splice(index, 1);
}

function widgetList(row) {
  return state.value.widgets[row.id] ?? [];
}

function updateWidgets(row, next) {
  state.value.widgets[row.id] = next;
}

async function preview() {
  busy.value = true;
  error.value = null;
  try {
    plan.value = await api('/api/settings/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(edits.value),
    });
    planOpen.value = true;
  } catch (cause) {
    error.value = cause.message;
  } finally {
    busy.value = false;
  }
}

async function confirmSave() {
  busy.value = true;
  error.value = null;
  try {
    saveResult.value = await api('/api/settings/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true, ...edits.value }),
    });
    planOpen.value = false;
    plan.value = null;
    await load();
    emit('saved', saveResult.value);
  } catch (cause) {
    error.value = cause.message;
    planOpen.value = false;
  } finally {
    busy.value = false;
  }
}

async function openRaw(file) {
  rawOpen.value = true;
  rawText.value = '';
  rawError.value = null;
  try {
    const body = await api(`/api/settings/raw?file=${encodeURIComponent(file)}`);
    rawText.value = body.text;
  } catch (cause) {
    rawError.value = cause.message;
  }
}
</script>

<template>
  <div class="settings">
    <p v-if="error" class="error">设置错误：{{ error }}</p>
    <p v-if="loading" class="muted">正在读取 config/_default …</p>

    <div v-if="settings && !loading" class="settings-body">
      <aside class="settings-nav">
        <div class="nav-head">
          <span>站点设置</span>
          <span class="muted small">{{ settings.configRoot }}</span>
        </div>
        <button
          v-for="item in groups"
          :key="item.id"
          type="button"
          class="nav-item"
          :class="{ active: item.id === groupId }"
          @click="groupId = item.id"
        >
          <b>{{ item.label }}</b>
          <span class="file">{{ item.file }}</span>
        </button>

        <div class="files">
          <div class="files-head">配置文件</div>
          <div v-for="file in settings.files" :key="file.file" class="file-row">
            <code>{{ file.file }}</code>
            <span class="muted small">{{ file.bytes }} B · {{ file.lines }} 行</span>
            <button type="button" class="mini" @click="openRaw(file.file)">原文</button>
          </div>
          <p class="muted small">
            主题 <b>{{ settings.theme.name ?? '（未声明）' }}</b> 的默认配置只读，保存会在本站配置里写入覆盖值。
          </p>
        </div>
      </aside>

      <main class="settings-main">
        <header class="group-head">
          <b>{{ group.label }}</b>
          <span class="muted small">{{ group.description }}</span>
        </header>

        <div v-for="row in rows" :key="row.id" class="row" :class="{ edited: rowEdited(row) || edits.set[row.id] !== undefined }">
          <div class="row-head">
            <label :for="`f-${row.id}`">{{ row.label }}</label>
            <span class="badge" :class="row.source ?? 'site'">{{ sourceLabel(row.source) }}</span>
            <span v-if="!row.editable" class="badge warn">{{ row.readOnlyReason }}</span>
            <span class="spacer"></span>
            <span class="muted small mono">{{ row.file }}<template v-if="row.path"> · {{ row.path }}</template></span>
          </div>

          <!-- a single value: text / number / select / boolean -->
          <template v-if="row.kind === 'value'">
            <div class="control">
              <template v-if="row.type === 'boolean'">
                <input :id="`f-${row.id}`" v-model="state.drafts[row.id]" type="checkbox" :disabled="!row.editable" />
                <span class="muted small">{{ state.drafts[row.id] ? '启用' : '关闭' }}</span>
              </template>
              <template v-else-if="row.type === 'select'">
                <select :id="`f-${row.id}`" v-model="state.drafts[row.id]" :disabled="!row.editable">
                  <option value="">（未设置）</option>
                  <option v-for="option in row.options ?? []" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
              </template>
              <template v-else>
                <input
                  :id="`f-${row.id}`"
                  v-model="state.drafts[row.id]"
                  :type="row.type === 'number' ? 'number' : 'text'"
                  :min="row.min ?? undefined"
                  :max="row.max ?? undefined"
                  :disabled="!row.editable"
                  :placeholder="row.source === 'theme' ? `主题默认：${valueText(row.value)}` : ''"
                />
              </template>
            </div>

            <p v-if="row.help" class="muted small">{{ row.help }}</p>
            <p v-for="warning in row.warnings" :key="warning" class="warn small">{{ warning }}</p>

            <div v-if="row.perLanguage" class="overrides">
              <button type="button" class="link" @click="openOverrides[row.id] = !openOverrides[row.id]">
                {{ openOverrides[row.id] ? '收起' : '各语言覆盖' }}
                （{{ row.languageRows.filter((item) => item.present).length }}/{{ row.languageRows.length }} 已覆盖）
              </button>
              <div v-if="openOverrides[row.id]" class="override-list">
                <div v-for="language in row.languageRows" :key="language.id" class="override-row" :class="{ edited: languageEdited(language) }">
                  <span class="lang">{{ language.code }}</span>
                  <input
                    v-model="state.drafts[language.id]"
                    type="text"
                    :placeholder="`继承：${valueText(language.effective)}`"
                  />
                  <span class="muted small">{{ language.present ? '本站覆盖' : '无覆盖' }}</span>
                </div>
                <p class="muted small">留空表示该语言继续使用上层值；覆盖只能修改，删除覆盖不在本阶段范围内。</p>
              </div>
            </div>
          </template>

          <!-- a list of inline tables (widgets) -->
          <template v-else-if="row.kind === 'widgets'">
            <div class="widgets">
              <div v-for="(widget, index) in widgetList(row)" :key="`${row.id}-${index}`" class="widget-row">
                <select
                  :value="widget.type"
                  @change="updateWidgets(row, widgetList(row).map((item, position) => (position === index ? { ...item, type: $event.target.value } : item)))"
                >
                  <option v-for="type in widgetTypesAvailable(row, settings)" :key="type" :value="type">{{ type }}</option>
                </select>
                <label class="inline">
                  limit
                  <input
                    type="number"
                    min="1"
                    :value="widget.params?.limit ?? ''"
                    placeholder="—"
                    @change="updateWidgets(row, setWidgetLimit(widgetList(row), index, $event.target.value))"
                  />
                </label>
                <span v-if="widget.params && Object.keys(widget.params).length > (widget.params.limit === undefined ? 0 : 1)" class="muted small">
                  其他参数：{{ Object.keys(widget.params).filter((key) => key !== 'limit').join(', ') }}（保留）
                </span>
                <span class="spacer"></span>
                <button type="button" class="mini" @click="updateWidgets(row, removeWidget(widgetList(row), index))">移除</button>
              </div>
              <div class="widget-add">
                <button
                  v-for="type in widgetTypesAvailable(row, settings).filter((type) => !widgetList(row).some((widget) => widget.type === type))"
                  :key="type"
                  type="button"
                  class="mini"
                  @click="updateWidgets(row, addWidget(widgetList(row), type))"
                >
                  + {{ type }}
                </button>
              </div>
            </div>
          </template>

          <!-- the social menu -->
          <template v-else-if="row.kind === 'menu-list'">
            <div v-for="entry in row.entries" :key="entry.index" class="menu-entry" :class="{ removing: markedForRemoval(entry.index) }">
              <div class="menu-head">
                <b>{{ entry.name ?? entry.identifier ?? `第 ${entry.index + 1} 条` }}</b>
                <span v-if="entry.icon && !entry.iconKnown" class="warn small">图标 “{{ entry.icon }}” 不在主题中，构建会失败</span>
                <span class="spacer"></span>
                <button type="button" class="mini" @click="toggleRemoval(entry.index)">
                  {{ markedForRemoval(entry.index) ? '取消删除' : '删除' }}
                </button>
              </div>
              <div class="menu-fields">
                <label v-for="field in row.fields" :key="field.key" class="menu-field">
                  <span>{{ field.label }}</span>
                  <input
                    v-if="field.type === 'boolean'"
                    v-model="state.drafts[`${row.id}[${entry.index}].${field.key}`]"
                    type="checkbox"
                  />
                  <input
                    v-else
                    v-model="state.drafts[`${row.id}[${entry.index}].${field.key}`]"
                    :list="field.key === 'params.icon' ? 'stack-icons' : undefined"
                    type="text"
                  />
                </label>
              </div>
            </div>

            <div class="menu-add">
              <div class="menu-head"><b>新增一条</b></div>
              <div class="menu-fields">
                <label class="menu-field"><span>标识</span><input v-model="newEntry.identifier" type="text" placeholder="mastodon" /></label>
                <label class="menu-field"><span>名称</span><input v-model="newEntry.name" type="text" placeholder="Mastodon" /></label>
                <label class="menu-field"><span>链接</span><input v-model="newEntry.url" type="text" placeholder="https://…" /></label>
                <label class="menu-field">
                  <span>图标</span>
                  <input v-model="newEntry.icon" list="stack-icons" type="text" placeholder="link" />
                </label>
                <label class="menu-field"><span>新窗口</span><input v-model="newEntry.newTab" type="checkbox" /></label>
              </div>
              <div class="menu-actions">
                <button type="button" class="mini" :disabled="!newEntry.identifier || !newEntry.name || !newEntry.url" @click="queueEntry">加入待保存</button>
                <span v-for="(entry, index) in state.menu.add" :key="`add-${index}`" class="badge">
                  + {{ entry.name }}
                  <button type="button" class="link" @click="dropQueued(index)">✕</button>
                </span>
              </div>
              <datalist id="stack-icons">
                <option v-for="icon in settings.theme.icons" :key="icon" :value="icon" />
              </datalist>
            </div>
          </template>

          <!-- the language table -->
          <template v-else-if="row.kind === 'language-list'">
            <table class="lang-table">
              <thead>
                <tr>
                  <th>语言</th>
                  <th v-for="field in row.fields" :key="field.key">{{ field.label }}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="entry in row.entries" :key="entry.code">
                  <td><code>{{ entry.code }}</code><span v-if="entry.isDefault" class="badge">默认</span></td>
                  <td v-for="field in row.fields" :key="field.key">
                    <input
                      v-model="state.drafts[`${row.id}.${entry.code}.${field.key}`]"
                      :type="field.type === 'number' ? 'number' : 'text'"
                    />
                  </td>
                  <td class="muted small">{{ entry.code }} 的标题覆盖在“常规 · 站点标题”里设置</td>
                </tr>
              </tbody>
            </table>
          </template>
        </div>

        <section v-if="unmanaged.length > 0" class="unmanaged">
          <div class="group-head">
            <b>只读键</b>
            <span class="muted small">
              这些键来自第 1-4 阶段（主题、permalinks、cookie 分类等），设置界面只读取它们，保存时会原样保留。
            </span>
          </div>
          <div v-for="file in unmanaged" :key="file.file" class="unmanaged-file">
            <code>{{ file.file }}</code>
            <ul>
              <li v-for="leaf in file.leaves" :key="leaf.path">
                <span class="mono">{{ leaf.path }}</span>
                <span class="muted small">{{ valueText(leaf.value) }}</span>
              </li>
            </ul>
          </div>
        </section>
      </main>
    </div>

    <footer v-if="settings && !loading" class="settings-foot">
      <span :class="pending > 0 ? 'dirty' : 'muted'">{{ pending > 0 ? `待保存 ${pending} 处` : '未修改' }}</span>
      <span class="spacer"></span>
      <button type="button" :disabled="busy || pending === 0" @click="preview">预览改动</button>
      <button type="button" :disabled="busy" @click="load">重新读取</button>
    </footer>

    <ModalShell v-if="planOpen && plan" title="设置改动预览（未写入）" :busy="busy" @close="planOpen = false">
      <p class="muted">将写入：{{ plan.changedFiles.join('、') || '（没有改动）' }}</p>
      <ul class="change-list">
        <li v-for="change in plan.changes" :key="`${change.id}-${change.path}`">
          <b>{{ change.label }}</b>
          <span class="mono muted">{{ change.file }} · {{ change.path }}</span>
          <span class="muted">{{ valueText(change.from) }} → {{ valueText(change.to) }}</span>
        </li>
      </ul>
      <p v-for="warning in plan.warnings" :key="warning" class="warn small">{{ warning }}</p>
      <details v-for="file in plan.files.filter((item) => item.status !== 'noop')" :key="file.file" open>
        <summary>{{ file.file }}（+{{ file.diff.added }} / -{{ file.diff.removed }}）</summary>
        <pre class="diff">{{ file.diffText }}</pre>
      </details>
      <template #footer>
        <span class="muted small">保存会先备份原文件，再原子写入并回读校验。</span>
        <span class="spacer"></span>
        <button type="button" :disabled="busy" @click="planOpen = false">取消</button>
        <button type="button" class="primary" :disabled="busy || plan.changedFiles.length === 0" @click="confirmSave">确认保存</button>
      </template>
    </ModalShell>

    <ModalShell v-if="rawOpen" title="配置文件原文（只读）" @close="rawOpen = false">
      <p v-if="rawError" class="error">{{ rawError }}</p>
      <pre class="raw">{{ rawText }}</pre>
      <template #footer>
        <span class="muted small">本视图只读：写配置一律经过设置表单，以避免手工编辑破坏 TOML 结构。</span>
      </template>
    </ModalShell>

    <p v-if="saveResult" class="flash">
      <template v-if="saveResult.status === 'noop'">{{ saveResult.message }}</template>
      <template v-else>
        已写入 {{ saveResult.files.filter((file) => file.status === 'written').map((file) => file.file).join('、') }}；
        备份 {{ saveResult.files.filter((file) => file.backupPath).length }} 份；
        {{ saveResult.buildScheduled ? '已开始重新构建' : '未触发构建（手动构建开关关闭）' }}。
      </template>
    </p>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}

.settings-body {
  display: flex;
  min-height: 0;
  flex: 1;
  overflow: hidden;
}

.settings-nav {
  width: 260px;
  border-right: 1px solid var(--border);
  padding: 8px;
  overflow: auto;
  background: var(--surface-2);
}

.nav-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 6px 8px;
  font-size: 13px;
}

.nav-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  border: 1px solid transparent;
  background: transparent;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.nav-item:hover {
  background: var(--surface-3);
}

.nav-item.active {
  background: var(--surface);
  border-color: var(--border-strong);
}

.nav-item .file,
.small {
  font-size: 11px;
}

.files {
  margin-top: 12px;
  border-top: 1px solid var(--border);
  padding-top: 8px;
}

.files-head {
  font-size: 11px;
  color: var(--muted);
  padding: 0 6px 4px;
}

.file-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 6px;
  font-size: 11px;
}

.file-row code {
  flex: 0 0 auto;
}

.file-row .mini {
  margin-left: auto;
}

.settings-main {
  flex: 1;
  overflow: auto;
  padding: 10px 14px 20px;
}

.group-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 10px;
}

.row {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 8px;
  background: var(--surface);
}

.row.edited {
  border-color: var(--warning);
  box-shadow: inset 3px 0 0 var(--warning);
}

.row-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.control {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}

.control input[type='text'],
.control input[type='number'],
.control select {
  min-width: 260px;
  padding: 3px 6px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  font: inherit;
}

.badge {
  font-size: 11px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  padding: 0 6px;
  color: var(--text);
  background: var(--surface-2);
}

.badge.theme {
  border-color: var(--accent-border);
  background: var(--accent-soft);
}

.badge.warn,
.warn {
  color: var(--warning);
}

.warn {
  font-size: 11px;
}

.muted {
  color: var(--muted);
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.link {
  border: 0;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  padding: 0;
}

.overrides {
  margin-top: 6px;
}

.override-list {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.override-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.override-row.edited {
  color: var(--warning);
}

.override-row .lang {
  width: 88px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.override-row input {
  flex: 0 0 320px;
  padding: 3px 6px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  font: inherit;
}

.widgets,
.menu-entry,
.menu-add {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.widget-row,
.menu-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.menu-entry {
  border: 1px solid var(--surface-3);
  border-radius: 6px;
  padding: 6px 8px;
}

.menu-entry.removing {
  opacity: 0.55;
  text-decoration: line-through;
}

.menu-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 6px;
}

.menu-field {
  display: flex;
  flex-direction: column;
  font-size: 11px;
  color: var(--text);
}

.menu-field input[type='text'] {
  padding: 3px 6px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  font: inherit;
}

.menu-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.lang-table {
  margin-top: 6px;
  border-collapse: collapse;
  font-size: 12px;
}

.lang-table th,
.lang-table td {
  border: 1px solid var(--border);
  padding: 4px 6px;
  text-align: left;
}

.lang-table input {
  width: 140px;
  padding: 3px 6px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  font: inherit;
}

.unmanaged {
  margin-top: 16px;
  border-top: 1px dashed var(--border-strong);
  padding-top: 10px;
}

.unmanaged-file ul {
  margin: 4px 0 10px;
  padding-left: 18px;
  font-size: 12px;
}

.settings-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  border-top: 1px solid var(--border);
  padding: 8px 14px;
  background: var(--surface-2);
}

.settings-foot button,
.menu-actions button,
.widget-row button {
  padding: 3px 8px;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}

.settings-foot button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}

.dirty {
  color: var(--warning);
  font-size: 12px;
}

.change-list {
  margin: 6px 0;
  padding-left: 18px;
  font-size: 12px;
}

.change-list li {
  display: flex;
  gap: 8px;
}

.diff,
.raw {
  max-height: 320px;
  overflow: auto;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  white-space: pre-wrap;
}

.error {
  color: var(--error);
  font-size: 12px;
}

.flash {
  padding: 8px 14px;
  background: var(--success-soft);
  border-top: 1px solid var(--success-border);
  font-size: 12px;
}

.spacer {
  margin-left: auto;
}

.mini {
  padding: 1px 6px;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
}
</style>
