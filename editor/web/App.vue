<script setup>
// Phase 8: the editor, as one coherent application.
//
// What was a stack of phase-specific panes is now a shell with four regions - a rail, a
// workspace, an inspector and a status bar - and five views (content, assets, relations,
// settings, git). The behaviour of Phases 1-7 is unchanged and deliberately so: every write is
// still "a plan you can read, then a confirm", the editor still never touches the filesystem,
// and the page still only speaks HTTP.
//
// The two things this phase adds are both about the *editing* experience:
//
//   * the Markdown input engine (toolbar, Ctrl+B…, `/` menu, link/image/table/code dialogs),
//     which never leaves source-text form and only ever rewrites the selection;
//   * a status bar and an inspector that answer "is it saved?", "did it build?", "does git see
//     it?" without the user having to go looking.

import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import { contentKindLabel, formLabel } from './contentLabels.js';
import AssetPanel from './components/AssetPanel.vue';
import CommandPalette from './components/CommandPalette.vue';
import CreateDocumentDialog from './components/CreateDocumentDialog.vue';
import DeleteDocumentDialog from './components/DeleteDocumentDialog.vue';
import DocumentList from './components/DocumentList.vue';
import FieldForm from './components/FieldForm.vue';
import GitPanel from './components/GitPanel.vue';
import MarkdownDialogs from './components/MarkdownDialogs.vue';
import MarkdownEditor from './components/MarkdownEditor.vue';
import PreviewPane from './components/PreviewPane.vue';
import RelationsPanel from './components/RelationsPanel.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import StatusBar from './components/StatusBar.vue';
import ToastStack from './components/ToastStack.vue';
import TrashPanel from './components/TrashPanel.vue';
import { buildCommands } from './commands.js';
import { createThemeStore } from './theme.js';
import { createToastStore } from './toast.js';

import { findLink } from '../src/editorCore/markdown.js';

const documents = ref([]);
const loadingDocuments = ref(true);
const sections = ref([]);
const groups = ref([]);
const selectedDoc = ref(null);
const selectedPath = ref(null);
const meta = ref(null);

const mode = ref('raw'); // 'form' | 'raw'
const view = ref('content'); // 'content' | 'assets' | 'relations' | 'settings' | 'git'

// The rail is data, not five near-identical buttons: one shape per entry, one
// place that decides what a navigation item looks like. Icons are emoji inside
// `.icon` boxes (see base.css) so they cannot drift from their label.
const VIEWS = [
  { id: 'content', icon: '📄', label: '内容' },
  { id: 'assets', icon: '🖼', label: '资源' },
  { id: 'relations', icon: '🔗', label: '关系' },
  { id: 'settings', icon: '⚙️', label: '站点设置' },
  { id: 'git', icon: '🌿', label: 'Git' },
];

function navCount(id) {
  if (id === 'content') return loadingDocuments.value ? '…' : String(documents.value.length);
  const total = gitStatus.value?.counts?.total;
  if (id === 'git') return total ? String(total) : '';
  return '';
}
const previewMode = ref('split'); // 'editor' | 'split' | 'preview'
const inspectorOpen = ref(true);
// The article selector. It is a region of the content view, open by default: the list is how a
// document is chosen, so a collapsed-by-default list is a missing feature, not a tidy layout.
const listOpen = ref(true);
const searchQuery = ref('');
const paletteOpen = ref(false);

const originalText = ref('');
const currentText = ref('');
const initialText = ref('');
const editorKey = ref(0);

const preview = ref(null);
const previewFor = ref(null);
const saveResult = ref(null);
const readback = ref(null);

const fieldsModel = ref(null);
const formEdits = ref({ set: {}, remove: [] });
const formPreview = ref(null);
const formPreviewFor = ref('');
const formResult = ref(null);

const busy = ref(false);
const error = ref(null);
const coreInfo = ref(null);
const editorRef = ref(null);
const saveState = ref('clean');
const fatal = ref(null);

// Phase 8: the Markdown dialogs, and the snapshot they apply against.
const mdDialog = ref('');
const mdSelection = ref({ anchor: 0, head: 0 });
const existingLink = ref(null);

const theme = createThemeStore();
const toasts = createToastStore();
// The store owns the state and the OS listener; the component keeps reactive copies so the
// template re-renders when the theme changes (a `data-theme` attribute is not reactive).
const themePreference = ref(theme.preference);
const themeResolved = ref(theme.resolved);
theme.subscribe(({ preference, resolved }) => {
  themePreference.value = preference;
  themeResolved.value = resolved;
});

function catchFatal(cause) {
  fatal.value = String(cause?.message ?? cause);
}

if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => catchFatal(event.error ?? event.message));
  window.addEventListener('unhandledrejection', (event) => catchFatal(event.reason));
}

// Phase 2 state
const buildStatus = ref(null);
const siteInfo = ref(null);
const autoRefreshPreview = ref(true);
const showLog = ref(false);
const buildError = ref(null);

// Phase 8: git
const gitStatus = ref(null);
const gitReloadKey = ref(0);

