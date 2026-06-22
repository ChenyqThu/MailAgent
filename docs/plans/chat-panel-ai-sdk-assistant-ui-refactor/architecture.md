# Architecture — assistant-ui × Vercel AI SDK Gateway × MailAgent Domain Services

> status: planning
> last-verified: 2026-06-22
> decision: use AI SDK for chat orchestration, not for MailAgent domain backend replacement

## 1. 结论

后端也切 Vercel AI SDK 后，整体架构**会更优**，但前提是切对边界：

- **切到 AI SDK**：模型调用、流式响应、tool schema、multi-step tool loop、tool approval、UIMessage stream、assistant-ui runtime integration。
- **不切到 AI SDK**：邮件同步、DavMail / AppleScript fallback、SQLite SSoT、Notion page 写入、KOS、附件抽取、outbox FanoutWorker、现有 Python service-layer。

目标架构不是“全栈换框架”，而是新增一个 **AI SDK Gateway**：

```txt
Electron Renderer / Web SPA
  └─ assistant-ui Thread / Composer / Tool UI
      └─ @assistant-ui/react-ai-sdk runtime
          └─ AI SDK useChat transport
              └─ Node AI SDK Gateway
                  ├─ streamText / convertToModelMessages
                  ├─ AI SDK tools / needsApproval
                  ├─ UIMessage stream
                  ├─ ai_chat.db / chat persistence adapter
                  └─ Python Domain Client
                       └─ serve-api /api/email /api/chat /api/agent /api/skills /api/reports
                           └─ SQLite SSoT / mail-sync / Notion / KOS / DavMail
```

## 2. 当前架构简述

当前 MailAgent chat 主要由 TS shared runtime 与 Python serve-api 共同组成：

```txt
AIChatPanel.tsx
  → useEmailChat / useGeneralChat
  → MailApi.chat
  → shared/chat/runtime.ts
  → createChatDispatcher
  → runHarness
  → ChatBackend.stream(): AsyncIterable<ChatStreamEvent>
  → custom_api.ts / notion_agent_http.ts
  → src/api/routers/chat.py /llm-proxy /notion-agent
```

优点：

- 已有稳定的 `ai_chat.db`、`chat_tool_call`、pending confirmation、tool registry。
- 和 MailAgent domain services 深度集成。
- Electron 与 Web 共享 runtime，远程访问已有 serve-api。

问题：

- 自研 provider stream parser 与 AI SDK 生态重复。
- 自研 harness 继续维护 multi-step、tool calling、approval、thinking、usage 的成本高。
- assistant-ui 要最佳体验时，AI SDK UIMessage stream / useChat runtime 是更自然的接入面。
- AG-UI / A2A / 外部 agent protocol 需要标准事件层，当前 `ChatStreamEvent` 需要 adapter。

## 3. 目标架构分层

### 3.1 View Layer

```txt
frontend/src/shared/assistant/
  components/          assistant-ui based Thread / Message / Composer
  tools/               A2UI ComponentRegistry + Tool UI cards
  context/             AgentContextSnapshot + context chips
  runtime/             AI SDK runtime / legacy runtime / AG-UI mirror adapters
```

职责：

- 唯一聊天视图层。
- 渲染 text / thinking / tool call / approval / result / error。
- 使用 Tailwind + MailAgent token + shadcn/Radix。
- 不直接调用 LLM provider，不读 secret。

### 3.2 AI SDK Gateway Layer

新增 Node/TypeScript 服务，可位于：

```txt
frontend/src/ai-gateway/               # 方案 A：随 Electron main / dev server 打包
src/ai_gateway/ 或 services/ai-gateway/ # 方案 B：独立 package / service
```

推荐项目内第一版：

```txt
frontend/src/ai-gateway/
  server.ts
  routes/chat.ts
  routes/threads.ts
  tools/index.ts
  tools/email.ts
  tools/notion.ts
  tools/kos.ts
  tools/reports.ts
  context/buildContext.ts
  persistence/chatStore.ts
  python/domainClient.ts
  security/approval.ts
```

职责：

- 对前端暴露 AI SDK UI-compatible chat endpoint。
- 使用 `streamText` 统一 provider streaming。
- 使用 `convertToModelMessages` 从 UIMessage 转模型消息。
- 使用 AI SDK `tool()` 定义工具。
- 使用 `stopWhen: stepCountIs(N)` 实现多步工具链。
- 使用 `needsApproval` 生成 approval request。
- 写 `ai_chat.db` 或调用 Python chat persistence endpoints。
- 作为 Python domain services 的 typed HTTP client。

