# MailAgent Frontend Project Plan

> 完整项目计划 SSoT。覆盖 V1 扩大版 Electron（~12-16 天）+ V2 远程访问（+4-6 天）+
> Island Hybrid（+1-2 周 Swift）三条线，强调**最大化并行开发**。
>
> **状态**: 2026-05-16 立项。用户决策已拍板。等 Sprint 0 启动。
>
> **关联**:
> - [`ARCHITECTURE.md`](./ARCHITECTURE.md) — 三条线如何协同
> - [`DESIGN.md`](./DESIGN.md) — 设计系统 SSoT
> - [`ISLAND-PLUGIN.md`](./ISLAND-PLUGIN.md) — Island 接入详
> - [`REMOTE-ACCESS.md`](./REMOTE-ACCESS.md) — V2 远程详
> - [`BACKEND-INTERFACES.md`](./BACKEND-INTERFACES.md) — 后端 4 接口面

---

## 0. TL;DR — 三条并行线 + 总工作量

| 线 | 工作量 | 平台 | 何时启动 | 阻塞关系 |
|---|---|---|---|---|
| **L1 V1 Electron**（主线）| **~16-21 天**（REVIEW-LOG C-04 重估，Sprint 4 AI Chat 从 2-3 天调到 6-9 天）| React + Electron + TypeScript | Sprint 0 起 | 全部独立 |
| **L2 Island Hybrid**（独立 Swift）| ~6-10 天（Swift ~3-4 天 + Python ~3-6 天）| Swift fork + Python plugin | L2 Sprint 1-3 与 L1 完全并行，**Day 1 就能起**；Sprint 4 联调依赖 L1 Sprint 5 | Sprint 4 端到端时 |
| **L3 V2 远程访问** | ~4-6 天 | FastAPI + Cloudflare Tunnel + Web SPA | L1 ship 后（**或 Sprint 5+ 提前起 FastAPI**） | 依赖 L1 共享 React 代码就绪 |

**并行收益**: 串行做要 26-37 天；并行做主线 16-21 天 + 1 个尾巴 ~3-5 天合并 ≈ **18-25 天总时长**（取决于一个人开还是多人）。

---

## 1. 总览路线图

```
Day  0    2    4    6    8   10   12   14   16   18   20
L1   ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ← Electron V1 扩大版 (Sprint 0-7)
L2   ──░░░░░░░░░░░░░░░░░░░░░         ← Island fork + plugin (并行起步)
L3                            ──░░░░░░░░░░░░  ← V2 远程 (L1 框架就绪后启动)

里程碑:
  ▲ Day 2:  Sprint 0 完工（脚手架 + tailwind/shadcn）
  ▲ Day 6:  Sprint 2 完工（Inbox + 详情 + AI Fields block）
  ▲ Day 9:  Sprint 3 完工（搜索 + 线程 + 翻译）
  ▲ Day 11: Sprint 4 完工（AI Chat Panel + Notion Agent）
  ▲ Day 13: Sprint 5 完工（批量 AI ops + 写操作）
  ▲ Day 15: V1 ship (含 polish)
  ▲ Day 18: Island 接入端到端联调
  ▲ Day 21: V2 远程 ship
```

---

## 2. L1 V1 Electron Sprint 拆分（~16-21 天，REVIEW-LOG C-04 重估）

V1 范围已按 designer mockup 扩大 — 比 archive 里 `frontend-v1-implementation-plan.md`
增加：AI Chat panel + Notion Agent 双 backend + 批量 AI 操作 + 一键翻译 + 主题色切换 +
完整快捷键体系。

### Sprint 0 — 工程脚手架（**1-2 天**）

