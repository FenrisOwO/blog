// Phase 7: links as a structured, ordered list of maps.
//
// The document under test is the fixture's `page/links/index*.md` (test/fixtures/README.md) - the
// only place in the corpus that has a `links:` block - and it is exactly the shape that resists a
// naive form: a list of maps inside the front matter, with an image that is sometimes an external
// URL and sometimes a page resource of the same bundle.

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDocumentService } from '../src/site/documentService.js';
import { createRelationService } from '../src/relations/relationService.js';
import { classifyLinkImage, isSafeImageReference, normalizeImageReference, planLinkEdits, readLinks, renderNewLinksBlock } from '../src/relations/linkModel.js';
import { FIXTURE, makeFixtureSandbox } from './fixtures/harness.js';

const SECTIONS = ['post', 'page', 'categories', ''];
const LINKS_PATH = FIXTURE.links;

function makeFixture(t) {
  const sandbox = makeFixtureSandbox(t, { prefix: 'hve-links-' });
  const documentService = createDocumentService({
    contentRoot: sandbox.contentRoot,
    siteRoot: sandbox.siteRoot,
    sections: SECTIONS,
    backupRoot: sandbox.backupRoot,
  });
  const relations = createRelationService({ documentService, backupRoot: sandbox.backupRoot });
  return { ...sandbox, documentService, relations };
}

function fingerprint(text) {
  return createHash('sha256').update(text).digest('hex');
}

function changedLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const lines = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) if (a[i] !== b[i]) lines.push(i);
  return lines;
}

test('reads the fixture links page: two items, four keys, two kinds of image', async (t) => {
  const fixture = makeFixture(t);
  const view = await fixture.relations.links({ path: LINKS_PATH });
  assert.equal(view.present, true);
  assert.equal(view.items.length, 2);
  assert.deepEqual(view.keyOrder, ['title', 'description', 'website', 'image']);

  const [github, second] = view.items;
  assert.equal(github.title, 'GitHub');
  assert.equal(github.website, 'https://github.com');
  assert.equal(github.imageRef.kind, 'external');
  assert.deepEqual(github.missing, []);

  // The second item's image is a page resource of this very bundle: a Phase 6 relationship, and
  // the reader says which file it is instead of guessing.
  assert.equal(second.imageRef.kind, 'resource');
  assert.equal(second.imageRef.resourcePath, FIXTURE.linksResource);
  assert.equal(view.malformed.length, 0);
});

test('editing one link changes one line of the file', async (t) => {
  const fixture = makeFixture(t);
  const abs = join(fixture.contentRoot, LINKS_PATH);
  const before = readFileSync(abs, 'utf8');
  // The fixture's second link carries its own description; an edit must change only that line.
  const original = readLinks(before.slice(before.indexOf('---') + 3, before.lastIndexOf('---'))).items[1].description;
  const edited = '夹具的图片资源（已编辑）。';

  const plan = await fixture.relations.planLinkEdits({
    path: LINKS_PATH,
    edit: [{ index: 1, set: { description: edited } }],
  });
  assert.equal(plan.changeSet.counts.modify, 1);
  // Exactly one line of the file changed, and it is the description.
  assert.equal(changedLines(before, plan.changeSet.changes[0].after).length, 1);
  const diffBody = plan.changeSet.changes[0].diffText.split('\n').slice(2);
  assert.deepEqual(diffBody, [
    `-     description: ${original}`,
    `+     description: ${edited}`,
  ]);
  assert.equal(plan.review.ok, true);

  fixture.relations.apply(plan);
  const after = readFileSync(abs, 'utf8');
  assert.equal(after, before.replace(
    `description: ${original}`,
    `description: ${edited}`,
  ));
});

