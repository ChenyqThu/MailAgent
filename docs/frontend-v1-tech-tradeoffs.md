# Frontend V1 Tech Tradeoffs

> **目的**: V1 Electron 前端每个技术选型的替代方案 + trade-off + 评分，方便 review
> 决定是否替换。
>
> **状态**: 设计稿（2026-05-16）— pending user review。
>
> **作者**: 与 [`frontend-v1-implementation-plan.md`](./frontend-v1-implementation-plan.md)
> §1 技术选型表格配套。每个选项给出 ✅ 默认推荐 / ⚠️ 备选 / ❌ 排除 + 简短理由。

---

## 0. 评分原则

| 维度 | 权重 | 含义 |
|---|---|---|
| 学习成本 | ★ | 团队 / 我熟悉度 |
| 性能 | ★★★ | Electron + 6000+ 邮件场景 |
| 生态 / 维护性 | ★★ | 包活跃度 + 社区 + 文档 |
| 与后端契约 | ★★★ | 与 CLI / SQLite / schema 契合 |
| 部署 / 打包 | ★ | electron-builder 友好度 |

---

## 1. 桌面壳

| 选项 | 学习 | 性能 | 生态 | 部署 | 评分 |
|---|---|---|---|---|---|
| ✅ **Electron** | 低 | 中（Chromium 内存大）| 极好 | 极好 | **8.5** |
| ⚠️ Tauri 2 | 中 (Rust) | 高（系统 WebView）| 中 | 中 | 7.0 |
| ❌ Pure web (PWA) | 极低 | 中 | 极好 | 受限（无文件系统访问）| 4.0 |
| ❌ Qt + PyQt | 高 | 高 | 中 | 差 | 4.0 |

**推荐 Electron**：
- 与现有 typescript + Node 生态对齐
- Mac 用户首选 (.dmg 装即用)
- Tauri 性能更好但 Rust 学习成本 + 包生态不如 Electron 厚

**何时考虑替换**: 内存占用成为问题 (>1GB)，或者想发布 mobile（Tauri 计划支持）。

---

## 2. 渲染框架

| 选项 | 学习 | 性能 | 生态 | 适配 SQLite | 评分 |
|---|---|---|---|---|---|
| ✅ **React + TypeScript** | 中 | 高 | 极好 | 极好（hooks pattern） | **8.5** |
| ⚠️ Vue 3 + TS | 低 | 高 | 好 | 好 | 7.5 |
| ⚠️ Svelte 5 | 中 | 极高 | 中 | 中 | 7.0 |
| ⚠️ Solid | 高 | 极高 | 小 | 中 | 6.5 |
| ❌ Vanilla JS | 极低 | 高 | - | - | 4.0（不适合中等复杂度 app）|

**推荐 React**：
- 团队 / 我最熟悉（gmail / openai 等大 web app 都 React）
- TanStack Query / Router / Table 生态最全
- shadcn/ui 是 React 优先

**何时考虑替换**: Vue 3 + composition API 也是好选；Svelte 5 性能极致但生态相对小。

---

## 3. 状态管理

| 选项 | 学习 | 复杂度 | 适配 SQLite SSoT | 评分 |
|---|---|---|---|---|
| ✅ **Zustand** | 极低 | 低 | 好（store 只缓存 metadata） | **8.5** |
| ⚠️ Jotai | 低 | 低 | 好（atom 细粒度） | 8.0 |
| ⚠️ Redux Toolkit | 中 | 中 | 中（boilerplate）| 6.5 |
| ❌ MobX | 中 | 中 | 中 | 5.5 |

**推荐 Zustand**：
- SQLite 是 SSoT，前端 state 只需要 UI state (active mailbox / search query / 主题)
- Zustand 5 行起手，无需 reducer / action / dispatch boilerplate

**TanStack Query 与 Zustand 分工**:
- TanStack Query: 服务端数据缓存 (邮件列表 / 详情 / 搜索结果) + 轮询 + invalidation
- Zustand: 纯 UI state (selected mailbox / sidebar open / theme)

---

## 4. 路由

| 选项 | 学习 | 类型安全 | 生态 | 评分 |
|---|---|---|---|---|
| ✅ **TanStack Router** | 中 | ⭐⭐⭐ | 中 | **8.5** |
| ⚠️ React Router v6 | 低 | ⭐⭐ | 极好 | 7.5 |
| ⚠️ Wouter | 极低 | ⭐ | 小 | 7.0 |
| ❌ Next.js App Router | 中 | ⭐⭐⭐ | 极好 | 5.0（Electron 用 Next 过重）|

**推荐 TanStack Router**：
- 与 TanStack Query 配套（同 author）
- 路由参数 + 搜索参数全类型化
- Search-state-as-source-of-truth（filter 在 URL 里）

**备选 React Router**：如果用户更熟 React Router，可降到 v6.x（loader 模式接 IPC 也好用）。

