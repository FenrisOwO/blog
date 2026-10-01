// Site Settings: preview a change, then save it, through the same SafeWriter the content
// layer uses.
//
// The shape of a save is unchanged from Phase 1: build the whole plan first, in memory,
// prove it (minimal rewrite + the value decodes back), and only then touch a file - through
// `saveSafely`, which backs up, writes atomically, verifies the read-back, and reports a
// no-op when nothing actually differs.
//
// A settings change can span several files (a language override lives in languages.toml
// while the site default lives in params.toml), which is the one place this differs from a
// document save. A multi-file save is therefore all-or-nothing: every file is planned and
// verified before the first write, and if a later write fails, the files already written are
// restored from the backups that write just made.

import { copyFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { saveSafely, diffLines, formatDiff } from '../site/safeWrite.js';
import { ASSET_LOCATIONS } from '../site/resourceModel.js';
import { SETTINGS_BY_ID } from './catalog.js';
import { ConfigGuard, isConfigFileName } from './configGuard.js';
import { describeSettings, publicSettings } from './describe.js';
import { PHOSPHOR_PREFIX, iconFileStatus, planSocialIcon, writeIconFile } from './socialIcons.js';
import { readThemeInfo } from './themeInfo.js';
import {
  applyAndVerify,
  formatInlineTable,
  formatValue,
  parseToml,
  planInsertArrayEntry,
  planInsertKeys,
  planRemoveArrayEntry,
  planValueEdit,
  sameValue,
} from './toml/index.js';

export class SettingsValidationError extends Error {
  constructor(message, { id = null } = {}) {
    super(message);
    this.name = 'SettingsValidationError';
    this.id = id;
  }
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function label(setting, field = null) {
  return field ? `${setting.label} · ${field.label}` : setting.label;
}

// -- validation --------------------------------------------------------------------------

function validateScalar({ setting, field, value, id }) {
  const type = field?.type ?? setting.type;
  const where = label(setting, field);

  if (type === 'boolean') {
    if (typeof value !== 'boolean') throw new SettingsValidationError(`${where}：需要 true/false`, { id });
    return value;
  }
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new SettingsValidationError(`${where}：需要一个数字`, { id });
    }
    if (setting.min !== null && setting.min !== undefined && value < setting.min) {
      throw new SettingsValidationError(`${where}：不能小于 ${setting.min}`, { id });
    }
    if (setting.max !== null && setting.max !== undefined && value > setting.max) {
      throw new SettingsValidationError(`${where}：不能大于 ${setting.max}`, { id });
    }
    if (field?.min !== undefined && value < field.min) {
      throw new SettingsValidationError(`${where}：不能小于 ${field.min}`, { id });
    }
    if (field?.max !== undefined && value > field.max) {
      throw new SettingsValidationError(`${where}：不能大于 ${field.max}`, { id });
    }
    return value;
  }
  if (type === 'select') {
    const options = (setting.options ?? []).map((option) => option.value);
    if (typeof value !== 'string' || !options.includes(value)) {
      throw new SettingsValidationError(`${where}：只能是 ${options.join(' / ')} 之一`, { id });
    }
    return value;
  }

  if (typeof value !== 'string') throw new SettingsValidationError(`${where}：需要文本`, { id });
  if (value.length > 2000) throw new SettingsValidationError(`${where}：文本过长（>2000 字符）`, { id });
  if (field?.required && value.trim() === '') throw new SettingsValidationError(`${where}：不能为空`, { id });
  return value;
}

