// The git panel's decisions, tested as plain functions - the panel renders them, this file
// decides whether they are right (house rule: no jsdom, so decisions live in web/*.js).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DIFF_SCOPES,
  KIND_LETTER,
  aheadBehindLabel,
  changeCountsLabel,
  commitBlockedReason,
  diffScopeLabel,
  emptyScopeHint,
  preferredScope,
  pushBlockedReason,
  pushButtonLabel,
  pushFailureNotice,
  pushResultLabel,
  pushSummary,
  pushTargetLabel,
  repositoryNotice,
  scopeSwitchAvailable,
  visibleChanges,
} from '../web/gitView.js';

test('the change list filters by path, case-insensitively, and an empty filter hides nothing', () => {
  const changes = [
    { path: 'content/post/Hello.md' },
    { path: 'content/post/notes/deep.md' },
    { path: 'config/_default/params.toml' },
  ];

  assert.equal(visibleChanges(changes, '').length, 3);
  assert.equal(visibleChanges(changes, '   ').length, 3, 'whitespace is not a needle');
  assert.deepEqual(visibleChanges(changes, 'POST/HELLO').map((change) => change.path), ['content/post/Hello.md']);
  assert.deepEqual(visibleChanges(changes, 'post/').length, 2);
  assert.deepEqual(visibleChanges(changes, 'params'), [changes[2]]);
  assert.deepEqual(visibleChanges(changes, 'nothing-matches'), []);
  assert.deepEqual(visibleChanges(null, 'x'), [], 'a missing list is an empty list, not a crash');
});

test('a row opens on the half of the change that actually has something to show', () => {
  // Staged only: the worktree is clean, so 未暂存 would open an empty page.
  assert.equal(preferredScope({ staged: true, unstaged: false }), 'staged');
  // Both halves: the worktree half is what the user just typed, so show that.
  assert.equal(preferredScope({ staged: true, unstaged: true }), 'unstaged');
  assert.equal(preferredScope({ staged: false, unstaged: true }), 'unstaged');
  assert.equal(preferredScope({ kind: 'untracked' }), 'unstaged');
  assert.equal(preferredScope(null), 'unstaged');

  assert.equal(diffScopeLabel('staged'), '已暂存（索引 vs HEAD）');
  assert.equal(diffScopeLabel('unstaged'), '未暂存（工作区 vs 索引）');
  assert.deepEqual([...DIFF_SCOPES], ['unstaged', 'staged']);

  // Untracked files have no index side, so the switch would only offer an empty answer.
  assert.equal(scopeSwitchAvailable({ kind: 'untracked' }), false);
  assert.equal(scopeSwitchAvailable({ kind: 'modified' }), true);
  assert.equal(scopeSwitchAvailable(null), false);
});

test('the commit button always says why it is disabled, in the order it would be fixed', () => {
  assert.equal(commitBlockedReason({ busy: true, changeCount: 3, selectedCount: 1, message: 'x' }), '正在提交…');
  assert.equal(commitBlockedReason({ changeCount: 0 }), '工作区是干净的，没有可提交的变更');
  assert.equal(commitBlockedReason({ changeCount: 2, selectedCount: 0, message: 'x' }), '先勾选要提交的文件');
  assert.equal(commitBlockedReason({ changeCount: 2, selectedCount: 2, message: '   ' }), '写一句提交信息');
  assert.equal(commitBlockedReason({ changeCount: 2, selectedCount: 2, message: '更新文章' }), null);
  assert.equal(commitBlockedReason(), '工作区是干净的，没有可提交的变更');
});

test('an empty diff says which half to look at instead', () => {
  assert.match(emptyScopeHint({ staged: true, unstaged: true }, 'unstaged'), /另一半（已暂存）有/);
  assert.match(emptyScopeHint({ staged: true, unstaged: true }, 'staged'), /另一半（未暂存）有/);
  assert.match(emptyScopeHint({ staged: true, unstaged: false }, 'unstaged'), /已经在索引里/);
  assert.match(emptyScopeHint(null, 'unstaged'), /已经被提交/);
});

