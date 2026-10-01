// Social-menu icons that do not come from the theme.
//
// The theme resolves `[[social]].params.icon` with `resources.GetMatch "icons/<name>.svg"` and
// FAILS THE BUILD when there is no such file (`layouts/_partials/helper/icon.html`). So both
// halves of this feature mean the same thing on disk: an SVG under the site's `assets/icons/`.
// This module turns the value the user picked in the settings form into
//
//   * the name that goes into menu.toml, and
//   * the file that has to exist for that name to resolve.
//
// Two namespaces keep the site's own files from shadowing the theme's: a Phosphor icon is
// installed as `phosphor-<name>.svg`, a picture the user chose as `custom-<name>.svg`. Nothing
// here ever overwrites a file: when the name is taken by different bytes, the next free
// numbered sibling is used, so two menu entries can never clobber each other's icon.
//
// The picture is read from the site itself (the same three locations the Resources screen
// lists) and is embedded in the SVG as a data URI: no second file, no request, and the theme's
// `resources.GetMatch` still has an `.svg` to find.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { atomicWriteBytes, sha256Bytes, sniffBytes } from '../site/bytes.js';
import { isInside } from '../site/paths.js';
import { ASSET_LOCATIONS } from '../site/resourceModel.js';

export const PHOSPHOR_PREFIX = 'phosphor-';
export const CUSTOM_PREFIX = 'custom-';
export const ICON_ASSET_DIR = 'assets/icons';

// A social icon is drawn at 24x24 next to a name. A picture meant for that slot is small; a
// picture meant for an article is not, and embedding it in every page would be a bug.
export const ICON_SOURCE_MAX_BYTES = 512 * 1024;

// `image:static:img/logo.png` / `image:content:post/bundle/cover.jpg` / `image:assets:…`.
const IMAGE_SPEC = /^image:([a-z]+):(.+)$/;

let phosphorDirCache;

export function phosphorAssetsDir() {
  if (phosphorDirCache !== undefined) return phosphorDirCache;
  phosphorDirCache = null;
  try {
    const require = createRequire(import.meta.url);
    // `package.json` is not in the package's `exports`, so the root comes from its main entry.
    const root = dirname(dirname(require.resolve('@phosphor-icons/core')));
    const dir = join(root, 'assets', 'regular');
    if (existsSync(dir)) phosphorDirCache = dir;
  } catch {
    // The package is an optional convenience: without it the editor simply offers no
    // Phosphor names, and every other icon keeps working.
    phosphorDirCache = null;
  }
  return phosphorDirCache;
}

let phosphorNamesCache;

export function phosphorIconNames() {
  if (phosphorNamesCache) return phosphorNamesCache;
  const dir = phosphorAssetsDir();
  phosphorNamesCache = dir
    ? readdirSync(dir).filter((name) => name.endsWith('.svg')).map((name) => name.slice(0, -4)).sort()
    : [];
  return phosphorNamesCache;
}

export function readPhosphorIconBytes(name) {
  const dir = phosphorAssetsDir();
  if (!dir || !phosphorIconNames().includes(name)) return null;
  return readFileSync(join(dir, `${name}.svg`));
}

export function parseImageSpec(value) {
  const match = IMAGE_SPEC.exec(String(value ?? '').trim());
  if (!match) return null;
  return { location: match[1], path: match[2] };
}

export function slugForIcon(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40);
  return slug === '' ? 'image' : slug;
}

export function imageIconName({ location, path }) {
  const base = String(path).split('/').filter(Boolean).pop() ?? 'image';
  const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  return `${CUSTOM_PREFIX}${slugForIcon(stem)}`;
}

// Read the picture the user picked, from the site's own trees. The path is resolved against the
// location root and has to stay inside it - the same rule the write path uses (`isInside`).
export function readImageSource({ siteRoot, location, path }) {
  if (!ASSET_LOCATIONS.includes(location)) {
    return { error: `图片位置 “${location}” 不被支持；可用：${ASSET_LOCATIONS.join(', ')}` };
  }
  const raw = String(path ?? '');
  if (raw === '' || isAbsolute(raw) || raw.includes('\0')) return { error: '图片路径无效' };

  const root = resolve(siteRoot, location);
  const abs = resolve(root, raw);
  if (!isInside(root, abs)) return { error: `图片路径越界：${location}:${raw}` };
  if (!existsSync(abs) || !statSync(abs).isFile()) return { error: `找不到图片：${location}:${raw}` };

  const size = statSync(abs).size;
  if (size > ICON_SOURCE_MAX_BYTES) {
    return { error: `图片太大：${location}:${raw} 是 ${size} 字节，社交图标的上限是 ${ICON_SOURCE_MAX_BYTES} 字节` };
  }
  const bytes = readFileSync(abs);
  const sniff = sniffBytes(bytes);
  if (!sniff || !sniff.mime.startsWith('image/')) return { error: `不是能识别的图片：${location}:${raw}` };
  return { bytes, mime: sniff.mime, size };
}

