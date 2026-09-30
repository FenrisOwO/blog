<script setup>
// Phase 6: the Resources screen, on the Phase 8 design system.
//
// It is a browser, not an image editor. It lists the binary files the content tree already
// knows about (each one grouped under the bundle that owns it, because a resource without its
// page is a file without a meaning), it previews them, and it offers the four things a
// resource's lifecycle actually has: upload, replace, delete, restore.
//
// Every write goes through the same two steps as the rest of the editor - a plan the user can
// read, then a confirmation. The panel never touches a path the service did not list: the
// preview URL and the write requests are built from what `/api/assets` returned.
//
// The look is not invented here: `.view`/`.view-head`/`.view-body`, `.toolbar`, `.panel`,
// `.list-item`, `.thumb`, `.badge`, `.dialog` and the state classes all come from base.css.

import { computed, onMounted, ref } from 'vue';

import ModalShell from './ModalShell.vue';

const emit = defineEmits(['changed']);

const listing = ref(null);
const location = ref('content');
const loading = ref(true);
const busy = ref(false);
const error = ref(null);
const message = ref(null);
const query = ref('');

// The pending operation: { kind: 'upload' | 'replace' | 'delete', plan, target, file? }
const pending = ref(null);
const restored = ref(null);

// The upload dialog: which bundle it targets, and the file the user picked.
const uploadOpen = ref(false);
const uploadFor = ref('');
const uploadName = ref('');

const locations = computed(() => [
  { id: 'content', label: '内容资源', count: listing.value?.summary.contentResources ?? 0 },
  { id: 'static', label: '站点静态文件', count: listing.value?.summary.staticFiles ?? 0 },
  { id: 'assets', label: 'Hugo 管线资源', count: listing.value?.summary.pipelineFiles ?? 0 },
]);
const summary = computed(() => listing.value?.summary ?? null);
const limits = computed(() => listing.value?.limits ?? { maxUploadBytes: 0, uploadExtensions: [] });
const bundles = computed(() => listing.value?.bundles ?? []);
const readOnlyFiles = computed(() => (location.value === 'static' ? listing.value?.static : listing.value?.assets) ?? []);
const writableBundles = computed(() => bundles.value.filter((bundle) => bundle.canUpload));

const scopeNote = computed(() =>
  location.value === 'static'
    ? '这些文件由站点直接使用（static/ 原样发布），只列出与预览：替换或删除它们没有可校验的反向引用。'
    : '这些文件交给 Hugo 管线处理（assets/），只列出与预览：替换或删除它们没有可校验的反向引用。',
);

function matches(text) {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return true;
  return String(text ?? '').toLowerCase().includes(needle);
}

function assetMatches(asset) {
  return matches(asset.filename) || matches(asset.path) || matches(asset.extension) || matches(asset.mimeType);
}