test('a repository that cannot be read says which of the two things went wrong', () => {
  const ownership = repositoryNotice({ reasonCode: 'dubious-ownership', reasonDirectory: '/projects' });
  assert.equal(ownership.command, 'git config --global --add safe.directory /projects');
  assert.match(ownership.title, /另一个用户/);
  assert.match(ownership.text, /不会执行 git init/);

  // Without a directory from git, the command still has to be a complete, runnable line.
  assert.match(repositoryNotice({ reasonCode: 'dubious-ownership' }).command, /safe\.directory <仓库路径>$/);

  const missing = repositoryNotice({ reasonCode: 'git-missing' });
  assert.equal(missing.command, null, 'there is no command that installs git for you');
  assert.match(missing.text, /不会自己安装/);

  // 不是仓库 / unknown / no status at all: the panel's own default wording, not a guess.
  assert.equal(repositoryNotice({ reasonCode: 'not-a-repository' }), null);
  assert.equal(repositoryNotice({}), null);
  assert.equal(repositoryNotice(null), null);
});

test('the counts line appears only when there is something to count', () => {
  assert.equal(changeCountsLabel({ total: 0, staged: 0, unstaged: 0 }), null);
  assert.equal(changeCountsLabel(null), null);
  assert.equal(changeCountsLabel({ total: 3, staged: 1, unstaged: 2 }), '已暂存 1 · 未暂存 2');
  assert.equal(changeCountsLabel({ total: 1 }), '已暂存 0 · 未暂存 0');
});

test('every kind the git service can report has a letter in the panel', () => {
  // Cross-checks the service's vocabulary: a new kind there without a letter here would render
  // as a bare '?'.
  for (const kind of ['modified', 'added', 'deleted', 'renamed', 'copied', 'untracked', 'conflicted', 'typechange']) {
    assert.equal(typeof KIND_LETTER[kind], 'string', `${kind} has no letter`);
    assert.equal(KIND_LETTER[kind].length, 1);
  }
  assert.equal(new Set(Object.values(KIND_LETTER)).size, Object.keys(KIND_LETTER).length, 'letters collide');
});

// --- Phase 10: the push box -------------------------------------------------

test('the ahead/behind badge shows only what is actually there', () => {
  assert.equal(aheadBehindLabel({ ahead: 3, behind: 0 }), '↑3');
  assert.equal(aheadBehindLabel({ ahead: 0, behind: 2 }), '↓2');
  assert.equal(aheadBehindLabel({ ahead: 3, behind: 2 }), '↑3 ↓2');
  // In step, or nothing known yet: no badge at all, because "0" and "unknown" are not news.
  assert.equal(aheadBehindLabel({ ahead: 0, behind: 0 }), null);
  assert.equal(aheadBehindLabel({ ahead: null, behind: null }), null);
  assert.equal(aheadBehindLabel({}), null);
  assert.equal(aheadBehindLabel(), null);
});

test('the push summary tells "nothing to send" apart from "the other side is unknown"', () => {
  const first = pushSummary({ hasUpstream: false, ahead: null, behind: null });
  assert.match(first.text, /首次推送/);
  assert.match(first.text, /上游/);

  const unknown = pushSummary({ hasUpstream: true, ahead: null, behind: null });
  assert.match(unknown.text, /无法确定/);
  assert.equal(unknown.tone, 'warn');

  const inStep = pushSummary({ hasUpstream: true, ahead: 0, behind: 0 });
  assert.match(inStep.text, /没有未推送的提交/);
  assert.equal(inStep.tone, 'muted');

  const ahead = pushSummary({ hasUpstream: true, ahead: 3, behind: 0 });
  assert.match(ahead.text, /3 个提交等待推送/);
  assert.equal(ahead.tone, 'info');

  // Behind is the case that ends in a refusal, and the wording says so before the click.
  const behind = pushSummary({ hasUpstream: true, ahead: 0, behind: 2 });
  assert.match(behind.text, /落后远程 2 个提交/);
  assert.equal(behind.tone, 'warn');

  const both = pushSummary({ hasUpstream: true, ahead: 1, behind: 1 });
  assert.match(both.text, /1 个提交等待推送/);
  assert.match(both.text, /落后远程 1 个提交/);
  assert.equal(both.tone, 'warn');

  // A push sends commits only, so uncommitted work is named rather than implied to be included.
  assert.equal(pushSummary({ hasUpstream: true, ahead: 1, behind: 0, uncommitted: 4 }).note, '未提交的 4 个文件不会随这次推送出去。');
  assert.equal(pushSummary({ hasUpstream: true, ahead: 1, behind: 0 }).note, null);
});

