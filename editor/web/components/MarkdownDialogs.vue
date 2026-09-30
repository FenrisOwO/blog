<script setup>
// The four helpers that need an argument: link, image, table, code block.
//
// Each one only *collects* the argument and hands it to the editor, which runs the same pure
// transform the toolbar would. The image helper is the only one that talks to the server, and
// it goes through Phase 6's AssetService: a drag-and-drop or a file picker uploads a real
// resource first, and the Markdown reference is only written after the upload succeeded.

import { computed, ref, watch } from 'vue';

import ModalShell from './ModalShell.vue';
import { CODE_LANGUAGES } from '../../src/editorCore/markdown.js';

const props = defineProps({
  open: { type: String, default: '' },
  selectedText: { type: String, default: '' },
  existingLink: { type: Object, default: null },
  documentPath: { type: String, default: '' },
  bundlePath: { type: String, default: '' },
});

const emit = defineEmits(['apply', 'close']);

const url = ref('');
const title = ref('');
const alt = ref('');
const src = ref('');
const cols = ref(3);
const rows = ref(2);
const language = ref('javascript');
const code = ref('');
const busy = ref(false);
const error = ref(null);
const assets = ref(null);
const pending = ref(null);

const isLink = computed(() => props.open === 'link');
const isImage = computed(() => props.open === 'image');
const isTable = computed(() => props.open === 'table');
const isCode = computed(() => props.open === 'codeBlock');

const titles = {
  link: '插入链接',
  image: '插入图片',
  table: '插入表格',
  codeBlock: '插入代码块',
};

// The resources of the bundle this document belongs to: Hugo resolves `![](image.webp)` next to
// the page, so those are the files a Markdown reference can name.
const bundleResources = computed(() => {
  const bundle = (assets.value?.bundles ?? []).find((entry) => entry.bundlePath === props.bundlePath);
  return bundle?.resources ?? [];
});

const canUpload = computed(() => {
  const bundle = (assets.value?.bundles ?? []).find((entry) => entry.bundlePath === props.bundlePath);
  return Boolean(bundle?.canUpload ?? bundle?.capabilities?.upload ?? true);
});

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

watch(
  () => props.open,
  async (next) => {
    error.value = null;
    pending.value = null;
    if (next === 'link') {
      url.value = props.existingLink?.url ?? '';
      title.value = props.existingLink?.title ?? '';
    }
    if (next === 'image') {
      alt.value = props.selectedText.trim();
      src.value = '';
      assets.value = null;
      try {
        assets.value = await api('/api/assets');
      } catch (cause) {
        error.value = `读取资源列表失败：${cause.message ?? cause}`;
      }
    }
    if (next === 'codeBlock') {
      code.value = '';
      language.value = 'javascript';
    }
  },
);

// A resource in the same directory is referenced by file name, like Hugo expects for a leaf
// bundle; anything else keeps a path relative to the document's own directory.
function referenceFor(resource) {
  const documentDir = props.documentPath.includes('/') ? props.documentPath.slice(0, props.documentPath.lastIndexOf('/')) : '';
  const resourceDir = resource.path.includes('/') ? resource.path.slice(0, resource.path.lastIndexOf('/')) : '';
  if (documentDir !== '' && resourceDir === documentDir) return resource.filename ?? resource.path.split('/').pop();
  return resource.path;
}

function chooseResource(resource) {
  src.value = referenceFor(resource);
}

function apply() {
  if (isLink.value) {
    if (!url.value.trim()) {
      error.value = '链接需要一个 URL。';
      return;
    }
    emit('apply', { id: 'link', arg: { url: url.value.trim(), title: title.value.trim() || null } });
    return;
  }
  if (isImage.value) {
    if (!src.value.trim()) {
      error.value = '请选择一个资源，或填写图片路径。';
      return;
    }
    emit('apply', { id: 'image', arg: { src: src.value.trim(), alt: alt.value } });
    return;
  }
  if (isTable.value) {
    emit('apply', { id: 'table', arg: { cols: Number(cols.value) || 2, rows: Number(rows.value) || 0 } });
    return;
  }
  emit('apply', { id: 'codeBlock', arg: { language: language.value, code: code.value || null } });
}

async function readFile(file) {
  return await new Promise((resolvePromise, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolvePromise(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('无法读取文件'));
    reader.readAsDataURL(file);
  });
}

async function upload(file) {
  if (!file) return;
  busy.value = true;
  error.value = null;
  pending.value = null;
  try {
    if (!props.bundlePath) throw new Error('当前文档不是一个 bundle，无法上传资源。请改用 assets/ 或 static/ 里的文件。');
    const dataBase64 = await readFile(file);
    // Plan first, exactly like the assets view: nothing is written until the confirm below.
    const plan = await api('/api/assets/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bundlePath: props.bundlePath, filename: file.name }),
    });
    pending.value = { plan, dataBase64, filename: file.name };
  } catch (cause) {
    error.value = `上传失败：${cause.message ?? cause}（Markdown 未做任何改动）`;
  } finally {
    busy.value = false;
  }
}

async function confirmUpload() {
  if (!pending.value) return;
  busy.value = true;
  error.value = null;
  try {
    const result = await api('/api/assets/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bundlePath: props.bundlePath,
        filename: pending.value.filename,
        dataBase64: pending.value.dataBase64,
        confirm: true,
      }),
    });
    const resource = { path: result.path, filename: result.filename ?? pending.value.filename };
    assets.value = await api('/api/assets');
    src.value = referenceFor(resource);
    pending.value = null;
  } catch (cause) {
    error.value = `上传失败：${cause.message ?? cause}（Markdown 未做任何改动）`;
  } finally {
    busy.value = false;
  }
}

