# Sprint 13 Handoff — EmailDetail + AIChatPanel 按 ref 设计系统实现

> Sprint 12 已 ship：is_important e2e（reader → SQLite v9 → repo → IPC → EmailRow ❗）
> + v8 pinned 持久化（pinned / group-collapse store + 「📌 已固定」分组）
> + Sprint 11 chrome 收尾 polish + SQLite SSoT inversion 战略 TODO 标记。
>
> Sprint 13 = 把 inbox 右侧 **EmailDetail（阅读 pane + popout 窗口）** 和
> **AIChatPanel（AI 聊天面板）** 按 `frontend/ref/DESIGN.md` §5.3 / §6 +
> `mockup-detail-window.html` + `mockup-inbox.html` 中央/右列 完整落地。
>
> **启动前最少读完**：§0 TL;DR + §3 工作目标 + §5 验收清单 + §6 启动 prompt

---

## 0. TL;DR

| 项 | 值 |
|---|---|
| Sprint 12 已 ship | (a) `is_important` 端到端：reader `_parse_importance` 三 header 归一 → SQLite v9 migration → `EmailRepository.is_important` + 排序权重 → IPC `EnrichedEmailMeta.is_important` → `EmailRow` ❗ AlertCircle 圆形线性 icon；(b) v8 pinned 持久化（`pinned.ts` / `group-collapse.ts` zustand store + `usePinnedSync` + `BatchActionBar`）；(c) Sprint 11 chrome 11 项收尾 polish；(d) `frontend/NOTES.md` + `EmailRow.tsx` 标 deprecated breadcrumb：notion.updateFlag 反向同步链路待 SQLite SSoT inversion 阶段废弃 |
| Sprint 13 目标 | **EmailDetail（inbox 阅读 pane + popout 窗口）+ AIChatPanel + 它们的所有 subcomponent** 按 `ref/DESIGN.md` §5.3 / §6 + `mockup-detail-window.html` + `mockup-inbox.html` 中央/右列对照刷一遍 |
| 设计 SSoT | `frontend/ref/DESIGN.md` V1.4 §5.3（AIChatPanel）§6（AI chat conventions §6.1-6.8）§5.1（EmailRow，已交付参照）+ `mockup-detail-window.html`（622 行 popout reader）+ `mockup-inbox.html` 3495 行（中央 EmailList + 右列 EmailDetail + AI panel）|
| 阀门 | typecheck 0 / lint 0 / vitest 全绿 / a11y `pnpm a11y:contrast --strict` clean / 新加测试自走全过 |
| 工作模式 | Claude Opus 4.7 max-effort 单线；按页面/组件原子 commit，每个 commit 自带验收证据 |
| 禁动区 | 见 §4 — TitleBar / Sidebar / StatusBar / 路由树 / glass / accent / theme / locale / nav-shell store 不动；不绕过 `notion.updateFlag` 路径（保留 deprecated 现状，等 SQLite SSoT inversion sprint） |

---

## 1. Sprint 12 已 ship deliverables（本 session）

### 1.1 `is_important` 端到端（reader → SQLite → 前端 ❗）

| 层 | 改动 |
|---|---|
| `src/mail/reader.py` | 新增 `_parse_importance(Importance, X-Priority, X-MSMail-Priority)` 三 header 归一到 bool；`parse_email_source` 出参带 `is_important` |
| `src/models.py` | `Email.is_important: bool = False` |
| `src/mail/sync_store.py` | **DB_VERSION 8 → 9**：v9 migration ALTER TABLE 加 `email_metadata.is_important INTEGER DEFAULT 0` + 部分索引 `idx_email_is_important WHERE is_important = 1`；`save_email` keys 列表加 is_important |
| `src/mail/new_watcher.py` | `_sync_single_email_v3` 解析后写库时带 is_important |
| `src/repository/email_repository.py` | `EmailMetadataRecord` 加 `is_important: bool = False`；`get_metadata` + `list_metadata` SELECT + dataclass 构造 + `is_important: Optional[bool]` 过滤参数 + `ORDER BY is_pinned DESC, is_important DESC, date_received DESC` |
| `frontend/src/electron/main/handlers/email.ts` | `EmailMetadataRow.is_important`、`LIST_COLS` / `ENRICHED_LIST_COLS` 加列、`shapeEnrichedItem` 透传 `is_important` |
| `frontend/src/shared/api/types.ts` | `EnrichedEmailMeta.is_important: boolean` |
| `frontend/src/shared/components/email/EmailRow.tsx` | `important = email.is_important === true`（与 LLM 推断的 `ai_priority` 解耦）；❗ icon 从三角形 warning 换成 **❗️ 同款圆形线性 icon**（外圈 r=10 circle + 感叹号竖线 + 底部实心点） |
| 测试 | fixture `is_important: true` 默认 + 8 个 snapshot 反映新 icon path；`tests/fixtures/sync-store-fixture.ts` 补 `is_pinned / pinned_at / is_important` 列避免 ABI rebuild 后 DAO 测试 OperationalError |

