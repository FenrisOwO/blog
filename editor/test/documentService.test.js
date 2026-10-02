// P1.5 acceptance tests: edit -> preview (dry run) -> commit -> read back.
//
// Every test works on a copy of the fixture corpus (test/fixtures/README.md), so the suite
// neither needs nor touches whatever the user has written in their own site.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { joinDocument, readDocument, splitDocument } from '../src/frontmatter/index.js';
import { UnterminatedFrontMatterError, createDocumentService } from '../src/site/documentService.js';
import { PathGuard } from '../src/site/paths.js';
import { saveSafely } from '../src/site/safeWrite.js';
import { FIXTURE, makeFixtureSandbox } from './fixtures/harness.js';

const SAMPLE = FIXTURE.article;
const BUNDLE = FIXTURE.bundle;

function makeSandbox(t) {
  return makeFixtureSandbox(t, { prefix: 'hve-svc-' });
}

function makeService(sandbox, options = {}) {
  return createDocumentService({
    contentRoot: sandbox.contentRoot,
    siteRoot: sandbox.siteRoot,
    section: 'post',
    backupRoot: sandbox.backupRoot,
    ...options,
  });
}

function disk(sandbox, path) {
  return readFileSync(join(sandbox.contentRoot, path), 'utf8');
}

function appendToBody(text, addition) {
  const parts = splitDocument(text);
  return joinDocument({ ...parts, bodyRaw: `${parts.bodyRaw}\n${addition}\n` });
}

function tokenCounts(text) {
  const tokens = ['{{<', '{{%', '```mermaid', '$$', '```', '<!--more-->', '<div', '</div>'];
  return Object.fromEntries(tokens.map((token) => [token, text.split(token).length - 1]));
}

test('body edit: preview is a dry run, commit writes, backs up and re-reads', (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  const before = disk(sandbox, SAMPLE);
  const target = appendToBody(before, '新增段落。');

  const preview = service.previewEdit({ path: SAMPLE, text: target });
  assert.equal(preview.status, 'preview');
  assert.equal(preview.frontMatter.bodyChanged, true);
  assert.deepEqual(preview.frontMatter.changedKeys, []);
  assert.match(preview.diffText, /\+ 新增段落。/);

  // Dry run must leave both the file and the backup area untouched.
  assert.equal(disk(sandbox, SAMPLE), before);
  assert.equal(existsSync(sandbox.backupRoot), false);

  const result = service.saveEdit({ path: SAMPLE, text: target });
  assert.equal(result.status, 'written');
  assert.equal(result.shaBefore, preview.shaBefore);
  assert.notEqual(result.shaAfter, result.shaBefore);
  assert.equal(result.onDiskMatchesTarget, true);
  assert.equal(disk(sandbox, SAMPLE), target);
  assert.equal(readFileSync(result.backupPath, 'utf8'), before);

  const verify = service.verify(SAMPLE, target);
  assert.equal(verify.matches, true);
  assert.equal(verify.sha, result.shaAfter);
  assert.equal(service.verify(SAMPLE, `${target}stale`).matches, false);
});

test('managed front matter field: exactly one line changes and siblings are intact', (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  const before = disk(sandbox, BUNDLE);
  const title = readDocument(before).values.title;
  // `image` is a resource reference, not a typed form field, so read it off the raw text.
  const image = splitDocument(before).frontMatterRaw.match(/^image: (.+)$/m)[1];
  const target = before.replace(`title: ${title}`, `title: ${title}（改名）`);
  assert.notEqual(target, before);

  const preview = service.previewEdit({ path: BUNDLE, text: target });
  assert.deepEqual(preview.frontMatter.changedKeys, ['title']);
  assert.deepEqual(preview.frontMatter.unknownChangedKeys, []);
  assert.equal(preview.frontMatter.bodyChanged, false);
  assert.equal(preview.diff.added, 1);
  assert.equal(preview.diff.removed, 1);
  assert.match(preview.diffText, new RegExp(`\\+ title: ${title}（改名）`));

  const result = service.saveEdit({ path: BUNDLE, text: target });
  assert.equal(result.status, 'written');
  assert.equal(result.onDiskMatchesTarget, true);

  const after = disk(sandbox, BUNDLE);
  assert.match(after, new RegExp(`image: ${image}`), 'the sibling image field is untouched');
  assert.match(after, /toc: false/);
});

