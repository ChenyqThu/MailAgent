# PRD — MailAgent Chat Panel × assistant-ui × Vercel AI SDK

> status: planning
> last-verified: 2026-06-22
> scope: front-end chat panel, AI orchestration gateway, tool UI, human approval

## 1. 背景

MailAgent 当前 chat 面板已经具备多轮 agent harness、tool calling、`chat_tool_call` 审计、`pending_confirmation` 人类确认、KOS / Notion / email write tools 等能力，但 UI 与协议层仍然是自研组合：

```txt
AIChatPanel / MessageList / Composer / ConfirmToolDialog
  → useEmailChat / useGeneralChat
  → shared/chat/runtime.ts
  → dispatcher / harness / ChatStreamEvent
  → Python serve-api / domain services
```

这套实现解决了 MailAgent 特有业务问题，但继续扩展会遇到四个瓶颈：

1. Chat 视图层自研过重，难以持续追上现代 Agent UI 能力。
2. Tool UI / approval UI 与消息流耦合，复杂交互卡片会继续膨胀 `MessageList`。
3. LLM provider / streaming / multi-step / tool approval 逻辑在自研 harness 中重复维护。
4. 后续要接 AG-UI / A2A / 外部 agent protocol 时，当前 `ChatStreamEvent` 不是生态标准。

因此，本专项建议升级为：

```txt
assistant-ui 负责唯一聊天视图层
Vercel AI SDK Gateway 负责 LLM streaming / tool calling / approval / UIMessage
Python serve-api + mail-sync 继续负责 MailAgent 业务域能力
A2UI 规范 tool result / approval card 的原生 React 渲染 payload
AG-UI 作为后续协议互操作层
```

## 2. 产品目标

### G1. 视觉和交互一致

聊天面板完全迁移到 assistant-ui primitives / runtime，但 UI 外观必须继续使用 MailAgent 现有 Tailwind token、主题三态、accent 色、shadcn/Radix 组件规范。

### G2. Agent 体验现代化

基础对话提供稳定流式文本、thinking、usage、message editing、branch/retry、attachments、quote context；复杂交互以原生 React tool cards 展示，而不是 JSON log 或 modal 堆叠。

### G3. AI 编排标准化

LLM provider、tool schema、multi-step loop、UIMessage stream、server-side tool approval 从自研 harness 逐步迁移到 Vercel AI SDK Gateway，减少自维护协议和 provider 差异。

### G4. 后端 workflow 与 UI 解耦

AI SDK 只接管“chat / LLM orchestration 层”，不替换 Python 邮件业务域服务。邮件解析、DavMail 写路径、SQLite SSoT、Notion 同步、KOS producer/consumer、FanoutWorker 均保持 Python domain services 所有权。

### G5. 外发邮件安全底线

任何真实发送、跨系统写入、Notion 批量同步、邮件移动 / 删除等高风险动作必须有可审计的人类确认；外发邮件必须绑定内容 hash、approval id、过期时间和最终发送 payload。

## 3. 非目标

- 不把整个 MailAgent 后端改写成 Node / Next.js。
- 不迁移 mail-sync / DavMail / Notion sync / SQLite SSoT 到 Vercel AI SDK。
- 不引入黑盒全栈 agent 框架替代当前业务服务层。
- 不在第一阶段强行删除现有 `useEmailChat` / `chat_db` / `ChatStreamEvent`；它们作为兼容层逐步退役。
- 不把 API key 暴露到 renderer。所有 LLM provider key 留在 Node Gateway / Python serve-api / Keychain 后端侧。

## 4. 用户故事

### U1. 处理当前邮件

作为用户，我打开一封邮件，聊天面板自动理解当前邮件正文、发件人、线程、AI 分类、Notion page 状态；我可以直接问“这封邮件要我做什么？”而不必复制内容。

### U2. 让 Agent 同步到 Notion

作为用户，当 Agent 建议把邮件同步到 Notion 或更新字段时，我看到字段映射、变更预览和确认按钮，可以修改 mapping 后确认。

### U3. 让 Agent 起草并发送邮件

作为用户，当 Agent 准备外发邮件时，我必须先看到收件人、主题、正文、附件和风险摘要；只有点击“允许发送”后才会真实发送。

### U4. 远程 Web / Electron 一致