**验收**：
- pytest 82/82（`tests/mail/test_sync_store_v6_migration.py` + `tests/repository/`）
- 生产 `data/sync_store.db` v9 migration 已跑过：`db_version=9`，`is_important` 列存在
- vitest `EmailRow.test.tsx` 14/14、8 snapshot 更新
- tsc `--noEmit` 0 错

> **重启服务前提**：`pm2 restart mail-sync`，让 SyncStore v9 migration 在生产
> 启动时 ALTER TABLE。若没重启过，新邮件 is_important 列只在 backfill 后才有
> 数据 —— EmailRow 短期会显示「无重要邮件」属正常。

### 1.2 v8 pinned 持久化

新增文件：
- `frontend/src/shared/state/pinned.ts` — zustand store + `usePinned`
- `frontend/src/shared/state/group-collapse.ts` — 「📌 已固定」分组折叠状态
- `frontend/src/shared/hooks/usePinnedSync.ts` — `useTogglePin` mutation（SQLite SSoT，CLI 写）
- `frontend/src/shared/components/email/BatchActionBar.tsx` — 多选批量操作 bar

EmailList 整合：「📌 已固定」分组（pinned_at DESC）+ 「📥 收件箱」分组，分组可折叠。EmailRow `ricon-pin` 按钮接通 `useTogglePin`。

### 1.3 Sprint 11 chrome 11 项收尾 polish

`AIFieldsBlock` / `MessageList` / `QuickActions` / `Sidebar` / `StatusBar` /
`ThemePickerPopover` / `EmailList` / `email-filter` / `batch` state 全部迭代
（具体见 `git show 5d48448` 范围 diff）。chrome 三块本身已稳定，本次只动业务区域。

### 1.4 SQLite SSoT inversion 战略 TODO

- `frontend/NOTES.md` 2026-05-19 strategic 条目：完整描述 4 步迁移面 a/b/c/d
- `EmailRow.tsx` 头部 module 注释加 deprecated breadcrumb 指 NOTES
- `~/.claude/projects/.../memory/project_sqlite_ssot_inversion.md` 长期 memory
- **当前行为不动** —— Sprint 13 也不要绕过 `notion.updateFlag`，等 SQLite SSoT
  inversion 独立 sprint 一起改

---

## 2. 当前组件现状（Sprint 13 工作面）

### 2.1 EmailDetail 家族（`frontend/src/shared/components/email/`）

| 文件 | 当前状态 | mockup 对照 |
|---|---|---|
| `EmailDetail.tsx` | 大组件，工具栏 + iframe body + AI fields + 附件全 inline 渲染 | `mockup-inbox.html` 右列 + `mockup-detail-window.html` 全文 |
| `EmailToolbar.tsx` | 4 ghost button + resync confirm dialog（Sprint 5）| `mockup-detail-window.html` header（`← Inbox` + `chip-crit` + ⌘K + theme/accent cluster）|
| `EmailBodyFrame.tsx` | sandboxed iframe + DOMPurify | mockup body 区域（无 chrome diff） |
| `AttachmentList.tsx` | 已有 Sprint 2 实现 | `mockup-detail-window.html` line 493+ "attachments" 区块 |
| `ThreadSidebar.tsx` | 兄弟邮件列表（Sprint 3）| mockup 暂无独立 thread sidebar — 是否合并到 EmailDetail 顶部待决 |
| `TranslatedBody.tsx` | Sprint 3 翻译产物 | 暂保留 |

### 2.2 AIChatPanel 家族（`frontend/src/shared/components/chat/`）

| 文件 | 当前状态 | DESIGN.md / mockup 对照 |
|---|---|---|
| `AIChatPanel.tsx` | Sprint 4 ship，Notion Agent + Custom API 双 backend，主流程跑通 | §5.3（panel 骨架）§6.1（backend selector）§6.4（action item card）§6.5（draft preview card）|
| `BackendSelector.tsx` | 二选一切换 | §6.1 — never more than one selected |
| `Composer.tsx` | textarea + footer + ⌘↩ send | §6.6 + `mockup-inbox.html:2520` placeholder |
| `MessageList.tsx` | 消息流 + tool-call rows + streaming cursor | §6.2 bubble shape + §6.3 tool-call rows + `mockup-inbox.html:351` "AI panel — message thread + tool-call lines + streaming cursor" |
| `QuickActions.tsx` | Sprint 5 quick chips | §6.7 — quick action chips |
| `ContextChips.tsx` | Sprint 4 context indicator | mockup AI panel 顶部 |

