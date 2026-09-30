// The settings form's own rule: what counts as "the user changed something", and what the
// payload it produces does when it reaches the real service.
//
// The descriptor comes from the real settings endpoint (the real config files), and the
// payload goes straight into the real service - so this checks the form against the code it
// actually talks to, the way `fieldForm.test.js` does for front matter.

import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { readThemeInfo } from '../src/settings/themeInfo.js';
import { createSettingsService } from '../src/settings/settingsService.js';
import { readToml } from '../src/settings/toml/index.js';
import { addWidget, editCount, editsFromDrafts, initialDrafts, removeWidget, setWidgetLimit, sourceLabel, valueText } from '../web/settingsDrafts.js';

const SITE_ROOT = '/projects/site';
const REAL_CONFIG = join(SITE_ROOT, 'config', '_default');
const CONFIG_FILES = ['hugo.toml', 'languages.toml', 'markup.toml', 'menu.toml', 'params.toml', 'related.toml'];

const themeInfo = readThemeInfo({ siteRoot: SITE_ROOT, site: { servicesDisqusShortname: 'hugo-theme-stack' } });

function tempSite() {
  const root = mkdtempSync(join(tmpdir(), 'hve-settings-form-'));
  const configRoot = join(root, 'config', '_default');
  cpSync(REAL_CONFIG, configRoot, { recursive: true });
  return {
    root,
    configRoot,
    service: createSettingsService({ siteRoot: root, configRoot, backupRoot: join(root, 'backups'), themeInfo }),
    read: (file) => readFileSync(join(configRoot, file), 'utf8'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('opening the form and changing nothing produces no edits at all', () => {
  const site = tempSite();
  try {
    const described = site.service.list();
    const state = initialDrafts(described);
    const edits = editsFromDrafts(described, state);

    // A form that just displays theme defaults must not write them down.
    assert.deepEqual(edits.set, {}, 'nothing is sent before the user types');
    assert.deepEqual(edits.menu, { add: [], remove: [] });
    assert.equal(editCount(edits), 0);

    const preview = site.service.preview(edits);
    assert.equal(preview.status, 'noop');
    assert.deepEqual(preview.changedFiles, []);
    assert.deepEqual(preview.warnings, []);
  } finally {
    site.cleanup();
  }
});

test('editing the visible values produces exactly the payload the service writes', () => {
  const site = tempSite();
  try {
    const described = site.service.list();
    const state = initialDrafts(described);
    const before = Object.fromEntries(CONFIG_FILES.map((file) => [file, site.read(file)]));

    state.drafts['params.footer.since'] = '2011';
    state.drafts['params.comments.enabled'] = false;
    state.drafts['params.colorScheme.default'] = 'dark';
    state.drafts['params.sidebar.subtitle'] = '新的副标题';
    state.drafts['params.sidebar.subtitle@ja'] = '日本語の副題';
    state.drafts['markup.highlight.lineNos'] = false;
    state.drafts['menu.social[0].name'] = 'GitHub (main)';
    state.drafts['languages.list.zh.label'] = '简体中文（大陆）';
    state.menu.add.push({ identifier: 'rss', name: 'RSS', url: 'https://example.com/index.xml', icon: 'rss', newTab: false });
    state.menu.remove.push(1);

    const edits = editsFromDrafts(described, state);
    assert.equal(editCount(edits), 10);
    assert.deepEqual(edits.menu.add, [{ identifier: 'rss', name: 'RSS', url: 'https://example.com/index.xml', 'params.icon': 'rss' }]);
    assert.deepEqual(edits.menu.remove, [1]);

    const preview = site.service.preview(edits);
    assert.equal(preview.status, 'preview');
    assert.deepEqual([...preview.changedFiles].sort(), ['languages.toml', 'markup.toml', 'menu.toml', 'params.toml']);
    assert.equal(preview.files.every((file) => file.status === 'noop' || file.diffText.length > 0), true);

    const saved = site.service.save(edits);
    assert.equal(saved.status, 'written');

    const params = readToml(site.read('params.toml')).values;
    assert.equal(params['footer.since'], 2011);
    assert.equal(params['comments.enabled'], false);
    assert.equal(params['colorScheme.default'], 'dark');
    assert.equal(params['sidebar.subtitle'], '新的副标题');
    assert.equal(readToml(site.read('languages.toml')).values['ja.params.sidebar.subtitle'], '日本語の副題');
    assert.equal(readToml(site.read('markup.toml')).values['highlight.lineNos'], false);
    assert.equal(readToml(site.read('menu.toml')).values['social[0].name'], 'GitHub (main)');
    assert.equal(readToml(site.read('languages.toml')).values['zh.label'], '简体中文（大陆）');
    assert.equal(readToml(site.read('menu.toml')).values['social[1].identifier'], 'rss');
    // related.toml was not part of the edit, so it is byte-identical.
    assert.equal(site.read('related.toml'), before['related.toml']);

    // And the form, loaded again, shows the new values as the site's own.
    const after = site.service.list();
    assert.equal(after.settings['params.footer.since'].value, 2011);
    assert.equal(after.settings['params.colorScheme.default'].source, 'site');
    assert.deepEqual(after.settings['menu.social'].entries.map((entry) => entry.identifier), ['github', 'rss']);
  } finally {
    site.cleanup();
  }
});

test('the widget editor produces a widget list the service accepts', () => {
  const site = tempSite();
  try {
    const described = site.service.list();
    const state = initialDrafts(described);
    const row = described.settings['params.widgets.homepage'];

    let list = state.widgets['params.widgets.homepage'];
    assert.deepEqual(list.map((widget) => widget.type), ['search', 'archives', 'categories', 'tag-cloud']);
    list = removeWidget(list, 0);
    list = setWidgetLimit(list, 0, '2');
    list = addWidget(list, 'toc');
    state.widgets['params.widgets.homepage'] = list;

    const edits = editsFromDrafts(described, state);
    assert.deepEqual(edits.set['params.widgets.homepage'], [
      { type: 'archives', params: { limit: 2 } },
      { type: 'categories', params: { limit: 10 } },
      { type: 'tag-cloud', params: { limit: 10 } },
      { type: 'toc' },
    ]);

    assert.equal(site.service.save(edits).status, 'written');
    assert.deepEqual(readToml(site.read('params.toml')).values['widgets.homepage'], edits.set['params.widgets.homepage']);
    // The sibling list keeps its own value.
    assert.deepEqual(readToml(site.read('params.toml')).values['widgets.page'], [{ type: 'toc' }]);
    assert.deepEqual(row.values.map((widget) => widget.type), ['search', 'archives', 'categories', 'tag-cloud']);
  } finally {
    site.cleanup();
  }
});

test('a language override that is cleared is not written as an empty value', () => {
  const site = tempSite();
  try {
    const described = site.service.list();
    const state = initialDrafts(described);
    state.drafts['params.sidebar.subtitle@en'] = '';
    state.drafts['params.sidebar.subtitle@zh-hant-tw'] = '  ';

    const edits = editsFromDrafts(described, state);
    // An empty box means "leave the language layer alone": deleting an override is not part
    // of Phase 5, and writing "" would blank the sidebar.
    assert.equal(edits.set['params.sidebar.subtitle@en'], undefined);
    assert.equal(edits.set['params.sidebar.subtitle@zh-hant-tw'], undefined);
    assert.equal(editCount(edits), 0);
  } finally {
    site.cleanup();
  }
});

test('the form refuses nothing the service refuses, and the labels match the payload', () => {
  const site = tempSite();
  try {
    const described = site.service.list();
    const state = initialDrafts(described);

    assert.equal(sourceLabel('theme'), '主题默认');
    assert.equal(sourceLabel('site'), '本站配置');
    assert.equal(valueText(true), '是');
    assert.equal(valueText(['a', 'b']), 'a, b');
    assert.equal(valueText([{ type: 'search' }]), 'search');
    assert.equal(valueText(null), '（未设置）');

    // A number the form allows to be typed is refused by the service if it is out of range,
    // and the message names the setting.
    state.drafts['params.footer.since'] = '1800';
    const edits = editsFromDrafts(described, state);
    assert.equal(edits.set['params.footer.since'], 1800);
    assert.throws(() => site.service.preview(edits), /不能小于 1970/);
  } finally {
    site.cleanup();
  }
});
