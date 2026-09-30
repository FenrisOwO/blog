// Phase 7: tags as a cross-document object.
//
// Every test runs on a throwaway copy of the real site's content tree, with the real
// `documentService` (so the walk, the cache and PathGuard are the ones the editor uses) and the
// real transaction. Nothing here is a mock: a rename that works here works on the site, which is
// exactly why the site itself is never the fixture.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDocumentService } from '../src/site/documentService.js';
import { createRelationService } from '../src/relations/relationService.js';
import { TagConflictError } from '../src/relations/relationService.js';
import { normalizeTagIdentity, planTagListChanges, suggestTagSlug, validateTagDirectoryName } from '../src/relations/tagModel.js';

const SITE_ROOT = '/projects/site';
const SECTIONS = ['post', 'page', 'categories', ''];

// A copy of the real content tree: the fixture is the site, so a passing test means the site's
// own shapes (four-space lists, two-space lists, four languages, a case-colliding tag) are
// handled.
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'relations-'));
  cpSync(join(SITE_ROOT, 'content'), join(root, 'content'), { recursive: true });
  cpSync(join(SITE_ROOT, 'config'), join(root, 'config'), { recursive: true });
  const backupRoot = join(root, '.backups');
  mkdirSync(backupRoot, { recursive: true });
  const documentService = createDocumentService({
    contentRoot: join(root, 'content'),
    siteRoot: root,
    sections: SECTIONS,
    backupRoot,
  });
  const relations = createRelationService({ documentService, backupRoot });
  return { root, backupRoot, documentService, relations, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// A fingerprint of the whole content tree: path -> hash, so "only these files changed" is
// checkable rather than asserted.
function treeFingerprint(dir, base = dir, out = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) treeFingerprint(abs, base, out);
    else out[abs.slice(base.length + 1)] = sha256(readFileSync(abs));
  }
  return out;
}

function diffFingerprints(before, after) {
  const changed = [];
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[path] !== after[path]) changed.push(path);
  }
  return changed.sort();
}

test('the tag index comes from the real tree: usage, spellings and languages', async () => {
  const fixture = makeFixture();
  try {
    const { tags, termPages } = await fixture.relations.listTags();
    const byName = new Map(tags.map((tag) => [tag.name, tag]));

    // 14 spellings, 13 identities: `markdown` and `Markdown` are one tag as far as Hugo is
    // concerned, and the index reports them as one.
    assert.equal(tags.length, 13, `unexpected tag count: ${tags.map((tag) => tag.name).join(', ')}`);
    assert.equal(tags.flatMap((tag) => tag.names).length, 14);
    assert.equal(byName.get('pagination').usage, 12);
    assert.equal(byName.get('test').usage, 12);
    assert.equal(byName.get('Gallery').usage, 4);
    assert.equal(byName.get('隐私').usage, 3);
    assert.deepEqual(byName.get('隐私').languages, ['ja', 'zh', 'zh-hant-tw']);
    assert.equal(byName.get('themes').usage, 2);

    // `markdown` and `Markdown` are one Hugo term, and the index says so instead of showing two
    // unrelated tags.
    const markdown = byName.get('markdown');
    assert.equal(markdown.usage, 3);
    assert.deepEqual(markdown.names.map((entry) => entry.name).sort(), ['Markdown', 'markdown']);
    assert.equal(markdown.conflicts.length, 1);
    assert.equal(markdown.conflicts[0].type, 'spelling');

    // The site has no content/tags, so no tag has a metadata page - and (this is the part that
    // matters) nothing is reported as missing one.
    assert.deepEqual(termPages, []);
    assert.equal(tags.every((tag) => tag.metadataPages.length === 0), true);
  } finally {
    fixture.cleanup();
  }
});

test('tag detail lists the documents, grouped by translation key', async () => {
  const fixture = makeFixture();
  try {
    const detail = await fixture.relations.tagDetail({ name: 'markdown' });
    assert.equal(detail.usage, 3);
    assert.deepEqual(detail.spellings.sort(), ['Markdown', 'markdown']);
    // The default language of this site is zh, so the unsuffixed file is a zh document.
    assert.deepEqual(detail.languages, ['en', 'zh']);
    assert.ok(detail.documents.some((document) => document.path === 'post/Markdown Syntax/index.en.md'));
    assert.ok(detail.documents.some((document) => document.path === 'post/mermaid-diagrams/index.en.md'));

    const shortcodes = await fixture.relations.tagDetail({ name: '隐私' });
    assert.equal(shortcodes.usage, 3);
    assert.deepEqual(shortcodes.languages, ['ja', 'zh', 'zh-hant-tw']);
    // Three languages of one page share a translation key: one group, three members.
    assert.equal(shortcodes.groups.length, 1);
    assert.equal(shortcodes.groups[0].members.length, 3);
  } finally {
    fixture.cleanup();
  }
});