### 3.3 Python Domain Services Layer

保持现状并强化边界：

```txt
src/api/routers/email.py
src/api/routers/chat.py
src/api/routers/agent.py
src/api/routers/skills.py
src/api/routers/reports.py
src/services/
src/mail/
src/notion/
src/kos/
```

职责：

- 邮件读取 / 搜索 / 正文 / 附件。
- 写操作：flag、archive、move、draft、send、resync、Notion sync。
- SQLite SSoT 与 outbox 维护。
- Notion / DavMail / KOS 具体业务执行。
- 二次鉴权和业务安全校验。

## 4. 部署形态

### 4.1 Electron 本机

```txt
MailAgent.app
  ├─ Electron main
  ├─ Renderer
  ├─ embedded Python serve-api
  └─ embedded Node AI SDK Gateway
```

- Renderer 走 `http://127.0.0.1:<aiGatewayPort>/api/ai/chat`。
- AI Gateway 走 `http://127.0.0.1:<serveApiPort>/api/*`。
- Electron main 负责端口发现、token 注入、生命周期管理。
- LLM API key 从 keytar / env 读，只在 Gateway / main 侧可见。

### 4.2 远程 Web

```txt
Browser / PWA
  → Cloudflare Access
  → cloudflared tunnel
  → local AI SDK Gateway
  → local Python serve-api
```

- 远程 Web 不持有 provider key。
- Cloudflare Access 继续作为外层鉴权。
- Gateway 对 CF Access / local token 做二次鉴权。
- 可选择只暴露 Gateway，由 Gateway 代理部分 serve-api；也可保留现有 `/api` serve-api，Gateway 只管 `/api/ai/*`。

### 4.3 AI Gateway 是否一定要独立进程

推荐分阶段：

1. **Phase 2 PoC**：在 Electron main 内启动一个 Node HTTP server，或复用 Vite dev server style。
2. **Phase 3+**：如果稳定，作为 `mailagent-ai-gateway` 独立本地服务，由 Electron lifecycle 管理。
3. **打包**：随 `frontend/` Node bundle 进入 app，不新增用户安装步骤。

## 5. 数据流

### 5.1 基础对话

```txt
assistant-ui Composer submit
  → useChatRuntime / AssistantChatTransport
  → POST /api/ai/chat { messages, contextSnapshot, threadId }
  → AI Gateway streamText({ model, system, messages, tools })
  → toUIMessageStreamResponse()
  → assistant-ui Thread streaming render
  → onFinish persist UIMessage + usage
```

### 5.2 工具调用

```txt
LLM emits tool call
  → AI SDK validates zod inputSchema
  → tool.execute() in Gateway
  → Gateway calls Python domain service
  → Python returns domain result envelope
  → Gateway wraps result with A2UI payload
  → UIMessage tool part streams to assistant-ui
  → ComponentRegistry renders card
```

### 5.3 高风险工具审批

```txt
LLM emits tool call for email_prepare_send
  → AI SDK tool has needsApproval: true / async policy
  → streamText completes with tool-approval-request part
  → assistant-ui renders SendApprovalCard
  → user approves / edits / rejects
  → frontend sends tool-approval-response
  → Gateway validates approval hash / expiry
  → second streamText call executes approved tool
  → Python domain service performs send only after server-side approval guard
```

注意：AI SDK 的 tool approval 不是“同一个 streamText 调用原地暂停”，而是“两次调用模型”的 flow；因此 MailAgent 对“挂起后恢复”的 mental model 要从当前 `awaitConfirmation()` 迁移到 approval-request / approval-response 消息模型。

### 5.4 Context Injection

```txt
Renderer builds AgentContextSnapshot
  → Gateway validates / normalizes snapshot
  → Gateway enriches with server-side body / AI fields if needed
  → buildSystemPrompt + model messages
  → tool execute context receives snapshot
```

## 6. 持久化架构

当前：

```txt
ai_chat.db
  ai_chat_sessions
  ai_chat_messages
  chat_tool_call
  agent_memory_kv
```

目标推荐：

```txt
ai_chat_sessions
  id
  anchor_type
  anchor_id
  backend_kind = 'ai-sdk'
  model
  created_at / updated_at

ai_chat_messages
  id
  session_id
  role
  content_text_legacy
  ui_message_json        # AI SDK UIMessage canonical payload
  status
  model
  usage_json
  metadata_json
  created_at / updated_at

chat_tool_call
  id
  message_id
  tool_call_id
  tool_name
  input_json
  approval_id
  approval_status
  approval_hash
  user_edited_input_json
  output_json
  status
  duration_ms
  created_at / updated_at
```