### 2.3 mockup 关键 anchor（精读必看）

- `frontend/ref/mockup-detail-window.html` **L254-318**（header chrome：red-light + `← Inbox` 链 + subject + chip-crit + ⌘K + theme/accent picker）
- `frontend/ref/mockup-detail-window.html` **L319-622**（main：`<main class="glass-3 min-h-full">` + sections：from/to/cc/date + ai fields block + body 区 + attachments）
- `frontend/ref/mockup-inbox.html` **L351-** AI panel 区块（`/* AI panel — message thread + tool-call lines + streaming cursor */`）
- `frontend/ref/mockup-inbox.html` **L2259** internal_id + message_id 元信息线
- `frontend/ref/mockup-inbox.html` **L2520** AI composer placeholder（i18n hardcode 参考）

---

## 3. Sprint 13 工作目标（按优先级）

### 3.1 EmailDetail（inbox 右列阅读 pane）

按 `mockup-inbox.html` 右列 + `ref/DESIGN.md` §5（component catalog）：

1. **EmailToolbar** 按 `mockup-detail-window.html:254-318` 风格统一（不破坏 popout 复用）
   - subject + AI priority chip 同行
   - ⌘K 触发 CommandPalette（chrome 已实装，这里只是入口位置调整）
   - resync / draft / archive / star 按钮顺序与 mockup 对齐
2. **AI Fields Block**（from/to/cc/date + AI labels + reply suggestion）按 §5 排版规范（密度 / typo / chip 色系）
3. **EmailBodyFrame** 边界 + glass-3 容器 + 滚动条样式
4. **AttachmentList** 按 mockup line 493+ 重做：file-type icon + size + derived-from 二级提示
5. ThreadSidebar：决定保留独立 sidebar 还是收到 EmailDetail 顶部 thread strip（mockup 偏后者）

### 3.2 EmailDetail Popout 窗口

`mockup-detail-window.html` 是 622 行的完整 popout 设计（独立窗口 + 自己的 mini chrome）。当前没有 popout 实现 —— 需要：
- 新 IPC `window:open-email-detail({internalId})` → main process `new BrowserWindow` + `loadURL` 带 hash 或 query
- 新路由 `/email/:internalId` 走独立 `EmailDetailWindowLayout`（无 Sidebar/StatusBar）
- 复用 `EmailDetail.tsx` 主体，外壳替换为 popout chrome（`← Inbox` 链 = `window.close()` + 通知 inbox 重新 focus 该邮件；fallback 走 `mockup-detail-window.html:263` 的 `onclick="if(window.opener){window.close();return false;}"` 模式）

### 3.3 AIChatPanel polish

按 `ref/DESIGN.md` §5.3 + §6.1-6.8 + `mockup-inbox.html:351+` AI panel 区块：

- §6.2 bubble shape：用户气泡 + AI 气泡视觉分层
- §6.3 tool-call rows：folded by default，点击展开 stdout/duration
- §6.4 action item card：AI 输出建议的「下一步」卡片
- §6.5 draft preview card：AI 生成回复时的草稿卡片 + 「📝 创建草稿」按钮（已有 Path A，沿用 [[reference_mailagent_issue_tracking]] 里记录的 rich text 双路径）
- §6.6 composer：textarea + footer + ⌘↩ 提示 + backend chip 钉右
- §6.7 quick action chips：top of panel
- §6.8 batch AI ops：与 `BatchActionBar` 联动（多选时 AIChatPanel 顶部出现 batch banner）

### 3.4 EmailDetail ↔ AIChatPanel 联动

mockup 中 AIChatPanel 是 EmailDetail 右下半 / 可折叠面板。要决定布局：
- **方案 A**：固定 3 列（Sidebar / EmailList / EmailDetail）+ AIChatPanel 作 EmailDetail 内部 tab 或可折叠 sub-pane
- **方案 B**：4 列（Sidebar / EmailList / EmailDetail / AIChatPanel），AIChatPanel 独立列可宽度拉伸

