// Path safety for the site's config directory.
//
// Same interface as `PathGuard` (`resolveForRead` / `resolveForWrite` / `toRelative`), so the
// existing SafeWriter can be reused unchanged - but the rule is different in one important
// way: content is an allow-list of *directories* and a file type, and config is an allow-list
// of *files*. A TOML file is only writable if it already exists in `config/_default`, which
// is what stops a settings save from ever creating a new config file, writing into a
// subdirectory, or touching a theme's own config.

import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export class ConfigFileNotFoundError extends Error {
  constructor(relPath) {
    super(`config file not found: ${relPath}`);
    this.name = 'ConfigFileNotFoundError';
    this.path = relPath;
  }
}

export function isConfigFileName(relPath) {
  return typeof relPath === 'string' && /^[A-Za-z0-9_-]+\.toml$/.test(relPath);
}

export class ConfigGuard {
  constructor({ configRoot }) {
    this.configRoot = resolve(configRoot);
  }

  // The TOML files this editor is allowed to manage: the ones that are already there, at the
  // top level of the config directory.
  listFiles() {
    if (!existsSync(this.configRoot)) return [];
    return readdirSync(this.configRoot)
      .filter((name) => name.endsWith('.toml'))
      .filter((name) => {
        try {
          return this.resolveForWrite(name).startsWith(this.configRoot);
        } catch {
          return false;
        }
      })
      .sort();
  }

  resolveForRead(relPath) {
    const abs = this.#resolve(relPath);
    if (!isAbsolute(relPath) && isConfigFileName(relPath) && existsSync(abs)) return abs;
    throw new ConfigFileNotFoundError(relPath);
  }

  resolveForWrite(relPath) {
    const abs = this.#resolve(relPath);
    if (!existsSync(abs)) throw new ConfigFileNotFoundError(relPath);
    return abs;
  }

  #resolve(relPath) {
    if (typeof relPath !== 'string' || relPath === '') throw new Error('empty config path rejected');
    if (isAbsolute(relPath)) throw new Error(`absolute config path rejected: ${relPath}`);
    if (!isConfigFileName(relPath)) {
      throw new Error(`only a single .toml file in the config directory is writable: ${relPath}`);
    }
    const abs = resolve(this.configRoot, relPath);
    const rel = relative(this.configRoot, abs);
    if (rel !== relPath || rel.includes(sep) || rel.startsWith('..')) {
      throw new Error(`config path escapes the config directory: ${relPath}`);
    }
    return abs;
  }

  isWritable(relPath) {
    try {
      this.resolveForWrite(relPath);
      return true;
    } catch {
      return false;
    }
  }

  toRelative(absPath) {
    return relative(this.configRoot, absPath).split(sep).join('/');
  }
}

export function configGuardFor(siteRoot) {
  return new ConfigGuard({ configRoot: join(siteRoot, 'config', '_default') });
}
