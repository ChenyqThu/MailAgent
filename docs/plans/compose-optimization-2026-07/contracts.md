# Compose 优化 Epic — Lane 契约（编排者钦定，所有 lane 必读必守）

> 有疑义先按本文执行，落地中发现契约不成立 → 在最终汇报里 flag，不要自行改契约。
> 现状调查：`research/frontend-compose-status.md` + `research/ai-draft-pipeline.md`（行号是快照，动手前就地复核）。
> 设计参考：`design/`（handoff 全文见 `compose-handoff.md`）。

## D1 草稿线程 linkage（Bug A，T4 后端 / T5 前端）

- **DB v35 → v36**（/db-migration 规范：idempotent、bump 三处一致：`src/mail/sync_store.py` DB_VERSION、`src/api/routers/admin.py`（如有 EXPECTED_DB_VERSION）、`frontend/src/electron/main/backend_lifecycle.ts` EXPECTED_DB_VERSION=36）。`email_metadata` 加 3 列：
  - `draft_source_internal_id INTEGER`（原邮件行 internal_id，可空）
  - `draft_in_reply_to TEXT`（可空）
  - `draft_references TEXT`（可空，空格分隔的 msg-id 链原文）
- 写入点（两处，缺一不可）：
  1. `_mirror_draft_locally`（mail_write.py）：即时写 linkage；`thread_id` 不再硬编码 None，继承原邮件 record.thread_id。
  2. `reconcile_drafts`（davmail_backend.py）：把已算出的 `in_reply_to_raw`/`references_raw`（现为死字段）持久化；据 in_reply_to 的 message_id 反查原行填 `draft_source_internal_id`；thread_id 走既有 `_thread_id_from_headers`。→ 覆盖 webhook `_create_draft_via_imap` 等一切草稿来源，统一自愈。
- **发送/保存复用**：`ComposeRequest` 加可选 `source_draft_id: Optional[int]`（HTTP body key `sourceDraftId`，IPC opts `sourceDraftId`）。`_compose_reply_draft` mode='new' 分支：有 source_draft_id 且该行有 linkage → 恢复 in_reply_to/references/thread_id（internal_id_for_threading 相应设置）；无 → 现状零派生。三层校验（HTTP `_compose_request_from_body` / IPC `validateComposeOpts` / service）都放行该字段——哨兵坑教训：改一层不够。
- 前端（T5）：draft-edit 的 buildComposePayload 带 `sourceDraftId: internalId`（草稿行自己的 id）。

## D2 引用分离 marker（Bug B，T4 后端 / T5 前端）

- marker 契约：引用块整体包裹 `<div data-ma-quote="1">…</div>`（含「在…写道：」行 + blockquote 全部）。常量名 `QUOTE_MARKER_ATTR = "data-ma-quote"`，Python 定义在 `src/services/mail_write.py`（或就近常量），TS 定义在 `frontend/src/shared/lib/` 下新模块 `quoteSplit.ts`。
- 后端（T4）：`_prepare_draft` split_quote=False 的合并处 + `_build_reply_quote` 产出的引用块带 marker（落盘草稿与发送 MIME 都带；wrapper div 对收件方渲染无害）。webhook `_create_draft_via_imap` 的正文**补拼引用块**（与路径 C 同构、带 marker）——统一「AI 草稿打开有引用可看」体验。
- 前端（T5）：draft-edit 回填改为：`splitQuoteHtml(body)` → marker 前段进 editor（经 draftHtmlGate 分类仍适用于前段）；marker 段（含）进折叠 quote 区（保真 iframe）。无 marker 时回退现状 draftHtmlGate 全量分流。发送时 getSanitizedHtml 拼回 quote（现有逻辑），**验证 EMAIL_PURIFY_OPTS/DOMPurify 不剥 data-ma-quote 属性**（DOMPurify 默认 ALLOW_DATA_ATTR=true，需加回归测试锁住）。

## D3 dirty 跟踪 + 离开确认（Bug C，T6，依赖 T5 合入）

- baseline：预填完成（planApplied=true / draft 回填结束）**之后**的变更才算 dirty——editor `on('update')` 在预填后挂载生效，字段 setter 包 markDirty。彻底规避 6 月「预填误标 dirty」旧坑。
- 弹窗 `UnsavedChangesDialog`（复用 ComposeDialogs 风格）三键：**保存草稿**（saveMut 成功后继续原动作）/ **丢弃**（继续）/ **取消**（中断、留在 compose）。
- 拦截点全覆盖：① EmailDetail 切邮件 effect（active 变化时若 dirty：保持 overlay 弹窗，选择后再 closeCompose）② Esc ③ 顶部「放弃」④ 新邮件浮窗关闭/scrim ⑤ ⌘N 重复打开。
- draft-edit 的「删除草稿」仍走既有 DeleteDraftDialog，语义不变。

## D4 设计落地边界（T1/T2/T3/T5）