function onDrop(event) {
  const file = event.dataTransfer?.files?.[0];
  if (file) upload(file);
}

function onPick(event) {
  const file = event.target.files?.[0];
  if (file) upload(file);
}
</script>

<template>
  <ModalShell v-if="open" :title="titles[open] ?? '插入'" :busy="busy" @close="emit('close')">
    <p v-if="error" class="error-line">{{ error }}</p>

    <template v-if="isLink">
      <label class="field">
        <span>URL</span>
        <input v-model="url" type="text" placeholder="https://example.com" :disabled="busy" @keydown.enter="apply" />
      </label>
      <label v-if="selectedText.trim() === ''" class="field">
        <span>显示文字</span>
        <input :value="selectedText" type="text" disabled />
      </label>
      <label class="field">
        <span>标题（可选）</span>
        <input v-model="title" type="text" placeholder="悬停时显示" :disabled="busy" />
      </label>
      <p class="hint">
        将生成 <code>[{{ selectedText || '文字' }}]({{ url || 'https://…' }})</code>；
        <template v-if="existingLink">这里会替换已有链接的地址，而不是嵌套第二个链接。</template>
        <template v-else>只改选中的文字。</template>
      </p>
    </template>

    <template v-else-if="isImage">
      <label class="field">
        <span>替代文字（a11y）</span>
        <input v-model="alt" type="text" placeholder="描述这张图片" :disabled="busy" />
      </label>
      <label class="field">
        <span>路径 / 资源</span>
        <input v-model="src" type="text" placeholder="image.webp 或 https://…" :disabled="busy" />
      </label>

      <div class="drop" @dragover.prevent @drop.prevent="onDrop">
        <p>把图片拖到这里，或者</p>
        <label class="btn mini">
          选择文件
          <input type="file" accept="image/*" hidden :disabled="busy" @change="onPick" />
        </label>
        <p class="hint">上传走 Phase 6 的 AssetService；上传失败时 Markdown 不会被改动。</p>
      </div>

      <div v-if="pending" class="upload-plan">
        <b>上传计划</b>
        <p>
          目标：<code>{{ pending.plan.path ?? pending.plan.targetPath }}</code>
          <span class="badge">{{ pending.plan.status ?? 'create' }}</span>
        </p>
        <p class="hint">{{ pending.plan.confirmHint ?? '确认后会写入这个资源。' }}</p>
        <button type="button" class="btn primary sm" :disabled="busy" @click="confirmUpload">确认上传</button>
      </div>

      <div v-if="assets" class="resources">
        <h4>同一 bundle 里的资源（{{ bundleResources.length }}）</h4>
        <p v-if="canUpload === false" class="hint warn">这个 bundle 不在可写范围内，只能选择已有资源。</p>
        <div class="resource-grid">
          <button
            v-for="resource in bundleResources"
            :key="resource.path"
            type="button"
            class="resource"
            :class="{ active: src === referenceFor(resource) }"
            :disabled="busy"
            @click="chooseResource(resource)"
          >
            <img v-if="resource.previewUrl" :src="resource.previewUrl" :alt="resource.filename" />
            <span v-else class="placeholder">—</span>
            <code>{{ resource.filename ?? resource.path }}</code>
          </button>
        </div>
      </div>
    </template>

    <template v-else-if="isTable">
      <div class="grid-2">
        <label class="field">
          <span>列数</span>
          <input v-model="cols" type="number" min="1" max="12" :disabled="busy" />
        </label>
        <label class="field">
          <span>数据行数</span>
          <input v-model="rows" type="number" min="0" max="50" :disabled="busy" />
        </label>
      </div>
      <p class="hint">生成标准 GFM 表格；插入后仍然是 Markdown，可以逐字编辑。</p>
    </template>

    <template v-else-if="isCode">
      <div class="grid-2">
        <label class="field">
          <span>语言</span>
          <select v-model="language" :disabled="busy">
            <option v-for="option in CODE_LANGUAGES" :key="option" :value="option">{{ option }}</option>
          </select>
        </label>
      </div>
      <label class="field">
        <span>代码（留空则插入空代码块，光标停在中间）</span>
        <textarea v-model="code" rows="6" :disabled="busy" placeholder="let x = 1;"></textarea>
      </label>
    </template>

    <template #footer>
      <span class="spacer"></span>
      <button type="button" class="btn" :disabled="busy" @click="emit('close')">取消</button>
      <button v-if="!isImage" type="button" class="btn primary" :disabled="busy" @click="apply">插入</button>
      <button v-else type="button" class="btn primary" :disabled="busy || !src" @click="apply">插入引用</button>
    </template>
  </ModalShell>
</template>

<style scoped>
.grid-2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: var(--space-lg);
}

.drop {
  display: grid;
  justify-items: center;
  gap: var(--space-sm);
  padding: var(--space-xl);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--surface-2);
  text-align: center;
  font-size: var(--text-sm);
}

.upload-plan {
  display: grid;
  gap: var(--space-sm);
  padding: var(--space-md);
  border: 1px solid var(--accent-border);
  border-radius: var(--radius-md);
  background: var(--accent-soft);
  font-size: var(--text-sm);
}

.resources h4 {
  margin: 0 0 var(--space-sm);
}

.resource-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: var(--space-md);
}

.resource {
  display: grid;
  gap: var(--space-xs);
  justify-items: center;
  padding: var(--space-sm);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  cursor: pointer;
  overflow: hidden;
}

.resource:hover {
  border-color: var(--accent);
}

.resource.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.resource img {
  width: 100%;
  height: 56px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  background: var(--surface-3);
}

.resource .placeholder {
  color: var(--faint);
}

.resource code {
  font-size: 10px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hint.warn {
  color: var(--warning);
}
</style>