function validateWidgets({ setting, value, id, widgetTypes }) {
  if (!Array.isArray(value)) throw new SettingsValidationError(`${setting.label}：需要组件列表`, { id });
  if (value.length > 12) throw new SettingsValidationError(`${setting.label}：组件过多（>12）`, { id });

  return value.map((item, index) => {
    if (!isPlainObject(item)) throw new SettingsValidationError(`${setting.label} 第 ${index + 1} 项：需要对象`, { id });
    const type = item.type;
    if (typeof type !== 'string' || type === '') {
      throw new SettingsValidationError(`${setting.label} 第 ${index + 1} 项：缺少 type`, { id });
    }
    if (widgetTypes.length > 0 && !widgetTypes.includes(type)) {
      throw new SettingsValidationError(
        `${setting.label} 第 ${index + 1} 项：主题没有 widget/${type}.html（可用：${widgetTypes.join(', ')}）`,
        { id },
      );
    }

    const params = item.params === undefined ? undefined : item.params;
    if (params !== undefined) {
      if (!isPlainObject(params)) throw new SettingsValidationError(`${setting.label} 第 ${index + 1} 项：params 需要是一个表`, { id });
      for (const [key, paramValue] of Object.entries(params)) {
        if (!['string', 'number', 'boolean'].includes(typeof paramValue)) {
          throw new SettingsValidationError(`${setting.label} 第 ${index + 1} 项：params.${key} 只支持字符串/数字/布尔`, { id });
        }
      }
      if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100)) {
        throw new SettingsValidationError(`${setting.label} 第 ${index + 1} 项：limit 需要是 1-100 的整数`, { id });
      }
      // An empty params table is not written: `{ type = "search", params = {} }` is noise.
      if (Object.keys(params).length === 0) {
        const { params: _dropped, ...rest } = item;
        return rest;
      }
    }
    return { type, ...(params ? { params } : {}) };
  });
}

// A social icon name the theme cannot resolve is a build failure, not a cosmetic problem:
// Hugo stops with "icon 'brand-mastodon.svg' is not found under 'assets/icons'". Resolving the
// value is therefore part of planning (`resolveIcon` in createSettingsService), and it can end
// in a file the save has to write as well as a value it has to set.

function validateMenuEntry({ setting, entry, id }) {
  const out = {};
  for (const field of setting.fields) {
    const value = entry?.[field.key];
    if (value === undefined || value === null || value === '') {
      if (field.required) throw new SettingsValidationError(`社交菜单：${field.label} 不能为空`, { id });
      continue;
    }
    out[field.key] = validateScalar({ setting, field, value, id: id ?? `${setting.id}.${field.key}` });
  }
  if (Object.keys(out).length === 0) throw new SettingsValidationError('社交菜单：需要至少一个字段', { id });
  return out;
}

// -- edits --------------------------------------------------------------------------------

// The widget list, written the way this site writes it: one inline table per line, indented
// one level deeper than the key, trailing comma on every item.
function formatWidgetsForFile(widgets, { indent, itemIndent }) {
  if (widgets.length === 0) return '[]';
  const inner = itemIndent ?? `${indent}    `;
  const lines = widgets.map((widget) => `${inner}{ ${formatInlineTable(widget)} },`);
  return `[\n${lines.join('\n')}\n${indent}]`;
}

// Values are planned in a batch per file, because two settings can share a table that does
// not exist yet - writing them one at a time would create that table twice.
function valueEditsFor({ doc, entries }) {
  const plans = planInsertKeys(doc.parsed, entries);
  if (plans.some((plan) => plan === null)) {
    throw new SettingsValidationError(`无法定位写入位置：${doc.file}`);
  }
  return plans;
}

function menuEntryLines({ arrayPath, entry, indent = '    ' }) {
  const lines = [`[[${arrayPath}]]`];
  const scalars = [];
  for (const [key, value] of Object.entries(entry)) {
    if (key.startsWith('params.')) continue;
    scalars.push([key, value]);
  }
  const params = Object.entries(entry).filter(([key]) => key.startsWith('params.'));
  const pad = scalars.reduce((max, [key]) => Math.max(max, key.length), 0);
  for (const [key, value] of scalars) {
    lines.push(`${indent}${key}${' '.repeat(pad - key.length)} = ${formatValue(value)}`);
  }
  if (params.length > 0) {
    lines.push('');
    lines.push(`${indent}[${arrayPath}.params]`);
    for (const [key, value] of params) {
      lines.push(`${indent}${indent}${key.slice('params.'.length)} = ${formatValue(value)}`);
    }
  }
  return lines;
}

// -- plan ---------------------------------------------------------------------------------