`mockup-inbox.html` 整体宽度 + AI panel 位置应该能直接读出来。**Sprint 13 第一步**：精读 mockup-inbox 整页布局 + 量化各列宽度 +
得出方案，再动手。

---

## 4. 禁动区（继承 Sprint 11/12，未明确指示不要碰）

- TitleBar / Sidebar / StatusBar 三块 chrome 本身
- Liquid Glass / wallpaper / accent token / theme token / locale 切换
- 路由树骨架（`/admin/*` 嵌套 + `validateSearch`）— Sprint 13 可加 `/email/:id` popout 路由，但不改 inbox 主路由 contract
- nav-shell store / account helper / keymap
- **`notion.updateFlag` 反向同步链路** — Sprint 13 不要改它，等 SQLite SSoT inversion 独立 sprint。如 EmailDetail
  flag/archive/done 按钮要接通，沿用现状 `mailApi.notion.updateFlag(...)` + 头部加同款 deprecated breadcrumb
- SyncStore DB schema —— Sprint 13 是纯前端 polish，不动 v9 之后的迁移

---

## 5. 验收清单

每个 commit ship 前自检：

- [ ] `pnpm typecheck` 0 错
- [ ] `pnpm lint` 0 错
- [ ] `pnpm vitest run` 全绿（如新增组件 → 至少 1 个 snapshot 测试 + 1 个交互测试）
- [ ] `pnpm a11y:contrast` `--strict` 0 violation
- [ ] 视觉对照：dark + light 两模式都跟对应 mockup 像素级邻近（容差：间距 ±2px / 字号严格相等 / 颜色 token 完全相同）
- [ ] i18n：所有新文案 zh-CN + en-US 双 locale 同步，无 hardcoded 中文 string
- [ ] 中文 ≥ 14px（`text-aux` / `text-body` 及以上；`text-meta` / `text-micro` 是 mono 仅 ASCII）
- [ ] Disabled 用 `opacity-50 + data-disabled + aria-disabled + tabIndex=-1`，CSS 不靠 `pointer-events: none`
- [ ] HoverTip 优先于 native `title=""`
- [ ] 若动了 notion.updateFlag 调用点，**必须维持 deprecated breadcrumb 注释**，不能默默切到新接口
- [ ] 真实后端，无 mock（要 mock 仅限单测内部）

---

## 6. Sprint 13 启动 prompt（粘到新 session）

```
此项目是 MailAgent (macOS Electron 邮件同步)。Sprint 11 ship 了 chrome
SSoT（TitleBar / Sidebar / StatusBar + 路由 + Liquid Glass），Sprint 12
ship 了 is_important 端到端 + v8 pinned + chrome 收尾 polish + SQLite SSoT
inversion 战略 TODO 标记。Sprint 13 = 按 `frontend/ref/DESIGN.md` V1.4 +
mockup HTML 把 **EmailDetail + AIChatPanel** 完整落地。

**强制先读（按顺序）**：
1. `frontend/SPRINT13-HANDOFF.md` — 本 sprint 整体（已 ship / 工作目标 /
   禁动区 / 验收清单）
2. `frontend/SPRINT11-HANDOFF.md` §0 + §11（chrome 关键文件指针）
3. `frontend/ref/DESIGN.md` §1（哲学）§2.1（ink token）§2.7（accent）§2.8
   （glass）§2.10（i18n）§3（typo）§5.1（EmailRow 参照）§5.3（AIChatPanel）
   §6（AI chat conventions §6.1-6.8）§9.4（disabled）§14（lint）
4. `frontend/ref/mockup-detail-window.html` — 622 行 popout 全文
5. `frontend/ref/mockup-inbox.html` L351+（AI panel）+ 右列 EmailDetail 区
6. `frontend/NOTES.md` 2026-05-19 strategic 条目 — 理解为什么 notion.updateFlag
   不要在本 sprint 改

**当前组件现状**：
- `src/shared/components/email/{EmailDetail,EmailToolbar,EmailBodyFrame,
  AttachmentList,ThreadSidebar,TranslatedBody}.tsx`
- `src/shared/components/chat/{AIChatPanel,BackendSelector,Composer,
  ContextChips,MessageList,QuickActions}.tsx`
- `src/shared/components/ai/{AIBadge,AIFieldsBlock}.tsx`

**Sprint 13 工作目标**（按优先级，逐个独立 commit）：
1. EmailDetail（inbox 右列）按 mockup-inbox 右列 + mockup-detail-window
   visual contract polish — toolbar / AI fields / body / attachments
2. EmailDetail popout 窗口 — 新路由 `/email/:id` + 新 IPC 开独立 BrowserWindow
   + EmailDetailWindowLayout (no chrome)
3. AIChatPanel 按 §6.1-6.8 polish — bubble shape / tool-call rows / action
   item card / draft preview card / composer / quick action chips / batch ops
4. EmailDetail ↔ AIChatPanel 布局：精读 mockup-inbox 量化各列宽度，
   决定 3 列 + 内嵌 tab 还是 4 列独立 pane

**约定（继承 Sprint 11/12，强制）**：
- 真实后端，无 mock；IPC / mailagent CLI
- 颜色 token 全走 Tailwind class（bg-ink-* / text-coral / coral/30），零 hex
- `.glass*` / `.app-nav*` / `.row-selected` 是 authored CSS
- i18n：中文 hardcoded 不允许，新 key 同步 zh-CN + en-US
- 中文 ≥ 14px
- Disabled：opacity-50 + data-disabled + aria-disabled + tabIndex=-1
- HoverTip 优先于 native title
- 验收：typecheck / lint / vitest / a11y:contrast 全绿
- Commit 风格：feat(frontend): Sprint 13 <focus> — A + B + C
- 不动 notion.updateFlag 反向同步链路（NOTES.md deprecated breadcrumb 保留）
- 不动 chrome / 路由树 / glass token / nav-shell store

**问用户**："Sprint 13 第一刀先做哪一项？或者按 1→4 顺序我直接开干？"
```

