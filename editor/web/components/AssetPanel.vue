<script setup>
// Phase 6: the Resources screen.
//
// It is a browser, not an image editor. It lists the binary files the content tree already
// knows about (each one grouped under the bundle that owns it, because a resource without its
// page is a file without a meaning), it previews them, and it offers the four things a
// resource's lifecycle actually has: upload, replace, delete, restore.
//
// Every write goes through the same two steps as the rest of the editor - a plan the user can
// read, then a confirmation. The panel never touches a path the service did not list: the
// preview URL and the write requests are built from what `/api/assets` returned.

import { computed, onMounted, ref } from 'vue';

const emit = defineEmits(['changed']);

const listing = ref(null);
const location = ref('content');
const loading = ref(true);
const busy = ref(false);
const error = ref(null);
const message = ref(null);

// The pending operation: { kind: 'upload' | 'replace' | 'delete', plan, target, file? }
const pending = ref(null);
const restored = ref(null);

const locations = computed(() => [
  { id: 'content', label: '内容资源', count: listing.value?.summary.contentResources ?? 0 },
  { id: 'static', label: '站点静态文件', count: listing.value?.summary.staticFiles ?? 0 },
  { id: 'assets', label: 'Hugo 管线资源', count: listing.value?.summary.pipelineFiles ?? 0 },
]);
const summary = computed(() => listing.value?.summary ?? null);
const limits = computed(() => listing.value?.limits ?? { maxUploadBytes: 0, uploadExtensions: [] });
const bundles = computed(() => listing.value?.bundles ?? []);
const readOnlyFiles = computed(() => (location.value === 'static' ? listing.value?.static : listing.value?.assets) ?? []);

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

// -- upload ----------------------------------------------------------------------------

const uploadFor = ref('');
const uploadName = ref('');

const uploadTarget = computed(() => bundles.value.find((bundle) => bundle.bundlePath === uploadFor.value) ?? null);

