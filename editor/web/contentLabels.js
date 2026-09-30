// Display names and formatting for the two axes of the content model, and the title fallback
// the list needs. Plain ESM with no Vue imports, so `node --test` can check the decisions
// instead of a browser - the same rule `fieldDrafts.js` follows.

// The type of the content: what the file means in the site.
export const CONTENT_KIND_LABELS = {
  article: '文章',
  page: '页面',
  category: '分类',
  other: '其它',
};

// The bundle form: how the file is shaped on disk.
export const FORM_LABELS = {
  standalone: '单文件',
  'leaf-bundle': 'leaf bundle',
  'branch-bundle': 'branch bundle',
};

export function contentKindLabel(kind) {
  return CONTENT_KIND_LABELS[kind] ?? kind ?? '未知';
}

export function formLabel(kind) {
  return FORM_LABELS[kind] ?? kind ?? '未知';
}

const INDEX_PATTERN = /(^|\/)_index(\.[^/]*)?\.md$/;

// A list row needs a name even when the document has no title, and the filename stem is a
// poor one for a bundle whose file is called `index.md`. Bundles fall back to their
// directory (`page/about`), and the home page - whose directory is the content root and has
// no name at all - says so instead of showing `_index`.
export function titleOf(doc) {
  const title = doc?.meta?.title;
  if (typeof title === 'string' && title.trim() !== '') return title;

  const path = doc?.path ?? '';
  if (INDEX_PATTERN.test(path) && !doc?.bundlePath) return '(站点首页)';
  if (doc?.bundlePath) return doc.bundlePath;
  if (doc?.base) return doc.base;
  return path;
}

// "when was this last touched", in the units a person actually uses. `now` is injectable so
// the formatting can be tested without freezing the clock.
export function formatUpdated(iso, now = Date.now()) {
  if (typeof iso !== 'string' || iso === '') return '';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';

  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return '刚刚';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days <= 30) return `${days} 天前`;
  return iso.slice(0, 10);
}
