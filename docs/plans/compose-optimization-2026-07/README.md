# Compose 优化专项 Epic（2026-07-15）

> Worktree: `email-compose-optimization-e47643` · branch `claude/email-compose-optimization-e47643`
> 设计源: claude.ai/design 项目 `4485e80b`（MailAgent）`compose/` 目录，已落盘 `./design/`
> 交接文档: `./design/../compose-handoff.md`（原 `compose/compose handoff.md`）

## 范围

### A. 设计落地（compose 重做 v2，per handoff）
1. **RecipientField 重做**：内联输入 + 头像自动补全 + 全键盘操作 + 粘贴拆分 + 内外部区分 + chip 详情/编辑 + To/Cc/Bcc 折叠。
2. **RichEditor（TipTap classic 方向，已拍板）**：分组常驻工具栏（标题/字号/颜色/高亮/链接 popover）+ slash 块菜单 + @mention。⚠️ 生产 = TipTap **v3.23.6** + React 19，设计 demo 的 v2.27.2 作废；suggestion 用 `@tiptap/react` ReactRenderer，读派生态用 `useEditorState`。bubble/minimal/bottom 三个 demo 分支不落地。
3. **AttachmentTray**：整窗拖拽 + 缩略图卡片（类型图标/角标/大小/图片预览）+ 进度。必须保住既有附件契约（显式 attachments=权威列表；forward 补拉原附件；stage_id/attachment_id refs）。
4. **形态外壳**：新邮件=可拖动浮窗（FloatingShell，替代现居中模态）；回复/转发/草稿编辑=右侧全窗（现状布局保持）。
5. **发送管线**：sanitize + 样式内联化（handoff §9.1；评估 juice vs 复用现有 emailSanitize/EMAIL_PURIFY_OPTS 扩展）。

### B. Bug 修复（3 个，用户上报）
- **B-1 AI 拟稿丢线程**：AI 自动拟定的答复草稿回复后不在原线程。疑点：AI 拟稿路径创建草稿时未写 In-Reply-To/References，或从草稿发送时线程头丢失/重建错误。
- **B-2 AI 草稿打开时回复与引用不分离**：AI 建议+引用块被合并成单一 body 存草稿；从草稿箱打开走 email.get+email.body 直灌，draftHtmlGate 判 complex → 整块折叠。目标：AI 拟稿只把答复内容放可编辑区，引用块自然折叠（对齐 split_quote 契约）。
- **B-3 离开 compose 无确认直接丢**：6 月重做时因预填误标 dirty 删掉了 dirty 跟踪 + DiscardDialog。重新引入：正确 baseline 的 dirty 跟踪 + 离开确认弹窗（保存草稿 / 丢弃 / 取消）。

## 既有契约（不可破坏）
- `draftPlan split_quote`：dry-run 时 `reply_html` 只含 AI 建议，`quote_html/quote_text` 单独给；CLI 直调/ping-island 默认 False 行为不变。
- 附件契约：`attachments` 缺省=服务端自动收集；显式（含 []）=权威列表；send-approved 拒附件。
- `_ThreadingHeader` 永不 RFC2047 编码（sender.py）；davmail 头解析 `_decode_mime_header`。
- draftHtmlGate：simple 直灌 TipTap / complex 折叠 iframe。
- 主题 v3 token（--r-ctl/--r-row/--r-card/--r-pop、--sel-wash、--c-* 语义色）；浮层材质用 `.glass-pop`。
- 哨兵 internalId=-1（mode='new'）三层校验（IPC validateComposeOpts / HTTP _require_compose_internal_id / service）。

## 执行编排
- 主 session（Fable 5）：规划/编排/验收/契约缝 review。
- Phase 1（并行组件 lane，文件不相交）：T1 RecipientField（opus）· T2 RichEditor（fable）· T3 AttachmentTray（sonnet）· T4 后端 B-1+B-2（fable）。
- Phase 2（集成）：T5 ComposePanel 集成+形态外壳+发送管线 · T6 B-3 离开确认（依赖 T5）。
- Phase 3：四闸（pytest / vitest / typecheck / agent_eval）+ codex gpt-5.6-sol xhigh 分批交叉 review + 修复。

## 现状调查报告
- 前端现状：`./research/frontend-compose-status.md`
- AI 拟稿链路：`./research/ai-draft-pipeline.md`
