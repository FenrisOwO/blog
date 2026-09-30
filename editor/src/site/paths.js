// Path safety for filesystem access.
//
// Writes are an allow-list, never a suggestion: a path must resolve inside one of the
// configured writable roots, be Markdown, and not be absolute. Phase 1 shipped with a
// single root (content/post); Phase 3 lets the editor manage the site's real Markdown
// pages too, so the roots are configurable - but the default is still the Phase 1 value,
// and every check below is unchanged.

import { statSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';

export function isInside(parent, child) {
  const rel = relative(parent, child);
  if (rel === '') return false;
  return !rel.startsWith('..') && !isAbsolute(rel);
}

export class PathGuard {
  constructor({
    contentRoot,
    writableSubdir = 'post',
    writableRoots = null,
    staticRoot = null,
    assetRoot = null,
    // Phase 7: the taxonomy roots (usually ['tags', 'categories']) whose `_index.md` files
    // are term pages. Empty by default, so nothing is writable through the taxonomy door
    // unless the site's own config asked for it.
    taxonomies = [],
  }) {
    this.contentRoot = resolve(contentRoot);
    this.writableRoots = (writableRoots ?? [writableSubdir]).map((root) => resolve(this.contentRoot, root));
    // Phase 6: where the site keeps non-content files. Both are read-only in this phase - the
    // guard knows how to resolve them so the asset browser has one door, not two.
    this.staticRoot = staticRoot ? resolve(staticRoot) : null;
    this.assetRoot = assetRoot ? resolve(assetRoot) : null;
    this.taxonomies = [...taxonomies];
  }

  // Kept for the Phase 1 shape of the API: a single writable root.
  get writableRoot() {
    return this.writableRoots[0];
  }

  resolveForRead(relPath) {
    const abs = resolve(this.contentRoot, relPath);
    if (abs !== this.contentRoot && !isInside(this.contentRoot, abs)) {
      throw new Error(`read outside content root: ${relPath}`);
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

  resolveForWrite(relPath) {
    if (typeof relPath !== 'string' || relPath === '') {
      throw new Error(`empty path rejected`);
    }
    if (isAbsolute(relPath)) {
      throw new Error(`absolute path rejected: ${relPath}`);
    }
    if (!relPath.endsWith('.md')) {
      throw new Error(`only .md files are writable: ${relPath}`);
    }
    const abs = resolve(this.contentRoot, relPath);
    const allowed = this.writableRoots.some((root) => isInside(root, abs) || root === this.contentRoot);
    if (!allowed || !isInside(this.contentRoot, abs)) {
      throw new Error(`write outside ${this.writableRoots.join(', ')}: ${relPath}`);
    }
    return abs;
  }

  toRelative(absPath) {
    return relative(this.contentRoot, absPath).split(sep).join('/');
  }

  // --- Phase 6: binary resources ------------------------------------------
  //
  // A resource is a file, not a document: the write guard's "only .md" rule is exactly
  // backwards here, so these are separate doors - and they keep the same two properties the
  // document guards have: an allow-list of roots, and a refusal that never reveals whether
  // the path exists.

  // Readable: any non-Markdown file inside the content tree (that is what a page resource is).
  resolveAssetForRead(relPath) {
    const abs = this.resolveForRead(relPath);
    if (abs === this.contentRoot) throw new Error(`not a file: ${relPath}`);
    if (abs.endsWith('.md')) throw new Error(`a Markdown file is a document, not a resource: ${relPath}`);
    return abs;
  }

  // Writable: a resource of a section the editor manages, and never a hidden temp file.
  resolveAssetForWrite(relPath) {
    if (typeof relPath !== 'string' || relPath === '') throw new Error('empty path rejected');
    if (isAbsolute(relPath)) throw new Error(`absolute path rejected: ${relPath}`);
    if (relPath.endsWith('.md')) throw new Error(`a Markdown file is a document, not a resource: ${relPath}`);
    const abs = resolve(this.contentRoot, relPath);
    const allowed = this.writableRoots.some((root) => isInside(root, abs) || root === this.contentRoot);
    if (!allowed || !isInside(this.contentRoot, abs)) {
      throw new Error(`write outside ${this.writableRoots.join(', ')}: ${relPath}`);
    }
    const name = relPath.split('/').pop() ?? '';
    if (name.startsWith('.')) throw new Error(`refusing a hidden file: ${relPath}`);
    return abs;
  }

  isWritableAsset(relPath) {
    try {
      this.resolveAssetForWrite(relPath);
      return true;
    } catch {
      return false;
    }
  }

  // Delete and replace use one rule, because a delete that cannot be undone by writing the
  // file back is not a capability this phase offers.
  resolveAssetForRemoval(relPath) {
    return this.resolveAssetForWrite(relPath);
  }

  // Static and asset-pipeline files: readable when the site has such a directory configured,
  // never writable in this phase. The location picks the root, so a path can only resolve
  // inside the tree it claims to belong to.
  resolveSiteAssetForRead({ location, relPath }) {
    const root = location === 'static' ? this.staticRoot : location === 'assets' ? this.assetRoot : null;
    if (!root) throw new Error(`unknown or unconfigured asset location: ${location}`);
    if (typeof relPath !== 'string' || relPath === '') throw new Error('empty path rejected');
    if (isAbsolute(relPath)) throw new Error(`absolute path rejected: ${relPath}`);
    const abs = resolve(root, relPath);
    if (!isInside(root, abs)) throw new Error(`read outside ${location}: ${relPath}`);
    return abs;
  }

  toRelativeTo(root, absPath) {
    return relative(root, absPath).split(sep).join('/');
  }

  // --- Phase 7: taxonomy term pages ---------------------------------------
  //
  // A tag or category page lives at `content/<taxonomy>/<term>/_index[_<lang>].md`. Renaming
  // a tag has to move that page with it, and the term directory is created by Hugo's own
  // convention rather than by the editor - so this is a second, narrower door than
  // `writableRoots` (which `content/tags` is usually not a member of): a path may be written
  // here only if it is exactly a taxonomy term page, only under a taxonomy the site's config
  // declares, and only one directory level below that taxonomy's root.
  resolveTaxonomyWrite(relPath) {
    if (typeof relPath !== 'string' || relPath === '') throw new Error('empty path rejected');
    if (isAbsolute(relPath)) throw new Error(`absolute path rejected: ${relPath}`);
    const clean = relPath.replace(/\\/g, '/');
    if (clean !== relPath) throw new Error(`backslashes are not a path separator here: ${relPath}`);
    if (!relPath.endsWith('.md')) throw new Error(`only .md files are writable: ${relPath}`);

    const segments = relPath.split('/');
    if (segments.length !== 3) {
      throw new Error(`not a taxonomy term page (expected <taxonomy>/<term>/_index.md): ${relPath}`);
    }
    const [taxonomy, term, file] = segments;
    if (!this.taxonomies.includes(taxonomy)) {
      throw new Error(`unknown taxonomy: ${taxonomy}`);
    }
    if (!term || term === '.' || term === '..' || term.includes('\0')) {
      throw new Error(`unsafe taxonomy term for a directory name: ${term}`);
    }
    if (!/^_index(\.[A-Za-z0-9-]+)?\.md$/.test(file)) {
      throw new Error(`a taxonomy term directory holds only _index files: ${relPath}`);
    }

    const taxonomyRoot = resolve(this.contentRoot, taxonomy);
    const termDir = resolve(taxonomyRoot, term);
    const abs = resolve(termDir, file);
    // The term is a single segment, so `../..` cannot be expressed as one - but a term that
    // resolves outside its taxonomy root (a symlink-free check on a name like 'a/../../b' is
    // impossible now that the name cannot contain a slash) is still refused rather than
    // trusted.
    if (!isInside(this.contentRoot, termDir) || !isInside(taxonomyRoot, abs)) {
      throw new Error(`taxonomy term page escapes its taxonomy: ${relPath}`);
    }
    return abs;
  }

  isWritableTaxonomyPage(relPath) {
    try {
      this.resolveTaxonomyWrite(relPath);
      return true;
    } catch {
      return false;
    }
  }

  // Deleting and restoring move whole bundles, so the target may be a directory - but it
  // still has to be inside a writable root, and it must never be the content root or a
  // section root (`content/post` is a door, not a room: deleting it would remove a section).
  //
  // "Section root" means a directory, though, not simply a path with no slash in it: the
  // home page is `content/_index.md`, a top-level FILE, and refusing to delete it would
  // make the editor unable to manage a page it happily lists and edits.
  resolveForRemoval(relPath) {
    if (typeof relPath !== 'string' || relPath === '') {
      throw new Error('empty path rejected');
    }
    if (isAbsolute(relPath)) {
      throw new Error(`absolute path rejected: ${relPath}`);
    }
    const abs = resolve(this.contentRoot, relPath);
    if (!isInside(this.contentRoot, abs)) {
      throw new Error(`delete outside content root: ${relPath}`);
    }
    const rel = relative(this.contentRoot, abs);
    const stats = statSync(abs, { throwIfNoEntry: false });
    const isSectionRoot = !rel.includes(sep) && (stats === undefined || stats.isDirectory());
    if (isSectionRoot) {
      throw new Error(`refusing to delete a section root: ${relPath}`);
    }
    if (!this.writableRoots.some((root) => isInside(root, abs))) {
      throw new Error(`delete outside ${this.writableRoots.join(', ')}: ${relPath}`);
    }
    return abs;
  }
}