// Phase 3 dialogs
const createOpen = ref(false);
const createPlan = ref(null);
const createError = ref(null);
const deleteOpen = ref(false);
const deletePlan = ref(null);
const deleteError = ref(null);
const trashOpen = ref(false);
const trashEntries = ref([]);
const trashError = ref(null);

const dirty = computed(() => currentText.value !== originalText.value);
const canCommit = computed(
  () => Boolean(preview.value) && preview.value.status !== 'noop' && previewFor.value === currentText.value && !busy.value,
);

const editableFields = computed(() => fieldsModel.value?.editable === true);
const formChanges = computed(() => Object.keys(formEdits.value.set ?? {}).length + (formEdits.value.remove ?? []).length);
const canPreviewForm = computed(() => editableFields.value && formChanges.value > 0 && !busy.value);
const canSaveForm = computed(
  () =>
    Boolean(formPreview.value) &&
    formPreview.value.changed === true &&
    formPreviewFor.value === JSON.stringify(formEdits.value) &&
    !busy.value,
);

const generation = computed(() => buildStatus.value?.generation ?? 0);
const previewUrl = computed(() => buildStatus.value?.preview?.url ?? '/');
const autoBuildOnSave = computed(() => buildStatus.value?.autoBuildOnSave ?? true);

const visibleDocuments = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (query === '') return documents.value;
  return documents.value.filter((doc) =>
    [doc.path, doc.meta?.title ?? '', contentKindLabel(doc.contentKind), doc.section].some((value) =>
      String(value).toLowerCase().includes(query),
    ),
  );
});

const bundlePath = computed(() => selectedDoc.value?.bundlePath ?? '');

// The inspector's facts, in one object so the template stays readable.
const facts = computed(() => {
  if (!meta.value) return [];
  return [
    { label: '路径', value: selectedPath.value },
    { label: '类型', value: `${contentKindLabel(meta.value.contentKind)} · ${formLabel(meta.value.kind)}` },
    { label: '分区', value: meta.value.section || '(根)' },
    { label: '语言', value: meta.value.language },
    { label: 'front matter', value: (meta.value.frontMatterKeys ?? []).join(', ') || '（无）' },
  ];
});

const gitForDocument = computed(() => {
  if (!selectedPath.value || !gitStatus.value?.changes) return null;
  return gitStatus.value.changes.find((change) => change.path === selectedPath.value) ?? null;
});

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

