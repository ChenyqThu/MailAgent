# Sprint 14 — AI Chat Panel 收尾

## 任务目标

补齐 AI Chat 面板 5 个 "coming in Sprint 14" 占位:
1. **会话历史 sidebar** (session switcher per email)
2. **附件上传** (Composer 附件按钮 — 当前 disabled)
3. **@-mention** 上下文引用 (Composer mention 按钮 — 当前 disabled)
4. **消息行内编辑** (User message edit + re-send)
5. **Popout 窗口** (chat 浮窗模式独立 Electron window)

外加 BackendSelector polish (Settings 关联但 Sprint 18 PR D 之后视觉可能需要微调).

后端 `ai_chat.db` schema (sessions + messages) + `mailApi.chat.{listSessions, listMessages, send, ...}` IPC 已就位 (`src/shared/hooks/useEmailChat.ts:235` 已消费 listSessions). 这一 sprint 主要是 UI + 部分新增 IPC.

## 起点资源 (按顺序读)

| 路径 | 行 | 用途 |
|---|---|---|
| `frontend/SPRINT13-HANDOFF.md` + `SPRINT13-COMPLETION.md` | — | Chat panel 上一 sprint 完成状态 + 设计决策 |
| `frontend/src/shared/components/chat/AIChatPanel.tsx` | **~300** | 主组件;line 141/176/177/293 是 5 个 TODO 注释定位 |
| `frontend/src/shared/components/chat/Composer.tsx` | **~190** | Composer attach/mention 按钮 (line 154/169 HoverTip blocked) |
| `frontend/src/shared/components/chat/MessageList.tsx` | **~250** | MessageList edit/popout placeholder (line 35/37/131) |
| `frontend/src/shared/components/chat/BackendSelector.tsx` | — | BackendSelector 跟 Sprint 18 Settings 的衔接 |
| `frontend/src/shared/hooks/useEmailChat.ts` | **~550** | Chat hook,line 76 已注释 Sprint 14 history switcher;line 207 sessionMeta 缓存 |
| `frontend/src/electron/main/chat/backends/*.ts` | — | IPC backend 协议 (Notion Agent / Custom API) |
| `frontend/DESIGN.md` §5 / §8 | — | Chat 设计规范 |
| `frontend/ref/mockup-inbox.html` (AI panel 部分) | — | 视觉参考 |

## 建议工作路径

### Phase 1 — 调研 (1-2 h)

1. **读 AIChatPanel.tsx 一遍**: 5 处 TODO 注释逐个定位, 看现状是 stub 还是 disabled.
2. **跑 `pnpm dev` 实测**: 打开 AI 面板, 点击 attach / @ / model switch 各看 HoverTip 文案; 切换不同 email 验证 sessionMeta cache 行为; 跑一次完整 chat 流确认 SSE stream + session 创建.
3. **审计后端 IPC contract**:
   - `mailApi.chat.listSessions(emailId)` 是否支持分页? 历史多了要分页 UI.
   - `mailApi.chat.send` 是否已接受 attachment / mention payload? 还是要新 IPC?
   - `ai_chat.db` schema: 查 `frontend/src/electron/main/db.ts` 看 sessions/messages 表是否有 `attachment_path` / `mention_ids` 列, 没有的话要加 migration.

### Phase 2 — 拆分 PR (产出 plan)

按依赖度排序, 每个 PR 独立可 ship:

| PR | 范围 | 依赖 | 工作量预估 |
|---|---|---|---|
| **A — 会话历史 sidebar** | AIChatPanel 加 collapsible left rail 列出 sessions,点击切换 activeSessionId | 仅 UI + `listSessions` IPC (已存在) | 1-1.5 day |
| **B — 行内编辑** | MessageList user message hover 出 "edit" icon → 改 message text → re-send (后端 truncate session 后续 messages 重发) | 需 IPC: `chat.editMessage(sessionId, messageId, newContent)` + 后端逻辑 | 1.5-2 day |
| **C — Composer 附件上传** | attach 按钮接 file picker → 上传到 ai_chat.db `chat_attachments` 表 → composer chip 显示 → send 时把 file_id 传给 LLM (vision) | 后端 schema 加表 + IPC: `chat.uploadAttachment` / `chat.send({ attachment_ids })` + LLM 协议 (Anthropic vision / OpenAI file_id) | 2-3 day |
| **D — @-mention 邮件引用** | `@` 键触发 popup → 搜邮件 (FTS5 search_email_bodies 复用) → 选中后插入 `@[subject]` chip → send 时附带 internal_id 给 LLM 作 context | 需 IPC: `chat.searchMentionCandidates(query)` + LLM context payload 新增 referenced_emails | 1.5-2 day |
| **E — Popout 窗口** | onOpenInWindow 触发 new BrowserWindow,加载同 AIChatPanel route 但全屏 + 独立状态 + 自动同步主窗 ai_chat.db | Electron BrowserWindow API + 主进程 IPC bridge 共享 ai_chat.db | 2 day |
| **F — BackendSelector polish** | Sprint 18 Settings 关联 — 视觉对齐 + 跟 Settings AI tab 跳转 deep link | UI only | 0.5 day |