- [ ] `pnpm create electron-vite` 模板初始化（React + TypeScript）
- [ ] 安装：`pnpm add better-sqlite3 execa keytar zustand @tanstack/react-query @tanstack/react-router lucide-react workbox-precaching i18next react-i18next i18next-browser-languagedetector i18next-icu`
- [ ] 安装 shadcn primitives 按 [DESIGN.md §12](./DESIGN.md)：`button badge command toast tooltip dialog dropdown-menu input textarea tabs`
- [ ] 拷 `tailwind.config.ts` from [DESIGN.md §11](./DESIGN.md)
- [ ] 拷 `:root` CSS variable 主题色块 from [DESIGN.md §2.7](./DESIGN.md)
- [ ] 项目结构 from [DESIGN.md §13](./DESIGN.md) + [ARCHITECTURE.md §5](./ARCHITECTURE.md)
- [ ] **数据层抽象骨架** — `shared/api/types.ts` MailApi interface + `shared/api/factory.ts` makeMailApi()
- [ ] `shared/api/ElectronApi.ts` 占位（throw `'not implemented'`），renderer 通过 useMailApi() 获取（**真实现 Sprint 1**）
- [ ] `useMailApi()` hook 实现（singleton 缓存）
- [ ] **Schema codegen 骨架（REVIEW-LOG C-03）** — `pnpm add -D json-schema-to-typescript`；脚本 `pnpm gen:types` 从 `../docs/cli-schema/*.schema.json` 生成 `shared/types/cli.gen.ts`；Sprint 1 起的 IPC handler 与 EmailRepository 共用 SoT
- [ ] electron main IPC contextBridge 骨架（preload 暴露 `window.electron`）
- [ ] better-sqlite3 singleton + 路径检测（默认 `~/Documents/MailAgent/data/sync_store.db`）
- [ ] keytar 集成 + 首次启动引导（settings 页面占位）
- [ ] TanStack Router setup + Provider
- [ ] **i18n 骨架 (DESIGN.md §16)** — `src/shared/i18n/index.ts` initReactI18next + browser-languagedetector + i18next-icu（ICU plural/select）；`locales/{zh-CN,en-US}/common.json` 占位 5 个 key；Suspense fallback 防 flash；`Intl` formatter wrapper in `shared/format/`（封装 TZ / RelativeTimeFormat / 文件大小）
- [ ] **三态主题骨架 (DESIGN.md §17)** — `shared/state/appearance.ts` `themeMode ∈ {system,dark,light}` + `accent ∈ 6 swatch`；`applyResolvedTheme()` 接 `(prefers-color-scheme: dark)` MediaQuery listener；**op-id + rAF 串行 guard（REVIEW-LOG C-06）**；Electron main process `BrowserWindow` 创建前设 `nativeTheme.themeSource`；`index.html` inline bootstrap script 防 FOUC（REVIEW-LOG C-07）
- [ ] **ESLint 自定义 rules 骨架（REVIEW-LOG H-08 新增任务）** — `eslint-plugin-local-rules` 引入；DESIGN.md §14 八条非协商 + i18n + 三态主题第 9/10 条每条至少 1 个 fixture test。Sprint 1 末 CI 引入。
- [ ] `pnpm dev` 跑通空白窗口

**Sprint 0 完工 checklist**:
- ✅ Electron 窗口能打开
- ✅ React 能跑
- ✅ Tailwind/shadcn 能引用 token
- ✅ `useMailApi()` 占位 throw `'not implemented'`，组件 import 不报错（**真实现 Sprint 1**）
- ✅ `useTranslation()` 能在组件里 call 到，切换 `i18n.changeLanguage('en-US')` 占位字符串实时变
- ✅ **主题三态切换 DOM 立即响应**（data-theme attribute + html class 同步），系统 dark/light 切换时 system 模式跟随；**light mode 视觉允许 unpolished**（REVIEW-LOG C-08：mockup 仅 dark，light 视觉等 Sprint 1 末 spot-check）
- ✅ 主题色切换 (`data-accent` attribute) 切换后 coral 像素变色（与 themeMode 独立）
- ✅ `pnpm gen:types` 跑通，生成 `shared/types/cli.gen.ts`（schema codegen）
- ✅ `pnpm lint` 跑通，自定义 rules 0 violation（空骨架阶段）
- ✅ **本 Sprint i18n 字符串 review**（REVIEW-LOG M-10）：扫存量 `[TODO en]`，补 en-US 翻译，确保为 0

### Sprint 1 — 数据层 + 主框架（**2-3 天**）

- [ ] `src/electron/main/db.ts` — better-sqlite3 singleton + WAL + busy_timeout
- [ ] `src/electron/main/handlers/email.ts` — list / get / body / search 4 IPC handler **走 `shared/types/cli.gen.ts` schema 验证返回形状**（REVIEW-LOG C-03）
- [ ] `src/electron/main/handlers/attachment.ts` — list / localPath
- [ ] `src/electron/main/cli_runner.ts` — REVIEW-LOG C-02 重写版本（CliQueue + AbortController + 全退出码分发 + path cache）
- [ ] `ElectronApi.email.list/get/body/search()` 真实现（IPC invoke）
- [ ] Zustand stores: `mailbox.ts` (active mailbox) / `appearance.ts` (theme) / `batch.ts` (selectedIds)
- [ ] TitleBar 36px + StatusBar 24px 组件（[DESIGN.md §5](./DESIGN.md)）
- [ ] Sidebar 240px 框架 + section header（[DESIGN.md §3.3](./DESIGN.md) English UPPERCASE mono）
- [ ] 主题色 popover 接入 title bar `<dot> Coral` 入口
- [ ] **Light mode visual spot-check（REVIEW-LOG C-08）** — EmailRow / AIBadge / Toolbar / Composer / Sidebar 5 个核心组件双 mode 截屏对比；发现明显视觉崩坏立即修 token 或回到 designer
- [ ] CI 引入 ESLint 自定义 rules（Sprint 0 已搭骨架）
- [ ] 单测：fixture sync_store.db 跑 4 个 email handler + CliQueue concurrent test + 全退出码分发 test
- [ ] **i18n 字符串 review**（REVIEW-LOG M-10）

