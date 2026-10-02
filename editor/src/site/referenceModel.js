// The reference model: which strings in Markdown / front matter Hugo can actually resolve.
//
// The chain that has to agree is
//
//   content tree -> Hugo Page Resources -> reference -> Hugo build -> published URL
//
// and the rule Hugo follows is narrow:
//
//   * a page resource is found by its path INSIDE the page's own leaf bundle
//     (`image.png`, `images/image.png`) - that is why the reference is bundle-relative;
//   * anything else is taken literally as a URL, interpreted relative to the page it is
//     rendered on (`src="categories/Documentation/x.jpg"` on /p/foo/ means
//     /p/foo/categories/Documentation/x.jpg);
//   * `static/` is copied to the site root, so it is referenced by an absolute path
//     (`/img/logo.png`) - the same string works from any page and in production;
//   * `assets/` is Hugo's pipeline, not content: nothing in Markdown can name it (the
//     theme's image hook only resolves page resources and remote URLs).
//
// A source-tree path such as `categories/Documentation/hash.jpg` is therefore not "almost
// right": Hugo never sees it as a resource of the post, it publishes the file under the
// OWNING page's URL (`/categories/documentation/hash.jpg` - note the case, which follows the
// published URL, not the directory name), and the raw string ends up relative to whatever
// page happens to render it. Both halves of that are wrong at once, which is exactly how a
// cover can look plausible in one place and 404 everywhere else.
//
// This module is pure: it classifies and it suggests. It never reads the filesystem, and it
// is the only place the editor decides whether a reference is resolvable.

// `page-resource`   the file is in this document's own bundle - the only form Hugo resolves
// `site-url`        an absolute path into the published site (static/, or a published URL)
// `external`        http(s) / protocol-relative / data: - passed through untouched
// `source-path`     a path in the content tree (optionally `content/`-prefixed)
// `foreign-resource` a bundle-relative name that belongs to ANOTHER page's bundle
// `pipeline-asset`  a file under assets/ (Hugo pipeline input, not referenceable in Markdown)
// `unpublished-url` an absolute path that the last build did not publish
// `no-bundle`       a page-relative name, but this document is a single file with no bundle
// `ambiguous-name`  a bare name that exists in more than one bundle
// `empty`           nothing to resolve
export const REFERENCE_KINDS = [
  'page-resource',
  'site-url',
  'external',
  'source-path',
  'foreign-resource',
  'pipeline-asset',
  'unpublished-url',
  'no-bundle',
  'ambiguous-name',
  'empty',
];

const RESOLVABLE = new Set(['page-resource', 'site-url', 'external']);

// Directories that only exist in the source tree, so a reference containing them is a
// source path, never a URL.
const SOURCE_ROOTS = ['content/', 'static/', 'assets/'];

const EXTERNAL = /^(?:https?:)?\/\/|^(?:data|mailto|tel):/i;
// Markdown link destinations cannot contain whitespace unless they are wrapped in <...>.
// Goldmark leaves `![alt](image with space.png)` as literal text - a silent failure, which
// is why a reference with a space is written in the angle-bracket form instead.
const NEEDS_ANGLE = /[\s()<>]/;

export function stripAngle(value) {
  const text = String(value ?? '').trim();
  return text.startsWith('<') && text.endsWith('>') ? text.slice(1, -1) : text;
}

export function isReferenceWrapped(value) {
  const text = String(value ?? '').trim();
  return text.startsWith('<') && text.endsWith('>');
}

// The Markdown destination for a reference: angle brackets only when the destination needs
// them, so ordinary names stay readable.
export function markdownDestination(reference) {
  const value = String(reference ?? '').trim();
  if (value === '' || isReferenceWrapped(value)) return value;
  return NEEDS_ANGLE.test(value) ? `<${value}>` : value;
}

// A file inside `bundlePath` addressed from that bundle: `post/foo/images/x.png` in bundle
// `post/foo` is `images/x.png`. Null when the file is not inside the bundle at all - the
// caller then has to explain why it cannot be referenced, not silently write a path.
export function bundleRelative(bundlePath, resourcePath) {
  const bundle = String(bundlePath ?? '').replace(/\/+$/, '');
  const resource = String(resourcePath ?? '').replace(/^\/+/, '');
  if (bundle === '') return null;
  if (!resource.startsWith(`${bundle}/`)) return null;
  const relative = resource.slice(bundle.length + 1);
  return relative === '' ? null : relative;
}