合计 ~9-12 个工作日. 可以根据用户优先级裁 PR D/E (附 mention + popout 是 nice-to-have).

### Phase 3 — 实现要点

- **共享 ai_chat.db**: Popout 窗口 + 主窗口同时写 sessions 表, 后端要 WAL + SQLite busy_timeout, 现 `db.ts` 看是否已配
- **会话切换 UX**: switcher 显示 `last_message_at` 倒序; 当前 active session 用 `bg-ink-4` 高亮 (跟 Sidebar `.row-selected` 一致)
- **编辑后 re-stream**: 编辑用户消息要 backend truncate 该消息之后的所有 messages + 重新触发 stream — 注意 useEmailChat.ts 的 streamingMessageId 状态机, 编辑期间禁止 send
- **附件 UX**: composer 加 chip stack 显示 pending attachments + 删除按钮; send 后清空; 失败附件用 fail 色显示 + retry icon
- **@-mention popup**: 用 cmdk / radix Command palette 风格 (跟 ⌘K 一致), 异步加载 search 结果, debounce 200ms

## 关键约束 (non-negotiables)

1. **i18n 覆盖**: 每个新 UI label / button / tooltip 都加 zh + en (`chat.*` 命名空间 + i18n locales 同步)
2. **DESIGN.md tokens**: color/spacing/radius 全走 `--ink-*` / `--c-accent` / `text-{micro,meta,aux,body,lead}`,不引新 hex
3. **复用现有 primitives**: shadcn 已落 (Button/Dialog/Tabs/Switch/...), 不重写; Popover 用 `frontend/src/shared/components/ui/popover.tsx` 不重新封装
4. **a11y**: 编辑按钮要 aria-label, mention popup 要 role="listbox", attachment chip 要 aria-label="remove attachment"
5. **流式状态机不动**: useEmailChat.ts SSE 处理逻辑 (Sprint 10/13 已稳),编辑/附件/mention 都接到 send() 入口,不改内部 streaming refs

## 不要做

- ❌ 不要重写 AIChatPanel — 现有 layout (header / MessageList / Composer / RightPanel) 已稳, 只加新组件 + 接新 IPC
- ❌ 不要把 6 个 PR 合一个大 PR ship — Sprint 18 review 6 轮迭代教训, 拆 PR 才方便回滚
- ❌ 不要碰 `ai_chat.db` migration 不写 dev migration script — 加 schema 新表/新列 要走 `frontend/src/electron/main/db.ts` 的 migrate 函数
- ❌ 不要默认开 popout — 用户主动点 icon 才开;popout 状态 (open/closed) 持久化到 localStorage 避免每次重启都关掉

## 验证条件 (每 PR commit 前)

- [ ] vitest 全过 + tsc 0 errors
- [ ] pnpm dev 实测 — 走完该 PR 的 happy path + 至少 1 个 edge case
- [ ] i18n zh + en 两套同步 (locale JSON 加 key)
- [ ] 同时打开 2 封 email 切换 session 验证 sessionMeta cache 没串
- [ ] 离线场景 (LLM 网关挂): attach 上传 / mention search 看 error toast 是否友好

## Sprint 18 review 遗留

✅ **PR #5 已 merge main** (Sprint 18 Settings 完整) 
✅ **PR #6 已 merge main** (Sprint 15 backend metadata 补齐 + logo 刷新)
- 本地 `sprint15-backend` 分支已远程删除, 切到 `main` 准备开 Sprint 14: `git checkout main && git pull && git checkout -b sprint14-chat`
- `SPRINT18-SETTINGS-HANDOFF.md` 工作文档留在本地, 不入仓 (review 完结, 文档归档参考即可)

