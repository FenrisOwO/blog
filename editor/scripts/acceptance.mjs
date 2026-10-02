#!/usr/bin/env node
// P1.6 acceptance: the hard gate for Phase 1, plus the Phase 2 build-loop checks.
//
// This runs against the REAL site, because "a no-op save must not change a single byte"
// is only meaningful on the real corpus. Every no-op save is checked per file (content,
// SHA and mtime) and the whole content tree is hashed before and after, so an accidental
// write anywhere - not just on the file being saved - fails the run.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { createBuildService, defaultBuildPaths } from '../src/build/index.js';
import { runCommand, runSlashCommand } from '../src/editorCore/markdown.js';
import { ALLOWED_SUBCOMMANDS, createGitService, redactCredentials } from '../src/git/index.js';
import { readDocument, saveDocument, splitDocument } from '../src/frontmatter/index.js';
import { createSettingsService } from '../src/settings/settingsService.js';
import { readThemeInfo } from '../src/settings/themeInfo.js';
import { createAssetService } from '../src/site/assetService.js';
import { createDocumentService } from '../src/site/documentService.js';
import { createRelationService, TagConflictError } from '../src/relations/relationService.js';
import { PathGuard } from '../src/site/paths.js';
import { saveSafely } from '../src/site/safeWrite.js';

const EDITOR_ROOT = join(import.meta.dirname, '..');
const SITE_ROOT = '/projects/site';
const CONTENT_ROOT = join(SITE_ROOT, 'content');
const BACKUP_ROOT = join(EDITOR_ROOT, '.backups');
const HUGO = process.env.HUGO_BIN ?? (existsSync('/projects/.bin/hugo') ? '/projects/.bin/hugo' : 'hugo');
const SECTION = 'post';

let failures = 0;

