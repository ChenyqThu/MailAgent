# MailAgent · Frontend

> macOS Electron 邮件桌面 app（本机主战场）+ 远程 Web SPA / PWA（出差用）+
> ping-island Hybrid 灵动岛集成（macOS 本机增强）三位一体的前端体系。
>
> **状态**: 2026-05-16 架构定稿 / 设计系统就位 / 项目计划完整 / **深度 review 完成（[REVIEW-LOG.md](./REVIEW-LOG.md)）** — 等 Sprint 0 启动。
>
> **后端**: SQLite-SSoT 邮件同步系统（详 `../CLAUDE.md`），mail-sync 在本地 macOS 跑，
> Mail.app → SQLite → Notion 实时双向同步 + LLM 分类 + 飞书通知。

---

## 0. 入口阅读顺序

第一次读这个目录的人按以下顺序看（半小时入门）：

1. **本文** — 全局导览 + 决策摘要
2. **[ARCHITECTURE.md](./ARCHITECTURE.md)** — 三条线（V1 Electron / V2 远程 / Island）如何协同，关键架构决策
3. **[DESIGN.md](./DESIGN.md)** — 设计系统 SSoT（色彩 / typography / 组件 / AI panel 约定 / Island 约定 / **i18n §16** / **三态主题 §17**）
4. **[PROJECT-PLAN.md](./PROJECT-PLAN.md)** — Sprint 拆分 + 并行开发指引
5. **[BACKEND-INTERFACES.md](./BACKEND-INTERFACES.md)** — 后端 4 个接口面（CLI / FastAPI / Redis / SQLite）+ 数据契约
6. **[ISLAND-PLUGIN.md](./ISLAND-PLUGIN.md)** — ping-island Hybrid 接入详
7. **[REMOTE-ACCESS.md](./REMOTE-ACCESS.md)** — V2 Cloudflare Tunnel + Web SPA + PWA 详

视觉参考：

- `mockup-inbox.html` — 三栏 inbox + 360px AI Chat panel + 批量操作 bar
- `mockup-dynamic-island.html` — 灵动岛 Plugin 8 场景 (V4 = Hybrid 方案)

历史归档：[`archive/`](./archive/) — 7 份早期规划文档（被 ARCHITECTURE / PROJECT-PLAN / ISLAND-PLUGIN / REMOTE-ACCESS / BACKEND-INTERFACES 5 份新文档取代或精简）

---

## 1. 文件清单

```
frontend/
├── README.md                       ← 本文，导览
├── REVIEW-LOG.md                   ← 2026-05-16 深度 review 决议（opus 4.7 + 5 codex agents）
├── DESIGN.md                       ← 设计系统 SSoT (1440+ 行, 17 sections)
├── ARCHITECTURE.md                 ← 完整前端架构（三线协同）
├── PROJECT-PLAN.md                 ← 项目计划 + Sprint + 并行指引
├── BACKEND-INTERFACES.md           ← 后端 4 接口面参考
├── ISLAND-PLUGIN.md                ← ping-island Hybrid 接入
├── REMOTE-ACCESS.md                ← V2 远程访问架构
│
├── mockup-inbox.html               ← claude design 出，inbox 主页
├── mockup-dynamic-island.html      ← claude design 出，Island Plugin V4
├── mockups/                        ← (future) detail / search / settings / admin / llm-dashboard
│
└── archive/
    ├── README.md                   ← 归档说明 + 每份文档命运
    ├── frontend-design-handoff.md
    ├── frontend-integration-spec.md
    ├── frontend-ping-island-integration.md
    ├── frontend-v1-feature-spec.md
    ├── frontend-v1-implementation-plan.md
    ├── frontend-v1-tech-tradeoffs.md
    └── frontend-v2-remote-access.md
```

---

## 2. 决策摘要（2026-05-16 拍板）

### 2.1 技术栈

| 层 | 选型 |
|---|---|
| 桌面壳 | Electron + electron-vite + electron-builder |
| 渲染框架 | React 18 + TypeScript + TanStack Query + Zustand + TanStack Router |
| 样式 | Tailwind + shadcn/ui（DESIGN.md §11 paste-ready 配置）|
| 主题色 accent | 6 swatch CSS variable 驱动（DESIGN.md §2.7）|
| **主题三态** | **light / dark / system**（默认 system 跟随，DESIGN.md §17）|
| **i18n** | **i18next + react-i18next**，V1 双语 zh-CN + en-US（DESIGN.md §16）|
| SQLite 驱动 | better-sqlite3 (main 进程，~4ms 命中) |
| CLI fork | execa |
| Keychain | keytar (macOS 原生 Keychain) |
| 邮件 HTML 渲染 | sandboxed iframe + DOMPurify |
| AI Chat 后端 | Notion Agent (`notion-agent-cli`) + Custom API（Anthropic/OpenAI/...）双 backend |