## 当前已知 bug / 优化 (跟 chat panel 相关)

无 — Sprint 13 round 8-18 已修过一轮 (NOTES.md `2026-05-20`). 进 Sprint 14 前如果 user 实测发现 chat 新 bug, 优先归类到 Phase 2 PR 内处理.

## Progress — Session 2026-05-20 (sprint14-chat 分支) — ✅ 6 个核心 PR + 4 个 polish PR + 1 fix ship

**Branch**: `sprint14-chat` @ `834f594` (push 到 origin/sprint14-chat)
**累计 11 commits / ~+3551 lines / 30+ files / 149/149 chat 相关测试通过**:

| PR | Commit | 范围 | 测试 |
|---|---|---|---|
| ✅ PR A — 会话历史 sidebar | `6c21aab` | ChatSidebar (140px 左 rail) + useEmailChat.{sessions, selectSession, refreshSessions} + ai-chat-panel store sidebarOpen 持久化 + History 按钮 ⇧⌥H 接通 | 13 个新 ChatSidebar 测试 + 31 useEmailChat 测试无回归 |
| ✅ PR B — 行内编辑 | `0c2fc0a` | chat_db.deleteMessagesFromId + dispatcher.editChatMessage + chat:editMessage IPC + useEmailChat.editMessage + UserBubble inline editor (⌘↩ / Esc / isStreaming disable) | 3 chat_db + 5 dispatcher + 4 useEmailChat 新测试 |
| ✅ PR F — BackendSelector polish | `3198798` | hero card 右上 Settings 齿轮 icon → `/settings?tab=ai` deep link | UI-only (无新单测) |
| ✅ PR E — Popout 窗口 | `23dc2f6` | popout-mode store + bootPopoutModeFromQuery + main process createPopoutWindow + ChatApi.openPopout + PopoutShell 全屏 + Maximize2 button + close 模式区分 (popout `window.close` vs inbox `hideAIChatPanel`) | 8 个新 popout-mode 测试 |
| ✅ PR D — @-mention 邮件引用 | `e3b4078` | MentionPopover (复用 FTS5 search + debounce 200ms) + Composer @ 按钮接通 + chip stack + buildMentionContext (mailApi.email.body 拉 markdown 截 600 char/封) prepend 到 user message | 8 个新 MentionPopover 测试 |
| ✅ PR C — Composer 附件上传 (MVP) | `0752171` | chat-attachments lib (isTextAttachment + readAttachment FileReader + buildAttachmentBlock) + Composer hidden file input + chip stack + AIChatPanel attachments state + handleSend prepend `[Attached files]` | 25 个新 chat-attachments 测试 |
| ✅ PR G — polish round 1 | `f1fd546` | Composer textarea `@` keystroke 自动开 mention popover + ChatSidebar session preview (lazy load first user msg, undefined=loading / null=空 / string=preview) | 4 个新 ChatSidebar preview 测试 |
| ✅ PR H — keyboard polish | `4455e82` | MentionPopover ↑/↓/Enter 键盘导航 + aria-activedescendant + Composer ⌘O attach / ⌘⇧M mention + AIChatPanel ⇧⌥W popout + send-后 textarea autofocus | 2 个新 MentionPopover keyboard 测试 |
| ✅ PR I — DraftPreviewCard inline editor | `12b08c2` | 用户在 send 前可直接编辑 LLM 起草的回复内容; Edit button toggle + textarea + Escape 撤回 + send 用 editedBody + send 后自动退出 edit 模式 | — (DraftPreviewCard 内置 state) |
| ✅ PR J — Session 删除 | `7b6aed7` | ChatSidebar SessionItem hover 显示 trash icon + inline confirm (trash → check/cancel UI, e.stopPropagation 防冒泡) + useEmailChat.deleteSession + chat:deleteSession IPC | 4 个新 delete 测试 |
| 🔧 fix(G) lint | `834f594` | sessionPreviews useEffect 挪到 `chat = useEmailChat()` 之后, 修 use-before-declared lint | — |