### Sprint 2 — Inbox 三栏（**2-3 天**）

- [ ] EmailList 列 340px + 列头 + filter chips + virtualized rows (`react-window`)
- [ ] `<EmailRow>` 组件 — 严格 paste from [DESIGN.md §5.1](./DESIGN.md)
  - 1.5px unread coral dot / lang pip / paperclip / AI priority chip / AI action chip
  - 失败行 SYNC FAILED pill
  - selected 状态 3px coral 左边
- [ ] `<EmailDetail>` flex-1 — toolbar + body + AI Fields block + 附件
- [ ] **`<AIFieldsBlock>` (3×11 grid)** — 11 个 AI 字段紧凑显示
- [ ] 邮件正文：sandboxed iframe (srcdoc + sandbox=allow-same-origin) + DOMPurify
- [ ] Inline image (cid:) 替换为本机 `file://` 路径
- [ ] 5s 轮询新邮件 + new row badge
- [ ] 键盘 J/K 切邮件

### Sprint 3 — 搜索 + 线程 + 翻译（**1.5-2 天**）

- [ ] `/search` 路由 FTS5 接入（IPC handler 直查 `email_body_fts MATCH ?` + bm25 + snippet）
- [ ] 搜索结果 snippet 高亮（DOMPurify 安全渲染 `<mark>`）
- [ ] mailbox / date range / has_attachments filter
- [ ] 详情页加 `<ThreadSidebar>` (折叠在右 Panel `Thread` tab)
- [ ] **翻译 EN→中**: 详情页 inline 按钮 + toolbar 按钮，调 Custom API（默认 GPT-5 / Claude） → 暂存 `email_metadata.translated_body_md` 字段（V1 不持久化也可，仅会话内 cache）
- [ ] 一键翻译 ETA 显示

### Sprint 4 — AI Chat Panel + Notion Agent（**6-9 天**，REVIEW-LOG C-04 重估）

> 原估 2-3 天严重低估。codex 3 揭示漏掉的层：Electron main IPC bridge / 独立 chat LLM 层（不能复用 `LLMProcessor.process_email` 批处理路径）/ 状态机粒度。

**UI 组件层（~2-3 天）**:
- [ ] `<AIChatPanel>` 360px 右侧固定 — 严格 paste from [DESIGN.md §5.3](./DESIGN.md)
- [ ] Tabs: AI / Thread / Sync（默认 AI）
- [ ] **`<BackendSelector>`** — Notion Agent · Jarvis（默认）+ Custom API 行 + 备选 chips (`claude-sonnet-4-6` / `gpt-5.4` / `claude-opus-4-7`)
- [ ] **`<ContextChips>`** — 已加载 邮件全文 · 8 AI fields（REVIEW-LOG H-14）· Thread 4 · Notion 2 项目
- [ ] `<MessageList>` — user bubble (`bg-ink-4` rounded-br-sm) + assistant bubble (no bg) + system divider；virtualization (react-window) 长对话
- [ ] **`<ToolCallRow>`** — mono 11.5px log line，arrow `text-info` + dot color by status
- [ ] **`<DraftPreviewCard>`** — coral ring + DRAFT REPLY header + 发送/重生成/编辑/在新窗口
- [ ] **`<Composer>`** — textarea growable + footer slash/attach affordance + 圆形 send button + `⌘↩` send + 取消按钮（流式中）
- [ ] **`<QuickActions>`** chips — 总结 / 起草回复 / 翻译 / 提取动作项 / 关联 Notion

**Electron main IPC stream bridge 层（~2 天，REVIEW-LOG C-04 / M-08）**:
- [ ] `src/electron/main/handlers/ai_chat.ts` —— **API key 不能进 renderer bundle**，所有 LLM 调用走 main process subprocess pipe + IPC chunk stream 推 renderer
- [ ] CSP 策略：renderer 禁连外网，只能 IPC 给 main
- [ ] `cancel` IPC：renderer 切邮件 / 关 panel 时通过 AbortController 关 in-flight subprocess
- [ ] `useEmailChat` React hook：订阅 IPC 流式 chunk → 维护 messages state；处理 streaming 中断 / 网络断开 / quota exceeded 4 个状态机

