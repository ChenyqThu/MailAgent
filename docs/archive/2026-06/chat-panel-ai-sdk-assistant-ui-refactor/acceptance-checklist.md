# Acceptance Checklist — Chat Panel AI SDK / assistant-ui 重构专项

> status: planning
> last-verified: 2026-06-22
> usage: 每个 PR / phase 合入前按本清单验收；高风险项未通过不得默认开启。

## 1. 总体验收

- [ ] 默认 flag off 时现有 MailAgent chat 行为完全不变。
- [ ] assistant-ui shell flag on 后基础对话可用。
- [ ] AI SDK Gateway flag on 后新会话可走 UIMessage stream。
- [ ] Python domain services 仍是邮件 / Notion / KOS / SQLite SSoT 的唯一业务权威。
- [ ] Renderer 不接触 provider API key、Notion token、mail write token。
- [ ] Electron 与 Web 两端均有 smoke test。
- [ ] 所有 high-risk tools 无静默执行路径。

## 2. Phase 00 — Research & Spike

- [ ] 官方文档调研完成并记录。
- [ ] AI SDK Gateway 是否引入的边界明确。
- [ ] assistant-ui runtime 选择明确。
- [ ] AG-UI 是否作为主路径的决策明确。
- [ ] Gateway `/health` spike 可跑通。
- [ ] AI SDK pure text streaming PoC 可跑通。
- [ ] Tool approval PoC 记录了与 legacy `awaitConfirmation` 的语义差异。
- [ ] 没有默认行为变化。

## 3. Phase 01 — assistant-ui Shell

- [ ] `MAILAGENT_ASSISTANT_UI_PANEL=1` 时使用 assistant-ui shell。
- [ ] flag off 时旧 `AIChatPanel` 路径可用。
- [ ] `ChatMessage` → assistant message 映射正确。
- [ ] streaming chunk 不重复、不丢失。
- [ ] thinking part 可折叠显示。
- [ ] tool_use / tool_result 可显示为 tool step。
- [ ] pending confirmation 不丢失，legacy ConfirmToolDialog fallback 可用。
- [ ] stop / retry / edit user message 可用。
- [ ] session history / popout 可用。
- [ ] 视觉 token 与 MailAgent 主界面一致。

## 4. Phase 02 — AI SDK Gateway

- [ ] Gateway lifecycle 由 Electron main 管理。
- [ ] `/health` 返回 Gateway、Python API、model 配置状态。
- [ ] `/api/ai/chat` 支持 pure text UIMessage stream。
- [ ] abort signal 可取消 upstream stream。
- [ ] provider key 只在 Gateway / main / secure backend 侧读取。
- [ ] Gateway 到 Python serve-api 使用内部鉴权。
- [ ] UIMessage 可持久化并 reload。
- [ ] Gateway 不可用时前端有 graceful fallback。
- [ ] Electron 和 Web 访问路径均验证。

## 5. Phase 03 — Tool Registry Migration

### Read tools

- [ ] `email_search` 可用。
- [ ] `email_get` 可用。
- [ ] `email_body` 可用。
- [ ] `email_list_thread` 可用。
- [ ] `email_search_attachments` 可用。
- [ ] `kos_query` 可用或在 KOS 未配置时明确 unavailable。
- [ ] read tools 不请求 approval。
- [ ] read tools 不产生 side effect。

### Write tools

- [ ] `email_flag` 默认需要 preview approval。
- [ ] `email_archive` 默认需要 preview approval。
- [ ] `email_draft_reply` 默认需要 edit approval。
- [ ] `sync_to_notion` 默认需要 preview / blocking approval。
- [ ] write tools 全部通过 Python domain service 执行。
- [ ] write tools 全部写 `chat_tool_call` audit。
- [ ] Gateway schema 与 Python validation 不冲突。
- [ ] legacy / AI SDK tool parity tests 覆盖关键字段。

## 6. Phase 04 — Generative UI & Human-in-the-loop

### A2UI / Tool Cards

- [ ] ComponentRegistry 可注册工具卡片。
- [ ] registry miss 显示 generic fallback。
- [ ] A2UI payload schema validation 失败时 fallback，不崩溃。
- [ ] Tool card props 不包含 secret。
- [ ] A2UI payload 写入 audit。

