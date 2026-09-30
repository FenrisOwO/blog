# 站点编辑功能可行性分析

对象：`/projects/site`（Hugo Theme Stack 4.0.3，4 语言，默认 zh）
方法：**先浏览实际网页**（首页 / 文章页 / 友链页 / 关于页），再回溯到数据源与主题模板，逐项判定可行性。
结论日期：2026-09-29

---

## 0. 一句话结论

你列的这些功能**技术上都能做**，但它们和 P1 做的"改文章"不是同一类东西：
P1 是**编辑一份 Markdown**，而你列的多数是**改站点设置**（TOML 配置）、**改页面**（另外几种 Markdown）、**换图片**（二进制）。

真正的工作量不在"写 UI"，而在三件新能力上：

1. **写范围模型要重做** —— 现在是"只准写 `content/post/**` 的 `.md`"，必须升级成"按功能分级授权"
2. **需要无损 TOML 编辑器** —— 站点名称/简介/页脚/侧边栏都在 `config/*.toml`，带注释和嵌套表
3. **需要二进制资源管线** —— 头像/封面/友链图标是图片文件，要能上传 + 原子替换 + 回滚

另外有一个**必须先补的短板**：现在编辑文章后，Hugo 预览页（`/`）读的是静态产物 `site/public`，**不会自动重建**，所以改完看不到效果。这个"构建/预览闭环"应该排在前面。

---

## 1. 浏览网页发现的可编辑面（完整清单）

### 1.1 全局（每个页面都有）

| # | 界面元素 | 数据源 | 类型 |
|---|---|---|---|
| 1 | 侧边栏头像 | `site/assets/img/avatar.png` | 图片 |
| 2 | 头像角标 emoji ✏️ | `config/_default/params.toml` → `[sidebar] emoji` | TOML |
| 3 | **站点名称**（头像下 H1） | `config/_default/languages.toml` → `[zh] title`（每语言一份） | TOML |
| 4 | **站点简介**（名称下 H2） | `config/_default/languages.toml` → `[zh.params.sidebar] subtitle`（每语言一份） | TOML |
| 5 | 顶部导航菜单（主页/关于/归档/搜索/链接 + 图标） | 各内容文件的 `menu.main{name,weight,params.icon}` | Front Matter |
| 6 | 社交图标（GitHub / Twitter） | `config/_default/menu.toml` → `[[social]]` | TOML |
| 7 | 语言切换器（4 语言） | `config/_default/languages.toml` | TOML |
| 8 | 暗色模式开关 | `params.toml` → `[colorScheme] toggle/default` | TOML |
| 9 | 页脚版权 `© 2020 - 2026 …` | `params.toml` → `[footer] since`；名称取 `Site.Title`，可用 `copyright` 覆盖 | TOML |
| 10 | 页脚自定义文字 | `params.toml` → `[footer] customText`（当前为空） | TOML |
| 11 | 页脚主题署名 Hugo/Stack/Jimmy | **主题模板里写死**，只有 i18n 能改 | 模板 |
| 12 | 页脚字体署名 + 许可链接 | **站点自己的覆盖文件** `site/layouts/_partials/footer/footer.html`（HTML） | 模板 |

> ⚠️ **坑**：`params.toml` 里的 `[sidebar] subtitle = "Lorem ipsum…"` 是**死的**。
> 4 个语言在 `languages.toml` 里各自覆盖了 subtitle，所以这个全局值永远不会出现在页面上。
> 一个"天真实现"的设置界面如果去写 `params.toml` 的 subtitle，用户会以为坏了。**必须写 `languages.toml`。**

### 1.2 首页

| # | 界面元素 | 数据源 |
|---|---|---|
| 13 | 侧边栏组件与顺序（搜索/归档/分类/标签云） | `params.toml` → `[widgets] homepage` |
| 14 | 文章卡片（标题/描述/封面/日期/阅读时长/分类/翻译链接） | 各文章 front matter |
| 15 | 分页条（1、2…） | `hugo.toml` → `[pagination] pagerSize = 3` |
| 16 | 首页菜单项（名称/权重/图标） | `content/_index*.md` |

### 1.3 文章页

| # | 界面元素 | 数据源 |
|---|---|---|
| 17 | 标题 / **副标题(description)** / 日期 / 阅读时长 | front matter（`readingTime` 可覆盖） |
| 18 | 分类、标签 | front matter `categories` / `tags` |
| 19 | 封面图 | front matter `image` |
| 20 | 目录 TOC | front matter `toc` + `params.toml [article] toc` |
| 21 | 翻译链接（English/正體中文/日本語） | 同目录的兄弟语言文件 |
| 22 | 许可协议 | `params.toml [article.license]` + 页级 `license` |
| 23 | 相关文章（自动） | `related.toml` 权重配置 |
| 24 | 评论区（Disqus） | `params.toml [comments]` |