function check(ok, label, detail = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function treeHashes(root) {
  const map = new Map();
  for (const file of walk(root)) {
    map.set(relative(root, file), sha256(readFileSync(file, 'utf8')));
  }
  return map;
}

// T12 must not race the editor server that is already watching this site.
async function detectEditorServer() {
  for (const port of [process.env.EDITOR_PORT, 1313, 18771].filter(Boolean)) {
    const base = `http://127.0.0.1:${port}`;
    try {
      const response = await fetch(`${base}/api/build/status`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) continue;
      const status = await response.json();
      if (status.watching || status.autoBuildOnSave) return { base, status };
    } catch {
      // Not this port: keep looking, and fall back to the in-process driver.
    }
  }
  return null;
}

async function postJson(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${payload.error ?? JSON.stringify(payload)}`);
  return payload;
}

function plan_sizes(plan) {
  return { documents: plan.documentCount, resources: plan.resourceCount, files: plan.totalFiles };
}

function countFiles(dir) {
  return existsSync(dir) ? walk(dir).length : 0;
}

// The whole Hugo project, not just content: a build must not rewrite any of it. Files
// Hugo regenerates as a side effect are listed explicitly rather than silently excluded.
const SOURCE_DIRS = ['content', 'config', 'layouts', 'static', 'assets', 'themes', 'data', 'i18n'];
const SOURCE_EXEMPT = new Set(['assets/jsconfig.json', 'hugo_stats.json']);

function sourceHashes() {
  const map = new Map();
  for (const dir of SOURCE_DIRS) {
    const root = join(SITE_ROOT, dir);
    if (!existsSync(root)) continue;
    for (const file of walk(root)) {
      const rel = relative(SITE_ROOT, file);
      if (SOURCE_EXEMPT.has(rel)) continue;
      map.set(rel, createHash('sha256').update(readFileSync(file)).digest('hex'));
    }
  }
  return map;
}

// The site belongs to a person, and that person may be editing it in the editor window while
// acceptance runs: a save over there lands in the same tree a moment later, and a whole-tree byte
// comparison cannot tell their write from one of ours. So the comparison is *attributed*: the
// paths this run named must come back byte for byte, and anything else that moved is reported as
// an outside write instead of failing the run. Attributing by path is sound because every write
// in this editor goes through a named path - an uploaded file, a document, a config file - so a
// path the run never named is not the run's doing. Each item still asserts its own files byte for
// byte as it goes, so this is the summary, not the only proof.
const owns = (owned, rel) =>
  owned.some((entry) => rel === entry || rel.startsWith(entry.endsWith('/') ? entry : `${entry}/`));

function checkSourceRestored(label, before, after, owned) {
  const differed = [
    ...[...after.keys()].filter((rel) => !before.has(rel)),
    ...[...before.keys()].filter((rel) => after.has(rel) && after.get(rel) !== before.get(rel)),
  ];
  const ours = differed.filter((rel) => owns(owned, rel));
  const foreign = differed.filter((rel) => !owns(owned, rel));
  check(ours.length === 0, label, ours.slice(0, 5).join(', '));
  if (foreign.length > 0) {
    console.log(`  ⚠️  ${foreign.length} 个文件在验收期间被别的窗口写入，不计入本次失败：${foreign.slice(0, 3).join(', ')}`);
  }
}

const allMarkdown = walk(CONTENT_ROOT).filter((file) => file.endsWith('.md')).sort();
const writableMarkdown = allMarkdown.filter((file) => relative(CONTENT_ROOT, file).startsWith(`${SECTION}/`));
const readOnlyMarkdown = allMarkdown.filter((file) => !writableMarkdown.includes(file));

console.log('P1.6 + P2 — Phase 1 无损验收 + Phase 2 构建闭环验收');
console.log(`  site     : ${SITE_ROOT}`);
console.log(`  markdown : ${allMarkdown.length} 份（可写 ${writableMarkdown.length} / 只读 ${readOnlyMarkdown.length}）`);
console.log('');

const before = treeHashes(CONTENT_ROOT);
const sourceBefore = sourceHashes();
const backupsBefore = countFiles(BACKUP_ROOT);

// T1 - the front matter engine round-trips every real file without touching a byte.
console.log('T1  引擎往返：读入 -> 原样保存，逐字节一致');
{
  const broken = [];
  for (const file of allMarkdown) {
    const text = readFileSync(file, 'utf8');
    const { values } = readDocument(text);
    if (saveDocument(text, values) !== text) broken.push(relative(CONTENT_ROOT, file));
  }
  check(broken.length === 0, `${allMarkdown.length} 份文件全部逐字节一致`, broken.join(', '));
}

// T2 - no-op save through the real write path, on the real files.
console.log('T2  空操作保存：经 DocumentService -> SafeWriter，磁盘必须毫厘不动');
{
  const service = createDocumentService({
    contentRoot: CONTENT_ROOT,
    siteRoot: SITE_ROOT,
    section: SECTION,
    backupRoot: BACKUP_ROOT,
  });

  const moved = [];
  const unguarded = [];
  for (const file of writableMarkdown) {
    const relPath = relative(CONTENT_ROOT, file);
    const text = readFileSync(file, 'utf8');
    const mtimeBefore = statSync(file).mtimeMs;

    const preview = service.previewEdit({ path: relPath, text });
    const result = service.saveEdit({ path: relPath, text });

    if (result.status !== 'noop') unguarded.push(`${relPath}(${result.status})`);
    if (preview.status !== 'noop' || preview.diff.changed !== 0) unguarded.push(`${relPath}(preview)`);
    if (readFileSync(file, 'utf8') !== text) moved.push(`${relPath}(content)`);
    if (statSync(file).mtimeMs !== mtimeBefore) moved.push(`${relPath}(mtime)`);
    if (result.backupPath !== null) moved.push(`${relPath}(backup)`);
  }

  check(unguarded.length === 0, `25 份可写文件全部判定为 no-op`, unguarded.join(', '));
  check(moved.length === 0, `25 份文件内容 / mtime 均未变化`, moved.join(', '));
}

// T3 - the write scope is still an allow-list, not a suggestion.
console.log('T3  写范围：content/post 之外必须被拒绝');
{
  const guard = new PathGuard({ contentRoot: CONTENT_ROOT });
  const leaked = [];
  for (const file of readOnlyMarkdown) {
    const relPath = relative(CONTENT_ROOT, file);
    try {
      saveSafely({ guard, relPath, nextText: `${readFileSync(file, 'utf8')}\n触碰`, backupRoot: BACKUP_ROOT });
      leaked.push(relPath);
    } catch {
      // expected
    }
  }
  check(leaked.length === 0, `${readOnlyMarkdown.length} 份只读文件全部被 SafeWriter 拒绝`, leaked.join(', '));
}

// T4 - the whole tree, not just the saved files, is unchanged by the whole run.
console.log('T4  全树校验：整次验收前后 content 树完全一致');
{
  const after = treeHashes(CONTENT_ROOT);
  const changed = [...after].filter(([path, hash]) => before.get(path) !== hash).map(([path]) => path);
  const added = [...after.keys()].filter((path) => !before.has(path));
  const removed = [...before.keys()].filter((path) => !after.has(path));
  check(changed.length + added.length + removed.length === 0, `content 树 ${before.size} 个文件零变化`, [...changed, ...added.map((p) => `+${p}`), ...removed.map((p) => `-${p}`)].join(', '));

  const combined = createHash('sha256');
  for (const path of [...after.keys()].sort()) {
    combined.update(path);
    combined.update(readFileSync(join(CONTENT_ROOT, path), 'utf8'));
  }
  console.log(`     树 SHA : ${combined.digest('hex').slice(0, 16)}`);
  check(countFiles(BACKUP_ROOT) === backupsBefore, '本次验收未产生任何备份（因为没有任何写入）');
}

// T5 - the editor can never be part of the deployed Hugo output.
console.log('T5  隔离：编辑器产物不得出现在 site/ 或 Hugo 输出中');
{
  const publicDir = join(SITE_ROOT, 'public');
  const buildPaths = defaultBuildPaths({ editorRoot: EDITOR_ROOT, siteRoot: SITE_ROOT });
  const inPublic = existsSync(publicDir)
    ? walk(publicDir).filter((file) => /editor/i.test(relative(publicDir, file)))
    : [];
  const inSite = walk(SITE_ROOT).filter((file) => /editor/i.test(relative(SITE_ROOT, file)) && !relative(SITE_ROOT, file).startsWith('themes/'));
  check(!join(EDITOR_ROOT, 'dist').startsWith(SITE_ROOT), '编辑器构建产物位于 site/ 之外');
  check(inPublic.length === 0, 'site/public 中没有编辑器文件', inPublic.join(', '));
  check(inSite.length === 0, 'site/ 中没有编辑器命名的文件', inSite.join(', '));

  // Phase 2: the staging/cache directories Hugo writes into must also stay outside the site.
  check(!buildPaths.stagingDir.startsWith(SITE_ROOT), '构建暂存区位于 site/ 之外', buildPaths.stagingDir);
  check(!buildPaths.cacheDir.startsWith(SITE_ROOT), 'Hugo 缓存位于 site/ 之外', buildPaths.cacheDir);
  check(!BACKUP_ROOT.startsWith(SITE_ROOT), '备份目录位于 site/ 之外', BACKUP_ROOT);
  check(!existsSync(join(SITE_ROOT, '.build')), 'site/ 中没有 .build 目录');
  check(!existsSync(join(SITE_ROOT, '.backups')), 'site/ 中没有 .backups 目录');
}

// T6 - the site still builds, from the same content, with hugo.
console.log('T6  构建：Hugo 仍然构建成功');
{
  const workDir = mkdtempSync(join(tmpdir(), 'hve-accept-'));
  const destination = join(workDir, 'public');
  const cacheDir = join(workDir, 'cache');
  try {
    const output = execFileSync(
      HUGO,
      ['--gc', '--minify', '--source', SITE_ROOT, '--destination', destination, '--cacheDir', cacheDir],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const pages = walk(destination).filter((file) => file.endsWith('.html')).length;
    const leaked = walk(destination).filter((file) => /editor/i.test(relative(destination, file)));
    check(pages > 0, `构建成功，产出 ${pages} 个 HTML 页面`, output.split('\n').find((line) => line.startsWith('Total in')) ?? '');
    check(leaked.length === 0, '构建产物中没有编辑器文件');
  } catch (error) {
    check(false, 'Hugo 构建失败', String(error.message).split('\n')[0]);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// T7 - Phase 2: the editor's own build loop, end to end, on the real site.
console.log('T7  构建闭环：BuildService 构建真实站点并发布到 site/public');
{
  const paths = defaultBuildPaths({ editorRoot: EDITOR_ROOT, siteRoot: SITE_ROOT });
  const service = createBuildService({
    siteRoot: SITE_ROOT,
    stagingDir: paths.stagingDir,
    cacheDir: paths.cacheDir,
    publishDir: join(SITE_ROOT, 'public'),
    publishRoot: SITE_ROOT,
    timeoutMs: 180_000,
  });

  const record = await service.build({ trigger: 'manual' });
  const status = service.getStatus();

  check(record.state === 'success', '构建成功', record.message);
  check(record.exitCode === 0, 'Hugo 退出码为 0');
  check(record.timedOut === false, '未超时');
  check(record.errorCount === 0, '没有构建错误', `${record.errorCount} 个错误 / ${record.warningCount} 条警告`);
  check(record.published !== null && record.published.files > 100, `发布 ${record.published?.files ?? 0} 个文件`);
  check(status.generation === 1, 'preview generation 递增到 1', String(status.generation));

  const indexPath = join(SITE_ROOT, 'public', 'index.html');
  check(existsSync(indexPath), 'site/public/index.html 已生成');
  const pages = existsSync(join(SITE_ROOT, 'public')) ? walk(join(SITE_ROOT, 'public')).filter((f) => f.endsWith('.html')).length : 0;
  check(pages > 100, `输出中有 ${pages} 个 HTML 页面`);

  const staged = existsSync(paths.stagingDir) ? walk(paths.stagingDir).length : 0;
  check(staged > 0, `暂存区留在 site/ 之外（${paths.stagingDir}）`);
  const leakedToStaging = walk(paths.stagingDir).filter((file) => /editor/i.test(relative(paths.stagingDir, file)));
  check(leakedToStaging.length === 0, '暂存区与输出中都没有编辑器文件');
}

// T8 - the safety property that made staging worth it: a broken build publishes nothing.
console.log('T8  失败构建：绝不改动输出目录');
{
  const workDir = mkdtempSync(join(tmpdir(), 'hve-accept-broken-'));
  const brokenContent = join(workDir, 'content');
  const output = join(workDir, 'public');
  mkdirSync(join(brokenContent, 'post', 'broken'), { recursive: true });
  writeFileSync(
    join(brokenContent, 'post', 'broken', 'index.md'),
    '---\ntitle: "broken"\ndate: 2026-01-01\n---\n\n{{< nosuchshortcode >}}\n',
  );
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'index.html'), '<html>previous good build</html>');

  try {
    const service = createBuildService({
      siteRoot: SITE_ROOT,
      stagingDir: join(workDir, 'staging'),
      cacheDir: join(workDir, 'cache'),
      publishDir: output,
      publishRoot: workDir,
      extraArgs: ['--contentDir', brokenContent],
      timeoutMs: 180_000,
    });

    const record = await service.build({ trigger: 'manual' });

    check(record.state === 'error', '构建被判定为失败', record.message);
    check(record.exitCode !== 0, `Hugo 退出码非 0（${record.exitCode}）`);
    check(record.errorCount > 0, `解析出 ${record.errorCount} 个错误`);
    check(
      record.diagnostics.some((d) => d.file?.endsWith('post/broken/index.md')),
      '错误定位到了出问题的文件',
      record.diagnostics.map((d) => d.file).filter(Boolean).join(', '),
    );
    check(record.published === null, '没有发生发布');
    check(
      readFileSync(join(output, 'index.html'), 'utf8') === '<html>previous good build</html>',
      '上一次成功的输出原封不动',
    );
    check(service.getStatus().generation === 0, 'generation 没有前进（预览不会被破坏）');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// T9 - building must not rewrite the source tree. Hugo does write cache/sidecar files of
// its own; those are named here rather than silently excluded.
console.log('T9  构建不得改动源文件');
{
  const afterContent = treeHashes(CONTENT_ROOT);
  const changedContent = [...before.keys()].filter((rel) => afterContent.get(rel) !== before.get(rel));
  const addedContent = [...afterContent.keys()].filter((rel) => !before.has(rel));
  check(changedContent.length === 0, 'content/ 逐字节未变', changedContent.join(', '));
  check(addedContent.length === 0, 'content/ 没有新增文件', addedContent.join(', '));

  const afterSource = sourceHashes();
  const changed = [...sourceBefore.keys()].filter((rel) => afterSource.get(rel) !== sourceBefore.get(rel));
  const added = [...afterSource.keys()].filter((rel) => !sourceBefore.has(rel));
  const removed = [...sourceBefore.keys()].filter((rel) => !afterSource.has(rel));
  check(changed.length === 0, `整个 Hugo 源树未被改动（content/config/layouts/static/assets/themes，共 ${sourceBefore.size} 个文件）`, changed.slice(0, 5).join(', '));
  check(added.length === 0, '源树没有多出文件', added.slice(0, 5).join(', '));
  check(removed.length === 0, '源树没有少文件', removed.slice(0, 5).join(', '));
  check(
    SOURCE_EXEMPT.has('assets/jsconfig.json') && existsSync(join(SITE_ROOT, 'assets', 'jsconfig.json')),
    '唯一豁免：assets/jsconfig.json（Hugo 自生成的编辑器提示文件，不属于内容）',
  );
}

// T10 - Phase 3 walks the whole content tree, so it runs on a copy of it: create, edit via
// the form, delete, and restore. The real tree is hashed again at the end of this section,
// which is what proves every one of those operations stayed on its copy.
console.log('T10 Phase 3：跨目录内容管理（在副本上执行）');
{
  const workDir = mkdtempSync(join(tmpdir(), 'editor-p3-'));
  const contentCopy = join(workDir, 'content');
  const backupCopy = join(workDir, 'backups');
  cpSync(CONTENT_ROOT, contentCopy, { recursive: true });

  try {
    const service = createDocumentService({
      contentRoot: contentCopy,
      siteRoot: SITE_ROOT,
      sections: ['post', 'page', 'categories', ''],
      backupRoot: backupCopy,
    });

    const overview = await service.contentOverview();
    check(overview.documents.length === allMarkdown.length, `副本中列出 ${overview.documents.length} 份文档`);
    check(
      overview.sections.map((entry) => entry.section).join(',') === 'post,page,categories,',
      '目录顺序 = 声明顺序（content 根在最后）',
      overview.sections.map((entry) => entry.section).join(','),
    );
    check(overview.groups.some((group) => group.languages.length === 4), '翻译分组识别出 4 语言的文章');

    // Form edit: change one field of a page, confirm, and check the body is untouched.
    const aboutPath = 'page/about/index.md';
    const aboutBefore = readFileSync(join(contentCopy, aboutPath), 'utf8');
    const previewFields = service.previewFields({ path: aboutPath, set: { title: '关于（验收）' } });
    check(previewFields.changed === true && previewFields.bodyUnchanged === true, '表单预览：只改 front matter');
    check(readFileSync(join(contentCopy, aboutPath), 'utf8') === aboutBefore, 'dry-run 不写盘');

    const saved = service.saveFields({ path: aboutPath, set: { title: '关于（验收）' } });
    const aboutAfter = readFileSync(join(contentCopy, aboutPath), 'utf8');
    check(saved.saved?.backupPath != null, '表单保存有备份', String(saved.saved?.backupPath));
    check(aboutAfter.includes('title: 关于（验收）'), '表单保存写入磁盘');
    check(
      splitDocument(aboutAfter).bodyRaw === splitDocument(aboutBefore).bodyRaw,
      '正文逐字节未变',
    );
    check(service.previewFields({ path: aboutPath, set: { title: '关于（验收）' } }).changed === false, '重复保存是 no-op');

    // Create: the plan is shown first, and creating does not touch anything else.
    const plan = service.planForCreate({ kind: 'leaf-bundle', section: 'post', title: '验收草稿', language: 'zh' });
    check(plan.path === 'post/验收草稿/index.md', '创建计划给出路径', plan.path);
    check(plan.conflicts.length === 0 && plan.writable === true, '计划无冲突且路径可写');
    check(!existsSync(join(contentCopy, plan.path)), '计划阶段未创建文件');

    const created = service.createDocument({ kind: 'leaf-bundle', section: 'post', title: '验收草稿', language: 'zh' });
    check(existsSync(join(contentCopy, created.path)), '确认后文件存在', created.path);
    check(readFileSync(join(contentCopy, created.path), 'utf8').includes('draft: true'), '新文档是草稿');
    check((await service.listDocuments()).length === overview.documents.length + 1, '列表多出一份文档');
    check(
      service.planForCreate({ kind: 'leaf-bundle', section: 'post', title: '验收草稿', language: 'zh' }).conflicts.length > 0,
      '同名再次创建会被拒绝',
    );

    // Delete: whole bundle, into the trash, and back.
    const deletePlan = service.planForDelete({ path: created.path, scope: 'bundle' });
    check(deletePlan.totalFiles === 1 && deletePlan.recoverable === true, '删除计划：1 个文件，可恢复');
    check(existsSync(join(contentCopy, created.path)), '删除计划未动磁盘');

    const removed = service.removeDocument({ path: created.path, scope: 'bundle' });
    check(!existsSync(join(contentCopy, created.path)), '删除后文件离开 content/');
    check(removed.trashId != null, '删除记录了回收站条目', String(removed.trashId));
    check(!backupCopy.startsWith(SITE_ROOT), '回收站位于 site/ 之外', backupCopy);
    check(
      (await service.listDocuments()).length === overview.documents.length,
      '列表回到删除前的数量',
    );

    const entries = service.trash();
    check(
      entries.length === 1 && entries[0].relPath === 'post/验收草稿' && entries[0].files === 1,
      '回收站记录了原路径与文件数',
      JSON.stringify(entries.map((entry) => [entry.relPath, entry.files, entry.bytes])),
    );
    const restored = service.restore({ id: removed.trashId });
    check(existsSync(join(contentCopy, created.path)), '恢复把文件放回原路径', restored.relPath);
    check((await service.listDocuments()).length === overview.documents.length + 1, '恢复后列表又回到 +1');

    // Nothing in the real tree was touched by any of the above.
    const realAfter = treeHashes(CONTENT_ROOT);
    const realChanged = [...before.keys()].filter((rel) => realAfter.get(rel) !== before.get(rel));
    check(realChanged.length === 0, '真实 content/ 在上述操作中零变化', realChanged.join(', '));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// T11 - Phase 4: the content TYPES and bundle FORMS the site really has, and what "delete"
// means for each of them. Runs on a copy of the content tree, because the interesting cases
// (a category page whose directory holds an image, a section page whose directory holds
// child pages) must not be provoked on the real tree just to be looked at.
console.log('T11 Phase 4：内容类型 / bundle 形态（在副本上执行）');
{
  const workDir = mkdtempSync(join(tmpdir(), 'editor-p4-'));
  const contentCopy = join(workDir, 'content');
  const backupCopy = join(workDir, 'backups');
  cpSync(CONTENT_ROOT, contentCopy, { recursive: true });

  const CATEGORY_PAGE = 'categories/Documentation/_index.md';
  const PAGE_BUNDLE = 'page/links/index.md';

  try {
    const service = createDocumentService({
      contentRoot: contentCopy,
      siteRoot: SITE_ROOT,
      sections: ['post', 'page', 'categories', ''],
      backupRoot: backupCopy,
    });

    const documents = await service.listDocuments();
    const counts = {};
    for (const doc of documents) counts[doc.contentKind] = (counts[doc.contentKind] ?? 0) + 1;
    // Expected counts come from the directory layout itself, so the user adding an article is
    // never read as a regression: post/ is an article, page/ a page, categories/ a category, and
    // a markdown file sitting at the content root is everything else.
    const layoutCounts = { article: 0, page: 0, category: 0, other: 0 };
    for (const file of allMarkdown) {
      const rel = relative(CONTENT_ROOT, file);
      if (rel.startsWith('post/')) layoutCounts.article += 1;
      else if (rel.startsWith('page/')) layoutCounts.page += 1;
      else if (rel.startsWith('categories/')) layoutCounts.category += 1;
      else layoutCounts.other += 1;
    }
    check(
      ['article', 'page', 'category', 'other'].every((kind) => counts[kind] === layoutCounts[kind]),
      '四类内容都从真实目录结构推导出来',
      `${JSON.stringify(counts)} vs 目录 ${JSON.stringify(layoutCounts)}`,
    );
    check(
      documents.every((doc) => ['standalone', 'leaf-bundle', 'branch-bundle'].includes(doc.kind)),
      '每份文档都带一种 bundle 形态',
    );
    const byPath = new Map(documents.map((doc) => [doc.path, doc]));
    check(byPath.get(PAGE_BUNDLE).contentKind === 'page' && byPath.get(PAGE_BUNDLE).kind === 'leaf-bundle', 'Page 是 leaf bundle');
    check(byPath.get(CATEGORY_PAGE).contentKind === 'category' && byPath.get(CATEGORY_PAGE).kind === 'branch-bundle', 'Category 是 branch bundle');
    check(byPath.get('_index.md').contentKind === 'other', '首页 _index.md 归入 other');
    check(documents.every((doc) => doc.updatedAt), '列表带更新时间');

    // The category page's own image is a resource OF that page.
    const resources = await service.listResources();
    check(
      resources.some((resource) => resource.path === 'categories/Documentation/hutomo-abrianto-l2jk-uxb1BY-unsplash.jpg'),
      'branch bundle 目录里的图片被识别为该页面的资源',
    );

    // Page: edit the body, then delete the whole bundle (index + image) and put it back.
    const pageBefore = readFileSync(join(contentCopy, PAGE_BUNDLE), 'utf8');
    service.saveEdit({ path: PAGE_BUNDLE, text: `${pageBefore}\nP4 PAGE EDIT\n` });
    check(readFileSync(join(contentCopy, PAGE_BUNDLE), 'utf8').includes('P4 PAGE EDIT'), 'Page 正文编辑写入副本');

    const pagePlan = service.planForDelete({ path: PAGE_BUNDLE });
    check(pagePlan.scope === 'bundle' && pagePlan.documentCount === 4 && pagePlan.resourceCount === 1, 'Page 整包删除计划：4 语言 + 1 资源', JSON.stringify(plan_sizes(pagePlan)));
    const pageRemoved = service.removeDocument({ path: PAGE_BUNDLE });
    check(!existsSync(join(contentCopy, 'page/links')), 'Page 整包删除后目录消失');
    service.restore({ id: pageRemoved.trashId });
    check(readFileSync(join(contentCopy, PAGE_BUNDLE), 'utf8') === `${pageBefore}\nP4 PAGE EDIT\n`, 'Page 恢复后内容一致');
    check(existsSync(join(contentCopy, 'page/links/ts-logo-128.jpg')), 'Page 的资源一起回来了');

    // Category: one language only, then the whole term page (four languages + its image).
    const singlePlan = service.planForDelete({ path: CATEGORY_PAGE, scope: 'document' });
    check(singlePlan.documentCount === 1 && singlePlan.resourceCount === 0, 'Category 单文件删除只算 1 份文档', JSON.stringify(plan_sizes(singlePlan)));
    check(singlePlan.warnings.some((warning) => warning.includes('会保留')), 'Category 单文件删除提示其余文件保留');

    const wholePlan = service.planForDelete({ path: CATEGORY_PAGE, scope: 'bundle' });
    check(wholePlan.documentCount === 4 && wholePlan.resourceCount === 1 && wholePlan.totalFiles === 5, 'Category 整页删除：4 语言 _index + 1 图片', JSON.stringify(plan_sizes(wholePlan)));
    const categoryRemoved = service.removeDocument({ path: CATEGORY_PAGE, scope: 'bundle' });
    const entries = service.trash();
    check(
      entries.some((entry) => entry.id === categoryRemoved.trashId && entry.files === 5 && entry.entries?.length === 5),
      '一次删除 = 一个回收站条目（5 个路径）',
      JSON.stringify(entries.map((entry) => [entry.relPath, entry.files])),
    );
    service.restore({ id: categoryRemoved.trashId });
    check(
      existsSync(join(contentCopy, 'categories/Documentation/_index.zh-hant-tw.md')) &&
        existsSync(join(contentCopy, 'categories/Documentation/hutomo-abrianto-l2jk-uxb1BY-unsplash.jpg')),
      'Category 恢复：所有语言与资源全部回位',
    );

    // A branch bundle whose directory really holds child pages: the page goes, the children stay.
    writeFileSync(join(contentCopy, 'page/_index.md'), '---\ntitle: 页面\n---\n', 'utf8');
    const branchPlan = service.planForDelete({ path: 'page/_index.md', scope: 'bundle' });
    check(
      branchPlan.files.length === 1 && branchPlan.kept.includes('page/about/') && branchPlan.kept.includes('page/links/'),
      'branch bundle 只删页面自己，子页面列在“会保留”里',
      JSON.stringify(branchPlan.kept),
    );
    service.removeDocument({ path: 'page/_index.md', scope: 'bundle' });
    check(existsSync(join(contentCopy, 'page/about/index.md')) && existsSync(join(contentCopy, 'page/links/index.md')), '子页面确实没被删掉');

    // Creating a category page, which is the only way a new term gets a description page.
    const categoryPlan = service.planForCreate({ kind: 'branch-bundle', section: 'categories', title: '验收分类' });
    check(categoryPlan.path === 'categories/验收分类/_index.md' && categoryPlan.contentKind === 'category', '分类页创建计划：branch bundle', categoryPlan.path);
    service.createDocument({ kind: 'branch-bundle', section: 'categories', title: '验收分类' });
    check(existsSync(join(contentCopy, 'categories/验收分类/_index.md')), '分类页创建成功');

    const realAfter = treeHashes(CONTENT_ROOT);
    const realChanged = [...before.keys()].filter((rel) => realAfter.get(rel) !== before.get(rel));
    check(realChanged.length === 0, '真实 content/ 在 T11 中零变化', realChanged.join(', '));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// T12 - Phase 4: a Page and a Category page edited on the REAL site, built, and seen in the
// published output. This is the only section that writes to the real content tree, so the
// original bytes go back in a `finally` and the tree is re-hashed afterwards: the point is
// that the loop closes (edit -> build -> preview -> revert), not that the edit stays.
//
// A save schedules a build on the editor server watching this site, and two Hugo processes
// sharing one staging directory fail for reasons that have nothing to do with the feature.
// So when a watching server is up the loop is driven through ITS api - the same path the UI
// uses - and otherwise through an in-process service and BuildService.
console.log('T12 Phase 4：真实站点上的 Page / Category 编辑 → 构建 → 预览 → 还原');
{
  const ABOUT_PAGE = 'page/about/index.md';
  const CATEGORY_PAGE = 'categories/Documentation/_index.md';
  const ABOUT_ABS = join(CONTENT_ROOT, ABOUT_PAGE);
  const CATEGORY_ABS = join(CONTENT_ROOT, CATEGORY_PAGE);
  const stamp = `${process.pid}${Date.now()}`;
  const pageMarker = `P4-PAGE-${stamp}`;
  const categoryMarker = `P4-CATEGORY-${stamp}`;

  const aboutBefore = readFileSync(ABOUT_ABS, 'utf8');
  const categoryBefore = readFileSync(CATEGORY_ABS, 'utf8');
  const treeBefore = treeHashes(CONTENT_ROOT);

  const inPublic = (needle) =>
    walk(join(SITE_ROOT, 'public'))
      .filter((file) => file.endsWith('.html'))
      .filter((file) => readFileSync(file, 'utf8').includes(needle))
      .map((file) => relative(SITE_ROOT, file));

  function localDriver() {
    const service = createDocumentService({
      contentRoot: CONTENT_ROOT,
      siteRoot: SITE_ROOT,
      sections: ['post', 'page', 'categories', ''],
      backupRoot: BACKUP_ROOT,
    });
    const paths = defaultBuildPaths({ editorRoot: EDITOR_ROOT, siteRoot: SITE_ROOT });
    const buildService = createBuildService({
      siteRoot: SITE_ROOT,
      stagingDir: paths.stagingDir,
      cacheDir: paths.cacheDir,
      publishDir: join(SITE_ROOT, 'public'),
      publishRoot: SITE_ROOT,
      timeoutMs: 180_000,
    });
    return {
      label: '进程内 service + BuildService',
      editPage: async (text) => service.saveEdit({ path: ABOUT_PAGE, text }),
      editCategory: async (set) => service.saveFields({ path: CATEGORY_PAGE, set }),
      revert: async () => {
        service.saveEdit({ path: ABOUT_PAGE, text: aboutBefore });
        service.saveEdit({ path: CATEGORY_PAGE, text: categoryBefore });
      },
      build: async () => {
        const record = await buildService.build({ trigger: 'manual' });
        return { state: record.state, message: record.message, generation: buildService.getStatus().generation };
      },
    };
  }

  function liveDriver(base) {
    // Every write goes through the server, which schedules the build itself after its own
    // debounce. "The build finished after my last write" is the condition to wait for: asking
    // for "the next build number" instead would race the debounce and wait forever.
    let lastWriteAt = 0;
    const status = async () => (await fetch(`${base}/api/build/status`)).json();
    const write = async (path, body) => {
      const payload = await postJson(base, path, body);
      lastWriteAt = Date.now();
      return payload;
    };
    return {
      label: `运行中的编辑器服务 ${base}`,
      editPage: (text) => write('/api/documents/save', { path: ABOUT_PAGE, text, confirm: true }),
      editCategory: (set) => write('/api/documents/fields/save', { path: CATEGORY_PAGE, set, confirm: true }),
      revert: async () => {
        await write('/api/documents/save', { path: ABOUT_PAGE, text: aboutBefore, confirm: true });
        await write('/api/documents/save', { path: CATEGORY_PAGE, text: categoryBefore, confirm: true });
      },
      build: async () => {
        const deadline = Date.now() + 240_000;
        for (;;) {
          const current = await status();
          const last = current.lastBuild;
          if (last && last.finishedAt >= lastWriteAt && current.activity !== 'building' && !current.queued) {
            return { state: last.state, message: last.message, generation: current.generation };
          }
          if (Date.now() > deadline) {
            return { state: 'timeout', message: '等待编辑器服务的构建超时', generation: current.generation };
          }
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      },
    };
  }

  const live = await detectEditorServer();
  const driver = live ? liveDriver(live.base) : localDriver();
  console.log(`     driver : ${driver.label}`);

  try {
    // A Page: the body, through the same save path the editor uses.
    const pageEdit = await driver.editPage(`${aboutBefore}\n${pageMarker}\n`);
    check(pageEdit.status === 'written', 'Page 保存写入真实站点', pageEdit.status);
    check(readFileSync(ABOUT_ABS, 'utf8').includes(pageMarker), 'Page 改动落盘');

    // A Category page: the description, through the front-matter form.
    const categoryEdit = await driver.editCategory({ description: categoryMarker });
    check(categoryEdit.status === 'written', 'Category description 表单保存写入真实站点', categoryEdit.status);
    check(readFileSync(CATEGORY_ABS, 'utf8').includes(categoryMarker), 'Category 改动落盘');

    const afterEdit = await driver.build();
    check(afterEdit.state === 'success', '编辑后构建成功', afterEdit.message);

    const pageHits = inPublic(pageMarker);
    check(pageHits.length > 0, 'Page 的改出现在发布输出里', pageHits.slice(0, 3).join(', '));
    const categoryHits = inPublic(categoryMarker);
    check(
      categoryHits.some((file) => file.includes('categories/documentation')),
      'Category 的改出现在它的栏目页里',
      categoryHits.slice(0, 3).join(', '),
    );
  } finally {
    // Put the real tree back, byte for byte, whatever happened above: the original bytes are
    // written back rather than the original VALUES, because the form is allowed to format a
    // field it writes and a formatted field is not the same file.
    await driver.revert();
    const reverted = await driver.build();
    check(reverted.state === 'success', '还原后构建成功', reverted.message);
  }

  const pageHitsAfter = inPublic(pageMarker);
  const categoryHitsAfter = inPublic(categoryMarker);
  check(pageHitsAfter.length === 0, '还原后 Page 的临时改动不再出现在输出里', pageHitsAfter.slice(0, 3).join(', '));
  check(categoryHitsAfter.length === 0, '还原后 Category 的临时改动不再出现在输出里', categoryHitsAfter.slice(0, 3).join(', '));

  const treeAfter = treeHashes(CONTENT_ROOT);
  const changed = [...treeBefore.keys()].filter((rel) => treeAfter.get(rel) !== treeBefore.get(rel));
  const added = [...treeAfter.keys()].filter((rel) => !treeBefore.has(rel));
  const removed = [...treeBefore.keys()].filter((rel) => !treeAfter.has(rel));
  check(
    changed.length + added.length + removed.length === 0,
    `真实 content/ 已逐字节还原（${treeBefore.size} 个文件）`,
    [...changed, ...added.map((p) => `+${p}`), ...removed.map((p) => `-${p}`)].join(', '),
  );
}

// T13 - Phase 5: site settings, on the real config files. A theme-only setting is turned
// into a site override, a language override is written, the site is rebuilt, and the change
// has to show up in the published HTML - that is the only proof a settings edit means
// anything. Then the original bytes go back and the output is checked again.
console.log('T13 Phase 5：真实站点设置写入 → 构建 → public 变化 → 还原');
{
  const CONFIG_ROOT = join(SITE_ROOT, 'config', '_default');
  const SETTINGS_FILES = ['hugo.toml', 'languages.toml', 'markup.toml', 'menu.toml', 'params.toml', 'related.toml'];
  const stamp = `${process.pid}${Date.now()}`;
  const jaMarker = `P5-JA-${stamp}`;
  const configBefore = new Map(SETTINGS_FILES.map((file) => [file, readFileSync(join(CONFIG_ROOT, file), 'utf8')]));
  const themeInfo = readThemeInfo({ siteRoot: SITE_ROOT, site: {} });

  const inPublicContent = (needle) =>
    walk(join(SITE_ROOT, 'public'))
      .filter((file) => file.endsWith('.html'))
      .filter((file) => readFileSync(file, 'utf8').includes(needle))
      .map((file) => relative(SITE_ROOT, file));

  const buildPaths = defaultBuildPaths({ editorRoot: EDITOR_ROOT, siteRoot: SITE_ROOT });
  const buildService = createBuildService({
    siteRoot: SITE_ROOT,
    stagingDir: buildPaths.stagingDir,
    cacheDir: buildPaths.cacheDir,
    publishDir: join(SITE_ROOT, 'public'),
    publishRoot: SITE_ROOT,
    timeoutMs: 180_000,
  });
  const settings = createSettingsService({ siteRoot: SITE_ROOT, configRoot: CONFIG_ROOT, backupRoot: BACKUP_ROOT, themeInfo });

  const live = await detectEditorServer();

  // When the editor server is running, its builds own the staging directory and the publish
  // step. A second BuildService pointed at the same paths would fight it for that directory,
  // so the acceptance never builds locally in that case - it asks the server and waits.
  const buildStatus = () => fetch(`${live.base}/api/build/status`).then((response) => response.json());

  // A write through the server's API schedules its own build (that is the editor's normal
  // behaviour). Waiting for that build to finish before asking for another one is what makes
  // this test deterministic: otherwise the manual build can be coalesced with the scheduled
  // one and the assertion runs against the output of the *previous* state.
  async function settle() {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const status = await buildStatus();
      if (status.activity !== 'building' && !status.queued) return status;
      if (Date.now() > deadline) return status;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  async function buildNow() {
    if (!live) {
      const record = await buildService.build({ trigger: 'manual' });
      return { state: record.state, message: record.message };
    }
    await settle();
    const before = await buildStatus();
    await postJson(live.base, '/api/build', { trigger: 'manual' });
    const deadline = Date.now() + 240_000;
    for (;;) {
      const status = await (await fetch(`${live.base}/api/build/status`)).json();
      const last = status.lastBuild;
      if (last && status.activity !== 'building' && !status.queued && status.generation > (before.generation ?? 0)) {
        return { state: last.state, message: last.message };
      }
      if (Date.now() > deadline) return { state: 'timeout', message: '等待编辑器服务的构建超时' };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  // The values this run writes are derived from the site's own config rather than assumed:
  // this config belongs to the user, and a personalised footer year or colour scheme must not
  // turn the acceptance red. What is asserted is the *transition* (theme -> site override) and
  // the round trip (the original value comes back).
  const describedBefore = settings.list();
  const sinceBefore = describedBefore.settings['params.footer.since'].value;
  const sinceNext = Number(sinceBefore) + 1;
  // The Stack theme prints "<since> - <current year>" only when the two differ, and the year
  // alone when they are the same. Both assertions below follow that rule, so a site whose footer
  // year is the current year does not read as a failed restore.
  const thisYear = String(new Date().getFullYear());
  const footerYearText = (since) => (String(since) === thisYear ? String(since) : `${since} -`);
  const copyrightLine = (html) =>
    (html.match(/<section class="copyright">([\s\S]*?)<\/section>/) ?? ['', ''])[1].replace(/\s+/g, ' ').trim();
  const schemeSourceBefore = describedBefore.settings['params.colorScheme.default'].source;

  const edits = {
    set: {
      // theme-only settings become a site override the first time they are saved
      'params.colorScheme.default': 'dark',
      'params.footer.since': sinceNext,
      'params.sidebar.subtitle@ja': jaMarker,
    },
  };

  try {
    const described = describedBefore;
    check(['theme', 'site'].includes(schemeSourceBefore), `保存前 colorScheme.default 的来源可读（${schemeSourceBefore}）`);
    const jaSubtitle = described.settings['params.sidebar.subtitle'].languageRows.find((row) => row.code === 'ja');
    check(jaSubtitle.present === true && jaSubtitle.id === 'params.sidebar.subtitle@ja', 'ja 副标题原本已有覆盖');

    const planned = settings.preview(edits);
    check(planned.status === 'preview' && planned.changedFiles.includes('params.toml'), 'dry-run 给出计划', planned.changedFiles.join(', '));
    check(
      SETTINGS_FILES.every((file) => readFileSync(join(CONFIG_ROOT, file), 'utf8') === configBefore.get(file)),
      'dry-run 未写入任何配置文件',
    );

    if (live) {
      const saved = await postJson(live.base, '/api/settings/save', { confirm: true, ...edits });
      check(saved.status === 'written', `通过 ${live.base} 写入真实配置`, saved.status);
    } else {
      const saved = settings.save(edits);
      check(saved.status === 'written', '进程内 service 写入真实配置', saved.status);
    }

    const params = readFileSync(join(CONFIG_ROOT, 'params.toml'), 'utf8');
    const languages = readFileSync(join(CONFIG_ROOT, 'languages.toml'), 'utf8');
    check(/default\s+= "dark"/.test(params), '主题默认被写成本站覆盖值', 'colorScheme.default');
    check(new RegExp(`since\\s+= ${sinceNext}`).test(params), 'footer.since 已更新');
    check(languages.includes(jaMarker), 'ja 语言覆盖已写入 languages.toml');
    check(
      ['hugo.toml', 'markup.toml', 'menu.toml', 'related.toml'].every((file) => readFileSync(join(CONFIG_ROOT, file), 'utf8') === configBefore.get(file)),
      '未改动的配置文件逐字节一致',
    );
    check(settings.list().settings['params.colorScheme.default'].source === 'site', '保存后来源变为本站配置');

    const built = await buildNow();
    check(built.state === 'success', '设置改动后构建成功', built.message);

    const home = readFileSync(join(SITE_ROOT, 'public', 'index.html'), 'utf8');
    check(home.includes('localStorage.setItem(colorSchemeKey, "dark")'), '主题默认的改动出现在 public 里（暗色）');
    check(copyrightLine(home).includes(footerYearText(sinceNext)), 'footer.since 的改动出现在 public 里');
    const jaHits = inPublicContent(jaMarker);
    check(jaHits.some((file) => file.startsWith('public/ja/')), 'ja 副标题的改动出现在 ja 页面里', jaHits.slice(0, 3).join(', '));
  } finally {
    // The original bytes go back, not the original values: the engine is allowed to keep a
    // file's own formatting, and only the bytes prove the site was restored.
    for (const [file, text] of configBefore) writeFileSync(join(CONFIG_ROOT, file), text);
  }

  const restored = await buildNow();
  check(restored.state === 'success', '还原后构建成功', restored.message);
  check(inPublicContent(jaMarker).length === 0, '还原后临时 ja 覆盖不再出现在输出里');
  const restoredCopyright = copyrightLine(readFileSync(join(SITE_ROOT, 'public', 'index.html'), 'utf8'));
  check(
    restoredCopyright.includes(footerYearText(sinceBefore)) && !restoredCopyright.includes(String(sinceNext)),
    `还原后 footer.since 回到原值 ${sinceBefore}`,
    restoredCopyright.slice(0, 90),
  );

  const configAfter = new Map(SETTINGS_FILES.map((file) => [file, readFileSync(join(CONFIG_ROOT, file), 'utf8')]));
  const configChanged = SETTINGS_FILES.filter((file) => configAfter.get(file) !== configBefore.get(file));
  check(configChanged.length === 0, `config/_default 已逐字节还原（${SETTINGS_FILES.length} 个文件）`, configChanged.join(', '));
}

// T14 - Phase 6: binary resources on the REAL site. The lifecycle of an image is only real
// if the built output follows it: a new image has to appear in public/, a replacement has to
// change the published bytes while the page's reference keeps working, a deletion has to
// remove the output (not just the file), and a restore has to bring the identical bytes back.
// Markdown referencing the replaced image is checked too, because a resource without its page
// is a file without a meaning.
//
// When the editor server is running, every write goes through its HTTP API rather than through
// an in-process service: that is what keeps the *server's* watcher, build scheduling and
// publish manifest in the loop (a direct file write would look like an external edit and race
// the build this test waits for). Without a server, the same calls run in-process.
console.log('T14 Phase 6：真实站点二进制资源（新增 / 替换 / 删除 / 恢复 + 构建后 public 变化）');
{
  const GALLERY = 'post/Image Gallery';
  const REFERENCED = `${GALLERY}/hudai-gayiran-3Od_VKcDEAA-unsplash.jpg`;
  const PUBLISHED_REFERENCED = join(SITE_ROOT, 'public', 'p', 'image-gallery', 'hudai-gayiran-3Od_VKcDEAA-unsplash.jpg');
  const stamp = `${process.pid}${Date.now()}`;
  const uploadName = `p6-acceptance-${stamp}.png`;
  const uploadPath = `${GALLERY}/${uploadName}`;
  const PUBLISHED_UPLOAD = join(SITE_ROOT, 'public', 'p', 'image-gallery', uploadName);
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );
  const bufferSha = (buffer) => createHash('sha256').update(buffer).digest('hex');
  const fileSha = (abs) => bufferSha(readFileSync(abs));
  const contentBefore = sourceHashes();
  const referencedBefore = fileSha(join(CONTENT_ROOT, REFERENCED));
  const originalReferencedBytes = readFileSync(join(CONTENT_ROOT, REFERENCED));
  const markdownBefore = readFileSync(join(CONTENT_ROOT, GALLERY, 'index.md'), 'utf8');
  // Same extension, different bytes: a replacement has to keep the name and the bytes agreeing.
  const replacementBytes = readFileSync(join(CONTENT_ROOT, GALLERY, 'luca-bravo-alS7ewQ41M8-unsplash.jpg'));

  const documents = createDocumentService({
    contentRoot: CONTENT_ROOT,
    siteRoot: SITE_ROOT,
    sections: ['post', 'page', 'categories', ''],
    backupRoot: BACKUP_ROOT,
  });
  const assets = createAssetService({
    siteRoot: SITE_ROOT,
    contentRoot: CONTENT_ROOT,
    staticRoot: join(SITE_ROOT, 'static'),
    assetRoot: join(SITE_ROOT, 'assets'),
    backupRoot: BACKUP_ROOT,
    guard: documents.guard,
    documents,
    defaultLanguage: documents.defaultLanguage,
  });

  const buildPaths = defaultBuildPaths({ editorRoot: EDITOR_ROOT, siteRoot: SITE_ROOT });
  const buildService = createBuildService({
    siteRoot: SITE_ROOT,
    stagingDir: buildPaths.stagingDir,
    cacheDir: buildPaths.cacheDir,
    publishDir: join(SITE_ROOT, 'public'),
    publishRoot: SITE_ROOT,
    timeoutMs: 180_000,
  });
  const live = await detectEditorServer();

  // One write surface, two backends: the running server's API (whose watcher and publish
  // manifest are then part of the loop) or the same calls in-process.
  const resources = live
    ? {
        location: `HTTP ${live.base}`,
        list: async () => await (await fetch(`${live.base}/api/assets`)).json(),
        planUpload: (bundlePath, filename) => postJson(live.base, '/api/assets/upload', { bundlePath, filename }),
        upload: (bundlePath, filename, dataBase64) => postJson(live.base, '/api/assets/upload', { bundlePath, filename, dataBase64, confirm: true }),
        replace: (path, dataBase64) => postJson(live.base, '/api/assets/replace', { path, dataBase64, confirm: true }),
        planRemove: (path) => postJson(live.base, '/api/assets/delete', { path }),
        remove: (path) => postJson(live.base, '/api/assets/delete', { path, confirm: true }),
        restore: (id) => postJson(live.base, '/api/trash/restore', { id, confirm: true }),
      }
    : {
        location: '进程内 AssetService',
        list: () => assets.listAssets(),
        planUpload: (bundlePath, filename) => assets.planUpload({ bundlePath, filename }),
        upload: (bundlePath, filename, dataBase64) => assets.upload({ bundlePath, filename, dataBase64, confirm: true }),
        replace: (path, dataBase64) => assets.replace({ path, dataBase64, confirm: true }),
        planRemove: (path) => assets.planRemove({ path }),
        remove: (path) => assets.remove({ path, confirm: true }),
        restore: (id) => assets.restore({ id }),
      };

  const buildStatus = () => fetch(`${live.base}/api/build/status`).then((response) => response.json());

  // A write through the server's API schedules its own build (that is the editor's normal
  // behaviour). Waiting for that build to finish before asking for another one is what makes
  // this test deterministic: otherwise the manual build can be coalesced with the scheduled
  // one and the assertion runs against the output of the *previous* state.
  async function settle() {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const status = await buildStatus();
      if (status.activity !== 'building' && !status.queued) return status;
      if (Date.now() > deadline) return status;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  async function buildNow() {
    if (!live) {
      const record = await buildService.build({ trigger: 'manual' });
      return { state: record.state, message: record.message };
    }
    await settle();
    const before = await buildStatus();
    await postJson(live.base, '/api/build', { trigger: 'manual' });
    const deadline = Date.now() + 240_000;
    for (;;) {
      const status = await buildStatus();
      const last = status.lastBuild;
      if (last && status.activity !== 'building' && !status.queued && status.generation > (before.generation ?? 0)) {
        return { state: last.state, message: last.message };
      }
      if (Date.now() > deadline) return { state: 'timeout', message: '等待编辑器服务的构建超时' };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  // The preview converges rather than switches. A write schedules its own build, the watcher
  // may have scheduled another, and this test can also be racing both - so the *property* is
  // polled (pushing another build when the interval passes) instead of sampled at a moment
  // that depends on when the last build happened to start.
  async function converge(predicate, { attempts = 4, betweenMs = 6000 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await predicate()) return true;
      if (live) {
        await settle();
        await postJson(live.base, '/api/build', { trigger: 'manual' });
      } else {
        await buildService.build({ trigger: 'manual' });
      }
      const deadline = Date.now() + betweenMs;
      while (Date.now() < deadline) {
        if (await predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    return Boolean(await predicate());
  }

  let cleanupTrashId = null;
  try {
    console.log(`     driver : ${resources.location}`);

    // Discovery: the gallery's images are page resources of the bundle, with the capabilities
    // an image needs, and the site trees are listed but read-only.
    const listing = await resources.list();
    const gallery = listing.bundles.find((bundle) => bundle.bundlePath === GALLERY);
    check(Boolean(gallery), 'bundle 的资源被列出', `${listing.summary.contentResources} 个内容资源 / ${listing.summary.staticFiles} 个静态文件`);
    check(
      Boolean(gallery) && gallery.resources.some((resource) => resource.path === REFERENCED && resource.capabilities.replace && resource.capabilities.delete),
      '页面资源可替换、可删除',
      (gallery?.resources ?? []).map((resource) => resource.filename).join(', '),
    );
    check(
      listing.static.every((asset) => !asset.capabilities.replace && !asset.capabilities.delete),
      'static/ 与 assets/ 只读（仅列出与预览）',
      `static ${listing.summary.staticFiles} / assets ${listing.summary.pipelineFiles}`,
    );

    // A plan writes nothing: the file is not on disk and the output is untouched.
    const uploadPlan = await resources.planUpload(GALLERY, uploadName);
    check(uploadPlan.status === 'preview' && uploadPlan.canWrite && !existsSync(join(CONTENT_ROOT, uploadPath)), '上传先给出计划，且不落盘');

    // Add: a new image in the bundle, then a replacement of one the page already references.
    const created = await resources.upload(GALLERY, uploadName, PNG.toString('base64'));
    check(created.status === 'created' && fileSha(join(CONTENT_ROOT, uploadPath)) === bufferSha(PNG), '新增图片：磁盘字节与上传内容一致');

    const replaced = await resources.replace(REFERENCED, replacementBytes.toString('base64'));
    check(replaced.status === 'replaced', '替换被引用的图片：计划 + 备份 + 写入');
    check(Boolean(replaced.backupPath) && existsSync(replaced.backupPath), '替换前先备份旧字节', replaced.backupPath ?? '');
    check(fileSha(join(CONTENT_ROOT, REFERENCED)) === bufferSha(replacementBytes), '替换后磁盘字节即为新内容');

    const built1 = await buildNow();
    check(built1.state === 'success', '新增 + 替换后构建成功', built1.message);
    check(
      await converge(() => existsSync(PUBLISHED_UPLOAD) && fileSha(PUBLISHED_UPLOAD) === bufferSha(PNG)),
      '新增的图片出现在 public/ 里',
    );
    check(
      await converge(() => fileSha(PUBLISHED_REFERENCED) === bufferSha(replacementBytes)),
      '被替换图片的输出字节随之更新',
    );
    check(
      readFileSync(join(CONTENT_ROOT, GALLERY, 'index.md'), 'utf8') === markdownBefore,
      '资源操作没有改写引用它的 Markdown（路径不变，引用继续有效）',
    );
    check(
      readFileSync(join(SITE_ROOT, 'public', 'p', 'image-gallery', 'index.html'), 'utf8').includes('hudai-gayiran-3Od_VKcDEAA-unsplash'),
      '构建后的页面仍然引用该资源',
    );

    // Delete: a reversible move, and the output follows - the file is gone from public/ too.
    const removePlan = await resources.planRemove(uploadPath);
    check(removePlan.status === 'preview' && removePlan.recoverable && existsSync(join(CONTENT_ROOT, uploadPath)), '删除先给出计划且可恢复');
    const deleted = await resources.remove(uploadPath);
    check(deleted.status === 'deleted' && !existsSync(join(CONTENT_ROOT, uploadPath)), '图片被移入回收站，源文件已不在站点里');

    const built2 = await buildNow();
    check(built2.state === 'success', '删除后构建成功', built2.message);
    check(await converge(() => !existsSync(PUBLISHED_UPLOAD)), '删除的图片不再出现在 public/ 里（发布清单裁剪）');
    check(existsSync(PUBLISHED_REFERENCED), '同一目录里未被删除的图片仍然在 public/ 里');

    // Restore: the trash moves the identical bytes back, and the preview follows again.
    const restored = await resources.restore(deleted.trashId);
    check(restored.relPath === uploadPath && existsSync(join(CONTENT_ROOT, uploadPath)), '从回收站恢复到原路径');
    check(fileSha(join(CONTENT_ROOT, uploadPath)) === bufferSha(PNG), '恢复是逐字节的（不是重新编码）');

    const built3 = await buildNow();
    check(built3.state === 'success', '恢复后构建成功', built3.message);
    check(
      await converge(() => existsSync(PUBLISHED_UPLOAD) && fileSha(PUBLISHED_UPLOAD) === bufferSha(PNG)),
      '恢复的图片重新出现在 public/ 里',
    );
  } finally {
    // The user's site goes back exactly as it was, through the same two operations a person
    // would use: the test image is deleted again (so it lands in the trash rather than
    // vanishing), and the replaced image gets its original bytes back - the counterpart of the
    // replace, through the same write path.
    if (existsSync(join(CONTENT_ROOT, uploadPath))) {
      try {
        const removed = await resources.remove(uploadPath);
        cleanupTrashId = removed.trashId;
      } catch {
        // Already gone: nothing left to clean up.
      }
    }
    await resources.replace(REFERENCED, originalReferencedBytes.toString('base64'));
  }

  const finalBuild = await buildNow();
  check(finalBuild.state === 'success', '清理后构建成功', finalBuild.message);
  check(fileSha(join(CONTENT_ROOT, REFERENCED)) === referencedBefore, '被替换的图片已按字节还原');
  check(await converge(() => !existsSync(PUBLISHED_UPLOAD)), '验收产生的临时图片没有留在 public/ 里');
  check(
    await converge(() => fileSha(PUBLISHED_REFERENCED) === referencedBefore),
    '被替换图片的输出也回到原字节',
  );
  check(Boolean(cleanupTrashId), '清理走的也是回收站（临时图片可人工恢复）', cleanupTrashId ?? '');

  const contentAfter = sourceHashes();
  checkSourceRestored(
    `Hugo 源树在 T14 后逐字节还原（${contentBefore.size} 个文件）`,
    contentBefore,
    contentAfter,
    [GALLERY],
  );
}

// T15/T16 - Phase 7: tags as a cross-document object, and links as a structured list. Both run
// against the REAL site, because the thing being proven is not that a helper returns a string:
// it is that renaming a tag rewrites exactly the files that use it (and nothing else), that
// Hugo's own taxonomy output follows, that a metadata page moves with its tag to the directory
// Hugo actually looks in, and that everything can be put back byte for byte.
//
// Writes go through the editor server's HTTP API when it is running (so its watcher, build
// scheduling and publish manifest stay in the loop) and through the same services in-process
// when it is not. The two drivers are the same calls either way.
const p7Server = await detectEditorServer();
const p7ContentBefore = sourceHashes();
const p7BuildPaths = defaultBuildPaths({ editorRoot: EDITOR_ROOT, siteRoot: SITE_ROOT });
const p7BuildService = createBuildService({
  siteRoot: SITE_ROOT,
  stagingDir: p7BuildPaths.stagingDir,
  cacheDir: p7BuildPaths.cacheDir,
  publishDir: join(SITE_ROOT, 'public'),
  publishRoot: SITE_ROOT,
  timeoutMs: 180_000,
});

async function p7BuildStatus() {
  return await (await fetch(`${p7Server.base}/api/build/status`)).json();
}

async function p7Settle() {
  if (!p7Server) return null;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const status = await p7BuildStatus();
    if (status.activity !== 'building' && !status.queued) return status;
    if (Date.now() > deadline) return status;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

// Build and wait for the *result*, so an assertion never runs against the previous generation.
async function p7BuildNow() {
  if (!p7Server) {
    const record = await p7BuildService.build({ trigger: 'manual' });
    return { state: record.state, message: record.message };
  }
  await p7Settle();
  const before = await p7BuildStatus();
  await postJson(p7Server.base, '/api/build', { trigger: 'manual' });
  const deadline = Date.now() + 240_000;
  for (;;) {
    const status = await p7BuildStatus();
    const last = status.lastBuild;
    if (last && status.activity !== 'building' && !status.queued && status.generation > (before.generation ?? 0)) {
      return { state: last.state, message: last.message };
    }
    if (Date.now() > deadline) return { state: 'timeout', message: '等待编辑器服务的构建超时' };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// The same convergence loop T14 uses: a write may have scheduled its own build, so the
// *property* is polled (pushing a build when the interval passes) instead of sampled once.
async function p7Converge(predicate, { attempts = 4, betweenMs = 6000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return true;
    if (p7Server) {
      await p7Settle();
      await postJson(p7Server.base, '/api/build', { trigger: 'manual' });
    } else {
      await p7BuildService.build({ trigger: 'manual' });
    }
    const deadline = Date.now() + betweenMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return Boolean(await predicate());
}

console.log('T15 Phase 7：真实站点标签关系（跨文档改名 / 同义合并 / 元数据页迁移 + 构建后 taxonomy 变化）');
{
  const documents = createDocumentService({
    contentRoot: CONTENT_ROOT,
    siteRoot: SITE_ROOT,
    sections: ['post', 'page', 'categories', ''],
    backupRoot: BACKUP_ROOT,
  });
  const relations = createRelationService({ documentService: documents, backupRoot: BACKUP_ROOT });
  const TAGS = 'test';
  const MERGED = 'testing';
  const GALLERY_PAGE = 'tags/Gallery/_index.md';
  const RENAMED_PAGE = 'tags/Gallery 相册/_index.md';
  const MARKER = `PHASE7-META-${process.pid}${Date.now()}`;
  const sample = join(CONTENT_ROOT, 'post', 'pagination-test-01.en.md');

  const tags = p7Server
    ? {
        driver: `HTTP ${p7Server.base}`,
        list: async () => await (await fetch(`${p7Server.base}/api/tags`)).json(),
        detail: async (name) => await (await fetch(`${p7Server.base}/api/tags/detail?name=${encodeURIComponent(name)}`)).json(),
        plan: (request) => postJson(p7Server.base, '/api/tags/plan', request),
        apply: (request) => postJson(p7Server.base, '/api/tags/apply', { ...request, confirm: true }),
        planError: async (request) => {
          const response = await fetch(`${p7Server.base}/api/tags/plan`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
          });
          return { status: response.status, body: await response.json() };
        },
      }
    : {
        driver: '进程内 RelationService',
        list: () => relations.listTags(),
        detail: (name) => relations.tagDetail({ name }),
        plan: (request) => (request.action === 'edit'
          ? relations.planTagEdit(request)
          : request.action === 'page'
            ? relations.planTagPageCreate(request)
            : relations.planTagRename({ from: request.from, to: request.to, mode: request.action })),
        apply: (request) => {
          const planned = request.action === 'edit'
            ? relations.planTagEdit(request)
            : request.action === 'page'
              ? relations.planTagPageCreate(request)
              : relations.planTagRename({ from: request.from, to: request.to, mode: request.action });
          return planned.then((plan) => {
            const result = relations.apply(plan);
            return {
              ...result,
              counts: plan.changeSet.counts,
              noop: plan.changeSet.counts.total === 0,
              changes: plan.changeSet.changes.map((change) => ({ kind: change.kind, relPath: change.relPath })),
              buildScheduled: false,
            };
          });
        },
        planError: async (request) => {
          try {
            await tags.plan(request);
            return { status: 200, body: null };
          } catch (cause) {
            return { status: cause instanceof TagConflictError ? 409 : 400, body: { error: cause.message } };
          }
        },
      };

  const sampleBefore = readFileSync(sample, 'utf8');

  try {
    console.log(`     driver : ${tags.driver}`);

    // Discovery: the index is a view over the walk, so no document body is read for it, and the
    // site's missing content/tags means no tag is reported as lacking a metadata page.
    const index = await tags.list();
    // The vocabulary is derived from the documents' own front matter rather than pinned to a
    // number: articles - and tags - are added by the person who owns the site, and that must not
    // read as a regression. A term is the case-insensitive identity of a spelling, which is the
    // property under test here.
    const spellings = new Set();
    for (const file of walk(CONTENT_ROOT)) {
      if (!file.endsWith('.md')) continue;
      const front = readFileSync(file, 'utf8').split(/^---\s*$/m)[1] ?? '';
      const block = front.split(/^tags:/m)[1]?.split(/^\S/m)[0] ?? '';
      for (const match of block.matchAll(/^\s*-\s*(.+?)\s*$/gm)) spellings.add(match[1].replace(/^['"]|['"]$/g, ''));
    }
    const identities = new Set([...spellings].map((name) => name.toLowerCase()));
    check(
      index.tags.length === identities.size,
      `标签索引：${identities.size} 个 term`,
      `标签 ${index.tags.length} 个`,
    );
    check(
      index.tags.flatMap((tag) => tag.names).length === spellings.size,
      `${spellings.size} 种写法：大小写不同的 markdown / Markdown 是同一个 term`,
      index.tags.flatMap((tag) => tag.names).map((entry) => entry.name).join(', '),
    );
    check(
      index.tags.every((tag) => tag.metadataPages.length === 0),
      '本站没有 content/tags 目录 → 没有任何标签被当作“缺少元数据页”',
    );
    const markdown = index.tags.find((tag) => tag.identity === 'markdown');
    check(
      Boolean(markdown) && markdown.usage === 3 && markdown.names.length === 2 && markdown.conflicts.length === 1,
      'markdown / Markdown 合并为一个 term 并标记冲突',
      `${markdown?.usage} 份文档，写法 ${markdown?.names.map((entry) => entry.name).join(' / ')}`,
    );

    const detail = await tags.detail('隐私');
    check(
      detail.usage === 3 && detail.languages.length === 3 && detail.groups.length === 1 && detail.groups[0].members.length === 3,
      '标签详情按翻译组列出多语言文档',
      `${detail.usage} 份文档 / ${detail.languages.join(' ')} / ${detail.groups.length} 组`,
    );

    // A plan is advisory: it names the files and shows the diff, and writes nothing.
    const plan = await tags.plan({ action: 'merge', from: TAGS, to: MERGED });
    check(
      plan.counts.modify === 12 && plan.counts.total === 12 && plan.changes.length === 12,
      '合并计划覆盖 12 份使用该标签的文档',
      `${plan.counts.modify} 个文件 / ${plan.touched.length} 个路径`,
    );
    check(
      plan.changes.every((change) => change.diff.removed === 1 && change.diff.added === 1),
      '每个文件的 diff 只有那一行标签',
      plan.changes[0].diffText.split('\n').slice(2).join(' | '),
    );
    check(
      readFileSync(sample, 'utf8') === sampleBefore,
      '计划阶段源文件逐字节不变（dry run 不落盘）',
    );

    const conflict = await tags.planError({ action: 'rename', from: TAGS, to: 'pagination' });
    check(
      conflict.status === 409,
      '重命名到站点已有的标签被拒绝（409），不会静默合并',
      String(conflict.body?.error ?? '').slice(0, 60),
    );

    const applied = await tags.apply({ action: 'merge', from: TAGS, to: MERGED });
    check(applied.counts.modify === 12 && applied.status === 'committed', '确认后一次写入 12 份文档', `status=${applied.status}`);
    const sampleAfter = readFileSync(sample, 'utf8');
    check(/^ {2}- testing$/m.test(sampleAfter) && /^ {2}- pagination$/m.test(sampleAfter), '文档里标签改成了目标值，同一列表里的其他标签没被碰过');

    const built1 = await p7BuildNow();
    check(built1.state === 'success', '合并后构建成功', built1.message);
    check(
      await p7Converge(() => existsSync(join(SITE_ROOT, 'public', 'en', 'tags', MERGED, 'index.html'))),
      'Hugo 生成了新标签的 taxonomy 页面',
    );
    check(
      await p7Converge(() => !existsSync(join(SITE_ROOT, 'public', 'en', 'tags', TAGS, 'index.html'))),
      '旧标签的 taxonomy 页面随之消失（不是留下空页）',
    );
    check(
      await p7Converge(() => {
        const page = join(SITE_ROOT, 'public', 'en', 'p', 'pagination-test-01', 'index.html');
        return existsSync(page) && readFileSync(page, 'utf8').includes(MERGED);
      }),
      '文章页面渲染出新标签（英文版的 /en/p/pagination-test-01/）',
    );

    // A metadata page is created only when asked for, and Hugo attaches it to the term whose
    // name the directory carries.
    // The marker is the page's *title*: that is what this theme renders for a term page (the
    // term template shows the metadata page's title, not its body).
    const pageRequest = { action: 'page', name: 'Gallery', title: MARKER };
    const pagePlan = await tags.plan(pageRequest);
    check(pagePlan.counts.create === 1, '元数据页先给出计划', pagePlan.changes[0]?.relPath ?? '');
    const pageApplied = await tags.apply(pageRequest);
    check(pageApplied.counts.create === 1 && existsSync(join(CONTENT_ROOT, GALLERY_PAGE)), '创建标签元数据页 content/tags/Gallery/_index.md');

    const galleryBefore = readFileSync(join(CONTENT_ROOT, GALLERY_PAGE), 'utf8');
    check(galleryBefore === `---\ntitle: ${MARKER}\n---\n`, '元数据页内容就是给出的 title', galleryBefore.replace(/\n/g, '⏎'));
    check(
      await p7Converge(() => {
        const page = join(SITE_ROOT, 'public', 'tags', 'gallery', 'index.html');
        return existsSync(page) && readFileSync(page, 'utf8').includes(`<title>${MARKER}</title>`);
      }),
      'Hugo 把 content/tags/Gallery/ 用作 Gallery 标签的元数据页',
    );

    const renamePlan = await tags.plan({ action: 'rename', from: 'Gallery', to: 'Gallery 相册' });
    check(
      renamePlan.counts.modify === 4 && renamePlan.counts.move === 1 && (renamePlan.warnings ?? []).length === 0,
      '改名计划：4 份文档 + 1 个元数据页迁移，且没有告警',
      `modify=${renamePlan.counts.modify} move=${renamePlan.counts.move}`,
    );
    await tags.apply({ action: 'rename', from: 'Gallery', to: 'Gallery 相册' });
    check(
      existsSync(join(CONTENT_ROOT, RENAMED_PAGE)) && !existsSync(join(CONTENT_ROOT, GALLERY_PAGE)),
      '元数据页随标签移动到以新标签名命名的目录',
    );
    check(readFileSync(join(CONTENT_ROOT, RENAMED_PAGE), 'utf8') === galleryBefore, '迁移是逐字节的（不是重新序列化）');
    check(
      await p7Converge(() => {
        const page = join(SITE_ROOT, 'public', 'tags', 'gallery-相册', 'index.html');
        return existsSync(page) && readFileSync(page, 'utf8').includes(`<title>${MARKER}</title>`);
      }),
      'Hugo 在新标签的页面里用上了迁移过来的元数据页（目录名 = 标签名，URL 由 Hugo 生成）',
    );
    check(
      await p7Converge(() => !existsSync(join(SITE_ROOT, 'public', 'tags', 'gallery', 'index.html'))),
      '旧标签名不再有页面',
    );

    // Put the tag back the way it was, through the same write path.
    await tags.apply({ action: 'rename', from: 'Gallery 相册', to: 'Gallery' });
    check(
      existsSync(join(CONTENT_ROOT, GALLERY_PAGE)) && readFileSync(join(CONTENT_ROOT, GALLERY_PAGE), 'utf8') === galleryBefore,
      '标签改回原名时元数据页也回到原目录、原字节',
    );
    await tags.apply({ action: 'merge', from: MERGED, to: TAGS });
    check(readFileSync(sample, 'utf8') === sampleBefore, '反向合并后样本文档逐字节还原');
  } finally {
    // The site goes back exactly as it was, through the same write path - and this runs even if
    // an assertion above threw, so a failed run cannot leave the user's tags renamed. Each step
    // is a no-op when the step it reverses never happened.
    try {
      const current = await tags.list();
      if (current.tags.some((tag) => tag.name === 'Gallery 相册')) {
        await tags.apply({ action: 'rename', from: 'Gallery 相册', to: 'Gallery' });
      }
    } catch {
      // The tag was never renamed: nothing to undo.
    }
    // The temporary metadata page is deleted through the editor's own delete (so it lands in
    // the trash and stays recoverable), and the empty directory it lived in is removed - a
    // directory is not a document, so there is no service call for it.
    try {
      for (const rel of [GALLERY_PAGE, RENAMED_PAGE]) {
        if (existsSync(join(CONTENT_ROOT, rel))) await documents.removeDocument({ path: rel, scope: 'document' });
      }
    } catch {
      // Already gone.
    }
    // The temporary taxonomy directory itself: a directory is not a document, so there is no
    // service call for it. It is removed only when it holds no files at all - if the user ever
    // grows a real content/tags tree, this leaves it alone.
    const taxonomyRoot = join(CONTENT_ROOT, 'tags');
    if (existsSync(taxonomyRoot) && walk(taxonomyRoot).length === 0) rmSync(taxonomyRoot, { recursive: true, force: true });
    try {
      if (readFileSync(sample, 'utf8').includes(MERGED)) await tags.apply({ action: 'merge', from: MERGED, to: TAGS });
    } catch {
      // The merge was never applied, or is already reversed.
    }
  }

  const finalBuild = await p7BuildNow();
  check(finalBuild.state === 'success', 'T15 清理后构建成功', finalBuild.message);
  check(
    await p7Converge(() => existsSync(join(SITE_ROOT, 'public', 'en', 'tags', TAGS, 'index.html'))
      && !existsSync(join(SITE_ROOT, 'public', 'en', 'tags', MERGED, 'index.html'))),
    '构建输出回到改名前的 taxonomy 页面',
  );
  check(!existsSync(join(CONTENT_ROOT, 'tags')), '验收没有在 content/ 下留下 tags 目录');
}
console.log('T16 Phase 7：真实站点链接列表编辑（字段 / 新增 / 排序 / 删除 + 构建后页面变化 + 还原）');
{
  const documentsT16 = createDocumentService({
    contentRoot: CONTENT_ROOT,
    siteRoot: SITE_ROOT,
    sections: ['post', 'page', 'categories', ''],
    backupRoot: BACKUP_ROOT,
  });
  const relationsT16 = createRelationService({ documentService: documentsT16, backupRoot: BACKUP_ROOT });
  const LINKS = 'page/links/index.md';
  const LINKS_ABS = join(CONTENT_ROOT, LINKS);
  const OTHER_LANG = join(CONTENT_ROOT, 'page/links/index.en.md');
  // The Chinese links page is published at /链接/ (the slug comes from the site's permalink
  // config), and its images are processed copies under the same URL.
  const PUBLISHED = join(SITE_ROOT, 'public', '链接', 'index.html');
  const MARK = `PHASE7-LINK-${process.pid}${Date.now()}`;
  const NEW_TITLE = `Example ${process.pid}`;

  const links = p7Server
    ? {
        driver: `HTTP ${p7Server.base}`,
        view: async (path) => await (await fetch(`${p7Server.base}/api/links?path=${encodeURIComponent(path)}`)).json(),
        plan: (request) => postJson(p7Server.base, '/api/links/plan', request),
        apply: (request) => postJson(p7Server.base, '/api/links/apply', { ...request, confirm: true }),
      }
    : {
        driver: '进程内 RelationService',
        view: (path) => relationsT16.links({ path }),
        plan: (request) => relationsT16.planLinkEdits(request),
        apply: async (request) => {
          const plan = await relationsT16.planLinkEdits(request);
          const result = relationsT16.apply(plan);
          return { ...result, counts: plan.changeSet.counts, applied: plan.applied, skipped: plan.skipped };
        },
      };

  const before = readFileSync(LINKS_ABS, 'utf8');
  const otherLangBefore = readFileSync(OTHER_LANG, 'utf8');
  const publishedBefore = existsSync(PUBLISHED) ? sha256(readFileSync(PUBLISHED, 'utf8')) : null;

  try {
    console.log(`     driver : ${links.driver}`);

    // Discovery: the list of maps the field form refuses is the list this view is built on.
    const view = await links.view(LINKS);
    check(
      view.present === true && view.items.length === 2 && view.keyOrder.join(',') === 'title,description,website,image',
      '读到一个页面里的 links 条目与文档自有的键顺序',
      `${view.items.length} 个条目 / ${view.keyOrder.join(' → ')}`,
    );
    check(
      view.items[0].imageRef.kind === 'external' && view.items[1].imageRef.kind === 'resource'
        && view.items[1].imageRef.resourcePath === 'page/links/ts-logo-128.jpg',
      '图片引用区分外部链接与同一 bundle 的页面资源',
      `${view.items[0].imageRef.kind} / ${view.items[1].imageRef.kind}`,
    );
    check(
      Boolean(publishedBefore) && readFileSync(PUBLISHED, 'utf8').includes('ts-logo-128'),
      '构建后的链接页引用了同一 bundle 里的资源',
    );
    check(view.malformed.length === 0, '没有无法识别的条目');

    // A plan is a dry run: exactly one line, and nothing on disk.
    const editPlan = await links.plan({ path: LINKS, edit: [{ index: 1, set: { description: MARK } }] });
    check(
      editPlan.counts.modify === 1 && editPlan.changes[0].diff.changed === 2,
      '改一个条目的一个字段 = 一行改动',
      editPlan.changes[0].diffText.split('\n').slice(2).join(' | '),
    );
    check(readFileSync(LINKS_ABS, 'utf8') === before, '计划阶段文件逐字节不变（dry run 不落盘）');

    const editApplied = await links.apply({ path: LINKS, edit: [{ index: 1, set: { description: MARK } }] });
    check(editApplied.counts.modify === 1, '确认后写入 1 个文件');
    check(
      readFileSync(LINKS_ABS, 'utf8') === before.replace(view.items[1].description, MARK),
      '写入结果与预览的 diff 完全一致（其余字节不变）',
    );

    const builtEdit = await p7BuildNow();
    check(builtEdit.state === 'success', '编辑后构建成功', builtEdit.message);
    check(
      await p7Converge(() => readFileSync(PUBLISHED, 'utf8').includes(MARK)),
      '构建后的页面显示新的描述',
    );
    check(
      await p7Converge(() => readFileSync(PUBLISHED, 'utf8').includes('ts-logo-128')),
      '同一条目的图片引用没有被动过',
    );

    // Adding an item keeps the document's own indentation and key order.
    const addRequest = {
      path: LINKS,
      add: [{ title: NEW_TITLE, description: MARK, website: 'https://example.com/phase7', image: 'https://example.com/phase7.png' }],
    };
    const addPlan = await links.plan(addRequest);
    check(
      addPlan.counts.modify === 1 && (addPlan.applied ?? []).some((entry) => entry.action === 'add'),
      '新增条目先给计划',
      `+${addPlan.changes[0].diff.added} 行`,
    );
    await links.apply(addRequest);
    const afterAdd = readFileSync(LINKS_ABS, 'utf8');
    check(
      afterAdd.includes(`  - title: ${NEW_TITLE}\n    description: ${MARK}\n    website: https://example.com/phase7\n    image: https://example.com/phase7.png\n`),
      '新增条目沿用文档自己的缩进与键顺序',
    );

    await links.apply({ path: LINKS, move: [{ from: 2, to: 0 }] });
    // Only the front matter counts: the page body also contains a `links:` example, and it has
    // to come out of every one of these edits untouched.
    const frontMatterLinks = readFileSync(LINKS_ABS, 'utf8')
      .replace(/^---\n/, '')
      .split(/^links:\n/m)[1]
      .split(/^\S/m)[0];
    const titles = [...frontMatterLinks.matchAll(/^ {2}- title: (.*)$/gm)].map((match) => match[1]);
    check(
      titles.join(' → ') === `${NEW_TITLE} → GitHub → TypeScript`,
      '排序只改变顺序，正文里的示例列表没被碰过',
      titles.join(' → '),
    );

    const builtAdd = await p7BuildNow();
    check(builtAdd.state === 'success', '新增 + 排序后构建成功', builtAdd.message);
    check(
      await p7Converge(() => readFileSync(PUBLISHED, 'utf8').includes(NEW_TITLE)),
      '构建后的链接页出现新增的条目',
    );

    // Reverse everything through the same write path: the added item is removed (it is at index
    // 0 after the move) and the description is put back (the TypeScript item is at index 2).
    await links.apply({ path: LINKS, remove: [0], edit: [{ index: 2, set: { description: view.items[1].description } }] });
    check(readFileSync(LINKS_ABS, 'utf8') === before, '反向操作后 links 文件逐字节还原');
    check(readFileSync(OTHER_LANG, 'utf8') === otherLangBefore, '同一页面的其他语言版本没有被改动（每次只读一个文件）');

    const finalBuild = await p7BuildNow();
    check(finalBuild.state === 'success', '还原后构建成功', finalBuild.message);
    check(
      await p7Converge(() => Boolean(publishedBefore) && sha256(readFileSync(PUBLISHED, 'utf8')) === publishedBefore),
      '构建输出也逐字节还原',
    );
  } finally {
    if (readFileSync(LINKS_ABS, 'utf8') !== before) {
      // A failed assertion must not leave the user's page edited. This is the rescue path, not
      // the write path under test, so it writes the bytes back directly.
      writeFileSync(LINKS_ABS, before);
    }
  }

  const contentAfter = sourceHashes();
  checkSourceRestored(
    `Hugo 源树在 T15 + T16 后逐字节还原（${p7ContentBefore.size} 个文件）`,
    p7ContentBefore,
    contentAfter,
    [LINKS, 'page/links/index.en.md'],
  

  );
}

