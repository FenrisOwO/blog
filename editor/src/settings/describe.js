// Turn the catalog + the real config files into the payload the Settings screen renders.
//
// The important part is `source`. Hugo's config is layered: `languages.<code>.params.<key>`
// overrides `params.<key>`, and the site's config overrides the theme's default config. A
// settings UI that treats "one setting = one TOML field" is wrong on this site - the English
// sidebar subtitle is *not* `params.toml:sidebar.subtitle` - so every row here carries where
// its value really comes from, and every per-language row says which language layer is
// winning. `describe.js` is the single place that resolves this; the UI only displays it.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { SETTINGS, SETTING_GROUPS, SETTINGS_BY_ID } from './catalog.js';
import { ConfigGuard } from './configGuard.js';
import { readThemeInfo } from './themeInfo.js';
import { parseToml, readToml } from './toml/index.js';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function createConfigDocs({ configRoot, files = null }) {
  const guard = new ConfigGuard({ configRoot });
  const list = files ?? guard.listFiles();
  const docs = new Map();
  for (const file of list) {
    const abs = guard.resolveForRead(file);
    const text = readFileSync(abs, 'utf8');
    const parsed = parseToml(text);
    docs.set(file, {
      file,
      abs,
      text,
      sha256: sha256(text),
      bytes: Buffer.byteLength(text, 'utf8'),
      lines: parsed.lines.length,
      parsed,
      values: readToml(text).values,
    });
  }
  return { guard, docs, files: [...docs.keys()] };
}

// Hugo's own config layering, in one place:
//   per-language value -> site value -> theme default -> nothing
function resolveValue({ docs, file, path, languageCode = null, languagePath = null, themeParams }) {
  const doc = docs.get(file);
  const languageDoc = docs.get('languages.toml');

  if (languageCode && languageDoc) {
    const key = languagePath ?? (path.startsWith('params.') || file === 'params.toml' ? `params.${path}` : null);
    if (key) {
      const languageEntry = languageDoc.parsed.entries.get(`${languageCode}.${key}`);
      if (languageEntry) {
        return { value: languageEntry.value, present: true, source: 'language', valueText: languageEntry.rawValue };
      }
    }
  }

  const entry = doc?.parsed.entries.get(path);
  if (entry) {
    return { value: entry.value, present: true, source: 'site', valueText: entry.rawValue };
  }

  if (themeParams && path in themeParams) {
    return { value: themeParams[path], present: false, source: 'theme', valueText: null };
  }

  return { value: null, present: false, source: 'unset', valueText: null };
}

function optionList({ setting, themeInfo, languages }) {
  if (setting.options) return setting.options.map((option) => ({ ...option }));
  if (setting.optionsFrom === 'commentProviders') {
    const providers = new Set(themeInfo.commentProviders);
    const current = themeInfo.params?.['comments.provider'];
    if (typeof current === 'string' && current !== '') providers.add(current);
    return [...providers].sort().map((value) => ({ value, label: value }));
  }
  if (setting.optionsFrom === 'languages') {
    return languages.map((language) => ({
      value: language.code,
      label: `${language.code}${language.label ? `（${language.label}）` : ''}`,
    }));
  }
  return null;
}

function languageList({ docs, fallback = [] }) {
  const languagesDoc = docs.get('languages.toml');
  if (!languagesDoc) return fallback;
  const codes = new Set();
  for (const path of languagesDoc.parsed.entries.keys()) {
    const dot = path.indexOf('.');
    if (dot > 0) codes.add(path.slice(0, dot));
  }

  return [...codes]
    .map((code) => ({
      code,
      label: languagesDoc.parsed.entries.get(`${code}.label`)?.value ?? code,
      locale: languagesDoc.parsed.entries.get(`${code}.locale`)?.value ?? null,
      weight: languagesDoc.parsed.entries.get(`${code}.weight`)?.value ?? null,
      title: languagesDoc.parsed.entries.get(`${code}.title`)?.value ?? null,
      present: true,
    }))
    .sort((a, b) => (a.weight ?? 0) - (b.weight ?? 0) || a.code.localeCompare(b.code));
}

function menuEntries({ docs, arrayPath, icons = [] }) {
  const menuDoc = docs.get('menu.toml');
  if (!menuDoc) return [];
  const keys = menuDoc.parsed.arrayTables.get(arrayPath) ?? [];
  return keys.map((key, index) => {
    const entry = (suffix) => menuDoc.parsed.entries.get(`${key}${suffix ? `.${suffix}` : ''}`);
    return {
      index,
      tableKey: key,
      identifier: entry('identifier')?.value ?? null,
      name: entry('name')?.value ?? null,
      url: entry('url')?.value ?? null,
      icon: entry('params.icon')?.value ?? null,
      // The theme resolves the icon at build time and fails the build when it is not there,
      // so the entry says up front whether the name is one the theme knows.
      iconKnown: icons.length === 0 || icons.includes(entry('params.icon')?.value),
      newTab: entry('params.newTab')?.value ?? null,
      present: {
        identifier: Boolean(entry('identifier')),
        name: Boolean(entry('name')),
        url: Boolean(entry('url')),
        'params.icon': Boolean(entry('params.icon')),
        'params.newTab': Boolean(entry('params.newTab')),
      },
    };
  });
}