test('unknown front matter keys are reported and stay unchanged on a body edit', (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  const before = disk(sandbox, BUNDLE);
  const target = appendToBody(before, '只改正文。');

  const preview = service.previewEdit({ path: BUNDLE, text: target });
  assert.deepEqual(preview.frontMatter.unknownChangedKeys, []);
  assert.equal(preview.frontMatter.bodyChanged, true);
  assert.equal(splitDocument(target).frontMatterRaw, splitDocument(before).frontMatterRaw);

  const result = service.saveEdit({ path: BUNDLE, text: target });
  assert.equal(result.status, 'written');
  assert.equal(splitDocument(disk(sandbox, BUNDLE)).frontMatterRaw, splitDocument(before).frontMatterRaw);
});

test('touching an unknown key is surfaced as a warning instead of passing silently', (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  const before = disk(sandbox, BUNDLE);
  const target = before.replace('toc: false', 'toc: true');

  const preview = service.previewEdit({ path: BUNDLE, text: target });
  assert.deepEqual(preview.frontMatter.unknownChangedKeys, ['toc']);
  assert.ok(preview.warnings.some((warning) => warning.includes('toc')));
});

test('shortcodes, Mermaid, math, fenced code and images survive a body edit', (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  // One fixture document carries every construct (shortcode, Mermaid, math, fenced code, an
  // image, a raw <div>, an excerpt marker); its language siblings and the bundle come along.
  const targets = [FIXTURE.markdownZh, FIXTURE.markdown, BUNDLE];

  for (const path of targets) {
    const before = disk(sandbox, path);
    const target = appendToBody(before, '新增段落。');

    // Appending to the body must not rewrite a single byte of the original file.
    assert.ok(target.startsWith(before), `${path}: original text must be a prefix of the target`);
    assert.deepEqual(tokenCounts(target), tokenCounts(before), `${path}: special constructs changed`);

    const result = service.saveEdit({ path, text: target });
    assert.equal(result.status, 'written', path);
    assert.equal(result.onDiskMatchesTarget, true, path);

    const after = disk(sandbox, path);
    assert.ok(after.startsWith(before), `${path}: nothing before the edit may change`);
    assert.deepEqual(tokenCounts(after), tokenCounts(before), path);
  }
});

test('a no-op save writes nothing and creates no backup', (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  const before = disk(sandbox, SAMPLE);
  const mtimeBefore = statSync(join(sandbox.contentRoot, SAMPLE)).mtimeMs;

  const preview = service.previewEdit({ path: SAMPLE, text: before });
  assert.equal(preview.status, 'noop');
  assert.equal(preview.diff.changed, 0);

  const result = service.saveEdit({ path: SAMPLE, text: before });
  assert.equal(result.status, 'noop');
  assert.equal(result.backupPath, null);
  assert.equal(result.shaAfter, result.shaBefore);
  assert.equal(disk(sandbox, SAMPLE), before);
  assert.equal(statSync(join(sandbox.contentRoot, SAMPLE)).mtimeMs, mtimeBefore);
  assert.equal(existsSync(sandbox.backupRoot), false);
});

test('previewing without committing (cancel) leaves the disk untouched', (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  const before = disk(sandbox, SAMPLE);
  const shaBefore = service.verify(SAMPLE, before).sha;

  service.previewEdit({ path: SAMPLE, text: appendToBody(before, '被放弃的修改') });

  assert.equal(disk(sandbox, SAMPLE), before);
  assert.equal(service.verify(SAMPLE, before).sha, shaBefore);
  assert.equal(existsSync(sandbox.backupRoot), false);
});

