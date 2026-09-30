// Insert B regression: the Phase 8 shell must mount the article selector.
//
// The shell rewrite rebuilt the content view as rail + workspace + inspector, and in doing so it
// dropped the mount point for the article selector: DocumentList stayed imported, the
// `visibleDocuments` computed that feeds it stayed defined, and the topbar search kept filtering
// - but nothing rendered the list. A document could then only be reached through the command
// palette, which is not the flow the view is built around.
//
// Nothing caught it, because no test looked at the shell as a whole: the component was never
// deleted, so every test that imported it or the services behind it still passed. These tests
// look at the shell as a whole - what it declares versus what it renders - and then walk the
// selection flow against the real content tree.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createEditorServer } from '../server/index.js';

const ROOT = join(import.meta.dirname, '..');
const SITE_ROOT = '/projects/site';
const CONTENT_ROOT = join(SITE_ROOT, 'content');

const appSource = readFileSync(join(ROOT, 'web', 'App.vue'), 'utf8');
const baseCss = readFileSync(join(ROOT, 'web', 'styles', 'base.css'), 'utf8');
const tokensCss = readFileSync(join(ROOT, 'web', 'styles', 'tokens.css'), 'utf8');

// The SFC root template, isolated by its line-anchored tags: the nested `v-if` templates are
// indented, so they cannot be confused with it.
function rootTemplate(source) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line === '<template>');
  const end = lines.findLastIndex((line) => line === '</template>');
  assert.ok(start > -1 && end > start, 'App.vue has one root <template>');
  return lines.slice(start, end + 1).join('\n');
}

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start > -1, `expected to find: ${startMarker}`);
  // Search for the end *after* the start: the shell has nested headers and panes, so the first
  // match in the whole string is not necessarily the one that closes this region.
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `expected markers in order: ${startMarker}`);
  return source.slice(start, end);
}

const template = rootTemplate(appSource);
const script = appSource.slice(0, appSource.indexOf('<template>'));
const contentView = between(
  template,
  '<!-- ============================ content ============================ -->',
  '<!-- ============================ other views ============================ -->',
);
const selectorPane = between(contentView, '<aside v-if="listOpen" class="browser"', '</aside>');
const workspaceHead = between(contentView, '<header class="workspace-head">', '</header>');

test('the Phase 8 shell renders the article selector inside the content view', () => {
  assert.match(contentView, /<DocumentList/, 'the article selector is not mounted in the content view');
  assert.match(selectorPane, /aria-label="文章选择"/, 'the selector entry point is not labelled');
  assert.match(selectorPane, /class="browser"/, 'the selector has no pane of its own');

  // The pane is a grid column, so it has to come before the workspace in DOM order.
  const asideEnd = contentView.indexOf('</aside>');
  const listTag = contentView.indexOf('<DocumentList');
  const workspaceStart = contentView.indexOf('<section class="workspace content-view">');
  assert.ok(listTag > contentView.indexOf('<aside') && listTag < asideEnd, 'the selector renders inside its own pane');
  assert.ok(asideEnd < workspaceStart, 'the pane sits before the workspace it feeds');
});

test('the selector is wired to the filtered list and to the document opener', () => {
  // The topbar search filters `visibleDocuments`, so that - not the raw list - is what the
  // selector has to render; wiring it to `documents` would silently ignore the filter.
  assert.match(selectorPane, /:documents="visibleDocuments"/);
  assert.match(selectorPane, /:selected-path="selectedPath"/);
  assert.match(selectorPane, /:loading="loadingDocuments"/);
  assert.match(selectorPane, /:sections="sections"/);
  assert.match(selectorPane, /:groups="groups"/);
  assert.match(selectorPane, /@select="openDocument"/, 'choosing an article must open it');

  // "Open -> choose -> edit": the handler the selector emits into has to load that document's
  // Markdown and make it the current one.
  const openDocument = between(script, 'async function openDocument(doc)', '\n// --- P1/P2: raw text');
  assert.match(openDocument, /\/api\/documents\/raw\?path=/, 'opening must read the article through the API');
  assert.match(openDocument, /selectedPath\.value = doc\.path/, 'the selected article must become the current document');
  assert.match(openDocument, /selectedDoc\.value = doc/);
  assert.match(openDocument, /initialText\.value = data\.text/, 'the editor must receive the article text');
  assert.match(openDocument, /editorKey\.value \+= 1/, 'the editor must remount onto the chosen article');
});