**独立 chat LLM 层（~1.5-2 天）**:
- [ ] 新建 `src/electron/main/llm_chat/` 目录 —— **不复用** `src/llm_agent/processor.py`（那是批处理 tool_use，非流式 chat）
- [ ] Anthropic Messages stream 路径（claude-* 模型）：直连 CRS 或原生 Anthropic，cache_control 透传
- [ ] OpenAI Chat Completions stream 路径（gpt-* / gemini-* / codex-* 模型）：CRS 强制 `stream=true`，逐 chunk parse
- [ ] Notion Agent CLI 路径：`notion-agent chat <prompt> --agent-page-id <id> --json --stream`，pipe stdout 解析
- [ ] 多轮上下文管理：超过 token 阈值时 truncate 早期 message 或 LLM summary

**前端独立 SQLite 持久化层（~0.5-1 天，REVIEW-LOG C-05 / M-06）**:
- [ ] **不在 `sync_store.db` 加表**（违反后端 DB_VERSION 升级流程）
- [ ] 前端独立 `~/.mailagent/frontend/ai_chat.db` —— `ai_chat_sessions` + `ai_chat_messages` 双表（schema 见 BACKEND-INTERFACES.md §4.5.1）
- [ ] better-sqlite3 第二个 connection 给 ai_chat.db
- [ ] 写入：每条 user message + assistant 流式 chunk 完成 + status (pending/streaming/complete/error/aborted) + tokens + cost
- [ ] 切邮件中断时把 streaming message 改 aborted 不重放

**i18n + 三态主题 + a11y（~0.5-1 天）**:
- [ ] 所有 AI panel JSX 字符串走 `t()` —— 流式中的 "AI 思考中..." / "已取消" / 错误提示都要 i18n key
- [ ] DraftPreviewCard / ToolCallRow 双主题视觉验证（light/dark 各跑一遍）
- [ ] 键盘 a11y：Tab 在 BackendSelector / Composer / send button 间走通，VoiceOver 报对

### Sprint 5 — 写操作 + 批量 AI 操作（**1.5-2 天**）

- [ ] `<Toolbar>` 详情页 — `✦ 起草回复` (coral fill 唯一 primary) + 翻译 / 重传 Notion / AI 重跑（ghost）
- [ ] CLI fork wrapper `src/electron/main/cli_runner.ts` — execa + JSON 解析 + 退出码→错误码 + stream stdout
- [ ] `email:resync` / `notion:update-flag` / `llm:run` IPC handler
- [ ] **`<BatchActionBar>` 52px** — 严格 paste from [DESIGN.md §5.4](./DESIGN.md)
  - 出现在 `selectedIds.length > 0` 时
  - AI 批量分类 / AI 批量起草回复 / 批量翻译 EN→中（coral text + coral/10 fill 三个 AI 头牌）
  - 维护 ops: 标已读 / 归档 / 重传 Notion（ghost）
  - 右边显示 `queued · est. ~4.2s · $0.018`
- [ ] 长任务（backfill body / batch resync）— 进度条 + SIGINT 二次确认 dialog
- [ ] Toast (shadcn) — top-right slide-in，3s auto-dismiss with progress bar

### Sprint 6 — 看板 + LLM dashboard + 设置（**1.5 天**）

- [ ] `/admin` 看板 — health + DB stats + dead-letter list（CLI `mailagent admin stats/health/dead-letter`）
- [ ] `/llm` dashboard — 处理状态分布 + cost 趋势（D3 / Recharts）+ cache hit rate
- [ ] `/calendar` 列表 — 周期会议 recurring discover/replay
- [ ] `/settings` 完整页：
  - API key 输入（keytar 写入）+ test ping 按钮
  - DB 路径（folder picker）
  - 附件根目录
  - 轮询频率 (5s / 10s / 30s / off)
  - 主题色（6 swatch 选）
  - Notion Agent page_id 绑定
  - Custom API endpoint + key
  - About + GitHub link

### Sprint 7 — Polish + 打包（**1.5 天**）

- [ ] 三态主题切换 UI（Settings → Appearance：Light / System / Dark segmented control + accent 6 swatch；[DESIGN.md §17.4](./DESIGN.md)）；执行 `pnpm a11y:contrast` 验证 18 组合（6 accent × 3 mode）全 WCAG AA 通过
- [ ] i18n 完整 review：所有 JSX 字符串走 `t()`；存量 `[TODO en]` ≤ 0；切语言（System / 简体中文 / English）实测；Island plugin Python 端 envelope title/preview 也从 `~/.mailagent/plugins/ping_island/locales/{lang}/island.json` 读
- [ ] 全局快捷键注册（[DESIGN.md §9.5](./DESIGN.md) 全表，从 `shared/keymap.ts` 单一 SSoT 读）
- [ ] `?` 弹出快捷键 help 模态
- [ ] CommandPalette `⌘K`（shadcn `<Command>`）— 模糊搜邮件 / 切 mailbox / 跳设置
- [ ] 错误 toast / loading 骨架屏统一
- [ ] Empty state（空收件箱 / 零结果）
- [ ] `electron-builder` macOS .dmg ad-hoc 签名（先不公证）
- [ ] auto-updater (electron-updater + GitHub Releases)
- [ ] README + 安装指南

