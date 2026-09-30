// Site Settings (Phase 5.2 / 5.3): the service that turns "the user changed three fields"
// into "these files, this diff, this build".
//
// Reads are asserted against the real site (a settings screen that does not read the real
// config is not worth testing). Writes always happen in a temporary copy of
// `config/_default`, and every write assertion re-reads the files from disk.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { ConfigFileNotFoundError, ConfigGuard, configGuardFor } from '../src/settings/configGuard.js';
import { readThemeInfo } from '../src/settings/themeInfo.js';
import { saveSafely } from '../src/site/safeWrite.js';
import { createSettingsService, SettingsValidationError } from '../src/settings/settingsService.js';
import { readToml } from '../src/settings/toml/index.js';

const SITE_ROOT = '/projects/site';
const REAL_CONFIG = join(SITE_ROOT, 'config', '_default');
const CONFIG_FILES = ['hugo.toml', 'languages.toml', 'markup.toml', 'menu.toml', 'params.toml', 'related.toml'];

const themeInfo = readThemeInfo({
  siteRoot: SITE_ROOT,
  site: { servicesDisqusShortname: 'hugo-theme-stack' },
});

function tempSite() {
  const root = mkdtempSync(join(tmpdir(), 'hve-settings-'));
  const configRoot = join(root, 'config', '_default');
  mkdirSync(configRoot, { recursive: true });
  for (const file of CONFIG_FILES) copyFileSync(join(REAL_CONFIG, file), join(configRoot, file));
  const backupRoot = join(root, 'backups');
  const service = createSettingsService({ siteRoot: root, configRoot, backupRoot, themeInfo });
  return {
    root,
    configRoot,
    backupRoot,
    service,
    read: (file) => readFileSync(join(configRoot, file), 'utf8'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function withTempSite(fn) {
  const site = tempSite();
  try {
    return fn(site);
  } finally {
    site.cleanup();
  }
}

test('the settings list describes the real site: values, sources and layering', () => {
  const service = createSettingsService({
    siteRoot: SITE_ROOT,
    configRoot: REAL_CONFIG,
    backupRoot: join(tmpdir(), 'unused-backups'),
    themeInfo,
  });
  const described = service.list();

  assert.deepEqual(described.files.map((file) => file.file), CONFIG_FILES);
  assert.deepEqual(described.languages.map((language) => language.code), ['zh', 'en', 'zh-hant-tw', 'ja']);
  assert.equal(described.defaultLanguage, 'zh');
  assert.deepEqual(described.groups.map((group) => group.id), ['general', 'appearance', 'navigation', 'language', 'markup', 'related']);

  // The values asserted here are the ones the real site currently holds, read from the same
  // files the service reads: this config belongs to the user, so a test that pinned the
  // shipped defaults would fail the moment anyone used the settings screen.
  const realOf = (file) => readToml(readFileSync(join(REAL_CONFIG, file), 'utf8')).values;
  const realParams = realOf('params.toml');
  const realLanguages = realOf('languages.toml');
  const realHugo = realOf('hugo.toml');

  // A value the site writes itself.
  const since = described.settings['params.footer.since'];
  assert.equal(since.value, realParams['footer.since']);
  assert.equal(since.source, 'site');
  assert.equal(since.present, true);

  // A value that only the theme has: offered, but honestly marked. Which keys are still
  // theme-only depends on how much of the theme the site has overridden, so one is found.
  const themeOnly = Object.entries(described.settings).find(
    ([, setting]) => setting.source === 'theme' && setting.present === false && setting.kind === 'value',
  );
  assert.ok(themeOnly, 'the theme defaults are offered alongside the site values');
  assert.ok(themeOnly[1].warnings.some((warning) => warning.includes('主题默认')));

  // The override relationship, per language: the site default plus the language layer.
  const subtitle = described.settings['params.sidebar.subtitle'];
  assert.equal(subtitle.value, realParams['sidebar.subtitle']);
  const byCode = new Map(subtitle.languageRows.map((row) => [row.code, row]));
  for (const code of described.languages.map((language) => language.code)) {
    const override = realLanguages[`${code}.params.sidebar.subtitle`];
    const row = byCode.get(code);
    assert.ok(row, `${code} has a row`);
    assert.equal(row.effective, override ?? realParams['sidebar.subtitle']);
    if (override !== undefined) {
      assert.equal(row.source, 'language');
      assert.equal(row.present, true);
    }
  }

  // Title is the same idea with Hugo's own key: languages.<code>.title overrides hugo.title.
  const title = described.settings['hugo.title'];
  assert.equal(title.value, realHugo.title);
  const titleRow = title.languageRows.find((row) => row.code === 'zh');
  assert.equal(titleRow.effective, realLanguages['zh.title'] ?? realHugo.title);
  assert.equal(titleRow.source, realLanguages['zh.title'] === undefined ? 'site' : 'language');

  // Options come from the theme, not from this editor.
  assert.deepEqual(described.theme.widgetTypes, ['archives', 'categories', 'search', 'tag-cloud', 'taxonomy', 'toc']);
  assert.ok(described.theme.icons.includes('brand-github'), 'the theme\'s own icon names are listed');
  assert.equal(described.settings['menu.social'].entries.every((entry) => entry.iconKnown), true);
  assert.deepEqual(described.settings['menu.social'].iconOptions, described.theme.icons);
  assert.ok(described.theme.commentProviders.includes('disqus'));
  assert.ok(described.settings['params.comments.provider'].options.some((option) => option.value === 'giscus'));
  assert.ok(described.settings['hugo.defaultContentLanguage'].options.some((option) => option.value === 'ja'));

  // Unmanaged keys are reported, so "not supported yet" is never the same as "invisible".
  const unmanaged = described.unmanaged['params.toml'].map((leaf) => leaf.path);
  assert.ok(unmanaged.includes('mainSections'));
  assert.ok(unmanaged.includes('cookies.categories.analytics'));
  assert.ok(described.unmanaged['related.toml'].some((leaf) => leaf.path === 'indices'));
});

test('a preview of a scalar change shows the file, the diff and the change list', () => {
  withTempSite(({ service, read }) => {
    const current = readToml(read('params.toml')).values['footer.since'];
    const next = current + 1;
    const preview = service.preview({ set: { 'params.footer.since': next } });
    assert.equal(preview.status, 'preview');
    assert.deepEqual(preview.changedFiles, ['params.toml']);
    const file = preview.files.find((item) => item.file === 'params.toml');
    assert.equal(file.status, 'changed');
    assert.deepEqual(file.diff, { added: 1, removed: 1 });
    assert.match(file.diffText, new RegExp(`-\\s+since = ${current}`));
    assert.match(file.diffText, new RegExp(`\\+\\s+since = ${next}`));

    const change = preview.changes.find((item) => item.id === 'params.footer.since');
    assert.equal(change.from, current);
    assert.equal(change.to, next);
    assert.equal(change.status, 'update');
    assert.equal(change.label, '页脚起始年份');

    // A dry run writes nothing at all.
    assert.equal(read('params.toml').includes(`since = ${next}`), false);
    assert.equal(existsSync(join('/tmp', 'nothing-here')), false);
  });
});

test('saving a scalar writes the file, keeps a backup and leaves the other files alone', () => {
  withTempSite(({ service, read, backupRoot, configRoot }) => {
    const before = Object.fromEntries(CONFIG_FILES.map((file) => [file, read(file)]));
    const current = readToml(before['params.toml']).values['footer.since'];
    const next = current + 1;
    const result = service.save({ set: { 'params.footer.since': next } });

    assert.equal(result.status, 'written');
    assert.deepEqual(result.touched, ['params.toml']);
    const written = result.files.find((item) => item.file === 'params.toml');
    assert.equal(written.status, 'written');
    assert.ok(written.backupPath && existsSync(written.backupPath));
    assert.equal(readFileSync(written.backupPath, 'utf8'), before['params.toml']);

    // Readback: the value is what was asked for, and the rest of the file is untouched.
    const after = read('params.toml');
    assert.equal(readToml(after).values['footer.since'], next);
    assert.equal(after.replace(`    since = ${next}`, `    since = ${current}`), before['params.toml']);
    for (const file of CONFIG_FILES.filter((name) => name !== 'params.toml')) {
      assert.equal(read(file), before[file], `${file} must not be touched`);
    }
    assert.equal(readdirSync(configRoot).length, CONFIG_FILES.length);
  });
});

test('a no-op save writes nothing, not even a backup', () => {
  withTempSite(({ service, read, backupRoot }) => {
    const before = read('params.toml');
    // The values the file already holds: saving them back must be a true no-op.
    const current = readToml(before).values;
    const result = service.save({
      set: { 'params.footer.since': current['footer.since'], 'params.sidebar.emoji': current['sidebar.emoji'] },
    });

    assert.equal(result.status, 'noop');
    assert.deepEqual(result.files, []);
    assert.equal(result.changes.every((change) => change.status === 'noop'), true);
    assert.equal(read('params.toml'), before);
    assert.equal(existsSync(backupRoot), false);
    assert.match(result.message, /没有写入/);
  });
});

test('one save can change several files, including a language override', () => {
  withTempSite(({ service, read }) => {
    const languagesBefore = readToml(read('languages.toml')).values;
    const beforeEn = languagesBefore['en.params.sidebar.subtitle'];
    const result = service.save({
      set: {
        'params.sidebar.subtitle': '站点默认副标题',
        'params.sidebar.subtitle@en': 'English override',
      },
    });

    assert.equal(result.status, 'written');
    assert.deepEqual([...result.touched].sort(), ['languages.toml', 'params.toml']);

    const params = readToml(read('params.toml')).values;
    const languages = readToml(read('languages.toml')).values;
    assert.equal(params['sidebar.subtitle'], '站点默认副标题');
    assert.equal(languages['en.params.sidebar.subtitle'], 'English override');
    // Only English was overridden: the other languages keep whatever they had.
    for (const code of ['zh', 'zh-hant-tw', 'ja']) {
      assert.equal(languages[`${code}.params.sidebar.subtitle`], languagesBefore[`${code}.params.sidebar.subtitle`]);
    }
    assert.notEqual(languages['en.params.sidebar.subtitle'], beforeEn);

    // The site default is in params.toml, and the file keeps its comment about cookies.
    assert.ok(read('params.toml').includes('# GDPR Cookie Consent Configuration'));
  });
});

test('a setting that only the theme declares is created as a site override', () => {
  withTempSite(({ service, read }) => {
    // Which settings are still theme-only is a property of the site's own config, so one is
    // picked from the live list rather than named here.
    const candidate = Object.entries(service.list().settings).find(
      ([, setting]) =>
        setting.file === 'params.toml' &&
        setting.kind === 'value' &&
        setting.source === 'theme' &&
        setting.present === false &&
        typeof setting.value === 'string' &&
        Array.isArray(setting.options) &&
        setting.options.length > 0,
    );
    assert.ok(candidate, 'the theme still declares a params.toml setting this site has not set');
    const [id, setting] = candidate;
    const next = setting.options.find((option) => option.value !== setting.value)?.value;
    assert.ok(next !== undefined, 'the picked setting offers another value');
    const path = id.replace(/^params\./, '');

    const before = read('params.toml');
    assert.equal(readToml(before).values[path], undefined, `${id} is not in the site config yet`);

    const result = service.save({ set: { [id]: next } });
    assert.equal(result.status, 'written');

    const after = read('params.toml');
    const valuesAfter = readToml(after).values;
    assert.equal(valuesAfter[path], next);
    // The key was added where it belongs and nothing else moved: every value the file had is
    // still there, with the same value.
    for (const [key, value] of Object.entries(readToml(before).values)) {
      assert.deepEqual(valuesAfter[key], value, `${key} must not move`);
    }

    // And the descriptor now reports it as a site value, not a theme one.
    const written = service.list().settings[id];
    assert.equal(written.source, 'site');
    assert.equal(written.present, true);
    assert.deepEqual(written.warnings, []);
  });
});

test('the widget list can be edited in place, in the file\'s own style', () => {
  withTempSite(({ service, read }) => {
    const result = service.save({
      set: {
        'params.widgets.homepage': [
          { type: 'archives', params: { limit: 3 } },
          { type: 'tag-cloud', params: { limit: 10 } },
        ],
      },
    });
    assert.equal(result.status, 'written');

    const after = read('params.toml');
    assert.deepEqual(readToml(after).values['widgets.homepage'], [
      { type: 'archives', params: { limit: 3 } },
      { type: 'tag-cloud', params: { limit: 10 } },
    ]);
    assert.ok(after.includes('    homepage = [\n        { type = "archives", params = { limit = 3 } },\n'), 'same one-per-line style');
    assert.ok(after.includes('    page     = [{ type = "toc" }]'), 'the sibling list is untouched');
  });
});

test('menu entries can be edited, added and removed', () => {
  withTempSite(({ service, read }) => {
    const edited = service.save({ set: { 'menu.social[1].name': 'Twitter / X', 'menu.social[1].params.newTab': true } });
    assert.equal(edited.status, 'written');
    let values = readToml(read('menu.toml')).values;
    assert.equal(values['social[1].name'], 'Twitter / X');
    assert.equal(values['social[1].params.newTab'], true);
    assert.equal(values['social[0].name'], 'GitHub', 'the other entry is untouched');

    const added = service.save({
      menu: {
        add: [{ identifier: 'mastodon', name: 'Mastodon', url: 'https://mastodon.social/@x', 'params.icon': 'link' }],
      },
    });
    assert.equal(added.status, 'written');
    values = readToml(read('menu.toml')).values;
    assert.equal(values['social[2].identifier'], 'mastodon');
    assert.equal(values['social[2].params.icon'], 'link');
    assert.equal(values['social[2].name'], 'Mastodon');

    const removed = service.save({ menu: { remove: [0] } });
    assert.equal(removed.status, 'written');
    const menu = readToml(read('menu.toml'));
    assert.deepEqual(menu.arrays, ['social']);
    assert.equal(menu.values['social[0].identifier'], 'twitter');
    assert.equal(menu.values['social[1].identifier'], 'mastodon');
    assert.equal(menu.values['social[0].params.icon'], 'brand-twitter');
  });
});

test('language rows can be edited', () => {
  withTempSite(({ service, read }) => {
    const result = service.save({
      set: {
        'languages.list.en.weight': 5,
        'languages.list.en.label': 'English (US)',
        'languages.list.ja.title': 'Hugo テーマ Stack',
      },
    });
    assert.equal(result.status, 'written');
    const values = readToml(read('languages.toml')).values;
    assert.equal(values['en.weight'], 5);
    assert.equal(values['en.label'], 'English (US)');
    assert.equal(values['ja.title'], 'Hugo テーマ Stack');
    // The order in the file did not change: `en` keeps its place.
    const text = read('languages.toml');
    assert.ok(text.indexOf('[en]') < text.indexOf('[zh]'));
  });
});

test('validation refuses what would break the site, before any file is touched', () => {
  withTempSite(({ service, read }) => {
    const before = read('params.toml');
    const cases = [
      [{ 'params.comments.provider': 'facebook' }, /只能是/],
      [{ 'params.footer.since': 1900 }, /不能小于/],
      [{ 'params.footer.since': 'soon' }, /需要一个数字/],
      [{ 'hugo.hasCJKLanguage': 'yes' }, /需要 true\/false/],
      [{ 'params.widgets.homepage': [{ type: 'nonexistent' }] }, /主题没有 widget/],
      [{ 'params.widgets.homepage': [{ type: 'archives', params: { limit: 0 } }] }, /limit/],
      [{ 'params.widgets.homepage': 'archives' }, /需要组件列表/],
      [{ 'nope.nope': 1 }, /未知的设置项/],
      [{ 'hugo.baseURL': 'x'.repeat(3000) }, /文本过长/],
      // A social icon the theme cannot resolve is a build failure, so it is refused here.
      [{ 'menu.social[0].params.icon': 'brand-mastodon' }, /主题里没有图标/],
      [{ 'languages.list.en.label': '' }, /不能为空/],
    ];
    for (const [set, pattern] of cases) {
      assert.throws(() => service.save({ set }), (error) => {
        assert.ok(error instanceof SettingsValidationError, `${JSON.stringify(set)} threw ${error.name}`);
        assert.match(error.message, pattern);
        return true;
      });
    }
    assert.throws(() => service.save({ menu: { remove: [9] } }), /没有第 10 条/);
    assert.throws(() => service.save({ menu: { add: [{ name: 'x', url: 'y' }] } }), /标识 不能为空/);
    assert.throws(
      () => service.save({ menu: { add: [{ identifier: 'z', name: 'Z', url: 'u', 'params.icon': 'brand-mastodon' }] } }),
      /主题里没有图标/,
    );

    // Nothing was written by any of the refusals.
    assert.equal(read('params.toml'), before);
  });
});

test('a multi-file save is all-or-nothing: a failed write rolls the others back', () => {
  const site = tempSite();
  try {
    const before = Object.fromEntries(CONFIG_FILES.map((file) => [file, site.read(file)]));
    let writes = 0;

    // The one failure that cannot be produced on a healthy filesystem is a write that fails
    // *after* another file was already written, so `writeFile` is the seam for it: it is the
    // real SafeWriter, and only the second call fails.
    const failing = createSettingsService({
      siteRoot: site.root,
      configRoot: site.configRoot,
      backupRoot: site.backupRoot,
      themeInfo,
      writeFile: (options) => {
        writes += 1;
        if (writes === 2) throw new Error('simulated disk failure');
        return saveSafely(options);
      },
    });

    const current = readToml(site.read('params.toml')).values['footer.since'];
    assert.throws(
      // Both edits must really write: the second write is the one made to fail.
      () => failing.save({ set: { 'params.footer.since': current + 1, 'hugo.title': 'Changed' } }),
      (error) => {
        assert.match(error.message, /保存失败/);
        assert.match(error.message, /已回滚/);
        return true;
      },
    );
    assert.equal(writes, 2);

    // Every file is back to the bytes it had before the save, backups included.
    for (const file of CONFIG_FILES) {
      assert.equal(site.read(file), before[file], `${file} must be back to its original content`);
    }
  } finally {
    site.cleanup();
  }
});

test('the guard refuses anything outside a single existing .toml file', () => {
  const guard = configGuardFor(SITE_ROOT);
  assert.deepEqual(guard.listFiles(), CONFIG_FILES);
  assert.equal(guard.isWritable('params.toml'), true);
  assert.throws(() => guard.resolveForWrite('../hugo.toml'), /only a single .toml/);
  assert.throws(() => guard.resolveForWrite('/etc/passwd'), /absolute config path/);
  assert.throws(() => guard.resolveForWrite('nested/params.toml'), /only a single .toml/);
  assert.throws(() => guard.resolveForWrite('new.toml'), /not found/);
  assert.throws(() => guard.resolveForWrite('params.yaml'), /only a single .toml/);
  assert.throws(() => guard.resolveForRead('nope.toml'), /not found/);
  assert.equal(guard.toRelative(join(guard.configRoot, 'menu.toml')), 'menu.toml');
  assert.ok(new ConfigGuard({ configRoot: REAL_CONFIG }).configRoot.endsWith('config/_default'));
});

test('the raw view reads a file and never lets a path escape', () => {
  const service = createSettingsService({
    siteRoot: SITE_ROOT,
    configRoot: REAL_CONFIG,
    backupRoot: join(tmpdir(), 'unused-backups'),
    themeInfo,
  });
  const raw = service.raw('params.toml');
  assert.equal(raw.text, readFileSync(join(REAL_CONFIG, 'params.toml'), 'utf8'));
  assert.equal(raw.sha256.length, 64);
  assert.ok(raw.tables.includes('sidebar'));
  assert.throws(() => service.raw('../../../etc/passwd'), SettingsValidationError);
  assert.throws(() => service.raw('params.yaml'), SettingsValidationError);
  // A name that is fine but a file that is not there is a missing file, not a bad request.
  assert.throws(() => service.raw('missing.toml'), ConfigFileNotFoundError);
});

test('writes are typed: a number stays a number and a string stays quoted', () => {
  withTempSite(({ service, read }) => {
    service.save({ set: { 'hugo.pagination.pagerSize': 5, 'hugo.baseURL': 'https://example.com/' } });
    const text = read('hugo.toml');
    assert.ok(text.includes('    pagerSize = 5'));
    assert.ok(text.includes('baseURL                = "https://example.com/"'), 'alignment and quoting survive');
    const values = readToml(text).values;
    assert.equal(values['pagination.pagerSize'], 5);
    assert.equal(values.baseURL, 'https://example.com/');
    // The theme line is untouched.
    assert.ok(text.includes('theme = "hugo-theme-stack"'));
  });
});