---

## 7. 关键文件指针（绝对路径）

| 用途 | Path |
|---|---|
| 本 handoff | `frontend/SPRINT13-HANDOFF.md` |
| 上一 sprint handoff | `frontend/SPRINT11-HANDOFF.md`（Sprint 12 未单独 handoff，并入此文档 §1） |
| 设计 SSoT | `frontend/ref/DESIGN.md` |
| Mockup | `frontend/ref/mockup-{detail-window,inbox,compose,search,settings,admin,onboarding,dynamic-island}.html` |
| EmailDetail 家族 | `frontend/src/shared/components/email/{EmailDetail,EmailToolbar,EmailBodyFrame,AttachmentList,ThreadSidebar,TranslatedBody}.tsx` |
| AIChatPanel 家族 | `frontend/src/shared/components/chat/{AIChatPanel,BackendSelector,Composer,ContextChips,MessageList,QuickActions}.tsx` |
| AI 共享 | `frontend/src/shared/components/ai/{AIBadge,AIFieldsBlock}.tsx` |
| IPC 入口 | `frontend/src/electron/main/handlers/email.ts`（read）+ `write_ops.ts`（write，含 `notion:updateFlag` deprecated path）|
| Types | `frontend/src/shared/api/types.ts` — `EnrichedEmailMeta` / `EmailDetail` / `AIFields` |
| Strategic NOTES | `frontend/NOTES.md` 2026-05-19 条目（SQLite SSoT inversion 4 步迁移） |
| Long-term memory | `~/.claude/projects/-Users-chenyuanquan-Documents-MailAgent/memory/project_sqlite_ssot_inversion.md` |
| 本 sprint commit | `5d48448`（Sprint 12 主体）+ `68e60af`（NOTES + EmailRow deprecated 标记）|

---

## 8. 风险 & 未决项（Sprint 13 启动时确认）

- **EmailDetail popout 窗口要不要做**：用户在 Sprint 11 候选里把 popout 标为「待用户决定」。Sprint 13 启动时再问一次，
  确认要做就按 §3.2 加新路由 + IPC；不做就把 §3.2 跳过专攻 inline pane
- **ThreadSidebar 去留**：mockup-detail-window 没有独立 thread sidebar，是否把它收到 EmailDetail 顶部 thread strip
- **AIChatPanel 列宽**：3 列还是 4 列布局（§3.4）—— 先精读 mockup 再定
- **iframe body 高度自适应**：当前 EmailBodyFrame 可能用固定 height，mockup body 是 main 内部自然流动；要决定要不要改
  iframe → `srcDoc` + measure → 父级 height（保留 sandbox 但失去 iframe 滚动）
- **SQLite v9 重启**：Sprint 13 启动前确认生产 `pm2 restart mail-sync` 跑过、新邮件 is_important 在落库。否则
  EmailRow ❗ icon 看着像不工作（实际是数据没刷上来）
- **`node_modules/` 顶层 untracked**：项目根有个 untracked node_modules（`.gitignore` 没忽略）—— Sprint 13 启动时检查
  来源 + 决定加 `.gitignore` 还是清掉
