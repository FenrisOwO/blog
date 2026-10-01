// The git panel's decisions, tested as plain functions - the panel renders them, this file
// decides whether they are right (house rule: no jsdom, so decisions live in web/*.js).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DIFF_SCOPES,
  KIND_LETTER,
  changeCountsLabel,
  commitBlockedReason,
  diffScopeLabel,
  emptyScopeHint,
  preferredScope,
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
