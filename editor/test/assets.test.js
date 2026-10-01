// Phase 6: binary resources as their own domain object.
//
// Four layers are covered here, in the order they are reached: the byte layer (digest, sniff,
// atomic write), the resource model (what a file is, who owns it, what may be done to it), the
// path guard (doors, not suggestions), and the asset service (list -> plan -> write -> restore).
//
// The service is exercised on a temp copy of the real content tree with real bytes, never on
// the site: an upload that went wrong in a test would be a deleted image in the user's site.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASSET_MAX_BYTES,
  atomicWriteBytes,
  extensionOf,
  formatBytes,
  mimeForExtension,
  sha256Bytes,
  sniffBytes,
  typeForMime,
} from '../src/site/bytes.js';
import { describeResource, describeSiteAsset, suggestAvailableName, validateAssetFileName } from '../src/site/resourceModel.js';
import { createAssetService, AssetValidationError } from '../src/site/assetService.js';
import { createDocumentService } from '../src/site/documentService.js';
import { PathGuard } from '../src/site/paths.js';
import { FIXTURE, FIXTURE_CONTENT, FIXTURE_SITE, makeFixtureSandbox } from './fixtures/harness.js';

const SITE_ROOT = FIXTURE_SITE;
const CONTENT_ROOT = FIXTURE_CONTENT;
// The fixture's leaf bundle with images: this file's subject is what the editor does to the
// resources of a bundle, so it uses a bundle the tests own.
const GALLERY = dirname(FIXTURE.bundle);
const GALLERY_PHOTO = FIXTURE.bundleResource;
const GALLERY_UNUSED = FIXTURE.bundleLooseResource;

// Real bytes, small enough to inline. The service never decodes an image, so what matters is
// that these are recognised formats with the right signatures.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_OTHER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64',
);
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const JPG = readFileSync(join(CONTENT_ROOT, GALLERY_PHOTO));

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');

function sandbox(t) {
  // The fixture's own static/img/logo.png and assets/scss/custom.scss are the site trees this
  // file lists; the theme comes from the installed dependency.
  const fixture = makeFixtureSandbox(t, { prefix: 'hve-assets-', theme: true });
  // The tests below talk about a *site* root: config, static/ and assets/ hang off it.
  const root = fixture.siteRoot;
  const contentRoot = fixture.contentRoot;
  const backupRoot = fixture.backupRoot;
  const documents = createDocumentService({
    contentRoot,
    siteRoot: root,
    sections: ['post', 'page', 'categories', ''],
    backupRoot,
  });
  const service = createAssetService({
    siteRoot: root,
    contentRoot,
    staticRoot: join(root, 'static'),
    assetRoot: join(root, 'assets'),
    backupRoot,
    guard: documents.guard,
    documents,
    defaultLanguage: documents.defaultLanguage,
  });

  return {
    root,
    contentRoot,
    backupRoot,
    service,
    documents,
    guard: documents.guard,
    read: (relPath) => readFileSync(join(contentRoot, relPath)),
    exists: (relPath) => existsSync(join(contentRoot, relPath)),
  };
}

// -- bytes -------------------------------------------------------------------------------

test('the byte layer recognises the formats this phase accepts, and only those', () => {
  assert.equal(sniffBytes(PNG).mime, 'image/png');
  assert.deepEqual(sniffBytes(PNG).extensions, ['.png']);
  assert.equal(sniffBytes(JPG).mime, 'image/jpeg');
  assert.equal(sniffBytes(GIF).mime, 'image/gif');
  assert.equal(sniffBytes(PDF).mime, 'application/pdf');
  assert.equal(sniffBytes(Buffer.from('wOF2\u0000\u0000')).mime, 'font/woff2');
  assert.equal(sniffBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).mime, 'image/svg+xml');

  // Content that is not a format the editor knows is not guessed at.
  assert.equal(sniffBytes(Buffer.from('just some text\n')), null);
  assert.equal(sniffBytes(Buffer.alloc(0)), null);
  assert.equal(sniffBytes('not a buffer'), null);

  // The digest is over the bytes, so it is the same for the fixture and for the file it came
  // from - which is what makes "restored byte-for-byte" a checkable claim later.
  assert.equal(sha256Bytes(JPG), sha(JPG));
  assert.equal(sha256Bytes(PNG), sha256Bytes(Buffer.from(PNG)));

  assert.equal(mimeForExtension('.JPEG'), 'image/jpeg');
  assert.equal(mimeForExtension('.md'), null);
  assert.equal(typeForMime('image/png'), 'image');
  assert.equal(typeForMime('application/pdf'), 'document');
  assert.equal(typeForMime(null), 'other');
  assert.equal(extensionOf('Photo.JPG'), '.jpg');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.00 MB');
});

