# Phase 3 — 内容管理

目标：把 Phase 1/2 的「一份文档、一个目录」扩展成对**整棵内容树**的管理——浏览、新建、表单编辑、删除、恢复，同时不放松前两个阶段的任何一条约束（显式写入、空操作逐字节一致、失败构建不发布、源树不被构建改动）。

## 作用域

写入范围由一串 section 声明，从 `server/index.js` 传给 `PathGuard`：

```
sections: ['post', 'page', 'categories', '']
                                         ↑ '' = content 根目录，必须排在最后
```

`''` 排在最后有两个原因：总览按声明顺序分组展示，根目录天然是"其余全部"；`PathGuard` 只认字符串前缀，把根目录放在前面会让后续所有更窄的规则失去意义。

| 层 | 路径 | 说明 |
| --- | --- | --- |
| source | `/projects/site/content` | 唯一事实来源 |
| backups | `/projects/editor/.backups` | 保存前副本（SafeWriter） |
| trash | `/projects/editor/.backups/trash` | 删除的文档 + `manifest.json` |
| build/output | 同 Phase 2 | 每次写入仍然走同一条构建—预览闭环 |

## 接口

| 方法 | 路径 | 写入 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/documents` | 否 | 总览：`count` / `documents` / `sections` / `groups` / `warnings` |
| GET | `/api/documents/raw?path=` | 否 | 原文 |
| GET | `/api/documents/fields?path=` | 否 | 表单描述（含只读字段与引擎给出的原因） |
| POST | `/api/documents/fields/preview` | 否 | `{path, set, remove}` 的 dry-run diff |
| POST | `/api/documents/fields/save` | 是 | 同上 + `confirm: true` |
| POST | `/api/documents/create` | 计划否 / 确认 | 缺 `confirm` 返回计划，带 `confirm` 才落盘 |
| POST | `/api/documents/delete` | 计划否 / 确认 | `scope: 'bundle' \| 'file'`，移动而非销毁 |
| GET | `/api/trash` | 否 | `{entries}` |
| POST | `/api/trash/restore` | 是 | `{id, confirm}` |

## 关键设计决定与代价

### 1. 删除是"移动"而不是"销毁"
`removeDocument` 把文件搬进 `.backups/trash/<id>/files/<relPath>`（同盘 `rename`，无复制开销），并写一份 `manifest.json`：`{id, relPath, kind, files, bytes, deletedAt, restoredAt}`。
**注意 `files`/`bytes` 是计数，不是列表**——UI 只能显示"几个文件、多大"，不能指望逐文件清单。
恢复走 `restoreFromTrash`：`restoredAt` 挡住重复恢复，`manifest.relPath` 再做一次越界检查，然后重新过 `PathGuard`。代价：回收站会一直长大，目前没有清理策略。

### 2. 表单是"请求"，不是编辑器
`describeFields` 只把引擎能无损重写的字段标为 `editable`；嵌套映射、无法安全表示的标量一律 `editable: false`，并给出引擎自己的原因（例如"值是嵌套映射，请在原文中编辑"）。表单**只提交 front matter**，正文与缩进永远不会被重排——这条在验收里是逐字节断言的。

### 3. 空输入 = 不修改
用户在日期框里删光内容，会得到 `lastmod: ""`，而 Hugo 无法把空字符串解析成日期——一次手滑就能让构建失败。因此空白输入**不提交**；要删字段用该行右侧显式的 ✕。空列表同理（`tags:` 底下什么都没有不是列表）。
这条规则决定"是否发生写入"，所以放在 `web/fieldDrafts.js`（纯 ESM，不依赖 Vue），用 `node --test` 直接测，而不是靠点界面。

### 4. 新建只落在声明的目录里
`createSections: ['post', 'page']`；kind 支持 `leaf-bundle` / `branch-bundle` / `standalone`，按语言后缀（`index.en.md` / `_index.zh-hant-tw.md` / `slug.en.md`）拼路径。新文档一律 `draft: true`——避免"刚建就上线"。同名冲突在计划阶段就报出来，确认时直接抛错。

## 验收

* `node --test`：153 项（含 `test/fieldForm.test.js` 用真实文档描述 + 真实 `applyFieldEdits` 验证表单规则）。
* `node scripts/acceptance.mjs`：T1..T9（Phase 1/2，跑在真实站点上）+ **T10**（Phase 3）。
  T10 在 `content/` 的**副本**上执行新建 / 表单编辑 / 删除 / 恢复，然后重新哈希真实 content 树，断言零变化——即"整套内容管理只动它该动的地方"。
* UI 侧没有 jsdom/vitest，所以 `.vue` 里尽量不放判断逻辑；界面靠 `npm run build:web` + 接口级测试保障。