**V1 ship checklist**:
- ✅ Inbox 三栏正常打开 + 列表能加载
- ✅ 详情页 HTML 渲染（沙箱）+ AI Fields + 附件
- ✅ AI Chat panel：Notion Agent 默认能用 + Custom API 切换
- ✅ 翻译 EN→中能跑
- ✅ 批量 AI 操作能跑（至少 AI 批量分类）
- ✅ 全文搜索能跑
- ✅ 主题色切换能跑（6 色）
- ✅ 设置页 keytar / DB 路径 / Notion Agent 绑定能用
- ✅ 全局快捷键 J/K/R/⌘K 能用
- ✅ macOS .dmg 能装能跑
- ✅ Lint: `pnpm lint:design` 0 violation（[DESIGN.md §14](./DESIGN.md) 八条非协商）

---

## 3. L2 Island Hybrid Sprint 拆分（~6-10 天）

详细技术细节见 [`ISLAND-PLUGIN.md`](./ISLAND-PLUGIN.md)。Sprint 列表：

### Island-Sprint 1 — fork ping-island + 加 `.mail` brand（**2-3 天 Swift**，REVIEW-LOG H-10 重估）

> 原估 1.5-2 天偏低。加 `MailAgentSessionView.swift` 至少骨架后实际 6 个文件 ~150-300 行 diff。

- [ ] `git clone https://github.com/ChenyqThu/ping-island.git mailagent-island`
- [ ] 添加 upstream remote 便于后续 rebase
- [ ] `Prototype/Sources/IslandShared/Models.swift` — `AgentProvider` enum 加 `.mail`
- [ ] `PingIsland/Models/ClientProfile.swift` — `SessionClientBrand` 加 `.mail`
- [ ] 加 ClientProfile registry entry：`id="mailagent", title="MailAgent", brand=.mail, ...`
- [ ] Mascot 资源 — 至少 3 个 pixel-art 头像（Work / Personal / Dev account）
- [ ] `xcodebuild` 验证编译通过
- [ ] 本地装 `.app` 测试 ping-island 能识别 .mail brand（用 `nc -U /tmp/island.sock` 手发 envelope）

### Island-Sprint 2 — MailAgent 仓内 plugin 主体（**2-3 天 Python**，REVIEW-LOG H-09 拆 4 文件）

- [ ] `src/notify/ping_island.py` — socket writer（**显式 settimeout(3.0)** REVIEW-LOG H-16）+ envelope builder + Swift Date 编码（`sent_at = time.time() - 978307200`）
- [ ] `src/notify/island_dispatch.py` — 4 个事件源 → envelope 构建 → 调 ping_island.send()
- [ ] `src/notify/island_response.py` — BridgeResponse 回灌处理；正确 AppleScript 语法（REVIEW-LOG H-12）
- [ ] `src/notify/island_snooze.py` — snooze 队列 + 轮询 re-emit
- [ ] **`src/notify/island_reconnect.py`（REVIEW-LOG H-17 新增）** — 5min 检查 socket 文件存在 + send queue (max 20) + exponential backoff
- [ ] 4 个事件挂钩：`mail/new_watcher.py:_sync_single_email_v3` + `llm_agent/runner.py` + `events/handlers.py` + `sync_store.mark_failed`
- [ ] `~/.mailagent/plugins/ping_island/` 安装：plugin manifest + mascot 资源软链 + 配置文件
- [ ] `.env` 加 `PING_ISLAND_ENABLED=false`（默认关）+ `PING_ISLAND_SOCKET_PATH`
- [ ] `island_dispatch` SQLite 表（评估指标用）
- [ ] pytest 覆盖（mock socket）+ test_island_send_sets_timeout + test_reconnect_after_socket_unlink

### Island-Sprint 3 — 跳转 + intervention（**1-2 天 Python**）

- [ ] BridgeResponse 解析 — 用户在灵动岛点的 option dispatch
- [ ] `open_mail` 选项：`osascript -e 'tell app "Mail" to ...'` 打开邮件
- [ ] `open_notion` 选项：`open notion://...` deep-link
- [ ] `create_draft` 选项：调 `mailagent` CLI 创建草稿（复用现有 flow）
- [ ] `snooze_1h` 选项：写 `data/snooze.json` + 1h 后重新 emit envelope
- [ ] `mark_done` 选项：调 `mailagent notion update-flag --processing-status 已完成`