test('the service refuses paths it did not identify', (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  for (const path of ['../hugo.toml', 'page/about/index.md', '/etc/passwd', 'post/does-not-exist.md', '']) {
    assert.throws(() => service.saveEdit({ path, text: 'x' }), /document not found/, path);
  }
  assert.equal(existsSync(sandbox.backupRoot), false);
});

test('SafeWriter still rejects out-of-scope paths inside the service content root', (t) => {
  const sandbox = makeSandbox(t);
  const guard = new PathGuard({ contentRoot: sandbox.contentRoot });

  for (const path of ['../hugo.toml', 'page/about/index.md', '/etc/passwd', 'post/notes.txt']) {
    assert.throws(
      () => saveSafely({ guard, relPath: path, nextText: 'x', backupRoot: sandbox.backupRoot }),
      /outside|absolute path|only \.md/i,
      path,
    );
  }
  assert.equal(existsSync(sandbox.backupRoot), false);
});

// --- Phase Insert A: the listing memo ---------------------------------------
//
// The memo is only ever allowed to be a listing. These tests pin the properties that make
// it safe: a write through the service is visible to the very next listing, and an edit
// made outside the editor can hide only for as long as the memo's own lifetime.

async function titleOf(service, path) {
  return (await service.listDocuments()).find((doc) => doc.path === path)?.meta?.title;
}

test('a write through the service is visible to the very next listing', async (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  const before = await titleOf(service, SAMPLE);
  assert.ok(before, 'sample document is listed');

  const renamed = disk(sandbox, SAMPLE).replace(`title: ${before}`, 'title: 性能测试标题');
  assert.notEqual(renamed, disk(sandbox, SAMPLE), 'sample really has a title to rename');
  service.saveEdit({ path: SAMPLE, text: renamed });
  assert.equal(await titleOf(service, SAMPLE), '性能测试标题', 'save is visible immediately');

  const created = service.createDocument({ section: 'post', kind: 'standalone', title: 'Memo 新建', today: '2026-01-01' });
  assert.ok((await service.listDocuments()).some((doc) => doc.path === created.path), 'create is visible immediately');

  service.removeDocument({ path: created.path });
  assert.equal((await service.listDocuments()).some((doc) => doc.path === created.path), false, 'delete is visible immediately');

  const trashId = service.trash()[0]?.id;
  service.restore({ id: trashId });
  assert.ok((await service.listDocuments()).some((doc) => doc.path === created.path), 'restore is visible immediately');
});

test('an edit from outside the editor is visible immediately', async (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  assert.ok(await titleOf(service, SAMPLE), 'sample is listed');
  writeFileSync(join(sandbox.contentRoot, SAMPLE), disk(sandbox, SAMPLE).replace(/title: .*/, 'title: 外部改动'), 'utf8');

  assert.equal(await titleOf(service, SAMPLE), '外部改动', 'a listing must not hide someone else\'s edit');
});

test('reading one document never depends on the listing', async (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  await service.listDocuments();
  const fresh = disk(sandbox, SAMPLE).replace(/title: .*/, 'title: 直接读取');
  writeFileSync(join(sandbox.contentRoot, SAMPLE), fresh, 'utf8');

  assert.equal(service.read(SAMPLE).text, fresh, 'text comes from disk, not from the listing');
  assert.match(service.read(SAMPLE).doc.meta.title, /直接读取/);
});

test('locating a document by path does not need a listing', (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  // A file that exists on disk but was never listed still resolves: the path is the ID.
  mkdirSync(join(sandbox.contentRoot, 'post', 'deep'), { recursive: true });
  writeFileSync(join(sandbox.contentRoot, 'post', 'deep', 'nested.md'), '---\ntitle: 深层文档\n---\n\nbody\n', 'utf8');

  assert.equal(service.read('post/deep/nested.md').doc.meta.title, '深层文档');
  assert.ok(service.fields('post/deep/nested.md').fields.length > 0);
});

