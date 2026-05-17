# Sprint 2 Handoff — Inbox 三栏

> 起 Sprint 2 时把这段 paste 给新 session（或 `/clear` 后 `@frontend/SPRINT-2-HANDOFF.md`）。
> Ship 完后整篇删除（短命文档；不维护跨 sprint）。

---

## 上下文

- 仓库：`~/Documents/MailAgent`
- Sprint 1 ship：
  - `30c8b4c` feat(frontend): Sprint 1 — data layer + main framework
  - `d8fb544` feat(frontend): Sprint 1 — design-system lint rules + vitest suite
- 后端：mail-sync online (pm2)，v4 SSoT Phase 4 灰度切完 (`NOTION_READ_FROM_SQLITE=true`)
- 协作 CLI：`~/Documents/notion-agent-cli`（Sprint 4 才用，Sprint 2 不阻塞）

## Sprint 1 ship 的 → Sprint 2 可直接消费

**main 进程**
- `cli_runner.ts` (REVIEW-LOG C-02 完整版) — CliQueue 4r/1w + 11 退出码 + AbortController + before-quit cleanup（Sprint 5 写命令用，Sprint 2 暂未用）
- `handlers/email.ts` (list/get/body/search 4 IPC) + `handlers/attachment.ts` (list/localPath 2 IPC) — SQLite 直读 thin DAO，返回值已对齐 `cli.gen.ts` schema 形状（REVIEW-LOG C-03）
- `main/index.ts` 已 register 全部 handler + cli_runner lifecycle

**renderer 数据层**
- `shared/api/types.ts`：`EmailMeta = EmailList_EmailListItem` / `EmailDetail = EmailGet_EmailRecord` / `EmailBody = MailagentEmailBody.data` / `SearchHit = EmailSearch_SearchHit` / `AttachmentMeta = AttachmentList_AttachmentItem` 全接通
- `ElectronApi.ts`: `useMailApi().email.list/get/body/search` + `.attachment.list/localPath` 真跑 via `window.electron.ipcRenderer.invoke`
- `shared/state/{mailbox, batch, appearance}`：Zustand stores 就位
- `shared/components/layout/{TitleBar, StatusBar, Sidebar, SectionHeader, InboxLayout}`：主框架就位，`InboxLayout` 的 main slot 当前是 Sprint 1 placeholder card

**质量基础设施**
- 9 条 design lint rule 全 CI gate（`pnpm lint` 0 violation）
- vitest 47 测试全绿（handler functional + ajv schema validation + cli_runner concurrency + ESLint RuleTester）
- `pnpm test` = `vitest run`，`pnpm test:watch` = watch
- **`src/shared/types/cli.gen.ts` 是 gitignored** — fresh checkout 必须先跑 `pnpm gen:types`

## Sprint 2 任务（PROJECT-PLAN §2，2-3 天）

### EmailList 340px 列
- `<EmailList>` 容器：列头（mailbox name + filter chips：未读 / 已标 / 失败 / 全部）+ virtualized rows
  - 装 `react-window`：`pnpm add react-window @types/react-window`
- `<EmailRow>` —— **严格 paste from DESIGN.md §5.1**（已有完整代码 + cn / Badge variant / className）
  - 1.5px unread coral dot / lang pip / paperclip + count / AI priority chip / AI action chip
  - 失败行 SYNC FAILED pill
  - selected 状态 3px coral 左边
- `<AIBadge>` —— **严格 paste from DESIGN.md §5.2**（5 个 priority variant + withDot prop）
- 数据：`useQuery(['emails', mailbox], () => useMailApi().email.list({ mailbox, limit: 100 }))`
- 键盘 J/K 切邮件（接 `shared/state/mailbox` 的 active 字段 → 新加 `activeInternalId` 或单独建 `state/active-email.ts`）

### EmailDetail flex-1 列
- `<EmailDetail>` —— toolbar + body + AI Fields block + 附件
- `<Toolbar>` —— Sprint 5 才接 actions，Sprint 2 ship UI shell：
  - 主按钮 `✦ 起草回复` 用 `bg-coral/100`（lint no-coral-flood 要求 alpha 显式）
  - ghost 按钮：翻译 / 重传 / AI 重跑