迁移策略：

- 第一阶段新增 `ui_message_json`，旧 `content` 继续保留。
- 新会话双写 UIMessage JSON + legacy content。
- 旧会话读取时转换为 UIMessage。
- Cutover 后以 UIMessage 为 SSoT，legacy 字段仅用于兼容 / 搜索。

## 7. Tool 架构

### 7.1 Gateway Tool Registry

```ts
export const mailagentTools = {
  emailSearch: tool({ inputSchema, execute }),
  emailGet: tool({ inputSchema, execute }),
  emailDraftReply: tool({ inputSchema, needsApproval, execute }),
  emailPrepareSend: tool({ inputSchema, needsApproval: true, execute }),
  syncToNotion: tool({ inputSchema, needsApproval: true, execute }),
  kosQuery: tool({ inputSchema, execute }),
};
```

### 7.2 Domain Client

```ts
class MailAgentDomainClient {
  emailSearch(input): Promise<SearchResult>;
  getEmailContext(id): Promise<EmailContext>;
  createDraft(input): Promise<DraftResult>;
  sendApproved(input): Promise<SendResult>;
  syncToNotion(input): Promise<NotionResult>;
}
```

### 7.3 A2UI Result Envelope

每个复杂工具 result 都携带可选 UI payload：

```ts
type ToolResultWithA2UI<T> = T & {
  a2ui?: {
    protocol: 'a2ui.mailagent';
    version: '1.0';
    component: string;
    props: Record<string, unknown>;
  };
};
```

## 8. assistant-ui 接入

目标使用：

```tsx
import { useChatRuntime } from '@assistant-ui/react-ai-sdk';

const runtime = useChatRuntime({
  api: '/api/ai/chat',
  transport: new MailAgentAssistantTransport({ contextSnapshot }),
});

<AssistantRuntimeProvider runtime={runtime}>
  <Thread />
  <MailAgentToolUIs />
</AssistantRuntimeProvider>
```

保留 legacy fallback：

```txt
MAILAGENT_CHAT_RUNTIME=legacy-external-store | ai-sdk | ag-ui
```

## 9. AG-UI 位置

AG-UI 不作为第一阶段主路径。它的价值在于后续互操作：

```txt
AI SDK UIMessage stream
  → AG-UI mirror adapter
  → external agent clients / CopilotKit / future protocol consumers
```

对应 endpoint：

```txt
GET/POST /api/ai/agui/chat
```

AG-UI mirror 输出：text、thinking、tool_call、tool_result、state_snapshot、interrupt。

## 10. 关键设计决策

| 决策 | 选择 | 原因 |
|---|---|---|
| AI SDK 放在哪 | Node AI Gateway | AI SDK 是 TypeScript toolkit；不应嵌进 Python 核心业务 |
| assistant-ui runtime | AI SDK Runtime 主路径 | 和 UIMessage stream、tool UI、attachments、multi-step 最贴合 |
| Python serve-api 是否保留 | 保留 | 业务服务层和 SSoT 已成熟 |
| Tool approval | AI SDK `needsApproval` + domain hash guard | 生态标准 + MailAgent 安全补强 |
| 历史持久化 | UIMessage JSON 逐步成为 canonical | assistant-ui / AI SDK 原生兼容 |
| AG-UI | 后置 mirror | 避免一开始同时迁移两个协议面 |

## 11. 主要风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| Node Gateway 增加一个本地服务 | 打包 / 生命周期复杂度上升 | Electron lifecycle 管理，健康检查，端口注入 |
| AI SDK approval 是两次模型调用 | 和当前 awaitConfirmation 语义不同 | 文档和 UI 明确“审批后继续”，审批消息进入 thread |
| 工具从 TS harness 迁移到 AI SDK tools | 可能出现 parity 差异 | 单工具迁移、golden fixtures、legacy fallback |
| UIMessage 持久化迁移 | 历史会话兼容风险 | 双写、读转换、按 session backend_kind 路由 |
| 密钥边界 | Renderer 泄漏风险 | Gateway-only secrets，preload 不暴露 provider key |

## 12. 推荐默认架构

最终稳定态：

```txt
frontend/src/shared/components/chat/AIChatPanel.tsx
  → AssistantRuntimeProvider
  → useChatRuntime(@assistant-ui/react-ai-sdk)
  → /api/ai/chat
  → AI SDK Gateway streamText
  → Python domain services
```

Legacy 保留最小兼容：

```txt
legacy ChatStreamEvent adapter
  → read old sessions
  → support rollback
  → cutover 后归档 / 删除
```