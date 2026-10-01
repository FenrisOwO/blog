// What the theme already tells us, read from the theme itself.
//
// Two of the settings are *choices from a set*, and the set belongs to the theme, not to this
// editor: which widgets can go in a sidebar (one partial per widget) and which comment
// backends exist (one table per provider). Deriving those lists from the theme means the form
// can never offer a widget the theme would not render, or a provider it does not support -
// and it keeps working if the theme is updated, without a hardcoded list to maintain.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { phosphorIconNames } from './socialIcons.js';
import { readToml } from './toml/index.js';

export function readThemeName({ siteRoot, hugoConfig = join(siteRoot, 'config', '_default', 'hugo.toml') }) {
  if (!existsSync(hugoConfig)) return null;
  const value = readToml(readFileSync(hugoConfig, 'utf8')).values.theme;
  return typeof value === 'string' && value !== '' ? value : null;
}

function widgetTypes(themeRoot) {
  const dir = join(themeRoot, 'layouts', '_partials', 'widget');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.html'))
    .map((name) => name.slice(0, -'.html'.length))
    .sort();
}

// Social menu entries name an icon; the theme resolves it from `assets/icons/<name>.svg` and
// FAILS THE BUILD when it is not there. Which names exist is therefore theme (and site)
// knowledge, and the editor has to know it before writing one.
function iconNames(roots) {
  const names = new Set();
  for (const root of roots) {
    const dir = join(root, 'assets', 'icons');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.svg')) names.add(name.slice(0, -'.svg'.length));
    }
  }
  return [...names].sort();
}

function commentProviders(themeRoot, site) {
  const providers = new Set();
  const themeParams = join(themeRoot, 'config', '_default', 'params.toml');
  if (existsSync(themeParams)) {
    const parsed = readToml(readFileSync(themeParams, 'utf8'));
    for (const table of parsed.tables) {
      const match = /^comments\.([A-Za-z0-9_-]+)$/.exec(table);
      if (match) providers.add(match[1]);
    }
  }
  // `disqus` is not a `[comments.<provider>]` table in this theme: it is Hugo's own service,
  // so it is a provider exactly when the site configures one.
  if (site.servicesDisqusShortname !== undefined && site.servicesDisqusShortname !== '') providers.add('disqus');
  return [...providers].sort();
}

export function readThemeInfo({ siteRoot, themeName = null, site = {} }) {
  const name = themeName ?? readThemeName({ siteRoot });
  const root = name ? join(siteRoot, 'themes', name) : null;
  const present = Boolean(root && existsSync(root) && statSync(root).isDirectory());

  const defaultParamsFile = present ? join(root, 'config', '_default', 'params.toml') : null;
  const defaultParams = defaultParamsFile && existsSync(defaultParamsFile)
    ? readToml(readFileSync(defaultParamsFile, 'utf8'))
    : null;

  return {
    name,
    root: present ? root : null,
    present,
    // What the theme alone would use, so the editor can say "this value comes from the theme
    // and saving would override it here" instead of showing an empty field.
    params: defaultParams?.values ?? {},
    paramsFile: defaultParamsFile,
    widgetTypes: present ? widgetTypes(root) : [],
    commentProviders: present ? commentProviders(root, site) : [],
    icons: present ? iconNames([root, siteRoot]) : [],
    // Names the editor can install itself, from the optional `@phosphor-icons/core` package
    // (feel free to leave it out: an empty list costs nothing but the extra choices).
    phosphorIcons: present ? phosphorIconNames() : [],
  };
}

// Where the site's own `[languages]`/`[[menu]]`-style defaults live for non-params settings:
// Hugo merges the theme's config with the site's, and only the site side is ever written.
export const THEME_CONFIG_READ_ONLY = true;
