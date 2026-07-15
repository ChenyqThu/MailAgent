# 前端 Compose 现状调查（2026-07-15，explore lane 产出）

> 行号为调查时快照，动手前请就地复核。

## 1. Compose 面板架构

核心组件（`frontend/src/shared/components/email/compose/`）：
- `ComposePanel.tsx`（1006 行）：`ComposePanelInner`（:200-987，共享实现）+ `ComposePanel`（:991-1006，store 薄壳，`key={internalId-mode}` remount）。
- `ComposeEditor.tsx`（479 行）：TipTap 编辑面 `ComposeEditor` + 格式工具栏 `ComposeFormatToolbar`。
- `ComposeDialogs.tsx`：`SendConfirmDialog` / `DeleteDraftDialog`。
- `ComposeNewModal.tsx`：写新邮件居中模态外壳。
- `RecipientField.tsx`：To/Cc/Bcc chip 输入。

状态管理：
- 两个 zustand store（刻意分离）：`shared/state/compose.ts`（reply/reply-all/forward overlay，绑 internalId+mode）+ `shared/state/compose-new.ts`（新邮件模态）。
- **表单内容全是组件本地 useState**（ComposePanel.tsx:215-239），不进 store、不持久化 → 数据丢失根因。

四入口：
| 入口 | 触发 | 链路 | mode |
|---|---|---|---|
| 新写 | Sidebar.tsx:427 / ⌘N GlobalShortcuts.tsx:78 | openNewCompose → ComposeNewModal（router-instance.tsx:159）→ Inner mode='new' variant='modal' | new |
| 回复/转发 | EmailToolbar.tsx:302-365 → EmailDetail.handleOpenCompose（:416-422）→ openCompose | overlay 渲染 EmailDetail.tsx:750-754 | reply/reply-all/forward |
| 草稿箱打开 | EmailDetail.tsx:705 硬编码 `mailbox ∈ ['草稿箱','草稿','Drafts']` → 早返回渲染 Inner mode='draft-edit'（:707-713），不走 store | draft-edit |

坑：草稿识别字符串硬编码两处（EmailDetail.tsx:705、:1090）；overlay 双保险 effect（:424-437）切邮件时清 stale store——**这段是丢内容路径**；动效 useExitAnimation（:442-446 overlay；ComposeNewModal.tsx:37）。

## 2. 编辑器（TipTap v3.23.6）

- 配置 ComposePanel.tsx:241-255：useEditor 父持有；扩展 StarterKit + TextStyle/Color/FontFamily/FontSize/BackgroundColor + Image(inline+base64)；`immediatelyRender:false`。工具栏用 useEditorState 订阅（ComposeEditor.tsx:246-276）。
- split_quote 契约（api/types/email.ts:253-275 DraftPlanResult）：reply_html=仅建议进 TipTap；quote_html/quote_text 折叠 iframe，发送拼回。
- 正文初始化（一次性 effect，planApplied guard，ComposePanel.tsx:311-377）：
  - reply/reply-all：editorHtml = plan.reply_html（:373-374）；quoteHtml = plan.quote_html || forward_intro_html（:375）✅
  - forward：editor 留空，quote 同上 ✅
  - draft-edit：`classifyDraftHtml(d.html)` 分流（:327-335），**不走 split_quote**
  - new：仅 setPlanApplied(true)
- **split_quote 只在 reply/reply-all/forward 生效；draft-edit 和 new 完全不走。**

## 3. 草稿箱打开路径

- 取正文 draftQ（:278-296）：`Promise.all([email.get, email.body({format:'html'})])`，空回落 markdown。
- 灌 editor（:326-335，经 draftHtmlGate.ts）：simple → setContent(整个 body 含引用)；complex → 整块折叠 iframe（quoteHtml+preserveOriginal），editor 空；empty → markdown。
- **draft-edit 无回复/引用拆分逻辑**。
- 元数据有 thread_id/message_id（cli.gen.ts:1868-1869）但无 in_reply_to/references，且 ComposePanel 不读。
- **draft-edit 保存/发送走 `wireMode='new'`（ComposePanel.tsx:213）→ 后端零线程派生 → 丢线程**；发送成功后删原草稿（:541-548）。

## 4. 未保存丢失

**零 dirty 跟踪 / 关闭确认 / 自动保存**（grep dirty|unsaved|beforeunload|onUpdate|autosave 零命中）。丢失路径：
1. 切邮件：EmailDetail.tsx:430-437 effect 无条件 closeCompose → 静默丢（最严重）。
2. Esc：ComposePanel.tsx:644-653 直接 onClose()。
3. 「放弃」按钮 handleDiscard（:635-641）直接 onClose()（注释：避免 setContent 误标 dirty）。
4. mode 切换/切草稿：key remount 丢弃。
5. draft-edit 关闭 = setActive(null)（EmailDetail.tsx:711）。

## 5. 发送/存草稿

- 正文拼装 getSanitizedHtml（:380-384）：`DOMPurify.sanitize(editor.getHTML()) + sanitizeEmailHtml(quoteHtml)`。
- buildComposePayload（:456-514）：附件 refs（{stage_id}/{attachment_id}）；forward 补拉原附件权威列表；恒传 forceSubject:true（:494）。
- mutations（:516-579）：saveMut→email.draft、sendMut→email.send（draft-edit 成功后删原草稿）、deleteMut→email.deleteDraft。
- 两条路：Electron ElectronApi.ts:298-321 → IPC → electron/main/handlers/draft.ts（bodyHtml 落临时 .html → --body-html-file → 本机 serve-api）；Web HttpApi.ts:280-313 → POST /email/draft 等。附件 raw PUT /email/compose-attachment。
- draftPlan 预热：EmailDetail.tsx:477-491 debounce 600ms 预取 reply/reply-all plan（qk.compose.planMode，staleTime Infinity）。

## 6. 样式对齐度（主题 v3 token）

- 已对齐：ComposeNewModal rounded-[var(--r-pop)]+glass-pop；拖拽层 --r-card；glass-3 列背景；.gbtn 家族。
- 未对齐：.folder-editor-btn 圆角硬编码 6px（index.css:5093）；.folder-draft-editor code 4px/pre 6px；.folder-field-row 无圆角；ComposeDialogs 徽章 rounded-[11px]；重要性下拉 rounded-lg；附件 chip rounded-md 等。

## 7. 测试清单（vitest）

- components: ComposePanel.test.tsx / ComposePanelDraftEdit.test.tsx / ComposeAttachments.test.tsx / ComposeAttachmentsDnd.test.tsx / EmailToolbarCompose.test.tsx / RecipientField.autocomplete.test.tsx
- shared: draftHtmlGate.test.ts / plaintext_html.test.ts
- main: compose_draft.test.ts / draft.test.ts
- 间接: dompurify_xss.test.ts / EmailBodyFrame.test.tsx
- 缺口：dirty-state / 切邮件丢内容 / draft-edit 线程 —— 均无测试（功能不存在）。