test('adding, removing and reordering links keeps the other items byte-identical', async (t) => {
  const fixture = makeFixture(t);
  const abs = join(fixture.contentRoot, LINKS_PATH);
  const before = readFileSync(abs, 'utf8');

  const plan = await fixture.relations.planLinkEdits({
    path: LINKS_PATH,
    add: [{ title: 'Hugo', description: '静态站点生成器', website: 'https://gohugo.io', image: 'https://gohugo.io/images/hugo-logo-wide.svg' }],
  });
  fixture.relations.apply(plan);
  let text = readFileSync(abs, 'utf8');
  // Everything before the next top-level key is the links block plus one appended item, and
  // every byte of the two original items is untouched.
  assert.equal(
    text.slice(0, text.indexOf('menu:')),
    before.slice(0, before.indexOf('menu:')).replace(
      '    image: fixture-logo.jpg\n',
      '    image: fixture-logo.jpg\n  - title: Hugo\n    description: 静态站点生成器\n    website: https://gohugo.io\n    image: https://gohugo.io/images/hugo-logo-wide.svg\n',
    ),
  );

  // Only the front matter is inspected: the page's own body also lists links as an example.
  const frontMatterOf = (document) => document.slice(0, document.indexOf('\nmenu:'));
  const titlesOf = (document) => [...frontMatterOf(document).matchAll(/^ {2}- title: (.*)$/gm)].map((match) => match[1]);

  const reorder = await fixture.relations.planLinkEdits({ path: LINKS_PATH, move: [{ from: 2, to: 0 }] });
  fixture.relations.apply(reorder);
  text = readFileSync(abs, 'utf8');
  assert.deepEqual(titlesOf(text), ['Hugo', 'GitHub', 'Fixture']);
  // The moved item kept its bytes, description and image included.
  assert.ok(text.includes('    image: https://gohugo.io/images/hugo-logo-wide.svg'));

  const removePlan = await fixture.relations.planLinkEdits({ path: LINKS_PATH, remove: [1] });
  fixture.relations.apply(removePlan);
  text = readFileSync(abs, 'utf8');
  assert.deepEqual(titlesOf(text), ['Hugo', 'Fixture']);
  // The removed item's fields are gone, and the surviving item kept its description.
  assert.ok(!text.includes('GitHub 是世界上最大的软件开发平台。'));
  assert.ok(text.includes('夹具自带的图片资源。'));
});

test('an add that is missing a required field is refused, never written half-formed', async (t) => {
  const fixture = makeFixture(t);
  const abs = join(fixture.contentRoot, LINKS_PATH);
  const before = readFileSync(abs, 'utf8');
  const plan = await fixture.relations.planLinkEdits({ path: LINKS_PATH, add: [{ title: 'No website' }] });
  assert.equal(plan.changeSet.counts.total, 0);
  assert.equal(plan.skipped[0].reason.includes('必填字段'), true);
  assert.equal(readFileSync(abs, 'utf8'), before);
});

test('a document with no links field gets one, and only when a link is really added', async (t) => {
  const fixture = makeFixture(t);
  const path = FIXTURE.article;
  const abs = join(fixture.contentRoot, path);

  const empty = await fixture.relations.links({ path });
  assert.equal(empty.present, false);
  assert.deepEqual(empty.items, []);

  await assert.rejects(() => fixture.relations.planLinkEdits({ path, edit: [{ index: 0, set: { title: 'x' } }] }), /没有 links 字段/);

  const plan = await fixture.relations.planLinkEdits({ path, add: [{ title: 'Hugo', website: 'https://gohugo.io' }] });
  assert.equal(plan.changeSet.counts.modify, 1);
  fixture.relations.apply(plan);

  const text = readFileSync(abs, 'utf8');
  assert.match(text, /draft: false\nlinks:\n {2}- title: Hugo\n {4}website: https:\/\/gohugo\.io\n/);
  assert.equal((await fixture.relations.links({ path })).items[0].website, 'https://gohugo.io');
});

test('editing an unknown key is refused unless the document already uses it', async (t) => {
  const fixture = makeFixture(t);
  const plan = await fixture.relations.planLinkEdits({ path: LINKS_PATH, edit: [{ index: 0, set: { nonsense: 'x' } }] });
  assert.equal(plan.changeSet.counts.total, 0);
  assert.equal(plan.skipped[0].reason.includes('没有 nonsense 字段'), true);
});

test('malformed data is reported and left alone', () => {
  const frontMatter = '---\ntitle: x\nlinks:\n  - https://example.com\n  - title: Ok\n    website: https://ok.example\n---\n';
  const model = readLinks(frontMatter);
  assert.equal(model.items.length, 1);
  assert.equal(model.items[0].title, 'Ok');
  assert.equal(model.malformed.length, 1);
  assert.equal(model.malformed[0].reason.includes('不是键值映射'), true);

  // A scalar entry is not rewritten by an edit of the map entry: the malformed line stays.
  const result = planLinkEdits({ block: model.block, parsed: model.parsed, keyOrder: model.keyOrder, edit: [{ index: 1, set: { website: 'https://changed.example' } }] });
  assert.equal(result.changed, true);
  assert.ok(result.block.includes('- https://example.com'));
  assert.ok(result.block.includes('website: https://changed.example'));
});

test('remove, edit and move in one plan all address the list as it was read', () => {
  const block = [
    'links:',
    '  - title: A',
    '    website: https://a.example',
    '  - title: B',
    '    website: https://b.example',
    '  - title: C',
    '    website: https://c.example',
    '',
  ].join('\n');
  const parsed = readLinks(`---\n${block}---\n`);

  // Remove B (index 1), edit A (index 0), move C (index 2) to the top: every index is the one
  // from the file, even though the removal happens first internally.
  const result = planLinkEdits({
    block: parsed.block,
    parsed: parsed.parsed,
    keyOrder: parsed.keyOrder,
    remove: [1],
    edit: [{ index: 0, set: { website: 'https://a2.example' } }],
    move: [{ from: 2, to: 0 }],
  });

  assert.deepEqual(result.skipped, []);
  const titles = [...result.block.matchAll(/^ {2}- title: (.*)$/gm)].map((match) => match[1]);
  assert.deepEqual(titles, ['C', 'A']);
  assert.ok(result.block.includes('website: https://a2.example'));
  assert.ok(!result.block.includes('https://b.example'));
});

