// The git panel's decisions, as data and pure functions.
//
// The house rule (see AGENTS.md): a `.vue` file renders, and the parts that can be *wrong* live
// in a `.js` module that `node --test` can call directly - there is no jsdom here, so a decision
// buried in a component is a decision nothing can check. Everything in this file is pure.

// One letter per change kind, which is what the row shows where a git client shows `XY`.
export const KIND_LETTER = Object.freeze({
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U',
  conflicted: '!',
  typechange: 'T',
});

export const DIFF_SCOPES = Object.freeze(['unstaged', 'staged']);

// Which half of a change a row opens on. A change that lives only in the index has nothing to
// show for the worktree, so opening it on 未暂存 would present an empty page for a change the
// user is looking at - so the index half is what it opens on.
export function preferredScope(change) {
  if (change && change.staged === true && change.unstaged !== true) return 'staged';
  return 'unstaged';
}

export function diffScopeLabel(scope) {
  return scope === 'staged' ? '已暂存（索引 vs HEAD）' : '未暂存（工作区 vs 索引）';
}

// Untracked files have no index side at all, so the switch has nothing to switch to.
export function scopeSwitchAvailable(diff) {
  return Boolean(diff) && diff.kind !== 'untracked';
}

// The path filter over the change list. An empty needle means "everything": the list is never
// silently shortened, so the count beside it always describes what is on screen.
export function visibleChanges(changes, filter) {
  const list = Array.isArray(changes) ? changes : [];
  const needle = String(filter ?? '').trim().toLowerCase();
  if (needle === '') return list;
  return list.filter((change) => String(change.path ?? '').toLowerCase().includes(needle));
}

// Why the commit button is disabled, in words, in the order the user would fix them. `null` means
// "nothing is blocking it". A greyed-out button with no reason beside it is how a working editor
// gets blamed for being broken.
export function commitBlockedReason({ busy = false, changeCount = 0, selectedCount = 0, message = '' } = {}) {
  if (busy) return '正在提交…';
  if (changeCount === 0) return '工作区是干净的，没有可提交的变更';
  if (selectedCount === 0) return '先勾选要提交的文件';
  if (String(message).trim() === '') return '写一句提交信息';
  return null;
}

// A repository probe fails in two ways that look alike in git's own words and need opposite
// advice. The service classifies the failure (reasonCode); the wording the user reads is here.
export function repositoryNotice(status) {
  const code = status?.reasonCode;
  if (code === 'dubious-ownership') {
    const directory = status?.reasonDirectory ?? '<仓库路径>';
    return {
      title: 'git 拒绝读取这个仓库：它属于另一个用户',
      command: `git config --global --add safe.directory ${directory}`,
      text: '在运行编辑器的机器上执行上面这条命令（一次即可），然后点「刷新」。编辑器不会替你改 git 配置，也不会执行 git init。',
    };
  }
  if (code === 'git-missing') {
    return {
      title: '找不到 git 可执行文件',
      command: null,
      text: '这台机器上没有 git，或者它不在 PATH 里。编辑器只读 git，不会自己安装一个。',
    };
  }
  return null;
}

// "已暂存 2 · 未暂存 5" - only when there is something to say.
export function changeCountsLabel(counts) {
  if (!counts || !counts.total) return null;
  return `已暂存 ${counts.staged ?? 0} · 未暂存 ${counts.unstaged ?? 0}`;
}

// An empty diff in one half is a normal state, not a failure, and the wording should say which
// half to look at instead.
export function emptyScopeHint(change, scope) {
  const other = scope === 'staged' ? '未暂存' : '已暂存';
  if (change && change.staged === true && change.unstaged === true) {
    return `这个范围里没有改动；另一半（${other}）有。`;
  }
  return '这个范围里没有改动——改动可能已经在索引里，或者已经被提交。';
}
