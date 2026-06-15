# Compose（回复 / 回复所有 / 转发）+ 真实发送 — Handoff

**状态**: ✅ 后端 + 前端代码完成、测试通过；⚠️ **尚未 dogfood**（需真机 davmail + Outlook 账号验证 SMTP 发送 + Sent 归档）。

**Commit**（分支 `feat/island-p0-fixes`，基于 folder 分支最新点 `ba19f0d`）:
- `985be8d` feat(compose): 后端 reply/forward 草稿 + SMTP 真实发送
- `9a5a30b` feat(compose): 前端 TipTap 撰写面板 + 回复/回复所有/转发 toolbar

> ⚠️ **分支注意**: session 开始在 `feat/folder-archive-drafts`，期间被切到新建的 `feat/island-p0-fixes`（从 folder 分支 `ba19f0d` 切出）。两个 compose commit 落在 island-p0-fixes。若需移到别处：`git cherry-pick 985be8d 9a5a30b`（两 commit 自洽，仅依赖 ba19f0d 基础）。**未 push**。

---

## 用户需求

收件箱邮件详情顶部操作菜单增加「回复 / 回复所有 / 转发」三操作。已确认方案：**完整撰写面板 + 真实 SMTP 发送 + 转发带原始附件 + 统一走 davmail backend**。

## 架构

```
EmailToolbar 分裂下拉 (回复/回复所有/转发)
  → EmailDetail.handleOpenCompose(mode)
  → ComposePanel (TipTap 富文本, zustand useComposeStore)
      ├─ 打开: mailApi.email.draftPlan({internalId, mode})  → dry-run 预填 to/cc/subject/正文/引用
      ├─ 存草稿: mailApi.email.draft({...})                  → email:draft IPC
      └─ 发送:   SendConfirmDialog → mailApi.email.send({...}) → email:send IPC
  → cli_runner.callCli(['email','draft'|'send', ...])  (body 经 os.tmpdir 临时文件传 --body-html-file)
  → mailagent CLI (src/cli/commands/email.py)
  → backend.append_draft / send_email
      ├─ DavMailBackend (PRIMARY): IMAP APPEND / smtp_session.send_message
      └─ AppleScriptBackend (FALLBACK): create_reply_draft.sh / SMTP (forward+send 仅 davmail)
```

## 后端契约（已实现 + 测试）

```bash
# 草稿 (落 Drafts)
mailagent email draft <id> --mode {reply|reply-all|forward} \
  [--to "a@b,c@d"] [--cc ...] [--bcc ...]   # 完整收件人覆盖 (compose 编辑后权威值)
  [--subject "..."]                          # 完整主题覆盖 (覆盖 Re:/Fwd: 自动前缀)
  [--body-html-file PATH]                    # TipTap HTML (compose 用这个, 零转换)
  [--body-file PATH]                         # markdown 备选
  [--extra-to/--extra-cc]                    # 追加语义 (灵动岛用, compose 不用)
  [--dry-run] -o json                        # dry-run = compose 预填单一数据源

# 真实发送 (SMTP, 不可逆)
mailagent email send <id> --mode ... [收件人/正文同上] --yes -o json
#   无 --yes + json → E_INVALID_ARG (前端必须自己弹确认后传 --yes)
#   forward 必须收件人; forward --dry-run 不要求 (返回 Fwd: subject + 引用供预填)
```

dry-run plan data（compose 预填）: `{to[], cc[], bcc[], subject, reply_text, reply_html, forward_intro_text, forward_intro_html, attachments, warnings}`。

**关键文件**:
- `src/mail/backend/sender.py`（新）: `build_outgoing_mime`（reply/forward/附件 multipart/mixed 单一来源）+ `smtp_send` + `_append_to_sent`
- `src/mail/backend/types.py`: `DraftMode` 加 forward；`DraftRequest` 加 bcc/attachments/forward_intro_text/html；`SendResult`
- `src/mail/backend/{davmail,applescript}_backend.py`: `send_email`；davmail `_build_mime`（委托 sender，保留 `_build_reply_mime` 别名供 folder_sync）
- `src/mail/backend/imap_client.py`: `discover_sent_folder`
- `src/cli/commands/email.py`: `_compose_reply_draft` / `_prepare_draft`（forward + 收件人覆盖 + 附件 + body）；`email draft`（加 forward/options）；`email send`（新）
- `src/config.py`: `davmail_archive_sent`（默认 False）/ `davmail_sent_folder`