// An SVG is used as it is (it may already be the icon the user drew); anything else is embedded
// in a 24x24 SVG, which is the box the theme gives a social icon.
export function svgBytesForImage({ bytes, mime }) {
  if (mime === 'image/svg+xml') return bytes;
  const href = `data:${mime};base64,${bytes.toString('base64')}`;
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">'
      + `<image href="${href}" width="24" height="24" preserveAspectRatio="xMidYMid meet"/>`
      + '</svg>',
    'utf8',
  );
}

function iconAbsPath(siteRoot, name) {
  return join(resolve(siteRoot, ICON_ASSET_DIR), `${name}.svg`);
}

// The name a file can live under without touching one that is already there.
function uniqueIconName({ siteRoot, name, bytes }) {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const candidate = attempt === 1 ? name : `${name}-${attempt}`;
    const abs = iconAbsPath(siteRoot, candidate);
    if (!existsSync(abs)) return candidate;
    if (readFileSync(abs).equals(bytes)) return candidate;
  }
  return null;
}

function iconFileFor({ siteRoot, baseName, bytes }) {
  const name = uniqueIconName({ siteRoot, name: baseName, bytes });
  if (name === null) return { error: `${ICON_ASSET_DIR} 里已有 20 个同名图标，无法为 ${baseName} 找到空位` };
  return { icon: name, file: { relPath: `${ICON_ASSET_DIR}/${name}.svg`, name, bytes, sha256: sha256Bytes(bytes) } };
}

// What a `params.icon` value means, resolved:
//   { icon }             the name to write (empty = no icon)
//   { icon, file }       …and the SVG that has to exist for it
//   { unknown: true }    the theme has no such icon and it is not one of ours
//   { error }            the value is one of ours but cannot be materialised
export function planSocialIcon({ siteRoot, value, themeIcons = [] }) {
  const icon = String(value ?? '').trim();
  if (icon === '') return { icon: '' };

  const spec = parseImageSpec(icon);
  if (spec) {
    const source = readImageSource({ siteRoot, ...spec });
    if (source.error) return { error: source.error };
    return iconFileFor({ siteRoot, baseName: imageIconName(spec), bytes: svgBytesForImage(source) });
  }

  // An explicit `phosphor-<name>` always means Phosphor, even for a name the theme also has.
  if (icon.startsWith(PHOSPHOR_PREFIX)) {
    const name = icon.slice(PHOSPHOR_PREFIX.length);
    const bytes = readPhosphorIconBytes(name);
    if (!bytes) {
      return { error: `没有名为 “${name}” 的 Phosphor 图标（Phosphor 图标由 @phosphor-icons/core 提供）` };
    }
    return iconFileFor({ siteRoot, baseName: `${PHOSPHOR_PREFIX}${name}`, bytes });
  }

  // A theme icon wins over a same-named Phosphor icon: `rss`, `home`, `link` and `search`
  // exist in both sets, and the theme's are the ones the rest of the site already uses.
  if (themeIcons.includes(icon)) return { icon };

  const bytes = readPhosphorIconBytes(icon);
  if (bytes) return iconFileFor({ siteRoot, baseName: `${PHOSPHOR_PREFIX}${icon}`, bytes });

  // The theme has no icons at all (or is missing): the editor has nothing to check against,
  // so it accepts the name, exactly as it did before Phosphor existed.
  if (themeIcons.length === 0) return { icon };
  return { unknown: true };
}

// New files only: a file that is already there with the same bytes is left alone (`noop`), and
// the caller never asks for a name that is taken (see `uniqueIconName`).
export function writeIconFile({ siteRoot, relPath, bytes }) {
  const abs = join(resolve(siteRoot), relPath);
  if (existsSync(abs) && readFileSync(abs).equals(bytes)) return { status: 'noop', path: abs };
  atomicWriteBytes(abs, bytes);
  return { status: 'created', path: abs };
}

export function iconFileStatus({ siteRoot, relPath, bytes }) {
  const abs = join(resolve(siteRoot), relPath);
  return existsSync(abs) && readFileSync(abs).equals(bytes) ? 'noop' : 'create';
}
