// The command registry behind Ctrl+K.
//
// Pure data plus one filter function, so the palette is a view of the application's real
// actions rather than a list of links: every entry carries the same `run` the button would
// call, and an entry that cannot run right now is disabled with the reason visible.

export const COMMAND_GROUPS = Object.freeze(['Actions', 'Navigate', 'Documents', 'Git', 'View']);

// Fuzzy-ish match: every character of the query must appear in order, which is what makes
// "nsart" find "New Article" the way a command palette should.
export function fuzzyScore(text, query) {
  const haystack = String(text ?? '').toLowerCase();
  const needle = String(query ?? '').toLowerCase();
  if (needle === '') return 0;
  if (haystack.includes(needle)) return 100 - haystack.indexOf(needle);
  let score = 0;
  let cursor = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, cursor);
    if (found === -1) return -1;
    score += found === cursor ? 4 : 1;
    cursor = found + 1;
  }
  return score;
}

export function commandScore(command, query) {
  if (String(query ?? '').trim() === '') return 1;
  const candidates = [command.label, command.id, ...(command.keywords ?? [])];
  const scores = candidates.map((candidate) => fuzzyScore(candidate, query));
  return Math.max(...scores);
}

export function filterCommands(commands, query) {
  return commands
    .filter((command) => command.enabled !== false || String(query ?? '').trim() !== '')
    .map((command) => ({ command, score: commandScore(command, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || (a.command.order ?? 0) - (b.command.order ?? 0))
    .map((entry) => entry.command);
}

export function groupCommands(commands) {
  const groups = new Map();
  for (const command of commands) {
    const group = command.group ?? 'Actions';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(command);
  }
  return [...groups.entries()].map(([group, items]) => ({ group, items }));
}

function make(id, group, label, options = {}) {
  return {
    id,
    group,
    label,
    shortcut: options.shortcut ?? null,
    keywords: options.keywords ?? [],
    enabled: options.enabled ?? true,
    hint: options.hint ?? null,
    run: options.run ?? (() => {}),
  };
}

// The commands the palette offers. `state` is a snapshot of the application and `actions` are
// the same functions the buttons in the UI call, so a command can never drift from the UI.
export function buildCommands(state, actions) {
  const hasDocument = Boolean(state.selectedPath);
  const documents = (state.documents ?? []).slice(0, 40);

  const commands = [
    make('new-article', 'Actions', '新建文章', { keywords: ['new', 'create', 'article', '新建'], run: actions.create }),
    make('save', 'Actions', '保存当前文档', {
      shortcut: 'Ctrl+S',
      keywords: ['save', 'write', '保存'],
      enabled: hasDocument && state.dirty === true && state.busy !== true,
      hint: hasDocument ? null : '没有打开的文档',
      run: actions.save,
    }),
    make('preview-changes', 'Actions', '预览变更（dry-run）', {
      keywords: ['diff', 'preview', '预览'],
      enabled: hasDocument && state.busy !== true,
      run: actions.preview,
    }),
    make('discard', 'Actions', '放弃未保存的修改', {
      keywords: ['discard', 'revert', '放弃'],
      enabled: hasDocument && state.dirty === true,
      run: actions.discard,
    }),
    make('build', 'Actions', '构建站点', {
      keywords: ['build', 'hugo', '构建'],
      run: actions.build,
    }),
    make('open-preview', 'Actions', '打开预览', {
      keywords: ['preview', 'site', '预览'],
      run: actions.openPreview,
    }),
    make('refresh', 'Actions', '重新读取内容树', { keywords: ['reload', 'refresh', '刷新'], run: actions.refresh }),
    make('trash', 'Actions', '打开回收站', { keywords: ['trash', 'restore', '回收站'], run: actions.trash }),

    make('view-content', 'Navigate', '内容', { keywords: ['content', 'content', '内容'], enabled: state.view !== 'content', run: () => actions.go('content') }),
    make('view-assets', 'Navigate', '资源', { keywords: ['assets', 'images', '资源'], enabled: state.view !== 'assets', run: () => actions.go('assets') }),
    make('view-relations', 'Navigate', '关系', { keywords: ['tags', 'links', '关系'], enabled: state.view !== 'relations', run: () => actions.go('relations') }),
    make('view-settings', 'Navigate', '站点设置', { keywords: ['settings', 'config', 'toml', '设置'], enabled: state.view !== 'settings', run: () => actions.go('settings') }),
    make('view-git', 'Navigate', 'Git 变更', { keywords: ['git', 'changes', 'diff'], enabled: state.view !== 'git', run: () => actions.go('git') }),

    make('toggle-theme', 'View', `切换到${state.theme === 'dark' ? '浅色' : '深色'}主题`, {
      keywords: ['theme', 'dark', 'light', '主题'],
      run: actions.toggleTheme,
    }),
    make('theme-light', 'View', '主题：浅色', { keywords: ['light', '浅色'], enabled: state.themePreference !== 'light', run: () => actions.setTheme('light') }),
    make('theme-dark', 'View', '主题：深色', { keywords: ['dark', '深色'], enabled: state.themePreference !== 'dark', run: () => actions.setTheme('dark') }),
    make('theme-system', 'View', '主题：跟随系统', { keywords: ['system', '系统'], enabled: state.themePreference !== 'system', run: () => actions.setTheme('system') }),
    make('toggle-inspector', 'View', state.inspectorOpen ? '隐藏检查器' : '显示检查器', {
      keywords: ['inspector', 'sidebar', '检查器'],
      run: actions.toggleInspector,
    }),
    make('search', 'View', '在内容中搜索', { shortcut: 'Ctrl+F', keywords: ['find', 'search', '搜索'], run: actions.focusSearch }),

    make('commit', 'Git', '提交变更…', {
      keywords: ['commit', 'git', '提交'],
      enabled: state.gitChanges > 0,
      hint: state.gitChanges > 0 ? null : '没有未提交的变更',
      run: actions.commit,
    }),
    make('git-history', 'Git', '查看提交历史', {
      keywords: ['log', 'history', '历史'],
      enabled: state.gitRepository === true,
      run: actions.gitHistory,
    }),
  ];

  for (const document of documents) {
    commands.push(
      make(`open:${document.path}`, 'Documents', document.title || document.path, {
        keywords: [document.path, document.section ?? '', document.language ?? ''],
        hint: document.path,
        enabled: document.path !== state.selectedPath,
        run: () => actions.open(document),
      }),
    );
  }

  return commands;
}