// Every leaf path the catalog is responsible for, so the report of "settings we do not
// manage yet" is computed rather than guessed.
function coveredPaths({ described, settings }) {
  const covered = new Set();
  for (const setting of settings) {
    if (setting.path && setting.file !== 'languages.toml') covered.add(`${setting.file}:${setting.path}`);
    if (setting.perLanguage) {
      for (const language of described.languages) {
        const key = setting.languagePath ?? `params.${setting.path}`;
        covered.add(`languages.toml:${language.code}.${key}`);
      }
    }
    if (setting.type === 'language-list') {
      for (const language of described.languages) {
        for (const field of setting.fields) covered.add(`languages.toml:${language.code}.${field.key}`);
      }
    }
    if (setting.type === 'menu-list') {
      for (const entry of described.rawMenu?.[setting.arrayPath] ?? []) {
        for (const field of setting.fields) covered.add(`${setting.file}:${entry.tableKey}.${field.key}`);
      }
    }
  }
  return covered;
}

function unmanagedLeaves({ docs, covered }) {
  const out = {};
  for (const [file, doc] of docs) {
    const leaves = doc.parsed.leaves
      .filter((leaf) => !covered.has(`${file}:${leaf.path}`))
      .map((leaf) => ({
        path: leaf.path,
        type: leaf.type,
        valueText: leaf.rawValue,
        value: leaf.ok ? leaf.value : null,
        readable: leaf.ok,
        reason: leaf.ok ? null : leaf.reason,
        comment: leaf.comment,
      }));
    if (leaves.length > 0) out[file] = leaves;
  }
  return out;
}

