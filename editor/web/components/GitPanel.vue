<script setup>
// Git, as a review panel.
//
// The editor writes files; this panel shows what that did to the repository, and offers exactly
// one write: committing the paths the user ticks. There is no reset, no clean, no checkout, no
// force and no amend - the server's git service does not implement them - so nothing here can
// lose an article. An uninitialised repository is shown as a state, not as an error, and the
// editor never runs `git init`.

import { computed, nextTick, onMounted, ref, watch } from 'vue';

import {
  KIND_LETTER,
  changeCountsLabel,
  commitBlockedReason as blockedReason,
  diffScopeLabel,
  emptyScopeHint,
  preferredScope,
  repositoryNotice,
  scopeSwitchAvailable,
  visibleChanges as filterChanges,
} from '../gitView.js';

const props = defineProps({
  reloadKey: { type: Number, default: 0 },
  // A request from outside (the command palette): which tab to land on, and whether the cursor
  // belongs in the commit message. Assigned as a fresh object each time, so repeats still fire.
  tabRequest: { type: Object, default: null },
  notify: { type: Function, default: null },
});

const emit = defineEmits(['changed']);

const status = ref(null);
const log = ref(null);
const loading = ref(true);
const error = ref(null);
const diff = ref(null);
const diffError = ref(null);
const diffLoading = ref(false);
const selected = ref(null);
const commit = ref(null);
const message = ref('');
const checked = ref(new Set());
const busy = ref(false);
const tab = ref('changes');
const filter = ref('');
// Which half of a change the side pane is showing: the worktree against the index, or the index
// against HEAD. Both are `git diff`; only the flag differs.
const diffScope = ref('unstaged');
// The history tab shows the whole commit as one patch, and narrows to one file on request.
const commitText = ref('');
const commitNarrowed = ref(null);
const messageBox = ref(null);

const changes = computed(() => status.value?.changes ?? []);

// A site that has never been committed shows every file as untracked - hundreds of rows - so the
// list is filterable by path. Unfiltered, it stays complete: nothing is hidden silently.
const visibleChanges = computed(() => filterChanges(changes.value, filter.value));
const notARepository = computed(() => status.value !== null && status.value.repository === null);
const selectedPaths = computed(() => changes.value.filter((change) => checked.value.has(change.path)).map((change) => change.path));
const canCommit = computed(() => message.value.trim() !== '' && selectedPaths.value.length > 0 && busy.value === false);

// Why the commit button is greyed out, in words.
const commitBlockedReason = computed(() =>
  blockedReason({
    busy: busy.value,
    changeCount: changes.value.length,
    selectedCount: selectedPaths.value.length,
    message: message.value,
  }),
);

const selectedChange = computed(() => changes.value.find((change) => change.path === selected.value) ?? null);

const repositoryHint = computed(() => repositoryNotice(status.value));

const countsLabel = computed(() => changeCountsLabel(status.value?.counts));

const scopeLabel = computed(() => diffScopeLabel(diffScope.value));

const showScopeSwitch = computed(() => scopeSwitchAvailable(diff.value));

const scopeEmptyHint = computed(() => emptyScopeHint(selectedChange.value, diffScope.value));

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const suffix = body.stderr ? `：${String(body.stderr).split('\n').slice(-3).join(' ')}` : '';
    throw new Error(`${body.error ?? `HTTP ${response.status}`}${suffix}`);
  }
  return body;
}

async function loadStatus() {
  loading.value = true;
  error.value = null;
  try {
    status.value = await api('/api/git/status');
    if (status.value.repository !== null) {
      log.value = await api('/api/git/log?limit=30');
      const present = new Set(changes.value.map((change) => change.path));
      checked.value = new Set([...checked.value].filter((path) => present.has(path)));
      if (selected.value && !present.has(selected.value)) selected.value = null;
    }
  } catch (cause) {
    error.value = cause.message ?? String(cause);
  } finally {
    loading.value = false;
  }
}

async function openDiff(path, scope = null) {
  const change = changes.value.find((entry) => entry.path === path) ?? null;
  selected.value = path;
  commit.value = null;
  commitText.value = '';
  commitNarrowed.value = null;
  diffScope.value = scope ?? preferredScope(change);
  diffLoading.value = true;
  diffError.value = null;
  try {
    diff.value = await api(`/api/git/diff?path=${encodeURIComponent(path)}&staged=${diffScope.value === 'staged'}`);
  } catch (cause) {
    diff.value = null;
    diffError.value = cause.message ?? String(cause);
  } finally {
    diffLoading.value = false;
  }
}

function setScope(scope) {
  if (scope === diffScope.value || !selected.value) return;
  return openDiff(selected.value, scope);
}