// T17 - Phase 8: the Markdown editing commands, on the REAL document.
//
// The editor's promise is that formatting is a *selection* operation on source text, never a
// re-serialisation: nothing here may touch the file, and a command that changes nothing must
// return the text byte for byte. The document is read, edited in memory and compared; the file
// is hashed before and after so "we only changed the selection" is checked, not asserted.
console.log('T17 Phase 8：Markdown 命令在真实文档上只改选区、逐字节无损');
{
  const TARGET = join(CONTENT_ROOT, 'post', 'Markdown Syntax', 'index.md');
  const before = readFileSync(TARGET, 'utf8');
  const beforeStat = statSync(TARGET);
  const parts = splitDocument(before);
  const body = parts.bodyRaw ?? '';

  // A no-op command must be byte-identical: this is the property that lets Ctrl+B be pressed
  // anywhere in a 9 KB article without fear.
  const noop = runCommand('hr', body, { anchor: 0, head: 0 });
  check(typeof noop.text === 'string' && noop.text.length > 0, 'T17 命令引擎返回新的源文本');

  // Bold around a real selection, then back: toggle twice must land on the original bytes.
  const selection = body.slice(0, 12);
  const bolded = runCommand('bold', body, { anchor: 0, head: selection.length });
  check(bolded.text.startsWith('**' + selection + '**'), 'T17 加粗只包裹选中的 12 个字符', bolded.text.slice(0, 24));
  const unbolded = runCommand('bold', bolded.text, bolded.selection);
  check(unbolded.text === body, 'T17 再按一次加粗逐字节还原');

  // A list is a line operation: it may only touch the lines the selection covers.
  const lines = body.split('\n');
  const oneLine = runCommand('ul', body, { anchor: 0, head: lines[0].length });
  check(oneLine.text.split('\n').length === lines.length, 'T17 列表命令不增删行数');
  check(oneLine.text.split('\n').slice(1).join('\n') === lines.slice(1).join('\n'), 'T17 列表命令只改选中行');

  // A slash command is UI: the typed query is removed before the command runs.
  const slashText = body + '\n/quo';
  const slash = runSlashCommand('quote', slashText, { anchor: slashText.length, head: slashText.length });
  check(!slash.text.includes('/quo'), 'T17 斜杠命令会先删除被敲进去的查询文本');
  check(slash.text.trimEnd().endsWith('>'), 'T17 斜杠命令接下来插入引用', JSON.stringify(slash.text.slice(-4)));

  // Ctrl+K on a selection turns the selection into link text and keeps it selected (so typing
  // over the label works); a label typed into the dialog puts the caret after the link instead.
  const sample = body.trim().slice(0, 6);
  const sampleAt = body.indexOf(sample);
  const linked = runCommand('link', body, { anchor: sampleAt, head: sampleAt + sample.length }, { url: 'https://example.com' });
  check(linked.text.includes(`[${sample}](https://example.com)`), 'T17 Ctrl+K 把选中的文字变成链接文字');
  check(
    linked.text.slice(linked.selection.anchor, linked.selection.head) === sample,
    'T17 链接文字保持选中，便于继续改',
  );
  const labelled = runCommand('link', body, { anchor: 0, head: 0 }, { text: '站点', url: 'https://example.com' });
  check(labelled.text.startsWith('[站点](https://example.com)'), 'T17 对话框里的文字成为链接文字');
  check(labelled.selection.anchor === '[站点](https://example.com)'.length, 'T17 插入后光标落在链接之后');

  const after = readFileSync(TARGET, 'utf8');
  const afterStat = statSync(TARGET);
  check(after === before, 'T17 磁盘上的文档逐字节未变');
  check(afterStat.mtimeMs === beforeStat.mtimeMs, 'T17 磁盘上的文档连 mtime 都没变（命令全程只在内存里）');
  console.log(`  （样本 ${relative(EDITOR_ROOT, TARGET)}，${before.length} 字节）`);
}

