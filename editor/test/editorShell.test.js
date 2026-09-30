// Phase 8: the shell's own logic - the theme store, the toast store and the command registry.
//
// These three are the parts of the modern-editor layer that are pure data and callbacks, so they
// are tested here rather than through the DOM: the point of each test is that the *policy*
// (how "system" resolves, how long an error stays, which commands are allowed right now) lives
// outside the components.

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCommands, commandScore, filterCommands, groupCommands } from '../web/commands.js';
import { createThemeStore, readStoredTheme, resolveTheme, THEME_PREFERENCES } from '../web/theme.js';
import { createToastStore, TOAST_KINDS } from '../web/toast.js';

test('resolveTheme only consults the OS when the preference is system', () => {
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  // An unknown or missing preference behaves as "system" rather than throwing.
  assert.equal(resolveTheme(undefined, true), 'dark');
  assert.equal(resolveTheme('neon', false), 'light');
});

test('readStoredTheme falls back to system for junk, absence and a hostile storage', () => {
  const fake = (value) => ({ getItem: () => value });
  assert.equal(readStoredTheme(fake('dark')), 'dark');
  assert.equal(readStoredTheme(fake('solarized')), 'system');
  assert.equal(readStoredTheme(fake(null)), 'system');
  assert.equal(readStoredTheme(undefined), 'system');
  assert.equal(
    readStoredTheme({
      getItem() {
        throw new Error('storage disabled');
      },
    }),
    'system',
  );
});

test('the theme store writes the resolved theme and remembers the preference', () => {
  const written = [];
  const root = { dataset: {} };
  const storage = { getItem: () => 'system', setItem: (key, value) => written.push([key, value]) };
  const store = createThemeStore({ storage, root, media: { matches: true, addEventListener() {} } });

  assert.equal(store.preference, 'system');
  assert.equal(store.resolved, 'dark');
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(root.dataset.themePreference, 'system');

  store.set('light');
  assert.equal(root.dataset.theme, 'light');
  assert.equal(root.dataset.themePreference, 'light');
  assert.deepEqual(written, [['hve.theme', 'light']]);

  // Toggling is defined against what the user currently sees, not the stored preference.
  store.toggle();
  assert.equal(store.resolved, 'dark');
  assert.equal(store.preference, 'dark');

  // An unknown preference changes nothing.
  store.set('sepia');
  assert.equal(store.preference, 'dark');

  store.set('system');
  assert.equal(store.resolved, 'dark', 'system resolves through the OS query again');
});

test('the theme store tolerates a storage that refuses to write', () => {
  const root = { dataset: {} };
  const store = createThemeStore({
    storage: {
      getItem: () => 'dark',
      setItem() {
        throw new Error('quota');
      },
    },
    root,
    media: null,
  });
  assert.doesNotThrow(() => store.set('light'));
  assert.equal(store.resolved, 'light');
});

test('the theme store notifies subscribers and re-resolves when the OS flips', () => {
  const root = { dataset: {} };
  let listener = null;
  const media = {
    matches: false,
    addEventListener(event, handler) {
      assert.equal(event, 'change');
      listener = handler;
    },
  };
  const store = createThemeStore({ storage: null, root, media });
  const seen = [];
  const unsubscribe = store.subscribe(({ preference, resolved }) => seen.push(`${preference}:${resolved}`));

  assert.deepEqual(seen, ['system:light']);
  media.matches = true;
  listener();
  assert.deepEqual(seen, ['system:light', 'system:dark'], 'a system preference follows the OS');

  store.set('light');
  media.matches = false;
  listener();
  assert.equal(store.resolved, 'light', 'an explicit choice ignores the OS');

  unsubscribe();
  store.set('dark');
  assert.equal(seen.length, 3);
  assert.deepEqual([...THEME_PREFERENCES], ['light', 'dark', 'system']);
});

test('toasts are classified, timed per kind and never stacked twice for one key', () => {
  const store = createToastStore({ now: () => 12 });
  const kinds = [];
  store.subscribe((items) => kinds.push(items.length));

  assert.deepEqual(kinds, [0], 'a new subscriber is told the current state');
  const first = store.success('已保存', { text: 'post/a.md' });
  store.error('保存失败', { key: 'save' });
  store.error('保存失败（重试）', { key: 'save' });

  assert.equal(store.items.length, 2, 'the same key replaces rather than stacks');
  assert.deepEqual(kinds, [0, 1, 2, 2]);
  assert.equal(store.items[0].id, first);
  assert.equal(store.items[0].at, 12);
  assert.ok(store.items[1].timeout > store.items[0].timeout, 'an error stays longer than a success');
  assert.deepEqual([...TOAST_KINDS], ['success', 'info', 'warning', 'error']);

  store.dismiss(first);
  assert.equal(store.items.length, 1);
  assert.equal(store.dismiss(9999), undefined, 'dismissing an unknown id is not an error');
  store.clear();
  assert.equal(store.items.length, 0);
});