**前端关键文件**:
- `frontend/src/electron/main/handlers/draft.ts`: 新增 `email:draft`/`email:send`/`email:draftPlan`（走 callCli）；保留旧 `email:createDraft`（AI panel tool 用）
- `frontend/src/shared/components/email/compose/`（新）: ComposePanel / RecipientField / ComposeEditor / ComposeDialogs
- `frontend/src/shared/state/compose.ts`（新）: zustand store
- `frontend/src/shared/api/{types,ElectronApi,HttpApi}.ts`: draft/send/draftPlan
- `frontend/src/shared/components/email/{EmailToolbar,EmailDetail}.tsx`: 分裂下拉 + handleOpenCompose
- `frontend/src/shared/i18n/locales/{zh-CN,en-US}/common.json`: `compose.*`（ICU `{n}` 插值）+ `toolbar.reply/replyAll/forward/composeMenu`

## ⚠️ 下一步：必做的 dogfood 验证（无真机账号无法在 CI 跑）

1. **【高】SMTP 发送是否自动归 Sent**：`sender.smtp_send` 默认**不**手动 APPEND Sent（假设 EWS 服务端自动归档，与现有 `folder_sync.send_draft` / `itip_reply` 一致）。**发一封真实邮件确认 Outlook「已发送」里有**。若缺 → `echo 'DAVMAIL_ARCHIVE_SENT=true' >> .env`（开了 `discover_sent_folder` + 手动 APPEND；**先验证再开，防与服务端自动归档重复成双份**）。
2. **e2e compose 流程**：`cd frontend && pnpm dev` → 详情 toolbar 选回复/回复所有/转发 → 面板预填正确（reply 带 LLM 建议 / forward 带 Fwd: + 引用）→ 编辑富文本 → 存草稿（去 Outlook 草稿箱核对富文本 + Fwd: + 转发附件）→ 发送（确认对话框 → 收件方确认富文本保真 + 线程折叠）。
3. **CLI 先手验**（davmail 模式 + `MAILAGENT_CLI_API_KEY`）:
   ```bash
   mailagent email draft <id> --mode forward --to a@b.com --dry-run -o json | jq
   mailagent email draft <id> --mode forward --to a@b.com --api-key $KEY   # 真建草稿
   mailagent email send  <id> --mode reply --yes --api-key $KEY            # 真发送
   ```

## 已知限制 / 风险

- **forward inline 图片 cid 失效**：转发默认只带常规附件（`is_inline=False`）；原文内联图（cid:）在重拼的引用 HTML 里会破图，故不带（文档化限制）。
- **forward 附件 cap 20MB**（编码前）：超限跳过剩余 + warnings。
- **applescript 模式**：forward draft 直接报错（sh 无 forward）；send 走 SMTP（依赖 DavMail JVM 在跑）。reply draft 的 sh emergency fallback 不受影响。
- **HTML↔MIME**：compose 走 `--body-html-file`（TipTap HTML 直用作 reply_html，零转换；reply_text 由 `html_to_markdown` 生成 fallback）。reply_suggestion 路径仍走 markdown→HTML。

## 测试

- 后端: `pytest tests/cli/test_email_draft.py tests/cli/test_email_send.py tests/mail/backend/ -q`（含 forward compose / build_mime 结构 / send mock SMTP / to+subject override）。全套 `pytest tests/` = 1791 passed, 2 failed（**2 failed 是 pre-existing，与 compose 无关**：`test_reverse_sync_outbox` / `test_handlers_outbox` 的 `update_local_flags(processing_status=)` 签名 — 已 stash 验证）。
- 前端: `cd frontend && pnpm typecheck`（pass）+ `pnpm exec vitest run tests/main/compose_draft.test.ts tests/components/ComposePanel.test.tsx tests/components/EmailToolbarCompose.test.tsx`（22 passed）。全套 1 failed = `sidebar-contract.test.tsx`（**pre-existing**，folder 工作加了存档/草稿箱 nav 行但 contract 仍断言 12）。

## 未提交的并行工作（不是 compose，勿混入）

工作区还有 **folder 草稿发送 dogfood**（`folder/DraftEditor.tsx` 加发送按钮 + zh-CN `folder.editor.send*` key — 后者已随前端 commit 带入，因同文件无法分离）+ **灵动岛 P0**（`island_dispatch.py` / `island_response.py` + tests）+ `new_watcher.py`（session 前已 M）。这些是其它工作线的，留给对应 session 提交。

## 后续可选增强

- compose 右侧 AI rail（撰写助手：快捷重写 / 翻译 / 语气检测，见 `mockup-compose.html`）— 本期未做。
- 定时发送（mockup 有 UI，后端无）。
- 收件人自动补全（本期纯手输 chip）。
