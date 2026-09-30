// Phase 8: the shell and the design system, checked as invariants rather than by eye.
//
// The UI audit found the same problems repeated across views: thirteen hand-rolled buttons, an
// enumerated rail in the shell, a selector whose own header was padded differently from every
// other pane, and empty/error/badge styles redefined per component. Each was an easy edit and an
// easy thing to reintroduce, so this file pins the properties that make the unification real:
//
//   1. one stylesheet owns the primitives, and no component redefines one;
//   2. components carry no colours of their own - they name a token;
//   3. the shell's navigation is data, not markup, and every view uses the page structure;
//   4. two things line up because they are the *same* thing: an icon is a fixed box, and a
//      control that sits next to another control takes the same height.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const WEB = join(ROOT, 'web');
const COMPONENTS = join(WEB, 'components');

const tokensCss = readFileSync(join(WEB, 'styles', 'tokens.css'), 'utf8');
const baseCss = readFileSync(join(WEB, 'styles', 'base.css'), 'utf8');
const appSource = readFileSync(join(WEB, 'App.vue'), 'utf8');
const mainJs = readFileSync(join(WEB, 'main.js'), 'utf8');

const componentFiles = readdirSync(COMPONENTS).filter((name) => name.endsWith('.vue'));
const components = componentFiles.map((name) => ({
  name,
  source: readFileSync(join(COMPONENTS, name), 'utf8'),
}));

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start > -1, `expected to find: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `expected markers in order: ${startMarker}`);
  return source.slice(start, end);
}

function styleBlock(source) {
  const start = source.indexOf('<style');
  if (start === -1) return '';
  return source.slice(source.indexOf('>', start) + 1, source.lastIndexOf('</style>'));
}

// Names a component must not define: each one has a single owner in base.css, and a component
// that redefines it is how "the button in the dialog is 2px shorter" happens.
const SHARED = [
  'badge', 'chip', 'btn', 'mini', 'list', 'list-item', 'thumb', 'panel', 'panel-head',
  'panel-body', 'field-row', 'empty', 'error-line', 'flash', 'count', 'muted', 'faint', 'mono',
  'spacer', 'hint', 'search', 'row', 'stack', 'icon', 'view', 'view-head', 'view-body',
];
const definedIn = (css, name) => new RegExp(`^\\.${name}(?:\\s*\\{|\\s*,)`, 'm').test(css);

test('the primitives are defined by the stylesheet and by nothing else', () => {
  for (const name of SHARED) {
    assert.ok(definedIn(baseCss, name), `.${name} is not defined in base.css`);
  }
  for (const { name, source } of components) {
    const css = styleBlock(source);
    for (const primitive of SHARED) {
      assert.ok(
        !definedIn(css, primitive),
        `${name} redefines .${primitive}; it belongs in base.css`,
      );
    }
    assert.doesNotMatch(source, /class="rail-item/, `${name} still uses the pre-Phase-8 rail class`);
  }
});

test('component styles name tokens instead of colours', () => {
  for (const { name, source } of components) {
    const css = styleBlock(source);
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, `${name} hardcodes a hex colour`);
    assert.doesNotMatch(css, /\b(?:rgba?|hsla?)\(/, `${name} hardcodes an rgb()/hsl() colour`);
  }
  // ...and the tokens themselves live in exactly one file.
  assert.match(tokensCss, /:root\s*\{/, 'tokens.css defines the light palette');
  assert.match(tokensCss, /\[data-theme='dark'\]/, 'tokens.css defines the dark palette');
});

test('one control height keeps a toolbar on one baseline', () => {
  // The heights are tokens, not numbers repeated per component.
  for (const token of ['--control-h-sm', '--control-h', '--control-h-lg', '--control-pad-x', '--gap-control']) {
    assert.ok(tokensCss.includes(`${token}:`), `missing control token ${token}`);
  }
  assert.ok(tokensCss.includes('--panel-head-h:'), 'panes need one header height');
  assert.ok(tokensCss.includes('--page-pad:'), 'views need one page padding');

  // Buttons and inputs take their height from the same token, and neither fixes a numeric
  // line-height: the height plus centred content is what puts them on one baseline.
  const buttonBase = /\.btn,\s*\.mini\s*\{([^}]*)\}/.exec(baseCss);
  assert.ok(buttonBase, 'the button base block is defined');
  assert.match(buttonBase[1], /height:\s*var\(--control-h\)/);
  assert.doesNotMatch(buttonBase[1], /line-height:\s*\d/, 'the button base must not fix a line-height');

  const fieldBase = /input\[type='text'\][\s\S]*?\{([^}]*)\}/.exec(baseCss);
  assert.ok(fieldBase, 'the field base block is defined');
  assert.match(fieldBase[1], /height:\s*var\(--control-h\)/);
  assert.doesNotMatch(fieldBase[1], /line-height:\s*\d/, 'fields must not fix a line-height');
});

test('an icon is a box, so a glyph and a label line up', () => {
  // Both glyph kinds - emoji and svg - are centred in one box, which is what stops an emoji from
  // sitting a pixel high next to text.
  assert.match(baseCss, /\.icon\s*\{[^}]*display:\s*inline-flex/);
  assert.match(baseCss, /\.icon\s*\{[^}]*align-items:\s*center/);
  assert.match(baseCss, /\.icon\s*\{[^}]*justify-content:\s*center/);
  assert.match(baseCss, /\.icon\s*\{[^}]*flex:\s*0 0 auto/);

  // Every decorative glyph is hidden from assistive tech; the label next to it carries the
  // meaning. `icon-btn` is a button (labelled separately), so it is not in scope.
  const glyphs = [...appSource.matchAll(/<span[^>]*class="icon[^"]*"[^>]*>/g)];
  assert.ok(glyphs.length > 0, 'the shell uses icons');
  for (const [tag] of glyphs) {
    assert.match(tag, /aria-hidden="true"/, `an icon is announced to screen readers: ${tag}`);
  }
});

test('the shell navigation is data and the active entry is marked for assistive tech', () => {
  // One source of truth for the rail: the view list. An enumerated rail is how the rail and the
  // command palette drift apart.
  assert.match(appSource, /const VIEWS = \[/, 'the rail is built from a view list');
  assert.match(appSource, /v-for="item in VIEWS"/, 'the rail renders the view list');
  assert.match(appSource, /:aria-current="view === item\.id \? 'page' : undefined"/, 'the active view is announced');

  // Each view's own header uses the shared structure, so no view can invent its own padding.
  for (const file of ['AssetPanel.vue', 'RelationsPanel.vue', 'SettingsPanel.vue']) {
    const { source } = components.find((entry) => entry.name === file);
    assert.match(source, /class="view\b/, `${file} does not use the shared page structure`);
    assert.match(source, /class="view-head"/, `${file} has no shared page header`);
  }
  assert.match(appSource, /class="workspace content-view"/, 'the content view uses the shared workspace');

  // The article selector is a *pane*, not a page: its header is the shared pane header, so it
  // lines up with the workspace and the inspector it sits between.
  const pane = between(appSource, '<aside v-if="listOpen" class="browser"', '</aside>');
  assert.match(pane, /class="browser-head"/, 'the selector has no shared pane header');
  assert.match(pane, /class="browser-body"/, 'the selector has no shared pane body');
  assert.match(baseCss, /\.browser-head\s*\{/, 'the pane header is defined by the stylesheet');
  assert.match(
    baseCss,
    /\.browser-head[^{]*\{[^}]*min-height:\s*var\(--panel-head-h\)/,
    'pane headers share one height with panel headers',
  );

  // The list itself is the shared list primitive, so an article row and an asset row are the
  // same row.
  const selector = components.find((entry) => entry.name === 'DocumentList.vue').source;
  assert.match(selector, /class="list-item selectable doc-row"/, 'an article row is not the shared list row');
  assert.match(selector, /<span class="body">/, 'the shared row body carries title and meta');
});

test('the command palette is a view of the same actions, icons included', () => {
  const commands = readFileSync(join(WEB, 'commands.js'), 'utf8');
  assert.match(commands, /icon: options\.icon \?\? iconFor\(id\)/, 'every command carries an icon');
  // The icons that mirror the rail must be the same glyphs, or the palette and the rail disagree
  // about what "内容" is.
  const palette = components.find((entry) => entry.name === 'CommandPalette.vue').source;
  assert.match(palette, /class="icon sm"[^>]*>\s*\{\{ command\.icon \}\}/, 'palette rows render the icon box');
});

test('the stylesheet is loaded as tokens first, then the system built on them', () => {
  const tokensAt = mainJs.indexOf('styles/tokens.css');
  const baseAt = mainJs.indexOf('styles/base.css');
  assert.ok(tokensAt > -1, 'main.js loads tokens.css');
  assert.ok(baseAt > -1, 'main.js loads base.css');
  assert.ok(tokensAt < baseAt, 'tokens must load before the stylesheet that uses them');
});

test('the responsive rules keep the view structure usable', () => {
  // Every breakpoint that resizes the shell must keep the panes positive and the page padding
  // tokenised, so a narrow window compresses the layout instead of breaking it.
  for (const [, value] of baseCss.matchAll(/--browser-w:\s*(-?\d+(?:\.\d+)?)px/g)) {
    assert.ok(Number(value) > 0, 'the selector column must stay positive');
  }
  for (const width of [1500, 1200, 1100, 960]) {
    assert.match(baseCss, new RegExp(`@media\\s*\\(max-width:\\s*${width}px\\)`), `the shell has a ${width}px breakpoint`);
  }
  const media = [...baseCss.matchAll(/@media[^{]+\{/g)].map((match) => match[0]);
  assert.ok(media.length >= 2, 'the design system covers more than one breakpoint');
});