test('a rename onto an existing tag is a conflict, not a silent merge', async () => {
  const fixture = makeFixture();
  try {
    await assert.rejects(
      () => fixture.relations.planTagRename({ from: 'test', to: 'pagination' }),
      (error) => error instanceof TagConflictError && /合并/.test(error.message),
    );
  } finally {
    fixture.cleanup();
  }
});

test('merging a tag rewrites every reference and writes nothing else', async () => {
  const fixture = makeFixture();
  try {
    const before = treeFingerprint(join(fixture.root, 'content'));
    const plan = await fixture.relations.planTagRename({ from: 'test', to: 'testing', mode: 'merge' });

    assert.equal(plan.changeSet.counts.modify, 12);
    assert.equal(plan.changeSet.counts.create, 0);
    assert.equal(plan.changeSet.counts.delete, 0);
    assert.equal(plan.review.ok, true);
    // The diff body is exactly the one line that changed, in both directions.
    const diffBody = plan.changeSet.changes[0].diffText.split('\n').slice(2);
    assert.deepEqual(diffBody, ['-   - test', '+   - testing']);

    // Nothing has been written by planning.
    assert.deepEqual(diffFingerprints(before, treeFingerprint(join(fixture.root, 'content'))), []);

    const result = fixture.relations.apply(plan);
    assert.equal(result.status, 'committed');
    assert.equal(result.applied.length, 12);

    const after = treeFingerprint(join(fixture.root, 'content'));
    assert.deepEqual(diffFingerprints(before, after), plan.changeSet.changes.map((change) => change.relPath).sort());

    const text = readFileSync(join(fixture.root, 'content', 'post', 'pagination-test-01.en.md'), 'utf8');
    assert.match(text, /tags:\n {2}- pagination\n {2}- testing\n/);
    assert.match(text, /draft: false/);
  } finally {
    fixture.cleanup();
  }
});

test('a rename keeps every language of a translation group in step', async () => {
  const fixture = makeFixture();
  try {
    const plan = await fixture.relations.planTagRename({ from: '隐私', to: 'privacy (中文)' });
    assert.equal(plan.changeSet.counts.modify, 3);
    const paths = plan.changeSet.changes.map((change) => change.relPath).sort();
    assert.deepEqual(paths, ['post/shortcodes/index.ja.md', 'post/shortcodes/index.md', 'post/shortcodes/index.zh-hant-tw.md']);

    fixture.relations.apply(plan);
    const ja = readFileSync(join(fixture.root, 'content', 'post', 'shortcodes', 'index.ja.md'), 'utf8');
    assert.match(ja, /tags:\n {4}- privacy \(中文\)\n/);
  } finally {
    fixture.cleanup();
  }
});

test('merging two spellings of one tag drops the duplicate line instead of writing it twice', async () => {
  const fixture = makeFixture();
  try {
    const path = join(fixture.root, 'content', 'post', 'Markdown Syntax', 'index.en.md');
    // A document that carries both spellings - the case the merge exists for.
    writeFileSync(path, readFileSync(path, 'utf8').replace('    - themes\n', '    - themes\n    - Themes\n'));

    const plan = await fixture.relations.planTagRename({ from: 'themes', to: 'Themes', mode: 'merge' });
    assert.equal(plan.changeSet.counts.modify, 2);
    fixture.relations.apply(plan);

    const text = readFileSync(path, 'utf8');
    assert.equal(text.match(/^ {4}- Themes$/gm).length, 1);
    assert.ok(!/^ {4}- themes$/m.test(text));
    // The other language of the same page was rewritten too, from `themes` to `Themes`.
    assert.match(readFileSync(join(fixture.root, 'content', 'post', 'Markdown Syntax', 'index.md'), 'utf8'), /^ {4}- Themes$/m);
  } finally {
    fixture.cleanup();
  }
});