---

## 5. CSS / UI

| 选项 | 学习 | 设计自由度 | 生态 | 评分 |
|---|---|---|---|---|
| ✅ **Tailwind + shadcn/ui** | 中 | 极高 | 极好 | **9.0** |
| ⚠️ Tailwind + Headless UI / Radix | 中 | 极高 | 好 | 8.5 |
| ⚠️ Mantine | 低 | 中 | 好 | 7.5 |
| ⚠️ Ant Design | 低 | 中 | 极好 | 7.0（设计风格偏 enterprise）|
| ❌ Material UI | 中 | 中 | 极好 | 6.5（设计风格不适合邮件 app）|
| ❌ Bootstrap | 低 | 低 | 好 | 5.0 |

**推荐 Tailwind + shadcn/ui**：
- shadcn 是"复制粘贴"模式，源码完全可控；不强依赖某 npm 包
- Tailwind 与项目其他 web 一致（dashboard.html 风格）
- 配色 / 字号 / spacing 自由度高

**为什么不用 Ant Design**：邮件 app 需要紧凑 + 现代风格（参考 Mimestream / Spark），AntD 太"管理后台"。

---

## 6. 邮件 HTML 渲染（关键安全决策）

| 选项 | 安全 | 渲染保真 | 性能 | 评分 |
|---|---|---|---|---|
| ✅ **sandboxed iframe + srcdoc + DOMPurify** | ⭐⭐⭐ | ⭐⭐⭐ | 中 | **9.0** |
| ⚠️ shadow DOM + DOMPurify | ⭐⭐ | ⭐⭐ | 高 | 7.0 |
| ❌ dangerouslySetInnerHTML + DOMPurify | ⭐ | ⭐⭐⭐ | 高 | 4.0（XSS 风险高）|
| ❌ 渲染 markdown only | ⭐⭐⭐ | ⭐ | 高 | 5.0（丢格式 + 图）|

**强烈推荐 sandboxed iframe**：
- `<iframe srcdoc="..." sandbox="allow-same-origin">` 完全隔离
- DOMPurify 二次清洗（防 SVG/iframe-in-iframe 等绕过）
- 阻止 `target="_blank"` 跳出（前端拦截 + 显示外链确认 dialog）
- 自动 link 检测 (mailto / http / https) → 转 Electron `shell.openExternal`

**性能注意**: 每次切换邮件 iframe 重建 ~10-20ms，可接受。

**Markdown 备选 view**:
- 复用 `email_body.body_markdown`（已是 markdownify 产物）+ react-markdown
- UI toggle: HTML / Markdown / Raw 3 mode

---

## 7. 数据层

### 7.1 SQLite 驱动

| 选项 | 性能 | API | 评分 |
|---|---|---|---|
| ✅ **better-sqlite3** | ⭐⭐⭐ | 同步 | **9.5** |
| ⚠️ node-sqlite3 | ⭐⭐ | 异步 | 6.0 |
| ❌ Drizzle ORM / Prisma | ⭐⭐ | ORM 抽象 | 5.0（不需要 ORM）|

**推荐 better-sqlite3**：
- 同步 API（main 进程跑，不阻塞 renderer）
- 性能比 node-sqlite3 快 ~10x（C++ native binding）
- 支持 FTS5 / WAL 模式 / prepare statement

**关键配置**:
```typescript
const db = new Database(path, { readonly: true, fileMustExist: true });
db.pragma('journal_mode = WAL');     // 与 mail-sync 共存
db.pragma('busy_timeout = 5000');    // 写竞争时等 5s
db.prepare('...').all();             // prepared statement 缓存
```

### 7.2 ORM 抽象

| 选项 | 评分 |
|---|---|
| ✅ **手写 query + TS interface** | **9.0** |
| ⚠️ Kysely (query builder) | 7.0 |
| ❌ Drizzle ORM | 5.0 |
| ❌ Prisma | 4.0（Electron 部署复杂）|

**推荐手写**：EmailRepository python 接口已稳定，TS 这边照搬就行；ORM 抽象层在
schema 稳定 + 简单查询场景下是 dead weight。

### 7.3 类型生成

| 选项 | 评分 |
|---|---|
| ✅ **手写 TS interface** | **7.5**（45+ schema 但稳定）|
| ⚠️ json-schema-to-typescript | 7.0（要 build pipeline）|
| ❌ tRPC | 5.0（前后端跨进程模型不匹配）|

**推荐手写**：CLI schema 稳定，手写 ~200 行 TS 全覆盖。json-schema-to-typescript
适合 schema 频繁变；当前 PR-5 已冻结 contract。

---

## 8. CLI fork

| 选项 | API | 错误处理 | 评分 |
|---|---|---|---|
| ✅ **execa** | promise + stream | ⭐⭐⭐ | **9.0** |
| ⚠️ Node child_process | callback / event | ⭐⭐ | 7.0 |
| ❌ shelljs | bash-like | ⭐ | 5.0（不适合长任务）|