### Notion cards

- [ ] NotionSyncCard 显示目标 database / page。
- [ ] NotionSyncCard 显示字段 mapping。
- [ ] NotionSyncCard 显示 proposed values / conflict warnings。
- [ ] 用户可修改 mapping 后确认。
- [ ] dry-run 和 apply 分离。

### Draft / outbound cards

- [ ] DraftReplyCard 可编辑正文。
- [ ] 创建草稿前必须确认。
- [ ] SendApprovalCard 显示 To / CC / BCC。
- [ ] SendApprovalCard 显示 Subject / Body / Attachments。
- [ ] SendApprovalCard 显示外部收件人 / 敏感词 warning。
- [ ] SendApprovalCard 显示 expiry 状态。
- [ ] approve / edit / reject 三路径都可用。

### Safety

- [ ] 无 approval token 不能执行真实外发。
- [ ] approval 过期不能执行真实外发。
- [ ] hash mismatch 不能执行真实外发。
- [ ] idempotency key 重复不能重复外发。
- [ ] rejected approval 不执行 domain write。
- [ ] session abort / navigation 取消 pending approval。

## 7. Phase 05 — AG-UI Interop

- [ ] `MAILAGENT_AG_UI_MIRROR=1` 时 `/api/ai/agui/chat` 可用。
- [ ] text stream 映射为 AG-UI text events。
- [ ] tool call / tool result 映射正确。
- [ ] approval request 映射为 interrupt / requires-action。
- [ ] context snapshot 映射为 state snapshot。
- [ ] AG-UI mirror 关闭后不影响 AI SDK runtime 主路径。
- [ ] AG-UI event golden snapshot 覆盖基础对话、工具、approval、error。

## 8. Phase 06 — Cutover & Cleanup

- [ ] 新会话默认 `backend_kind='ai-sdk'`。
- [ ] 旧会话可读。
- [ ] 旧 `custom-api` / `notion-agent` session 有明确 fallback / migration path。
- [ ] assistant-ui 是唯一产品聊天视图层。
- [ ] legacy UI 主路径移除或 hidden。
- [ ] Gateway health 不可用时自动 fallback。
- [ ] rollback flags 仍可恢复 legacy。
- [ ] dogfood 7 天无 P0/P1 后才删除 legacy harness 主路径。

## 9. 性能验收

- [ ] Electron chat panel 首屏 < 200ms。
- [ ] Web chat panel 首屏 < 500ms。
- [ ] 首 token p50 < 800ms。
- [ ] 首 token p95 < 1500ms。
- [ ] tool card 首渲染 < 100ms。
- [ ] Context snapshot 常规邮件构建 < 150ms。
- [ ] 切换邮件不会泄漏旧 stream chunk。
- [ ] 取消 stream 后不会 resurrect spinner。

## 10. 安全验收

- [ ] Renderer bundle 不包含 provider API key。
- [ ] Gateway 不把 secret 写入 UIMessage / A2UI / AG-UI state。
- [ ] 邮件正文 / 附件 / mention 全部标记 untrusted。
- [ ] Prompt injection marker tests 通过。
- [ ] high-risk tools 全部有 approval policy。
- [ ] Python domain services 全部做二次校验。
- [ ] audit row 可追踪 tool input、edited input、approval、output、error。

## 11. 回归场景

- [ ] 总结当前邮件。
- [ ] 根据当前邮件起草回复。
- [ ] 搜索历史邮件并引用结果回答。
- [ ] 查询附件内容。
- [ ] 标记邮件已完成。
- [ ] Archive 邮件。
- [ ] 同步当前邮件到 Notion。
- [ ] 修改 Notion property mapping 后同步。
- [ ] 生成外发邮件并审批发送。
- [ ] 用户拒绝外发，Agent 正确停止。
- [ ] KOS 不可用时 fallback 到本地搜索。
- [ ] 远程 Web chat 正常。
- [ ] Electron popout chat 正常。
- [ ] 切换邮件时旧 stream abort。

## 12. 合入前命令

```bash
cd frontend
pnpm typecheck
pnpm test
pnpm test:e2e
```

后端相关变更：

```bash
pytest tests/api tests/services tests/llm_agent
```

如新增 DB schema：

```bash
pnpm test -- chat_db
pytest tests/chat
```