export function describeSettings({ siteRoot, configRoot = join(siteRoot, 'config', '_default'), themeInfo = null }) {
  const { guard, docs, files } = createConfigDocs({ configRoot });
  const hugoValues = docs.get('hugo.toml')?.values ?? {};
  const theme = themeInfo ?? readThemeInfo({
    siteRoot,
    themeName: hugoValues.theme ?? null,
    site: { servicesDisqusShortname: hugoValues['services.disqus.shortname'] },
  });

  const languages = languageList({ docs });
  const defaultLanguage = hugoValues.defaultContentLanguage ?? languages[0]?.code ?? null;
  const languageRows = languages.map((language) => ({
    ...language,
    isDefault: language.code === defaultLanguage,
  }));

  const targetIndex = new Map();
  const settings = {};
  const groupOrder = new Map(SETTING_GROUPS.map((group, index) => [group.id, index]));

  const described = { languages: languageRows, docs, theme, rawMenu: {} };

  for (const setting of SETTINGS) {
    const doc = setting.file ? docs.get(setting.file) : null;
    const row = {
      id: setting.id,
      group: setting.group,
      label: setting.label,
      help: setting.help ?? null,
      type: setting.type,
      kind: 'value',
      file: setting.file ?? null,
      path: setting.path ?? null,
      warnings: setting.warnings ?? [],
      options: setting.options ?? null,
      min: setting.min ?? null,
      max: setting.max ?? null,
      themeDefault: Boolean(setting.themeDefault),
      editable: Boolean(doc),
      readOnlyReason: doc ? null : `配置文件不存在：${setting.file}`,
    };

    // Three of the settings are structural (a widget list, the social menu, the language
    // list) and the rest are a value at a path. The kind decides which branch runs; a
    // structural setting must never fall into the plain-value branch just because it also
    // names a path.
    const kind =
      setting.type === 'widgets' || setting.type === 'menu-list' || setting.type === 'language-list'
        ? setting.type
        : 'value';
    row.kind = kind;

    if (kind === 'value') {
      const resolved = resolveValue({
        docs,
        file: setting.file,
        path: setting.path,
        themeParams: setting.file === 'params.toml' ? theme.params : null,
      });
      row.value = resolved.value;
      row.valueText = resolved.valueText;
      row.present = resolved.present;
      row.source = resolved.source;
      row.target = { file: setting.file, path: setting.path };
      targetIndex.set(setting.id, { kind: 'value', file: setting.file, path: setting.path, setting });

      if (!resolved.present && resolved.source === 'theme') {
        row.warnings = [...row.warnings, '当前值来自主题默认配置（themes/…/config/_default/params.toml）；保存会在本站配置里新增覆盖。'];
      }

      if (setting.perLanguage) {
        row.perLanguage = true;
        row.languageRows = languageRows.map((language) => {
          const perLanguage = resolveValue({
            docs,
            file: setting.file,
            path: setting.path,
            languageCode: language.code,
            languagePath: setting.languagePath ?? null,
            themeParams: null,
          });
          const id = `${setting.id}@${language.code}`;
          targetIndex.set(id, {
            kind: 'value',
            file: perLanguage.present ? 'languages.toml' : 'languages.toml',
            path: setting.languagePath
              ? `${language.code}.${setting.languagePath}`
              : `${language.code}.params.${setting.path}`,
            setting,
            language: language.code,
          });
          return {
            id,
            code: language.code,
            label: language.label,
            value: perLanguage.present ? perLanguage.value : null,
            valueText: perLanguage.valueText,
            present: perLanguage.present,
            source: perLanguage.present ? 'language' : resolved.source,
            effective: perLanguage.present ? perLanguage.value : resolved.value,
            target: targetIndex.get(id),
          };
        });
      }
    } else if (kind === 'widgets') {
      row.widgetTypes = theme.widgetTypes;
      row.values = docs.get(setting.file)?.parsed.entries.get(setting.path)?.value ?? [];
      row.present = Boolean(docs.get(setting.file)?.parsed.entries.get(setting.path));
      row.target = { file: setting.file, path: setting.path };
      row.editable = Boolean(doc);
      targetIndex.set(setting.id, { kind: 'widgets', file: setting.file, path: setting.path, setting });
    } else if (kind === 'menu-list') {
      row.kind = 'menu-list';
      row.arrayPath = setting.arrayPath;
      row.fields = setting.fields;
      row.iconOptions = theme.icons;
      row.entries = menuEntries({ docs, arrayPath: setting.arrayPath, icons: theme.icons });
      described.rawMenu[setting.arrayPath] = row.entries;
      for (const entry of row.entries) {
        for (const field of setting.fields) {
          const path = `${entry.tableKey}.${field.key}`;
          const present = Boolean(docs.get(setting.file)?.parsed.entries.get(path));
          targetIndex.set(`${setting.id}[${entry.index}].${field.key}`, {
            kind: 'menu-field',
            file: setting.file,
            path,
            arrayPath: setting.arrayPath,
            index: entry.index,
            key: field.key,
            field,
            setting,
          });
        }
      }
    } else if (kind === 'language-list') {
      row.kind = 'language-list';
      row.fields = setting.fields;
      row.entries = languageRows.map((language) => ({
        code: language.code,
        isDefault: language.isDefault,
        values: Object.fromEntries(setting.fields.map((field) => [field.key, language[field.key] ?? null])),
      }));
      for (const language of languageRows) {
        for (const field of setting.fields) {
          targetIndex.set(`${setting.id}.${language.code}.${field.key}`, {
            kind: 'language-field',
            file: setting.file,
            path: `${language.code}.${field.key}`,
            language: language.code,
            key: field.key,
            field,
            setting,
          });
        }
      }
    }

    if (row.options === null && setting.optionsFrom) {
      row.options = optionList({ setting, themeInfo: theme, languages: languageRows });
    }
    settings[setting.id] = row;
  }

  const covered = coveredPaths({ described, settings: SETTINGS });
  const unmanaged = unmanagedLeaves({ docs, covered });

  const groups = SETTING_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    file: group.file,
    description: group.description,
    settings: SETTINGS.filter((setting) => setting.group === group.id).map((setting) => setting.id),
  })).sort((a, b) => groupOrder.get(a.id) - groupOrder.get(b.id));

  return {
    siteRoot,
    configRoot: guard.configRoot,
    files: files.map((file) => {
      const doc = docs.get(file);
      return {
        file,
        bytes: doc.bytes,
        lines: doc.lines,
        sha256: doc.sha256,
        tables: [...doc.parsed.tables.keys()].length,
        arrays: [...doc.parsed.arrayTables.keys()],
        editable: true,
      };
    }),
    theme: {
      name: theme.name,
      root: theme.root,
      present: theme.present,
      paramsFile: theme.paramsFile,
      widgetTypes: theme.widgetTypes,
      commentProviders: theme.commentProviders,
      icons: theme.icons,
      readOnly: true,
    },
    languages: languageRows,
    defaultLanguage,
    groups,
    settings,
    order: SETTINGS.map((setting) => setting.id),
    unmanaged,
    targetIndex,
    // Kept for the service; `publicSettings` drops it so the HTTP payload stays small.
    docs,
  };
}

// The payload the editor sends over HTTP: the parsed document map contains the whole text of
// every config file, and the browser has no use for it.
export function publicSettings(described) {
  const { docs, targetIndex, ...rest } = described;
  return rest;
}

export { SETTINGS, SETTING_GROUPS, SETTINGS_BY_ID };