test('an atomic byte write leaves the bytes it was given, and nothing else', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hve-bytes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const target = join(root, 'nested', 'image.png');
  atomicWriteBytes(target, PNG);
  assert.equal(sha256Bytes(readFileSync(target)), sha256Bytes(PNG));

  // Overwriting is byte-exact too, and no temp file survives the rename.
  atomicWriteBytes(target, PNG_OTHER);
  assert.equal(sha256Bytes(readFileSync(target)), sha256Bytes(PNG_OTHER));
  assert.deepEqual(readdirSync(join(root, 'nested')), ['image.png']);
});

// -- model -------------------------------------------------------------------------------

test('a resource knows what it is, where it lives and who owns it', () => {
  const resource = describeResource({
    path: `${GALLERY}/luca-bravo-alS7ewQ41M8-unsplash.jpg`,
    size: JPG.length,
    mtimeMs: 1_700_000_000_000,
    bundle: { bundlePath: GALLERY, kind: 'leaf-bundle', documentPath: `${GALLERY}/index.md`, contentKind: 'article', section: 'post' },
    writable: true,
  });

  assert.equal(resource.id, `content:${GALLERY}/luca-bravo-alS7ewQ41M8-unsplash.jpg`);
  assert.equal(resource.filename, 'luca-bravo-alS7ewQ41M8-unsplash.jpg');
  assert.equal(resource.extension, '.jpg');
  assert.equal(resource.mimeType, 'image/jpeg');
  assert.equal(resource.type, 'image');
  assert.equal(resource.location, 'content');
  assert.equal(resource.size, JPG.length);
  assert.equal(resource.bundlePath, GALLERY);
  assert.equal(resource.bundleKind, 'leaf-bundle');
  assert.equal(resource.ownerDocument, `${GALLERY}/index.md`);
  assert.equal(resource.section, 'post');
  assert.equal(resource.updatedAt, new Date(1_700_000_000_000).toISOString());
  assert.deepEqual(resource.capabilities, { preview: true, replace: true, delete: true, upload: false });

  // The same file outside a writable root is the same file, with no write capability.
  const readOnly = describeResource({ path: `${GALLERY}/x.jpg`, writable: false });
  assert.equal(readOnly.capabilities.preview, true);
  assert.equal(readOnly.capabilities.replace, false);
  assert.equal(readOnly.capabilities.delete, false);
});

test('the site trees are listed with the same model but no write capability', () => {
  const staticAsset = describeSiteAsset({ location: 'static', path: 'img/logo.png', size: PNG.length });
  assert.equal(staticAsset.location, 'static');
  assert.equal(staticAsset.locationLabel, '站点静态文件');
  assert.equal(staticAsset.bundlePath, null);
  assert.deepEqual(staticAsset.capabilities, { preview: true, replace: false, delete: false, upload: false });

  // A file the browser cannot render is still a resource: classified, not previewed.
  const pipeline = describeSiteAsset({ location: 'assets', path: 'scss/custom.scss', size: 18 });
  assert.equal(pipeline.type, 'other');
  assert.equal(pipeline.capabilities.preview, false);
  assert.equal(describeSiteAsset({ location: 'static', path: 'notes.txt' }).type, 'text');
});

