// The reference model, on its own: which strings Hugo can resolve and which ones it cannot.
// The end-to-end proof (a real Hugo build) lives in imageReferences.test.js; this file pins
// the decisions, so a change of mind has to be a change of test.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bundleOfDocument,
  bundleRelative,
  classifyReference,
  describeReferenceKind,
  isResolvable,
  markdownDestination,
  referenceForResource,
  referenceForStatic,
} from '../src/site/referenceModel.js';

// One bundle with a flat resource, a nested one and a name with a space; one foreign bundle;
// one static file. The paths are the fixture site's, which imageReferences.test.js builds.
const CONTEXT = {
  documentPath: 'post/fixture-bundle/index.md',
  bundlePath: 'post/fixture-bundle',
  // bundle-relative names, exactly as Hugo addresses a page resource
  bundleResources: ['fixture-photo.jpg', 'images/deep.png', 'two words.png'],
  // content-root-relative paths: every resource file in the tree
  contentResources: [
    'post/fixture-bundle/fixture-photo.jpg',
    'post/fixture-bundle/images/deep.png',
    'post/fixture-bundle/two words.png',
    'categories/fixture-category/fixture-banner.png',
    'page/links/fixture-logo.jpg',
  ],
  staticPaths: ['img/logo.png'],
  assetPaths: ['scss/custom.scss'],
  isPublished: null,
};

const classify = (value, overrides = {}) => classifyReference(value, { ...CONTEXT, ...overrides });

test('a bundle-relative name is a page resource - the one form Hugo resolves', () => {
  const verdict = classify('fixture-photo.jpg');
  assert.equal(verdict.kind, 'page-resource');
  assert.equal(verdict.ok, true);
  assert.equal(isResolvable(verdict), true);
});

test('a nested resource keeps its subdirectory, and ./ is the same file', () => {
  assert.deepEqual(classify('images/deep.png').kind, 'page-resource');
  assert.equal(classify('images/deep.png').ok, true);
  const dotted = classify('./images/deep.png');
  assert.equal(dotted.ok, false, 'the editor normalises instead of writing ./');
  assert.equal(dotted.normalized, 'images/deep.png');
  assert.equal(dotted.suggestion, 'images/deep.png');
});

test('a name with a space is only resolvable in the angle-bracket form', () => {
  const bare = classify('two words.png');
  assert.equal(bare.kind, 'page-resource');
  assert.equal(bare.ok, false);
  assert.equal(bare.suggestion, '<two words.png>');
  const wrapped = classify('<two words.png>');
  assert.equal(wrapped.ok, true, 'the angle form is what Hugo/Goldmark can parse');
  assert.equal(markdownDestination('two words.png'), '<two words.png>');
  assert.equal(markdownDestination('fixture-photo.jpg'), 'fixture-photo.jpg');
});

test('a source-tree path is refused, whichever way it is written', () => {
  for (const value of [
    'categories/fixture-category/fixture-banner.png',
    'content/categories/fixture-category/fixture-banner.png',
    '/categories/fixture-category/fixture-banner.png',
    'post/fixture-bundle/fixture-photo.jpg',
    'content/post/fixture-bundle/fixture-photo.jpg',
  ]) {
    const verdict = classify(value);
    assert.equal(verdict.ok, false, `${value} must not be written verbatim`);
    assert.ok(verdict.reason.length > 0, `${value} needs a reason`);
  }
  // A source path that points at the document's OWN resource is one suggestion away.
  for (const value of ['post/fixture-bundle/fixture-photo.jpg', 'content/post/fixture-bundle/fixture-photo.jpg']) {
    const verdict = classify(value);
    assert.equal(verdict.kind, 'page-resource');
    assert.equal(verdict.suggestion, 'fixture-photo.jpg');
  }
  // One that points into another bundle is refused as such, never rewritten into a URL.
  for (const value of ['categories/fixture-category/fixture-banner.png', '/categories/fixture-category/fixture-banner.png']) {
    const verdict = classify(value);
    assert.ok(['source-path', 'foreign-resource'].includes(verdict.kind), `${value} -> ${verdict.kind}`);
    assert.equal(String(verdict.suggestion ?? '').includes('fixture-banner.png'), false, 'no guessed URL');
  }
});