test('link image references are classified and unsafe ones refused', () => {
  const resources = { resourceNames: ['fixture-logo.jpg'], resourcePaths: ['page/links/fixture-logo.jpg'] };
  assert.equal(classifyLinkImage('https://github.com/x.png', resources).kind, 'external');
  assert.equal(classifyLinkImage('//cdn.example.com/x.png', resources).kind, 'external');
  assert.equal(classifyLinkImage('fixture-logo.jpg', resources).kind, 'resource');
  assert.equal(classifyLinkImage('missing.png', resources).kind, 'missing-resource');
  assert.equal(classifyLinkImage('/images/logo.png', resources).kind, 'absolute-path');
  assert.equal(classifyLinkImage('', resources).kind, 'empty');

  assert.equal(isSafeImageReference('fixture-logo.jpg'), true);
  assert.equal(isSafeImageReference('sub/dir/x.png'), true);
  assert.equal(isSafeImageReference('../../etc/passwd'), false);
  assert.equal(isSafeImageReference('~/.ssh/id_rsa'), false);
  assert.equal(isSafeImageReference(''), false);

  const block = 'links:\n  - title: A\n    website: https://a.example\n';
  const parsed = readLinks(`---\n${block}---\n`);
  const escaped = planLinkEdits({ block: parsed.block, parsed: parsed.parsed, keyOrder: parsed.keyOrder, add: [{ title: 'B', website: 'https://b.example', image: '../../secret.png' }] });
  assert.equal(escaped.changed, false);
  assert.equal(escaped.skipped[0].reason.includes('不是安全的引用'), true);
});

test('a new links block for a document without one keeps the site key order', () => {
  const block = renderNewLinksBlock([{ title: 'A', website: 'https://a.example', image: 'https://a.example/i.png' }]);
  assert.equal(block, 'links:\n  - title: A\n    website: https://a.example\n    image: https://a.example/i.png\n');
});

test('a no-op link edit writes nothing, including when the value is already there', async (t) => {
  const fixture = makeFixture(t);
  const abs = join(fixture.contentRoot, LINKS_PATH);
  const before = readFileSync(abs, 'utf8');
  const plan = await fixture.relations.planLinkEdits({ path: LINKS_PATH, edit: [{ index: 0, set: { website: 'https://github.com' } }] });
  assert.equal(plan.changeSet.counts.total, 0);
  assert.equal(plan.changeSet.noop, true);
  const result = fixture.relations.apply(plan);
  assert.equal(result.status, 'committed');
  assert.equal(readFileSync(abs, 'utf8'), before);
  assert.equal(fingerprint(readFileSync(abs, 'utf8')), fingerprint(before));
});

test('editing a links page that does not exist fails before any write', async (t) => {
  const fixture = makeFixture(t);
  await assert.rejects(() => fixture.relations.planLinkEdits({ path: 'page/links/nope.md', add: [{ title: 'x', website: 'y' }] }), /nope\.md|not found|NotFound/i);
  assert.equal(existsSync(join(fixture.contentRoot, 'page', 'links', 'nope.md')), false);
  // A path that escapes the content root is refused by the same guard the editor uses.
  await assert.rejects(() => fixture.relations.planLinkEdits({ path: '../../etc/passwd', add: [{ title: 'x', website: 'y' }] }));
});

test('links survive a write of unrelated front matter fields', async (t) => {
  const fixture = makeFixture(t);
  const abs = join(fixture.contentRoot, LINKS_PATH);
  const before = readFileSync(abs, 'utf8');
  // The Phase 3 form still refuses list-of-maps, so it must skip links rather than flatten it.
  const preview = fixture.documentService.previewFields({ path: LINKS_PATH, set: { comments: true } });
  assert.equal(preview.status, 'preview');
  fixture.documentService.saveFields({ path: LINKS_PATH, set: { comments: true } });
  const after = readFileSync(abs, 'utf8');
  // The field form rewrote its one boolean and left the links block above it alone, because a
  // form that cannot represent a list of maps must not touch one.
  assert.equal(after, before.replace('comments: false', 'comments: true'));
  const frontMatterRaw = after.slice(after.indexOf('---') + 3, after.lastIndexOf('---'));
  assert.equal(readLinks(frontMatterRaw).items.length, 2);
});

