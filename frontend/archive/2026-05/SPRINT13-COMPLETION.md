# Sprint 13 Completion — EmailDetail + AIChatPanel 按 mockup 落地

> Sprint 13 = 用户睡前要求：「按 mockup 和设计系统把 inbox 的 email detail 分列，
> 还有 AI chat panel 都还原成 mockup 效果」+ 「toolbar 自适应」+「打不通的
> 后端要明确标记并禁用按钮」。本文档收尾 handoff 给下一 sprint。
>
> **启动前最少读完**：§1 TL;DR + §3 待用户决策（醒来挑） + §4 Sprint 14 候选

---

## 1. TL;DR

| 项 | 值 |
|---|---|
| Commits | `b9afefa` (part 1) + `36ead91` (part 2 + lint fix) + 本文档 commit |
| 闸 | typecheck 0 / lint 0 / vitest 564 passed | 1 skipped / a11y 12 组合 clean |
| 真正新增功能 | EmailToolbar 自适应 + Mark Important 只读 ❗ + DraftPreviewCard 4 按钮全接通 + AttachmentList derived 内联 + AIChatPanel newSession() 接通 + EmailDetail Thread 行 + footer .eml 占位 |
| 验收的现状 | AIFieldsBlock / MessageList / Composer / ContextChips / BackendSelector / QuickActions / EmailBodyFrame — Sprint 10-12 已完成 mockup 对齐，本 sprint 仅做小调（pre 背景 tint + .err/.num/.key 颜色 class） |
| **明确禁用 + HoverTip** 的按钮 | Archive（无 CLI）/ History（无侧栏）/ Edit draft（无内联编辑器）/ Open draft in window（popout 待决）/ View source .eml（CLI 已存在但无 IPC wrapper） |
| **deprecated 保留** 的路径 | EmailRow + EmailToolbar 的 `notion.updateFlag`（Mark Read / Mark Flagged）— 注释指向 NOTES.md 2026-05-19，等 SQLite SSoT inversion 独立 sprint |

---

## 2. Sprint 13 实际做了什么

### 2.1 EmailToolbar 自适应（用户最强调）

**`src/shared/components/email/EmailToolbar.tsx`** 全文重写。

实现：`useContainerDensity()` hook 通过 ResizeObserver 监听 toolbar 容器宽度，按三档切换：

| 档位 | 触发宽度 | 行为 |
|---|---|---|
| `wide` | ≥ 980 px | 主操作 + 次操作 全部 `icon + label` |
| `medium` | ≥ 740 px | 仅主操作 (Draft Reply) `+label`，次操作 icon-only |
| `narrow` | <  740 px | 全部 icon-only（与 mockup baseline 一致） |

**HoverTip 接入**（DESIGN.md §9.5 — HoverTip 优先于 native title）：
- 任何 icon-only 按钮自动 wrap `<HoverTip text={label} side="bottom">`
- 当 label 已 visible inline → skip HoverTip（避免双重提示）
- 禁用按钮仍 wrap HoverTip 解释禁用原因
- `hoverHint` prop 可覆盖文本（用于附加快捷键 `· Esc / R / U / S`）

**Mark Important（v9 header bit 只读 ❗）**：
- 来源：`reader._parse_importance` 解析 `Importance / X-Priority / X-MSMail-Priority` →
  `email_metadata.is_important` (boolean)
- UI：`isImportant=true` 时在 Star 和 Archive 之间渲染 `<AlertCircle text-impt>`，**只读**
- 无写路径（后端无 `email.markImportant` IPC），HoverTip 解释「邮件头标记为重要 · 只读」

**Archive 显式禁用**：
- 后端无 `mailagent email archive` CLI
- 按钮保留在 mockup 位置（视觉密度对齐），但 `disabled + data-disabled + opacity-50 + tabIndex=-1 + HoverTip="归档 · 等待 Sprint 14 接 CLI"`
- 不假装能用，符合用户「明确标记并禁用」要求

**3 个新单测**（EmailToolbar.test.tsx 14 → 18 passed）：
- archive button 真 disabled + tabIndex=-1
- isImportant=true 渲染 ❗ 角色为 img 的 indicator
- isImportant=false 完全隐藏

### 2.2 DraftPreviewCard 4 按钮接通真后端

**`src/shared/components/chat/MessageList.tsx` + `AIChatPanel.tsx`**

新增 `DraftHandlers` 接口 + 注入链 `AIChatPanel → MessageList → AssistantBubble → DraftPreviewCard`：