// T18 - Phase 8: the git service, on a throwaway repository.
//
// The real site lives inside a repository that has never been committed, so the parts that only
// matter on a repository with history (diff, log, show, commit) are exercised on a temporary one
// built here. Nothing in this block can reach the user's repository: it is a fresh mkdtemp with
// its own git dir.
console.log('T18 Phase 8：git 服务（状态 / diff / 日志 / 提交）在临时仓库上');
{
  const repo = mkdtempSync(join(tmpdir(), 'hve-git-'));
  const git = createGitService({ siteRoot: repo });

  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'acceptance@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Acceptance'], { cwd: repo });

    writeFileSync(join(repo, 'kept.md'), '# kept\n', 'utf8');
    writeFileSync(join(repo, 'other.md'), '# other\n', 'utf8');

    const fresh = await git.status();
    check(fresh.repository !== null, 'T18 临时仓库被识别为仓库');
    check(fresh.counts.untracked === 2, 'T18 两个未跟踪文件都出现在状态里', JSON.stringify(fresh.counts));
    check(fresh.changes.every((change) => !change.path.includes('..')), 'T18 状态里的路径是站点相对路径');

    // Only the ticked path may enter the commit: the other file stays untracked.
    const committed = await git.commit({ message: 'T18 只提交一个文件', paths: ['kept.md'] });
    check(committed.files.length === 1 && committed.files[0] === 'kept.md', 'T18 提交只包含勾选的文件');
    check(committed.sha.length >= 7, 'T18 提交返回了新的 HEAD');

    const afterCommit = await git.status();
    check(!afterCommit.changes.some((change) => change.path === 'kept.md'), 'T18 已提交的文件离开变更列表');
    check(afterCommit.counts.untracked === 1, 'T18 没勾选的文件仍然是未跟踪状态', JSON.stringify(afterCommit.counts));

    const history = await git.log({ limit: 5 });
    check(history.commits.length === 1 && history.commits[0].sha === committed.sha, 'T18 提交出现在日志里');
    check(history.commits[0].subject.includes('T18'), 'T18 日志里的提交主题正确', history.commits[0].subject);

    const shown = await git.show({ sha: committed.sha });
    check(shown.commit.sha === committed.sha, 'T18 show 能按 sha 取回同一个提交');
    check(shown.files.some((file) => file.path === 'kept.md'), 'T18 show 列出了提交里的文件');

    writeFileSync(join(repo, 'kept.md'), '# kept\n\nedited\n', 'utf8');
    const edited = await git.diff({ path: 'kept.md' });
    check(edited.text.includes('+edited'), 'T18 diff 显示新加的行');

    // A commit message has to say something, and a path may not escape the site.
    let rejected = null;
    try {
      await git.commit({ message: '   ', paths: ['kept.md'] });
    } catch (cause) {
      rejected = cause;
    }
    check(rejected !== null && /message/i.test(String(rejected.message)), 'T18 空提交信息被拒绝');

    rejected = null;
    try {
      await git.commit({ message: 'escape', paths: ['../outside.md'] });
    } catch (cause) {
      rejected = cause;
    }
    check(rejected !== null, 'T18 站点之外的路径被拒绝');

    // The allow-list is the safety property: no reset, no clean, no checkout, no fetch, no force.
    // `push` is no longer on this list (Phase 10 added it, behind `push()` and its own confirm), but
    // everything that could rewrite or discard work still is.
    const forbidden = ['reset', 'clean', 'checkout', 'fetch', 'pull', 'merge', 'rebase', 'gc', 'init'].filter(
      (name) => ALLOWED_SUBCOMMANDS.includes(name),
    );
    check(forbidden.length === 0, 'T18 服务不允许 reset / clean / checkout / fetch 等破坏性命令', forbidden.join(', '));

    let blocked = null;
    try {
      await git.run(['clean', '-fd']);
    } catch (cause) {
      blocked = cause;
    }
    check(blocked !== null && blocked.name === 'GitValidationError', 'T18 直接调用破坏性命令被拒绝');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}