### 1.4 页面类

| # | 界面元素 | 数据源 |
|---|---|---|
| 25 | **关于页正文** | `content/page/about/index*.md`（4 语言） |
| 26 | **友链页卡片** | `content/page/links/index*.md` → `links:` **数组**（title/description/website/image） |
| 27 | 归档页 | `content/page/archives/index*.md` + 文章日期 |
| 28 | 搜索页 | `content/page/search/index*.md` → `outputs: [html, json]` |
| 29 | 分类页（标题/描述/封面/配色） | `content/categories/<名>/_index*.md` → `title/description/image/style` |
| 30 | 标签页 | **没有对应目录，纯自动生成**；想加描述/配色需新建 `content/tags/<tag>/_index*.md` |

### 1.5 图片类（二进制）

| # | 用途 | 位置 |
|---|---|---|
| 31 | 头像 | `site/assets/img/avatar.png`（当前仅 373 B，是占位图） |
| 32 | 分类封面 | `content/categories/Documentation/*.jpg`（bundle 资源） |
| 33 | 文章封面 | page bundle 或 `assets/img/` |
| 34 | 友链图标 | bundle 内文件（如 `ts-logo-128.jpg`）或外链 |

---

## 2. 可行性分级

### 档 1 — 现有架构稍扩写范围即可（不需要新引擎）✅

| 功能 | 目标文件 | 只差什么 |
|---|---|---|
| **更改文章年份/日期** | `content/post/**/*.md` | **什么都不差**，已在写范围内 |
| 文章描述、封面、许可、评论开关 | `content/post/**/*.md` | 同上 |
| **标签功能**（改名/删除/新增） | `content/post/**/*.md` | ⚠️ 差**多文件事务**（见 §3.1） |
| **关于页**正文 | `content/page/about/index*.md` | 扩写范围到 `content/page/**` |
| **友链页** | `content/page/links/index*.md` | 扩写范围 + **YAML 数组级改写**（见 §3.2） |
| 首页菜单项 | `content/_index*.md` | 扩写范围到 `content/*.md` |
| 分类页元数据（描述/配色/封面字段） | `content/categories/*/_index*.md` | 扩写范围（本身已是 front matter） |
| 归档页、搜索页 | `content/page/*/index*.md` | 扩写范围 |

> 这一档全部是"Markdown + Front Matter"，能**完整复用** P1 的 FrontMatterEngine、SafeWriter、备份与 no-op 保证。这是性价比最高的一档。

### 档 2 — 需要新能力：无损 TOML 配置编辑 ⚠️

涉及：站点名称、站点简介、头像路径、emoji、页脚（版权起始年/自定义文字）、侧边栏组件、社交图标、评论 provider、语言列表。

`config/_default/*.toml` 的特点决定了不能"简单解析再写回"：

- 有**注释**（`# ...`），且注释是给人看的说明，不能丢
- 有**嵌套表** `[a.b.c]` 与**内联表** `{ type = "search" }`
- 有**数组表** `[[social]]`
- 键的**顺序**被人工组织过

所以需要一个和 FrontMatterEngine 对等的 **"无损 TOML 最小改写引擎"**：只改目标键的值，其余逐字节保留。

**同时必须处理 Hugo 的合并语义**：`.Site.Params` 是"站点级 + 语言级"多层合并，语言级优先。写错层 = 看起来没生效（§1.1 的 subtitle 就是活例子）。UI 上应该明确"改的是哪个语言"。

### 档 3 — 需要新能力：二进制资源管线 ⚠️

涉及：头像、分类封面、文章封面、友链图标。

需要：上传 → 类型/尺寸校验 → 原子替换 → 备份 → 回滚。二进制没有"no-op 逐字节一致"的自然表述，改成"**哈希一致即不动**"的等价保证。

另外主题会对图片做多尺寸处理（800/1600/2400）与缩略图，替换头像后可能还要提醒"下次构建才生效"。

### 档 4 — 不建议做（高风险 / 低收益）⛔

| 功能 | 原因 |
|---|---|
| 改页脚主题署名（Hugo/Stack/Jimmy） | 主题模板写死；改主题 = 后续升级困难 |
| 改页脚字体署名 | 在站点覆盖的 HTML 模板里，且**带 SIL OFL 1.1 法律义务**（注释里写明了必须附带许可声明）。删了有法律风险 |
| 让编辑器直接编辑 `layouts/**` 模板 | 等于把编辑器变成代码编辑器，风险远大于收益 |

**正解**：主题预留了 4 个空扩展点，站点可以安全注入内容而不覆盖主题文件——
`layouts/_partials/footer/custom.html`、`head/custom.html`、`head/style.html`、`head/script.html`。
编辑器要"加东西"时只往这些文件里追加，不碰主题、不碰已有覆盖文件。