- 编辑器方向已拍板 **classic**：分组常驻工具栏（正文/H1-3 下拉、字号下拉、B/I/U/S、颜色+高亮 swatch popover、列表/引用/代码块、链接 popover、图片、分割线、@、撤销重做）+ slash 块菜单 + @mention。bubble/minimal/bottom 不落地。
- **TipTap v3.23.6 + React 19**（设计 demo 的 v2.27.2 作废）：suggestion 渲染用 `@tiptap/react` ReactRenderer（不用 demo 的 window.__ttSuggest 全局桥）；读派生态用 `useEditorState`。新依赖（版本对齐 ^3.23.6）：`@tiptap/extension-highlight`、`@tiptap/extension-mention`、`@tiptap/suggestion`；placeholder 用 v3 对应包（查 @tiptap/extensions）。不引入 juice/sanitize-html（沿用 DOMPurify+EMAIL_PURIFY_OPTS 管线，样式内联化后续评估）。
- @mention 语义：插入 mention 节点（label=姓名，id=email）；选中后该联系人**不在任何收件人字段时自动加进 To**；发送序列化为可读文本（mention 节点渲染 `@姓名`）。数据源=现有收件人自动补全数据源（内部域优先）。
- 新邮件形态：居中模态 → **可拖动浮窗**（header 拖动、双击/按钮最大化、点 scrim 关闭走 dirty 守卫）。材质 `.glass-pop`（浮层铁律），动效保留 useExitAnimation。回复/转发/draft-edit 全窗布局保持。
- 附件：缩略图卡片 grid（148px minmax）、类型图标+扩展名角标+大小、图片缩略预览、hover 删除、上传进度条、空态 dropzone、整窗拖拽 overlay（现有 useAttachmentDrop 语义）。**附件契约不可破**：显式 attachments=权威列表；forward 补拉原附件；{stage_id}/{attachment_id} refs；send-approved 拒附件。
- token 纪律：新样式一律 v3 token（--r-ctl/8 控件、--r-row/9、--r-card/12、--r-pop/14 浮层；--c-warn 外部联系人点、--c-ai AI 紫、--c-ok 成功、ink 系前景）；浮层材质 .glass-pop；semantic 色用 `rgb(var(--token)/alpha)` 不写死 hex（设计 KIND_META 附件角标色可暂 hex，标 TODO token 化）。禁自造 spring/动效参数（motion-gsap 五预设）。

## Lane 文件所有权（防冲突，越界=返工）

| Lane | 独占文件 | 禁碰 |
|---|---|---|
| T1 RecipientField | `frontend/src/shared/components/email/compose/RecipientField.tsx` + `frontend/tests/components/RecipientField*.test.tsx`（+ 如需新增子组件文件放同目录 `recipient-*.tsx`） | ComposePanel/ComposeEditor/附件/后端 |
| T2 编辑器 | `ComposeEditor.tsx` + `frontend/tests/components/ComposeEditor*.test.tsx` + 新建 `compose/editor-*.tsx`（slash/mention 子组件）+ `frontend/package.json`（仅加 @tiptap 依赖） | ComposePanel/RecipientField/附件/后端 |
| T3 附件 | 新建 `compose/AttachmentTray.tsx` + `frontend/tests/components/AttachmentTray.test.tsx` | ComposePanel（接线留 T5）/其余 |
| T4 后端 | `src/services/mail_write.py`、`src/mail/sync_store.py`（migration）、`src/mail/backend/davmail_backend.py`、`src/api/routers/email.py`、`src/events/handlers.py`、`tests/{services,mail,api,cli,events}/…`、`frontend/src/electron/main/backend_lifecycle.ts`（仅 EXPECTED_DB_VERSION 常量行）、admin.py EXPECTED_DB_VERSION（如有） | 前端组件 |
| T5 集成 | `ComposePanel.tsx`、`ComposeNewModal.tsx`、`ComposeDialogs.tsx`（如需）、`EmailDetail.tsx`（compose 相关段）、`shared/lib/quoteSplit.ts`（新）、`api/types`、`electron/main/handlers/draft.ts`、相关测试 | — |
| T6 dirty 守卫 | `ComposePanel.tsx`/`EmailDetail.tsx`/`ComposeDialogs.tsx` 增量 + `compose/useComposeGuard.ts`（新）+ 测试 | 在 T5 合入后开工 |

- 组件 API 兼容纪律（T1/T2）：**保持既有导出名与既有 props 向后兼容**（ComposePanel 未改动也必须能编译、既有测试仍绿）；新能力用新增可选 props。接线/换用由 T5 统一做。
- T1/T2/T3 保持 UI 视觉与 `design/` 一致但**类名/结构按生产惯例**（Tailwind + 既有 .gbtn/.glass-pop 体系，不照搬 demo 的 rcp-*/tb-* 类名，除非新建样式确需 authored CSS 进 index.css——尽量组件内 Tailwind）。

## 验证与提交纪律（每个 lane）

- Python 测试：`/Users/chenyuanquan/Documents/MailAgent/venv/bin/python -m pytest tests/<相关目录> -q`（worktree 无 venv，用主仓 venv；在 worktree 根目录跑）。禁裸 `pytest`（必须带 tests 路径）。
- 前端测试：`cd frontend && npx vitest run tests/components/<相关文件>`；typecheck 以 `pnpm run build` 内的为准（standalone typecheck 有增量缓存假 PASS 坑），lane 层面至少跑 `npx tsc --noEmit -p .`（如项目有对应 script 用 script）。
- 本仓 PostToolUse hook 每次 Edit 后跑 autoflake：**import 与其首个使用点必须在同一次 Edit 里写入**，拆开必被删。
- 完成后自 commit：`git add <自己 lane 的精确路径>` + `git commit`（message 规范 `feat(compose): …` / `fix(compose): …`，结尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`）。遇 index.lock 冲突等待 2s 重试。**不许 git checkout/reset/stash/push**。