### Island-Sprint 4 — 与 V1 Electron 端到端联调（**1-2 天 Swift + Python**）

- [ ] V1 Electron main 进程加 `island.send()` wrapper（IPC + python subprocess 或直接 unix socket）
- [ ] 真实邮件全链路测：新邮件 → AI Reviewed Urgent → ping-island Phase 1 展开 → Phase 2 dock → hover Phase 3 → click 跳 Mail.app
- [ ] 主题色同步 — Electron 主题色变化 broadcast 到 ping-island
- [ ] mascot 切换（Work / Personal / Dev）配置 UI

### Island-Sprint 5 — Polish + distribution（**1-2 天**）

- [ ] `scripts/build.sh` 出 .dmg
- [ ] GitHub Actions release pipeline
- [ ] Sparkle 自动更新接 fork 的 appcast
- [ ] 写 README 说明 fork 与 upstream 的 diff（diff stat + 哪些文件改了）
- [ ] 月度 rebase upstream 流程文档

**Island ship checklist**:
- ✅ 真实 .mail brand session 出现在 ping-island session list
- ✅ MailAgent mascot 显示
- ✅ 4 phase 生命周期跑通
- ✅ 点击跳 Mail.app / Notion
- ✅ Buddy 离岛模式带 unread count
- ✅ 失败 fail-open（ping-island 没跑时 mail-sync 不受影响）
- ✅ Upstream rebase 流程实测一次

**与 V1 的依赖**：仅 Island-Sprint 4 需要 V1 Electron 已 ship；Island-Sprint 1-3 完全独立可以 Day 1 起。

---

## 4. L3 V2 远程访问 Sprint 拆分（~4-6 天）

详细技术细节见 [`REMOTE-ACCESS.md`](./REMOTE-ACCESS.md)。Sprint 列表：

### V2-Sprint 1 — 本地 FastAPI 骨架（**1.5 天**）

- [ ] `src/api/app.py` + middleware + auth (Cloudflare Access JWT 校验)
- [ ] `src/api/routers/email.py` — list / get / body / search
- [ ] `src/api/cli_runner.py` — subprocess wrapper
- [ ] PM2 ecosystem 配置：`mailagent-api` 与 `mail-sync` 并存

### V2-Sprint 2 — 端点全集 + 附件 stream（**1 天**）

- [ ] `attachment` / `llm` / `admin` 路由
- [ ] StreamingResponse 附件下载（Range 头支持便于断点续传）
- [ ] pytest fixture 跑一遍

### V2-Sprint 3 — Web build target + data layer abstraction 真用（**1.5 天**）

- [ ] `frontend/vite.web.config.ts` + `src/web/main.tsx` 入口
- [ ] `HttpApi` 实现 — fetch + cookie/JWT + 错误码→Error 类
- [ ] 全 React 组件 review — 确保只走 `useMailApi()`，无 `window.electron.*` 直引
- [ ] `npm run dev:web` 起来跑通 list + detail + search 三个核心页

### V2-Sprint 4 — Cloudflare Tunnel + Access + PWA（**1 天**）

- [ ] `cloudflared` 装 + tunnel 创 + DNS 配 (`mail.chenge.ink` → `127.0.0.1:8200`)
- [ ] Cloudflare Access 配 OAuth + email 白名单
- [ ] FastAPI middleware 校验 Cf-Access-Jwt-Assertion
- [ ] PWA manifest + workbox service worker
- [ ] iOS Safari "添加到主屏幕"实测（iPhone + iPad）

### V2-Sprint 5 — 部署 + Polish（**1 天**）

- [ ] Cloudflare Pages 接 GitHub repo（web build → `gh-pages` branch 自动部署）
- [ ] 远端 SLO 测试（iPad / iPhone 实跑一遍）
- [ ] CSP / CORS / 安全 checklist 逐条验
- [ ] 文档 / README / .env.example 更新

**V2 ship checklist**:
- ✅ iPad 浏览器打开 `mail.chenge.ink` → OAuth → 进 inbox
- ✅ iPad 添加到主屏幕 → 启动伪原生
- ✅ 详情页 / 搜索 / 标完成 / 重传 都能用
- ✅ 附件 stream 下载能用
- ✅ FastAPI 二次 JWT 校验防护到位

**与 V1 的依赖**：必须 V1 Sprint 5（写操作 + 批量 + 数据层完整）完成才能起 V2-Sprint 3（共享 React）；V2-Sprint 1/2 可以 V1 Sprint 5 之后立刻起，但 V2-Sprint 3 必须 V1 完整。