---

## 3. 必须一起解决的架构问题

### 3.1 多文件事务（标签功能的真正难点）

实测本站在用 14 个标签，其中：

- `pagination` → **12 个文件**
- `test` → **12 个文件**
- `Gallery` / `Photoswipe` → 各 4 个文件

所以"把一个标签改名"= 一次改 12 个文件。必须：

- 要么全部成功、要么全部回滚（不能改一半）
- 每个文件各自备份，回滚时按序还原
- 每个文件仍要满足"除目标字段外逐字节不变"
- UI 要让用户看到"这会改动 12 个文件"再确认

现有 SafeWriter 是单文件语义，需要扩展出**事务/批量**能力。

### 3.2 结构化数组改写（友链页的真正难点）

友链的 `links:` 是 YAML 数组，元素还是嵌套映射：

```yaml
links:
  - title: GitHub
    description: GitHub 是世界上最大的软件开发平台。
    website: https://github.com
    image: https://…
```

P1 的 FrontMatterEngine 目前只做**标量键的最小改写**（`managedKeys` 那套）。要对数组做增/删/改/排序，需要：

- 能定位到"第 N 个数组元素"
- 新增元素时按站点既有缩进风格生成（2 空格缩进 + `- ` 前缀）
- 删除元素时不留下空行/错位
- 仍然保持其余部分逐字节不变

这是**新引擎能力**，不是简单扩白名单。

### 3.3 多语言联动

站点名称、简介、关于页、友链页 —— 每一项都有 **4 份语言文件**。

UI 必须回答："我改的是简体中文，还是全部语言？"
一旦选"全部"，就又回到多文件事务（§3.1）。

### 3.4 改配置后必须重建才生效

改了 `params.toml` / `languages.toml` / `menu.toml` 后，Hugo 必须重新构建。

现在的状况：编辑器保存 `.md` 后，Hugo 预览（`/`）读的是静态产物 `site/public`，**不会自动更新** —— 也就是说 P1.5 保存成功后，用户在预览页其实**看不到变化**。

所以"构建/预览闭环"（原本排在 P3）**应该提前**，否则后面每个功能都会给人"改了没反应"的感觉。

### 3.5 写范围模型需要重做

现在的模型是单一白名单：`.md` + `content/post/**`。

应升级为**能力分级授权**：

| 档 | 路径 | 文件类型 | 风险 |
|---|---|---|---|
| A | `content/post/**` | `.md` | 低（已验证） |
| B | `content/page/**`、`content/categories/**`、`content/_index*.md` | `.md` | 低 |
| C | `config/_default/*.toml` | `.toml` | **中高**（影响全站） |
| D | `site/assets/**`、bundle 资源 | 图片 | 中（二进制） |
| E | `site/layouts/**` | `.html` | **高**（默认禁止，仅在扩展点追加） |

每一档都要继续走同一个 `SafeWriter`：备份 → 原子写 → 读回校验；并且 no-op 保证要**平移到 TOML 和二进制**上。

---

## 4. 建议的落地顺序（按依赖关系）

| 顺序 | 内容 | 理由 |
|---|---|---|
| 0 | **构建/预览闭环**（改完自动重建 + 显示构建错误） | 没有它，后面所有功能都"看不到效果" |
| 1 | **文章字段表单**（原 P2）+ **多文件事务**基础 | 拿到"结构化字段编辑 + 批量写"，后面都要用 |
| 2 | **页面类 Markdown**：关于页、首页、分类页（扩写范围） | 复用现有引擎，成本最低 |
| 3 | **友链页**（数组改写引擎） | 需要新引擎，但独立性强 |
| 4 | **标签管理**（跨文件改名/合并/清理） | 依赖第 1 步的事务能力 |
| 5 | **图片资源**：头像、封面（二进制管线） | 需要新能力 |
| 6 | **站点设置面板**：名称/简介/页脚/侧边栏/社交（TOML 引擎） | 最难，影响面最大，放最后 |

---

## 5. 风险提示（写在前面）

1. **改配置影响全站**：一个 TOML 写错会让 183 个页面全崩。必须"先 dry-run 构建校验、再落盘"，或者落了盘也能一键回滚。
2. **`params.toml` vs `languages.toml` 的覆盖关系**：不看这一层就会做出"能改但没效果"的功能。
3. **页脚字体署名有法律义务**：SIL OFL 要求随字体附带许可声明。编辑器不应该提供"删除署名"的按钮。
4. **多语言默认行为**：建议默认只改当前语言，改全部语言必须显式勾选并二次确认。
5. **`site/` 不在 git 里**：`/projects` 仓库中 `site/` 是未跟踪目录，出事没有版本历史兜底，**备份是唯一退路**。

---

*本分析基于实际浏览站点 + 主题模板与配置的逐项核对，未修改 `site/` 任何内容。*