test('a filename has to be a filename before anything else happens', () => {
  for (const name of ['image.jpg', 'a-b_c.1.png', '中文图片.webp', 'photo.JPEG']) {
    assert.equal(validateAssetFileName(name).ok, true, `${name} should be accepted`);
  }
  for (const name of ['', '   ', '../escape.png', 'sub/dir.png', 'sub\\dir.png', '.hidden.png', 'bad:name.png', 'bad?name.png', 'con.png']) {
    assert.equal(validateAssetFileName(name).ok, false, `${name} should be refused`);
  }
  assert.match(validateAssetFileName('sub/dir.png').reason, /文件名|分隔/);
  assert.equal(validateAssetFileName('x'.repeat(120) + '.png').ok, false);

  // A colliding upload is offered a name instead of overwriting the file that is already there.
  const suggestion = suggestAvailableName('photo.jpg', ['photo.jpg', 'photo-2.jpg']);
  assert.equal(suggestion, 'photo-3.jpg');
  assert.equal(suggestAvailableName('unused.png', ['photo.jpg']), 'unused.png');
});

// -- guard -------------------------------------------------------------------------------

test('the guard has two doors: markdown is a document, everything else is a resource', (t) => {
  const { guard, contentRoot } = sandbox(t);

  // A section resource is writable; a section root is not a resource location, and neither is
  // a path that climbs out or hides.
  assert.equal(guard.isWritableAsset(`${GALLERY}/probe.png`), true);
  assert.equal(guard.isWritableAsset(FIXTURE.linksResource), true);
  assert.equal(guard.isWritableAsset(`${GALLERY}/index.md`), false, 'markdown is not a resource');
  assert.equal(guard.isWritableAsset('../outside.png'), false);
  assert.equal(guard.isWritableAsset('/etc/passwd'), false);
  assert.equal(guard.isWritableAsset('.hidden.png'), false);
  assert.equal(guard.isWritableAsset(''), false);
  // The allow-list is what decides: with Phase 1's narrow scope, only post/ is a resource home.
  const narrow = new PathGuard({ contentRoot });
  assert.equal(narrow.isWritableAsset('post/x.png'), true);
  assert.equal(narrow.isWritableAsset('page/x.png'), false, 'a section the editor does not manage is refused');

  // Reads inside a bundle resolve to that bundle; a markdown file is refused here.
  assert.equal(guard.resolveAssetForRead(GALLERY_PHOTO), join(contentRoot, GALLERY_PHOTO));
  assert.throws(() => guard.resolveAssetForRead(`${GALLERY}/index.md`), /document, not a resource/);
  assert.throws(() => guard.resolveAssetForRead('../../etc/passwd'), /outside content root/);

  // static/ and assets/ are readable through the location that owns them, and nothing else.
  assert.equal(guard.resolveSiteAssetForRead({ location: 'static', relPath: 'img/logo.png' }), join(guard.staticRoot, 'img', 'logo.png'));
  assert.throws(() => guard.resolveSiteAssetForRead({ location: 'static', relPath: '../config/params.toml' }), /read outside static/);
  assert.throws(() => guard.resolveSiteAssetForRead({ location: 'theme', relPath: 'x.png' }), /unknown or unconfigured/);
  assert.throws(() => guard.resolveSiteAssetForRead({ location: 'static', relPath: '/etc/passwd' }), /absolute path/);

  // The guard keeps deciding for the content tree exactly as it did before this phase.
  assert.equal(new PathGuard({ contentRoot }).isWritable('post/x.md'), true);
  assert.equal(new PathGuard({ contentRoot }).isWritable('post/x.png'), false);
});

// -- service -----------------------------------------------------------------------------