function postJson(path, payload) {
  return api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// The editor itself is the source of truth for "what the user currently sees".
function editorText() {
  return editorRef.value ? editorRef.value.getText() : currentText.value;
}

function resetTransientState() {
  preview.value = null;
  previewFor.value = null;
  saveResult.value = null;
  readback.value = null;
  formPreview.value = null;
  formPreviewFor.value = '';
  formResult.value = null;
}

// Every message the user sees goes through the toast stack now; nothing in this file calls
// window.alert, and an error is a sentence rather than a stack trace.
function note(message) {
  toasts.info(message);
}

watch(dirty, (next) => {
  if (saveState.value !== 'saving') saveState.value = next ? 'dirty' : 'clean';
});

// --- data ------------------------------------------------------------------

async function loadDocuments() {
  loadingDocuments.value = true;
  try {
    const data = await api('/api/documents');
    documents.value = data.documents ?? [];
    sections.value = data.sections ?? [];
    groups.value = data.groups ?? [];
  } finally {
    loadingDocuments.value = false;
  }
}

async function loadFields(path) {
  fieldsModel.value = await api('/api/documents/fields?path=' + encodeURIComponent(path));
  formEdits.value = { set: {}, remove: [] };
  formPreview.value = null;
  formPreviewFor.value = '';
}

async function openDocument(doc) {
  busy.value = true;
  error.value = null;
  try {
    const data = await api('/api/documents/raw?path=' + encodeURIComponent(doc.path));
    selectedDoc.value = doc;
    selectedPath.value = doc.path;
    meta.value = {
      kind: data.kind,
      contentKind: data.contentKind,
      language: data.language,
      section: data.section,
      frontMatterKeys: data.frontMatterKeys,
    };
    originalText.value = data.text;
    currentText.value = data.text;
    initialText.value = data.text;
    editorKey.value += 1;
    resetTransientState();
    await loadFields(doc.path);
  } catch (cause) {
    error.value = String(cause.message ?? cause);
    toasts.error('无法打开文档', { text: String(cause.message ?? cause) });
  } finally {
    busy.value = false;
  }
}

// --- P1/P2: raw text ------------------------------------------------------

async function runPreview() {
  busy.value = true;
  error.value = null;
  resetTransientState();
  try {
    const text = editorText();
    const data = await postJson('/api/documents/preview', { path: selectedPath.value, text });
    preview.value = data;
    previewFor.value = text;
    currentText.value = text;
  } catch (cause) {
    error.value = String(cause.message ?? cause);
  } finally {
    busy.value = false;
  }
}

async function commitPreviewed() {
  if (!canCommit.value) return;
  busy.value = true;
  error.value = null;
  saveState.value = 'saving';
  try {
    const text = editorText();
    const result = await postJson('/api/documents/save', {
      path: selectedPath.value,
      text,
      confirm: true,
    });
    saveResult.value = result;

    // Re-read from disk and compare against what the editor still shows.
    const fresh = await api('/api/documents/raw?path=' + encodeURIComponent(selectedPath.value));
    originalText.value = fresh.text;
    readback.value = { matches: fresh.text === editorText(), sha: result.shaAfter };
    preview.value = null;
    previewFor.value = null;
    saveState.value = readback.value.matches ? 'saved' : 'error';
    if (result.status === 'noop') note('内容没有变化，未写入任何字节。');

    await loadDocuments();
    await loadFields(selectedPath.value);
    await refreshGit();

    // The server schedules a build for a real save; pick the new status up immediately
    // so the user is not left wondering whether anything happened.
    if (result.buildScheduled) await pollBuildStatus();
  } catch (cause) {
    error.value = String(cause.message ?? cause);
    saveState.value = 'error';
    toasts.error('保存失败', { text: `${String(cause.message ?? cause)}（磁盘内容没有被改动）` });
  } finally {
    busy.value = false;
  }
}

function cancelEdit() {
  if (editorRef.value) editorRef.value.setText(originalText.value);
  currentText.value = originalText.value;
  resetTransientState();
  note('已放弃未保存的修改。');
}

// One keystroke for "save": the dry run still runs first, so Ctrl+S can never bypass the
// plan-then-confirm gate the server enforces.
async function saveCurrent() {
  if (mode.value === 'form') {
    if (!canPreviewForm.value && !canSaveForm.value) return;
    await previewForm();
    await saveForm();
    return;
  }
  if (!dirty.value || busy.value) return;
  await runPreview();
  await commitPreviewed();
}

// --- P3.2: the front-matter form -----------------------------------------

function applyFormEdits(next) {
  formEdits.value = next;
}

async function previewForm() {
  busy.value = true;
  error.value = null;
  formPreview.value = null;
  try {
    const payload = { path: selectedPath.value, ...formEdits.value };
    const data = await postJson('/api/documents/fields/preview', payload);
    formPreview.value = data;
    formPreviewFor.value = JSON.stringify(formEdits.value);
  } catch (cause) {
    error.value = String(cause.message ?? cause);
  } finally {
    busy.value = false;
  }
}

async function saveForm() {
  if (!canSaveForm.value) return;
  busy.value = true;
  error.value = null;
  saveState.value = 'saving';
  try {
    const payload = { path: selectedPath.value, ...formEdits.value, confirm: true };
    formResult.value = await postJson('/api/documents/fields/save', payload);

    const fresh = await api('/api/documents/raw?path=' + encodeURIComponent(selectedPath.value));
    originalText.value = fresh.text;
    currentText.value = fresh.text;
    initialText.value = fresh.text;
    editorKey.value += 1;
    saveState.value = 'saved';

    await loadDocuments();
    await loadFields(selectedPath.value);
    await refreshGit();

    if (formResult.value.buildScheduled) await pollBuildStatus();
  } catch (cause) {
    error.value = String(cause.message ?? cause);
    saveState.value = 'error';
    toasts.error('表单保存失败', { text: String(cause.message ?? cause) });
  } finally {
    busy.value = false;
  }
}

// --- P3.3: creating --------------------------------------------------------

function openCreate() {
  createOpen.value = true;
  createPlan.value = null;
  createError.value = null;
}

async function planCreate(request) {
  busy.value = true;
  createError.value = null;
  try {
    createPlan.value = await postJson('/api/documents/create', request);
  } catch (cause) {
    createError.value = String(cause.message ?? cause);
    createPlan.value = null;
  } finally {
    busy.value = false;
  }
}

async function confirmCreate(request) {
  busy.value = true;
  createError.value = null;
  try {
    const created = await postJson('/api/documents/create', { ...request, confirm: true });
    createOpen.value = false;
    createPlan.value = null;
    await loadDocuments();
    const doc = documents.value.find((candidate) => candidate.path === created.path);
    if (doc) await openDocument(doc);
    if (created.buildScheduled) await pollBuildStatus();
    await refreshGit();
    toasts.success('已创建文档', { text: created.path });
  } catch (cause) {
    createError.value = String(cause.message ?? cause);
  } finally {
    busy.value = false;
  }
}

// --- P3.4: deleting -------------------------------------------------------

function openDelete() {
  deleteOpen.value = true;
  deletePlan.value = null;
  deleteError.value = null;
}

async function planDelete(request) {
  busy.value = true;
  deleteError.value = null;
  try {
    deletePlan.value = await postJson('/api/documents/delete', request);
  } catch (cause) {
    deleteError.value = String(cause.message ?? cause);
    deletePlan.value = null;
  } finally {
    busy.value = false;
  }
}

async function confirmDelete(request) {
  busy.value = true;
  deleteError.value = null;
  try {
    const result = await postJson('/api/documents/delete', { ...request, confirm: true });
    deleteOpen.value = false;
    deletePlan.value = null;

    // The document being edited may be the one that just left.
    const gone = result.files.map((file) => file.path);
    await loadDocuments();
    if (selectedPath.value && gone.includes(selectedPath.value)) {
      selectedPath.value = null;
      selectedDoc.value = null;
      meta.value = null;
      fieldsModel.value = null;
      if (documents.value.length > 0) await openDocument(documents.value[0]);
    }
    if (result.buildScheduled) await pollBuildStatus();
    await refreshGit();
    toasts.success('已移入回收站', { text: `${result.target}（${result.totalFiles} 个文件）` });
  } catch (cause) {
    deleteError.value = String(cause.message ?? cause);
  } finally {
    busy.value = false;
  }
}

async function openTrash() {
  trashOpen.value = true;
  trashError.value = null;
  await refreshTrash();
}

async function refreshTrash() {
  try {
    trashEntries.value = (await api('/api/trash')).entries ?? [];
  } catch (cause) {
    trashError.value = String(cause.message ?? cause);
  }
}

async function restoreTrash(id) {
  busy.value = true;
  trashError.value = null;
  try {
    const restored = await postJson('/api/trash/restore', { id, confirm: true });
    await refreshTrash();
    await loadDocuments();
    if (restored.buildScheduled) await pollBuildStatus();
    await refreshGit();
    toasts.success('已恢复', { text: restored.relPath });
  } catch (cause) {
    trashError.value = String(cause.message ?? cause);
  } finally {
    busy.value = false;
  }
}

// --- Phase 5/6/7 callbacks -------------------------------------------------

async function onAssetsChanged(result) {
  if (result.buildScheduled === false && result.status === 'noop') return;
  await loadDocuments();
  if (result.buildScheduled) await pollBuildStatus();
  await refreshGit();
}

async function onRelationsChanged(result) {
  await loadDocuments();
  if (result.buildScheduled) await pollBuildStatus();
  await refreshGit();
}

async function onSettingsSaved(result) {
  if (result.status === 'noop') {
    note('站点设置没有变化，未写入任何文件。');
    return;
  }
  const files = (result.files ?? []).filter((file) => file.status === 'written').map((file) => file.file);
  toasts.success('站点设置已保存', {
    text: `${files.join('、')}（备份 ${(result.files ?? []).filter((file) => file.backupPath).length} 份）`,
  });
  if (result.buildScheduled) await pollBuildStatus();
  await refreshGit();
}

// --- Phase 2: build -------------------------------------------------------

async function pollBuildStatus() {
  try {
    buildStatus.value = await api('/api/build/status');
  } catch (cause) {
    buildError.value = String(cause.message ?? cause);
  }
}

let pollTimer = null;
let stopped = false;
let gitTicks = 0;

async function pollLoop() {
  await pollBuildStatus();
  gitTicks += 1;
  // Git is polled far more slowly than the build: a status call is cheap but not free, and the
  // panel also refreshes itself after every write.
  if (gitTicks % 10 === 0) await refreshGit();
  if (stopped) return;
  const active = ['running', 'queued'].includes(buildStatus.value?.state);
  pollTimer = setTimeout(pollLoop, active ? 500 : 1500);
}

async function triggerBuild() {
  buildError.value = null;
  try {
    await postJson('/api/build', { trigger: 'manual' });
    await pollBuildStatus();
  } catch (cause) {
    buildError.value = String(cause.message ?? cause);
    toasts.error('无法启动构建', { text: String(cause.message ?? cause) });
  }
}

async function setAutoBuild(onSave) {
  try {
    await postJson('/api/build/auto', { onSave });
    await pollBuildStatus();
  } catch (cause) {
    buildError.value = String(cause.message ?? cause);
  }
}

async function loadSiteInfo() {
  try {
    siteInfo.value = await api('/api/site');
  } catch {
    // informational only
  }
}

// --- Phase 8: git ---------------------------------------------------------

async function refreshGit() {
  try {
    gitStatus.value = await api('/api/git/status');
  } catch (cause) {
    gitStatus.value = { repository: null, reason: String(cause.message ?? cause), changes: [], counts: { total: 0 } };
  }
}

async function onGitChanged() {
  await refreshGit();
  gitReloadKey.value += 1;
}

// --- Phase 8: Markdown dialogs -------------------------------------------

function openMarkdownDialog({ id }) {
  mdDialog.value = id;
  const selection = mdSelection.value;
  const text = editorRef.value?.getText() ?? '';
  existingLink.value = id === 'link' ? findLink(text, selection) : null;
}

function applyMarkdownDialog({ id, arg }) {
  const applied = editorRef.value?.applyDialog(id, arg);
  mdDialog.value = '';
  existingLink.value = null;
  if (applied === false) {
    toasts.warning('没有插入任何内容', { text: '编辑期间内容发生了变化，请重试。' });
  }
}

function closeMarkdownDialog() {
  mdDialog.value = '';
  editorRef.value?.cancelDialog();
  existingLink.value = null;
}

function onEditorSelection(selection) {
  mdSelection.value = selection;
}

// --- Phase 8: commands, theme, keyboard ----------------------------------

const commands = computed(() =>
  buildCommands(
    {
      view: view.value,
      documents: documents.value,
      selectedPath: selectedPath.value,
      dirty: dirty.value,
      busy: busy.value,
      theme: themeResolved.value,
      themePreference: themePreference.value,
      inspectorOpen: inspectorOpen.value,
      listOpen: listOpen.value,
      gitChanges: gitStatus.value?.counts?.total ?? 0,
      gitRepository: Boolean(gitStatus.value?.repository),
    },
    actions,
  ),
);

const actions = {
  go: (next) => {
    view.value = next;
  },
  create: openCreate,
  save: saveCurrent,
  preview: runPreview,
  discard: cancelEdit,
  build: triggerBuild,
  openPreview: () => window.open(previewUrl.value, '_blank', 'noopener'),
  refresh: async () => {
    await loadDocuments();
    await refreshGit();
    note('已重新读取内容树与 git 状态。');
  },
  trash: openTrash,
  toggleTheme: () => theme.toggle(),
  setTheme: (preference) => theme.set(preference),
  toggleInspector: () => {
    inspectorOpen.value = !inspectorOpen.value;
  },
  toggleList: () => {
    listOpen.value = !listOpen.value;
  },
  // Searching filters the list, so a search that arrives while the list is closed has to reopen
  // it - otherwise the match count changes somewhere the user cannot see.
  focusSearch: () => {
    view.value = 'content';
    listOpen.value = true;
    document.querySelector('.topbar-search input')?.focus();
  },
  commit: () => {
    view.value = 'git';
  },
  gitHistory: () => {
    view.value = 'git';
  },
  open: (doc) => openDocument(doc),
};

function onGlobalKeydown(event) {
  const target = event.target;
  const typing = target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    paletteOpen.value = !paletteOpen.value;
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    saveCurrent();
    return;
  }
  if (event.key === 'Escape') {
    if (paletteOpen.value) paletteOpen.value = false;
    return;
  }
  // A single, deliberate shortcut for the palette-adjacent things while typing: not hijacking
  // any plain letter, because the editor is a text field.
  if (typing) return;
  if (event.key === '?') paletteOpen.value = true;
}