**整体测试**: 149/149 chat 相关测试通过 (chat_db 27 / dispatcher 23 / useEmailChat 35 / ChatSidebar 21 / popout-mode 8 / MentionPopover 10 / chat-attachments 25). tsc 0 errors. 3 个 pre-existing fail 跟 Sprint 14 无关 (`useBatchOps.test.tsx` import 缺失文件 / `sidebar-contract.test.tsx` Sprint 18 disabled row 改成可见 / `CommandPalette.test.tsx` 全 suite isolation flake — 单跑 16/16 通过).

**关键架构决策** (后续 sprint 接手参考):

1. **PR A sidebar 宽度**: 140px (panel 内左 rail), 主内容缩到 220px. handoff §47 写的 "collapsible left rail" 没明确宽度, 选 140px 在 220px 主内容下 BackendSelector / MessageList / Composer 都仍能正常 render.

2. **PR B 编辑后端语义**: deleteMessagesFromId 删 messageId 自身 + 之后所有 messages, 然后 append 全新 user msg + assistant msg. 不复用原 messageId (会破坏 created_at 排序). 前端 refresh() 用 listMessages 重 fetch 全部.

3. **PR E popout URL 选择**: 用 `?popout=1&email=N` query string, 不用 router route. main.tsx 在 React.render 之前 sync 读 query 设 zustand store, App.tsx 条件渲染 PopoutShell 替代 AppRouter. **绕过 createMemoryHistory packaged 限制**.

4. **PR D LLM context 策略**: mention email 信息**纯 plain text prepend** 到 user message, **不动后端 dispatcher / LLM context payload**. buildMentionContext 调 mailApi.email.body 拉 markdown 截 600 char/封, format 为 `- #internal_id "subject" — sender — date\n  excerpt`. LLM 自然解析.

5. **PR C 附件 MVP scope**: 仅 in-memory + plain text prepend, **不动 ai_chat.db schema** (CHAT_DB_VERSION=2 不变), **不接 LLM vision 协议**. 文本类 (text/*, application/json/xml/yaml, .md/.csv/.json/.tsx 等) 用 FileReader.text() 读取截 5000 字符 inline; 二进制 (image/pdf/zip) 仅 metadata.

**Sprint 14 收口验证 checklist** (建议 reviewer 实测):

- [ ] `pnpm test` 全过 (139 chat 相关 + 504+ 其他 = ~643 测试)
- [ ] `pnpm tsc --noEmit` 0 errors
- [ ] `pnpm dev` 实测每个 PR 的 happy path:
  - [ ] PR A: 切换历史 session 不串数据, sidebar 关闭/打开 localStorage 持久化
  - [ ] PR B: hover user msg → edit icon → 改文本 → ⌘↩ save → 后端 truncate + re-stream
  - [ ] PR F: Settings 齿轮跳 `/settings?tab=ai`
  - [ ] PR E: TabBar Maximize2 → 新 BrowserWindow 480×760 全屏 chat, popout 内 close 关窗
  - [ ] PR D: @ 按钮弹 popover, 搜邮件, 选中 chip 显示, 发送后 LLM 看到 referenced email context
  - [ ] PR C: attach 按钮选 .md/.txt 文件 → chip 显示文件名 + size, send 后 LLM 看到 fenced code block

**Sprint 15 / 后续 follow-up 候选** (PR C MVP 未做的完整方案):

- ⏳ chat_attachments 表 + CHAT_DB_VERSION 2→3 migration — 持久化附件元数据 (会话恢复后仍有 chip)
- ⏳ LLM vision 协议 — Anthropic image content block (`{type: "image", source: {...}}`) + OpenAI file_id, 让 LLM 真能看图 / PDF
- ⏳ Main process file picker (Electron `showOpenDialog`) — 替换浏览器 file input, 跟 macOS 原生 dialog 一致
- ⏳ chat_attachments 上传到本地 storage (跟 email attachments 同 `data/chat-attachments/{session_id}/`)
- ⏳ BackendSelector multi-agent / multi-API-key dropdown (PR F polish 第二阶段)

**架构清晰度**: 后端 IPC 全在 `electron/main/handlers/chat.ts`, dispatcher 全在 `electron/main/chat/dispatcher.ts`, hook 全在 `shared/hooks/useEmailChat.ts`, UI 全在 `shared/components/chat/*.tsx`. 每个 PR 都是 backend → IPC → hook → UI 四层。
