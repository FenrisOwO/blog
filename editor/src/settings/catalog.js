// What the Settings screen offers, and where each setting actually lives.
//
// Two rules shape this file:
//
//  1. Nothing here contains the *contents* of a config file. Every entry names a file and a
//     dotted key path; the current value is always read from the real files at request time,
//     so a value the user changed by hand is never overwritten by a stale copy.
//
//  2. A setting is only listed if this Hugo site really has it - either in the site's own
//     `config/_default/*.toml`, or in the theme's default config, in which case the editor
//     says so and saving *creates* the site-level override (which is how Hugo config
//     layering is meant to be used, and why `colorScheme` can be offered at all: this site
//     never wrote it down, the theme did).
//
// `perLanguage` marks a setting Hugo can override per language
// (`languages.<code>.params.<key>`); `languagePath` does the same for a top-level key such as
// `title`, which `languages.<code>.title` overrides. The resolution order - language, then
// site, then theme - is implemented once, in `describe.js`, and shown in the UI as "来源".

export const SETTING_GROUPS = [
  {
    id: 'general',
    label: '常规',
    file: 'hugo.toml',
    description: '站点标题、地址、默认语言、分页与 Disqus 短名（hugo.toml）',
  },
  {
    id: 'appearance',
    label: '外观',
    file: 'params.toml',
    description: '配色、侧边栏、页脚、文章、评论、Cookie 与首页组件（params.toml，未写入的值来自主题默认）',
  },
  {
    id: 'navigation',
    label: '导航',
    file: 'menu.toml',
    description: '社交菜单条目（menu.toml）。主菜单项由页面的 front matter `menu` 决定，属于内容编辑。',
  },
  {
    id: 'language',
    label: '语言',
    file: 'languages.toml',
    description: '每种语言的名称、地区与排序（languages.toml）',
  },
  {
    id: 'markup',
    label: 'Markdown',
    file: 'markup.toml',
    description: 'Goldmark 扩展与代码高亮（markup.toml）',
  },
  {
    id: 'related',
    label: '相关文章',
    file: 'related.toml',
    description: '相关文章索引与阈值（related.toml）',
  },
];

// The select values a setting accepts. Kept next to the setting because they are Hugo's
// vocabulary, not the theme's (the theme's own lists are derived from the theme, see
// `themeInfo.js`).
const COLOR_SCHEMES = [
  { value: 'auto', label: '跟随系统 (auto)' },
  { value: 'light', label: '浅色 (light)' },
  { value: 'dark', label: '深色 (dark)' },
];

const SORT_BY = [
  { value: 'default', label: '默认（日期）' },
  { value: 'lastmod', label: '最后修改时间' },
];