function openUpload(bundle) {
  pending.value = null;
  uploadFor.value = bundle.bundlePath;
  uploadName.value = '';
  error.value = null;
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
      uploadFor.value = '';
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
  <div class="assets">
    <header class="assets-head">
      <span>资源</span>
      <span v-if="summary" class="muted">
        内容 {{ summary.contentResources }} · 静态 {{ summary.staticFiles }} · 管线 {{ summary.pipelineFiles }} ·
        共 {{ humanSize(summary.totalBytes) }} · 可替换 {{ summary.replaceable }}
      </span>
      <span class="spacer"></span>
      <button type="button" class="mini" :disabled="loading || busy" @click="load">刷新</button>
    </header>

    <p v-if="error" class="error">资源操作失败：{{ error }}</p>
    <p v-if="message" class="flash">{{ message }}</p>

    <div v-if="restored" class="panel">
      <p>
        最近删除：<code>{{ restored.path }}</code>（回收站 id <code>{{ restored.id }}</code>）
        <button type="button" class="mini" :disabled="busy" @click="restoreLast">恢复</button>
      </p>
    </div>

    <div class="tabs">
      <button
        v-for="item in locations"
        :key="item.id"
        type="button"
        :class="{ active: location === item.id }"
        @click="location = item.id"
      >
        {{ item.label }}（{{ item.count }}）
      </button>
    </div>

    <p v-if="loading" class="muted">加载中…</p>

    <template v-else-if="location === 'content'">
      <p class="hint">
        资源属于所在的 bundle：替换保持路径不变，引用继续有效；删除会移入回收站，且不会自动改写 Markdown。
        可写类型：<code>{{ limits.uploadExtensions.join(' ') }}</code>，单个文件上限 {{ humanSize(limits.maxUploadBytes) }}。
      </p>

      <p v-if="bundles.length === 0" class="muted">没有发现任何 bundle。</p>

      <section v-for="bundle in bundles" :key="bundle.bundlePath" class="panel bundle">
        <header class="bundle-head">
          <b>{{ bundle.bundlePath || '（内容根目录）' }}</b>
          <span class="badge">{{ bundle.contentKind ?? bundle.kind ?? '未知' }}</span>
          <span v-if="bundle.bundleKind" class="badge">{{ bundle.bundleKind }}</span>
          <span class="muted">{{ bundle.documents.length }} 份文档 · {{ bundle.resources.length }} 个资源</span>
          <span class="spacer"></span>
          <button v-if="bundle.canUpload" type="button" class="mini" :disabled="busy" @click="openUpload(bundle)">上传到此处</button>
          <span v-else class="muted" :title="bundle.uploadBlockedReason ?? ''">{{ bundle.uploadBlockedReason ?? '不可写入' }}</span>
        </header>

        <div v-if="uploadFor === bundle.bundlePath" class="panel">
          <p>
            上传新文件到 <code>{{ bundle.bundlePath }}</code>：不会覆盖同名文件，重名时会给出可用名称。
          </p>
          <input type="file" :disabled="busy" @change="onPick($event, planUpload)" />
          <button type="button" class="mini" :disabled="busy" @click="uploadFor = ''">取消</button>
        </div>

        <p v-if="bundle.resources.length === 0" class="muted">这个 bundle 还没有资源。</p>

        <ul class="resource-list">
          <li v-for="asset in bundle.resources" :key="asset.id" class="resource">
            <img v-if="asset.previewUrl" :src="asset.previewUrl" :alt="asset.filename" class="thumb" />
            <span v-else class="thumb placeholder">{{ asset.extension || '?' }}</span>
            <span class="resource-info">
              <code>{{ asset.filename }}</code>
              <span class="muted">
                {{ humanSize(asset.size) }} · {{ asset.mimeType ?? '未知类型' }} ·
                {{ asset.referenced ? `被 ${asset.referencedBy.length} 份文档引用` : '未被引用' }}
              </span>
              <span v-if="asset.capabilities.replace" class="muted">
                替换保持路径；删除可恢复（回收站）
              </span>
              <span v-else class="muted">只读资源</span>
            </span>
            <span class="spacer"></span>
            <label v-if="asset.capabilities.replace" class="mini file-button">
              替换
              <input type="file" :disabled="busy" @change="onPick($event, (file) => planReplace(asset, file))" />
            </label>
            <button v-if="asset.capabilities.delete" type="button" class="mini" :disabled="busy" @click="planDelete(asset)">删除</button>
          </li>
        </ul>
      </section>
    </template>

    <template v-else>
      <p class="hint">
        这些文件由站点或主题直接使用（{{ location === 'static' ? 'static/ 原样发布' : 'assets/ 交给 Hugo 管线处理' }}），
        本阶段只列出与预览：替换或删除它们没有可校验的反向引用。
      </p>
      <ul class="resource-list">
        <li v-for="asset in readOnlyFiles" :key="asset.id" class="resource">
          <img v-if="asset.previewUrl" :src="asset.previewUrl" :alt="asset.path" class="thumb" />
          <span v-else class="thumb placeholder">{{ asset.extension || '?' }}</span>
          <span class="resource-info">
            <code>{{ asset.path }}</code>
            <span class="muted">{{ humanSize(asset.size) }} · {{ asset.type }}</span>
          </span>
          <span class="spacer"></span>
          <span class="badge">只读</span>
        </li>
      </ul>
    </template>

    <div v-if="pending" class="panel plan">
      <header>
        <b>
          {{ pending.kind === 'upload' ? '新建资源' : pending.kind === 'replace' ? '替换资源' : '删除资源' }}
        </b>
        <span class="badge">status: {{ pending.plan.status ?? (pending.plan.planned ? 'preview' : '—') }}</span>
        <span class="spacer"></span>
        <button type="button" class="mini" :disabled="busy" @click="pending = null">取消</button>
        <button type="button" class="btn" :disabled="busy" @click="confirmPending">
          {{ pending.kind === 'delete' ? '确认删除' : '确认写入' }}
        </button>
      </header>
      <p><code>{{ pending.plan.path ?? pending.plan.targetPath }}</code> — {{ pending.plan.confirmHint }}</p>
      <p v-if="pending.kind === 'upload'" class="muted">
        新文件：{{ pending.filename }}（{{ humanSize(pending.dataBase64.length * 3 / 4) }}）
        <span v-if="pending.plan.exists"> · 已存在，建议改名 {{ pending.plan.suggestion }}</span>
      </p>
      <p v-if="pending.kind === 'replace'" class="muted">
        替换为：{{ pending.filename }} · 原内容 sha256 <code>{{ String(pending.plan.shaBefore).slice(0, 12) }}</code>
        · 写入前会先备份
      </p>
      <p v-for="warning in pending.plan.warnings ?? []" :key="warning" class="warn-line">⚠ {{ warning }}</p>
    </div>
  </div>
</template>
