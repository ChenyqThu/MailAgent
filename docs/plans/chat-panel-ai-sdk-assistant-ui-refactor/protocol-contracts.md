# Protocol Contracts — UIMessage / A2UI / AG-UI / Legacy ChatStreamEvent

> status: planning
> last-verified: 2026-06-22
> purpose: define the compatibility layer while MailAgent migrates from custom ChatStreamEvent to AI SDK UIMessage and, later, AG-UI interop.

## 1. 协议分层

本专项同时涉及四个“协议/格式”，必须明确职责，避免混用：

| 层 | 协议 / 格式 | 职责 | 是否第一阶段主路径 |
|---|---|---|---|
| 视图 runtime | AI SDK `UIMessage` stream | assistant-ui 与 AI SDK Gateway 的主交互格式 | 是 |
| 生成式 UI | A2UI MailAgent payload | tool result / approval card 的 typed React 渲染 payload | 是 |
| 互操作事件 | AG-UI | 后续对外 agent event / interrupt / state snapshot mirror | 否，Phase 5 |
| Legacy | `ChatStreamEvent` | 当前自研 stream event，迁移期兼容和回滚 | 是，作为 adapter |

## 2. Canonical Message Format

迁移后，`UIMessage` 是 chat 视图层的 canonical message format。

```ts
export type MailAgentUIMessage = UIMessage<MailAgentMetadata, MailAgentDataParts, MailAgentTools>;

export interface MailAgentMetadata {
  sessionId: number;
  anchorType: 'email' | 'general';
  anchorId: number | null;
  model: string | null;
  costUsd?: number | null;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  mailagentVersion: string;
}
```

持久化字段：

```txt
ai_chat_messages.ui_message_json = JSON.stringify(MailAgentUIMessage)
ai_chat_messages.content_text_legacy = extractText(uiMessage)
```

## 3. A2UI Payload

A2UI 是 MailAgent 自定义的“工具 UI 渲染 payload”，不替代 AI SDK / AG-UI，而是作为 tool result / approval data 的 typed payload。

```ts
export interface A2UIPayload<Props = Record<string, unknown>> {
  protocol: 'a2ui.mailagent';
  version: '1.0';
  component: string;
  props: Props;
  intents?: A2UIIntent[];
  audit?: {
    risk: 'trace' | 'preview' | 'edit' | 'blocking';
    requiresApproval: boolean;
    approvalId?: string;
    contentHash?: string;
  };
}

export interface A2UIIntent {
  id: string;
  label: string;
  kind: 'primary' | 'secondary' | 'danger';
  payload?: unknown;
}
```

A2UI 出现位置：

```ts
// Tool result payload
{
  ok: true,
  data: {...},
  a2ui: {
    protocol: 'a2ui.mailagent',
    component: 'NotionSyncCard',
    props: {...}
  }
}

// Tool approval request payload
{
  toolCallId,
  toolName: 'email_prepare_send',
  state: 'input-available',
  input: {...},
  a2ui: {
    protocol: 'a2ui.mailagent',
    component: 'SendApprovalCard',
    props: {...}
  }
}
```

## 4. Legacy ChatStreamEvent → UIMessage Mapping

迁移期需要把旧 session / legacy runtime event 转成 UIMessage part。

| Legacy event | UIMessage / part 映射 |
|---|---|
| `chunk` | append to assistant text part |
| `thinking` | `data-thinking` part |
| `tool_call` | `data-tool-trace` part 或 legacy tool message |
| `tool_use` | tool part with `state: 'input-available'` |
| `pending_confirmation` | tool part with `state: 'input-available'` + A2UI approval payload |
| `tool_result` | tool part with `state: 'output-available'` |
| `usage` | message metadata.usage |
| `done` | message status complete |
| `error` | message status error + metadata.error |

示例 adapter：

```ts
export function legacyEventToUIMessagePatch(event: ChatStreamEvent): UIMessagePatch {
  switch (event.type) {
    case 'chunk':
      return { kind: 'append-text', delta: event.delta };
    case 'thinking':
      return { kind: 'append-data', part: { type: 'data-thinking', data: { delta: event.delta } } };
    case 'tool_use':
      return {
        kind: 'upsert-tool',
        toolCallId: event.toolUseId,
        toolName: event.name,
        state: 'input-available',
        input: event.input,
      };
    case 'tool_result':
      return {
        kind: 'upsert-tool',
        toolCallId: event.toolUseId,
        state: 'output-available',
        output: event.output ?? { error: event.errorMessage, status: event.status },
      };
  }
}
```