// Filtering is a view concern: the listing stays exactly what the service returned.
const visibleBundles = computed(() =>
  bundles.value
    .map((bundle) => ({ ...bundle, resources: bundle.resources.filter(assetMatches) }))
    .filter((bundle) => bundle.resources.length > 0),
);
const visibleReadOnly = computed(() => readOnlyFiles.value.filter(assetMatches));
const hiddenCount = computed(() => {
  if (location.value !== 'content') return readOnlyFiles.value.length - visibleReadOnly.value.length;
  return bundles.value.reduce((total, bundle) => total + bundle.resources.filter((asset) => !assetMatches(asset)).length, 0);
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
    listing.value = await api('/api/assets');
  } catch (cause) {
    error.value = String(cause.message ?? cause);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function humanSize(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name} 读取失败`));
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });
}

function note(text) {
  message.value = text;
  setTimeout(() => {
    if (message.value === text) message.value = null;
  }, 6000);
}

function setScope(id) {
  location.value = id;
  error.value = null;
}

// -- upload ----------------------------------------------------------------------------

function openUpload(bundle) {
  pending.value = null;
  error.value = null;
  uploadOpen.value = true;
  uploadName.value = '';
  uploadFor.value = bundle?.bundlePath ?? writableBundles.value[0]?.bundlePath ?? '';
}

function closeUpload() {
  uploadOpen.value = false;
  uploadName.value = '';
}

async function planUpload(file) {
  busy.value = true;
  error.value = null;
  try {
    const data = await readAsBase64(file);
    const plan = await api('/api/assets/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bundlePath: uploadFor.value, filename: file.name }),
    });
    uploadName.value = file.name;
    pending.value = { kind: 'upload', plan, dataBase64: data, filename: file.name };
  } catch (cause) {
    error.value = String(cause.message ?? cause);
  } finally {
    busy.value = false;
  }
}

// -- replace ---------------------------------------------------------------------------

async function planReplace(asset, file) {
  busy.value = true;
  error.value = null;
  try {
    const data = await readAsBase64(file);
    const plan = await api('/api/assets/replace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: asset.path }),
    });
    pending.value = { kind: 'replace', plan, dataBase64: data, filename: file.name, asset };
  } catch (cause) {
    error.value = String(cause.message ?? cause);
  } finally {
    busy.value = false;
  }
}

// -- delete ----------------------------------------------------------------------------

async function planDelete(asset) {
  busy.value = true;
  error.value = null;
  try {
    const plan = await api('/api/assets/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: asset.path }),
    });
    pending.value = { kind: 'delete', plan, asset };
  } catch (cause) {
    error.value = String(cause.message ?? cause);
  } finally {
    busy.value = false;
  }
}

// -- confirm ---------------------------------------------------------------------------

const planTitle = computed(() => {
  if (!pending.value) return '';
  return pending.value.kind === 'upload' ? '新增资源' : pending.value.kind === 'replace' ? '替换资源' : '删除资源';
});

async function confirmPending() {
  if (!pending.value) return;
  busy.value = true;
  error.value = null;
  const { kind, plan } = pending.value;
  try {
    if (kind === 'upload') {
      const result = await api('/api/assets/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bundlePath: uploadFor.value, filename: pending.value.filename, dataBase64: pending.value.dataBase64, confirm: true }),
      });
      note(`已新增 ${result.path}（${humanSize(result.bytes)}）`);
      closeUpload();
      emit('changed', result);
    } else if (kind === 'replace') {
      const result = await api('/api/assets/replace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: plan.path, dataBase64: pending.value.dataBase64, confirm: true }),
      });
      note(result.status === 'noop' ? `${result.path} 内容未变，未写入` : `已替换 ${result.path}（备份 ${result.backupPath ? '1' : '0'} 份）`);
      emit('changed', result);
    } else {
      const result = await api('/api/assets/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: plan.path, confirm: true }),
      });
      restored.value = { id: result.trashId, path: result.path };
      note(`已把 ${result.path} 移入回收站`);
      emit('changed', result);
    }
    pending.value = null;
    await load();
  } catch (cause) {
    error.value = String(cause.message ?? cause);
  } finally {
    busy.value = false;
  }
}

async function restoreLast() {
  if (!restored.value) return;
  busy.value = true;
  error.value = null;
  try {
    const result = await api('/api/trash/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: restored.value.id, confirm: true }),
    });
    note(`已恢复 ${result.relPath}`);
    restored.value = null;
    emit('changed', result);
    await load();
  } catch (cause) {
    error.value = String(cause.message ?? cause);
  } finally {
    busy.value = false;
  }
}

function onPick(event, handler) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (file) handler(file);
}
</script>

<template>
  <div class="view assets-view">
    <header class="view-head">
      <h2 class="view-title">
        <span class="icon lg" aria-hidden="true">🖼</span>
        <span>资源</span>
        <span v-if="summary" class="badge">
          {{ summary.contentResources + summary.staticFiles + summary.pipelineFiles }} 个文件
        </span>
      </h2>
      <p class="view-sub">
        内容资源属于所在的 bundle：替换保持路径不变，引用继续有效；删除会移入回收站，且不会自动改写 Markdown。
        <template v-if="summary">
          共 {{ humanSize(summary.totalBytes) }} · 可替换 {{ summary.replaceable }} ·
          可写类型 <code>{{ limits.uploadExtensions.join(' ') || '—' }}</code> ·
          单文件上限 {{ humanSize(limits.maxUploadBytes) }}
        </template>
      </p>
    </header>

    <div class="toolbar assets-toolbar">
      <div class="segmented" role="group" aria-label="资源范围">
        <button
          v-for="item in locations"
          :key="item.id"
          type="button"
          :aria-pressed="location === item.id"
          @click="setScope(item.id)"
        >
          {{ item.label }}
          <span class="count">{{ item.count }}</span>
        </button>
      </div>

      <label class="search">
        <span class="icon sm" aria-hidden="true">🔍</span>
        <input v-model="query" type="search" placeholder="筛选资源（文件名 / 路径 / 类型）" aria-label="筛选资源" />
      </label>
      <span v-if="hiddenCount > 0" class="badge">已筛掉 {{ hiddenCount }} 个</span>
      <button v-if="query" type="button" class="mini" @click="query = ''">清除</button>

      <span class="spacer"></span>
      <button
        v-if="location === 'content'"
        type="button"
        class="btn primary"
        :disabled="loading || busy || writableBundles.length === 0"
        @click="openUpload(null)"
      >
        <span class="icon sm" aria-hidden="true">➕</span>
        <span>上传资源</span>
      </button>
      <button type="button" class="btn mini" :disabled="loading || busy" @click="load">
        <span class="icon sm" aria-hidden="true">↻</span>
        <span>刷新</span>
      </button>
    </div>

    <div class="view-body scroll">
      <p v-if="error" class="error-line">资源操作失败：{{ error }}</p>
      <p v-if="message" class="flash">{{ message }}</p>

      <div v-if="restored" class="panel">
        <div class="panel-head">
          <span class="icon sm" aria-hidden="true">🗑</span>
          <span class="panel-title">最近删除</span>
          <code class="mono">{{ restored.path }}</code>
          <span class="badge">回收站 id {{ restored.id }}</span>
          <span class="spacer"></span>
          <button type="button" class="mini" :disabled="busy" @click="restoreLast">恢复</button>
        </div>
      </div>

      <div v-if="loading" class="state">
        <span class="spinner" aria-hidden="true"></span>
        <strong>正在读取资源清单…</strong>
      </div>

      <template v-else-if="location === 'content'">
        <p v-if="visibleBundles.length === 0" class="empty">
          {{ query ? '没有匹配的资源。' : '没有发现任何 bundle。' }}
        </p>

        <section v-for="bundle in visibleBundles" :key="bundle.bundlePath" class="panel">
          <header class="panel-head">
            <span class="icon sm" aria-hidden="true">📦</span>
            <span class="panel-title">{{ bundle.bundlePath || '（内容根目录）' }}</span>
            <span class="badge">{{ bundle.contentKind ?? bundle.kind ?? '未知' }}</span>
            <span v-if="bundle.bundleKind" class="badge info">{{ bundle.bundleKind }}</span>
            <span class="count">{{ bundle.documents.length }} 份文档 · {{ bundle.resources.length }} 个资源</span>
            <span class="spacer"></span>
            <button v-if="bundle.canUpload" type="button" class="mini" :disabled="busy" @click="openUpload(bundle)">
              上传到此处
            </button>
            <span v-else class="badge warn" :title="bundle.uploadBlockedReason ?? ''">
              {{ bundle.uploadBlockedReason ?? '不可写入' }}
            </span>
          </header>

          <ul class="list resources">
            <li v-for="asset in bundle.resources" :key="asset.id" class="list-item">
              <img v-if="asset.previewUrl" :src="asset.previewUrl" :alt="asset.filename" class="thumb" />
              <span v-else class="thumb placeholder" aria-hidden="true">{{ asset.extension || '?' }}</span>

              <span class="body">
                <span class="title">{{ asset.filename }}</span>
                <span class="meta">{{ asset.path }} · {{ humanSize(asset.size) }} · {{ asset.mimeType ?? '未知类型' }}</span>
              </span>

              <span class="badge" :class="asset.referenced ? 'ok' : ''">
                {{ asset.referenced ? `被 ${asset.referencedBy.length} 份文档引用` : '未被引用' }}
              </span>
              <span class="badge">{{ asset.capabilities.replace ? '可替换' : '只读' }}</span>

              <span class="actions">
                <label v-if="asset.capabilities.replace" class="mini file-button">
                  替换
                  <input type="file" :disabled="busy" @change="onPick($event, (file) => planReplace(asset, file))" />
                </label>
                <button v-if="asset.capabilities.delete" type="button" class="mini danger" :disabled="busy" @click="planDelete(asset)">
                  删除
                </button>
              </span>
            </li>
          </ul>
        </section>
      </template>

      <template v-else>
        <p class="hint">{{ scopeNote }}</p>
        <p v-if="visibleReadOnly.length === 0" class="empty">
          {{ query ? '没有匹配的资源。' : '这个范围里没有文件。' }}
        </p>
        <section v-else class="panel">
          <header class="panel-head">
            <span class="icon sm" aria-hidden="true">{{ location === 'static' ? '📁' : '🧩' }}</span>
            <span class="panel-title">{{ location === 'static' ? 'static/' : 'assets/' }}</span>
            <span class="count">{{ visibleReadOnly.length }} 个文件</span>
          </header>
          <ul class="list resources">
            <li v-for="asset in visibleReadOnly" :key="asset.id" class="list-item">
              <img v-if="asset.previewUrl" :src="asset.previewUrl" :alt="asset.path" class="thumb" />
              <span v-else class="thumb placeholder" aria-hidden="true">{{ asset.extension || '?' }}</span>
              <span class="body">
                <span class="title">{{ asset.filename ?? asset.path }}</span>
                <span class="meta">{{ asset.path }} · {{ humanSize(asset.size) }} · {{ asset.type }}</span>
              </span>
              <span class="badge">只读</span>
            </li>
          </ul>
        </section>
      </template>
    </div>

    <!-- Upload: pick a target bundle and a file, then read the plan. -->
    <ModalShell v-if="uploadOpen" title="上传资源" :busy="busy" @close="closeUpload">
      <div class="field">
        <span>目标 bundle</span>
        <select v-model="uploadFor" :disabled="busy || pending">
          <option v-for="bundle in writableBundles" :key="bundle.bundlePath" :value="bundle.bundlePath">
            {{ bundle.bundlePath || '（内容根目录）' }}
          </option>
        </select>
      </div>
      <p class="hint">
        上传新文件到 <code>{{ uploadFor || '—' }}</code>：不会覆盖同名文件，重名时会给出可用名称。
        单个文件上限 {{ humanSize(limits.maxUploadBytes) }}。
      </p>
      <div class="field">
        <span>选择文件</span>
        <input type="file" :disabled="busy || !uploadFor" @change="onPick($event, planUpload)" />
      </div>
      <p v-if="uploadName" class="hint">已选择：{{ uploadName }}</p>
      <template #footer>
        <button type="button" class="btn mini" :disabled="busy" @click="closeUpload">取消</button>
        <span class="spacer"></span>
        <button type="button" class="btn primary" :disabled="busy || !pending" @click="confirmPending">确认写入</button>
      </template>
    </ModalShell>

    <!-- The plan: what will be written, before it is written. -->
    <ModalShell v-if="pending && !uploadOpen" :title="planTitle" :busy="busy" @close="pending = null">
      <p>
        <code>{{ pending.plan.path ?? pending.plan.targetPath }}</code>
        <span v-if="pending.plan.status || pending.plan.planned" class="badge">
          status: {{ pending.plan.status ?? 'preview' }}
        </span>
      </p>
      <p class="hint">{{ pending.plan.confirmHint }}</p>
      <p v-if="pending.kind === 'upload'" class="hint">
        新文件：{{ pending.filename }}（{{ humanSize(pending.dataBase64.length * 3 / 4) }}）
        <span v-if="pending.plan.exists"> · 已存在，建议改名 {{ pending.plan.suggestion }}</span>
      </p>
      <p v-if="pending.kind === 'replace'" class="hint">
        替换为：{{ pending.filename }} · 原内容 sha256 <code>{{ String(pending.plan.shaBefore).slice(0, 12) }}</code>
        · 写入前会先备份
      </p>
      <p v-for="warning in pending.plan.warnings ?? []" :key="warning" class="warn-line">⚠ {{ warning }}</p>
      <template #footer>
        <button type="button" class="mini" :disabled="busy" @click="pending = null">取消</button>
        <span class="spacer"></span>
        <button
          type="button"
          class="btn"
          :class="{ danger: pending.kind === 'delete' }"
          :disabled="busy"
          @click="confirmPending"
        >
          {{ pending.kind === 'delete' ? '确认删除' : '确认写入' }}
        </button>
      </template>
    </ModalShell>
  </div>
</template>

<style scoped>
/* Only the layout this view needs; every colour, control and panel metric comes
   from the design system (tokens.css + base.css). */

.assets-toolbar {
  border-bottom: 1px solid var(--border);
}

.assets-view .view-body {
  padding-top: var(--space-lg);
}

.resources .list-item {
  gap: var(--space-lg);
}

.resources .list-item .body {
  gap: 2px;
}

/* The replacement picker is a button that happens to open a file dialog. */
.file-button {
  position: relative;
  overflow: hidden;
}

.file-button input[type='file'] {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

@media (max-width: 1100px) {
  .resources .list-item {
    flex-wrap: wrap;
  }

  .resources .list-item .body {
    flex-basis: 55%;
  }
}
</style>