test('the selector is open by default and can always be reached again', () => {
  assert.match(script, /const listOpen = ref\(true\)/, 'the list must be open on first paint, not collapsed by default');

  // A toggle outside the pane itself: when the list is collapsed the pane is gone, so its own
  // "收起" button cannot be the only way back.
  assert.match(workspaceHead, /@click="listOpen = !listOpen"/, 'the workspace needs a toggle for the list');
  assert.match(workspaceHead, /:aria-pressed="listOpen"/);
  assert.ok(
    workspacesToggleIsOutsidePane(contentView),
    'the toggle must stay visible while the list is collapsed',
  );

  // And the same toggle again from the status bar and the command palette.
  assert.match(appSource, /@toggle-list="listOpen = !listOpen"/);
  const commands = readFileSync(join(ROOT, 'web', 'commands.js'), 'utf8');
  assert.match(commands, /make\('toggle-list', 'View'/, 'the palette needs a show/hide command for the list');
});

function workspacesToggleIsOutsidePane(view) {
  const paneEnd = view.indexOf('</aside>');
  const toggle = view.indexOf('@click="listOpen = !listOpen"');
  return paneEnd > -1 && toggle > paneEnd;
}

test('nothing the shell declares for the content view can go orphaned again', () => {
  // This is the root-cause guard. The regression was not a deleted component or a broken
  // endpoint: it was a declaration (`DocumentList`, `visibleDocuments`) that nothing rendered.
  // So: every component the shell imports must appear as a tag, and every computed it defines
  // must be used somewhere other than its own declaration.
  const orphanComponents = [];
  for (const [, name] of appSource.matchAll(/import\s+(\w+)\s+from\s+['"]\.\/components\/[\w.-]+\.vue['"]/g)) {
    if (!template.includes(`<${name}`)) orphanComponents.push(name);
  }
  assert.deepEqual(orphanComponents, [], `imported but never rendered: ${orphanComponents.join(', ')}`);

  const orphanComputeds = [];
  for (const [, name] of appSource.matchAll(/const\s+(\w+)\s*=\s*computed\(/g)) {
    const uses = appSource.split(new RegExp(`\\b${name}\\b`)).length - 1;
    if (uses < 2) orphanComputeds.push(name);
  }
  assert.deepEqual(orphanComputeds, [], `computed but never used: ${orphanComputeds.join(', ')}`);
});

test('the stylesheet gives the selector its own column and never hides it', () => {
  const width = /--browser-w:\s*(\d+(?:\.\d+)?)px/.exec(tokensCss);
  assert.ok(width, 'the selector needs a layout width token');
  assert.ok(Number(width[1]) > 0, 'the selector width must not be zero');

  // A grid column of its own, so the list cannot collapse into the workspace.
  assert.match(baseCss, /\.shell\.with-browser\s*\{[^}]*var\(--browser-w\)/);
  assert.match(baseCss, /\.shell\.with-browser\.with-inspector\s*\{[^}]*var\(--browser-w\)/);
  assert.match(appSource, /'with-browser': view === 'content' && listOpen/);

  // And no rule anywhere in the sheet may hide the pane: `display: none` is exactly the shape of
  // bug that makes a mounted selector unreachable. `min-width: 0` / `min-height: 0` are layout
  // allowances rather than hiding, which is why the pattern excludes them.
  const paneRules = [...baseCss.matchAll(/([^{}]*\.browser(?![-.\w])[^{}]*)\{([^}]*)\}/g)];
  assert.ok(paneRules.length > 0, 'the selector pane has no styles of its own');
  const hides =
    /display:\s*none|visibility:\s*hidden|opacity:\s*0(?![.\d])|clip-path|(?<![-\w])(?:max-)?height:\s*0(?![.\d])|(?<![-\w])(?:max-)?width:\s*0(?![.\d])/;
  for (const [, selector, body] of paneRules) {
    assert.doesNotMatch(body, hides, `the selector is hidden by: ${selector.trim()}`);
  }
  assert.match(paneRules[0][2], /display:\s*flex/, 'the pane lays its list out');

  // Every breakpoint that resizes the column must keep it positive.
  for (const [, value] of baseCss.matchAll(/--browser-w:\s*(\d+(?:\.\d+)?)px/g)) {
    assert.ok(Number(value) > 0, 'responsive rules must not collapse the selector');
  }
});

// --- the flow, against the real content tree --------------------------------

function stubBuildService() {
  return {
    getStatus: () => ({ state: 'idle', activity: 'idle', generation: 0, queued: false, preview: { url: '/', generation: 0 }, lastBuild: null, history: [], config: {} }),
    subscribe: () => () => {},
    scheduleBuild: () => {},
    build: () => Promise.resolve(),
    stop: () => {},
  };
}

async function withServer(run) {
  const server = createEditorServer({
    siteRoot: SITE_ROOT,
    contentRoot: CONTENT_ROOT,
    editorDist: join(ROOT, 'dist'),
    buildService: stubBuildService(),
    watchSources: false,
    buildOnStart: false,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function digest(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

test('open -> choose -> edit walks the real tree without touching a byte', async () => {
  await withServer(async (base) => {
    // What the selector renders is this list.
    const list = await (await fetch(`${base}/api/documents`)).json();
    assert.ok(list.count > 0, 'the selector needs articles to show');

    const article = list.documents.find((doc) => doc.section === 'post' && doc.language === 'zh');
    assert.ok(article, 'the site has a Chinese article to select');
    assert.equal('text' in article, false, 'the list stays light: contents arrive on selection');

    const file = join(CONTENT_ROOT, article.path);
    const before = { sha: digest(file), mtime: statSync(file).mtimeMs };

    // What `openDocument` does with the chosen document.
    const response = await fetch(`${base}/api/documents/raw?path=${encodeURIComponent(article.path)}`);
    assert.equal(response.status, 200);
    const raw = await response.json();
    assert.equal(raw.path, article.path);
    assert.equal(raw.text, readFileSync(file, 'utf8'), 'the editor must receive the article verbatim');
    assert.match(raw.text, /^---\n/, 'an article arrives with its front matter intact');

    const after = { sha: digest(file), mtime: statSync(file).mtimeMs };
    assert.deepEqual(after, before, 'selection is a read: the article must be byte-identical afterwards');
  });
});

test('the selector flow reaches articles in every section the shell lists', async () => {
  await withServer(async (base) => {
    const list = await (await fetch(`${base}/api/documents`)).json();
    const sections = [...new Set(list.documents.map((doc) => doc.section))];
    assert.ok(sections.length > 1, 'the selector groups more than one section');

    for (const document of list.documents) {
      const file = join(CONTENT_ROOT, document.path);
      const before = digest(file);
      const response = await fetch(`${base}/api/documents/raw?path=${encodeURIComponent(document.path)}`);
      assert.equal(response.status, 200, `the selector offers what cannot be opened: ${document.path}`);
      const raw = await response.json();
      assert.equal(raw.text, readFileSync(file, 'utf8'));
      assert.equal(digest(file), before, `opening changed the file on disk: ${document.path}`);
    }
  });
});