test('an unknown toast kind is shown as information rather than dropped', () => {
  const store = createToastStore();
  store.push('pink', 'hello');
  assert.equal(store.items[0].kind, 'info');
});

test('the command registry only offers what the current state allows', () => {
  const calls = [];
  const actions = new Proxy(
    {},
    {
      get: (_target, name) => (arg) => calls.push([name, arg]),
    },
  );

  const clean = buildCommands(
    {
      view: 'content',
      selectedPath: 'post/a.md',
      dirty: false,
      busy: false,
      theme: 'light',
      themePreference: 'light',
      inspectorOpen: true,
      gitChanges: 0,
      gitRepository: false,
      documents: [],
    },
    actions,
  );

  const byId = new Map(clean.map((command) => [command.id, command]));
  assert.equal(byId.get('save').enabled, false, 'nothing to save while the document is clean');
  assert.equal(byId.get('save').hint, null);
  assert.equal(byId.get('discard').enabled, false);
  assert.equal(byId.get('commit').enabled, false, 'a clean repository offers no commit');
  assert.equal(byId.get('commit').hint, '没有未提交的变更');
  assert.equal(byId.get('git-history').enabled, false, 'no repository, no history');
  assert.equal(byId.get('view-content').enabled, false, 'the palette does not re-open the current view');
  assert.equal(byId.get('view-git').enabled, true);
  assert.equal(byId.get('theme-light').enabled, false, 'the active theme is not offered again');
  assert.equal(byId.get('theme-dark').label, '主题：深色');

  // Empty query: the disabled entries are hidden, so the palette opens on what can actually run.
  const visible = filterCommands(clean, '').map((command) => command.id);
  assert.ok(visible.includes('build'));
  assert.ok(!visible.includes('save'));

  byId.get('build').run();
  byId.get('view-git').run();
  assert.deepEqual(calls, [['build', undefined], ['go', 'git']]);
});

test('the command registry follows the document, the repository and the search', () => {
  const documents = [
    { path: 'post/a.md', title: 'A', section: 'post', language: 'zh-cn' },
    { path: 'post/b.md', title: 'B', section: 'post', language: 'en' },
  ];
  const actions = { open: () => {}, save: () => {}, commit: () => {} };
  const dirty = buildCommands(
    {
      view: 'git',
      selectedPath: 'post/a.md',
      dirty: true,
      busy: false,
      theme: 'dark',
      themePreference: 'system',
      inspectorOpen: false,
      gitChanges: 3,
      gitRepository: true,
      documents,
    },
    actions,
  );

  const byId = new Map(dirty.map((command) => [command.id, command]));
  assert.equal(byId.get('save').enabled, true);
  assert.equal(byId.get('commit').enabled, true);
  assert.equal(byId.get('git-history').enabled, true);
  assert.equal(byId.get('toggle-theme').label, '切换到浅色主题');
  assert.equal(byId.get('toggle-inspector').label, '显示检查器');
  assert.equal(byId.get('view-git').enabled, false, 'already in git');
  assert.equal(byId.get('open:post/a.md').enabled, false, 'the open document is not offered again');
  assert.equal(byId.get('open:post/b.md').enabled, true);

  // A query searches disabled entries too - that is how you find out why something is greyed out.
  const matched = filterCommands(dirty, '提交').map((command) => command.id);
  assert.ok(matched.includes('commit'));
  assert.ok(matched.includes('git-history'));

  const grouped = groupCommands(filterCommands(dirty, ''));
  assert.deepEqual(
    grouped.map((entry) => entry.group),
    ['Actions', 'Navigate', 'View', 'Git', 'Documents'],
    'groups appear in registry order, documents last',
  );
  assert.equal(
    grouped.reduce((total, entry) => total + entry.items.length, 0),
    filterCommands(dirty, '').length,
  );

  assert.equal(commandScore({ id: 'build', label: '构建站点', keywords: [] }, ''), 1);
  assert.equal(commandScore({ id: 'build', label: 'Build', keywords: ['hugo'] }, 'hugo'), 100);
  assert.equal(commandScore({ id: 'build', label: 'Build', keywords: [] }, 'zzz'), -1);
});