作为用户，无论在 Electron 本机还是远程 Web，我都看到一致的聊天 UI 和工具卡片；区别只在可用能力和鉴权方式。

## 5. 功能需求

### F1. assistant-ui View Layer

- 使用 assistant-ui 作为唯一 Chat View Layer。
- 支持 Thread、Message、Composer、Tool UI、message edit、retry、stop、attachments、token usage。
- Legacy `MessageList` / `Composer` 仅保留在 feature flag 期间。

### F2. AI SDK Gateway

- 新增 TypeScript / Node AI Gateway。
- 提供 `POST /api/ai/chat`，输入 / 输出使用 AI SDK `UIMessage` stream。
- 使用 `streamText`、`convertToModelMessages`、`tool`、`stopWhen: stepCountIs(N)` 实现多步工具调用。
- Gateway tools 通过 HTTP / typed client 调 Python domain services，不直接读写 `sync_store.db`。

### F3. Context Injection

- 引入 `AgentContextSnapshot`。
- 自动注入当前邮件、选中 sender、thread、AI fields、Notion page、mentions、attachments、UI locale/timezone。
- 所有用户可见 context chip 与实际发送给模型的 context 来源一致。

### F4. Generative UI / A2UI

- 新增 `ComponentRegistry`。
- 工具 result / approval request 包含 `a2ui.mailagent` payload。
- `sync_to_notion`、`notion_property_mapping`、`email_prepare_send`、`email_draft_reply` 优先渲染原生卡片。
- 未注册工具降级为 generic tool trace card。

### F5. Human-in-the-loop

- 使用 AI SDK `needsApproval` 承载标准 approval request。
- assistant-ui tool renderer 使用 `respondToApproval` / approval state 展示审批。
- 外发邮件额外增加 MailAgent domain approval guard：content hash、approval id、expiry、idempotency key。

### F6. Legacy 兼容

- 旧 `ChatStreamEvent` 可映射成 UIMessage / A2UI 以支持灰度。
- 旧 `ai_chat.db` 会话历史可迁移到 `UIMessage` JSON 存储，迁移期间提供双读 / 双写。

## 6. 性能与 SLO

| 指标 | 目标 |
|---|---|
| Chat panel 首屏渲染 | Electron < 200ms；Web < 500ms |
| 首 token | Custom API / AI SDK Gateway < 800ms p50，< 1500ms p95 |
| 工具卡片首渲染 | tool call part 到达后 < 100ms |
| Context snapshot 构建 | 常规邮件 < 150ms；正文缺失 graceful degrade |
| UI stream 丢包 | 0；断流后可显示 partial + retry |
| 外发邮件审批误发 | 0 silent send |

## 7. 安全与合规要求

- Renderer 不持有 LLM API key、Notion token、mail write token。
- 高风险工具必须 `needsApproval`，且 Python domain service 再做 server-side policy check。
- 外发邮件 approval 必须绑定 payload hash，不能只相信“用户点击过按钮”。
- 引用邮件正文、附件内容均标记为 untrusted context。
- Tool audit 必须包含：tool name、input、approval state、user edited input、output、duration、error、model、session/message id。

## 8. 验收口径

- `MAILAGENT_ASSISTANT_UI=1` 下基础对话、streaming、停止、重试、编辑可用。
- `MAILAGENT_AI_SDK_GATEWAY=1` 下新会话默认走 AI SDK Gateway。
- 旧会话能读取，必要时用 legacy renderer fallback。
- `email_prepare_send` 无 approval token 时无法真实发送。
- Notion sync / property mapping 显示 A2UI card，支持修改后确认。
- Electron / Web 至少各完成 10 条 dogfood scenario。

## 9. 关键决策

| 决策 | 结论 |
|---|---|
| 后端是否切 Vercel AI SDK | 切 chat orchestration 层，不切 Python domain 层 |
| assistant-ui runtime | AI SDK Gateway 默认走 `@assistant-ui/react-ai-sdk`；legacy 灰度走 ExternalStoreRuntime |
| 工具注册权威 | AI SDK Gateway 生成 tool schema；Python domain service 是实际业务执行权威 |
| HITL 标准 | AI SDK `needsApproval` + MailAgent hash guard |
| AG-UI | 后续 interop mirror，不作为第一阶段默认 runtime |