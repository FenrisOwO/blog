// The tests own their data: this is the only module that knows where the fixture site lives,
// what its documents are called, and how a test gets a writable copy of it.
//
// Nothing here reads the user's own site. The two exceptions are deliberate and named as such:
// `REAL_SITE` is for the few tests whose subject *is* the real site (see the fixture README),
// and `INSTALLED_THEME` is the theme - a dependency, not content the editor writes.
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FIXTURE_SITE = join(import.meta.dirname, 'site');
export const FIXTURE_CONTENT = join(FIXTURE_SITE, 'content');

export const REAL_SITE = '/projects/site';
export const REAL_CONTENT = join(REAL_SITE, 'content');
export const INSTALLED_THEME = join(REAL_SITE, 'themes', 'hugo-theme-stack');

// The fixture's document paths, named once. A test that needs "an article" asks for
// `FIXTURE.article`; it never reaches into whatever the user happens to have written today.
export const FIXTURE = {
  home: '_index.md',
  article: 'post/fixture-article.en.md',
  articleZh: 'post/fixture-article.md',
  second: 'post/fixture-second.en.md',
  secondZh: 'post/fixture-second.md',
  draft: 'post/fixture-draft.md',
  markdown: 'post/fixture-markdown/index.en.md',
  markdownZh: 'post/fixture-markdown/index.md',
  bundle: 'post/fixture-bundle/index.md',
  bundleEn: 'post/fixture-bundle/index.en.md',
  bundleResource: 'post/fixture-bundle/fixture-photo.jpg',
  bundleLooseResource: 'post/fixture-bundle/fixture-extra.png',
  page: 'page/about/index.md',
  pageEn: 'page/about/index.en.md',
  links: 'page/links/index.md',
  linksResource: 'page/links/fixture-logo.jpg',
  category: 'categories/fixture-category/_index.md',
  categoryEn: 'categories/fixture-category/_index.en.md',
  categoryResource: 'categories/fixture-category/fixture-banner.png',
  tagPage: 'tags/fixture-tag/_index.md',
  other: 'misc/fixture-note.md',
  staticLogo: 'static/img/logo.png',
  siteAsset: 'assets/scss/custom.scss',
};

// The sections a fixture-based test treats as writable, mirroring what the editor is configured
// with in production (`''` is the content root, which is where the home page lives).
export const FIXTURE_SECTIONS = ['post', 'page', 'categories', ''];

// A copy of the fixture site in a temp directory. Tests mutate the copy and never the fixture,
// so a failing test cannot leave the corpus in a different shape for the next one.
export function makeFixtureSandbox(t, { prefix = 'hve-fixture-', theme = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const siteRoot = join(root, 'site');
  for (const tree of ['config', 'content', 'static', 'assets']) {
    cpSync(join(FIXTURE_SITE, tree), join(siteRoot, tree), { recursive: true });
  }
  if (theme) cpSync(INSTALLED_THEME, join(siteRoot, 'themes', 'hugo-theme-stack'), { recursive: true });
  // The backup root is *not* created here: "a no-op save writes nothing and creates no backup"
  // is a contract, and it is checked by the directory not existing.
  const backupRoot = join(root, 'backups');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    siteRoot,
    contentRoot: join(siteRoot, 'content'),
    configRoot: join(siteRoot, 'config', '_default'),
    backupRoot,
  };
}