async function openCommit(sha) {
  commit.value = null;
  selected.value = null;
  commitText.value = '';
  commitNarrowed.value = null;
  diffLoading.value = true;
  diffError.value = null;
  try {
    const shown = await api(`/api/git/show?sha=${encodeURIComponent(sha)}`);
    commit.value = shown;
    // One patch for the whole commit, straight from `git show`: a history row must not need a
    // second click to become readable.
    commitText.value = shown.text;
  } catch (cause) {
    diffError.value = cause.message ?? String(cause);
  } finally {
    diffLoading.value = false;
  }
}

async function openCommitFile(path) {
  if (!commit.value || !path) return;
  selected.value = path;
  commitNarrowed.value = path;
  diffLoading.value = true;
  try {
    const shown = await api(
      `/api/git/show?sha=${encodeURIComponent(commit.value.commit.sha)}&path=${encodeURIComponent(path)}`,
    );
    commitText.value = shown.text;
  } catch (cause) {
    diffError.value = cause.message ?? String(cause);
  } finally {
    diffLoading.value = false;
  }
}

function showWholeCommit() {
  if (!commit.value) return;
  selected.value = null;
  commitNarrowed.value = null;
  commitText.value = commit.value.text;
}

function toggle(path) {
  const next = new Set(checked.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  checked.value = next;
}

function toggleAll() {
  checked.value = checked.value.size === changes.value.length ? new Set() : new Set(changes.value.map((change) => change.path));
}

async function submitCommit() {
  if (!canCommit.value) return;
  busy.value = true;
  error.value = null;
  try {
    const result = await api('/api/git/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: message.value, paths: selectedPaths.value, confirm: true }),
    });
    props.notify?.('success', '已提交', { text: `${result.sha.slice(0, 8)} · ${result.files.length} 个文件` });
    message.value = '';
    checked.value = new Set();
    diff.value = null;
    commit.value = null;
    commitText.value = '';
    commitNarrowed.value = null;
    // Status and history both come from the repository, so both are re-read: the new commit has
    // to appear in the list the user is looking at.
    await loadStatus();
    emit('changed');
  } catch (cause) {
    const text = cause.message ?? String(cause);
    error.value = text;
    props.notify?.('error', '提交失败', { text: '工作区没有被改动，可以修正后重试。' });
  } finally {
    busy.value = false;
  }
}

function diffLines(text) {
  return String(text ?? '')
    .split('\n')
    .slice(0, 2000)
    .map((line) => {
      if (line.startsWith('@@')) return { cls: 'hunk', text: line };
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
        return { cls: 'meta', text: line };
      }
      if (line.startsWith('+')) return { cls: 'add', text: line };
      if (line.startsWith('-')) return { cls: 'del', text: line };
      return { cls: '', text: line };
    });
}

onMounted(loadStatus);
watch(() => props.reloadKey, loadStatus);
watch(
  () => props.tabRequest,
  (request) => {
    if (!request) return;
    tab.value = request.tab === 'history' ? 'history' : 'changes';
    if (request.focusMessage) nextTick(() => messageBox.value?.focus());
  },
);
</script>