test('the case of a published URL is not the case of the source directory', () => {
  // The real site: content/categories/Documentation/ publishes as /categories/documentation/.
  const verdict = classifyReference('/categories/Documentation/hash.jpg', {
    ...CONTEXT,
    contentResources: ['categories/Documentation/hash.jpg'],
    isPublished: () => false,
  });
  assert.equal(verdict.kind, 'source-path');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /大小写/);
});

test('a file in another page bundle is refused and names its owner', () => {
  const verdict = classify('categories/fixture-category/fixture-banner.png');
  assert.equal(verdict.kind, 'foreign-resource');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.owner, 'categories/fixture-category');
  assert.match(verdict.reason, /categories\/fixture-category/);
  const plain = classifyReference('fixture-banner.png', { ...CONTEXT, contentResources: ['categories/fixture-category/fixture-banner.png'] });
  // The name alone exists in exactly one foreign bundle: still not resolvable from here.
  assert.equal(plain.ok, false);
  assert.equal(plain.kind, 'foreign-resource');
  assert.match(plain.reason, /categories\/fixture-category/);
});

test('a name that exists in two bundles is ambiguous, not a guess', () => {
  const verdict = classifyReference('logo.png', {
    ...CONTEXT,
    contentResources: ['post/a/logo.png', 'post/b/logo.png'],
  });
  assert.equal(verdict.kind, 'ambiguous-name');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.candidates.length, 2);
});

test('static files are referenced by an absolute path - and only that way', () => {
  assert.equal(classifyReference('/img/logo.png', { ...CONTEXT, isPublished: () => true }).ok, true);
  assert.equal(classifyReference('/img/logo.png', CONTEXT).kind, 'site-url');
  const wrong = classify('static/img/logo.png');
  assert.equal(wrong.kind, 'site-url');
  assert.equal(wrong.ok, false);
  assert.equal(wrong.suggestion, '/img/logo.png');
});

test('assets/ is a pipeline input, not a referenceable file', () => {
  for (const value of ['assets/scss/custom.scss', 'scss/custom.scss']) {
    const verdict = classify(value);
    assert.equal(verdict.kind, 'pipeline-asset');
    assert.equal(verdict.ok, false);
  }
});

test('external addresses are left alone', () => {
  for (const value of ['https://example.com/a.png', 'http://example.com/a.png', '//example.com/a.png', 'data:image/png;base64,AAAA']) {
    assert.equal(classify(value).kind, 'external', value);
    assert.equal(classify(value).ok, true, value);
  }
});

test('an absolute path the build did not publish is reported as such', () => {
  const verdict = classifyReference('/categories/documentation/hash.jpg', { ...CONTEXT, isPublished: () => false });
  assert.equal(verdict.kind, 'unpublished-url');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /最近一次构建/);
  const published = classifyReference('/categories/documentation/hash.jpg', { ...CONTEXT, isPublished: () => true });
  assert.equal(published.ok, true);
});

// A branch bundle publishes its resources under the page's own URL, so a working URL can differ
// from the content path only by case - and a working URL must never be refused. The mistake
// (writing the content path with the source tree's capitalisation) is still caught.
test('a published URL wins over the source path that looks just like it', () => {
  const context = {
    ...CONTEXT,
    contentResources: ['categories/Documentation/hutomo.jpg'],
    isPublished: (url) => url === '/categories/documentation/hutomo.jpg',
  };
  const published = classifyReference('/categories/documentation/hutomo.jpg', context);
  assert.equal(published.kind, 'site-url');
  assert.equal(published.ok, true);

  const sourcePath = classifyReference('/categories/Documentation/hutomo.jpg', context);
  assert.equal(sourcePath.kind, 'source-path');
  assert.equal(sourcePath.ok, false);
  assert.equal(sourcePath.source, 'content/categories/Documentation/hutomo.jpg');
  assert.match(sourcePath.reason, /大小写/);
});

