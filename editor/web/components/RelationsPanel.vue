<script setup>
// Phase 7: the 关系 (Relations) screen - tags across the site, and the links inside one page.
//
// The screen exists for the two things a per-document form cannot express:
//
//   标签  a tag is one object used by many documents. Renaming or merging it is a change to
//         every file that uses it, so the panel shows the impact first (which documents, the
//         diff for each, the metadata page that would move) and only then writes. A rename onto
//         a tag the site already uses is refused by the server with 409, and the panel turns
//         that refusal into the merge the user probably meant.
//   链接  `links:` is a list of maps, which the field form refuses by design. Here it is what
//         it is: items with a key order, each field editable, the list reorderable, and every
//         change shown as a line diff before it is written.
//
// Nothing here writes on its own: planning is a dry run, and the confirm button is the same
// `confirm: true` gate every other write in this editor goes through.

import { computed, onMounted, ref, watch } from 'vue';

const props = defineProps({
  documents: { type: Array, default: () => [] },
});
const emit = defineEmits(['changed']);

const tab = ref('tags'); // 'tags' | 'links'

const busy = ref(false);
const error = ref(null);
const message = ref(null);
// The plan the user is being asked to confirm: { route, title, request, plan }
const pending = ref(null);
const result = ref(null);

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const problem = new Error(body.error ?? `${response.status} ${response.statusText}`);
    problem.status = response.status;
    problem.body = body;
    throw problem;
  }
  return body;
}

function post(path, payload) {
  return api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
}

function note(text) {
  message.value = text;
  setTimeout(() => {
    if (message.value === text) message.value = null;
  }, 8000);
}

function failure(cause) {
  error.value = String(cause?.message ?? cause);
}

// --- tags --------------------------------------------------------------------------------

const tagIndex = ref(null);
const loadingTags = ref(true);
const filter = ref('');
const selected = ref(null);
const detail = ref(null);
const loadingDetail = ref(false);
const renameTarget = ref('');
const pageName = ref('');
const editingPath = ref(null);
const editingTags = ref([]);
const newTag = ref('');

const tags = computed(() => tagIndex.value?.tags ?? []);
const visibleTags = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  if (!needle) return tags.value;
  return tags.value.filter((tag) => `${tag.name} ${(tag.names ?? []).map((entry) => entry.name).join(' ')}`.toLowerCase().includes(needle));
});
const conflictTags = computed(() => tags.value.filter((tag) => (tag.conflicts ?? []).length > 0));
const pagePlaceholder = computed(() => `为这个标签名创建 content/${tagIndex.value?.tagTaxonomy ?? 'tags'}/<名称>/_index.md`);

function submitNewTag(path) {
  const value = newTag.value.trim();
  if (value === '' || !path) return;
  newTag.value = '';
  return planTagEdit(path, { add: [value] });
}

async function loadTags() {
  loadingTags.value = true;
  error.value = null;
  try {
    tagIndex.value = await api('/api/tags');
  } catch (cause) {
    failure(cause);
  } finally {
    loadingTags.value = false;
  }
}

onMounted(loadTags);

async function openTag(tag) {
  selected.value = tag;
  renameTarget.value = tag.name;
  editingPath.value = null;
  loadingDetail.value = true;
  error.value = null;
  try {
    detail.value = await api(`/api/tags/detail?name=${encodeURIComponent(tag.name)}`);
  } catch (cause) {
    failure(cause);
  } finally {
    loadingDetail.value = false;
  }
}

async function refreshDetail() {
  if (!selected.value) return;
  detail.value = await api(`/api/tags/detail?name=${encodeURIComponent(selected.value.name)}`);
}

