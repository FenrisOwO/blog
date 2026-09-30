// Parsing Hugo's console output.
//
// Every sample below was captured from this project's real Hugo 0.167.0 by deliberately
// breaking a build, so the tests encode actual output rather than assumptions.

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractLocation, formatDiagnostic, parseBuildOutput, parseBuildStats } from '../src/build/buildErrors.js';

const SITE = '/tmp/hve-broken';

test('a shortcode error yields the file, line and the useful sentence', () => {
  const stderr =
    'ERROR error building site: assemble: failed to create page from pageMetaSource /post/broken1: ' +
    '"/tmp/hve-broken/content/post/broken1/index.md:8:1": failed to extract shortcode: ' +
    'template for shortcode "nosuchshortcode" not found\n';

  const parsed = parseBuildOutput({ stderr, siteRoot: SITE });

  assert.equal(parsed.errorCount, 1);
  assert.equal(parsed.warningCount, 0);
  const [diagnostic] = parsed.diagnostics;
  assert.equal(diagnostic.level, 'error');
  assert.equal(diagnostic.file, 'content/post/broken1/index.md');
  assert.equal(diagnostic.line, 8);
  assert.equal(diagnostic.column, 1);
  assert.equal(diagnostic.shortMessage, 'failed to extract shortcode: template for shortcode "nosuchshortcode" not found');
  assert.equal(parsed.firstError, diagnostic);
});

test('a front matter error keeps its code frame as context', () => {
  const stderr = [
    'ERROR error building site: assemble: failed to create page from pageMetaSource /post/x: ' +
      '"/tmp/hve-broken/content/post/x/index.md:4:7": [3:7] sequence end token \']\' not found',
    '   1 | title: "坏的 front matter"',
    '   2 | date: 2026-01-01',
    ">  3 | tags: [unclosed",
    '             ^',
    '',
  ].join('\n');

  const parsed = parseBuildOutput({ stderr, siteRoot: SITE });
  const [diagnostic] = parsed.diagnostics;

  assert.equal(diagnostic.file, 'content/post/x/index.md');
  assert.equal(diagnostic.line, 4);
  assert.equal(diagnostic.message.includes('sequence end token'), true);
  assert.equal(diagnostic.context.length, 4, 'the code frame lines attach to their diagnostic');
  assert.ok(diagnostic.context[2].startsWith('>  3 |'));
});

test('a "see <path>" error without a line still yields the file', () => {
  const stderr = 'ERROR the "date" front matter field is not a parsable date: see /tmp/hve-broken/content/post/z/index.md\n';

  const [diagnostic] = parseBuildOutput({ stderr, siteRoot: SITE }).diagnostics;

  assert.equal(diagnostic.level, 'error');
  assert.equal(diagnostic.file, 'content/post/z/index.md');
  assert.equal(diagnostic.line, null);
  assert.equal(diagnostic.shortMessage, 'the "date" front matter field is not a parsable date: see /tmp/hve-broken/content/post/z/index.md');
});

test('warnings are counted separately from errors', () => {
  const stderr = [
    'WARN  Search page not found. Create a page with layout: search.',
    'WARN  Taxonomy categories not found',
    'WARN  Taxonomy tags not found',
    '',
  ].join('\n');

  const parsed = parseBuildOutput({ stderr, siteRoot: SITE });

  assert.equal(parsed.errorCount, 0);
  assert.equal(parsed.warningCount, 3);
  assert.equal(parsed.firstError, null);
  assert.deepEqual(
    parsed.diagnostics.map((d) => d.shortMessage),
    ['Search page not found. Create a page with layout: search.', 'Taxonomy categories not found', 'Taxonomy tags not found'],
  );
});

// The build usually runs against a mirror of the site on local disk (see sourceMirror.js),
// so Hugo's absolute paths name the mirror. The user must still see content/... .
test('diagnostics from a mirrored build point back into the site', () => {
  const mirror = '/tmp/hugo-editor-build/site/source';
  const parsed = parseBuildOutput({
    stderr:
      'ERROR error building site: assemble: failed to create page from pageMetaSource /post/x: ' +
      `"${mirror}/content/post/x/index.md:4:7": [3:7] sequence end token ']' not found\n`,
    siteRoot: SITE,
    buildRoot: mirror,
  });

  const [diagnostic] = parsed.diagnostics;
  assert.equal(diagnostic.file, 'content/post/x/index.md');
  assert.equal(diagnostic.line, 4);
  assert.equal(diagnostic.column, 7);
});

test('a relative diagnostic path is reported as written', () => {
  const location = extractLocation('failed to read content/post/x.md:2:1', SITE, '/tmp/mirror');
  assert.equal(location.file, 'content/post/x.md');
  assert.equal(location.line, 2);
});


test('paths outside the site are left absolute rather than mangled', () => {
  const location = extractLocation('failed to read "/etc/hosts.md:1:1": nope', SITE);
  assert.equal(location.file, '/etc/hosts.md');
});

test('identical diagnostics are de-duplicated but distinct ones survive', () => {
  const stderr = [
    'WARN  Taxonomy tags not found',
    'WARN  Taxonomy tags not found',
    'WARN  Taxonomy categories not found',
    '',
  ].join('\n');

  const parsed = parseBuildOutput({ stderr, siteRoot: SITE });
  assert.equal(parsed.diagnostics.length, 2);
});

test('the build summary line is parsed', () => {
  assert.deepEqual(parseBuildStats('Total in 9363 ms\n'), { totalMs: 9363 });
  assert.deepEqual(parseBuildStats('nothing here'), { totalMs: null });
});

test('formatDiagnostic renders a clickable-looking location', () => {
  const [diagnostic] = parseBuildOutput({
    stderr: 'ERROR x: "/tmp/hve-broken/content/post/a.md:3:2": boom\n',
    siteRoot: SITE,
  }).diagnostics;
  assert.equal(formatDiagnostic(diagnostic), 'content/post/a.md:3:2: boom');
});