| 按钮 | 接通状态 | 实现 |
|---|---|---|
| **Send** | ✅ 真后端 | `mailApi.email.createDraft({internalId, body})` → Mail.app AppleScript；code-aware toast：`E_AUTOMATION_DENIED` / `E_MAIL_NOT_RUNNING` / `E_NO_MAILBOX` 各自分流 i18n key |
| **Regenerate** | ✅ 真后端 | `chat.retryLast` (UseEmailChat hook 已暴露)；为 null 时 HoverTip 显「regenPending」提示 |
| **Edit** | ⛔ Sprint 14 | 占位 + HoverTip「内联编辑器规划在 Sprint 14 — 暂时请用 ✎ Mail.app 修改」 |
| **Open in window** | ⛔ Sprint 14 | 占位 + HoverTip「Popout 窗口规划在 Sprint 14 — 见 SPRINT13-HANDOFF §3.2」 |

**Streaming gate**: 流式仍未结束时 Send 自动 disabled，避免半截草稿。

### 2.3 AttachmentList — derived 附件内联

**`src/shared/components/email/AttachmentList.tsx`** 重写。

- 过滤逻辑从 EmailDetail 移到组件内部
- docx → PDF / xlsx → CSV 转换产物（`email_attachment.derived_from = <parent_id>`）改为父 tile 内的小 chip：
  ```
  → pdf · 142 KB   (text-ok bg-ok/10 border-ok/25, 点击打开)
  ```
- 不再另开 sibling tile（grid 更整齐，mockup-faithful）
- 无可见原件时返回 null（EmailDetail 不用再算 length）

### 2.4 AIChatPanel `+ New conversation` 接通

`useEmailChat` 加 `newSession()` 公共方法：
- 中止当前流（如有）
- 清空 messages / activeSessionId / streamingMessageId / error / lastFailedInput
- 下次 `send()` 自然开新 session（chat.start 不带 sessionId）

`AIChatPanel` 顶部 3 按钮全部 HoverTip-wrapped + 修正错误绑定：
- `+ New chat` → `chat.newSession()`（之前错绑 `clearError`）
- `History` → **显式禁用** + HoverTip「会话历史 · 等待 Sprint 14 侧栏」
- `×` Close → HoverTip「收起面板 · ⌘L」

### 2.5 EmailDetail meta-grid Thread 行 + footer .eml 占位

- meta-grid 加 Thread 行（mockup-inbox L2128-2132 对齐）：`本对话 N 封` coral 链 (滚动到 `#thread-sidebar`) + `· internal_id N` 内联 mono
- 移除冗余 Notion / ID 独立行（toolbar + footer 已有）
- ThreadSidebar 加 `id="thread-sidebar"` + `scroll-mt-16`
- footer 新增 「查看原文 (.eml)」 disabled button + HoverTip 解释 Sprint 14 接 `mailagent debug email-source <id>` CLI

### 2.6 EmailBodyFrame BODY_CSS 微调

- `<pre>` 背景改为 `rgb(var(--ink-fg) / 0.06)` 对齐 mockup（原 `ink-0/0.5` 在 dark 模式压住 glass-3 背景）
- `<code>` 颜色 `#E89B4A` 直写（原 `rgb(232 155 74)` 等价，统一硬编码）
- 加 `pre .err / .num / .key` 颜色 class（mockup §2210 stack-trace 用，无 class 邮件无影响）

### 2.7 EmailRow deprecated breadcrumb

`EmailRow.tsx` 顶部 line 14-22 已有完整 NOTES.md cross-ref 注释，本 sprint 不再扩展。EmailToolbar Mark Read / Flag 也加同款注释。

### 2.8 types.ts 扩展

```typescript
export type EmailDetail = EmailGet_EmailRecord & {
  is_important?: boolean
}
```
Handler 已返回，cli.gen.ts schema 待 Sprint 14 加 `email-get.schema.json` 重新 codegen。

### 2.9 i18n 新增 keys（zh-CN + en-US 双 locale 同步）

| key | 用途 |
|---|---|
| `toolbar.important` / `importantHint` | Mark Important indicator |
| `toolbar.archiveBlocked` | Archive disabled HoverTip |
| `chat.newChat` / `newChatHint` | + New conversation HoverTip |
| `chat.history` / `historyBlocked` | History disabled HoverTip |
| `chat.closePanel` | × close HoverTip |
| `chat.draftReply.sending` / `toast.{sendOk,sendFailGeneric,sendFailAuto,sendFailMail,sendFailNoBin,editPending,popoutPending,regenPending}` | DraftPreviewCard wiring |
| `emailDetail.threadCount` / `viewSource` / `viewSourceBlocked` | meta-grid Thread + footer .eml |

