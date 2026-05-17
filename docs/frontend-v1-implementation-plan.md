# Frontend V1 Implementation Plan

> **目的**: MailAgent 第一版 Electron 前端的技术选型 + 任务拆分。
>
> **基础**: 用户已在 [`frontend-integration-spec.md`](./frontend-integration-spec.md) §8
> 回答 4 个核心架构问题：
> - **Q1 形态**: Electron
> - **Q2 SSoT 路径**: 直读 SQLite (读) + CLI 中转 (写)
> - **Q3 鉴权**: 单密码（`MAILAGENT_CLI_API_KEY` 现状）
> - **Q4 实时性**: 轮询
>
> **状态**: 设计稿（2026-05-16）— 等用户审批技术选型后进入任务拆分实施。

---

## 0. TL;DR

V1 是一个 **本机 Electron app**，用户在 macOS 上和 mail-sync 服务同机运行。
不需要远程部署，不需要多用户。架构最简：

```
┌─────────────────────────────────────────────────────┐
│  Electron App (main + renderer)                     │
│                                                     │
│  ┌──────────────┐    ┌────────────────────────┐    │
│  │ Renderer     │    │ Main Process           │    │
│  │ (React/Vue)  │◄──►│ - SQLite 直读 (better- │    │
│  │              │IPC │   sqlite3, ~4ms 命中)  │    │
│  │ 邮件列表 / 详情 │    │ - CLI fork (写命令)   │    │
│  │ 搜索 / 看板    │    │ - 附件文件读取        │    │
│  └──────────────┘    │ - 5-30s polling timer  │    │
│                      └────────────────────────┘    │
└─────────────────────────────────────────────────────┘
                    ↓ 同机器，零网络延迟
┌─────────────────────────────────────────────────────┐
│  本地 MailAgent backend (现有，PM2 mail-sync 进程)   │
│  - data/sync_store.db (SQLite SSoT)                 │
│  - data/attachments/{internal_id}/                  │
│  - mailagent CLI 入口                               │
└─────────────────────────────────────────────────────┘
```

预估总工作量：**~8-12 个工作日**（不含设计 + 调优）。

---

## 1. 技术选型

### 1.1 框架

| 项 | 选型 | 理由 | 备选 |
|---|---|---|---|
| 桌面壳 | **Electron** | 跨平台（macOS 优先）/ Node + Chromium / 与现有 typescript 知识对齐 | Tauri（更轻但 Rust 学习成本）/ pure web |
| 渲染层 | **React + TypeScript** | 生态最厚 / 路由 + 状态库选择多 / 用户熟悉 | Vue 3 / Svelte / Solid |
| 状态管理 | **Zustand** | 比 Redux 轻 / SQLite 数据本身就是 SSoT，前端只缓存 | Jotai / TanStack Query |
| 数据获取 | **TanStack Query** (React Query) | 自带缓存 + 轮询 + invalidation | SWR |
| 路由 | **TanStack Router** 或 **React Router** | TanStack Router 类型安全好 | wouter (轻量) |
| 样式 | **Tailwind CSS** | 与项目其他 web 一致（dashboard.html 用 Tailwind 风格）| CSS Modules / Emotion |
| 组件库 | **shadcn/ui** | 复制粘贴 / 不强依赖 / 与 Tailwind 配套 | Radix UI / Headless UI / Ant Design |
| 图标 | **Lucide React** | 与 shadcn 配套 | Heroicons |
| 构建 | **Vite + electron-vite** | Hot reload / typescript 原生 | Webpack |
| 打包 | **electron-builder** | macOS .dmg / 自动更新 | electron-forge |

### 1.2 数据层