- 邮件正文：sandboxed iframe（`srcdoc` + `sandbox="allow-same-origin"`）+ DOMPurify
  - 装 DOMPurify：`pnpm add dompurify @types/dompurify`
- Inline image (cid:) 替换为本机 `file://` 路径（用 `attachment:localPath` IPC + `webPreferences.sandbox: false` 已开）
- `<AIFieldsBlock>` (3×8 grid) — **REVIEW-LOG H-14 修订：V1 是 8 个不是 11 个**
  - AI Action / AI Priority / AI Review Status / Sentiment / Processing Status / Is Read / Is Flagged / Mailbox
  - V1.5 候选 Action Items / Tags / Translated Body 不渲染

### 5s 轮询 + new row badge
- react-query `refetchInterval: 5000` for `['emails']`
- 比较 prev / next list，新 internal_id 加 `NEW` badge（2s 后 fade）

### Sprint 末必做
- Sidebar 接通真实 mailbox list（`SELECT DISTINCT mailbox, COUNT(*) FILTER (WHERE is_read=0) FROM email_metadata GROUP BY mailbox`），unread count 显在 row 右边
- 把 InboxLayout 的 main slot 换成 `<EmailList />` + `<EmailDetail />` 两栏（min-width 940px = sidebar 240 + list 340 + detail flex-1 + 余 360 预留 Sprint 4 AI panel）
- **Light mode visual spot-check**（REVIEW-LOG C-08）：EmailRow / AIBadge / Toolbar 在 light/dark 各跑一遍
- i18n 字符串 review：扫存量 `[TODO en]` 应 0
- 单测：
  - EmailRow render snapshot — dark/light × selected/unselected × unread/read × failed/normal 8 组合
  - 5s 轮询不饿死 IPC：fire 多个 list 调用看是否在 4r 限流内
  - DOMPurify 真清掉 `<script>` / `onclick=` 等 vectors

## 注意事项

- **不要碰后端 schema**（v4 SSoT 已稳）
- `<EmailRow>` 完整代码在 DESIGN.md §5.1 —— 直接 paste，不要重新设计
- `<AIBadge>` 完整代码在 DESIGN.md §5.2
- `text-coral` / `bg-coral` 单独使用 = lint error（no-coral-flood 要求 `/15` 等 alpha 后缀 或 `/100` 显式声明）—— DESIGN.md §14 #8
- 任何 CJK 文字 className 含 `text-micro` / `text-meta` = lint error（no-cjk-in-mono-size）
- iframe 不能 `sandbox="allow-scripts"` —— XSS 风险，DOMPurify 一定要先过
- `pnpm gen:types` 任何时候 schema 变了就跑（cli.gen.ts gitignored）

## 协作模式（项目级 memory 已记）

- opus 4.7 单线主开发，全程 context
- 独立子任务（EmailList + EmailDetail + AIFieldsBlock 三件可并行）→ ultrawork
- 长 IO（`pnpm test --watch` / playwright）→ `run_in_background`
- Sprint 末 codex review 走 `omc ask codex` 或 `collaborating-with-codex` skill（**禁** `codex:codex-rescue` agent）
- 完工后直接 commit（feedback memory 已记，允许 atomic commit 不需问）
- 别动后端 schema

## issue 跟踪

- 开发中遇到的小坑 / TODO → 写 `frontend/NOTES.md`，一行一条带 ISO 日期
- 跨 session / 阻塞 / 需后端配合 → `gh issue create`（label: `area:frontend`）
- Sprint 末把 NOTES.md TODO 清一遍

## 第一步建议

1. `pnpm dev` 跑通看 Sprint 1 主框架窗口（TitleBar + Sidebar + StatusBar + 空 main）
2. 列 Sprint 2 任务依赖图 + 找出阻塞 / 待澄清
3. 从 **EmailList** 开始 —— 它定义 active selection，EmailDetail 才有源
4. EmailDetail 与 EmailList 是双向依赖 — active state 来回切，可以拆 `useActiveEmail()` hook 抽出共享逻辑

ultrathink everything. 多花 token 也要找透。