export function createSettingsService({
  siteRoot,
  configRoot = join(siteRoot, 'config', '_default'),
  backupRoot,
  themeInfo = null,
  // The writer is a seam, not a mock: it is `saveSafely` unless a caller says otherwise, and
  // the only caller that does is the test for the rollback path, which cannot be produced on
  // a healthy filesystem any other way.
  writeFile = saveSafely,
}) {
  const guard = new ConfigGuard({ configRoot });

  const describe = () => {
    const hugoText = guard.isWritable('hugo.toml') ? readFileSync(guard.resolveForRead('hugo.toml'), 'utf8') : '';
    const site = { servicesDisqusShortname: hugoText ? parseToml(hugoText).entries.get('services.disqus.shortname')?.value : undefined };
    const theme = themeInfo ?? readThemeInfo({ siteRoot, site });
    return describeSettings({ siteRoot, configRoot, themeInfo: theme });
  };

  function buildPlan({ set = {}, menu = {} } = {}) {
    const described = describe();
    const theme = described.theme;
    const changes = [];
    const warnings = [];
    const editsByFile = new Map();
    const pushEdit = (file, edit) => {
      if (!editsByFile.has(file)) editsByFile.set(file, []);
      editsByFile.get(file).push(edit);
    };
    const addChange = (change) => {
      changes.push(change);
    };

    // An icon the theme cannot resolve stops the build, so every social icon is resolved while
    // the plan is built: a theme icon is written as it is, a Phosphor name or a picture the
    // user picked gets an SVG of its own under the site's `assets/icons/` (socialIcons.js).
    // The plan carries the bytes; `save` is what writes them.
    const iconFiles = new Map();
    const resolveIcon = (rawIcon, id) => {
      const planned = planSocialIcon({ siteRoot, value: rawIcon, themeIcons: theme.icons ?? [] });
      if (planned.error) throw new SettingsValidationError(planned.error, { id });
      if (planned.unknown) {
        throw new SettingsValidationError(
          `主题里没有图标 “${rawIcon}”；可用图标：${(theme.icons ?? []).join(', ')}。`
            + `也可以填 ${PHOSPHOR_PREFIX}<Phosphor 名字>，或 image:<位置>:<路径>（位置取 ${ASSET_LOCATIONS.join(' / ')}）。`,
          { id },
        );
      }
      if (planned.file) iconFiles.set(planned.file.relPath, planned.file);
      return planned.icon;
    };

    const settingsById = new Map(Object.entries(described.settings));

    for (const [id, rawValue] of Object.entries(set ?? {})) {
      if (rawValue === undefined) continue;
      const target = described.targetIndex.get(id);
      if (!target) throw new SettingsValidationError(`未知的设置项：${id}`, { id });

      const setting = SETTINGS_BY_ID.get(target.setting.id) ?? target.setting;
      const doc = described.docs.get(target.file);
      if (!doc) throw new SettingsValidationError(`配置文件不存在：${target.file}`, { id });

      let value;
      let format = null;
      let formatOptions = {};
      if (target.kind === 'widgets' || setting.type === 'widgets') {
        if (!setting.widgetTypes || setting.widgetTypes.length === 0) {
          warnings.push(`${setting.label}：主题里没有找到 widget 模板，无法校验组件类型。`);
        }
        value = validateWidgets({ setting: { ...setting, widgetTypes: theme.widgetTypes }, value: rawValue, id, widgetTypes: theme.widgetTypes });
        format = formatWidgetsForFile;
      } else if (target.kind === 'menu-field' || target.kind === 'language-field') {
        value = validateScalar({ setting, field: target.field, value: rawValue, id });
        if (target.key === 'params.icon') value = resolveIcon(value, id);
      } else {
        value = validateScalar({ setting, value: rawValue, id });
      }

      const current = doc.parsed.entries.get(target.path)?.value;
      if (sameValue(current, value)) {
        addChange({ id, label: label(setting, target.field ?? null), file: target.file, path: target.path, from: current, to: value, status: 'noop' });
        continue;
      }

      pushEdit(target.file, {
        scope: 'values',
        entry: { path: target.path, value, format, formatOptions },
      });
      addChange({
        id,
        label: label(setting, target.field ?? null),
        file: target.file,
        path: target.path,
        from: current ?? null,
        to: value,
        status: current === undefined ? 'create' : 'update',
        origin: target.language ? `语言 ${target.language}` : null,
      });
      if (target.language && !doc.parsed.entries.has(target.path)) {
        warnings.push(`${target.path} 原本不存在，保存会新增这条语言覆盖。`);
      }
    }

    // Menu entries: removals first (they take whole blocks with them), then additions.
    for (const rawIndex of menu?.remove ?? []) {
      const index = Number(rawIndex);
      const doc = described.docs.get('menu.toml');
      if (!doc) throw new SettingsValidationError('menu.toml 不存在', { id: 'menu.social' });
      const section = settingsById.get('menu.social');
      const entry = section?.entries?.find((item) => item.index === index);
      if (!entry) throw new SettingsValidationError(`menu.toml 里没有第 ${index + 1} 条社交菜单`, { id: 'menu.social' });
      if ((section.entries?.length ?? 0) <= 1) {
        throw new SettingsValidationError('至少要保留一条社交菜单', { id: 'menu.social' });
      }
      pushEdit('menu.toml', planRemoveArrayEntry(doc.parsed, 'social', index));
      addChange({
        id: `menu.social[${index}]`,
        label: `社交菜单 · 删除 ${entry.name ?? entry.identifier ?? index + 1}`,
        file: 'menu.toml',
        path: `social[${index}]`,
        from: entry.identifier,
        to: null,
        status: 'remove',
      });
    }

    for (const rawEntry of menu?.add ?? []) {
      const doc = described.docs.get('menu.toml');
      if (!doc) throw new SettingsValidationError('menu.toml 不存在', { id: 'menu.social' });
      const setting = SETTINGS_BY_ID.get('menu.social');
      const entry = validateMenuEntry({ setting, entry: rawEntry, id: 'menu.social' });
      if (entry['params.icon']) entry['params.icon'] = resolveIcon(entry['params.icon'], 'menu.social');
      // Always write the identifier/name/url; params go into their own table, like the
      // entries already in the file.
      if (!entry.identifier) throw new SettingsValidationError('社交菜单：缺少标识（identifier）', { id: 'menu.social' });
      pushEdit('menu.toml', planInsertArrayEntry(doc.parsed, 'social', menuEntryLines({ arrayPath: 'social', entry })));
      addChange({
        id: 'menu.social.new',
        label: `社交菜单 · 新增 ${entry.name ?? entry.identifier}`,
        file: 'menu.toml',
        path: 'social[]',
        from: null,
        to: entry.identifier,
        status: 'create',
      });
    }

    // Apply the whole plan in memory, per file, and prove it before anything is written.
    const files = [];
    for (const [file, edits] of editsByFile) {
      const doc = described.docs.get(file);
      const valueEntries = edits.filter((item) => item.scope === 'values').map((item) => item.entry);
      const literalEdits = edits.filter((item) => item.scope !== 'values');
      const planned = [...valueEditsFor({ doc, entries: valueEntries }), ...literalEdits];
      const result = applyAndVerify(doc.text, planned);
      files.push({
        file,
        status: result.changed ? 'changed' : 'noop',
        before: doc.text,
        after: result.text,
        beforeSha: doc.sha256,
        afterSha: sha256(result.text),
        edits: result.edits,
      });
    }

    for (const file of described.files.map((item) => item.file)) {
      if (!files.some((item) => item.file === file)) {
        const doc = described.docs.get(file);
        files.push({ file, status: 'noop', before: doc.text, after: doc.text, beforeSha: doc.sha256, afterSha: doc.sha256, edits: [] });
      }
    }

    return { described, files, changes, warnings, iconFiles: [...iconFiles.values()] };
  }

  function filePreview(entry) {
    if (entry.status === 'noop') {
      return { file: entry.file, status: 'noop', diff: { added: 0, removed: 0 }, diffText: null, beforeSha: entry.beforeSha, afterSha: entry.afterSha };
    }
    const diff = diffLines(entry.before, entry.after);
    return {
      file: entry.file,
      status: 'changed',
      diff: { added: diff.added.length, removed: diff.removed.length },
      diffText: formatDiff(diff, entry.file),
      beforeSha: entry.beforeSha,
      afterSha: entry.afterSha,
      lines: entry.edits.length,
    };
  }

  // What a save would also write besides the config files: one SVG per social icon that does
  // not come from the theme. Reported here, written only by `save`.
  function iconsPreview(iconFiles) {
    return iconFiles.map((file) => ({
      path: file.relPath,
      status: iconFileStatus({ siteRoot, relPath: file.relPath, bytes: file.bytes }),
      bytes: file.bytes.length,
      sha256: file.sha256,
    }));
  }

  function preview({ set = {}, menu = {} } = {}) {
    const plan = buildPlan({ set, menu });
    const files = plan.files.map(filePreview);
    const icons = iconsPreview(plan.iconFiles);
    const changed = files.filter((file) => file.status !== 'noop');
    const changedIcons = icons.filter((icon) => icon.status !== 'noop');
    return {
      dryRun: true,
      files,
      icons,
      changedFiles: [...changed.map((file) => file.file), ...changedIcons.map((icon) => icon.path)],
      changes: plan.changes,
      warnings: plan.warnings,
      status: changed.length > 0 || changedIcons.length > 0 ? 'preview' : 'noop',
      description: publicSettings(plan.described),
    };
  }

  function save({ set = {}, menu = {} } = {}) {
    const plan = buildPlan({ set, menu });
    const changed = plan.files.filter((file) => file.status !== 'noop');
    // A missing icon file is reason enough to write even when every value already matches:
    // the config names an icon Hugo cannot find, and the build would stop on it.
    const pendingIcons = iconsPreview(plan.iconFiles).filter((icon) => icon.status !== 'noop');

    if (changed.length === 0 && pendingIcons.length === 0) {
      return {
        status: 'noop',
        files: [],
        icons: [],
        changes: plan.changes.map((change) => ({ ...change, status: 'noop' })),
        warnings: plan.warnings,
        touched: [],
        message: '所有值都与文件一致，没有写入。',
      };
    }

    const written = [];
    try {
      for (const entry of changed) {
        const result = writeFile({
          guard,
          relPath: entry.file,
          nextText: entry.after,
          backupRoot,
        });
        if (result.status === 'noop') {
          written.push({ file: entry.file, status: 'noop', backupPath: null });
          continue;
        }
        written.push({
          file: entry.file,
          status: result.status,
          backupPath: result.backupPath,
          diff: { added: result.diff.added.length, removed: result.diff.removed.length },
          bytes: Buffer.byteLength(entry.after, 'utf8'),
          sha256: sha256(readFileSync(guard.resolveForRead(entry.file), 'utf8')),
        });
      }
    } catch (error) {
      // Roll the files already written back to what they were. The backups were taken by the
      // same operation that wrote them, so a failure here is reported rather than hidden.
      const rolledBack = [];
      const failed = [];
      for (const item of [...written].reverse()) {
        if (!item.backupPath) continue;
        try {
          copyFileSync(item.backupPath, guard.resolveForWrite(item.file));
          rolledBack.push(item.file);
        } catch {
          failed.push(item.file);
        }
      }
      const rollbackNote = rolledBack.length > 0 ? `；已回滚：${rolledBack.join(', ')}` : '';
      const failedNote = failed.length > 0 ? `；回滚失败（需手工恢复）：${failed.join(', ')}` : '';
      throw new Error(`保存失败：${error.message}${rollbackNote}${failedNote}`);
    }

    // The config now names these icons, so the build needs them: an icon the theme cannot find
    // stops Hugo. New files only - a save never overwrites an icon that is already there with
    // different bytes (the name would have been disambiguated while planning instead).
    const writtenIcons = plan.iconFiles.map((file) => {
      const result = writeIconFile({ siteRoot, relPath: file.relPath, bytes: file.bytes });
      return { path: file.relPath, status: result.status, bytes: file.bytes.length, sha256: file.sha256 };
    });

    return {
      status: 'written',
      files: written,
      icons: writtenIcons,
      changes: plan.changes,
      warnings: plan.warnings,
      touched: written.filter((item) => item.status !== 'noop').map((item) => item.file),
      description: publicSettings(describe()),
    };
  }

  return {
    configRoot: guard.configRoot,
    guard,
    list: () => publicSettings(describe()),
    describe,
    // The raw file, for the read-only "原文" view. Reading it is how a user checks what the
    // form did, without the editor offering a second, unsafe way to write TOML.
    raw: (file) => {
      // A name that could never be a config file is a bad request; a name that is fine but
      // is not there is a missing file. The two answers are different on purpose.
      if (!isConfigFileName(file)) throw new SettingsValidationError(`不可读取的配置文件：${file}`);
      const text = readFileSync(guard.resolveForRead(file), 'utf8');
      const parsed = parseToml(text);
      return {
        file,
        text,
        sha256: sha256(text),
        lines: parsed.lines.length,
        tables: [...parsed.tables.keys()],
        arrays: [...parsed.arrayTables.keys()],
      };
    },
    preview,
    save,
  };
}
