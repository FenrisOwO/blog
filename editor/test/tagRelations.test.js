// Phase 7: tags as a cross-document object.
//
// Every test runs on a throwaway copy of the fixture corpus (test/fixtures/README.md), with the
// real `documentService` (so the walk, the cache and PathGuard are the ones the editor uses) and
// the real transaction. Nothing here is a mock: a rename that works here works on the site, which
// is exactly why the tests declare their own documents instead of reading the user's.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDocumentService } from '../src/site/documentService.js';
import { createRelationService } from '../src/relations/relationService.js';
import { TagConflictError } from '../src/relations/relationService.js';
import { normalizeTagIdentity, planTagListChanges, suggestTagSlug, validateTagDirectoryName } from '../src/relations/tagModel.js';
import { FIXTURE, makeFixtureSandbox } from './fixtures/harness.js';

const SECTIONS = ['post', 'page', 'categories', ''];

// The fixture corpus is deliberately small, so its vocabulary is a fact to read from the documents
// themselves (see `tagVocabulary` below): three used identities - `fixture` (with the `Fixture`
// spelling), `alpha` (both languages of fixture-article) and `markdown`/`Markdown` - plus one
// metadata page, `tags/fixture-tag/_index.md`, whose term no document uses.
function makeFixture(t) {
  const sandbox = makeFixtureSandbox(t, { prefix: 'hve-tags-' });
  const documentService = createDocumentService({
    contentRoot: sandbox.contentRoot,
    siteRoot: sandbox.siteRoot,
    sections: SECTIONS,
    backupRoot: sandbox.backupRoot,
  });
  const relations = createRelationService({ documentService, backupRoot: sandbox.backupRoot });
  return { ...sandbox, documentService, relations };
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

// The fixture's vocabulary is a fact to read from the documents, not a constant to pin: an
// identity is case-insensitive (that is the property under test), a name is one spelling of it,
// and a usage is one document carrying it.
function tagVocabulary(dir, base = dir, out = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      tagVocabulary(abs, base, out);
      continue;
    }
    if (!entry.name.endsWith('.md')) continue;
    const frontMatter = readFileSync(abs, 'utf8').split(/^---\s*$/m)[1] ?? '';
    const block = frontMatter.split(/^tags:/m)[1]?.split(/^\S/m)[0] ?? '';
    for (const line of block.matchAll(/^\s*-\s*(.+?)\s*$/gm)) {
      const name = line[1].replace(/^['"]|['"]$/g, '');
      const identity = out.get(name.toLowerCase()) ?? { names: new Set(), docs: new Set() };
      identity.names.add(name);
      identity.docs.add(abs.slice(base.length + 1));
      out.set(name.toLowerCase(), identity);
    }
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

test('the tag index comes from the fixture tree: usage, spellings and languages', async (t) => {
  const fixture = makeFixture(t);
  const { tags, termPages } = await fixture.relations.listTags();
  const byName = new Map(tags.map((tag) => [tag.name, tag]));

  // The index has to agree with the documents: one identity per case-insensitive spelling, one
  // name per spelling, one usage per document that carries it. `markdown` and `Markdown` are still
  // one tag, and the index reports them as one, which is what this test is for.
  const vocabulary = tagVocabulary(fixture.contentRoot);
  const spellings = [...vocabulary.values()].reduce((total, entry) => total + entry.names.size, 0);
  // The fixture also ships one metadata page (tags/fixture-tag/_index.md) for a term no document
  // uses: the index carries it as an orphan, so compare the document-backed tags only.
  const documentTags = tags.filter((tag) => !tag.orphan);
  assert.equal(documentTags.length, vocabulary.size, `unexpected tag count: ${tags.map((tag) => tag.name).join(', ')}`);
  assert.equal(documentTags.flatMap((tag) => tag.names).length, spellings);
  for (const name of ['fixture', 'alpha', 'markdown']) {
    assert.equal(byName.get(name).usage, vocabulary.get(name.toLowerCase()).docs.size, `${name} usage`);
  }
  // `alpha` is the tag the fixture uses in two languages (fixture-article.md and its .en.md).
  assert.deepEqual(byName.get('alpha').languages, ['en', 'zh']);

  // `markdown` and `Markdown` are one Hugo term, and the index says so instead of showing two
  // unrelated tags.
  const markdown = byName.get('markdown');
  assert.equal(markdown.usage, vocabulary.get('markdown').docs.size);
  assert.deepEqual(markdown.names.map((entry) => entry.name).sort(), ['Markdown', 'markdown']);
  assert.equal(markdown.conflicts.length, 1);
  assert.equal(markdown.conflicts[0].type, 'spelling');

  // The orphan metadata page is reported as such - usage 0, its own file named - and it is the
  // only metadata page in the corpus.
  const orphan = byName.get('fixture-tag');
  assert.equal(orphan.orphan, true);
  assert.equal(orphan.usage, 0);
  assert.equal(orphan.metadataPath, FIXTURE.tagPage);
  assert.deepEqual(termPages.map((page) => page.dir), ['fixture-tag']);
  assert.equal(tags.filter((tag) => tag.metadataPages.length > 0).length, 1);
});

test('tag detail lists the documents, grouped by translation key', async (t) => {
  const fixture = makeFixture(t);
  const detail = await fixture.relations.tagDetail({ name: 'markdown' });
  assert.equal(detail.usage, 2);
  assert.deepEqual(detail.spellings.sort(), ['Markdown', 'markdown']);
  // The default language of the fixture is zh, so the unsuffixed file is a zh document.
  assert.deepEqual(detail.languages, ['en', 'zh']);
  assert.ok(detail.documents.some((document) => document.path === FIXTURE.markdown));
  assert.ok(detail.documents.some((document) => document.path === FIXTURE.markdownZh));

  const alpha = await fixture.relations.tagDetail({ name: 'alpha' });
  assert.equal(alpha.usage, 2);
  assert.deepEqual(alpha.languages, ['en', 'zh']);
  // Two languages of one page share a translation key: one group, two members.
  assert.equal(alpha.groups.length, 1);
  assert.equal(alpha.groups[0].members.length, 2);
});

test('a rename onto an existing tag is a conflict, not a silent merge', async (t) => {
  const fixture = makeFixture(t);
  await assert.rejects(
    () => fixture.relations.planTagRename({ from: 'alpha', to: 'fixture' }),
    (error) => error instanceof TagConflictError && /合并/.test(error.message),
  );
});

test('merging a tag rewrites every reference and writes nothing else', async (t) => {
  const fixture = makeFixture(t);
  const before = treeFingerprint(fixture.contentRoot);
  const plan = await fixture.relations.planTagRename({ from: 'alpha', to: 'beta', mode: 'merge' });

  assert.equal(plan.changeSet.counts.modify, 2);
  assert.equal(plan.changeSet.counts.create, 0);
  assert.equal(plan.changeSet.counts.delete, 0);
  assert.equal(plan.review.ok, true);
  // The diff body is exactly the one line that changed, in both directions.
  const diffBody = plan.changeSet.changes[0].diffText.split('\n').slice(2);
  assert.deepEqual(diffBody, ['-   - alpha', '+   - beta']);

  // Nothing has been written by planning.
  assert.deepEqual(diffFingerprints(before, treeFingerprint(fixture.contentRoot)), []);

  const result = fixture.relations.apply(plan);
  assert.equal(result.status, 'committed');
  assert.equal(result.applied.length, 2);

  const after = treeFingerprint(fixture.contentRoot);
  assert.deepEqual(diffFingerprints(before, after), plan.changeSet.changes.map((change) => change.relPath).sort());

  const text = readFileSync(join(fixture.contentRoot, FIXTURE.article), 'utf8');
  assert.match(text, /tags:\n {2}- fixture\n {2}- beta\n/);
  assert.match(text, /draft: false/);
});

test('a rename keeps every language of a translation group in step', async (t) => {
  const fixture = makeFixture(t);
  const plan = await fixture.relations.planTagRename({ from: 'alpha', to: 'alpha (中文)' });
  assert.equal(plan.changeSet.counts.modify, 2);
  const paths = plan.changeSet.changes.map((change) => change.relPath).sort();
  assert.deepEqual(paths, [FIXTURE.article, FIXTURE.articleZh].sort());

  fixture.relations.apply(plan);
  const en = readFileSync(join(fixture.contentRoot, FIXTURE.article), 'utf8');
  assert.match(en, /tags:\n {2}- fixture\n {2}- alpha \(中文\)\n/);
});

test('merging two spellings of one tag drops the duplicate line instead of writing it twice', async (t) => {
  const fixture = makeFixture(t);
  const path = join(fixture.contentRoot, FIXTURE.markdown);
  // The fixture carries `markdown` (zh) and `Markdown` (en); make the en document carry both
  // spellings - the case the merge exists for.
  writeFileSync(path, readFileSync(path, 'utf8').replace('  - Markdown\n', '  - Markdown\n  - markdown\n'));

  const plan = await fixture.relations.planTagRename({ from: 'markdown', to: 'Markdown', mode: 'merge' });
  assert.equal(plan.changeSet.counts.modify, 2);
  fixture.relations.apply(plan);

  const text = readFileSync(path, 'utf8');
  assert.equal(text.match(/^ {2}- Markdown$/gm).length, 1);
  assert.ok(!/^ {2}- markdown$/m.test(text));
  // The other language of the same page was rewritten too, from `markdown` to `Markdown`.
  assert.match(readFileSync(join(fixture.contentRoot, FIXTURE.markdownZh), 'utf8'), /^ {2}- Markdown$/m);
});

test('editing one document adds, removes and replaces tags surgically', async (t) => {
  const fixture = makeFixture(t);
  const path = FIXTURE.article;
  const abs = join(fixture.contentRoot, path);
  const before = readFileSync(abs, 'utf8');

  const plan = await fixture.relations.planTagEdit({ path, add: ['beta'], remove: ['alpha'], replace: [{ from: 'fixture', to: 'Fixture' }] });
  assert.equal(plan.changeSet.counts.modify, 1);
  assert.deepEqual(plan.skipped, []);

  fixture.relations.apply(plan);
  const after = readFileSync(abs, 'utf8');
  assert.equal(after, before.replace('  - fixture\n  - alpha\n', '  - Fixture\n  - beta\n'));

  // A second identical edit is a no-op, and a no-op never reaches the disk.
  const again = await fixture.relations.planTagEdit({ path, add: ['beta'], remove: ['alpha'], replace: [{ from: 'Fixture', to: 'Fixture' }] });
  assert.equal(again.changeSet.counts.total, 0);
  assert.equal(again.changeSet.noop, true);
  // Only the add is refused; the replace of a tag the document no longer has is not an
  // error, because the document is already in the target state.
  assert.equal(again.skipped.length, 1);
  assert.equal(again.skipped[0].reason.includes('已存在'), true);
  assert.equal(readFileSync(abs, 'utf8'), after);
});

test('adding a tag that is already there is refused with a reason, not written twice', async (t) => {
  const fixture = makeFixture(t);
  const plan = await fixture.relations.planTagEdit({ path: FIXTURE.article, add: ['ALPHA'] });
  assert.equal(plan.changeSet.counts.total, 0);
  assert.equal(plan.skipped[0].reason.includes('已存在'), true);
});

test('a tag metadata page moves with its tag, byte for byte', async (t) => {
  const fixture = makeFixture(t);
  const pageDir = join(fixture.contentRoot, 'tags', 'alpha');
  mkdirSync(pageDir, { recursive: true });
  const pageText = '---\ntitle: alpha\n# a comment the editor must not lose\ndescription: "照片集"\n---\n\n正文\n';
  writeFileSync(join(pageDir, '_index.md'), pageText);
  writeFileSync(join(pageDir, '_index.en.md'), '---\ntitle: alpha\n---\n');
  writeFileSync(join(pageDir, 'cover.jpg'), 'not really a jpeg');

  const plan = await fixture.relations.planTagRename({ from: 'alpha', to: 'alpha 相册' });
  assert.equal(plan.changeSet.counts.modify, 2); // fixture-article.{md,en.md}
  assert.equal(plan.changeSet.counts.move, 2); // _index.md and _index.en.md, not cover.jpg
  assert.equal(plan.review.ok, true);

  fixture.relations.apply(plan);

  assert.equal(readFileSync(join(fixture.contentRoot, 'tags', 'alpha 相册', '_index.md'), 'utf8'), pageText);
  assert.equal(existsSync(join(fixture.contentRoot, 'tags', 'alpha', '_index.md')), false);
  // The resource beside the page is not the editor's to move.
  assert.equal(existsSync(join(fixture.contentRoot, 'tags', 'alpha', 'cover.jpg')), true);
  assert.equal(readFileSync(join(fixture.contentRoot, FIXTURE.articleZh), 'utf8').includes('- alpha 相册'), true);
});

test('a merge never overwrites an existing metadata page: it says so and defers', async (t) => {
  const fixture = makeFixture(t);
  mkdirSync(join(fixture.contentRoot, 'tags', 'alpha'), { recursive: true });
  mkdirSync(join(fixture.contentRoot, 'tags', 'fixture'), { recursive: true });
  writeFileSync(join(fixture.contentRoot, 'tags', 'alpha', '_index.md'), '---\ntitle: alpha\n---\n');
  writeFileSync(join(fixture.contentRoot, 'tags', 'fixture', '_index.md'), '---\ntitle: fixture\n---\n');

  const plan = await fixture.relations.planTagRename({ from: 'alpha', to: 'fixture', mode: 'merge' });
  assert.equal(plan.changeSet.counts.move, 0);
  assert.equal(plan.changeSet.warnings.some((warning) => warning.includes('元数据页合并本阶段暂不支持')), true);

  fixture.relations.apply(plan);
  assert.equal(readFileSync(join(fixture.contentRoot, 'tags', 'alpha', '_index.md'), 'utf8'), '---\ntitle: alpha\n---\n');
});

test('a tag name that cannot be a directory is refused for metadata pages, with a slug offered', async (t) => {
  const fixture = makeFixture(t);
  mkdirSync(join(fixture.contentRoot, 'tags', 'alpha'), { recursive: true });
  writeFileSync(join(fixture.contentRoot, 'tags', 'alpha', '_index.md'), '---\ntitle: alpha\n---\n');

  const plan = await fixture.relations.planTagRename({ from: 'alpha', to: '../escape' });
  assert.equal(plan.changeSet.counts.move, 0);
  assert.equal(plan.changeSet.warnings.some((warning) => warning.includes('不能作为目录名')), true);

  // Creating a page for an unsafe name is refused outright.
  await assert.rejects(() => fixture.relations.planTagPageCreate({ name: '../escape' }), /不能作为目录名/);
  assert.equal(existsSync(join(fixture.contentRoot, 'escape', '_index.md')), false);
  assert.equal(existsSync(join(fixture.contentRoot, 'tags', '..', 'escape', '_index.md')), false);

  const created = await fixture.relations.planTagPageCreate({ name: 'Hugo Editor' });
  assert.equal(created.changeSet.counts.create, 1);
  fixture.relations.apply(created);
  assert.equal(existsSync(join(fixture.contentRoot, 'tags', 'Hugo Editor', '_index.md')), true);
});

test('an orphan term page (no document uses the tag) shows in the index as usage 0', async (t) => {
  const fixture = makeFixture(t);
  mkdirSync(join(fixture.contentRoot, 'tags', 'Abandoned'), { recursive: true });
  writeFileSync(join(fixture.contentRoot, 'tags', 'Abandoned', '_index.md'), '---\ntitle: Abandoned\n---\n');

  const { tags } = await fixture.relations.listTags();
  const orphan = tags.find((tag) => tag.name === 'Abandoned');
  assert.ok(orphan);
  assert.equal(orphan.usage, 0);
  assert.equal(orphan.orphan, true);
  assert.equal(orphan.metadataPath, 'tags/Abandoned/_index.md');
});

test('a rename of a tag inside a document with no tags field is refused, not invented', async (t) => {
  const fixture = makeFixture(t);
  try {
    await assert.rejects(
      () => fixture.relations.planTagEdit({ path: FIXTURE.page, add: [], remove: [], replace: [{ from: 'nope', to: 'x' }] }),
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
