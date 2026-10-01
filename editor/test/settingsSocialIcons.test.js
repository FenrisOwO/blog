// A social entry can point at an icon the theme does not ship: a Phosphor icon
// (`phosphor-<name>`, from the optional `@phosphor-icons/core` package) or a picture the user
// picked (`image:<location>:<path>`). For Hugo both are the same problem - `helper/icon.html`
// does `resources.GetMatch "icons/<name>.svg"` and stops the build when no such file exists -
// so both end up as an SVG under the site's `assets/icons/`, and the name written into
// menu.toml is the name that file resolves to.
//
// The tests below are mostly about the second half of that sentence: a save must not clobber an
// icon another entry (or the user) already put there, a preview must write nothing at all, and
// what the form reads back has to match what the save wrote.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSettingsService } from '../src/settings/settingsService.js';
import { readPhosphorIconBytes } from '../src/settings/socialIcons.js';
import { makeFixtureSandbox } from './fixtures/harness.js';

const PHOSPHOR_ENTRY = {
  identifier: 'phosphor',
  name: 'Phosphor',
  url: 'https://phosphoricons.com',
  'params.icon': 'phosphor-github-logo',
};

function serviceFor(sandbox) {
  // No frozen `themeInfo`: the service re-reads the theme (and the site's own `assets/icons`)
  // on every describe, exactly like the server does, so an icon installed by a save is known
  // to the next read.
  return createSettingsService({
    siteRoot: sandbox.siteRoot,
    configRoot: sandbox.configRoot,
    backupRoot: sandbox.backupRoot,
  });
}

function iconsDir(sandbox) {
  return join(sandbox.siteRoot, 'assets', 'icons');
}

function menuText(sandbox) {
  return readFileSync(join(sandbox.configRoot, 'menu.toml'), 'utf8');
}

test('the form is offered the Phosphor names the installed package holds', (t) => {
  const sandbox = makeFixtureSandbox(t, { theme: true });
  const described = serviceFor(sandbox).describe();
  const row = described.settings['menu.social'];

  assert.deepEqual(row.phosphorIconOptions, described.theme.phosphorIcons);
  assert.ok(row.phosphorIconOptions.includes('github-logo'), 'Phosphor names come from the package');
  // The theme's own icons are still the first choice, and unchanged.
  assert.ok(row.iconOptions.includes('brand-github'));
  assert.equal(described.theme.icons.includes('github-logo'), false);
});

test('previewing a Phosphor icon and a picture reports the SVGs it would install, and writes nothing', (t) => {
  const sandbox = makeFixtureSandbox(t, { theme: true });
  const service = serviceFor(sandbox);
  const before = menuText(sandbox);

  const plan = service.preview({
    menu: {
      add: [
        PHOSPHOR_ENTRY,
        { identifier: 'shot', name: 'Photo', url: 'https://example.com', 'params.icon': 'image:static:img/logo.png' },
      ],
    },
  });

  assert.equal(plan.status, 'preview');
  assert.deepEqual(
    plan.icons.map((icon) => icon.path).sort(),
    ['assets/icons/custom-logo.svg', 'assets/icons/phosphor-github-logo.svg'],
  );
  assert.equal(plan.icons.every((icon) => icon.status === 'create'), true);
  assert.equal(existsSync(iconsDir(sandbox)), false, '预览不写任何文件');
  assert.equal(menuText(sandbox), before, '预览不改 menu.toml');
});