<template>
  <section class="workspace git-panel">
    <header class="workspace-head">
      <h2><span class="icon sm" aria-hidden="true">🌿</span>Git 变更</h2>
      <span v-if="status?.repository" class="badge accent">{{ status.branch ?? '(detached)' }}</span>
      <span v-if="status?.repository?.head" class="badge mono">{{ status.repository.head }}</span>
      <span v-if="countsLabel" class="badge">{{ countsLabel }}</span>
      <span class="spacer"></span>
      <div class="segmented">
        <button type="button" :aria-pressed="tab === 'changes'" @click="tab = 'changes'">变更 {{ changes.length }}</button>
        <button type="button" :aria-pressed="tab === 'history'" @click="tab = 'history'">历史 {{ log?.commits?.length ?? 0 }}</button>
      </div>
      <button type="button" class="btn mini" :disabled="loading" @click="loadStatus">
        <span class="icon sm" aria-hidden="true">↻</span>刷新
      </button>
    </header>

    <p v-if="error" class="state error">
      <strong>无法读取 git 状态</strong>
      <span>{{ error }}</span>
      <span class="state-actions"><button type="button" class="btn" @click="loadStatus">重试</button></span>
    </p>

    <p v-else-if="loading" class="state">
      <span class="spinner"></span>
      <span>正在读取仓库状态…</span>
    </p>

    <div v-else-if="notARepository" class="state">
      <strong>{{ repositoryHint ? repositoryHint.title : '这个站点不是 git 仓库' }}</strong>
      <p>{{ status.reason }}</p>
      <p v-if="repositoryHint?.command" class="hint"><code>{{ repositoryHint.command }}</code></p>
      <p v-if="repositoryHint" class="hint">{{ repositoryHint.text }}</p>
      <p v-else class="hint">编辑器不会替你执行 <code>git init</code>；如果想让变更被版本管理，请先手动初始化仓库。</p>
      <span class="state-actions"><button type="button" class="btn" @click="loadStatus">重新读取</button></span>
    </div>

    <div v-else class="git-body">
      <div class="git-main">
        <template v-if="tab === 'changes'">
          <div v-if="changes.length === 0" class="state">
            <strong>工作区是干净的</strong>
            <span>保存文档后，改动会出现在这里。</span>
          </div>
          <template v-else>
            <label class="file-filter">
              <input v-model="filter" type="search" placeholder="筛选路径…" aria-label="筛选变更文件" />
              <span class="hint">{{ filter ? `${visibleChanges.length} / ${changes.length}` : `${changes.length} 个文件` }}</span>
            </label>
            <div class="file-list">
              <div
                v-for="change in visibleChanges"
                :key="change.path"
                class="file-row"
                :class="{ active: selected === change.path }"
                role="button"
                tabindex="0"
                :aria-label="`查看 ${change.path} 的改动`"
                @click="openDiff(change.path)"
                @keydown.enter="openDiff(change.path)"
                @keydown.space.prevent="openDiff(change.path)"
              >
                <input
                  type="checkbox"
                  :checked="checked.has(change.path)"
                  :aria-label="`选择 ${change.path}`"
                  @click.stop="toggle(change.path)"
                />
                <span class="kind" :class="change.kind">{{ KIND_LETTER[change.kind] ?? '?' }}</span>
                <span class="path" :title="change.path">{{ change.path }}</span>
                <span v-if="change.originalPath" class="hint">← {{ change.originalPath }}</span>
                <span v-if="change.staged" class="badge">已暂存</span>
                <span v-if="change.unstaged" class="badge">未暂存</span>
              </div>
            </div>
            <div class="commit-box">
              <div class="commit-head">
                <label class="check">
                  <input type="checkbox" :checked="checked.size === changes.length" @change="toggleAll" />
                  <span>全选（{{ checked.size }}/{{ changes.length }}）</span>
                </label>
                <span class="spacer"></span>
                <span class="hint">只提交勾选的文件</span>
              </div>
              <textarea ref="messageBox" v-model="message" rows="3" placeholder="提交信息，例如：更新文章元数据"></textarea>
              <div class="commit-actions">
                <button type="button" class="btn primary sm" :disabled="!canCommit" @click="submitCommit">
                  <span v-if="busy" class="spinner"></span>
                  <span v-else class="icon sm" aria-hidden="true">✅</span>
                  <span>提交 {{ selectedPaths.length }} 个文件</span>
                </button>
                <span v-if="commitBlockedReason" class="hint">{{ commitBlockedReason }}</span>
                <span v-else class="hint">不会执行 pre-commit 钩子，也不会 push。</span>
              </div>
            </div>
          </template>
        </template>

        <template v-else>
          <div v-if="!log || log.commits.length === 0" class="state">
            <strong>还没有提交</strong>
            <span>这个仓库目前没有历史。</span>
          </div>
          <div v-else class="file-list">
            <button
              v-for="entry in log.commits"
              :key="entry.sha"
              type="button"
              class="commit-row"
              @click="openCommit(entry.sha)"
            >
              <code class="sha">{{ entry.sha.slice(0, 8) }}</code>
              <span class="path">{{ entry.subject }}</span>
              <span class="hint">{{ entry.author }} · {{ entry.date }}</span>
            </button>
          </div>
        </template>
      </div>

      <aside class="git-side">
        <div v-if="diffLoading" class="state"><span class="spinner"></span><span>正在读取 diff…</span></div>
        <p v-else-if="diffError" class="state error">
          <strong>无法读取 diff</strong>
          <span>{{ diffError }}</span>
        </p>

        <template v-else-if="commit">
          <h3>{{ commit.commit.subject }}</h3>
          <p class="hint">
            <code>{{ commit.commit.sha.slice(0, 10) }}</code> · {{ commit.commit.author }} · {{ commit.commit.date }}
          </p>
          <pre v-if="commit.commit.body" class="commit-body">{{ commit.commit.body }}</pre>
          <h4>文件（{{ commit.files.length }}）</h4>
          <div class="file-list compact">
            <template v-for="file in commit.files" :key="file.repoPath">
              <button
                v-if="!file.outside"
                type="button"
                class="file-row"
                :class="{ active: selected === file.path }"
                @click="openCommitFile(file.path)"
              >
                <span class="path">{{ file.path }}</span>
                <span class="stat">
                  <span class="add">+{{ file.additions }}</span> <span class="del">-{{ file.deletions }}</span>
                </span>
              </button>
              <!-- A commit can reach outside the site (the repository may be larger than it).
                   Naming the file is honest; offering a diff the site root cannot produce is not. -->
              <div v-else class="file-row outside" :title="file.repoPath">
                <span class="path">{{ file.repoPath }}</span>
                <span class="hint">站点之外</span>
              </div>
            </template>
          </div>
          <p class="hint">
            <template v-if="commitNarrowed">
              只显示 <code>{{ commitNarrowed }}</code>
              <button type="button" class="btn mini" @click="showWholeCommit">看整个提交</button>
            </template>
            <template v-else>这是整次提交的改动。</template>
          </p>
          <pre v-if="commitText" class="diff"><code><span v-for="(line, index) in diffLines(commitText)" :key="index" class="diff-line" :class="line.cls">{{ line.text }}</span></code></pre>
          <p v-else class="hint">这次提交没有可显示的文本改动（可能是合并提交，或改动全在二进制文件里）。</p>
        </template>

        <template v-else-if="diff">
          <h3>{{ diff.kind === 'untracked' ? '新增（尚未跟踪）' : '改动' }}</h3>
          <div v-if="showScopeSwitch" class="segmented" role="group" aria-label="diff 范围">
            <button type="button" :aria-pressed="diffScope === 'unstaged'" @click="setScope('unstaged')">未暂存</button>
            <button type="button" :aria-pressed="diffScope === 'staged'" @click="setScope('staged')">已暂存</button>
          </div>
          <p class="hint">
            <code>{{ diff.path }}</code>
            <span v-if="diff.binary" class="badge warn">二进制文件</span>
            <span v-else class="badge ok">+{{ diff.additions }}</span>
            <span v-if="!diff.binary" class="badge err">-{{ diff.deletions }}</span>
            <span v-if="showScopeSwitch" class="hint">{{ scopeLabel }}</span>
          </p>
          <p v-if="diff.binary" class="hint">这是二进制资源，diff 不显示字节内容。</p>
          <p v-else-if="diff.text.trim() === ''" class="hint">{{ scopeEmptyHint }}</p>
          <pre v-else class="diff"><code><span v-for="(line, index) in diffLines(diff.text)" :key="index" class="diff-line" :class="line.cls">{{ line.text }}</span></code></pre>
        </template>

        <div v-else class="state">
          <strong>选择一个文件</strong>
          <span>左边点一个变更，或者点一次提交看它的 diff。</span>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.file-filter {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  border-bottom: 1px solid var(--border);
}