test('the asset list groups resources by the bundle that owns them', async (t) => {
  const { service } = sandbox(t);
  const listing = await service.listAssets();

  const gallery = listing.bundles.find((bundle) => bundle.bundlePath === GALLERY);
  assert.ok(gallery, 'the gallery bundle is listed');
  assert.equal(gallery.kind, 'leaf-bundle');
  assert.equal(gallery.contentKind, 'article');
  assert.equal(gallery.canUpload, true);
  assert.equal(gallery.uploadBlockedReason, null);
  assert.equal(gallery.documentPath, `${GALLERY}/index.md`, 'the default language page opens first');
  // The fixture bundle owns a photo the page points at and an image it does not use.
  assert.deepEqual(gallery.resources.map((resource) => resource.filename).sort(), [
    'fixture-extra.png',
    'fixture-photo.jpg',
  ]);
  for (const resource of gallery.resources) {
    assert.equal(resource.capabilities.replace, true);
    assert.match(resource.previewUrl, /^\/api\/assets\/raw\?location=content&path=/);
  }
  const photo = gallery.resources.find((resource) => resource.filename === 'fixture-photo.jpg');
  const unused = gallery.resources.find((resource) => resource.filename === 'fixture-extra.png');
  assert.equal(photo.referenced, true, 'the page points at its photo');
  // A resource in a bundle that does not reference it is still listed, flagged as unreferenced.
  assert.equal(unused.referenced, false);

  // The content root is not a bundle: there is nothing to upload into.
  const rootBundle = listing.bundles.find((bundle) => bundle.bundlePath === '');
  if (rootBundle) assert.equal(rootBundle.canUpload, false);

  // The site's own trees are mirrored, read-only, and never carry a write capability.
  assert.deepEqual(listing.assets.map((asset) => asset.path), ['scss/custom.scss']);
  assert.deepEqual(listing.static.map((asset) => asset.path), ['img/logo.png']);
  assert.equal(listing.static[0].capabilities.delete, false);
  assert.equal(listing.summary.staticFiles, 1);
  // The fixture's content resources: the bundle's two images, the links page's logo and the
  // category page's banner.
  assert.equal(listing.summary.contentResources, 4);
  assert.equal(listing.summary.replaceable, 4);
  assert.equal(listing.limits.maxUploadBytes, ASSET_MAX_BYTES);
  assert.ok(listing.limits.uploadExtensions.includes('.png'));
  assert.equal(listing.limits.uploadExtensions.includes('.svg'), false, 'svg stays out of the writable set');
});

test('uploading writes the bytes it was given, and refuses to overwrite', async (t) => {
  const { service, read, exists } = sandbox(t);

  const plan = await service.planUpload({ bundlePath: GALLERY, filename: 'new-image.png', size: PNG.length });
  assert.equal(plan.status, 'preview');
  assert.equal(plan.canWrite, true);
  assert.equal(plan.exists, false);
  assert.equal(plan.targetPath, `${GALLERY}/new-image.png`);
  assert.match(plan.confirmHint, /将新建/);

  // A plan is a dry run: nothing is on disk.
  assert.equal(exists(plan.targetPath), false);

  const created = await service.upload({ bundlePath: GALLERY, filename: 'new-image.png', dataBase64: PNG.toString('base64'), confirm: true });
  assert.equal(created.status, 'created');
  assert.equal(created.path, `${GALLERY}/new-image.png`);
  assert.equal(created.mimeType, 'image/png');
  assert.equal(created.sha256, sha256Bytes(PNG));
  assert.equal(sha256Bytes(read(created.path)), sha256Bytes(PNG), 'the bytes on disk are the bytes uploaded');
  assert.equal(created.asset.capabilities.replace, true);
  assert.equal(created.asset.bundlePath, GALLERY, 'the new file belongs to the bundle it was uploaded into');

  // The same name again is refused with a suggestion, and without a confirm nothing is written.
  await assert.rejects(
    () => service.upload({ bundlePath: GALLERY, filename: 'new-image.png', dataBase64: PNG.toString('base64'), confirm: true }),
    (error) => {
      assert.ok(error instanceof AssetValidationError);
      assert.equal(error.suggestion, 'new-image-2.png');
      return true;
    },
  );
  const planned = await service.upload({ bundlePath: GALLERY, filename: 'new-image.png', dataBase64: PNG.toString('base64') });
  assert.equal(planned.status, 'awaiting-confirmation');
  assert.equal(planned.exists, true);
  assert.equal(planned.canWrite, false);
  assert.match(planned.warnings[0], /已存在/);
});