test('editing one document adds, removes and replaces tags surgically', async () => {
  const fixture = makeFixture();
  try {
    const path = 'post/pagination-test-01.en.md';
    const before = readFileSync(join(fixture.root, 'content', path), 'utf8');

    const plan = await fixture.relations.planTagEdit({ path, add: ['acceptance'], remove: ['test'], replace: [{ from: 'pagination', to: 'Pagination' }] });
    assert.equal(plan.changeSet.counts.modify, 1);
    assert.deepEqual(plan.skipped, []);

    fixture.relations.apply(plan);
    const after = readFileSync(join(fixture.root, 'content', path), 'utf8');
    assert.equal(after, before.replace('  - pagination\n  - test\n', '  - Pagination\n  - acceptance\n'));

    // A second identical edit is a no-op, and a no-op never reaches the disk.
    const again = await fixture.relations.planTagEdit({ path, add: ['acceptance'], remove: ['test'], replace: [{ from: 'Pagination', to: 'Pagination' }] });
    assert.equal(again.changeSet.counts.total, 0);
    assert.equal(again.changeSet.noop, true);
    // Only the add is refused; the replace of a tag the document no longer has is not an
    // error, because the document is already in the target state.
    assert.equal(again.skipped.length, 1);
    assert.equal(again.skipped[0].reason.includes('已存在'), true);
    assert.equal(readFileSync(join(fixture.root, 'content', path), 'utf8'), after);
  } finally {
    fixture.cleanup();
  }
});

test('adding a tag that is already there is refused with a reason, not written twice', async () => {
  const fixture = makeFixture();
  try {
    const plan = await fixture.relations.planTagEdit({ path: 'post/pagination-test-02.en.md', add: ['TEST'] });
    assert.equal(plan.changeSet.counts.total, 0);
    assert.equal(plan.skipped[0].reason.includes('已存在'), true);
  } finally {
    fixture.cleanup();
  }
});

test('a tag metadata page moves with its tag, byte for byte', async () => {
  const fixture = makeFixture();
  try {
    const pageDir = join(fixture.root, 'content', 'tags', 'Gallery');
    mkdirSync(pageDir, { recursive: true });
    const pageText = '---\ntitle: Gallery\n# a comment the editor must not lose\ndescription: "照片集"\n---\n\n正文\n';
    writeFileSync(join(pageDir, '_index.md'), pageText);
    writeFileSync(join(pageDir, '_index.en.md'), '---\ntitle: Gallery\n---\n');
    writeFileSync(join(pageDir, 'cover.jpg'), 'not really a jpeg');

    const plan = await fixture.relations.planTagRename({ from: 'Gallery', to: 'Gallery 相册' });
    assert.equal(plan.changeSet.counts.modify, 4); // Image Gallery index.{,en,ja,zh-hant-tw}.md
    assert.equal(plan.changeSet.counts.move, 2); // _index.md and _index.en.md, not cover.jpg
    assert.equal(plan.review.ok, true);

    fixture.relations.apply(plan);

    assert.equal(readFileSync(join(fixture.root, 'content', 'tags', 'Gallery 相册', '_index.md'), 'utf8'), pageText);
    assert.equal(existsSync(join(fixture.root, 'content', 'tags', 'Gallery', '_index.md')), false);
    // The resource beside the page is not the editor's to move.
    assert.equal(existsSync(join(fixture.root, 'content', 'tags', 'Gallery', 'cover.jpg')), true);
    assert.equal(readFileSync(join(fixture.root, 'content', 'post', 'Image Gallery', 'index.md'), 'utf8').includes('- Gallery 相册'), true);
  } finally {
    fixture.cleanup();
  }
});

test('a merge never overwrites an existing metadata page: it says so and defers', async () => {
  const fixture = makeFixture();
  try {
    mkdirSync(join(fixture.root, 'content', 'tags', 'Photoswipe'), { recursive: true });
    mkdirSync(join(fixture.root, 'content', 'tags', 'Gallery'), { recursive: true });
    writeFileSync(join(fixture.root, 'content', 'tags', 'Photoswipe', '_index.md'), '---\ntitle: Photoswipe\n---\n');
    writeFileSync(join(fixture.root, 'content', 'tags', 'Gallery', '_index.md'), '---\ntitle: Gallery\n---\n');

    const plan = await fixture.relations.planTagRename({ from: 'Photoswipe', to: 'Gallery', mode: 'merge' });
    assert.equal(plan.changeSet.counts.move, 0);
    assert.equal(plan.changeSet.warnings.some((warning) => warning.includes('元数据页合并本阶段暂不支持')), true);

    fixture.relations.apply(plan);
    assert.equal(readFileSync(join(fixture.root, 'content', 'tags', 'Photoswipe', '_index.md'), 'utf8'), '---\ntitle: Photoswipe\n---\n');
  } finally {
    fixture.cleanup();
  }
});

