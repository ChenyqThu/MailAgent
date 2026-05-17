# MailAgent Frontend Architecture

> 完整前端架构 SSoT。覆盖 V1 Electron 单机 + V2 远程访问 + Island 集成三条线
> 在一个体系内如何协同。
>
> **关联**:
> - [`DESIGN.md`](./DESIGN.md) — 设计系统 SSoT（视觉 / 组件 / token）
> - [`PROJECT-PLAN.md`](./PROJECT-PLAN.md) — Sprint 拆分与并行开发
> - [`BACKEND-INTERFACES.md`](./BACKEND-INTERFACES.md) — 后端 4 接口面
> - [`ISLAND-PLUGIN.md`](./ISLAND-PLUGIN.md) — ping-island Hybrid 接入
> - [`REMOTE-ACCESS.md`](./REMOTE-ACCESS.md) — V2 远程访问
> - 后端 [`../CLAUDE.md`](../CLAUDE.md) — mail-sync / SQLite SSoT / CLI / webhook-server

---

## 1. TL;DR — 三条线并存

```
                    ┌───────────────────────────────────────────────────┐
                    │              MailAgent 前端体系                    │
                    └───────────────────────────────────────────────────┘
                              │                  │                │
              ┌───────────────┘                  │                └───────────────┐
              ▼                                  ▼                                ▼
   ┌─────────────────────┐         ┌─────────────────────────┐       ┌──────────────────────┐
   │  V1: Electron App   │         │ V2: 远程访问 Web SPA   │       │ Island: Ping Island │
   │  (本机 macOS,主战场)│         │ (Cloudflare Tunnel +    │       │  Plugin (Hybrid)    │
   │                     │         │  Web SPA + PWA)         │       │                      │
   │  shared React +     │         │  shared React +         │       │  Swift fork minimal │
   │  IPC → SQLite 直读  │         │  HTTP → 本地 FastAPI    │       │  + Python plugin    │
   │  ~4ms 命中          │         │  ~200-400ms             │       │  通过 unix socket   │
   └─────────────────────┘         └─────────────────────────┘       └──────────────────────┘
              │                                  │                                │
              └──────────────┬───────────────────┘                                │
                             ▼                                                    │
                ┌──────────────────────────────┐                                  │
                │ src/web/  (shared React 实现) │                                  │
                │   - data layer abstraction    │                                  │
                │   - 90% 组件复用              │                                  │
                └──────────────────────────────┘                                  │
                             │                                                    │
                             ▼                                                    ▼
                ┌──────────────────────────────────────────────────────────────────┐
                │     本地 MailAgent backend (永远开机 + mail-sync 跑着)            │
                │  ├── data/sync_store.db (SQLite SSoT)                            │
                │  ├── data/attachments/{internal_id}/                             │
                │  ├── PM2: mail-sync     (现有)                                   │
                │  ├── PM2: mailagent-api  ← V2 新增 (127.0.0.1:8200)              │
                │  ├── PM2: mailagent-tunnel ← V2 新增 (cloudflared)               │
                │  └── ~/.mailagent/plugins/ping_island/ ← Island Plugin 主体      │
                └──────────────────────────────────────────────────────────────────┘
```

**关键架构决策**（已拍板 2026-05-16）:

| 维度 | 决策 |
|---|---|
| 桌面壳 | Electron + React + TypeScript + Vite + electron-vite |
| 渲染框架 | React 18 + TanStack Query + Zustand + TanStack Router |
| 样式 | Tailwind + shadcn/ui，6 主题色 CSS 变量驱动（详 DESIGN.md §2.7） |
| SQLite 驱动 | better-sqlite3 (main 进程，~4ms 命中) |
| CLI fork | execa |
| Keychain | keytar (macOS 原生 Keychain) |
| 打包 | electron-builder + GitHub Releases (electron-updater) |
| 远程访问 | 本地 FastAPI 暴露 + Cloudflare Tunnel + Cloudflare Access OAuth ✅ |
| Island | **Hybrid**: fork ping-island minimal (5 行 enum + mascot) + plugin 主体在本仓 |
| 数据存储 | **SQLite SSoT 不动**, ❌ Postgres / S3 (详 REMOTE-ACCESS.md §1) |
| AI Chat 后端 | Notion Agent (notion-agent-cli) + Custom API (Anthropic/OpenAI/...) 双 backend |
| 鉴权 | 本地: keytar / `MAILAGENT_CLI_API_KEY`；远程: Cloudflare Access (OAuth 白名单) |
| **i18n** | `i18next` + `react-i18next` + browser-languagedetector；V1 支持 `zh-CN` + `en-US`；Sprint 0 起强制不允许硬编码字符串（详 [DESIGN.md §16](./DESIGN.md#16-国际化-i18n标准化约束--自-sprint-0-起强制)）|
| **主题三态** | `light` / `dark` / `system`（默认 system 跟随）；`data-theme` + Tailwind `darkMode: 'class'` 双源同步；Electron `nativeTheme.themeSource`；切换瞬间生效（详 [DESIGN.md §17](./DESIGN.md#17-主题系统--三态-light--dark--system)）|

---

## 2. 关键架构原则

### 2.1 SQLite 是 Single Source of Truth

后端 mail-sync 持续把 macOS Mail.app 邮件 + 附件双写到 `data/sync_store.db` +
`data/attachments/{internal_id}/`。前端**永不**自己改 schema，只读；写操作走 CLI（事务安全）。

### 2.2 一份 React 代码服三个 build target

```
src/
├── shared/                      ★ 90%+ 代码住这里（组件 / store / hook / types）
│   ├── components/             从 DESIGN.md §13 推荐结构来
│   ├── api/                    MailApi interface + 抽象层
│   ├── state/                  Zustand stores
│   └── keymap.ts               全局快捷键 SSoT
├── electron/                    Electron-only entry
│   ├── main/                   main 进程：better-sqlite3 / execa / keytar / IPC
│   ├── preload/                contextBridge
│   └── renderer/               入口 main.tsx，注入 ElectronApi 实现
└── web/                         Web-only entry
    ├── main.tsx                注入 HttpApi 实现 + PWA service worker
    └── manifest.json           PWA manifest
```

**Sprint 0 硬约束** — 所有 React 组件通过 `useMailApi()` 调数据，**不能**直接
`window.api.email.list(...)`。否则 V2 Web 重写：

```typescript
// shared/api/factory.ts
export function makeMailApi(): MailApi {
  if (import.meta.env.VITE_BUILD_TARGET === 'electron') {
    return new ElectronApi();   // IPC + better-sqlite3 (本机 ~4ms)
  }
  return new HttpApi(baseUrl);  // fetch + Cf-Access JWT cookie (远端 ~200-400ms)
}

// shared/components/EmailList.tsx
const api = useMailApi();
const { data } = useQuery(['email/list', opts], () => api.email.list(opts));
// 这个组件不知道也不关心数据是 IPC 来的还是 HTTP 来的
```

### 2.3 Island 用 unix socket，与 React 完全解耦

Island 是 macOS 原生 Swift app（fork 自 ping-island），与 Electron 通过
`/tmp/island.sock` UNIX socket 通信。**React 不直接操作 Island** —— Electron main
进程是中介，把感兴趣的事件 broadcast 给 Island。

```
mail-sync (Python)                Electron main                  ping-island (fork)
    │                                  │                                 │
    │ classify · 11 ai_fields          │ better-sqlite3 insert           │
    ├────────────────────────────────▶│ refresh inbox UI                │
    │                                  │                                 │
    │                                  │ route(priority) → island        │
    │                                  ├────── unix socket ────────────▶│
    │                                  │       JSON envelope             │ Phase 1: 展开 4s
    │                                  │                                 │ Phase 2: dock icon
    │                                  │                                 │ Phase 3: hover 展开
    │                                  │ ◀──── click jump ───────────────│ Phase 4: focus_email
    │                                  │  open detail pane               │  pill 清空
```

**事件协议**：详见 [`ISLAND-PLUGIN.md`](./ISLAND-PLUGIN.md) §3。基于 ping-island 现有
`BridgeEnvelope` schema，自家 brand `.mail`。

### 2.4 V2 远程访问不动 SSoT

远程访问通过本地 FastAPI (`127.0.0.1:8200`) → Cloudflare Tunnel → Cloudflare Access
OAuth 拦截 → 浏览器/PWA。**不上 Postgres**，附件按需 stream。Mac 必须开机
（与 mail-sync 一致）。详见 [`REMOTE-ACCESS.md`](./REMOTE-ACCESS.md)。

### 2.5 i18n 是 Sprint 0 一等公民，不是 polish

V1 必须 zh-CN + en-US 双语 ready，不是 ship 后再补。`i18next` + `react-i18next` 装入 Sprint 0
脚手架，所有组件**硬编码字符串 = code review 拒绝**。Island plugin（Python 端）也读
`~/.mailagent/plugins/ping_island/locales/{lang}/island.json`，envelope 的 title/preview 走 i18n。

详 [DESIGN.md §16](./DESIGN.md#16-国际化-i18n标准化约束--自-sprint-0-起强制)。

### 2.6 主题三态 `light / dark / system` 与 6 accent 独立

主题切换（明 / 暗）= ink scale + fg ramp token 切换；accent (coral / cobalt / teal / rose / slate / olive)
= 单独 `--c-accent` CSS variable swap。**两层正交**，6 × 3 = 18 个视觉组合全部 WCAG AA 验证。

默认 `system` 跟随 macOS / 浏览器 / iOS 系统设置；用户可在 Settings 强制锁定 light 或 dark。
切换瞬间生效（<50ms 内 DOM 切完，无闪烁）。Electron `nativeTheme.themeSource` 同步窗口
chrome；Web SPA 走 `prefers-color-scheme` MediaQuery listener；Island 通过 unix socket 收 accent + theme broadcast。

详 [DESIGN.md §17](./DESIGN.md#17-主题系统--三态-light--dark--system)。

### 2.7 鉴权分层

| 路径 | 鉴权机制 | 适用 |
|---|---|---|
| Electron 本机 IPC 读 | 系统文件权限 (macOS Full Disk Access) | V1 主路径 |
| Electron 本机 CLI 写 | `MAILAGENT_CLI_API_KEY` from keytar | V1 写操作 |
| 远端 Web HTTPS 读/写 | Cloudflare Access (Zero Trust, Google OAuth + 邮箱白名单) | V2 主路径 |
| FastAPI 二次校验 | Cf-Access-Jwt-Assertion header (防 tunnel 误配) | V2 防御纵深 |

---

## 3. 数据流详图

### 3.1 V1 — 邮件列表读取

```
React Component (EmailList)
  │
  │ const api = useMailApi()               ← data layer abstraction
  │ api.email.list({ mailbox, limit, ... })
  │
  ▼
ElectronApi.email.list()                   ← Electron build
  │ window.electron.invoke('email:list', opts)
  │
  ▼
Electron main: ipcMain.handle('email:list', ...)
  │ better-sqlite3 prepared statement
  │ SELECT * FROM email_metadata WHERE ... LIMIT ? OFFSET ?
  │
  ▼
data/sync_store.db (SQLite, ~4ms)
  │
  ▲
  │ EmailMeta[]
  ▼
React Component renders
```

### 3.2 V1 — 邮件重传 Notion（写操作）

```
React Component (Toolbar)
  │ api.email.resync(id, { replaceExisting: true })
  ▼
ElectronApi.email.resync()
  │ window.electron.invoke('email:resync', id, opts)
  ▼
Electron main: ipcMain.handle('email:resync', ...)
  │ const key = await keytar.getPassword('mailagent', 'cli-api-key')
  │ execa('mailagent', ['-o', 'json', 'email', 'resync', id, '--api-key', key, ...])
  │ stream stdout → mainWindow.webContents.send('cli:log', chunk)
  ▼
mailagent CLI (typer)
  │ NotionSync.create_email_page_v2(...)
  ▼
Notion API
  │
  ▲
  │ JSON 结果（schema_version=1, status=success/error, data, meta.duration_ms）
  ▼
React Component shows Toast + invalidate queries
```

### 3.3 V2 — Web SPA 远程读取邮件

```
PWA / Web Browser (远端)
  │ fetch('/api/email/list?...')
  │ + cookie CF_Authorization (Cloudflare Access OAuth)
  ▼
Cloudflare 边缘 → Access 拦截 → 通过 → 注入 Cf-Access-Jwt-Assertion header
  ▼
cloudflared tunnel (本机) → 127.0.0.1:8200
  ▼
FastAPI middleware: 校验 JWT → 通过
  ▼
FastAPI router /api/email/list
  │ from src.repository import EmailRepository
  │ EmailRepository(db_path).list_metadata(...)
  ▼
data/sync_store.db (SQLite, ~4ms)
  │
  ▲
  │ JSON wrapper (status / data / meta)
  ▼ Cloudflare → 浏览器 (~200-400ms 全程)
React Component (同一份代码，HttpApi 实现路径) renders
```

### 3.4 Island — 新高优先级邮件触发

```
mail-sync._sync_single_email_v3 (Python, 本机)
  │ Notion sync 成功 → AI Reviewed (priority=Urgent)
  ▼
Electron main 监听 SQLite 变化（轮询或 Redis 通知）
  │ 看到新 row → 检查 priority
  │ if priority in {Critical, Urgent}: send_to_island(envelope)
  ▼
unix socket /tmp/island.sock
  │ JSON BridgeEnvelope (provider=mail, eventType=MailReceivedUrgent, ...)
  ▼
ping-island (fork) HookSocketServer
  │ 路由到 .mail brand → MailAgent mascot + 邮件 session view
  ▼
灵动岛 Phase 1 展开 4s → Phase 2 dock 红点 → 用户 hover → Phase 3 展开 → 点击 → Phase 4 跳转
  │ click intervention.option = "open_mail" → BridgeResponse
  ▲
  │ socket
  ▼
Electron main 收到响应 → 跳 Mail.app + 把 MailAgent 窗口 focus 到该邮件
```

---

## 4. 模块/进程清单

### 4.1 本机进程（macOS, PM2 管理）

| 进程名 | 启动命令 | 已有/新增 | 端口 | 职责 |
|---|---|---|---|---|
| `mail-sync` | `pm2 start main.py --name mail-sync --interpreter ./venv/bin/python3` | ✅ 已有 | - | 主同步循环 / SQLite 写 / Notion / 飞书 |
| `mailagent-api` | `pm2 start "uvicorn src.api.app:app --host 127.0.0.1 --port 8200" --name mailagent-api` | 🆕 V2 | 127.0.0.1:8200 | 给前端用的 read/write API |
| `mailagent-tunnel` | `pm2 start cloudflared --name mailagent-tunnel -- tunnel run mailagent-local` | 🆕 V2 | - | Cloudflare Tunnel 出口 |
| `MailAgent.app` | electron-builder 打包的 .app | 🆕 V1 | - | 本机 Electron UI |
| `PingIsland.app` (fork) | brew cask / dmg 自装 | 🆕 Island | unix socket `/tmp/island.sock` | macOS 灵动岛 UI |

### 4.2 远程进程（腾讯云 Ubuntu 170.106.181.89，不变）

| 进程名 | 职责 | V2 是否动 |
|---|---|---|
| `mailagent-webhook` | Notion webhook → Redis 入队，外部 agent `/command` 接口 | ❌ 不动 |
| Redis | event bus（本地服务消费） | ❌ 不动 |

**关键澄清** — `mailagent-webhook`（远程）和 `mailagent-api`（本机，V2 新增）**职责完全不同**:
- `mailagent-webhook` = Notion 中转 + 外部 agent，跑在云上
- `mailagent-api` = 给前端用的本机 read/write API，跑在本机
- 两个不合并

详 [`BACKEND-INTERFACES.md`](./BACKEND-INTERFACES.md) §2。

---

## 5. 关键文件位置

| 路径 | 内容 |
|---|---|
| `frontend/src/electron/main/` | Electron main 进程（IPC handlers / db / cli runner / keychain） |
| `frontend/src/electron/preload/` | contextBridge 暴露 `window.electron` |
| `frontend/src/electron/renderer/main.tsx` | Electron renderer 入口 |
| `frontend/src/web/main.tsx` | Web SPA 入口 |
| `frontend/src/shared/` | 共享 React (组件 / state / api 抽象) |
| `frontend/src/shared/api/factory.ts` | makeMailApi() — ElectronApi vs HttpApi 分支 |
| `frontend/src/shared/keymap.ts` | 全局快捷键 SSoT（DESIGN.md §9.5 来源） |
| `frontend/electron-vite.config.ts` | Electron build 配置 |
| `frontend/vite.web.config.ts` | Web SPA build 配置 |
| `frontend/tailwind.config.ts` | 从 DESIGN.md §11 来 |
| `frontend/package.json` | 依赖：electron / react / better-sqlite3 / execa / keytar / tanstack/query+router / zustand / tailwind / shadcn / vite |
| 后端 `src/api/` | 🆕 V2 FastAPI 模块（详 REMOTE-ACCESS.md §3） |
| 后端 `~/.mailagent/plugins/ping_island/` | 🆕 Island plugin 主体（详 ISLAND-PLUGIN.md §4） |

---

## 6. 与后端的契约边界

前端**不能假设**的事：
- ❌ SQLite schema 不变 — 后端 mail-sync 升级 schema 会通过 `db_version` 字段表达；前端读 `db_version` 决定兼容
- ❌ Notion webhook 实时性 — Notion → Mail 是亚秒级，但前端要做"乐观更新 + invalidate refetch"
- ❌ Email body 已写入 — 历史邮件 backfill 中可能缺 body（`email_body` 表 miss），UI 要 fallback "正在加载正文"
- ❌ **不能直接给 `data/sync_store.db` 加表**（REVIEW-LOG C-05）— 后端 mail-sync 拥有 DB_VERSION；AI Chat 等前端独有状态用 `~/.mailagent/frontend/ai_chat.db` 独立 SQLite

前端**可以假设**的事：
- ✅ `email_metadata` 不会 delete 已 `synced` 的行（除非用户在 admin 主动 archive）
- ✅ `internal_id` 是稳定主键（=AppleScript id）
- ✅ `mailagent` CLI 输出契约稳定（schema_version=1，详 `docs/cli-schema/`）
- ✅ `data/attachments/{internal_id}/*` 文件存在性 = `email_attachment.local_path` 存在

**Sprint 0 加任务（REVIEW-LOG C-03）**：从 `docs/cli-schema/*.schema.json` codegen TypeScript interface（`pnpm gen:types`）；Electron IPC handler 与 Python `EmailRepository` 共 SoT，避免双源真相漂移。详 `PROJECT-PLAN.md` Sprint 0。

---

## 7. 性能 / SLO

| 操作 | V1 Electron 目标 | V2 Web 目标 |
|---|---|---|
| 列表初次渲染（50 行） | < 200ms | < 500ms |
| 切换 email 详情 | < 50ms | < 800ms |
| 全文搜索（FTS5） | < 100ms | < 1.2s |
| AI panel chat 首 token | < 600ms (Notion Agent) / < 800ms (Custom API) | 同 |
| 邮件重传 Notion (resync) | < 5s | < 6s |
| 附件下载（5MB PDF） | 秒开（file://） | 流式 ~3-5s |
| 启动时间（冷启动） | < 1.5s | N/A |

监控：Electron main 进程暴露 `/diag/timings` 给 settings 页面查看。

---

## 8. 测试策略

| 层 | 工具 | 覆盖 |
|---|---|---|
| Unit — main IPC handlers | Vitest + better-sqlite3 fixture | DB query / IPC contract |
| Unit — shared React 组件 | Vitest + React Testing Library | props / interaction |
| E2E — Electron | Playwright + Electron | 关键路径 inbox → 详情 → 搜索 → 重传 |
| E2E — Web SPA | Playwright | 同样关键路径走 HTTP API |
| Visual regression | Storybook + Chromatic | V1.5+ |
| 设计契约 lint | 自写 `pnpm lint:design` | DESIGN.md §14 八条非协商项 |

---

## 9. V1 / V2 / Island 之间的依赖

```
                                    ┌──────────────┐
              ┌──────────────────── │ shared React │ ←────────────────┐
              │                     └──────────────┘                  │
              │                            ▲                          │
              │                            │ 90% 复用                  │
              ▼                            │                          ▼
       ┌─────────────┐                     │                  ┌─────────────┐
       │ V1 Electron │ ←─── 独立 build ────┴── 独立 build ──→ │ V2 Web/PWA  │
       │ (Sprint 0-7)│                                        │ (Sprint V2-1│
       └─────────────┘                                        │      ~ V2-5)│
              │                                               └─────────────┘
              │                                                      │
              │  unix socket                                          │
              ▼                                                      │
       ┌─────────────┐                                                │
       │ Island Plugin│  ← 独立 Swift fork + Python plugin            │
       │ (并行进行)   │     与前端完全无源码依赖                       │
       └─────────────┘                                                │
                                                                      │
   依赖说明：                                                          │
   - V1 必须先 ship，V2 在其上加 Web build target                     │
   - V2 共享 React 代码全部来自 V1                                    │
   - Island 与 V1/V2 都无源码依赖（只通过 unix socket 与 Electron main 联系）
   - 详 PROJECT-PLAN.md §5 并行开发指引
```

---

## 10. 不在本架构范围

- ❌ 写邮件草稿 in-app — 走 Mail.app 现有流程，前端只能触发"创建草稿"
- ❌ Calendar.app 双向同步 UI — 后端只读
- ❌ Mobile native app（iOS / Android）— V3+ 议题，目前 PWA 够用
- ❌ 多用户 / SaaS 化 — 单用户工具
- ❌ 服务端渲染（SSR / SSG）— Electron 不需要，Web SPA 也不需要（个人工具，SEO 无关）

---

> 本文档与 [`DESIGN.md`](./DESIGN.md) 互补：DESIGN.md 管"长什么样"，本文档管
> "怎么连起来"。所有 Sprint 工作量与计划在 [`PROJECT-PLAN.md`](./PROJECT-PLAN.md)。