**推荐 execa**：
- promise + stdin/stdout/stderr 流处理
- 自动 cleanup（spawned process 在 main quit 时杀掉）
- timeout / kill signal 控制

**典型使用**:
```typescript
const subprocess = execa('mailagent', ['-o', 'json', ...args, '--api-key', key]);
subprocess.stdout.on('data', chunk => mainWindow.webContents.send('cli:log', chunk));
const { stdout } = await subprocess;
return JSON.parse(stdout);
```

---

## 9. 鉴权 / Keychain

| 选项 | macOS | 跨平台 | 评分 |
|---|---|---|---|
| ✅ **keytar** | ✅ Keychain | ✅ | **9.0** |
| ⚠️ safeStorage (Electron 自带) | ✅ | ✅ | 7.0（无 manual rotate）|
| ❌ 配置文件明文 | ❌ | ❌ | 2.0 |
| ❌ encrypted JSON (electron-store + crypto) | ⭐⭐ | ✅ | 5.0 |

**推荐 keytar**：
- macOS 原生 Keychain 集成，用户能在 Keychain Access.app 看到 / 撤销
- 跨平台（Linux gnome-keyring / Windows Credential Vault）
- npm 包稳定 7+ 年

---

## 10. 构建 / 打包

| 选项 | 性能 | HMR | 评分 |
|---|---|---|---|
| ✅ **Vite + electron-vite** | ⭐⭐⭐ | ⭐⭐⭐ | **9.5** |
| ⚠️ Webpack + electron-forge | ⭐⭐ | ⭐⭐ | 6.0 |
| ❌ Rollup 直接 | ⭐⭐ | ⭐ | 5.0 |

**推荐 electron-vite**：
- Vite 6 主进程 + renderer 同 monorepo
- HMR 秒级反馈
- TypeScript 原生

---

## 11. 打包发布

| 选项 | macOS dmg | 自动更新 | 评分 |
|---|---|---|---|
| ✅ **electron-builder + GitHub Releases** | ✅ | ✅ (electron-updater) | **9.0** |
| ⚠️ electron-forge | ✅ | ✅ | 7.0 |
| ❌ pkg / nexe | ❌ | ❌ | 3.0 |

**推荐 electron-builder**：
- macOS .dmg / .pkg / 公证
- 内部用 ad-hoc 签名即可（用户首次打开 ctrl+click → 信任）；公开发布要 Apple Developer 证书（$99/年）
- auto-update via GitHub Releases (electron-updater 包)

**用户场景**: 内部用 + GitHub Releases 发布 → 用 ad-hoc 签名 + auto-updater 就够。

---

## 12. 测试

| 层 | 工具 | 评分 |
|---|---|---|
| Unit (renderer) | **Vitest + React Testing Library** | 9.0 |
| Unit (main IPC) | **Vitest + better-sqlite3 fixture** | 9.0 |
| E2E | **Playwright + Electron** | 8.5 |
| Visual regression | Storybook + Chromatic (V2) | 6.0 |

---

## 13. Review 决策清单

请逐条确认 / 修改：

- [ ] **§1 桌面壳**: Electron 还是 Tauri 2?
- [ ] **§2 渲染框架**: React 还是 Vue 3 / Svelte 5?
- [ ] **§3 状态管理**: Zustand 还是 Jotai / Redux Toolkit?
- [ ] **§4 路由**: TanStack Router 还是 React Router v6?
- [ ] **§5 CSS**: Tailwind + shadcn/ui 还是 Mantine / Ant Design?
- [ ] **§6 邮件 HTML 渲染**: sandboxed iframe（强烈推荐）还是其他?
- [ ] **§7 数据层**: better-sqlite3 + 手写 query + 手写 TS interface 三件套?
- [ ] **§8 CLI fork**: execa?
- [ ] **§9 Keychain**: keytar?
- [ ] **§10 构建**: electron-vite?
- [ ] **§11 打包**: electron-builder + GitHub Releases?
- [ ] **§12 测试**: Vitest + Playwright?
- [ ] **整体节奏**: 一次性定 stack 还是 Sprint 0 时再调整?

---

## 14. 我不熟悉的事 / 需要预研

- macOS .dmg ad-hoc 签名流程（vs 公证）
- better-sqlite3 在 Electron 多平台 binary 是否需要 electron-rebuild
- TanStack Router 与 Electron BrowserWindow 多窗口配合（V2 多窗口时考虑）
- electron-updater + GitHub private repo 配置

这些都是 Sprint 0 / Sprint 6 时再 PoC，不阻塞架构决策。

---

> 本文档与 [`frontend-v1-feature-spec.md`](./frontend-v1-feature-spec.md) 配套
> review；决策完了起 prd.json 进 Sprint 0 实施。