test('an external edit of the same size is caught by the file signature, not the clock', async (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  const title = readDocument(disk(sandbox, SAMPLE)).values.title;
  assert.equal(await titleOf(service, SAMPLE), title);
  // Same byte count, different bytes: only the file signature can catch this.
  const other = `${title[0]}${'x'.repeat(title.length - 1)}`;
  const sameLength = disk(sandbox, SAMPLE).replace(`title: ${title}`, `title: ${other}`);
  assert.equal(sameLength.length, disk(sandbox, SAMPLE).length, 'the rewrite keeps the byte count');
  writeFileSync(join(sandbox.contentRoot, SAMPLE), sameLength, 'utf8');

  assert.equal(await titleOf(service, SAMPLE), other, 'a listing is not allowed to serve a stale title');
  assert.equal(service.fields(SAMPLE).fields.find((f) => f.key === 'title').value, other);
});

test('a bundle keeps its resources after a cached description is reused', async (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);

  const bundlePrefix = `${FIXTURE.bundle.slice(0, FIXTURE.bundle.lastIndexOf('/'))}/`;
  const first = (await service.listResources()).filter((resource) => resource.path.startsWith(bundlePrefix));
  const second = (await service.listResources()).filter((resource) => resource.path.startsWith(bundlePrefix));
  assert.ok(first.length > 0, 'the sample bundle has resources');
  assert.deepEqual(second, first, 'reusing a cached bundle description keeps the resources identical');

  // Adding a resource touches the bundle directory, which must invalidate that description.
  writeFileSync(join(sandbox.contentRoot, dirname(FIXTURE.bundle), 'probe.png'), 'png');
  const after = (await service.listResources()).filter((resource) => resource.path.startsWith(bundlePrefix));
  assert.ok(after.some((resource) => resource.path.endsWith('probe.png')), 'a new resource is discovered');
  assert.equal(after.length, first.length + 1, 'and only it was added');
});

// --- the raw save refuses to write an unparseable front matter ---------------
//
// The raw path exists so the editor can write what the user sees, byte for byte. What it must
// not write is a document whose front matter never closes: Hugo answers that with
// "EOF looking for end YAML front matter delimiter" and the page is unreachable until a human
// edits it outside the editor.

test('a save that drops the closing delimiter is refused and writes nothing (case D)', (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);
  const before = disk(sandbox, SAMPLE);

  // Exactly the damage the editor produced: a `links` page whose YAML lost its closing `---`.
  const damaged = ['---', 'title: "链接"', 'links:', '  - title: QQ-主号', '    image: 大号头像.jpg', ''].join('\n');
  assert.throws(() => service.saveEdit({ path: SAMPLE, text: damaged }), UnterminatedFrontMatterError);
  assert.equal(disk(sandbox, SAMPLE), before, 'the refused save must not touch the file');
  assert.equal(existsSync(join(sandbox.backupRoot, '')), false, 'and must not leave a backup behind');

  // The preview says what is wrong before the user tries to save.
  const preview = service.previewEdit({ path: SAMPLE, text: damaged });
  assert.equal(preview.status, 'preview');
  assert.equal(preview.warnings.some((line) => line.includes('没有结尾')), true);
  assert.equal(disk(sandbox, SAMPLE), before);
});

test('a well-formed save keeps the delimiters and a body image (case D, case C)', (t) => {
  const sandbox = makeSandbox(t);
  const service = makeService(sandbox);
  const before = disk(sandbox, SAMPLE);

  const withImage = appendToBody(before, '正文图片：![](keep-me.jpg)');
  const result = service.saveEdit({ path: SAMPLE, text: withImage });
  assert.equal(result.status, 'written');
  assert.equal(result.onDiskMatchesTarget, true);

  const after = disk(sandbox, SAMPLE);
  const parts = splitDocument(after);
  assert.equal(parts.hasFrontMatter, true, 'the saved file must still be parseable');
  assert.equal(after.startsWith('---\n'), true);
  assert.equal(parts.frontMatterRaw.endsWith('---'), true);
  assert.equal(after.includes('![](keep-me.jpg)'), true, 'Markdown in the body is not touched');
  assert.equal(splitDocument(before).frontMatterRaw, parts.frontMatterRaw, 'front matter unchanged');
});