---

## 5. 并行开发指引

### 5.1 谁能并行做什么

| 阶段 | L1 V1 | L2 Island | L3 V2 |
|---|---|---|---|
| Day 1-2 | Sprint 0 工程脚手架 | **Island-Sprint 1**: fork + .mail brand | ⏸ 等 |
| Day 3-5 | Sprint 1-2 数据层 + Inbox | **Island-Sprint 2**: Python plugin | ⏸ 等 |
| Day 6-9 | Sprint 3 搜索 + 翻译 | **Island-Sprint 3**: 跳转 + intervention | ⏸ 等 |
| Day 10-11 | Sprint 4 AI Chat panel | （上一步收尾） | ⏸ 等 |
| Day 12-13 | Sprint 5 批量 AI 操作 | **Island-Sprint 4**: 与 V1 联调 | **V2-Sprint 1-2** FastAPI 骨架可起 |
| Day 14-15 | Sprint 6-7 看板 + polish + 打包 | **Island-Sprint 5**: distribution | **V2-Sprint 3** Web target |
| Day 16-18 | V1 ship + bug fix | （已 ship） | **V2-Sprint 4-5** Tunnel + PWA + 部署 |

### 5.2 单人开发节奏

如果一个人开（最常见），策略：
- **优先 L1 V1 直到 Sprint 4 末**（AI Chat panel 是 headline，是用户最看重的体验）
- **Sprint 5 起加入 L2 Island Sprint 1-2**（fork + plugin，2 天，可碎片时间做）
- **L1 V1 ship 后启动 L3 V2** + 完成 L2 联调

预估总时长 **15-21 天**（含 bug fix 与 polish）。

### 5.3 多人开发（理想）

- **A 全包 L1 V1**（~12-16 天）— React + Electron 主线
- **B 全包 L2 Island**（~6-10 天）— Swift fork + Python plugin
- **A 完成 V1 后接 L3 V2**（~4-6 天）

**理想总时长 ~16 天**（最长线 V1 完工 + 5 天 V2 收尾，Island 已 ship）。

### 5.4 跨线协调点

| 协调点 | 涉及线 | 内容 |
|---|---|---|
| 主题色 token | L1 + L2 | DESIGN.md §2.7 定 6 色；L2 plugin envelope 含 accent；保持 localStorage `mailagent.accent` 是 source |
| 三态主题 (light/dark/system) | L1 + L2 + L3 | DESIGN.md §17；L1 写入 localStorage `mailagent.themeMode` + 同步 Electron `nativeTheme`；L2 Island plugin 收 `theme` broadcast；L3 Web SPA 各端 `prefers-color-scheme` 独立 |
| i18n locale | L1 + L2 + L3 | DESIGN.md §16；L1 默认 system locale；L2 plugin Python 读 `~/.mailagent/plugins/ping_island/locales/{lang}/island.json`；L3 Web SPA 走 `Accept-Language` header / `navigator.language`；envelope title/preview 必须 i18n |
| Mascot 资源 | L1 + L2 | L2 fork 内带资源；L1 settings 页提供选择 UI；选择写到 plugin 配置 |
| AI 事件协议 | L1 + L2 | L2 接收 `ai-draft-start/stream/ready` 事件；L1 在 AI Chat panel start/stream/end 时 emit |
| data layer abstraction | L1 + L3 | L1 Sprint 0 起就用 `useMailApi()`；L3 Sprint 3 实现 HttpApi 时直接复用 |
| CLI 退出码契约 | L1 + L3 | 共享 `docs/cli-schema/error-codes.md`；L1 main + L3 FastAPI 都映射到统一错误 |

---