// Plan a rename, or the merge the user asked for after a 409. Planning is a dry run: it reads
// the affected files and returns the change set, and writes nothing.
async function planTagRename(mode) {
  if (!selected.value) return;
  const from = selected.value.name;
  const to = renameTarget.value.trim();
  if (to === '') return;
  busy.value = true;
  error.value = null;
  try {
    const plan = await post('/api/tags/plan', { action: mode, from, to });
    pending.value = {
      route: '/api/tags/apply',
      request: { action: mode, from, to },
      title: mode === 'merge' ? `合并标签 ${from} → ${to}` : `重命名标签 ${from} → ${to}`,
      plan,
    };
  } catch (cause) {
    if (cause.status === 409 && cause.body?.conflict) {
      // The server refuses to merge silently. Offer the merge, with the numbers.
      pending.value = {
        conflict: cause.body.conflict,
        message: cause.body.error,
        merge: { route: '/api/tags/apply', request: { action: 'merge', from, to }, title: `合并标签 ${from} → ${to}` },
      };
    } else {
      failure(cause);
    }
  } finally {
    busy.value = false;
  }
}

async function planMergeFromConflict() {
  const merge = pending.value?.merge;
  pending.value = null;
  if (!merge) return;
  busy.value = true;
  try {
    const plan = await post('/api/tags/plan', merge.request);
    pending.value = { ...merge, plan };
  } catch (cause) {
    failure(cause);
  } finally {
    busy.value = false;
  }
}

async function openDocumentTags(path) {
  if (editingPath.value === path) {
    editingPath.value = null;
    return;
  }
  editingPath.value = path;
  editingTags.value = [];
  error.value = null;
  try {
    const fields = await api(`/api/documents/fields?path=${encodeURIComponent(path)}`);
    const list = fields.fields.find((field) => field.key === 'tags');
    editingTags.value = Array.isArray(list?.value) ? list.value.map(String) : [];
  } catch (cause) {
    failure(cause);
  }
}

async function planTagEdit(path, { add = [], remove = [], replace = [] }) {
  busy.value = true;
  error.value = null;
  try {
    const plan = await post('/api/tags/plan', { action: 'edit', path, add, remove, replace });
    const parts = [];
    if (add.length) parts.push(`新增 ${add.join('、')}`);
    if (remove.length) parts.push(`移除 ${remove.join('、')}`);
    if (replace.length) parts.push(`改名 ${replace.map((entry) => `${entry.from}→${entry.to}`).join('、')}`);
    pending.value = { route: '/api/tags/apply', request: { action: 'edit', path, add, remove, replace }, title: `编辑 ${path} 的标签：${parts.join('，')}`, plan };
  } catch (cause) {
    failure(cause);
  } finally {
    busy.value = false;
  }
}

async function planTagPage() {
  const name = pageName.value.trim();
  if (name === '') return;
  busy.value = true;
  error.value = null;
  try {
    const plan = await post('/api/tags/plan', { action: 'page', name });
    pending.value = { route: '/api/tags/apply', request: { action: 'page', name }, title: `创建标签元数据页 ${plan.changes[0]?.relPath ?? name}`, plan };
  } catch (cause) {
    failure(cause);
  } finally {
    busy.value = false;
  }
}

// --- links -------------------------------------------------------------------------------

const linksPath = ref('page/links/index.md');
const linksView = ref(null);
const loadingLinks = ref(false);
const newLink = ref({ title: '', website: '', description: '', image: '' });
const rows = ref([]);

// The document list is the whole content tree; the picker stays collapsed because most
// documents have no links list, and the path box is the precise way to get to one.
const documentsWithLinksHint = computed(() => props.documents.map((doc) => doc.path).sort((a, b) => a.localeCompare(b)).map((path) => ({ path })));

async function loadLinks(path = linksPath.value) {
  linksPath.value = path;
  if (!path) return;
  loadingLinks.value = true;
  error.value = null;
  linksView.value = null;
  rows.value = [];
  try {
    const view = await api(`/api/links?path=${encodeURIComponent(path)}`);
    linksView.value = view;
    rows.value = view.items.map((item) => ({
      originalIndex: item.index,
      original: { title: item.title ?? '', description: item.description ?? '', website: item.website ?? '', image: item.image ?? '' },
      fields: { title: item.title ?? '', description: item.description ?? '', website: item.website ?? '', image: item.image ?? '' },
      imageRef: item.imageRef,
      removed: false,
    }));
  } catch (cause) {
    failure(cause);
  } finally {
    loadingLinks.value = false;
  }
}

const keys = ['title', 'description', 'website', 'image'];