| 项 | 选型 | 理由 |
|---|---|---|
| SQLite 驱动 | **better-sqlite3** | 同步 API / 性能最好 / Electron main 进程跑 |
| ORM | **不用** | EmailRepository 接口已稳定，包一层 TS 类型即可；用 ORM 反而冗余 |
| 类型生成 | 手写 TS interface（与 docs/cli-schema/*.json 对齐） | 45+ schema 太多自动生成会乱 |
| Migration | **不做** | 后端 mail-sync 服务管 schema migration，前端只读 |
| CLI 子进程 | **execa** | promisify child_process / typescript 友好 |

### 1.3 邮件渲染

| 项 | 选型 | 理由 |
|---|---|---|
| HTML 渲染 | **DOMPurify + sandboxed iframe** | 邮件 HTML 不可信，必须沙箱 + sanitize |
| Markdown 渲染 | **react-markdown + rehype-raw** | 支持 GFM / 代码块 / 表格 |
| Inline image | **直接渲染** `data/attachments/{id}/cid_*` 本地路径 | Electron file:// 协议 + custom protocol handler |
| 附件预览 | **PDF**: react-pdf；**Image**: img tag；**Office**: 走 `mailagent backfill derivatives` 转 PDF | docx/xlsx 已有 derived PDF/CSV |

### 1.4 鉴权 / 配置

| 项 | 方案 |
|---|---|
| API key 存储 | macOS Keychain（**keytar** 包） |
| 首次启动 | 检测 `$HOME/Library/Application Support/MailAgent/config.json` 是否含 API key；无则引导用户输入 |
| 写命令鉴权 | renderer → main IPC → main 取 keychain → `execa('mailagent', [...args, '--api-key', key])` |
| DB 路径配置 | 默认 `~/Documents/MailAgent/data/sync_store.db`，可在 settings 改 |

---

## 2. 路由结构

```
/                  → 邮件 inbox (按 mailbox + 时间 desc, 默认 50 条)
/mailbox/:name     → 单个邮箱（收件箱 / 发件箱 / ...）
/email/:id         → 邮件详情页（HTML/markdown render + 附件 list + AI 字段 + 线程视图）
/thread/:id        → 线程聚合视图（父 + 子邮件）
/search            → 全文搜索 (FTS5)
/calendar          → 日程列表（含周期会议）
/calendar/event/:id → 单个会议详情
/llm               → LLM 处理状态 + 成本 dashboard
/admin             → 健康检查 / dead-letter 队列 / backfill 进度 / v4 rollout 统计
/settings          → API key / DB 路径 / 轮询频率 / 主题
```

---

## 3. IPC 设计

Electron main ↔ renderer 走 `contextBridge`。所有 SQL/CLI 调用在 main 进程。

### 3.1 读操作（直读 SQLite）

```typescript
// renderer
const emails = await window.api.email.list({
  mailbox: '收件箱',
  status: 'synced',
  limit: 50,
  offset: 0,
  is_read: false,
});

// main process (similar to EmailRepository python interface):
ipcMain.handle('email:list', async (event, opts) => {
  const db = getDb();  // singleton better-sqlite3
  const where = buildWhereClause(opts);
  return db.prepare(`SELECT * FROM email_metadata ${where} ORDER BY date_received DESC LIMIT ? OFFSET ?`)
           .all(...where.params, opts.limit, opts.offset);
});
```

### 3.2 写操作（CLI fork）

```typescript
// renderer
const result = await window.api.email.resync(internalId, { replaceExisting: true });

// main process
ipcMain.handle('email:resync', async (event, id, opts) => {
  const apiKey = await keychain.get('mailagent-cli-api-key');
  const { stdout } = await execa('mailagent', [
    '-o', 'json',
    'email', 'resync', String(id),
    ...(opts.replaceExisting ? ['--replace-existing'] : []),
    '--api-key', apiKey,
  ]);
  return JSON.parse(stdout);
});
```

### 3.3 附件下载

```typescript
// renderer
const path = await window.api.attachment.localPath(attId);
// 用 file:// 协议直接渲染 <img> / 或交给系统 open

// main process
ipcMain.handle('attachment:localPath', async (event, attId) => {
  const att = db.prepare('SELECT local_path FROM email_attachment WHERE id = ?').get(attId);
  return att.local_path;  // 已是绝对路径，沙箱外可读
});
```

### 3.4 全文搜索

```typescript
// renderer
const hits = await window.api.email.search({ query: 'redis AND timeout', limit: 20 });

// main process（直接走 SQLite FTS5，不走 CLI 减少延迟）
ipcMain.handle('email:search', async (event, opts) => {
  return db.prepare(`
    SELECT m.*, snippet(email_body_fts, 0, '<mark>', '</mark>', '...', 16) AS snippet, bm25(email_body_fts) AS rank
    FROM email_body_fts
    JOIN email_metadata m ON m.internal_id = email_body_fts.rowid
    WHERE email_body_fts MATCH ?
    ORDER BY rank LIMIT ?`).all(opts.query, opts.limit);
});
```

---

## 4. 轮询设计

中央 polling manager（main 进程一个 setInterval），按 activeView 调整频率：

| 当前页面 | 轮询目标 | 频率 |
|---|---|---|
| inbox / mailbox | `email_metadata` since `last_max_internal_id` | 5s |
| email/:id | 该 internal_id 的 `email_metadata` + `llm_processing` | 10s（仅 active 时） |
| search | 不轮询（用户主动重新搜索） | - |
| /admin | `/admin/stats` + `dead_letter` + `v4_rollout_stats` | 30s |
| /llm | `llm_processing` aggregations | 10s |
| 后台 | 全部 paused | - |

新数据到达时 main 通过 `event.sender.send('email:new', ...)` 推给 renderer，
renderer 通过 TanStack Query 的 invalidateQueries 触发组件更新。

---

## 5. 任务拆分（V1, ~8-12 工作日）

### Sprint 0: 工程脚手架（1 天）

- [ ] electron-vite + React + TypeScript 模板初始化
- [ ] Tailwind + shadcn/ui setup
- [ ] better-sqlite3 + execa + keytar 安装
- [ ] IPC contextBridge 骨架 + Zustand store 骨架
- [ ] TanStack Query Provider + Router setup
- [ ] 项目结构 / 命名约定文档

### Sprint 1: 数据层 + 读路径（2 天）

- [ ] `src/main/db.ts` — better-sqlite3 singleton + 路径检测
- [ ] `src/main/handlers/email.ts` — list / get / body / search 4 个 handler
- [ ] `src/main/handlers/attachment.ts` — list / localPath
- [ ] `src/main/handlers/admin.ts` — stats / health / dead-letter
- [ ] TypeScript 类型定义（与 docs/cli-schema/ 对齐）
- [ ] 单测：用一个 fixture sync_store.db 跑各 handler

### Sprint 2: Inbox + 详情页（2 天）

- [ ] 路由 `/` / `/mailbox/:name` / `/email/:id`
- [ ] 邮件 list 组件（虚拟滚动 `react-window`，因可能 6000+ 封）
- [ ] 邮件详情：HTML sandboxed iframe + 内联图本地路径替换
- [ ] 附件列表 + 下载（attachment:localPath → spawn 系统 open）
- [ ] AI 字段展示（11 个 select / multi-select）
- [ ] 5s 轮询新邮件 + new badge

### Sprint 3: 搜索 + 线程视图（1 天）

- [ ] 路由 `/search` FTS5 接入
- [ ] 搜索结果 snippet 高亮（dangerouslySetInnerHTML + sanitize）
- [ ] mailbox / date range / has_attachments filter
- [ ] 邮件详情页加 thread sidebar（父 + 子 emails）

### Sprint 4: 写操作 + Keychain（1.5 天）

- [ ] keychain util + 首次启动引导（settings 页面）
- [ ] CLI fork wrapper：execa + JSON 解析 + 错误码处理
- [ ] `email/:id` 加 "重传 Notion" / "AI 重跑" / "更新旗标" 按钮
- [ ] 长任务模式（backfill body / derivatives）— 进度条 + SIGINT 二次确认 dialog

### Sprint 5: 看板 + LLM dashboard（1.5 天）

- [ ] `/admin` 健康检查 + DB 统计 + dead-letter 操作
- [ ] `/llm` 处理状态分布 + cost 趋势 + cache hit rate
- [ ] `/calendar` 列表 + 周期会议 recurring discover/replay

### Sprint 6: 打包 + 自动更新（1 天）

- [ ] electron-builder macOS .dmg + 签名（需要 Apple Developer 证书；先 ad-hoc）
- [ ] auto-updater (electron-updater + GitHub Releases)
- [ ] settings 页面：DB 路径 / 轮询频率 / 主题 / 重置 API key

### Sprint 7: Polish + Bug Fix（1-2 天）

- [ ] 暗色 / 亮色 theme
- [ ] 键盘快捷键（vim 风格 j/k 翻邮件 / cmd+k 搜索）
- [ ] 错误 toast / loading 骨架屏
- [ ] 文档：README + 安装指南

---

## 6. V1 不做

- ❌ 远程模式（FastAPI 中转）— V2 看是否多人 / mobile 再做
- ❌ 多用户 / OAuth — 仅单用户
- ❌ Push notification / SSE / WS — 轮询足够
- ❌ 写邮件草稿（前端编辑器）— 走 Mail.app 现有流程
- ❌ Calendar.app 双向同步 UI — 后端已是只读，前端只展示
- ❌ Mobile app — 框架不同
- ❌ 多语言 — 当前界面 zh-CN，前端跟进

---

## 7. 风险 / 缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| SQLite locking（mail-sync 写 + Electron 读冲突） | 中 | 中 | SQLite WAL 模式（PRAGMA `journal_mode=WAL`，后端已开）+ readonly connection in renderer |
| better-sqlite3 跨 Electron 版本兼容 | 低 | 中 | 用 electron-rebuild 自动 |
| 邮件 HTML 含恶意 JS / phishing 链接 | 高 | 高 | sandboxed iframe + DOMPurify + 阻止外链跳出（all clicks 拦截 + 提示） |
| 附件路径含中文 / emoji | 中 | 低 | Node fs 原生支持，需要 URL 转义 file:// |
| API key 被 renderer 读到 | 低 | 高 | API key 只存 main 进程 + keychain，IPC 仅返回执行结果 |
| 大邮箱（6000+）列表卡顿 | 高 | 中 | 虚拟滚动 `react-window` + 后端分页 |
| Office 衍生附件未生成时打开 | 中 | 低 | 详情页检测 derived 缺失 → 调 `mailagent backfill derivatives --internal-id` |

---

## 8. 测试策略

| 层 | 工具 | 覆盖 |
|---|---|---|
| Unit (main handlers) | Vitest + better-sqlite3 fixture | DB query / IPC handler |
| Unit (renderer components) | Vitest + React Testing Library | 组件 props / interaction |
| E2E | Playwright + Electron | 关键路径（inbox → 详情 → 搜索 → 重传） |
| 手测 | macOS dev + 真实 sync_store.db | UI 流畅度 / 邮件渲染 / 附件预览 |

---

## 9. 下一步

1. 用户审批本 plan（技术选型 + Sprint 拆分）
2. 起独立 git repo（推荐）或 monorepo 子目录 `frontend/`
3. Sprint 0 工程脚手架
4. 按 Sprint 顺序实施

**关键决策待用户确认**:
- [ ] **代码位置**: 独立 repo `mailagent-electron` vs 本 repo 加 `frontend/` 子目录？
- [ ] **首版目标**: 内部用 vs 准备发布？影响是否做签名 + 公证 + auto-update
- [ ] **Sprint 颗粒度**: 是否按本 plan 7 个 Sprint 走，还是更细粒度 PRD？

---

> 本 plan 与 PR-7 §1.1 ship 同 batch 起草（commit `9e4db8f` 之后）。前端实施需独立
> repo / 分支，与后端 mail-sync 并行演进。