### 2.2 三条产品线

| 线 | 目标 | 平台 | 工作量 | 状态 |
|---|---|---|---|---|
| **L1 V1 Electron**（主线）| 本机邮件桌面 app | macOS 14+ | **~16-21 天**（REVIEW-LOG C-04 重估 Sprint 4 AI Chat）| 等 Sprint 0 |
| **L2 Island Hybrid** | macOS 灵动岛通知 + 邮件专属 mascot + 跳转 | macOS 14+ | ~6-10 天（Swift ~3-4 天 + Python ~3-6 天）| L2-Sprint 1-3 与 L1 完全并行 Day 1 可起；L2-Sprint 4 联调 = L1 Sprint 5 后 |
| **L3 V2 远程访问** | 出差 iPad / iPhone / 借的电脑也能用 | 任何浏览器 | +4-6 天 atop L1 | 等 L1 Sprint 5+ |

详 [`PROJECT-PLAN.md`](./PROJECT-PLAN.md) §0 总览。

### 2.3 数据架构

- **SQLite 是 SSoT**（`data/sync_store.db`），后端 mail-sync 写，前端读
- **不上 Postgres / S3 云数据库**（[REMOTE-ACCESS.md §1](./REMOTE-ACCESS.md#1-为什么不上-postgres) 论证）
- **V1 Electron** 直读 SQLite (~4ms)；**写**走 `mailagent` CLI fork
- **V2 Web SPA** 走本机 FastAPI (`127.0.0.1:8200`) → Cloudflare Tunnel → `mail.chenge.ink`
- **远程鉴权** Cloudflare Access (Zero Trust OAuth + 邮箱白名单)
- **Island** 通过 unix socket `/tmp/island.sock` 收 envelope

### 2.4 V1 范围（已按 designer mockup 扩大）

V1 不只是"Inbox + 详情 + 搜索"，而是包含：

- ✅ 三栏 Inbox 三栏 + 详情 (AI Fields 3×11 block + 沙箱 HTML + 附件)
- ✅ 全文搜索 (FTS5 bm25 + snippet 高亮)
- ✅ **360px 右侧 AI Chat panel**（headline 功能）
  - Notion Agent · Jarvis 默认 backend
  - Custom API 切换（claude-3.5 / gpt-5 / deepseek-v3）
  - Tool-call rows + 流式 draft preview card
- ✅ **批量 AI 操作** (AI 批量分类 / AI 批量起草回复 / 批量翻译 EN→中)
- ✅ **一键翻译 EN→中**（详情页 inline 按钮 + toolbar + batch）
- ✅ 6 主题色切换 (CSS variable swap)
- ✅ **三态主题 light/dark/system**
- ✅ **i18n zh-CN + en-US**
- ✅ 完整全局快捷键 (DESIGN.md §9.5)
- ✅ /admin 看板 + /llm dashboard + /calendar
- ✅ macOS .dmg ad-hoc 签名 + electron-updater

详 [`PROJECT-PLAN.md`](./PROJECT-PLAN.md) §2。

### 2.5 Sprint 0 硬约束

启动 Sprint 0 起就要遵守的非协商项（lint CI 强制）：

1. **`useMailApi()` data layer abstraction** — 所有组件通过 hook 调数据，不能直接 `window.electron.email.list()`（否则 V2 Web 重写）— [ARCHITECTURE.md §2.2](./ARCHITECTURE.md#22-一份-react-代码服三个-build-target)
2. **i18n 强制** — JSX 内任何硬编码字符串 code review 拒绝；`text-micro` / `text-meta` 不允许中文 — [DESIGN.md §16](./DESIGN.md#16-国际化-i18n标准化约束--自-sprint-0-起强制)
3. **三态主题骨架** — `themeMode ∈ {system, dark, light}` + `prefers-color-scheme` MediaQuery listener + Electron `nativeTheme` 同步 — [DESIGN.md §17](./DESIGN.md#17-主题系统--三态-light--dark--system)
4. **DESIGN.md §14 八条 lint 非协商项** — 无 raw hex / 无 `text-xs` 中文 / 无 Tailwind 默认蓝紫 / 无 28px+ 圆角 / 无 gradient bg / 无 shadow-2xl 滥用 / 无 slate/zinc/neutral/stone 色 / 无 coral-flood
5. **额外 lint 第 9 / 10 条**（i18n + 主题）— 自写 ESLint rule

---

## 3. 各文档"何时回头看"

| 触发场景 | 看哪份 |
|---|---|
| 起 Sprint 0 工程脚手架 | [PROJECT-PLAN.md](./PROJECT-PLAN.md) §2 Sprint 0 + [DESIGN.md](./DESIGN.md) §11 §12 §13 |
| 实现 EmailRow / AIBadge / AIChatPanel / BatchActionBar 组件 | [DESIGN.md](./DESIGN.md) §5 (含 reference code) |
| 写 IPC handler | [ARCHITECTURE.md](./ARCHITECTURE.md) §3.1 §3.2 + [BACKEND-INTERFACES.md](./BACKEND-INTERFACES.md) §4 |
| 写 CLI subprocess wrapper | [BACKEND-INTERFACES.md](./BACKEND-INTERFACES.md) §1.6 |
| 接入 Notion Agent | [DESIGN.md](./DESIGN.md) §6 + 本仓 `pipx install notion-agent-cli` |
| AI Chat panel 流式 token | [DESIGN.md](./DESIGN.md) §6.5 (DraftPreviewCard) + §6.6 (Composer) + Electron main IPC bridge（详 PROJECT-PLAN Sprint 4） |
| 快捷键 | [DESIGN.md](./DESIGN.md) §9.5 — `src/shared/keymap.ts` 单一 SSoT |
| i18n 加新字符串 | [DESIGN.md](./DESIGN.md) §16.3 命名规范 + 写 `zh-CN/{ns}.json` + 标 `[TODO en]` |
| 三态主题切换 | [DESIGN.md](./DESIGN.md) §17 + [ARCHITECTURE.md](./ARCHITECTURE.md) §2.6 |
| 加 Web build target / FastAPI 端点 | [REMOTE-ACCESS.md](./REMOTE-ACCESS.md) §3 §4 §5 |
| Cloudflare Tunnel + Access 配置 | [REMOTE-ACCESS.md](./REMOTE-ACCESS.md) §6 |
| PWA manifest / service worker | [REMOTE-ACCESS.md](./REMOTE-ACCESS.md) §7 |
| fork ping-island 加 .mail brand | [ISLAND-PLUGIN.md](./ISLAND-PLUGIN.md) §2 |
| 写 Python plugin 发 envelope | [ISLAND-PLUGIN.md](./ISLAND-PLUGIN.md) §3 §4 |
| 灵动岛 i18n locale | [ISLAND-PLUGIN.md](./ISLAND-PLUGIN.md) §7 |
| 看为什么没选某技术（如 Tauri / Postgres / 自研 menubar）| `archive/frontend-v1-tech-tradeoffs.md` / `archive/frontend-v2-remote-access.md` §1 |

---

## 4. 项目结构（V1 ship 时长这样）

```
frontend/                                # 本目录（monorepo 子目录）
├── package.json
├── tsconfig.json
├── tailwind.config.ts                   # 从 DESIGN.md §11 来
├── electron-vite.config.ts
├── vite.web.config.ts                   # V2 加
│
├── src/
│   ├── shared/                          # ★ 90%+ 代码住这里（Electron 与 Web 共享）
│   │   ├── components/
│   │   │   ├── ui/                      # shadcn primitives + 扩展
│   │   │   ├── chrome/                  # TitleBar / StatusBar / BatchActionBar
│   │   │   ├── email/                   # EmailRow / EmailList / EmailDetail / AIFieldsBlock
│   │   │   ├── ai/                      # AIChatPanel / MessageList / Composer / BackendSelector
│   │   │   ├── search/                  # CommandPalette / SearchPage
│   │   │   └── settings/                # SettingsPage
│   │   ├── state/                       # Zustand stores
│   │   ├── api/                         # MailApi interface + ElectronApi / HttpApi
│   │   ├── i18n/                        # i18next config + locales/{zh-CN,en-US}/*.json
│   │   ├── format/                      # Intl wrapper (date / number / currency)
│   │   ├── hooks/                       # useMailApi / useTranslation / useAppearance
│   │   ├── keymap.ts                    # 全局快捷键 SSoT
│   │   └── types/                       # TypeScript interfaces
│   │
│   ├── electron/                        # Electron-only
│   │   ├── main/
│   │   │   ├── handlers/                # email.ts / attachment.ts / llm.ts / admin.ts / island.ts
│   │   │   ├── db.ts                    # better-sqlite3 singleton
│   │   │   ├── cli_runner.ts            # execa wrapper
│   │   │   ├── keychain.ts              # keytar wrapper
│   │   │   └── appearance.ts            # nativeTheme IPC
│   │   ├── preload/                     # contextBridge → window.electron
│   │   └── renderer/main.tsx            # 入口，注入 ElectronApi
│   │
│   └── web/                             # V2 Web SPA-only
│       ├── main.tsx                     # 入口，注入 HttpApi
│       ├── sw.ts                        # service worker
│       └── manifest.json                # PWA manifest
│
└── tests/
    ├── unit/                            # Vitest + better-sqlite3 fixture
    ├── e2e-electron/                    # Playwright + Electron
    └── e2e-web/                         # Playwright Web
```

---

## 5. 启动前 checklist

V1 Sprint 0 启动前确认：

- [ ] Node 20 + pnpm 9 装好
- [ ] `pipx install notion-agent-cli` 装好 + 验证 **`notion-agent chat <prompt> --json --stream` 跑通流式 + tool-call response**（REVIEW-LOG M-05）
- [ ] Notion Custom Agent 已建好，拿到 `agent_page_id`
- [ ] **关 Notion Email Agent automation 或加 `Processing Status = 未处理` 限制**（REVIEW-LOG H-15）
- [ ] **v4 SQLite-SSoT Phase 4 灰度切完**（REVIEW-LOG L-06）—— `NOTION_READ_FROM_SQLITE=true` 至少 3 封实测 OK
- [ ] git 仓库 `frontend/` 已就位（claude design 产物已在）
- [ ] `../docs/cli-schema/` 45+ JSON schema 已稳定（不会大改）—— Sprint 0 codegen 起点

Island Sprint 1 启动前确认：

- [ ] Xcode 16+ 装好
- [ ] `https://github.com/ChenyqThu/ping-island.git` fork 已 clone 到本地（✅ done 2026-05-16）
- [ ] Mascot 3 张 pixel art（Work / Personal / Dev）设计稿就位

V2 Sprint 1 启动前确认：

- [ ] L1 Sprint 5 完成（CLI runner / 写操作沉淀完）
- [ ] Cloudflare 账号 + Zero Trust 已开（免费 plan 足）
- [ ] `chenge.ink` DNS 在 Cloudflare（已有）
- [ ] iPad / iPhone 能装测试 PWA

---

## 6. 与后端的契约边界

前端**不能假设**:
- ❌ SQLite schema 不变 — 后端通过 `db_version` 表达兼容
- ❌ Notion webhook 实时性 — 亚秒级但要做乐观更新 + invalidate refetch
- ❌ Email body 已写入 — 历史邮件 backfill 中可能缺 body，UI 要 fallback

前端**可以假设**:
- ✅ `email_metadata` 不会 delete 已 synced 的行
- ✅ `internal_id` 是稳定主键
- ✅ `mailagent` CLI 输出契约稳定（`schema_version=1`）
- ✅ `data/attachments/{internal_id}/*` 存在性 = `email_attachment.local_path` 存在

详 [`ARCHITECTURE.md`](./ARCHITECTURE.md) §6。

---

## 7. 文档维护规则

- ✅ 改 token / 组件 / AI 约定 / Island 约定 / **i18n / 三态主题** → 改 `DESIGN.md`
- ✅ 改架构 / 数据流 / 进程 / 模块布局 → 改 `ARCHITECTURE.md`
- ✅ 改 Sprint / 工作量 / 风险 → 改 `PROJECT-PLAN.md`
- ✅ 改后端 CLI / FastAPI / schema → 改 `BACKEND-INTERFACES.md`（同步后端 docs/）
- ✅ 改 ping-island 集成 → 改 `ISLAND-PLUGIN.md`
- ✅ 改远程访问 → 改 `REMOTE-ACCESS.md`
- ❌ 不要改 `archive/` 里任何文件（历史只读）
- ❌ 不要改 `mockup-*.html`（视觉参考；要改重新让 claude design 出新版）

每次大改后 verify 跨文档相对链接：

```bash
cd frontend
for f in *.md; do
  grep -oE '\(\./[a-zA-Z0-9-]+\.md[^)]*\)' "$f" | tr -d '()' | sort -u | while read p; do
    target="${p%%#*}"; target="${target#./}"
    test -e "$target" && echo "OK  [$f] $p" || echo "MISS [$f] $p"
  done
done
```

---

## 8. 与外部仓库的关系

| 仓库 | 关系 |
|---|---|
| MailAgent 本仓 (后端) | 前端在 `frontend/` 子目录（monorepo） |
| [ChenyqThu/ping-island](https://github.com/ChenyqThu/ping-island) | **L2 独立 fork**（不在本仓），minimal Swift 改动 |
| [erha19/ping-island](https://github.com/erha19/ping-island) | fork 的 upstream，月度 rebase |
| [notion-agent-cli](https://github.com/your/notion-agent-cli) | pipx 安装，AI Chat panel 的 Notion Agent backend |
| Cloudflare Pages | V2 部署 Web SPA 静态资源 |
| Cloudflare Zero Trust | V2 远程访问鉴权 |

---

> 这份 README 是导览，所有 source-of-truth 在具体子文档。任何全局决策变更先改对应子文档，再回头同步本文档。
