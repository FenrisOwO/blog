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

// --- pushing ---------------------------------------------------------------
//
// The push box's decisions, kept here for the same reason as the rest of this file: a `.vue` file
// renders, and anything that can be *wrong* has to be callable from `node --test`.

// The count badges, and only what is actually there. `ahead: null` (the branch tracks nothing yet)
// has no badge on purpose: "we do not know yet" is not a number.
export function aheadBehindLabel({ ahead = null, behind = null } = {}) {
  const parts = [];
  if (Number.isInteger(ahead) && ahead > 0) parts.push(`↑${ahead}`);
  if (Number.isInteger(behind) && behind > 0) parts.push(`↓${behind}`);
  return parts.length > 0 ? parts.join(' ') : null;
}

// The sentence under the target: what would actually travel, and what would not.
export function pushSummary({ hasUpstream = false, ahead = null, behind = null, uncommitted = 0 } = {}) {
  let text;
  let tone = 'info';
  if (!hasUpstream) {
    text = '首次推送：会在远程新建这个分支，并把它设为上游。';
  } else if (!Number.isInteger(ahead) || !Number.isInteger(behind)) {
    text = '无法确定与远程的差距：本地跟踪引用不可用。';
    tone = 'warn';
  } else if (ahead === 0 && behind === 0) {
    text = '没有未推送的提交。';
    tone = 'muted';
  } else if (ahead === 0) {
    text = `本地没有新提交，但落后远程 ${behind} 个提交——推送会被拒绝。`;
    tone = 'warn';
  } else if (behind > 0) {
    text = `${ahead} 个提交等待推送；本地还落后远程 ${behind} 个提交，推送可能被拒绝。`;
    tone = 'warn';
  } else {
    text = `${ahead} 个提交等待推送。`;
  }
  // A push only sends commits, so uncommitted work is worth naming here - it is the difference
  // between "I pushed" and "my latest edit is on the site".
  const note = uncommitted > 0 ? `未提交的 ${uncommitted} 个文件不会随这次推送出去。` : null;
  return { text, note, tone };
}

// `origin/main ← phase-8-modern-editor`: the remote branch a push writes, and the local one it comes
// from. Without an upstream the destination is the local branch name, created by this push.
export function pushTargetLabel({ remote = null, branch = null, setUpstream = false } = {}) {
  if (!remote || !branch) return null;
  return setUpstream ? `${remote}/${branch}（本次新建，并设为上游）` : `${remote}/${branch}`;
}

// Why the push button is disabled, in the order the user would fix them. `null` means pushable.
export function pushBlockedReason({ busy = false, state = null } = {}) {
  if (busy) return '正在推送…';
  if (!state) return '正在读取远程信息…';
  if (state.detached === true || !state.branch) return '当前是游离 HEAD，没有可推送的分支';
  if (!Array.isArray(state.remotes) || state.remotes.length === 0) return '这个仓库还没有配置远程仓库（remote）';
  if (!state.remote) return '有多个远程仓库，请先在下面选一个';
  return null;
}

// The button is two-step: publishing to a remote is the one action here that leaves the machine, so
// the first click shows what would happen and asks.
export function pushButtonLabel({ stage = 'idle', remote = null, ahead = null } = {}) {
  const target = remote ?? '远程';
  if (stage === 'confirm') return `确认推送到 ${target}`;
  if (Number.isInteger(ahead) && ahead > 0) return `推送到 ${target}（${ahead} 个提交）`;
  return `推送到 ${target}`;
}

// What just happened, said plainly - "already there" and "we sent something" are different outcomes.
export function pushResultLabel({ pushed = false, upToDate = false, remote = '', branch = '', setUpstream = false } = {}) {
  if (upToDate) return `远程已经是最新的：${remote}/${branch}`;
  if (pushed) return `已推送 ${branch} → ${remote}/${branch}${setUpstream ? '（已设为上游）' : ''}`;
  return `远程没有需要更新的 ref：${remote}/${branch}`;
}

// Why a push failed, in words, plus the command that fixes it outside the editor. The service
// classifies (`reason`); the wording is here. `null` reason (a validation error) means the message
// the server sent is already precise, so the panel shows it as it is.
const PUSH_FAILURE_NOTICES = Object.freeze({
  'no-remote': {
    title: '这个仓库还没有远程仓库',
    text: '先在终端里把远程加上，回来点一次「刷新」就能推送。',
    command: 'git remote add origin <仓库地址>',
  },
  'detached-head': {
    title: '当前是游离 HEAD',
    text: '没有分支可以推送。先切回一个分支（编辑器不会替你 checkout）。',
    command: 'git switch <分支名>',
  },
  'no-credentials': {
    title: '这台机器没有访问远程仓库的凭据',
    text: '编辑器不会保存、也不会接受任何凭据（没有 token 输入框，是故意的）。在终端里登录一次，git 就会用系统里已有的凭据助手；登录前它会立刻失败，而不是卡在密码提示上。',
    command: 'gh auth login && gh auth setup-git',
  },
  'rejected-non-fast-forward': {
    title: '远程有你本地没有的提交，推送被拒绝',
    text: '这次推送什么都没改。编辑器不会替你 fetch、merge 或 force——那几条路都可能覆盖别人的提交。在终端里先把远程的提交取回来合好，再回来推送。',
    command: 'git pull --rebase',
  },
  'rejected-by-remote': {
    title: '远程拒绝了这次推送',
    text: '常见原因：分支受保护、服务端钩子拒绝、或者没有被授予写权限。git 的原文在下面。',
    command: null,
  },
  'remote-unreadable': {
    title: '远程仓库读不到',
    text: '仓库不存在、地址不对，或者这台机器没有它的访问凭据。先确认地址与权限。',
    command: 'gh auth status',
  },
  network: {
    title: '连不上远程仓库',
    text: '网络或 DNS 的问题，不是仓库的问题。git 的原文在下面。',
    command: null,
  },
  unknown: {
    title: '推送失败',
    text: 'git 给出的原因在下面原文里；编辑器没有猜，也没有改任何东西。',
    command: null,
  },
});

export function pushFailureNotice(reason) {
  return PUSH_FAILURE_NOTICES[reason] ?? PUSH_FAILURE_NOTICES.unknown;
}