// The UI state -> the plan the API takes. Rows carry their original index, so the request is
// expressed in the list as it was read, whatever the user did to the order in the meantime.
function linkRequest() {
  const edit = [];
  const remove = [];
  for (const row of rows.value) {
    if (row.originalIndex === null) continue;
    if (row.removed) {
      remove.push(row.originalIndex);
      continue;
    }
    const set = {};
    for (const key of keys) if (row.fields[key] !== row.original[key]) set[key] = row.fields[key];
    if (Object.keys(set).length > 0) edit.push({ index: row.originalIndex, set });
  }

  const survivors = rows.value.filter((row) => row.originalIndex !== null && !row.removed).map((row) => row.originalIndex);
  const sorted = [...survivors].sort((a, b) => a - b);
  const move = [];
  // The service applies moves in the list that is left after the removals, so the target order
  // is compared in that same space; adjacent swaps keep every step applyable in order.
  const working = [...sorted];
  for (let position = 0; position < survivors.length; position += 1) {
    const wanted = survivors[position];
    const at = working.indexOf(wanted);
    for (let step = at; step > position; step -= 1) {
      move.push({ from: working[step], to: working[step - 1] });
      [working[step - 1], working[step]] = [working[step], working[step - 1]];
    }
  }

  // Adds are applied last, so their insertion index is their position in the final list - which
  // is what makes moving a not-yet-written row up mean something.
  const add = [];
  let finalIndex = 0;
  for (const row of rows.value) {
    if (row.removed) continue;
    if (row.originalIndex === null) {
      add.push({ index: finalIndex, ...Object.fromEntries(keys.filter((key) => row.fields[key] !== '').map((key) => [key, row.fields[key]])) });
    }
    finalIndex += 1;
  }

  return { path: linksPath.value, edit, add, remove, move };
}

async function planLinkChange() {
  busy.value = true;
  error.value = null;
  try {
    const request = linkRequest();
    const plan = await post('/api/links/plan', request);
    pending.value = { route: '/api/links/apply', request, title: `编辑 ${request.path} 的链接`, plan };
  } catch (cause) {
    failure(cause);
  } finally {
    busy.value = false;
  }
}

function moveRow(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= rows.value.length) return;
  const next = [...rows.value];
  [next[index], next[target]] = [next[target], next[index]];
  rows.value = next;
}

function removeRow(index) {
  const row = rows.value[index];
  if (!row) return;
  if (row.originalIndex === null) {
    rows.value = rows.value.filter((_, at) => at !== index);
    return;
  }
  row.removed = !row.removed;
}

function addRow() {
  const row = { originalIndex: null, original: {}, fields: { ...newLink.value }, imageRef: null, removed: false };
  if (row.fields.title === '' || row.fields.website === '') {
    error.value = '新增链接需要 title 与 website';
    return;
  }
  rows.value = [...rows.value, row];
  newLink.value = { title: '', website: '', description: '', image: '' };
}

function resetRows() {
  loadLinks(linksPath.value);
}

// --- confirm -----------------------------------------------------------------------------

async function confirmPending() {
  if (!pending.value?.plan) return;
  busy.value = true;
  error.value = null;
  try {
    const answer = await post(pending.value.route, { ...pending.value.request, confirm: true });
    result.value = answer;
    note(
      answer.counts?.total
        ? `已执行：${answer.counts.total} 个文件变更（修改 ${answer.counts.modify}、新增 ${answer.counts.create}、删除 ${answer.counts.delete}、移动 ${answer.counts.move}）${answer.buildScheduled ? '，已安排构建' : ''}`
        : '没有文件需要写入（已经是目标状态）',
    );
    pending.value = null;
    emit('changed', answer);
    if (tab.value === 'tags') {
      await loadTags();
      await refreshDetail();
      editingPath.value = null;
    } else {
      await loadLinks();
    }
  } catch (cause) {
    failure(cause);
  } finally {
    busy.value = false;
  }
}

function cancelPending() {
  pending.value = null;
}

watch(tab, (next) => {
  error.value = null;
  if (next === 'links' && linksView.value === null && !loadingLinks.value) loadLinks();
});