共 17 个新 key × 2 locale = 34 翻译。

---

## 3. 待用户决策（醒来挑，留 TODO 给 Sprint 14）

### 3.1 EmailDetail Popout 窗口（SPRINT13-HANDOFF §3.2）

需用户拍板要不要做 popout window。当前：
- DraftPreviewCard "Open in window" 按钮已 disabled + HoverTip 引用 SPRINT13-HANDOFF §3.2
- ThreadSidebar / EmailDetail 主体不动

要做的话需要：
- 新 IPC `window:open-email-detail({internalId})` → main process `new BrowserWindow`
- 新路由 `/email/:internalId` 走 `EmailDetailWindowLayout`（无 chrome）
- 复用 `EmailDetail.tsx` 主体，外壳替换为 popout chrome

### 3.2 ThreadSidebar 去留（SPRINT13-HANDOFF §3.1 第 5 项）

mockup-detail-window.html 没有独立 thread sidebar；
mockup-inbox.html 右列 EmailDetail 也没有。当前前端有 `ThreadSidebar` 折叠 accordion。

二选一：
- **A**：保留 ThreadSidebar 现状（当前选择，本 sprint 不动），加 meta-grid Thread 链跳转
- **B**：收到 EmailDetail 顶部「thread strip」（横条折叠器）

本 sprint 默认 A，因为加 anchor 跳转后体验已经不错；如要做 B 需要重新设计 strip 组件。

### 3.3 AIChatPanel 4-列 vs 3-列布局（SPRINT13-HANDOFF §3.4）

mockup 是 4 列（Sidebar 240 | List 340 | Detail flex-1 | AI Panel 360）。
当前实现：3 列 + AI Panel 通过 `useAIChatPanel.visible` 条件渲染右侧 360px。

实际效果上 AI Panel 默认隐藏，⌘L 一键展开 → 用户体感等同 4 列可拉伸（但宽度不可拖拽）。
要做真 4 列 + 拖拽分割条需要新组件 + 持久宽度。

**建议**：保留现状（条件渲染 360）。拖拽分割条排到 V1.5。

### 3.4 View source (.eml)

按钮 + HoverTip 已就位，但无前端可用 IPC。后端 CLI `mailagent debug email-source <id>` 已存在，
只需：
- IPC handler 包 CLI
- mailApi.debug.emailSource(internalId): Promise<string>  
- 前端打开新窗口或 modal 展示 raw MIME

可作为 Sprint 14 小任务（~30min）。

### 3.5 Mark Important 是否需要可写

当前是 read-only ❗ indicator。如果用户希望手动 toggle：
- 后端要加 `mailagent email mark-important <id> --true|false` CLI
- IPC + mailApi 包装
- 按钮换成可点击的 toggle（替换当前 `<span role="img">` 为 `<button>`)

我**强烈建议**与 SQLite SSoT inversion 一起做（NOTES.md 2026-05-19 战略 TODO），
因为这些 write 都应该走新的 `email.flag / email.updateLocalFlag` fanout 路径。

---

## 4. Sprint 14 候选清单（按优先级）

1. **SQLite SSoT inversion**（最大 + 战略）：NOTES.md 2026-05-19 描述的 4 步迁移面 (a/b/c/d)。涉及：
   - 新 IPC `email.flag` 直写 SQLite + 排队 fanout
   - `handle_flag_changed / handle_completed / handle_ai_reviewed` handler 退化成「写 intent」
   - `notion.updateFlag` 调用点全部切换（EmailRow.tsx 4 处 + EmailToolbar 2 处）
   - SyncStore 加 `email_flag_pending` outbox 表 + idempotency

2. **EmailDetail popout 窗口**（§3.1）：新路由 + IPC + 独立 BrowserWindow
3. **AIChatPanel 会话历史侧栏**（§3.3 现状已 disabled 按钮等着）
4. **DraftPreviewCard 内联编辑器**（Edit 按钮等着）
5. **View source (.eml)**（§3.4，小任务）
6. **Mark Important 可写**（§3.5，跟 #1 SSoT inversion 合并）
7. **cli.gen.ts schema 加 `is_important`**（types.ts 当前 augment）
8. **Action Item Card**（DESIGN.md §6.4 — 当 LLM 输出含动作项时自动渲染）

---

## 5. 禁动区（继承 Sprint 11/12）— 验证未破坏