test('the target names the branch a push would write', () => {
  assert.equal(pushTargetLabel({ remote: 'origin', branch: 'main' }), 'origin/main');
  assert.match(pushTargetLabel({ remote: 'origin', branch: 'main', setUpstream: true }), /本次新建/);
  assert.equal(pushTargetLabel({ remote: null, branch: 'main' }), null);
  assert.equal(pushTargetLabel({ remote: 'origin', branch: null }), null);
  assert.equal(pushTargetLabel(), null);
});

test('the push button always says why it is disabled, in the order it would be fixed', () => {
  const repo = { branch: 'main', detached: false, remote: 'origin', remotes: [{ name: 'origin' }] };
  assert.equal(pushBlockedReason({ busy: true, state: repo }), '正在推送…');
  assert.equal(pushBlockedReason({ state: null }), '正在读取远程信息…');
  assert.match(pushBlockedReason({ state: { ...repo, detached: true, branch: null } }), /游离 HEAD/);
  assert.match(pushBlockedReason({ state: { ...repo, remote: null, remotes: [] } }), /没有配置远程仓库/);
  // Several remotes and none of them the obvious one: the service refuses to guess, and so does this.
  assert.match(
    pushBlockedReason({ state: { ...repo, remote: null, remotes: [{ name: 'a' }, { name: 'b' }] } }),
    /多个远程仓库/,
  );
  assert.equal(pushBlockedReason({ state: repo }), null);
  assert.equal(pushBlockedReason(), '正在读取远程信息…');
});

test('the push button is two-step, and the second step names the remote', () => {
  assert.equal(pushButtonLabel({ stage: 'idle', remote: 'origin', ahead: 3 }), '推送到 origin（3 个提交）');
  assert.equal(pushButtonLabel({ stage: 'idle', remote: 'origin', ahead: 0 }), '推送到 origin');
  assert.equal(pushButtonLabel({ stage: 'idle', remote: null, ahead: null }), '推送到 远程');
  assert.equal(pushButtonLabel({ stage: 'confirm', remote: 'origin', ahead: 3 }), '确认推送到 origin');
});

test('the result says whether anything actually travelled', () => {
  assert.equal(pushResultLabel({ pushed: true, remote: 'origin', branch: 'main' }), '已推送 main → origin/main');
  assert.match(
    pushResultLabel({ pushed: true, remote: 'origin', branch: 'main', setUpstream: true }),
    /已设为上游/,
  );
  assert.equal(pushResultLabel({ upToDate: true, remote: 'origin', branch: 'main' }), '远程已经是最新的：origin/main');
  assert.equal(pushResultLabel({ remote: 'origin', branch: 'main' }), '远程没有需要更新的 ref：origin/main');
  assert.equal(pushResultLabel(), '远程没有需要更新的 ref：/');
});

test('every push failure reason has wording and, where one exists, a command to fix it', () => {
  for (const reason of [
    'no-remote',
    'detached-head',
    'no-credentials',
    'rejected-non-fast-forward',
    'rejected-by-remote',
    'remote-unreadable',
    'network',
    'unknown',
  ]) {
    const notice = pushFailureNotice(reason);
    assert.equal(typeof notice.title, 'string', `${reason} has no title`);
    assert.equal(typeof notice.text, 'string', `${reason} has no explanation`);
  }

  // The two that a user can actually act on must hand over a runnable line.
  assert.match(pushFailureNotice('no-credentials').command, /^gh auth login/);
  assert.match(pushFailureNotice('no-credentials').text, /不会保存、也不会接受任何凭据/);
  assert.match(pushFailureNotice('rejected-non-fast-forward').command, /^git pull/);
  assert.match(pushFailureNotice('rejected-non-fast-forward').text, /不会替你 fetch、merge 或 force/);
  assert.equal(pushFailureNotice('network').command, null, 'there is no command that fixes the network');
  assert.equal(pushFailureNotice('rejected-by-remote').command, null, 'that one belongs to the remote');

  // A reason this build does not know still says something true rather than nothing.
  assert.equal(pushFailureNotice('something-new').title, '推送失败');
  assert.equal(pushFailureNotice(null).title, '推送失败');
  assert.equal(pushFailureNotice(undefined).title, '推送失败');
});