## 6. 风险 / 缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Notion Agent CLI (`notion-agent-cli`) 行为不稳定 | 中 | 中 | **Sprint 0 启动前** PoC 验证 `--json --stream` + tool-call response（REVIEW-LOG M-05）；fallback 路径 Custom API |
| better-sqlite3 跨 Electron 版本 binary 兼容 | 低 | 中 | `electron-rebuild` 自动 |
| ping-island upstream 主分支大改 | 中 | 中 | fork minimal（6 文件 ~150-300 行 diff，REVIEW-LOG H-10），rebase 容易 |
| Cloudflare Access JWT 校验复杂度（key rotation） | 中 | 高 | **REVIEW-LOG C-01 已修**：`PyJWKClient` 按 kid 缓存 + unknown 自动 refresh |
| 邮件 HTML 含恶意 JS / phishing 链接 | 高 | 高 | sandboxed iframe + DOMPurify + 阻止外链跳出 + 显示确认 dialog |
| AI panel 流式 token 卡顿 | 中 | 低 | Electron main IPC chunk stream + renderer 增量 setState；避免每 token 重渲染整个 message list |
| **AI Chat panel 写回 11 AI fields 与 Notion Custom Agent 冲突**（REVIEW-LOG H-15）| 中 | 中 | Sprint 4 前确认 Notion Email Agent 已关或 prompt 已限 `Processing Status = 未处理`；验证 Sprint 4 用例 |
| 大邮箱（6000+）列表初次加载卡 | 高 | 中 | `react-window` 虚拟滚动 + 后端 LIMIT/OFFSET 分页 |
| Mac 关机 → 远端 V2 断 | 高 | 中 | `caffeinate -d -i -m -s` 常驻；外接显示器 |
| Designer mockup 与 backend schema 错配 | 中 | 中 | Sprint 1 末做一次 schema/mockup 对账（8 AI fields V1 + 3 V1.5 候选 / Processing Status enum / 5 priority，REVIEW-LOG H-14）|
| **macOS sleep/restart 后 Island socket 静默丢通知**（REVIEW-LOG H-17）| 高 | 低 | `island_reconnect.py` 5min probe + send queue + exponential backoff |
| **Mockup 仅 dark mode，light mode 视觉无人出**（REVIEW-LOG C-08）| 高 | 中 | Sprint 1 末 spot-check 5 个核心组件；视觉崩坏立即修 token；Sprint 3 末跑 a11y 12 组合 lint |

---

## 7. 不在本计划范围

- ❌ 后端 schema 变更 — mail-sync 已稳定 v4
- ❌ AI Chat panel 历史会话搜索 / 跨邮件全文搜（V1.5）
- ❌ Calendar 双向同步 UI（后端只读 → 前端只读列表）
- ❌ Mobile native（PWA 足）
- ✅ **i18n 双语 (zh-CN + en-US) 是 V1 一等公民**（详 DESIGN.md §16），更多语言扩到 V2
- ✅ **三态主题 light/dark/system 是 V1 一等公民**（详 DESIGN.md §17），默认 system 跟随
- ❌ RTL (阿拉伯 / 希伯来) — V3+ 议题
- ❌ 主题深度自定义（仅 6 swatch，不开自由调色 / 不开自定义明暗 token）
- ❌ AI Chat 自带 RAG / 向量库（走 Notion Agent / Custom API 现有能力）

---

## 8. Sprint 启动前 checklist

V1 Sprint 0 启动前要确认：

- [ ] Node 20 + pnpm 9 装好
- [ ] `notion-agent-cli` 装好（`pipx install notion-agent-cli`）并验证 **`notion-agent chat <prompt> --json --stream` 跑通流式 + tool-call response 至少 1 个 tool 调用回执**（REVIEW-LOG M-05 — 原 checklist 只验 `--json` 不验 stream）
- [ ] Notion Custom Agent 已建好，拿到 `agent_page_id`
- [ ] **关 Notion Email Agent automation 或加 prompt 限 `Processing Status = 未处理`**（REVIEW-LOG H-15 —— 防 AI Chat 写回字段与 Notion automation 双跑撞车）
- [ ] Cloudflare 账号已登（V2 需要）
- [ ] Apple Developer 证书评估（V1 ad-hoc 签名先够，公开 release 才需要 $99/y）
- [ ] git 仓库 `frontend/` 子目录已就位（mockups + DESIGN.md 已在）
- [ ] `.env.example` 加 V1 / V2 / Island 全套配置项（mockup 设置页提示用户填什么）
- [ ] **v4 SQLite-SSoT Phase 4 灰度切完**（REVIEW-LOG L-06）：`NOTION_READ_FROM_SQLITE=true` 至少 3 封实测 OK，避免 V1 启动撞 Phase 4 灰度期

Island Sprint 1 启动前要确认：

- [ ] Xcode 16+ 装好
- [ ] `https://github.com/ChenyqThu/ping-island.git` fork 已 ready（已 done 2026-05-16）
- [ ] Mascot 3 张 pixel art 设计稿就位（可用 AI 生成 + Aseprite 微调）

V2 Sprint 1 启动前要确认：

- [ ] L1 Sprint 5 完成（写操作 + CLI runner 沉淀，FastAPI cli_runner 直接复用）
- [ ] Cloudflare Tunnel 账号 + Zero Trust 已开（免费 plan 足）
- [ ] domain `chenge.ink` DNS 在 Cloudflare（已有）
- [ ] iPad / iPhone 实机能装测试 PWA

---

> Sprint 启动以 `git commit -m "Sprint 0 kickoff"` 为节点。每个 Sprint 完工前 review 一次本计划，发现新风险或漏项立刻更新本文档。