/* The filter bar spans the pane; the input inside it keeps the shared control
   look, so this only decides how it shares the row. */
.file-filter input {
  flex: 1 1 auto;
  min-width: 0;
}

.git-panel {
  min-height: 0;
}

.git-body {
  display: grid;
  grid-template-columns: minmax(320px, 1fr) minmax(360px, 1.2fr);
  min-height: 0;
  flex: 1 1 auto;
}

.git-main {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--border);
}

.git-side {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  padding: var(--space-lg);
  min-height: 0;
  overflow-y: auto;
}

.git-side h3 {
  margin: 0;
}

.commit-box {
  display: grid;
  gap: var(--space-sm);
  padding: var(--space-md) var(--space-lg);
  border-top: 1px solid var(--border);
  background: var(--surface-2);
}

.commit-head,
.commit-actions {
  display: flex;
  align-items: center;
  gap: var(--space-md);
}

textarea {
  width: 100%;
}

.check {
  display: inline-flex;
  align-items: center;
  gap: var(--space-sm);
}

.commit-row {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  width: 100%;
  padding: var(--space-sm) var(--space-md);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
}

.commit-row:hover {
  background: var(--surface-hover);
}

.commit-row .sha {
  color: var(--accent);
}

.commit-body {
  margin: 0;
  padding: var(--space-md);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  white-space: pre-wrap;
}

.file-list.compact .file-row {
  padding: var(--space-xs) var(--space-sm);
}

/* A file the commit touched outside the site: named, but not offered as a diff the site root
   could not produce. */
.file-row.outside {
  cursor: default;
  color: var(--muted);
}

.file-row.outside:hover {
  background: transparent;
}

.diff {
  margin: 0;
  max-height: none;
  flex: 1 1 auto;
}
</style>