- ✅ TitleBar / Sidebar / StatusBar / 路由树 / Liquid Glass / accent token / theme / locale / nav-shell store — 全未动
- ✅ `notion.updateFlag` 反向同步链路 — 全部保留 + deprecated 注释突出
- ✅ SyncStore DB schema — v9 不动
- ✅ chrome 三块 SSoT — 未动

---

## 6. 启动 Sprint 14 prompt

```
此项目是 MailAgent (macOS Electron 邮件同步)。Sprint 13 ship 了:
- EmailToolbar 自适应 (icon/+label) + HoverTip + Mark Important 只读 ❗ + Archive 明确禁用
- DraftPreviewCard 4 按钮全接通 (Send 真 createDraft / Regenerate retryLast / Edit/Popout TODO)
- AttachmentList docx→PDF 衍生附件内联为 → pdf chip
- AIChatPanel newSession() 接通 / History 显式禁用 / 关闭 ⌘L
- EmailDetail Thread meta-row + footer .eml 占位 + ThreadSidebar anchor
- EmailBodyFrame pre 背景 + 颜色 class 微调
- 17 个新 i18n key 双 locale

闸: typecheck 0 / lint 0 / vitest 564 passed / a11y 12 组合 clean。

**强制先读**:
1. frontend/SPRINT13-COMPLETION.md — 本 sprint 收尾 (含待决策项 + Sprint 14 候选)
2. frontend/SPRINT13-HANDOFF.md — Sprint 13 启动时的总规划 (popout / ThreadSidebar / 4 vs 3 列等)
3. frontend/NOTES.md 2026-05-19 strategic 条目 — SQLite SSoT inversion 4 步详细描述

**问用户**: "Sprint 14 第一刀选哪个? 候选见 SPRINT13-COMPLETION.md §4。
推荐: #1 SQLite SSoT inversion (最大战略，最大收益)。"
```

---

## 7. 关键文件指针

| 用途 | Path |
|---|---|
| 本完成 doc | `frontend/SPRINT13-COMPLETION.md` |
| 启动 handoff | `frontend/SPRINT13-HANDOFF.md` |
| 设计 SSoT | `frontend/ref/DESIGN.md` |
| Mockup | `frontend/ref/mockup-{detail-window,inbox,compose,...}.html` |
| EmailToolbar 自适应核心 | `frontend/src/shared/components/email/EmailToolbar.tsx` (useContainerDensity / GhostBtn / PrimaryBtn / IconOnlyBtn) |
| EmailDetail meta-grid | `frontend/src/shared/components/email/EmailDetail.tsx:483-548` |
| DraftPreviewCard 接通 | `frontend/src/shared/components/chat/MessageList.tsx:72-220` |
| AIChatPanel newSession | `frontend/src/shared/hooks/useEmailChat.ts:512-535` + AIChatPanel 顶部按钮 |
| AttachmentList derived | `frontend/src/shared/components/email/AttachmentList.tsx` |
| EmailBodyFrame BODY_CSS | `frontend/src/shared/components/email/EmailBodyFrame.tsx:32-122` |
| HoverTip 复用 | `frontend/src/shared/components/ui/HoverTip.tsx` (Sprint 11 ship) |
| i18n 新 keys | `frontend/src/shared/i18n/locales/{zh-CN,en-US}/common.json` |
| EmailToolbar 18 测试 | `frontend/tests/components/EmailToolbar.test.tsx` |
| 本 sprint commits | `b9afefa` (主体) + `36ead91` (Thread + lint + footer .eml) |

---

## 8. 已知风险 / 限制

- **chat.newSession() 仅 client-side reset**：backend 没有 `forceNew` flag，所以「老 session 在 ai_chat.db 里仍然存在」。下次 send 时 `chat.start` 会创建新 session（因为 renderer 端没有 activeSessionId 了），但**老 session 不可见**直到 Sprint 14 history 侧栏出来。
- **`is_important` 类型 augment**：types.ts 用 intersection type 而非改 cli.gen.ts schema。Sprint 14 加 schema 时 augment 自然失效（cli.gen.ts 会有真字段）。
- **`scroll-mt-16` 在 ThreadSidebar 锚点**：依赖 `<main aria-label="inbox-main">` 的滚动容器，如果 layout 改了滚动祖先会失效。当前没问题。
- **Send 草稿期间 createDraft 失败的 toast 包含 raw error message**：可能含 stack trace，VoiceOver 朗读会很长。Sprint 14 polish 可截断到 200 chars。
