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

// Social icons come from three places, and the form shows all three: the theme's own icons (a
// name), every Phosphor name the installed package holds (a name, `phosphor-<name>`), and a
// picture the user picks (a path, `image:<location>:<path>` - the service copies/embeds it into
// the site's `assets/icons/` and writes the name that resolves to it). The picture list is the
// same `/api/assets` listing the Resources screen shows; a failed fetch only costs the picker.
const imageOptions = ref([]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif', '.bmp']);

const iconChoices = computed(() => [
  ...(settings.value?.theme.icons ?? []),
  ...(settings.value?.theme.phosphorIcons ?? []).map((name) => `phosphor-${name}`),
]);

function imageChoicesFrom(listing) {
  const out = [];
  const add = (location, where, assets) => {
    for (const asset of assets ?? []) {
      const name = asset.filename ?? asset.path ?? '';
      const dot = name.lastIndexOf('.');
      if (dot < 0 || !IMAGE_EXTENSIONS.has(name.slice(dot).toLowerCase())) continue;
      out.push({ value: `image:${location}:${asset.path}`, label: `${where} · ${asset.relativePath ?? asset.path}` });
    }
  };
  for (const bundle of listing?.bundles ?? []) add('content', bundle.bundlePath || '内容根目录', bundle.resources);
  add('static', '站点静态文件', listing?.static);
  add('assets', 'Hugo 管线资源', listing?.assets);
  return out;
}

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
    // The picture picker is a convenience on top of the icon names: if the listing fails, the
    // screen still works.
    imageOptions.value = await api('/api/assets').then(imageChoicesFrom).catch(() => []);
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

// Choosing a picture writes the same draft the text field does, in the form the service reads:
// `image:<location>:<path>`. The select resets itself, so picking the same picture twice works.
function setEntryIcon(row, entry, event) {
  const value = event.target.value;
  event.target.value = '';
  if (value) state.value.drafts[`${row.id}[${entry.index}].params.icon`] = value;
}

function setNewIcon(event) {
  const value = event.target.value;
  event.target.value = '';
  if (value) newEntry.value.icon = value;
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
  <div class="view settings">
    <header class="view-head">
      <h2 class="view-title">
        <span class="icon lg" aria-hidden="true">⚙️</span>
        <span>站点设置</span>
        <span v-if="settings" class="badge">{{ settings.configRoot }}</span>
      </h2>
      <p class="view-sub">
        设置是文件里的键：这里显示每个键的值、它来自哪个文件，以及它是不是本站覆盖值。
        主题默认配置只读，保存会在本站配置里写入覆盖值。
      </p>
    </header>

    <p v-if="error" class="error-line">设置错误：{{ error }}</p>
    <div v-if="loading" class="state">
      <span class="spinner" aria-hidden="true"></span>
      <strong>正在读取 config/_default …</strong>
    </div>

    <div v-if="settings && !loading" class="view-body flush settings-body">
      <aside class="settings-nav">
        <div class="nav-head">
          <span class="panel-title">设置分组</span>
        </div>
        <button
          v-for="item in groups"
          :key="item.id"
          type="button"
          class="list-item selectable nav-item"
          :class="{ selected: item.id === groupId }"
          :aria-current="item.id === groupId ? 'true' : undefined"
          @click="groupId = item.id"
        >
          <span class="body">
            <span class="title">{{ item.label }}</span>
            <span class="meta">{{ item.file }}</span>
          </span>
        </button>

        <div class="files">
          <div class="files-head">配置文件</div>
          <div v-for="file in settings.files" :key="file.file" class="list-item file-row">
            <span class="mono">{{ file.file }}</span>
            <span class="count">{{ file.bytes }} B · {{ file.lines }} 行</span>
            <span class="spacer"></span>
            <button type="button" class="mini" @click="openRaw(file.file)">原文</button>
          </div>
          <p class="hint">
            主题 <b>{{ settings.theme.name ?? '（未声明）' }}</b> 的默认配置只读，保存会在本站配置里写入覆盖值。
          </p>
        </div>
      </aside>

      <main class="settings-main">
        <header class="group-head">
          <b>{{ group.label }}</b>
          <span class="hint">{{ group.description }}</span>
        </header>

        <div v-for="row in rows" :key="row.id" class="setting" :class="{ edited: rowEdited(row) || edits.set[row.id] !== undefined }">
          <div class="setting-head">
            <label :for="`f-${row.id}`">{{ row.label }}</label>
            <span class="badge" :class="row.source === 'theme' ? 'info' : ''">{{ sourceLabel(row.source) }}</span>
            <span v-if="!row.editable" class="badge warn">{{ row.readOnlyReason }}</span>
            <span class="spacer"></span>
            <span class="count mono">{{ row.file }}<template v-if="row.path"> · {{ row.path }}</template></span>
          </div>

          <!-- a single value: text / number / select / boolean -->
          <template v-if="row.kind === 'value'">
            <div class="control">
              <template v-if="row.type === 'boolean'">
                <input :id="`f-${row.id}`" v-model="state.drafts[row.id]" type="checkbox" :disabled="!row.editable" />
                <span class="hint">{{ state.drafts[row.id] ? '启用' : '关闭' }}</span>
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

            <p v-if="row.help" class="hint">{{ row.help }}</p>
            <p v-for="warning in row.warnings" :key="warning" class="warn-line">{{ warning }}</p>

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
                  <span class="hint">{{ language.present ? '本站覆盖' : '无覆盖' }}</span>
                </div>
                <p class="hint">留空表示该语言继续使用上层值；覆盖只能修改，删除覆盖不在本阶段范围内。</p>
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
                <span v-if="widget.params && Object.keys(widget.params).length > (widget.params.limit === undefined ? 0 : 1)" class="hint">
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
                <span v-if="entry.icon && !entry.iconKnown" class="warn-line">图标 “{{ entry.icon }}” 不在主题中，构建会失败</span>
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
                  <select
                    v-if="field.key === 'params.icon' && imageOptions.length > 0"
                    class="icon-image"
                    @change="setEntryIcon(row, entry, $event)"
                  >
                    <option value="">或从图片里选…</option>
                    <option v-for="image in imageOptions" :key="image.value" :value="image.value">{{ image.label }}</option>
                  </select>
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
                  <input v-model="newEntry.icon" list="stack-icons" type="text" placeholder="link / phosphor-github-logo" />
                  <select v-if="imageOptions.length > 0" class="icon-image" @change="setNewIcon($event)">
                    <option value="">或从图片里选…</option>
                    <option v-for="image in imageOptions" :key="image.value" :value="image.value">{{ image.label }}</option>
                  </select>
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
                <option v-for="icon in iconChoices" :key="icon" :value="icon" />
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
                  <td class="hint">{{ entry.code }} 的标题覆盖在“常规 · 站点标题”里设置</td>
                </tr>
              </tbody>
            </table>
          </template>
        </div>

        <section v-if="unmanaged.length > 0" class="unmanaged">
          <div class="group-head">
            <b>只读键</b>
            <span class="hint">
              这些键来自第 1-4 阶段（主题、permalinks、cookie 分类等），设置界面只读取它们，保存时会原样保留。
            </span>
          </div>
          <div v-for="file in unmanaged" :key="file.file" class="unmanaged-file">
            <code>{{ file.file }}</code>
            <ul>
              <li v-for="leaf in file.leaves" :key="leaf.path">
                <span class="mono">{{ leaf.path }}</span>
                <span class="hint">{{ valueText(leaf.value) }}</span>
              </li>
            </ul>
          </div>
        </section>
      </main>
    </div>

    <footer v-if="settings && !loading" class="settings-foot">
      <span :class="pending > 0 ? 'dirty' : 'muted'">{{ pending > 0 ? `待保存 ${pending} 处` : '未修改' }}</span>
      <span class="spacer"></span>
      <button type="button" class="btn mini" :disabled="busy || pending === 0" @click="preview">预览改动</button>
      <button type="button" class="btn mini" :disabled="busy" @click="load">重新读取</button>
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
      <p v-for="warning in plan.warnings" :key="warning" class="warn-line">{{ warning }}</p>
      <details v-for="file in plan.files.filter((item) => item.status !== 'noop')" :key="file.file" open>
        <summary>{{ file.file }}（+{{ file.diff.added }} / -{{ file.diff.removed }}）</summary>
        <pre class="diff">{{ file.diffText }}</pre>
      </details>
      <template #footer>
        <span class="hint">保存会先备份原文件，再原子写入并回读校验。</span>
        <span class="spacer"></span>
        <button type="button" class="mini" :disabled="busy" @click="planOpen = false">取消</button>
        <button type="button" class="btn primary" :disabled="busy || plan.changedFiles.length === 0" @click="confirmSave">确认保存</button>
      </template>
    </ModalShell>

    <ModalShell v-if="rawOpen" title="配置文件原文（只读）" @close="rawOpen = false">
      <p v-if="rawError" class="error-line">{{ rawError }}</p>
      <pre class="raw">{{ rawText }}</pre>
      <template #footer>
        <span class="hint">本视图只读：写配置一律经过设置表单，以避免手工编辑破坏 TOML 结构。</span>
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

/* The page is a row: the group/file nav beside the form. `.view-body.flush` makes its child a
   column, which stacked the nav and the form and left the settings themselves below the fold;
   the direction has to be stated here, or the shared class decides it. */
.settings-body {
  display: flex;
  flex-direction: row;
  min-height: 0;
  flex: 1;
  overflow: hidden;
}

.settings-nav {
  width: 260px;
  border-right: 1px solid var(--border);
  padding: var(--space-md);
  overflow: auto;
  background: var(--surface-2);
}

.nav-head {
  display: flex;
  align-items: center;
  min-height: var(--control-h);
  padding: 0 var(--space-sm);
}

/* A group entry is a list row: the label, then the file that group writes. */
.nav-item {
  width: 100%;
  align-items: center;
  font: inherit;
  text-align: left;
}

.nav-item + .nav-item {
  border-top-color: transparent;
}

.files {
  margin-top: var(--space-lg);
  border-top: 1px solid var(--border);
  padding-top: var(--space-md);
}

.files-head {
  padding: 0 var(--space-sm) var(--space-xs);
  color: var(--muted);
  font-size: var(--text-xs);
}

.file-row {
  padding: var(--space-xs) var(--space-sm);
  font-size: var(--text-xs);
}

.settings-main {
  flex: 1;
  overflow: auto;
  padding: var(--space-md) var(--space-lg) var(--space-xl);
}

/* One setting: the key, where it comes from, and its control. */
.setting {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  padding: var(--space-md) var(--space-lg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  margin-bottom: var(--space-md);
}

.setting.edited {
  border-color: var(--warning-border);
  background: var(--warning-soft);
}

.setting-head {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  min-width: 0;
  font-size: var(--text-md);
}

.setting-head label {
  color: var(--text-strong);
  font-weight: var(--weight-medium);
}

.control {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  flex-wrap: wrap;
  min-width: 0;
}

.control > input[type='text'],
.control > input[type='number'],
.control > select {
  flex: 1 1 260px;
  max-width: 460px;
}

.group-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: var(--space-md);
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
  margin-top: var(--space-sm);
}

.override-list {
  margin-top: var(--space-sm);
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}

.override-row {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  font-size: var(--text-sm);
}

.override-row.edited {
  color: var(--warning);
}

.override-row .lang {
  width: 88px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}


.widgets,
.menu-entry,
.menu-add {
  margin-top: var(--space-sm);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.widget-row,
.menu-head {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  font-size: var(--text-sm);
}

.menu-entry {
  border: 1px solid var(--surface-3);
  border-radius: 6px;
  padding: var(--space-sm) var(--space-md);
}

.menu-entry.removing {
  opacity: 0.55;
  text-decoration: line-through;
}

.menu-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--space-sm);
}

.menu-field {
  display: flex;
  flex-direction: column;
  font-size: var(--text-xs);
  color: var(--text);
}

/* The picture picker sits under the icon name, not in place of it: the name stays editable. */
.menu-field .icon-image {
  margin-top: var(--space-xs);
}


.menu-actions {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.lang-table {
  margin-top: var(--space-sm);
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.lang-table th,
.lang-table td {
  border: 1px solid var(--border);
  padding: var(--space-xs) var(--space-sm);
  text-align: left;
}


.unmanaged {
  margin-top: var(--space-xl);
  border-top: 1px dashed var(--border-strong);
  padding-top: var(--space-md);
}

.unmanaged-file ul {
  margin: var(--space-xs) 0 var(--space-md);
  padding-left: var(--space-xl);
  font-size: var(--text-sm);
}

.settings-foot {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  border-top: 1px solid var(--border);
  padding: var(--space-md) var(--space-lg);
  background: var(--surface-2);
}


.dirty {
  color: var(--warning);
  font-size: var(--text-sm);
}

.change-list {
  margin: var(--space-sm) 0;
  padding-left: var(--space-xl);
  font-size: var(--text-sm);
}

.change-list li {
  display: flex;
  gap: var(--space-md);
}

.diff,
.raw {
  max-height: 320px;
  overflow: auto;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: var(--space-md);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--text-xs);
  white-space: pre-wrap;
}

</style>
