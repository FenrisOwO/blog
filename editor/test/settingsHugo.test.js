// Phase 5 acceptance, in one file: change settings, rebuild with real Hugo, and check the
// published site actually changed - the only proof that a settings edit means anything.
//
// This runs against a temporary copy of the whole site, so it can apply real changes (a new
// social link, a dropped widget, a language override, a theme default being overridden) and
// then assert the rendered HTML. The real site is only ever read here; acceptance T13/T14 do
// the same thing against the real site and restore it afterwards.

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createBuildService } from '../src/build/buildService.js';
import { createSettingsService } from '../src/settings/settingsService.js';
import { readToml } from '../src/settings/toml/index.js';

const SITE_ROOT = '/projects/site';
const CONFIG_FILES = ['hugo.toml', 'languages.toml', 'markup.toml', 'menu.toml', 'params.toml', 'related.toml'];

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

test('a settings change survives a real Hugo build into the public output', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hve-settings-hugo-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const siteRoot = join(root, 'site');
  cpSync(SITE_ROOT, siteRoot, {
    recursive: true,
    filter: (source) => !/(\/public|\/resources|\/\.hugo_build\.lock)$/.test(source),
  });

  const configRoot = join(siteRoot, 'config', '_default');
  const backupRoot = join(root, 'backups');
  const buildService = createBuildService({
    siteRoot,
    stagingDir: join(root, 'staging'),
    cacheDir: join(root, 'cache'),
    publishDir: join(root, 'public'),
    publishRoot: root,
    timeoutMs: 180_000,
  });
  const settings = createSettingsService({ siteRoot, configRoot, backupRoot });

  const readPublic = (relPath) => readFileSync(join(root, 'public', relPath), 'utf8');
  const describe = () => settings.list();

  // What the site renders is derived the way Hugo derives it - language override, then the
  // site's own value, then the theme's default - instead of being hardcoded: this config
  // belongs to the user, and a test pinned to the shipped defaults would fail the moment
  // anyone used the settings screen.
  const configOf = (file) => readToml(readFileSync(join(configRoot, file), 'utf8')).values;
  const paramsConfig = configOf('params.toml');
  const languageConfig = configOf('languages.toml');
  const hugoConfig = configOf('hugo.toml');
  const themeConfig = readToml(
    readFileSync(join(siteRoot, 'themes', 'hugo-theme-stack', 'config', '_default', 'params.toml'), 'utf8'),
  ).values;
  const at = (path, fallback) => (paramsConfig[path] === undefined ? fallback : paramsConfig[path]);
  const escape = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Hugo writes values through Go's HTML escaper: `Fenris's Blog` renders as `Fenris&#39;s Blog`.
  const escapeHtml = (value) =>
    String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&#34;')
      .replace(/'/g, '&#39;');

  const zhSubtitle = at('sidebar.subtitle', '') || languageConfig['zh.params.sidebar.subtitle'];
  const zhTitle = languageConfig['zh.title'] ?? hugoConfig.title;
  const jaTitle = languageConfig['ja.title'] ?? hugoConfig.title;
  const enTitle = languageConfig['en.title'] ?? hugoConfig.title;
  const colorSchemeBefore = at('colorScheme.default', themeConfig['colorScheme.default']);
  const sinceBefore = paramsConfig['footer.since'];
  const firstSocialUrl = configOf('menu.toml')['social[0].url'];

  // -- before ---------------------------------------------------------------
  const first = await buildService.build({ trigger: 'manual' });
  assert.equal(first.state, 'success', first.message);

  // The site default, the language override and the theme default are all visible in the HTML
  // that Hugo produced.
  assert.match(readPublic('index.html'), new RegExp(`<h2 class="site-description">${escape(zhSubtitle)}</h2>`));
  assert.match(
    readPublic('index.html'),
    new RegExp(`localStorage\\.setItem\\(colorSchemeKey, "${escape(colorSchemeBefore)}"\\)`),
    'the effective color scheme',
  );
  assert.match(readPublic('index.html'), new RegExp(`${sinceBefore} -`), 'footer since');
  assert.match(readPublic('index.html'), /class="search-form widget"/, 'homepage search widget');
  assert.match(readPublic('index.html'), new RegExp(`<ol class="menu-social">[\\s\\S]*${escape(firstSocialUrl)}`));
  assert.doesNotMatch(readPublic('index.html'), /mastodon\.social/);
  assert.match(readPublic('p/image-gallery/index.html'), /lntable/, 'code line numbers');
  assert.match(readPublic('index.html'), new RegExp(`<title>${escape(escapeHtml(zhTitle))}`));
  assert.match(readPublic('en/index.html'), new RegExp(`<title>${escape(escapeHtml(enTitle))}`));

  const beforeParams = readFileSync(join(configRoot, 'params.toml'), 'utf8');
  const beforeRelated = readFileSync(join(configRoot, 'related.toml'), 'utf8');
  const beforeContent = readFileSync(join(siteRoot, 'content', 'post', 'Image Gallery', 'index.md'), 'utf8');
  assert.equal(
    describe().settings['params.colorScheme.default'].source,
    paramsConfig['colorScheme.default'] === undefined ? 'theme' : 'site',
  );

  // -- change ---------------------------------------------------------------
  const saved = settings.save({
    set: {
      'params.colorScheme.default': 'dark',
      'params.footer.since': 2015,
      'markup.highlight.lineNos': false,
      'params.widgets.homepage': [
        { type: 'archives', params: { limit: 5 } },
        { type: 'categories', params: { limit: 10 } },
        { type: 'tag-cloud', params: { limit: 10 } },
      ],
      // Every language in this site overrides the title, so the site value alone changes no
      // page: the per-language override is what the rendered <title> follows.
      'hugo.title': 'Changed Site Title',
      'hugo.title@en': 'Changed EN Title',
      'params.sidebar.subtitle@ja': 'こんにちは、世界',
    },
    menu: {
      add: [
        {
          identifier: 'mastodon',
          name: 'Mastodon',
          url: 'https://mastodon.social/@x',
          'params.icon': 'link',
          'params.newTab': true,
        },
      ],
    },
  });
  assert.equal(saved.status, 'written');
  assert.deepEqual([...saved.touched].sort(), ['hugo.toml', 'languages.toml', 'markup.toml', 'menu.toml', 'params.toml']);
  assert.equal(describe().settings['params.colorScheme.default'].source, 'site');
  assert.equal(describe().settings['params.colorScheme.default'].value, 'dark');

  // The files that were not edited are byte-identical, and the edited ones keep their comments.
  assert.equal(readFileSync(join(configRoot, 'related.toml'), 'utf8'), beforeRelated);
  assert.equal(sha(readFileSync(join(configRoot, 'params.toml'), 'utf8')) === sha(beforeParams), false);
  assert.match(readFileSync(join(configRoot, 'params.toml'), 'utf8'), /# GDPR Cookie Consent Configuration/);
  assert.equal(readFileSync(join(siteRoot, 'content', 'post', 'Image Gallery', 'index.md'), 'utf8'), beforeContent);

  // -- after ----------------------------------------------------------------
  const second = await buildService.build({ trigger: 'manual' });
  assert.equal(second.state, 'success', second.message);
  assert.equal(second.published.files > 100, true);

  const index = readPublic('index.html');
  assert.match(index, /localStorage\.setItem\(colorSchemeKey, "dark"\)/, 'the theme default was overridden');
  assert.match(index, /2015 -/, 'footer since');
  assert.doesNotMatch(index, /class="search-form widget"/, 'the search widget was removed');
  assert.match(index, /class="widget archives"/, 'the archives widget is still there');
  assert.match(index, /<ol class="menu-social">[\s\S]*href='https:\/\/mastodon\.social\/@x'[\s\S]*?target="_blank"/, 'the new social link');
  assert.match(index, new RegExp(`<h2 class="site-description">${escape(zhSubtitle)}</h2>`), 'the zh override still wins');
  assert.match(index, new RegExp(`<title>${escape(escapeHtml(zhTitle))}`), 'the zh title override still wins over hugo.title');

  assert.match(readPublic('en/index.html'), /<title>Changed EN Title/, 'the en override wins');
  assert.match(
    readPublic('ja/index.html'),
    new RegExp(`<title>${escape(escapeHtml(jaTitle))}`),
    'ja keeps its own override: the en edit does not leak',
  );
  assert.equal(describe().settings['hugo.title'].value, 'Changed Site Title');
  assert.equal(describe().settings['hugo.title'].languageRows.find((row) => row.code === 'en').value, 'Changed EN Title');
  assert.match(readPublic('ja/index.html'), /<h2 class="site-description">こんにちは、世界<\/h2>/, 'the ja override');
  assert.doesNotMatch(readPublic('p/image-gallery/index.html'), /lntable/, 'line numbers are off now');
  assert.equal(existsSync(join(root, 'public', 'p', 'image-gallery', 'index.html')), true);
});