test('an upload has to be what its name says, and small enough', async (t) => {
  const { service, exists } = sandbox(t);
  const upload = (filename, buffer) =>
    service.upload({ bundlePath: GALLERY, filename, dataBase64: buffer.toString('base64'), confirm: true });

  // Renaming a script to .png does not make it an image.
  await assert.rejects(() => upload('fake.png', Buffer.from('#!/bin/sh\nrm -rf /\n')), /不是可识别的图片或 PDF/);
  // The bytes and the extension have to agree.
  await assert.rejects(() => upload('wrong.jpg', PNG), /与扩展名 .jpg 不符/);
  // A format this phase does not write is refused by name.
  await assert.rejects(() => upload('page.md', PNG), /document, not a resource/);
  await assert.rejects(() => upload('vector.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), /不支持写入 .svg/);
  await assert.rejects(() => upload('sub/dir.png', PNG), /文件名|分隔/);
  // Empty content is not a file.
  await assert.rejects(() => upload('empty.png', Buffer.from('')), /缺少文件内容|文件内容为空/);
  // The size limit is on the decoded bytes.
  await assert.rejects(() => upload('huge.png', Buffer.concat([PNG, Buffer.alloc(ASSET_MAX_BYTES)]), { timeout: 30_000 }), /文件过大|文件内容为空/);
  await assert.rejects(() => upload('big.png', Buffer.alloc(ASSET_MAX_BYTES + 1, 1)), /文件过大/);

  // Nothing above left a file behind.
  for (const name of ['fake.png', 'wrong.jpg', 'huge.png', 'big.png', 'empty.png']) {
    assert.equal(exists(`${GALLERY}/${name}`), false, `${name} must not exist`);
  }

  // A PDF is accepted (and, being a document, is not previewed).
  const pdf = await upload('paper.pdf', PDF);
  assert.equal(pdf.status, 'created');
  assert.equal(pdf.mimeType, 'application/pdf');
  assert.equal(pdf.asset.capabilities.preview, false);
  assert.equal(pdf.asset.capabilities.replace, true);
});

test('replacing keeps the path, backs up the old bytes, and is a true no-op when nothing changes', async (t) => {
  const { service, read, backupRoot } = sandbox(t);
  const path = GALLERY_PHOTO;
  const before = sha256Bytes(read(path));
  // Another real image from the fixture: a replace has to keep the name and the bytes agreeing,
  // so a JPEG path is replaced with JPEG content.
  const replacement = readFileSync(join(CONTENT_ROOT, FIXTURE.linksResource));

  const plan = await service.planReplace({ path, size: replacement.length });
  assert.equal(plan.status, 'preview');
  assert.equal(plan.shaBefore, before);
  assert.equal(plan.referenced, true);
  assert.match(plan.warnings[0], /被 2 个文档引用/); // both index files of the fixture bundle
  assert.equal(sha256Bytes(read(path)), before, 'the plan wrote nothing');

  const replaced = await service.replace({ path, dataBase64: replacement.toString('base64'), confirm: true });
  assert.equal(replaced.status, 'replaced');
  assert.equal(replaced.path, path, 'the path is what the references point at, so it does not change');
  assert.equal(replaced.shaBefore, before);
  assert.equal(replaced.shaAfter, sha256Bytes(replacement));
  assert.equal(replaced.mimeType, 'image/jpeg');
  assert.equal(sha256Bytes(read(path)), sha256Bytes(replacement));
  assert.ok(replaced.backupPath.startsWith(backupRoot), 'the overwrite took a backup first');
  assert.equal(sha256Bytes(readFileSync(replaced.backupPath)), before, 'the backup holds the old bytes');

  // The file is still the page's resource: same bundle, still referenced.
  assert.equal(replaced.asset.bundlePath, GALLERY);
  assert.equal(replaced.asset.referenced, true);

  // Replacing with the identical bytes is refused as a no-op rather than rewriting the file.
  const noop = await service.replace({ path, dataBase64: replacement.toString('base64'), confirm: true });
  assert.equal(noop.status, 'noop');
  assert.equal(noop.shaAfter, undefined);

  // Without confirm there is no write at all: the answer is the plan, not the write.
  const planned = await service.replace({ path, dataBase64: JPG.toString('base64') });
  assert.equal(planned.status, 'awaiting-confirmation');
  assert.equal(sha256Bytes(read(path)), sha256Bytes(replacement));

  // The bytes still have to match the name they are stored under.
  await assert.rejects(() => service.replace({ path, dataBase64: PNG.toString('base64'), confirm: true }), /与扩展名 .jpg 不符/);

  // A resource of a read-only location cannot be replaced through this service.
  await assert.rejects(() => service.planReplace({ path: 'scss/custom.scss' }), /不可替换|not found/);
});

test('deleting is a reversible move: the bytes come back exactly, and references are named', async (t) => {
  const { service, read, exists } = sandbox(t);
  const path = GALLERY_PHOTO;
  const before = sha256Bytes(read(path));

  const plan = await service.planRemove({ path });
  assert.equal(plan.status, 'preview');
  assert.equal(plan.files.length, 1);
  assert.equal(plan.totalBytes, read(path).length);
  assert.equal(plan.recoverable, true);
  assert.equal(plan.bundlePath, GALLERY);
  assert.equal(plan.referenced, true);
  assert.match(plan.warnings[0], /失效引用/);
  assert.equal(exists(path), true, 'the plan deleted nothing');

  const request = { ...plan, status: 'awaiting-confirmation' };
  assert.equal(request.recoverable, true);

  const deleted = await service.remove({ path, confirm: true });
  assert.equal(deleted.status, 'deleted');
  assert.equal(deleted.deleted, true);
  assert.equal(exists(path), false, 'the file is gone from the site');
  assert.ok(deleted.trashId);

  // The deletion is one trash entry, and it is an asset deletion, not a document deletion.
  const entry = service.trashEntries().find((candidate) => candidate.id === deleted.trashId);
  assert.equal(entry.reason, 'asset-delete');
  assert.equal(entry.relPath, path);
  assert.equal(entry.files, 1);

  // Restoring puts the identical bytes back on the original path.
  const restored = service.restore({ id: deleted.trashId });
  assert.equal(restored.relPath, path);
  assert.equal(exists(path), true);
  assert.equal(sha256Bytes(read(path)), before, 'restore is byte-for-byte, not a re-encode');

  // And the byte count on disk is what the trash manifest recorded.
  assert.equal(read(path).length, entry.bytes);

  // A read-only resource cannot be deleted at all.
  const readonly = await service.listAssets();
  const staticAsset = readonly.static[0];
  await assert.rejects(() => service.planRemove({ path: staticAsset.path }), /不可删除|not found/);
  await assert.rejects(() => service.planRemove({ path: `${GALLERY}/missing.jpg` }), /asset not found/);
});

test('a deleted resource can be uploaded again, and an upload cannot land on another bundle', async (t) => {
  const { service, exists, read } = sandbox(t);
  const path = GALLERY_UNUSED;

  await service.remove({ path, confirm: true });
  assert.equal(exists(path), false);

  // Re-uploading the same name now succeeds: the collision is with the filesystem, not with a
  // memory of what used to be there.
  const again = await service.upload({ bundlePath: GALLERY, filename: 'fixture-extra.png', dataBase64: PNG.toString('base64'), confirm: true });
  assert.equal(again.status, 'created');
  assert.equal(sha256Bytes(read(path)), sha256Bytes(PNG));

  // A resource can only be described through the location it belongs to.
  await assert.rejects(() => service.describe({ location: 'static', path }), /asset not found/);
  const described = await service.describe({ path });
  assert.equal(described.filename, 'fixture-extra.png');

  // Reading bytes is limited to the resources the service lists.
  const bytes = await service.readBytes({ path });
  assert.equal(sha256Bytes(bytes.bytes), sha256Bytes(PNG));
  assert.equal(bytes.mimeType, 'image/png');
  const revalidated = await service.readBytes({ path, ifNoneMatch: bytes.etag });
  assert.equal(revalidated.notModified, true);
  await assert.rejects(() => service.readBytes({ path: 'post/not-listed.png' }), /asset not found/);
  await assert.rejects(() => service.readBytes({ path: FIXTURE.bundle }), /asset not found/);
});
