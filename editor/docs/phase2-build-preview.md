# Phase 2 — 构建 / 预览闭环

目标：把「编辑 → 保存 → 构建 → 预览」变成一条自动、可见、可失败而不伤及现场的通路。

## 分层

```
源 site/  ──(Hugo)──▶  editor/.build/staging  ──(仅成功时)──▶  site/public  ──▶  预览 iframe
   ▲                                                                              │
   └──────────── 轮询指纹（1500ms）检测外部改动 ────────────────────────────────┘
```

| 层 | 路径 | 说明 |
| --- | --- | --- |
| source | `/projects/site` | 唯一事实来源，工具永不重写 |
| build | `editor/.build/staging` | Hugo 在此构建，**绝不在 site/ 内** |
| output | `/projects/site/public` | **只在构建退出码为 0 后**发布 |
| backups | `editor/.backups` | 保存前副本 |
| editor | `editor/dist` | UI 产物，挂在 `/editor/` |

## 模块

| 文件 | 职责 |
| --- | --- |
| `src/build/command.js` | 调起 hugo：参数、超时、输出上限 |
| `src/build/buildErrors.js` | 解析 Hugo 诊断（真实格式 `"path:line:col"`，行列在引号内） |
| `src/build/publisher.js` | staging → 发布目录；拒绝写到 site/ 之外或 site 根 |
| `src/build/buildService.js` | 状态机、单飞、去抖、仅成功才发布 |
| `src/build/watcher.js` | 轮询指纹（保证）+ fs.watch（加速）+ 忽略/静默/吸收 |
| `src/build/index.js` | 导出 |
| `server/index.js` | `/api/build`、`/api/build/status`、`/api/build/auto`，`/api/site` 报告分层与监听状态 |
| `web/components/BuildBar.vue` | 构建状态、耗时、产物大小、手动构建、日志开关 |
| `web/components/PreviewPane.vue` | 预览 iframe，按 generation 自动刷新 |

## 关键设计决定与代价

### 1. 先 staging 再发布 —— 用一次复制换「失败构建绝不污染预览」
Hugo 第一个错误就中止，且会把已产出的部分文件留在目标目录里（实测：坏 shortcode 只留下
`public/fonts`）。因此 Hugo 写到 staging，只有退出码为 0 才发布，`generation` 只在成功时递增。
代价：每次构建多一次全量复制。

### 2. 监听必须是轮询 —— 因为本机文件系统不支持 inotify
`/projects` 是 **v9fs(9p)** 挂载，`fs.watch` 在那里**完全收不到事件**，连单层非递归都不行；
`/tmp` 是 overlayfs，工作正常。这导致最初的实现（纯 `fs.watch`）在单元测试里全绿、在真实站点上
静默失效。

现在：轮询指纹为**保证**（默认 1500ms，签名 `mtime:size`，实测 v9fs 的 mtime 有亚秒精度），
`fs.watch` 仅在可用时作为加速；`probeNativeWatch()` 用编辑器自己拥有的目录做写入探测，
`/api/site` 以 `watch.nativeWatchSupported` 如实上报当前挂载能否收到事件。

代价：外部改动最多延迟一个轮询周期被发现（编辑器内的保存是立即触发，不走轮询）。

### 3. 忽略生成物 + 静默窗口「延后而非丢弃」 + 吸收自身写入
Hugo 每次构建都会写 `assets/jsconfig.json`、`resources/_gen/**`、`.hugo_build.lock`，必须忽略，
否则会自激循环。构建后的静默窗口**延后**事件而不是丢弃，所以窗口内的真实编辑不会丢。

一个只有跑真实闭环才会暴露的缺陷：**保存会让 watcher 把自己造成的改动当成外部变更**，
于是一次保存触发两次构建（实测 generation 每次 +2，白烧约 8 秒）。修法是 `watcher.absorb(paths)`：
保存成功后同步告诉 watcher「这个改动是我的」。修复后每次保存 generation 恰好 +1。

### 4. 发布耗时（实测，v9fs 特有）
```
Hugo 构建        约 10.2s
发布 474 文件     约 16s   （≈2s/MB；mkdir 缓存后从 20.6s 降到 16.1s，-22%）
一次保存总计      约 25-27s
```
已经做掉的零风险优化：发布时按目录缓存 `mkdirSync`，省掉 474 次冗余系统调用。

**尚未做、需要明确权衡的优化**：把发布从「逐文件复制」改成「删除旧目录 + 目录 rename」
（同文件系统下是 O(1)），预计把发布压到约 2s。没做的原因：(a) 它会在删除与 rename 之间
留出一个发布目录短暂不存在的窗口；(b) 它要求 staging 与发布目录必须同一文件系统，需
EXDEV 回退；(c) 它改动的正是「绝不让预览被破坏」这个不变量的实现。在正常文件系统上这次
复制只要几十毫秒，所以这是本沙箱环境的问题，应当作为独立改动单独评审。

## 验收

`scripts/acceptance.mjs` 在**真实站点**上跑，T1–T9：

- T1–T4  Phase 1 无损性（往返逐字节一致、空操作零写入、越界写入被拒、全树哈希不变）
- T5      隔离：编辑器产物、`.build`、`.backups` 都在 `site/` 之外
- T6      原生 Hugo 仍能构建
- T7      经 BuildService 的完整闭环，产出 474 文件 / 183 个 HTML 页面
- T8      **失败构建不发布**：坏 shortcode 时错误被定位到文件、输出目录原封不动、generation 不前进
- T9      构建后整个 Hugo 源树（454 个文件）逐字节未变，唯一豁免 `assets/jsconfig.json`

端到端闭环另有一轮真实写入验证（编辑 → 保存 → 构建 → 预览页里能看到改动 → 还原 → 预览回退），
结束后 content 树 SHA 与基线 `ab2ea7db9b47ecc7` 完全一致。