## 5. AI SDK Gateway Request Contract

Endpoint:

```txt
POST /api/ai/chat
Content-Type: application/json
Accept: text/event-stream
```

Request:

```ts
export interface MailAgentAIChatRequest {
  threadId?: string | null;
  sessionId?: number | null;
  anchor: {
    type: 'email' | 'general';
    id: number | null;
  };
  messages: MailAgentUIMessage[];
  contextSnapshot: AgentContextSnapshot;
  backend?: {
    model?: string | null;
    provider?: 'gateway' | 'anthropic' | 'openai-compatible';
  };
  options?: {
    thinking?: boolean;
    maxSteps?: number;
    enabledSkills?: string[];
  };
}
```

Response:

```txt
AI SDK UIMessage stream
```

第一阶段可以保持 AI SDK 默认 data stream；后续若 assistant-ui runtime 需要自定义 transport，可封装 `MailAgentChatTransport`。

## 6. Python Domain Service Contract

AI SDK Gateway 不直接写 MailAgent business DB，而是调用 domain endpoints。

### 6.1 Read tools

```txt
GET  /api/email/{id}
GET  /api/email/{id}/body?format=markdown
GET  /api/email/search
POST /api/email/threads
POST /api/chat/kos-call
```

### 6.2 Write tools

```txt
POST /api/email/{id}/flag
POST /api/email/{id}/archive
POST /api/email/draft
POST /api/email/send-approved
POST /api/notion/sync-preview
POST /api/notion/sync-apply
```

新增或调整 endpoint 时，必须满足：

- 接收 typed JSON body。
- 返回 `{ ok, data, error, meta }` 或现有 envelope。
- 每个写 endpoint 自带 server-side authorization。
- 高风险 endpoint 检查 approval token / hash。

## 7. Tool Approval Contract

AI SDK Gateway approval request：

```ts
export interface ToolApprovalRequestPayload {
  toolCallId: string;
  toolName: string;
  input: unknown;
  approval: {
    id: string;
    risk: 'preview' | 'edit' | 'blocking';
    reason: string;
    expiresAt: string;
    contentHash?: string;
  };
  a2ui?: A2UIPayload;
}
```

用户响应：

```ts
export interface ToolApprovalResponsePayload {
  toolCallId: string;
  approvalId: string;
  decision: 'approved' | 'rejected' | 'edited';
  editedInput?: unknown;
  reason?: string;
  contentHash?: string;
}
```

Gateway 行为：

1. 校验 approval id 是否存在。
2. 校验过期时间。
3. 如果有 content hash，重新计算输入 hash。
4. 写 `chat_tool_call.approval_status`。
5. 对 approved / edited 继续第二次 model call。
6. 对 rejected 生成 tool result canceled。

## 8. AG-UI Mirror Contract

Phase 5 后新增：

```txt
POST /api/ai/agui/chat
```

映射：

| UIMessage / AI SDK event | AG-UI event |
|---|---|
| user message submitted | `RUN_STARTED` |
| assistant text delta | `TEXT_MESSAGE_*` |
| thinking data part | `THINKING_*` / reasoning event |
| tool input available | `TOOL_CALL_*` |
| tool output available | `TOOL_CALL_RESULT` |
| context snapshot | `STATE_SNAPSHOT` |
| approval request | `RUN_FINISHED` with interrupt / requires-action outcome |
| error | `RUN_ERROR` |
| completion | `RUN_FINISHED` success |

AG-UI 只做 interop，不成为 MailAgent 第一阶段 canonical persistence format。

## 9. Versioning

所有协议 payload 必须带版本：

```ts
mailagentProtocol: {
  uiMessageVersion: 'ai-sdk-v6';
  a2uiVersion: '1.0';
  contextVersion: 'mailagent.context.v1';
}
```

Breaking change 规则：

- A2UI props 删除 / 改名：minor 不允许，必须 bump major。
- ContextSnapshot 新增字段：minor 可接受。
- Tool input schema 收窄：需要 migration note。
- Approval guard 变更：必须更新 HITL 文档和 acceptance checklist。

## 10. 测试要求

- Legacy event → UIMessage patch golden tests。
- UIMessage → persisted `ai_chat_messages` roundtrip tests。
- A2UI schema validation tests。
- Approval response hash mismatch tests。
- AG-UI mirror event sequence tests。
- Renderer Tool UI snapshot tests。