function tagOfConflict(tag) {
  return (tag.conflicts ?? []).length > 0;
}
</script>

<template>
  <div class="relations">
    <header class="relations-head">
      <span>关系</span>
      <span class="muted">
        标签是站点级别的对象：改一个标签会改掉所有用到它的文档，所以先看改动清单再确认写入。
      </span>
      <span class="spacer"></span>
      <span class="views">
        <button type="button" :class="{ active: tab === 'tags' }" @click="tab = 'tags'">标签</button>
        <button type="button" :class="{ active: tab === 'links' }" @click="tab = 'links'">链接</button>
      </span>
      <button v-if="tab === 'tags'" type="button" class="mini" :disabled="busy || loadingTags" @click="loadTags">刷新</button>
      <button v-else type="button" class="mini" :disabled="busy || loadingLinks" @click="loadLinks()">重新读取</button>
    </header>

    <p v-if="error" class="error">关系操作失败：{{ error }}</p>
    <p v-if="message" class="flash">{{ message }}</p>

    <!-- the plan the user is confirming: one file at a time, every diff shown -->
    <div v-if="pending?.conflict" class="panel plan">
      <header class="panel-head">
        <b>需要先决定</b>
        <span class="badge">409</span>
        <span class="spacer"></span>
        <button type="button" class="mini" @click="cancelPending">取消</button>
        <button type="button" class="btn primary" :disabled="busy" @click="planMergeFromConflict">改为合并</button>
      </header>
      <p>{{ pending.message }}</p>
      <p class="muted">
        目标标签已被 <b>{{ pending.conflict.destinationInUse ? pending.conflict.affected.length : 0 }}</b> 份文档使用过；
        合并会把两处写法统一为目标标签，同一文档里重复的标签行会被去掉。
      </p>
    </div>

    <div v-else-if="pending?.plan" class="panel plan">
      <header class="panel-head">
        <b>{{ pending.title }}</b>
        <span class="badge">{{ pending.plan.noop ? '无改动' : `${pending.plan.counts.total} 个文件` }}</span>
        <span class="spacer"></span>
        <button type="button" class="mini" :disabled="busy" @click="cancelPending">取消</button>
        <button type="button" class="btn primary" :disabled="busy" @click="confirmPending">确认执行</button>
      </header>
      <p>{{ pending.plan.text }}</p>
      <p v-if="!pending.plan.review?.ok" class="error">计划被拒绝：{{ (pending.plan.review.conflicts ?? []).join('；') }}</p>
      <p v-for="warning in pending.plan.warnings ?? []" :key="warning" class="warn-line">⚠ {{ warning }}</p>
      <p v-if="(pending.plan.skipped ?? []).length" class="muted">
        已跳过：{{ pending.plan.skipped.map((entry) => `${entry.value ?? entry.title ?? entry.index ?? entry.action}（${entry.reason}）`).join('；') }}
      </p>
      <details v-for="change in pending.plan.changes" :key="`${change.kind}:${change.relPath}:${change.toPath ?? ''}`" class="diff-block">
        <summary>
          <span class="badge">{{ change.kind }}</span>
          <code>{{ change.relPath }}</code>
          <span v-if="change.toPath"> → <code>{{ change.toPath }}</code></span>
          <span v-if="change.note" class="muted"> · {{ change.note }}</span>
          <span v-if="change.diff" class="muted"> · +{{ change.diff.added }} / -{{ change.diff.removed }}</span>
        </summary>
        <pre class="diff">{{ change.diffText }}</pre>
      </details>
      <p v-if="(pending.plan.unchanged ?? []).length" class="muted">
        已经是目标状态、不会写入：{{ pending.plan.unchanged.map((entry) => entry.relPath).join('、') }}
      </p>
    </div>

    <!-- tags -->
    <div v-if="tab === 'tags'" class="body">
      <aside class="sidebar">
        <div class="sidebar-head">
          <span>标签（{{ tags.length }}）</span>
          <span class="spacer"></span>
          <input v-model="filter" class="search" type="search" placeholder="筛选标签" />
        </div>
        <p v-if="loadingTags" class="muted">加载中…</p>
        <p v-else-if="visibleTags.length === 0" class="muted">没有匹配的标签。</p>
        <ul class="tag-list">
          <li
            v-for="tag in visibleTags"
            :key="tag.identity"
            :class="{ active: selected?.identity === tag.identity, orphan: tag.orphan }"
            @click="openTag(tag)"
          >
            <b>{{ tag.name }}</b>
            <span class="badge">{{ tag.usage }}</span>
            <span v-if="tagOfConflict(tag)" class="badge warn" title="多种写法会被 Hugo 合并为同一个 term">同义 {{ tag.names.length }}</span>
            <span v-if="tag.metadataPages.length" class="badge" title="有元数据页">页</span>
            <span v-if="tag.orphan" class="badge" title="没有文档使用这个标签">孤立页</span>
            <span class="muted">{{ tag.languages.join(' ') }}</span>
          </li>
        </ul>
        <p class="hint">
          本站在 <code>content/{{ tagIndex?.tagTaxonomy ?? 'tags' }}</code> 下没有目录时，任何标签都不会被视为“缺少元数据页”；
          元数据页只在明确创建时才会出现。
        </p>
      </aside>

      <main class="main">
        <div v-if="!selected" class="panel">
          <p class="muted">从左侧选择一个标签，查看它被哪些文档使用，并对整站重命名或合并。</p>
          <p v-if="conflictTags.length" class="warn-line">
            ⚠ 有 {{ conflictTags.length }} 个标签存在大小写/空白不同的写法：{{ conflictTags.map((tag) => tag.names.map((entry) => entry.name).join(' / ')).join('；') }}
          </p>
        </div>

        <template v-else>
          <div class="panel">
            <header class="panel-head">
              <b>{{ selected.name }}</b>
              <span class="badge">term <code>{{ selected.identity }}</code></span>
              <span class="muted">{{ selected.usage }} 份文档 · 语言 {{ selected.languages.join(' ') || '—' }}</span>
              <span class="spacer"></span>
              <span v-if="selected.metadataPages.length" class="badge">元数据页 {{ selected.metadataPages.map((page) => page.relPath).join('、') }}</span>
              <span v-else class="muted">没有元数据页</span>
            </header>
            <p v-if="(selected.names ?? []).length > 1" class="warn-line">
              ⚠ 同一 term 有两种写法：{{ selected.names.map((entry) => `${entry.name}（${entry.count}）`).join('、') }} — Hugo 视为同一个标签。
            </p>
            <div class="row">
              <label>新名称</label>
              <input v-model="renameTarget" type="text" placeholder="例如 Hugo Editor 或 hugo-editor" />
              <button type="button" class="mini" :disabled="busy" @click="planTagRename('rename')">预览重命名</button>
              <button type="button" class="mini" :disabled="busy" @click="planTagRename('merge')">预览合并</button>
            </div>
            <div class="row">
              <label>元数据页</label>
              <input v-model="pageName" type="text" :placeholder="pagePlaceholder" />
              <button type="button" class="mini" :disabled="busy" @click="planTagPage">预览创建</button>
              <span class="muted">只在明确需要时创建：本站的标签默认没有元数据页。</span>
            </div>
          </div>

          <p v-if="loadingDetail" class="muted">加载文档…</p>

          <section v-for="group in detail?.groups ?? []" :key="group.translationKey" class="panel group">
            <header class="panel-head">
              <b>{{ group.translationKey }}</b>
              <span class="muted">{{ group.members.length }} 个语言版本</span>
            </header>
            <ul class="doc-list">
              <li v-for="member in group.members" :key="member.path">
                <span class="doc-title">{{ member.title ?? '（无标题）' }}</span>
                <code class="muted">{{ member.path }}</code>
                <span class="badge">{{ member.language }}</span>
                <span class="muted">写作 {{ member.tag }}</span>
                <span class="spacer"></span>
                <button type="button" class="mini" :disabled="busy" @click="openDocumentTags(member.path)">
                  {{ editingPath === member.path ? '收起标签' : '编辑标签' }}
                </button>
              </li>
            </ul>
            <div v-if="group.members.some((member) => member.path === editingPath)" class="panel inline">
              <p>
                当前标签：
                <span v-for="tag in editingTags" :key="tag" class="chip">
                  {{ tag }}
                  <button type="button" class="x" :disabled="busy" title="移除" @click="planTagEdit(editingPath, { remove: [tag] })">×</button>
                </span>
                <span v-if="editingTags.length === 0" class="muted">（没有标签）</span>
              </p>
              <div class="row">
                <input v-model="newTag" type="text" placeholder="新增标签，回车预览" @keyup.enter="submitNewTag(editingPath)" />
                <button type="button" class="mini" :disabled="busy || newTag.trim() === ''" @click="submitNewTag(editingPath)">预览新增</button>
                <span class="muted">新增不会覆盖已有标签；重复的写法会被拒绝并说明原因。</span>
              </div>
            </div>
          </section>

          <section v-if="(detail?.documents ?? []).length === 0" class="panel">
            <p class="muted">
              没有文档使用这个标签。
              <template v-if="selected.metadataPages.length">
                它的元数据页仍然存在：{{ selected.metadataPages.map((page) => page.relPath).join('、') }} — 可能是一个孤立页。
              </template>
            </p>
          </section>
        </template>
      </main>
    </div>

    <!-- links -->
    <div v-else class="body">
      <aside class="sidebar">
        <div class="sidebar-head">
          <span>文档</span>
          <span class="spacer"></span>
          <button type="button" class="mini" :disabled="busy" @click="loadLinks('page/links/index.md')">链接页</button>
        </div>
        <div class="row">
          <input v-model="linksPath" type="text" placeholder="content 下的路径，例如 page/links/index.md" @keyup.enter="loadLinks()" />
          <button type="button" class="mini" :disabled="busy" @click="loadLinks()">读取</button>
        </div>
        <details class="doc-pick-box">
          <summary>从文档列表里选（{{ documentsWithLinksHint.length }}）</summary>
          <ul class="doc-pick">
            <li v-for="doc in documentsWithLinksHint" :key="doc.path" :class="{ active: doc.path === linksPath }" @click="loadLinks(doc.path)">
              <code>{{ doc.path }}</code>
            </li>
          </ul>
        </details>
      </aside>

      <main class="main">
        <p v-if="loadingLinks" class="muted">读取中…</p>
        <template v-else-if="linksView">
          <div class="panel">
            <header class="panel-head">
              <b>{{ linksView.path }}</b>
              <span v-if="linksView.present" class="badge">{{ linksView.style }}</span>
              <span v-else class="badge warn">没有 links 字段</span>
              <span class="muted">bundle {{ linksView.bundlePath ?? '（无）' }} · 键顺序 {{ linksView.keyOrder.join(' → ') }}</span>
              <span class="spacer"></span>
              <button type="button" class="mini" :disabled="busy" @click="resetRows">还原编辑</button>
              <button type="button" class="btn primary" :disabled="busy" @click="planLinkChange">预览变更</button>
            </header>
            <p class="hint">
              必填 <code>{{ linksView.requiredKeys.join(' ') }}</code>；每一项的字段可单独修改，列表可上下移动。
              图片引用会区分外部链接与本 bundle 的页面资源：像 <code>ts-logo-128.jpg</code> 这样的引用一旦删掉源文件，链接就断了。
            </p>
            <p v-for="bad in linksView.malformed" :key="bad.index" class="warn-line">⚠ 第 {{ bad.index }} 项不是键值映射，已保留原样：{{ bad.text }}</p>
          </div>

          <section v-for="(row, index) in rows" :key="row.originalIndex ?? `new-${index}`" class="panel item" :class="{ removed: row.removed }">
            <header class="panel-head">
              <b>{{ row.originalIndex === null ? '新增' : `第 ${row.originalIndex} 项` }}</b>
              <span v-if="row.imageRef" class="badge">{{ row.imageRef.kind }}</span>
              <span v-if="row.imageRef?.resourcePath" class="muted">{{ row.imageRef.resourcePath }}</span>
              <span class="spacer"></span>
              <button type="button" class="mini" :disabled="busy" @click="moveRow(index, -1)">上移</button>
              <button type="button" class="mini" :disabled="busy" @click="moveRow(index, 1)">下移</button>
              <button type="button" class="mini" :class="{ danger: !row.removed }" :disabled="busy" @click="removeRow(index)">
                {{ row.removed ? '撤销删除' : '删除' }}
              </button>
            </header>
            <div class="grid">
              <label>title</label>
              <input v-model="row.fields.title" type="text" />
              <label>website</label>
              <input v-model="row.fields.website" type="text" />
              <label>description</label>
              <input v-model="row.fields.description" type="text" />
              <label>image</label>
              <input v-model="row.fields.image" type="text" />
            </div>
          </section>

          <section class="panel">
            <header class="panel-head"><b>新增一项</b></header>
            <div class="grid">
              <label>title *</label>
              <input v-model="newLink.title" type="text" />
              <label>website *</label>
              <input v-model="newLink.website" type="text" />
              <label>description</label>
              <input v-model="newLink.description" type="text" />
              <label>image</label>
              <input v-model="newLink.image" type="text" placeholder="https://... 或同目录文件名" />
            </div>
            <div class="row">
              <button type="button" class="mini" :disabled="busy" @click="addRow">加入列表</button>
              <span class="muted">确认后才会写入；写入位置与格式沿用这个文档自己的缩进与键顺序。</span>
            </div>
          </section>
        </template>
      </main>
    </div>
  </div>