watch(mode, (next, previous) => {
  if (previous === 'form' && formChanges.value > 0 && next === 'raw') {
    formEdits.value = { set: {}, remove: [] };
    formPreview.value = null;
    note('表单中未保存的修改已丢弃（切换到原文）。');
  }
});

onMounted(async () => {
  window.addEventListener('keydown', onGlobalKeydown);
  await loadSiteInfo();
  await refreshGit();
  pollLoop();
  try {
    await loadDocuments();
    if (documents.value.length > 0) await openDocument(documents.value[0]);
  } catch (cause) {
    error.value = String(cause.message ?? cause);
  }
});

onUnmounted(() => {
  stopped = true;
  window.removeEventListener('keydown', onGlobalKeydown);
  if (pollTimer) clearTimeout(pollTimer);
});
</script>

<template>
  <div class="app">
    <header class="topbar">
      <span class="brand"><span class="dot" aria-hidden="true"></span>Hugo Visual Editor</span>
      <span class="badge">Phase 8</span>

      <label v-if="view === 'content'" class="search topbar-search">
        <span class="icon sm" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" stroke-linecap="round" />
          </svg>
        </span>
        <input v-model="searchQuery" type="search" placeholder="筛选文档（路径 / 标题 / 类型）" aria-label="筛选文档" />
        <kbd>/</kbd>
      </label>

      <span class="spacer"></span>

      <button type="button" class="btn mini" :disabled="busy" title="构建站点（hugo）" @click="triggerBuild">
        <span v-if="['running', 'queued'].includes(buildStatus?.state)" class="spinner" aria-hidden="true"></span>
        <span class="icon sm" aria-hidden="true">🏗</span>
        <span>构建</span>
        <span v-if="generation" class="badge">#{{ generation }}</span>
      </button>

      <button
        type="button"
        class="icon-btn"
        :aria-label="`切换到${themeResolved === 'dark' ? '浅色' : '深色'}主题`"
        :title="`主题：${themeResolved === 'dark' ? '深色' : '浅色'}`"
        @click="theme.toggle()"
      >
        <span class="icon" aria-hidden="true">{{ themeResolved === 'dark' ? '🌙' : '☀️' }}</span>
      </button>

      <button type="button" class="btn mini" title="命令面板 (Ctrl+K)" @click="paletteOpen = true">
        <span class="icon sm" aria-hidden="true">⌘</span>
        <span>命令</span>
        <kbd>Ctrl</kbd><kbd>K</kbd>
      </button>
    </header>

    <p v-if="fatal" class="warn-line fatal">界面错误（未捕获）：{{ fatal }}</p>
    <p v-if="buildError" class="warn-line fatal">构建接口错误：{{ buildError }}</p>

    <div
      class="shell"
      :class="{
        'with-browser': view === 'content' && listOpen,
        'with-inspector': view === 'content' && inspectorOpen,
      }"
    >
      <nav class="rail" aria-label="主导航">
        <button
          v-for="item in VIEWS"
          :key="item.id"
          type="button"
          class="nav-item"
          :aria-current="view === item.id ? 'page' : undefined"
          @click="view = item.id"
        >
          <span class="icon" aria-hidden="true">{{ item.icon }}</span>
          <span class="label">{{ item.label }}</span>
          <span v-if="navCount(item.id)" class="count">{{ navCount(item.id) }}</span>
        </button>

        <div class="nav-section">工具</div>
        <button type="button" class="nav-item" :disabled="busy" @click="openCreate">
          <span class="icon" aria-hidden="true">➕</span><span class="label">新建文档</span>
        </button>
        <button type="button" class="nav-item" :disabled="busy" @click="openTrash">
          <span class="icon" aria-hidden="true">🗑</span><span class="label">回收站</span>
        </button>
        <button type="button" class="nav-item" @click="paletteOpen = true">
          <span class="icon" aria-hidden="true">⌘</span><span class="label">命令面板</span>
          <span class="shortcut">Ctrl K</span>
        </button>
      </nav>

      <!-- ============================ content ============================ -->
      <template v-if="view === 'content'">
        <!-- The article selector: the list this view is built around. It is mounted here, next
             to the workspace it feeds, and it is what the topbar search filters. -->
        <aside v-if="listOpen" class="browser" aria-label="文章选择">
          <header class="browser-head">
            <span class="icon sm" aria-hidden="true">📄</span>
            <span class="title">文章</span>
            <span class="badge" :title="`筛选后 ${visibleDocuments.length} 篇，共 ${documents.length} 篇`">
              {{ loadingDocuments ? '…' : `${visibleDocuments.length}/${documents.length}` }}
            </span>
            <span v-if="searchQuery.trim()" class="badge accent">筛选中</span>
            <span class="spacer"></span>
            <button type="button" class="icon-btn mini" title="收起文章列表" aria-label="收起文章列表" @click="listOpen = false">
              <span class="icon sm" aria-hidden="true">⟨</span>
            </button>
          </header>
          <div class="browser-body">
            <DocumentList
              :documents="visibleDocuments"
              :sections="sections"
              :groups="groups"
              :selected-path="selectedPath"
              :loading="loadingDocuments"
              @select="openDocument"
            />
          </div>
        </aside>

        <section class="workspace content-view">
          <header class="workspace-head">
            <button
              type="button"
              class="btn mini"
              :aria-pressed="listOpen"
              :title="listOpen ? '收起文章列表' : '展开文章列表'"
              @click="listOpen = !listOpen"
            >
              <span class="icon sm" aria-hidden="true">📄</span>
              <span>文章列表</span>
            </button>
            <code class="path">{{ selectedPath ?? '（未选择文档）' }}</code>
            <span v-if="meta" class="badge">{{ contentKindLabel(meta.contentKind) }} · {{ formLabel(meta.kind) }} · {{ meta.section || '(根)' }} · {{ meta.language }}</span>
            <span v-if="dirty" class="badge warn">未保存</span>
            <span v-else class="badge ok">已保存</span>
            <span class="spacer"></span>
            <div class="segmented" role="group" aria-label="预览布局">
              <button type="button" :aria-pressed="previewMode === 'editor'" title="只显示编辑区" @click="previewMode = 'editor'">编辑</button>
              <button type="button" :aria-pressed="previewMode === 'split'" title="编辑 + 预览" @click="previewMode = 'split'">分栏</button>
              <button type="button" :aria-pressed="previewMode === 'preview'" title="只显示预览" @click="previewMode = 'preview'">预览</button>
            </div>
            <button type="button" class="btn mini danger" :disabled="busy || !selectedPath" @click="openDelete">
              <span class="icon sm" aria-hidden="true">🗑</span>
              <span>删除</span>
            </button>
          </header>

          <div class="tabs">
            <button type="button" class="tab" :aria-current="mode === 'raw' ? 'page' : undefined" @click="mode = 'raw'">原文</button>
            <button type="button" class="tab" :aria-current="mode === 'form' ? 'page' : undefined" @click="mode = 'form'">表单</button>
            <span v-if="mode === 'form' && formChanges > 0" class="badge warn">{{ formChanges }} 处待提交</span>
            <span class="spacer"></span>
            <span class="hint">表单与原文都只提交「预览 → 确认」两步</span>
          </div>

          <div class="toolbar">
            <template v-if="mode === 'raw'">
              <button type="button" class="btn" :disabled="busy || !selectedPath" @click="runPreview">预览变更（dry-run）</button>
              <button type="button" class="btn primary" :disabled="!canCommit" @click="commitPreviewed">确认保存</button>
              <button type="button" class="btn" :disabled="busy || !dirty" @click="cancelEdit">放弃修改</button>
              <span class="hint">必须先预览，且内容未再变化，才能保存</span>
            </template>
            <template v-else>
              <button type="button" class="btn" :disabled="!canPreviewForm" @click="previewForm">预览变更（dry-run）</button>
              <button type="button" class="btn primary" :disabled="!canSaveForm" @click="saveForm">确认保存</button>
              <span class="hint">表单只改 front matter；正文与缩进不会被重排</span>
            </template>
            <span class="spacer"></span>
            <span v-if="preview" class="badge accent">dry-run：{{ preview.status }} +{{ preview.diff.added }}/-{{ preview.diff.removed }}</span>
            <span v-if="saveResult" class="badge ok">已写入 · sha {{ String(saveResult.shaAfter).slice(0, 8) }}</span>
          </div>

          <p v-if="error" class="warn-line fatal">{{ error }}</p>

          <div class="split" :class="previewMode === 'split' ? 'editor-preview' : previewMode === 'preview' ? 'preview-only' : ''">
            <div class="pane" v-show="previewMode !== 'preview'">
              <template v-if="mode === 'raw'">
                <MarkdownEditor
                  ref="editorRef"
                  :key="editorKey"
                  :initial-text="initialText"
                  :read-only="false"
                  @ready="coreInfo = $event"
                  @change="currentText = $event"
                  @selection="onEditorSelection"
                  @dialog="openMarkdownDialog"
                />
                <div v-if="preview || saveResult" class="panel docs">
                  <div v-if="preview" class="panel-head">
                    <span class="panel-title">变更预览</span>
                    <span class="badge">status: {{ preview.status }}</span>
                    <span class="badge">+{{ preview.diff.added }} / -{{ preview.diff.removed }}</span>
                    <span class="badge">正文变更: {{ preview.frontMatter.bodyChanged ? '是' : '否' }}</span>
                  </div>
                  <pre v-if="preview" class="diff"><code v-for="(line, index) in String(preview.diffText).split('\n')" :key="index" class="diff-line">{{ line }}</code></pre>
                  <div v-if="saveResult" class="panel-head">
                    <span class="panel-title">保存结果</span>
                    <span class="badge">备份 {{ saveResult.backupPath ?? '无' }}</span>
                    <span class="badge" :class="readback && !readback.matches ? 'err' : 'ok'">
                      {{ readback && readback.matches ? '编辑器内容 == 磁盘内容' : '编辑器内容 != 磁盘内容' }}
                    </span>
                    <span class="badge">{{ saveResult.buildScheduled ? '已触发构建' : '未触发构建' }}</span>
                  </div>
                </div>
              </template>
              <div v-else class="form-scroll">
                <div v-if="formPreview" class="panel">
                  <div class="panel-head">
                    <span class="panel-title">表单变更预览</span>
                    <span class="badge">status: {{ formPreview.status }}</span>
                    <span class="badge">+{{ formPreview.diff.added }} / -{{ formPreview.diff.removed }}</span>
                    <span class="badge">正文未改动: {{ formPreview.bodyUnchanged ? '是' : '否' }}</span>
                  </div>
                  <div class="panel-body">
                    <div class="fact"><span>将修改 / 新增</span><span>{{ formPreview.applied.filter((entry) => entry.action !== 'unchanged').map((entry) => `${entry.path}(${entry.action})`).join(', ') || '（无）' }}</span></div>
                    <div class="fact"><span>未应用</span><span>{{ formPreview.skipped.map((entry) => `${entry.path}: ${entry.reason}`).join('; ') || '（无）' }}</span></div>
                    <p v-for="warning in formPreview.warnings" :key="warning" class="warn-line">⚠ {{ warning }}</p>
                    <pre class="diff"><code v-for="(line, index) in String(formPreview.diffText).split('\n')" :key="index" class="diff-line">{{ line }}</code></pre>
                  </div>
                </div>
                <div v-if="formResult" class="panel">
                  <div class="panel-head">
                    <span class="panel-title">表单保存结果</span>
                    <span class="badge">status: {{ formResult.status }}</span>
                    <span v-if="formResult.saved" class="badge">sha {{ formResult.saved.shaBefore.slice(0, 12) }} → {{ formResult.saved.shaAfter.slice(0, 12) }}</span>
                  </div>
                </div>
                <FieldForm :model="fieldsModel" :disabled="busy" @edits="applyFormEdits" />
              </div>
            </div>
            <div v-if="previewMode !== 'editor'" class="pane preview-pane">
              <PreviewPane :url="previewUrl" :generation="generation" v-model:auto-refresh="autoRefreshPreview" />
            </div>
          </div>
        </section>

        <aside v-if="inspectorOpen" class="inspector" aria-label="检查器">
          <div>
            <h4>文档</h4>
            <div v-for="fact in facts" :key="fact.label" class="fact"><span>{{ fact.label }}</span><span>{{ fact.value }}</span></div>
            <p v-if="!facts.length" class="hint">没有打开的文档。</p>
          </div>

          <div>
            <h4>Markdown 输入</h4>
            <div class="fact"><span>内核</span><span>{{ coreInfo?.name ?? '…' }}</span></div>
            <div class="fact"><span>选区</span><span>{{ mdSelection.anchor }}–{{ mdSelection.head }}</span></div>
            <p class="hint">
              工具栏、<kbd>Ctrl+B</kbd>、<kbd>/</kbd> 命令都走同一个命令表，只改选中的文字；文档始终是 Markdown 源文本。
            </p>
          </div>

          <div>
            <h4>构建</h4>
            <div class="fact"><span>状态</span><span>{{ buildStatus?.state ?? '未知' }}</span></div>
            <div class="fact"><span>代次</span><span>#{{ generation }}</span></div>
            <label class="fact check"><input type="checkbox" :checked="autoBuildOnSave" @change="setAutoBuild($event.target.checked)" /><span>保存后自动构建</span></label>
            <div class="row">
              <button type="button" class="btn mini" @click="triggerBuild">立即构建</button>
              <button type="button" class="btn mini ghost" @click="showLog = !showLog">{{ showLog ? '隐藏日志' : '显示日志' }}</button>
            </div>
            <pre v-if="showLog" class="log"><code>{{ (buildStatus?.lastBuild?.message ?? '（还没有构建日志）') }}</code></pre>
          </div>

          <div>
            <h4>Git</h4>
            <div class="fact"><span>仓库</span><span>{{ gitStatus?.repository ? gitStatus.repository.root : '未初始化' }}</span></div>
            <div class="fact"><span>分支</span><span>{{ gitStatus?.branch ?? '—' }}</span></div>
            <div class="fact"><span>本文档</span><span>{{ gitForDocument ? gitForDocument.kind : '无改动（或未跟踪目录）' }}</span></div>
            <p class="hint">编辑器只会读取 git；提交需要显式勾选文件并确认。</p>
            <button type="button" class="btn mini" @click="view = 'git'">打开 Git 面板</button>
          </div>
        </aside>
      </template>

      <!-- ============================ other views ============================ -->
      <!-- Every view owns its own page structure (.view / .view-head / .view-body),
           so the shell only decides which pane occupies the workspace column. -->
      <AssetPanel v-else-if="view === 'assets'" @changed="onAssetsChanged" />
      <RelationsPanel v-else-if="view === 'relations'" :documents="documents" @changed="onRelationsChanged" />
      <GitPanel
        v-else-if="view === 'git'"
        :reload-key="gitReloadKey"
        :notify="(kind, title, options) => toasts.push(kind, title, options)"
        @changed="onGitChanged"
      />
      <SettingsPanel v-else @saved="onSettingsSaved" />
    </div>

    <StatusBar
      :save="{ state: saveState }"
      :build="buildStatus"
      :git="gitStatus"
      :preview="previewUrl"
      :theme="themeResolved"
      :theme-preference="themePreference"
      :core="coreInfo?.name ?? ''"
      :auto-build-on-save="autoBuildOnSave"
      :list-open="listOpen"
      :inspector-open="inspectorOpen"
      @save="saveCurrent"
      @build="triggerBuild"
      @open-preview="actions.openPreview"
      @theme="(preference) => theme.set(preference)"
      @git="view = 'git'"
      @toggle-inspector="inspectorOpen = !inspectorOpen"
      @toggle-list="listOpen = !listOpen"
    />

    <CommandPalette :open="paletteOpen" :commands="commands" @close="paletteOpen = false" />

    <MarkdownDialogs
      :open="mdDialog"
      :selected-text="String(currentText).slice(mdSelection.anchor, mdSelection.head)"
      :existing-link="existingLink"
      :document-path="selectedPath ?? ''"
      :bundle-path="bundlePath"
      @apply="applyMarkdownDialog"
      @close="closeMarkdownDialog"
    />

    <CreateDocumentDialog
      :open="createOpen"
      :sections="siteInfo?.createSections ?? ['post', 'page']"
      :content-kinds="siteInfo?.contentKinds ?? null"
      :languages="siteInfo?.languages ?? []"
      :default-language="siteInfo?.defaultLanguage ?? null"
      :plan="createPlan"
      :busy="busy"
      :error="createError"
      @close="createOpen = false"
      @plan="planCreate"
      @create="confirmCreate"
    />

    <DeleteDocumentDialog
      :open="deleteOpen"
      :doc="selectedDoc"
      :plan="deletePlan"
      :busy="busy"
      :error="deleteError"
      @close="deleteOpen = false"
      @plan="planDelete"
      @delete="confirmDelete"
    />

    <TrashPanel
      :open="trashOpen"
      :entries="trashEntries"
      :busy="busy"
      :error="trashError"
      @close="trashOpen = false"
      @refresh="refreshTrash"
      @restore="restoreTrash"
    />

    <ToastStack :store="toasts" />
  </div>
</template>

<style scoped>
/* The shell owns the content view's own layout; the shared look of a header, a
   panel, a tab and a control lives in base.css so the other four views can use
   the same ones. */

.content-view {
  min-height: 0;
}

.workspace-head .path {
  font-size: var(--text-sm);
  color: var(--text-strong);
  max-width: 46ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.content-view .split {
  flex: 1 1 auto;
  min-height: 0;
}

.content-view .pane {
  overflow: hidden;
}

/* The diff/readback card sits at the bottom of the editor pane, flush with its
   edges: it is part of the pane, not a card floating inside it. */
.docs {
  margin: 0;
  border-radius: 0;
  border-left: none;
  border-right: none;
  border-bottom: none;
  max-height: 40%;
  overflow: auto;
}

.form-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--panel-pad-x);
}

.log {
  margin: var(--space-sm) 0 0;
  max-height: 220px;
  overflow: auto;
  padding: var(--space-md);
  border-radius: var(--radius-sm);
  background: var(--surface-3);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  white-space: pre-wrap;
}

.diff {
  max-height: 260px;
}

.fatal {
  color: var(--error);
}
</style>