test('a single-file post cannot own page resources, and is told so', () => {
  const verdict = classifyReference('image.png', {
    documentPath: 'post/第壹篇.md',
    bundlePath: bundleOfDocument('post/第壹篇.md'),
    contentResources: [],
    bundleResources: [],
  });
  assert.equal(verdict.kind, 'no-bundle');
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /单文件/);
  assert.match(verdict.suggestion, /static\//);
});

test('an unknown name in a bundle is not silently accepted either', () => {
  const verdict = classify('missing.png');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.kind, 'page-resource');
  assert.match(verdict.reason, /bundle（post\/fixture-bundle）/);
});

test('empty references have their own kind', () => {
  assert.equal(classify('').kind, 'empty');
  assert.equal(classify('   ').ok, false);
});

// --- the two helpers the UI uses to build a reference -----------------------

test('bundleRelative only answers for files inside the bundle', () => {
  assert.equal(bundleRelative('post/foo', 'post/foo/image.png'), 'image.png');
  assert.equal(bundleRelative('post/foo', 'post/foo/images/deep.png'), 'images/deep.png');
  assert.equal(bundleRelative('post/foo', 'post/bar/image.png'), null);
  assert.equal(bundleRelative('post/foo', 'post/foo/index.md'), 'index.md');
  assert.equal(bundleRelative('', 'image.png'), null);
});

test('referenceForResource gives the bundle-relative form, or refuses', () => {
  assert.deepEqual(referenceForResource({ documentPath: 'post/foo/index.md', resourcePath: 'post/foo/image.png' }), {
    ok: true,
    kind: 'page-resource',
    reference: 'image.png',
    relative: 'image.png',
  });
  const foreign = referenceForResource({ documentPath: 'post/foo/index.md', resourcePath: 'categories/cat/banner.png' });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reference, null);
  assert.match(foreign.reason, /categories\/cat/);
  const spaced = referenceForResource({ documentPath: 'post/foo/index.md', resourcePath: 'post/foo/two words.png' });
  assert.equal(spaced.reference, '<two words.png>');
  // The directory inside the bundle is part of the reference: a file name alone is a URL
  // relative to the page, which is how an image ends up published but never displayed.
  const nested = referenceForResource({ documentPath: 'post/foo/index.md', resourcePath: 'post/foo/images/deep.png' });
  assert.equal(nested.relative, 'images/deep.png');
  assert.equal(nested.reference, 'images/deep.png');
  assert.equal(
    referenceForResource({ documentPath: 'post/foo/index.md', resourcePath: 'post/foo/images/two words.png' }).reference,
    '<images/two words.png>',
  );
});

test('referenceForStatic produces the site-root URL', () => {
  assert.deepEqual(referenceForStatic('img/logo.png'), { ok: true, kind: 'site-url', reference: '/img/logo.png', relative: 'img/logo.png' });
  assert.equal(referenceForStatic('').ok, false);
});

test('bundleOfDocument mirrors Hugo: only index/_index files live in a bundle', () => {
  assert.equal(bundleOfDocument('post/foo/index.md'), 'post/foo');
  assert.equal(bundleOfDocument('post/foo/index.en.md'), 'post/foo');
  assert.equal(bundleOfDocument('categories/Documentation/_index.md'), 'categories/Documentation');
  assert.equal(bundleOfDocument('post/foo.md'), null);
  assert.equal(bundleOfDocument('_index.md'), null);
});

test('every kind has a label, and an unknown kind is not silently labelled', () => {
  const kinds = ['page-resource', 'site-url', 'external', 'source-path', 'foreign-resource', 'pipeline-asset', 'unpublished-url', 'no-bundle', 'ambiguous-name', 'empty'];
  const labels = kinds.map((kind) => describeReferenceKind(kind));
  for (const [index, kind] of kinds.entries()) {
    assert.ok(labels[index].length > 0, kind);
  }
  assert.equal(new Set(labels).size, kinds.length, 'labels are distinct');
  assert.equal(describeReferenceKind('empty'), '空引用');
  assert.equal(describeReferenceKind('nonsense'), '未知引用类型');
});