</template>

<style scoped>
.relations {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.relations-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.relations .body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  gap: 0.75rem;
}
.sidebar {
  flex: 0 0 22rem;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.main {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.spacer {
  flex: 1 1 auto;
}
.muted {
  color: var(--faint);
  font-size: 0.85rem;
}
.views button {
  margin-left: 0.25rem;
}
.views button.active {
  font-weight: 600;
  text-decoration: underline;
}
.tag-list,
.doc-list,
.doc-pick,
.doc-pick-box {
  list-style: none;
  margin: 0;
  padding: 0;
}
.doc-pick-box summary {
  cursor: pointer;
  color: var(--faint);
  font-size: 0.85rem;
  padding: 0.25rem 0.4rem;
}
.doc-pick {
  max-height: 24rem;
  overflow: auto;
}
.tag-list li,
.doc-pick li {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.4rem;
  cursor: pointer;
  border-radius: 4px;
}
.tag-list li:hover,
.doc-pick li:hover {
  background: var(--surface-hover);
}
.tag-list li.active,
.doc-pick li.active {
  background: var(--editor-selection);
}
.tag-list li.orphan {
  opacity: 0.75;
}
.badge.warn {
  background: var(--warning-soft);
}
.doc-list li {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.2rem 0;
}
.doc-title {
  font-weight: 500;
}
.row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.row label {
  min-width: 4.5rem;
  color: var(--faint);
  font-size: 0.85rem;
}
.row input[type='text'],
.row input[type='search'],
.search {
  flex: 1 1 14rem;
  min-width: 8rem;
}
.search {
  flex: 0 1 9rem;
}
.grid {
  display: grid;
  grid-template-columns: 6rem 1fr;
  gap: 0.35rem 0.6rem;
  align-items: center;
}
.grid label {
  color: var(--faint);
  font-size: 0.85rem;
}
.panel.item.removed {
  opacity: 0.55;
  text-decoration: line-through;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.1rem 0.4rem;
  margin-right: 0.25rem;
  border-radius: 999px;
  background: var(--surface-hover);
}
.chip .x {
  border: none;
  background: transparent;
  cursor: pointer;
  color: inherit;
  font-size: 0.9rem;
  line-height: 1;
}
.diff-block {
  margin-top: 0.35rem;
}
.diff-block summary {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.diff {
  max-height: 18rem;
  overflow: auto;
  white-space: pre-wrap;
  margin: 0.3rem 0 0;
  padding: 0.5rem;
  background: rgba(8, 12, 18, 0.45);
  border-radius: 4px;
  font-size: 0.8rem;
}
.panel.inline {
  margin-top: 0.4rem;
}
</style>