// --- the image field is a YAML scalar, never Markdown ------------------------
//
// `image` names a path or a URL; the theme resolves it the way it resolves a cover image. A
// value typed as `![](x.jpg)` is the same reference in the wrong language, and a Markdown image
// in YAML can only ever be a broken reference - so the serializer stores the destination, and
// the fixture page (two items, an external URL and a bundle resource) is the proof.

test('a plain image path survives a rewrite as a plain YAML string (case A)', async (t) => {
  const fixture = makeFixture(t);
  const abs = join(fixture.contentRoot, LINKS_PATH);
  const before = readFileSync(abs, 'utf8');

  // Writing the value that is already there changes nothing at all.
  const noop = await fixture.relations.planLinkEdits({ path: LINKS_PATH, edit: [{ index: 1, set: { image: 'fixture-logo.jpg' } }] });
  assert.equal(noop.changeSet.noop, true);

  const plan = await fixture.relations.planLinkEdits({ path: LINKS_PATH, edit: [{ index: 1, set: { image: 'fixture-photo-2.jpg' } }] });
  fixture.relations.apply(plan);
  const after = readFileSync(abs, 'utf8');
  assert.equal(after, before.replace('image: fixture-logo.jpg', 'image: fixture-photo-2.jpg'));
  assert.equal(after.includes('!['), false, 'a save must never introduce Markdown image syntax');
});

test('a Chinese image file name stays a legal YAML string (case B)', async (t) => {
  const fixture = makeFixture(t);
  const abs = join(fixture.contentRoot, LINKS_PATH);
  const before = readFileSync(abs, 'utf8');

  const plan = await fixture.relations.planLinkEdits({ path: LINKS_PATH, edit: [{ index: 1, set: { image: '空间号头像.jpg' } }] });
  fixture.relations.apply(plan);
  const after = readFileSync(abs, 'utf8');
  assert.equal(after, before.replace('image: fixture-logo.jpg', 'image: 空间号头像.jpg'));
  assert.equal(after.includes('!['), false);
  // The rest of the file - the other link's bytes included - is untouched.
  assert.equal(after.includes('image: https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png'), true);
});

test('Markdown image syntax in the image field is stored as its destination', async (t) => {
  const fixture = makeFixture(t);
  const abs = join(fixture.contentRoot, LINKS_PATH);

  const plan = await fixture.relations.planLinkEdits({ path: LINKS_PATH, edit: [{ index: 1, set: { image: '![](空间号头像.jpg)' } }] });
  fixture.relations.apply(plan);
  const after = readFileSync(abs, 'utf8');
  assert.equal(after.includes('image: 空间号头像.jpg'), true);
  assert.equal(after.includes('!['), false, 'the YAML must hold the destination, not Markdown');

  const added = await fixture.relations.planLinkEdits({ path: LINKS_PATH, add: [{ title: 'B站', website: 'https://space.bilibili.com/174863977', image: '![](b站头像.jpg)' }] });
  fixture.relations.apply(added);
  const withAdd = readFileSync(abs, 'utf8');
  assert.equal(withAdd.includes('image: b站头像.jpg'), true);
  assert.equal(withAdd.includes('!['), false);
  // It is still a links list of three items that the model can read back.
  assert.equal(readLinks(withAdd.slice(withAdd.indexOf('---') + 3, withAdd.lastIndexOf('---'))).items.length, 3);
});

test('unwrapping Markdown must not launder an unsafe image reference', () => {
  const block = 'links:\n  - title: A\n    website: https://a.example\n    image: a.jpg\n';
  const parsed = readLinks(`---\n${block}---\n`);
  const escaped = planLinkEdits({ block: parsed.block, parsed: parsed.parsed, keyOrder: parsed.keyOrder, add: [{ title: 'B', website: 'https://b.example', image: '![](../../secret.png)' }] });
  assert.equal(escaped.changed, false);
  assert.equal(escaped.skipped[0].reason.includes('不是安全的引用'), true);
  assert.equal(escaped.block.includes('secret'), false);
});

test('normalizeImageReference leaves everything it cannot read alone', () => {
  assert.equal(normalizeImageReference('example.jpg'), 'example.jpg');
  assert.equal(normalizeImageReference('![](example.jpg)'), 'example.jpg');
  assert.equal(normalizeImageReference('![alt](../img/example.jpg)'), '../img/example.jpg');
  assert.equal(normalizeImageReference('![](<example with space.jpg>)'), 'example with space.jpg');
  assert.equal(normalizeImageReference('![](example.jpg "标题")'), 'example.jpg');
  // Not one whole Markdown image: prose, a stray `)` or a title-only fragment is data.
  assert.equal(normalizeImageReference('see ![](example.jpg) here'), 'see ![](example.jpg) here');
  assert.equal(normalizeImageReference('![](a(b).jpg)'), '![](a(b).jpg)');
  assert.equal(normalizeImageReference(''), '');
});