export const SETTINGS = [
  // -- hugo.toml ---------------------------------------------------------------------
  {
    id: 'hugo.title',
    group: 'general',
    file: 'hugo.toml',
    path: 'title',
    type: 'text',
    label: '站点标题',
    help: 'languages.toml 里为某种语言写了 title 时，该语言以此为准。',
    perLanguage: true,
    languagePath: 'title',
  },
  { id: 'hugo.baseURL', group: 'general', file: 'hugo.toml', path: 'baseURL', type: 'text', label: '站点地址', help: '生成绝对链接时使用；本地预览时通常保持 http://localhost:1313/。' },
  {
    id: 'hugo.defaultContentLanguage',
    group: 'general',
    file: 'hugo.toml',
    path: 'defaultContentLanguage',
    type: 'select',
    optionsFrom: 'languages',
    label: '默认语言',
    help: '默认语言的内容会生成在站点根路径下，修改它会让所有语言的输出位置改变，需要完整重建。',
    warnings: ['修改默认语言会改变输出目录结构，构建后请检查各语言页面。'],
  },
  { id: 'hugo.hasCJKLanguage', group: 'general', file: 'hugo.toml', path: 'hasCJKLanguage', type: 'boolean', label: 'CJK 语言', help: '影响 .Summary 与 .WordCount 对中日韩文本的切分。' },
  { id: 'hugo.pagination.pagerSize', group: 'general', file: 'hugo.toml', path: 'pagination.pagerSize', type: 'number', min: 1, max: 100, label: '每页文章数', help: '列表分页大小。' },
  { id: 'hugo.services.disqus.shortname', group: 'general', file: 'hugo.toml', path: 'services.disqus.shortname', type: 'text', label: 'Disqus 短名', help: '评论提供方选择 disqus 时使用。' },
  { id: 'params.favicon', group: 'appearance', file: 'params.toml', path: 'favicon', type: 'text', label: '站点图标', help: '相对 static/ 或 assets/ 的图片路径。' },

  // -- params.toml (appearance) ------------------------------------------------------
  {
    id: 'params.colorScheme.default',
    group: 'appearance',
    file: 'params.toml',
    path: 'colorScheme.default',
    type: 'select',
    options: COLOR_SCHEMES,
    label: '默认配色',
    themeDefault: true,
    help: '主题默认 auto。保存后会在本站的 params.toml 里写入覆盖值。',
  },
  { id: 'params.colorScheme.toggle', group: 'appearance', file: 'params.toml', path: 'colorScheme.toggle', type: 'boolean', label: '允许切换明暗', themeDefault: true, help: '关闭后主题会强制使用默认配色。' },
  { id: 'params.sidebar.emoji', group: 'appearance', file: 'params.toml', path: 'sidebar.emoji', type: 'text', label: '头像角标', help: '显示在头像右下角的表情。' },
  {
    id: 'params.sidebar.subtitle',
    group: 'appearance',
    file: 'params.toml',
    path: 'sidebar.subtitle',
    type: 'text',
    label: '侧边栏副标题',
    perLanguage: true,
    help: '站点默认值；某种语言在 languages.toml 里有覆盖时，该语言显示覆盖值。',
  },
  { id: 'params.sidebar.avatar', group: 'appearance', file: 'params.toml', path: 'sidebar.avatar', type: 'text', label: '头像路径', help: '相对于 static/ 或 assets/ 的图片路径。' },
  { id: 'params.SortBy', group: 'appearance', file: 'params.toml', path: 'SortBy', type: 'select', options: SORT_BY, label: '列表排序', themeDefault: true, help: '主题定义的列表排序方式；本站未写入该值，显示的是主题默认。' },
  { id: 'params.sidebar.compact', group: 'appearance', file: 'params.toml', path: 'sidebar.compact', type: 'boolean', label: '紧凑侧边栏', themeDefault: true },
  { id: 'params.footer.since', group: 'appearance', file: 'params.toml', path: 'footer.since', type: 'number', min: 1970, max: 2100, label: '页脚起始年份', help: '显示为“起始年 - 当前年”。' },
  { id: 'params.footer.customText', group: 'appearance', file: 'params.toml', path: 'footer.customText', type: 'text', label: '页脚自定义文字', themeDefault: true, help: '支持 HTML，显示在页脚版权行下方。' },
  { id: 'params.article.license.enabled', group: 'appearance', file: 'params.toml', path: 'article.license.enabled', type: 'boolean', label: '文章许可协议', help: '在文章底部显示许可信息。' },
  { id: 'params.article.license.default', group: 'appearance', file: 'params.toml', path: 'article.license.default', type: 'text', label: '默认许可文本', help: '支持 Markdown。' },
  { id: 'params.article.readingTime', group: 'appearance', file: 'params.toml', path: 'article.readingTime', type: 'boolean', label: '显示阅读时长', themeDefault: true },
  { id: 'params.article.toc', group: 'appearance', file: 'params.toml', path: 'article.toc', type: 'boolean', label: '显示文章目录', themeDefault: true },
  { id: 'params.comments.enabled', group: 'appearance', file: 'params.toml', path: 'comments.enabled', type: 'boolean', label: '启用评论' },
  { id: 'params.comments.provider', group: 'appearance', file: 'params.toml', path: 'comments.provider', type: 'select', optionsFrom: 'commentProviders', label: '评论提供方', help: '可选项来自主题支持的后端；选择 disqus 时还需要 hugo.toml 的短名。' },
  { id: 'params.cookies.enabled', group: 'appearance', file: 'params.toml', path: 'cookies.enabled', type: 'boolean', label: 'Cookie 同意提示', help: '启用后分析类与功能类 Cookie 需要用户同意。' },
  { id: 'params.widgets.homepage', group: 'appearance', file: 'params.toml', path: 'widgets.homepage', type: 'widgets', label: '首页侧栏组件', help: '组件类型来自主题里存在的 widget 模板。' },
  { id: 'params.widgets.page', group: 'appearance', file: 'params.toml', path: 'widgets.page', type: 'widgets', label: '文章页侧栏组件' },

  // -- markup.toml -------------------------------------------------------------------
  { id: 'markup.goldmark.renderer.unsafe', group: 'markup', file: 'markup.toml', path: 'goldmark.renderer.unsafe', type: 'boolean', label: '允许原始 HTML', help: 'Markdown 里的 HTML 会被直接输出。' },
  { id: 'markup.goldmark.extensions.passthrough.enable', group: 'markup', file: 'markup.toml', path: 'goldmark.extensions.passthrough.enable', type: 'boolean', label: '数学公式透传' },
  { id: 'markup.tableOfContents.startLevel', group: 'markup', file: 'markup.toml', path: 'tableOfContents.startLevel', type: 'number', min: 1, max: 6, label: '目录起始层级' },
  { id: 'markup.tableOfContents.endLevel', group: 'markup', file: 'markup.toml', path: 'tableOfContents.endLevel', type: 'number', min: 1, max: 6, label: '目录结束层级' },
  { id: 'markup.tableOfContents.ordered', group: 'markup', file: 'markup.toml', path: 'tableOfContents.ordered', type: 'boolean', label: '目录使用序号' },
  { id: 'markup.highlight.noClasses', group: 'markup', file: 'markup.toml', path: 'highlight.noClasses', type: 'boolean', label: '内联高亮样式' },
  { id: 'markup.highlight.codeFences', group: 'markup', file: 'markup.toml', path: 'highlight.codeFences', type: 'boolean', label: '高亮围栏代码块' },
  { id: 'markup.highlight.guessSyntax', group: 'markup', file: 'markup.toml', path: 'highlight.guessSyntax', type: 'boolean', label: '自动猜测语言' },
  { id: 'markup.highlight.lineNos', group: 'markup', file: 'markup.toml', path: 'highlight.lineNos', type: 'boolean', label: '显示行号' },
  { id: 'markup.highlight.lineNoStart', group: 'markup', file: 'markup.toml', path: 'highlight.lineNoStart', type: 'number', min: 0, max: 1000, label: '行号起始值' },
  { id: 'markup.highlight.lineNumbersInTable', group: 'markup', file: 'markup.toml', path: 'highlight.lineNumbersInTable', type: 'boolean', label: '行号单独成列' },
  { id: 'markup.highlight.tabWidth', group: 'markup', file: 'markup.toml', path: 'highlight.tabWidth', type: 'number', min: 1, max: 16, label: 'Tab 宽度' },

  // -- related.toml ------------------------------------------------------------------
  { id: 'related.includeNewer', group: 'related', file: 'related.toml', path: 'includeNewer', type: 'boolean', label: '包含更新的文章' },
  { id: 'related.threshold', group: 'related', file: 'related.toml', path: 'threshold', type: 'number', min: 0, max: 100, label: '相关度阈值' },
  { id: 'related.toLower', group: 'related', file: 'related.toml', path: 'toLower', type: 'boolean', label: '忽略大小写' },

  // -- structural settings -----------------------------------------------------------
  {
    id: 'menu.social',
    group: 'navigation',
    file: 'menu.toml',
    type: 'menu-list',
    arrayPath: 'social',
    label: '社交菜单',
    help: '每条对应一个 [[social]]；图标名来自主题的 icons（如 brand-github）。',
    fields: [
      { key: 'identifier', label: '标识', type: 'text', required: true },
      { key: 'name', label: '名称', type: 'text', required: true },
      { key: 'url', label: '链接', type: 'text', required: true },
      { key: 'params.icon', label: '图标', type: 'text' },
      { key: 'params.newTab', label: '新窗口打开', type: 'boolean', optional: true },
    ],
  },
  {
    id: 'languages.list',
    group: 'language',
    file: 'languages.toml',
    type: 'language-list',
    label: '语言',
    help: 'weight 决定语言切换器里的顺序；label 是显示名称，locale 用于日期与排序。',
    fields: [
      { key: 'label', label: '名称', type: 'text', required: true },
      { key: 'locale', label: '地区代码', type: 'text', required: true },
      { key: 'weight', label: '排序', type: 'number', min: 1, max: 1000, required: true },
      { key: 'title', label: '语言标题', type: 'text', optional: true },
    ],
  },
];

export const SETTINGS_BY_ID = new Map(SETTINGS.map((setting) => [setting.id, setting]));

export function settingsForGroup(groupId) {
  return SETTINGS.filter((setting) => setting.group === groupId);
}