test('saving writes both icons, and the second save leaves the first one alone', (t) => {
  const sandbox = makeFixtureSandbox(t, { theme: true });
  const service = serviceFor(sandbox);

  const first = service.save({ menu: { add: [PHOSPHOR_ENTRY] } });
  const phosphorPath = join(iconsDir(sandbox), 'phosphor-github-logo.svg');
  const phosphorBytes = readPhosphorIconBytes('github-logo');
  assert.deepEqual(first.icons, [
    {
      path: 'assets/icons/phosphor-github-logo.svg',
      status: 'created',
      bytes: phosphorBytes.length,
      sha256: createHash('sha256').update(phosphorBytes).digest('hex'),
    },
  ]);
  assert.deepEqual(readFileSync(phosphorPath), phosphorBytes);
  assert.match(menuText(sandbox), /icon = "phosphor-github-logo"/);

  const second = service.save({
    menu: { add: [{ identifier: 'shot', name: 'Photo', url: 'https://example.com', 'params.icon': 'image:static:img/logo.png' }] },
  });
  const customPath = join(iconsDir(sandbox), 'custom-logo.svg');
  assert.equal(second.icons[0].path, 'assets/icons/custom-logo.svg');
  // A picture is embedded in the SVG the theme inlines, in the 24x24 box it gives an icon.
  const svg = readFileSync(customPath, 'utf8');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 24 24" width="24" height="24">/);
  assert.match(svg, /<image href="data:image\/png;base64,/);

  // Nothing about the first entry moved.
  assert.deepEqual(readFileSync(phosphorPath), readPhosphorIconBytes('github-logo'));
  const menu = menuText(sandbox);
  assert.match(menu, /icon = "phosphor-github-logo"/);
  assert.match(menu, /icon = "custom-logo"/);
  assert.match(menu, /identifier = "phosphor"/);
  assert.match(menu, /identifier = "shot"/);

  // And the form reads both back as resolvable: `iconKnown` is what stops the UI from warning
  // that a build will fail.
  const entries = service.describe().settings['menu.social'].entries;
  const mine = entries.filter((entry) => ['phosphor', 'shot'].includes(entry.identifier));
  assert.equal(mine.length, 2);
  assert.deepEqual(mine.map((entry) => entry.icon).sort(), ['custom-logo', 'phosphor-github-logo']);
  assert.equal(mine.every((entry) => entry.iconKnown), true);

  // A save that would install the same bytes again reports `noop` instead of writing.
  const again = service.preview({ menu: { add: [PHOSPHOR_ENTRY] } });
  assert.equal(again.icons[0].status, 'noop');
});

test('an icon file that is already there is never overwritten', (t) => {
  const sandbox = makeFixtureSandbox(t, { theme: true });
  const service = serviceFor(sandbox);
  mkdirSync(iconsDir(sandbox), { recursive: true });
  const mine = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
  writeFileSync(join(iconsDir(sandbox), 'phosphor-github-logo.svg'), mine);

  const result = service.save({ menu: { add: [PHOSPHOR_ENTRY] } });

  // The editor's icon goes next to the user's, and the config names the one it wrote.
  assert.equal(result.icons[0].path, 'assets/icons/phosphor-github-logo-2.svg');
  assert.deepEqual(readFileSync(join(iconsDir(sandbox), 'phosphor-github-logo-2.svg')), readPhosphorIconBytes('github-logo'));
  assert.equal(readFileSync(join(iconsDir(sandbox), 'phosphor-github-logo.svg'), 'utf8'), mine);
  assert.match(menuText(sandbox), /icon = "phosphor-github-logo-2"/);
});

test('a picture that is already an SVG is used as it is', (t) => {
  const sandbox = makeFixtureSandbox(t, { theme: true });
  const service = serviceFor(sandbox);
  const drawn = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>';
  writeFileSync(join(sandbox.siteRoot, 'static', 'img', 'mark.svg'), drawn);

  const result = service.save({
    menu: { add: [{ identifier: 'mark', name: 'Mark', url: 'https://example.com', 'params.icon': 'image:static:img/mark.svg' }] },
  });

  assert.equal(result.icons[0].path, 'assets/icons/custom-mark.svg');
  assert.equal(readFileSync(join(iconsDir(sandbox), 'custom-mark.svg'), 'utf8'), drawn);
  assert.match(menuText(sandbox), /icon = "custom-mark"/);
});

test('a theme icon is written as it is, and an icon nobody knows is still refused', (t) => {
  const sandbox = makeFixtureSandbox(t, { theme: true });
  const service = serviceFor(sandbox);

  // An existing entry, edited through the form: the value is a theme icon, so no file is made.
  const plan = service.preview({ set: { 'menu.social[0].params.icon': 'brand-twitter' } });
  assert.deepEqual(plan.icons, []);
  assert.equal(plan.status, 'preview');
  assert.match(plan.files.find((file) => file.file === 'menu.toml').diffText, /icon = "brand-twitter"/);

  assert.throws(
    () => service.preview({ set: { 'menu.social[0].params.icon': 'brand-mastodon' } }),
    /主题里没有图标 “brand-mastodon”/,
  );
  assert.throws(
    () => service.preview({ set: { 'menu.social[0].params.icon': 'image:static:img/nope.png' } }),
    /找不到图片：static:img\/nope.png/,
  );
  assert.throws(
    () => service.preview({ set: { 'menu.social[0].params.icon': 'phosphor-not-an-icon' } }),
    /没有名为 “not-an-icon” 的 Phosphor 图标/,
  );
});