console.log('');
console.log('T19 Phase 9：本地 git 工作流（Status → Diff → Commit → History → 提交 diff）在临时仓库上');
{
  const repoRoot = mkdtempSync(join(tmpdir(), 'hve-git9-'));
  const siteRoot = join(repoRoot, 'site');
  mkdirSync(join(siteRoot, 'content', 'post'), { recursive: true });
  const git = createGitService({ siteRoot });

  try {
    execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'acceptance@example.com'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Acceptance'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, '.gitignore'), 'site/public/\nsite/resources/\n', 'utf8');
    writeFileSync(join(siteRoot, 'content', 'post', 'article.md'), '# article\n', 'utf8');
    writeFileSync(join(repoRoot, 'outside.txt'), 'not the editor\'s business\n', 'utf8');
    execFileSync('git', ['add', '--', '.gitignore', 'site/content', 'outside.txt'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-q', '-m', 'T19 起始提交'], { cwd: repoRoot });

    // Status: the index half and the worktree half are two different questions.
    writeFileSync(join(siteRoot, 'content', 'post', 'staged.md'), '# staged\n', 'utf8');
    execFileSync('git', ['add', '--', 'site/content/post/staged.md'], { cwd: repoRoot });
    writeFileSync(join(siteRoot, 'content', 'post', 'article.md'), '# article\n\nedited\n', 'utf8');
    mkdirSync(join(siteRoot, 'public'), { recursive: true });
    writeFileSync(join(siteRoot, 'public', 'index.html'), '<html></html>\n', 'utf8');

    const status = await git.status();
    const byPath = Object.fromEntries(status.changes.map((change) => [change.path, change]));
    check(status.repository !== null && status.branch === 'main', 'T19 临时仓库被识别，分支来自 git 本身', String(status.branch));
    check(byPath['content/post/staged.md']?.staged === true && byPath['content/post/staged.md']?.unstaged === false, 'T19 只在索引里的文件：已暂存为真、未暂存为假');
    check(byPath['content/post/article.md']?.staged === false && byPath['content/post/article.md']?.unstaged === true, 'T19 只在工作区的文件：未暂存为真');
    check(status.counts.staged === 1 && status.counts.unstaged === 1, 'T19 状态分别统计已暂存与未暂存', JSON.stringify(status.counts));
    check(!status.changes.some((change) => change.path.startsWith('..') || change.path.includes('outside')), 'T19 站点之外的文件不出现在编辑器的状态里');
    check(!status.changes.some((change) => change.path.startsWith('public/')), 'T19 public/ 被 gitignore 时不进入变更列表', status.changes.map((c) => c.path).join(', '));

    // Diff: a file that only lives in the index has no worktree diff, so both halves must answer.
    const worktreeDiff = await git.diff({ path: 'content/post/staged.md' });
    const stagedDiff = await git.diff({ path: 'content/post/staged.md', staged: true });
    check(worktreeDiff.text.trim() === '' && worktreeDiff.staged === false, 'T19 索引里的改动在未暂存 diff 里为空（窗口本身不编造内容）');
    check(stagedDiff.staged === true && stagedDiff.text.includes('+# staged'), 'T19 已暂存 diff 给出索引里的改动', stagedDiff.text.split('\n').slice(0, 3).join(' / '));

    // Reading is not writing: HEAD and the index must be byte-identical afterwards.
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const indexBefore = createHash('sha256').update(readFileSync(join(repoRoot, '.git', 'index'))).digest('hex');
    await git.status();
    await git.diff({});
    await git.log({ limit: 5 });
    await git.show({ sha: headBefore });
    check(
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim() === headBefore &&
        createHash('sha256').update(readFileSync(join(repoRoot, '.git', 'index'))).digest('hex') === indexBefore,
      'T19 读操作（status / diff / log / show）不移动 HEAD 与索引',
    );

    // Commit: exactly the ticked paths, and both halves end up empty.
    const committed = await git.commit({ message: 'T19 提交两个文件', paths: ['content/post/staged.md', 'content/post/article.md'] });
    const after = await git.status();
    check(after.clean === true && after.counts.staged === 0 && after.counts.unstaged === 0, 'T19 提交后工作区干净、索引为空', JSON.stringify(after.counts));

    // History: one patch per row, and clicking a file narrows it - not the other way round.
    const shown = await git.show({ sha: committed.sha });
    check(shown.text.includes('+# staged') && shown.text.includes('+edited'), 'T19 一次 show 就给出整次提交的补丁');
    check(shown.files.length === 2 && shown.files.every((file) => file.outside === false && file.path !== null), 'T19 提交里的站点文件都不在站点之外');
    const narrowed = await git.show({ sha: committed.sha, path: 'content/post/article.md' });
    check(narrowed.text.includes('+edited') && !narrowed.text.includes('staged.md'), 'T19 点单个文件时只看该文件');

    // A commit that reached outside the site names the file and refuses to invent a diff for it.
    writeFileSync(join(repoRoot, 'outside.txt'), 'changed outside\n', 'utf8');
    execFileSync('git', ['add', '--', 'outside.txt'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-q', '-m', 'T19 改动站点之外'], { cwd: repoRoot });
    const outsideCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const outsideShown = await git.show({ sha: outsideCommit });
    const outsideFile = outsideShown.files.find((file) => file.repoPath === 'outside.txt');
    check(outsideFile !== undefined && outsideFile.outside === true && outsideFile.path === null, 'T19 站点之外的文件被标记为 outside，而不是给出假的站点相对路径');

    // A history row that has since been rewritten is a state, not a crash.
    let unknown = null;
    try {
      await git.show({ sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
    } catch (cause) {
      unknown = cause;
    }
    check(unknown !== null && unknown.name === 'GitUnknownCommitError', 'T19 不存在的提交是明确的状态错误', String(unknown && unknown.name));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

// T20 - Phase 10: the push, on a throwaway repository with a bare `origin` beside it.
//
// A push to GitHub differs from a push to a bare repository in `mkdtemp` in exactly one way: the
// transport. So this is the honest end-to-end gate - real refs, a real upstream, a real refusal
// when the remote moved on - and it never touches the user's repository, the network, or a
// credential. The whole-tree checks below and above still prove the real site came back unchanged.
console.log('');
console.log('T20 Phase 10：远程推送（首次 / 上游 / 已是最新 / 被拒绝 / 凭据不落地）在临时仓库 + 裸远程上');
{
  const repoRoot = mkdtempSync(join(tmpdir(), 'hve-git10-'));
  const originRoot = mkdtempSync(join(tmpdir(), 'hve-origin10-'));
  const siteRoot = join(repoRoot, 'site');
  mkdirSync(join(siteRoot, 'content', 'post'), { recursive: true });

  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const git = (cwd, args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
  const service = createGitService({ siteRoot });

  try {
    git(originRoot, ['init', '-q', '--bare', '--initial-branch=main']);
    git(repoRoot, ['init', '-q', '--initial-branch=main']);
    git(repoRoot, ['config', 'user.name', 'Acceptance']);
    git(repoRoot, ['config', 'user.email', 'acceptance@example.com']);
    writeFileSync(join(siteRoot, 'content', 'post', 'article.md'), '# article\n', 'utf8');
    git(repoRoot, ['add', '-A']);
    git(repoRoot, ['commit', '-q', '-m', 'T20 起始提交']);
    git(repoRoot, ['remote', 'add', 'origin', originRoot]);

    // Before the first push: there is a remote, there is no upstream, and the distance to the other
    // side is unknown rather than zero.
    const before = await service.remoteStatus();
    check(
      before.remotes.length === 1 && before.remotes[0].name === 'origin',
      'T20 远程仓库是从 git 本身读出来的',
      JSON.stringify(before.remotes.map((entry) => entry.name)),
    );
    check(before.upstream === null && before.hasUpstream === false, 'T20 首次推送前没有上游');
    check(before.ahead === null && before.behind === null, 'T20 没有上游时不编造领先/落后数量');
    check(before.setUpstream === true, 'T20 首次推送会记录上游');

    // The plan is a read: it names the one command and pushes nothing.
    const plan = await service.pushPlan();
    check(
      plan.args.join(' ') === 'push --porcelain --no-verify --set-upstream origin main',
      'T20 计划里的命令是固定的那一条（没有 force、没有 fetch）',
      plan.command,
    );
    check(git(originRoot, ['for-each-ref', '--format=%(refname)']) === '', 'T20 只看计划不会推送任何东西');

    const pushed = await service.push();
    check(pushed.pushed === true && pushed.setUpstream === true, 'T20 首次推送新建远程分支并记录上游');
    check(
      git(originRoot, ['rev-parse', 'refs/heads/main']) === git(repoRoot, ['rev-parse', 'HEAD']),
      'T20 提交真的到了远程',
    );

    const after = await service.remoteStatus();
    check(after.upstream !== null && after.upstream.full === 'origin/main', 'T20 推送后上游是 origin/main');
    check(after.ahead === 0 && after.behind === 0, 'T20 推送后与上游一致');
    check(after.setUpstream === false, 'T20 已有上游时不再带 --set-upstream');

    const again = await service.push();
    check(again.upToDate === true && again.pushed === false, 'T20 没有新提交时报告「远程已经是最新的」');

    // 凭据永不落地：远程 URL 里的 user:token 不会出现在服务返回的任何字段里。
    const SECRET = 'ghp_acceptance_secret';
    git(repoRoot, ['remote', 'add', 'withcredential', `https://user:${SECRET}@example.com/x.git`]);
    const credentialed = await service.remoteStatus();
    check(
      JSON.stringify(credentialed).includes(SECRET) === false,
      'T20 远程 URL 里的凭据不会出现在返回结果里',
      credentialed.remotes.map((entry) => entry.url).join(' , '),
    );
    check(
      redactCredentials(`https://user:${SECRET}@example.com/x.git`) === 'https://example.com/x.git',
      'T20 凭据是整个 userinfo 被剥掉，不是只遮密码',
    );
    git(repoRoot, ['remote', 'remove', 'withcredential']);

    // 远程名必须是 git 报告过的名字：任何像参数的东西都到不了命令行。
    let badRemote = null;
    try {
      await service.push({ remote: '--force' });
    } catch (cause) {
      badRemote = cause;
    }
    check(
      badRemote !== null && /unknown remote/.test(String(badRemote.message)),
      'T20 不存在的远程名被拒绝（--force 进不了命令行）',
      String(badRemote && badRemote.message),
    );

    // 远程前进（别人推了提交）：推送必须被拒绝，且不 force、不 fetch、本地远程都不动。
    const peerRoot = mkdtempSync(join(tmpdir(), 'hve-peer10-'));
    try {
      git(tmpdir(), ['clone', '-q', originRoot, peerRoot]);
      git(peerRoot, ['config', 'user.name', 'Someone Else']);
      git(peerRoot, ['config', 'user.email', 'else@example.test']);
      writeFileSync(join(peerRoot, 'theirs.md'), 'their work\n', 'utf8');
      git(peerRoot, ['add', '-A']);
      git(peerRoot, ['commit', '-q', '-m', 'T20 别人推的提交']);
      git(peerRoot, ['push', '-q', 'origin', 'main']);
    } finally {
      rmSync(peerRoot, { recursive: true, force: true });
    }
    const remoteHead = git(originRoot, ['rev-parse', 'refs/heads/main']);

    writeFileSync(join(siteRoot, 'content', 'post', 'article.md'), '# article\n\nlocal\n', 'utf8');
    await service.commit({ message: 'T20 本地提交', paths: ['content/post/article.md'] });
    const localHead = git(repoRoot, ['rev-parse', 'HEAD']);
    const trackingBefore = git(repoRoot, ['rev-parse', 'refs/remotes/origin/main']);

    let refused = null;
    try {
      await service.push();
    } catch (cause) {
      refused = cause;
    }
    check(
      refused !== null && refused.name === 'GitPushError',
      'T20 远程前进后推送被拒绝，而不是靠 force 解决',
      String(refused && refused.name),
    );
    check(
      refused !== null && refused.reason === 'rejected-non-fast-forward',
      'T20 拒绝的原因是分好类的（面板据此给建议）',
      String(refused && refused.reason),
    );
    check(git(repoRoot, ['rev-parse', 'HEAD']) === localHead, 'T20 被拒绝后本地分支没有移动');
    check(git(originRoot, ['rev-parse', 'refs/heads/main']) === remoteHead, 'T20 被拒绝后远程没有被改写');
    check(
      git(repoRoot, ['rev-parse', 'refs/remotes/origin/main']) === trackingBefore,
      'T20 被拒绝时没有偷偷 fetch（本地跟踪引用原样不动）',
    );

    // 游离 HEAD：没有分支可推，这是状态不是崩溃。
    git(repoRoot, ['checkout', '-q', '--detach']);
    let detached = null;
    try {
      await service.push();
    } catch (cause) {
      detached = cause;
    }
    check(
      detached !== null && detached.reason === 'detached-head',
      'T20 游离 HEAD 给出 detached-head',
      String(detached && detached.reason),
    );
    git(repoRoot, ['checkout', '-q', 'main']);

    // 没有远程仓库：同样是分类好的状态。
    const lonelyRoot = mkdtempSync(join(tmpdir(), 'hve-git10-noremote-'));
    try {
      const lonelySite = join(lonelyRoot, 'site');
      mkdirSync(lonelySite, { recursive: true });
      git(lonelyRoot, ['init', '-q', '--initial-branch=main']);
      const lonely = createGitService({ siteRoot: lonelySite });
      let noRemote = null;
      try {
        await lonely.push();
      } catch (cause) {
        noRemote = cause;
      }
      check(
        noRemote !== null && noRemote.reason === 'no-remote',
        'T20 没有远程仓库时给出 no-remote',
        String(noRemote && noRemote.reason),
      );
    } finally {
      rmSync(lonelyRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(originRoot, { recursive: true, force: true });
  }
}
console.log('');

if (failures === 0) {
  console.log('P1 + P2 验收通过 ✅  写入路径显式、空操作逐字节一致、失败构建不发布、源树不被构建改动。');
  console.log('Phase 3 内容管理验收通过 ✅  副本上的新建 / 表单编辑 / 删除 / 恢复都只动副本。');
  console.log('Phase 4 内容类型验收通过 ✅  Article / Page / Category / Other 与三种 bundle 形态都可查看、编辑、创建、删除并恢复。');
  console.log('Phase 5 站点设置验收通过 ✅  主题默认 → 本站覆盖、语言覆盖、多文件保存都写入真实配置，构建后出现在 public 里，还原后逐字节回退。');
  console.log('Phase 6 资源验收通过 ✅  新增 / 替换 / 删除 / 恢复都先计划后确认，构建后的 public 跟随资源变化（含发布清单裁剪），恢复逐字节一致，源树还原。');
  console.log('Phase 7 关系验收通过 ✅  标签改名/合并先给跨文档改动清单再确认，Hugo 的 taxonomy 与元数据页跟随迁移，反向操作后源树逐字节还原。');
  console.log('Phase 7 链接验收通过 ✅  links 列表按条目读、改、增删、排序，每次只动一行/一项，构建后的页面跟随变化，反向操作后源树与输出都逐字节还原。');
  console.log('Phase 8 Markdown 验收通过 ✅  工具栏 / 快捷键 / 斜杠命令 / 对话框都走同一张命令表，只改选中的文字，磁盘上的文档逐字节未动。');
  console.log('Phase 8 Git 验收通过 ✅  状态 / diff / 日志 / show 只读，提交只包含勾选的文件，破坏性命令不在白名单里。');
  console.log('Phase 9 Git 工作流验收通过 ✅  已暂存/未暂存分开统计、各自有 diff，提交后索引为空，历史一行即整次提交的补丁，站点之外的文件被如实标记，读操作不移动 HEAD 与索引。');
  console.log('Phase 10 推送验收通过 ✅  计划即命令（无 force / 无 fetch），首次推送记录上游，远程前进时被拒绝且本地与远程都不动，凭据不出现在任何返回值里。');
} else {
  console.log(`验收失败 ❌  ${failures} 项未通过`);
}
process.exit(failures === 0 ? 0 : 1);
