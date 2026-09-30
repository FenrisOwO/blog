// P1.4 architecture guard.
//
// Enforces the layering the project depends on: importing CodeMirror is allowed in
// exactly one place (`src/editorCore/cores/`). Every other module - the Vue app, the
// Hugo reader, the front-matter engine, the safe writer, the server - must stay
// unaware of it, so replacing the editor core cannot ripple into business code.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const CORE_IMPL_DIR = join(ROOT, 'src', 'editorCore', 'cores');

const SCAN_DIRS = ['web', 'src', 'server'].map((dir) => join(ROOT, dir));

const IMPORT_PATTERN =
  /(?:from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;

const CODEMIRROR_PACKAGE = /^(@codemirror\/|codemirror($|\/))/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (/\.(js|mjs|vue)$/.test(entry.name)) out.push(abs);
  }
  return out;
}

function importedSpecifiers(file) {
  const source = readFileSync(file, 'utf8');
  const specifiers = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    specifiers.push(match[1] ?? match[2] ?? match[3]);
  }
  return specifiers;
}

const FILES = SCAN_DIRS.flatMap((dir) => walk(dir));

test('only src/editorCore/cores may import CodeMirror', () => {
  const offenders = [];

  for (const file of FILES) {
    const inCoreImpl = file.startsWith(CORE_IMPL_DIR);
    for (const specifier of importedSpecifiers(file)) {
      if (CODEMIRROR_PACKAGE.test(specifier) && !inCoreImpl) {
        offenders.push(`${relative(ROOT, file)} -> ${specifier}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `CodeMirror imported outside src/editorCore/cores:\n${offenders.join('\n')}`);
});

test('the CodeMirror core really is the one place that imports it', () => {
  const coreImports = FILES.filter((file) => file.startsWith(CORE_IMPL_DIR)).flatMap((file) =>
    importedSpecifiers(file).filter((specifier) => CODEMIRROR_PACKAGE.test(specifier)),
  );

  assert.ok(coreImports.length > 0, 'expected the core implementation to import CodeMirror');
});

test('the Vue host talks to the editor through the adapter, not through a core implementation', () => {
  const offenders = [];
  for (const file of FILES) {
    if (!file.startsWith(join(ROOT, 'web'))) continue;
    for (const specifier of importedSpecifiers(file)) {
      if (specifier.includes('editorCore/cores/')) offenders.push(`${relative(ROOT, file)} -> ${specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the Vue host never reaches into the filesystem layer or SafeWriter', () => {
  const offenders = [];
  for (const file of FILES) {
    if (!file.startsWith(join(ROOT, 'web'))) continue;
    for (const specifier of importedSpecifiers(file)) {
      const forbidden =
        specifier.startsWith('node:') ||
        specifier.includes('/src/site/') ||
        specifier.includes('safeWrite') ||
        specifier.includes('documentService') ||
        specifier.includes('contentReader');
      if (forbidden) offenders.push(`${relative(ROOT, file)} -> ${specifier}`);
    }
  }
  assert.deepEqual(offenders, [], `Vue must go through HTTP, not the filesystem:\n${offenders.join('\n')}`);
});

test('the Vue host never imports the build layer', () => {
  const offenders = [];
  for (const file of FILES) {
    if (!file.startsWith(join(ROOT, 'web'))) continue;
    for (const specifier of importedSpecifiers(file)) {
      if (specifier.includes('/src/build/') || specifier.includes('buildService') || specifier.includes('hugoRunner')) {
        offenders.push(`${relative(ROOT, file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `Vue must trigger builds over HTTP:\n${offenders.join('\n')}`);
});

// Phase 8 adds exactly one more process boundary: git. Both layers are named explicitly, so a
// third one cannot appear by accident - it has to be added here on purpose.
const PROCESS_DIRS = ['src/build', 'src/git'].map((dir) => join(ROOT, dir));

test('only the build layer and the git layer may spawn processes', () => {
  const offenders = [];
  for (const file of FILES) {
    if (PROCESS_DIRS.some((dir) => file.startsWith(dir))) continue;
    if (importedSpecifiers(file).some((specifier) => specifier === 'node:child_process')) {
      offenders.push(relative(ROOT, file));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `processes may only be spawned by src/build or src/git:\n${offenders.join('\n')}`,
  );
});

test('both process layers really do spawn, and the git layer is not a second build layer', () => {
  const spawners = new Set(
    FILES.filter((file) =>
      importedSpecifiers(file).some((specifier) => specifier === 'node:child_process'),
    ).map((file) => relative(ROOT, file)),
  );
  assert.ok([...spawners].some((file) => file.startsWith('src/build')), 'the build layer spawns hugo');
  assert.ok([...spawners].some((file) => file.startsWith('src/git')), 'the git layer spawns git');

  const gitFiles = FILES.filter((file) => file.startsWith(join(ROOT, 'src', 'git')));
  for (const file of gitFiles) {
    const specifiers = importedSpecifiers(file);
    assert.equal(
      specifiers.some((specifier) => specifier.includes('/src/build/')),
      false,
      `${relative(ROOT, file)} must not import the build layer`,
    );
  }
});

test('the Vue host never imports the git layer', () => {
  const offenders = [];
  for (const file of FILES) {
    if (!file.startsWith(join(ROOT, 'web'))) continue;
    for (const specifier of importedSpecifiers(file)) {
      if (specifier.includes('/src/git/') || specifier.includes('gitService') || specifier === 'node:child_process') {
        offenders.push(`${relative(ROOT, file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `Vue must talk to git over HTTP:\n${offenders.join('\n')}`);
});