// The bundle a document lives in, or null for a single-file page. Hugo's rule, mirrored:
// a directory is a bundle when it holds an `index.*.md` (leaf) or `_index.*.md` (branch).
export function bundleOfDocument(documentPath) {
  const path = String(documentPath ?? '');
  const cut = path.lastIndexOf('/');
  if (cut < 0) return null;
  const dir = path.slice(0, cut);
  const name = path.slice(cut + 1);
  if (/^index(\.[A-Za-z0-9-]+)?\.md$/.test(name) || /^_index(\.[A-Za-z0-9-]+)?\.md$/.test(name)) return dir;
  return null;
}

function caseInsensitiveMatch(paths, value) {
  const lower = value.toLowerCase();
  return paths.find((path) => path.toLowerCase() === lower) ?? null;
}

function basename(path) {
  const cut = String(path).lastIndexOf('/');
  return cut < 0 ? String(path) : String(path).slice(cut + 1);
}

// Classify one reference value for one document.
//
// context:
//   documentPath      the document the reference is written in (`post/foo/index.md`)
//   bundlePath        its bundle, or null when the document is a single file
//   bundleResources   paths (content-root-relative) of that bundle's resources
//   contentResources  paths of every resource in the content tree
//   staticPaths       paths under static/, relative to static/
//   assetPaths        paths under assets/, relative to assets/
//   isPublished(url)   does the last build publish this absolute path? (static/ is always
//                      published, so `isPublished` is only consulted for other paths)
export function classifyReference(value, context = {}) {
  const raw = String(value ?? '').trim();
  const {
    documentPath = '',
    bundlePath = bundleOfDocument(documentPath),
    bundleResources = [],
    contentResources = [],
    staticPaths = [],
    assetPaths = [],
    isPublished = null,
  } = context;

  if (raw === '') {
    return { kind: 'empty', ok: false, value: raw, reason: '引用是空的。' };
  }

  if (EXTERNAL.test(raw)) {
    return { kind: 'external', ok: true, value: raw, reason: null };
  }

  const wrapped = isReferenceWrapped(raw);
  const text = stripAngle(raw);

  // An absolute path: a URL into the published site. static/ files live there, and so do
  // resources of other pages - both are legitimate, and both are checkable.
  if (text.startsWith('/')) {
    const path = text.slice(1);
    const staticPath = staticPaths.includes(path) ? path : null;
    if (staticPath !== null) {
      return { kind: 'site-url', ok: true, value: text, reason: null, source: `static/${path}` };
    }
    // What the build publishes is the only thing a browser can fetch, so it decides first: a
    // branch bundle's resources are published under the page's own URL, which can look exactly
    // like a content path (`/categories/documentation/...` for the page in
    // content/categories/Documentation/).
    if (isPublished && isPublished(text)) {
      return { kind: 'site-url', ok: true, value: text, reason: null, source: null };
    }
    // Not published, and it names a real file in the content tree: that is the source path
    // mistake. The case usually differs from the published URL, so say so instead of "not
    // published".
    const sourceHit = contentResources.find((candidate) => candidate === path) ?? caseInsensitiveMatch(contentResources, path);
    if (sourceHit !== null) {
      return {
        kind: 'source-path',
        ok: false,
        value: text,
        source: `content/${sourceHit}`,
        reason: `这是内容树里的路径（content/${sourceHit}），不是发布后的 URL——Hugo 发布的地址由所属页面决定，大小写也常常不同（例如 /categories/documentation/…）。`,
        suggestion: null,
      };
    }
    if (isPublished) {
      return {
        kind: 'unpublished-url',
        ok: false,
        value: text,
        reason: '最近一次构建的产物里没有这个地址（本地和线上都会 404）。',
        suggestion: '先构建一次，或改成资源面板里给出的引用。',
      };
    }
    return { kind: 'site-url', ok: true, value: text, reason: null };
  }

  // `./name` and `name` mean the same thing to Hugo; normalise before judging, so the
  // verdict describes the file, not the spelling.
  const normalized = text.replace(/^\.\//, '');

  const inOwnBundle = bundleResources.includes(normalized) || bundleResources.includes(text);
  if (inOwnBundle) {
    const reference = bundleResources.includes(normalized) ? normalized : text;
    const destination = markdownDestination(reference);
    if (destination !== raw) {
      return {
        kind: 'page-resource',
        ok: false,
        value: raw,
        normalized: reference,
        suggestion: destination,
        reason: reference === raw
          ? '这个文件名需要写成 <名字> 形式（文件名里有空格或括号）。'
          : `可以写成 ${destination}，Hugo 就能按页面资源解析它。`,
      };
    }
    return { kind: 'page-resource', ok: true, value: raw, normalized: reference, reason: null };
  }

  // `content/...`, `static/...`, `assets/...` and any path that matches a real file in the
  // content tree: a source path, whichever way it is written.
  const rootHit = SOURCE_ROOTS.find((root) => text.startsWith(root));
  if (rootHit) {
    const inner = text.slice(rootHit.length);
    if (inner === '') {
      return { kind: 'source-path', ok: false, value: raw, reason: `这是源码树路径（${text}），不是 Hugo 能解析的引用。` };
    }
    if (rootHit === 'static/') {
      return {
        kind: 'site-url',
        ok: false,
        value: raw,
        suggestion: `/${inner}`,
        reason: 'static/ 里的文件以站点根为地址，引用要写成 / 开头的 URL。',
      };
    }
    if (rootHit === 'assets/') {
      return {
        kind: 'pipeline-asset',
        ok: false,
        value: raw,
        reason: 'assets/ 是 Hugo 的管线资源，Markdown 与 front matter 都引用不到它（主题的图片钩子只解析页面资源与远程地址）。',
        suggestion: '把文件放进本文的 bundle，或放进 static/ 后用 /路径 引用。',
      };
    }
    if (rootHit === 'content/') {
      // `content/...` is the same path the content tree uses; judge the inner path and keep
      // the user's spelling as the value under review.
      return { ...classifyReference(inner, context), value: raw };
    }
    return {
      kind: 'source-path',
      ok: false,
      value: raw,
      reason: `这是内容树里的路径（${text}）——Hugo 不会把它当成页面资源，发布地址由所属页面决定。`,
      suggestion: '如果文件在本文的 bundle 里，写 bundle 内的相对路径；否则放进 static/ 并用 /路径 引用。',
    };
  }

  const assetHit = assetPaths.includes(normalized) || assetPaths.includes(text);
  if (assetHit) {
    return {
      kind: 'pipeline-asset',
      ok: false,
      value: raw,
      reason: '这个文件在 assets/ 里，属于 Hugo 的管线资源，Markdown 与 front matter 都引用不到它。',
      suggestion: '把文件放进本文的 bundle，或放进 static/ 后用 /路径 引用。',
    };
  }

  // A path that names a real file in the content tree is a source path: Hugo never sees the
  // string as a URL, and the file belongs to whichever page owns its bundle.
  const exact = contentResources.find((candidate) => candidate === normalized);
  if (exact) {
    const inside = bundlePath ? bundleRelative(bundlePath, exact) : null;
    if (inside !== null) {
      // The file IS this document's resource - only the spelling is wrong.
      return {
        kind: 'page-resource',
        ok: false,
        value: raw,
        source: `content/${exact}`,
        normalized: inside,
        suggestion: markdownDestination(inside),
        reason: `这是内容树里的写法；Hugo 按 bundle 内的相对路径解析页面资源，写 ${markdownDestination(inside)} 就对了。`,
      };
    }
    const owner = exact.includes('/') ? exact.slice(0, exact.lastIndexOf('/')) : '';
    return {
      kind: 'foreign-resource',
      ok: false,
      value: raw,
      source: `content/${exact}`,
      owner,
      reason: owner === ''
        ? `这是内容树里的路径（content/${exact}）——Hugo 不会把它当成页面资源，也不存在同名的发布地址。`
        : `这是内容树里的路径（content/${exact}）：它属于 bundle ${owner}，只对那个页面是页面资源，Hugo 在本文里解析不到它，也不存在这个 URL。`,
      suggestion: `把文件放进本文的 bundle（${bundlePath ?? '本文是单文件文章，没有 bundle'}），或放进 static/ 并用 /路径 引用。`,
    };
  }

  // A name that belongs to another page's bundle. Hugo resolves page resources only for the
  // rendering page, so this can never work - even when the file is one directory away.
  const foreign = contentResources.filter((candidate) => basename(candidate) === basename(normalized));
  if (foreign.length === 1) {
    const owner = foreign[0].includes('/') ? foreign[0].slice(0, foreign[0].lastIndexOf('/')) : '';
    return {
      kind: 'foreign-resource',
      ok: false,
      value: raw,
      source: `content/${foreign[0]}`,
      owner,
      reason: `这个文件属于 bundle ${owner}（content/${foreign[0]}），只对那个页面是页面资源；Hugo 在本文里解析不到它。`,
      suggestion: `把文件放进本文的 bundle（${bundlePath ?? '本文是单文件文章，没有 bundle'}），或放进 static/ 并用 /路径 引用。`,
    };
  }
  if (foreign.length > 1) {
    return {
      kind: 'ambiguous-name',
      ok: false,
      value: raw,
      candidates: foreign.map((candidate) => `content/${candidate}`),
      reason: `有 ${foreign.length} 个 bundle 里有这个文件名，Hugo 无法按名字判断你指的是哪一个。`,
      suggestion: '把文件放进本文的 bundle，或改成明确的 / 开头的 URL。',
    };
  }

  if (bundlePath === null || bundlePath === undefined || bundlePath === '') {
    return {
      kind: 'no-bundle',
      ok: false,
      value: raw,
      reason: '这篇文章是单文件（不在 bundle 里），它旁边的文件不是 Hugo 页面资源，Hugo 只会把它当成相对当前页面的 URL。',
      suggestion: '把图片放进 static/ 并用 /路径 引用；若要用 page resource，需要把文章改成 bundle（index.md + 图片同目录）。',
    };
  }

  const destination = markdownDestination(normalized);
  return {
    kind: 'page-resource',
    ok: false,
    value: raw,
    normalized,
    suggestion: destination === raw ? null : destination,
    reason: `本文的 bundle（${bundlePath}）里没有这个文件，Hugo 会把它当成相对当前页面的 URL；如果文件不在这里，页面就会 404。`,
  };
}

// The reference a document should use for a resource - or a reason why it cannot be used at
// all. This is what the resource lists offer, so the editor never has to guess again.
export function referenceForResource({ documentPath = '', bundlePath = bundleOfDocument(documentPath), resourcePath }) {
  const relative = bundlePath === null || bundlePath === undefined ? null : bundleRelative(bundlePath, resourcePath);
  if (relative === null) {
    const owner = String(resourcePath ?? '').includes('/') ? String(resourcePath).slice(0, String(resourcePath).lastIndexOf('/')) : '';
    return {
      ok: false,
      kind: 'foreign-resource',
      reference: null,
      reason: owner === ''
        ? '这个文件不在本文的 bundle 里，Markdown 引用不到它。'
        : `这个文件属于 bundle ${owner}，只能由那个页面按页面资源引用。`,
    };
  }
  return { ok: true, kind: 'page-resource', reference: markdownDestination(relative), relative };
}

// static/ files are published at the site root, so their reference is `/` + their path. The
// same string works from every page, in preview and in production, which is why shared
// images belong there.
export function referenceForStatic(staticPath) {
  const path = String(staticPath ?? '').replace(/^\/+/, '');
  if (path === '') return { ok: false, kind: 'empty', reference: null, reason: '空路径。' };
  return { ok: true, kind: 'site-url', reference: `/${path}`, relative: path };
}

// Only the resolvable kinds are allowed into a document; the rest carry a reason.
export function isResolvable(verdict) {
  return Boolean(verdict) && RESOLVABLE.has(verdict.kind) && verdict.ok === true;
}

export function describeReferenceKind(kind) {
  switch (kind) {
    case 'page-resource':
      return '页面资源（本文 bundle 内的文件）';
    case 'site-url':
      return '站点 URL（static/ 或已发布的地址）';
    case 'external':
      return '外部地址';
    case 'source-path':
      return '内容树路径（Hugo 不解析）';
    case 'foreign-resource':
      return '别的页面 bundle 里的文件';
    case 'pipeline-asset':
      return 'assets/ 管线资源';
    case 'unpublished-url':
      return '未被构建发布的地址';
    case 'no-bundle':
      return '单文件文章的相对名字';
    case 'ambiguous-name':
      return '重名文件';
    case 'empty':
      return '空引用';
    default:
      return '未知引用类型';
  }
}