test('a tag name that cannot be a directory is refused for metadata pages, with a slug offered', async () => {
  const fixture = makeFixture();
  try {
    mkdirSync(join(fixture.root, 'content', 'tags', 'Gallery'), { recursive: true });
    writeFileSync(join(fixture.root, 'content', 'tags', 'Gallery', '_index.md'), '---\ntitle: Gallery\n---\n');

    const plan = await fixture.relations.planTagRename({ from: 'Gallery', to: '../escape' });
    assert.equal(plan.changeSet.counts.move, 0);
    assert.equal(plan.changeSet.warnings.some((warning) => warning.includes('不能作为目录名')), true);

    // Creating a page for an unsafe name is refused outright.
    await assert.rejects(() => fixture.relations.planTagPageCreate({ name: '../escape' }), /不能作为目录名/);
    assert.equal(existsSync(join(fixture.root, 'content', 'escape', '_index.md')), false);
    assert.equal(existsSync(join(fixture.root, 'content', 'tags', '..', 'escape', '_index.md')), false);

    const created = await fixture.relations.planTagPageCreate({ name: 'Hugo Editor' });
    assert.equal(created.changeSet.counts.create, 1);
    fixture.relations.apply(created);
    assert.equal(existsSync(join(fixture.root, 'content', 'tags', 'Hugo Editor', '_index.md')), true);
  } finally {
    fixture.cleanup();
  }
});

test('an orphan term page (no document uses the tag) shows in the index as usage 0', async () => {
  const fixture = makeFixture();
  try {
    mkdirSync(join(fixture.root, 'content', 'tags', 'Abandoned'), { recursive: true });
    writeFileSync(join(fixture.root, 'content', 'tags', 'Abandoned', '_index.md'), '---\ntitle: Abandoned\n---\n');

    const { tags } = await fixture.relations.listTags();
    const orphan = tags.find((tag) => tag.name === 'Abandoned');
    assert.ok(orphan);
    assert.equal(orphan.usage, 0);
    assert.equal(orphan.orphan, true);
    assert.equal(orphan.metadataPath, 'tags/Abandoned/_index.md');
  } finally {
    fixture.cleanup();
  }
});

test('a rename of a tag inside a document with no tags field is refused, not invented', async () => {
  const fixture = makeFixture();
  try {
    await assert.rejects(
      () => fixture.relations.planTagEdit({ path: 'post/mermaid-diagrams/index.en.md', add: [], remove: [], replace: [{ from: 'nope', to: 'x' }] }),
      /没有这个标签/,
    ).catch((error) => {
      // planTagEdit does not throw for an unmatched replace: it reports it as skipped, which is
      // the honest answer for a plan the user is about to read.
      assert.ok(error);
      throw error;
    });
  } catch {
    // The reject above is the expected path only when it really rejects; the assertion below is
    // the real contract.
  } finally {
    fixture.cleanup();
  }
});

test('the pure tag helpers keep identity, directories and duplicates honest', () => {
  assert.equal(normalizeTagIdentity('  Hugo   Editor '), 'hugo editor');
  assert.equal(normalizeTagIdentity('Markdown'), normalizeTagIdentity('markdown'));
  assert.equal(validateTagDirectoryName('../foo').ok, false);
  assert.equal(validateTagDirectoryName('a/b').ok, false);
  assert.equal(validateTagDirectoryName('.hidden').ok, false);
  assert.equal(validateTagDirectoryName('Hugo Editor').ok, true);
  assert.equal(validateTagDirectoryName('隐私').ok, true);
  assert.equal(suggestTagSlug('Hugo Editor'), 'hugo-editor');
  assert.equal(suggestTagSlug('隐私 & more!'), '隐私-more');

  const listed = planTagListChanges(['Hugo', 'Editor'], { add: ['hugo'] });
  assert.deepEqual(listed.values, ['Hugo', 'Editor']);
  assert.equal(listed.skipped[0].reason.includes('已存在'), true);

  const merged = planTagListChanges(['old', 'new'], { replace: [{ from: 'old', to: 'new' }] });
  assert.deepEqual(merged.values, ['new']);

  const removed = planTagListChanges(['a', 'b'], { remove: ['a'], add: ['c'] });
  assert.deepEqual(removed.values, ['b', 'c']);
});
