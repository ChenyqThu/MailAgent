# Generative UI & Human-in-the-loop — A2UI ComponentRegistry 与安全审批

> status: planning
> last-verified: 2026-06-22
> scope: tool cards, A2UI payload, assistant-ui Tool UI, AI SDK tool approval, outbound-message safety

## 1. 目标

MailAgent 的复杂 Agent 交互应在 assistant-ui message stream 内渲染原生 React 卡片，而不是继续依赖 JSON log、toast 或全局 modal。

```txt
AI SDK tool call / approval request / result
  → A2UI payload
  → ComponentRegistry
  → assistant-ui Tool UI
  → MailAgent native React card
```

本文件定义：A2UI ComponentRegistry、Notion sync / property mapping 卡片、邮件草稿 / 外发审批卡片、高风险工具 human-in-the-loop 机制，以及外发消息的“无静默执行”安全底线。

## 2. 术语

| 术语 | 定义 |
|---|---|
| Tool UI | assistant-ui 对 tool call / result 的渲染入口 |
| A2UI | MailAgent 自定义 typed UI payload，用来选择 React card 和 props |
| Approval Request | AI SDK `needsApproval` 产生的待用户确认工具调用 |
| Domain Guard | Python domain service 在真实写操作前的二次安全校验 |
| Content Hash | 外发邮件审批绑定的 payload hash |

## 3. ComponentRegistry

新增目录：

```txt
frontend/src/shared/assistant/tools/
  ComponentRegistry.tsx
  a2ui.ts
  toolSchemas.ts
  registerToolUIs.tsx
  generic/ToolTraceCard.tsx
  generic/ToolErrorCard.tsx
  notion/NotionSyncCard.tsx
  notion/NotionPropertyMappingCard.tsx
  mail/DraftReplyCard.tsx
  mail/SendApprovalCard.tsx
```

核心类型：

```ts
export type ToolUiRisk = 'trace' | 'preview' | 'edit' | 'blocking';

export interface ComponentRegistration<Args = unknown, Result = unknown> {
  toolName: string;
  componentName: string;
  risk: ToolUiRisk;
  parseArgs(args: unknown): Args;
  parseResult?(result: unknown): Result;
  toA2UI(input: {
    args: Args;
    result?: Result;
    status: ToolUiStatus;
    approval?: ToolApprovalRequestPayload;
  }): A2UIPayload;
  render(input: {
    args: Args;
    result?: Result;
    status: ToolUiStatus;
    approval?: ToolApprovalRequestPayload;
    actions: ToolUiActions;
  }): React.ReactNode;
}

export interface ToolUiActions {
  approve(input?: unknown): Promise<void>;
  reject(reason?: string): Promise<void>;
  editAndApprove(input: unknown): Promise<void>;
  openInComposer?(input: unknown): void;
}
```

每个复杂工具注册一个 UI-only Tool UI。工具执行仍在 AI SDK Gateway / Python domain service。

## 4. A2UI payload 示例

### 4.1 Notion sync

```ts
export interface SyncToNotionArgs {
  internal_id: number;
  target_database_id: string;
  target_page_id?: string | null;
  property_map: Record<string, string>;
  proposed_values: Record<string, unknown>;
  dry_run?: boolean;
}

export interface SyncToNotionResult {
  internal_id: number;
  notion_page_id: string;
  applied_values: Record<string, unknown>;
  warnings: string[];
}
```

A2UI：

```ts
{
  protocol: 'a2ui.mailagent',
  version: '1.0',
  component: 'NotionSyncCard',
  props: {
    emailId: 53675,
    targetDatabaseId: '...',
    propertyMap: {...},
    proposedValues: {...},
    warnings: [],
  },
  intents: [
    { id: 'confirm', label: '确认同步', kind: 'primary' },
    { id: 'edit_mapping', label: '修改字段映射', kind: 'secondary' },
    { id: 'cancel', label: '取消', kind: 'danger' }
  ]
}
```

### 4.2 外发邮件审批

```ts
export interface EmailPrepareOutboundArgs {
  internal_id?: number | null;
  mode: 'reply' | 'reply-all' | 'forward' | 'new';
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body_markdown: string;
  body_html?: string;
  attachments?: SendAttachmentPreview[];
  importance?: 'high' | 'normal' | 'low';
  risk_summary: SendRiskSummary;
  idempotency_key: string;
  content_hash: string;
  expires_at: string;
}
```

A2UI：

```ts
{
  protocol: 'a2ui.mailagent',
  version: '1.0',
  component: 'SendApprovalCard',
  props: {
    draft: emailPrepareOutboundArgs,
    approval: {
      id: 'appr_...',
      risk: 'blocking',
      reason: 'Outbound email requires explicit approval',
      expiresAt: '2026-06-22T...Z',
      contentHash: 'sha256:...'
    }
  },
  audit: {
    risk: 'blocking',
    requiresApproval: true,
    approvalId: 'appr_...',
    contentHash: 'sha256:...'
  }
}
```

## 5. Human-in-the-loop 机制

高风险工具在 AI SDK Gateway 中声明 `needsApproval`。UI 行为：

```txt
tool approval request arrives
  → SendApprovalCard renders inline
  → user chooses approve / edit / reject
  → frontend appends approval response message
  → second stream call resumes tool execution
```

和当前 `awaitConfirmation` 的区别：

```txt
当前 legacy harness:
  dispatchTools → awaitConfirmation(toolUseId) → renderer confirmTool → same promise resumes

目标 AI SDK flow:
  streamText step produces approval request → message requires action
  → user approval response becomes next input → new streamText call continues
```

迁移期：

- Legacy session 继续支持 `pending_confirmation`。
- AI SDK session 使用 approval request / response。

## 6. 外发邮件安全底线

真实外发类 domain endpoint 必须要求 approval token：

```ts
export interface OutboundApprovalToken {
  approvalId: string;
  sessionId: number;
  messageId: string;
  toolCallId: string;
  contentHash: string;
  approvedBy: 'local-user';
  approvedAt: string;
  expiresAt: string;
}
```

Python domain service 必须验证：

1. approval id 存在且未使用。
2. approval 未过期。
3. session / message / toolCall 匹配。
4. 当前 outbound payload 的 stable hash 与 approval 绑定的 hash 一致。
5. idempotency key 未重复使用。
6. 用户拒绝 / 修改后未重新批准时不执行外发动作。

## 7. SendApprovalCard UX

卡片必须展示：

- To / CC / BCC。
- Subject。
- Body editor。
- Attachment list。
- External recipient warning。
- Sensitive terms warning。
- Expiry countdown。
- “允许发送”“修改后继续”“取消”。

用户点击后产生结构化 approval response：

```ts
export interface OutboundApprovalResponse {
  approvalId: string;
  decision: 'approved' | 'edited' | 'rejected';
  finalDraft?: EmailPrepareOutboundArgs;
  contentHash?: string;
  reason?: string;
}
```

## 8. Notion Sync Card UX

`NotionSyncCard` 展示：

- 当前邮件摘要。
- 目标 Notion database / page。
- 字段 mapping。
- Proposed values。
- 冲突 / missing property warning。
- Dry-run diff。
- Confirm / edit mapping / cancel。

高风险规则：

- 新建 page：preview approval。
- 更新 existing page：preview approval。
- 批量同步：blocking approval。
- 删除 / 覆盖字段：blocking approval。

## 9. Generic fallback

未注册工具显示：

```tsx
<ToolTraceCard
  toolName={toolName}
  input={input}
  output={output}
  status={status}
/>
```

原则：

- 不能因为 registry miss 而丢工具结果。
- 高风险但未注册的工具必须显示 raw input 并要求 fallback approval。
- Registry miss 应记录 telemetry。

## 10. 审计表兼容

`chat_tool_call` 扩展字段：

```txt
approval_id TEXT NULL
approval_status TEXT NULL        -- none / requested / approved / rejected / expired
approval_content_hash TEXT NULL
approval_expires_at INTEGER NULL
ui_payload_json TEXT NULL         -- A2UI payload
```

AI SDK Gateway 每次 tool state 变化写入：

```txt
requested → approved/rejected → running → ok/error/canceled
```

## 11. 测试

- A2UI schema validation。
- ComponentRegistry unknown fallback。
- SendApprovalCard hash mismatch。
- Approval expired。
- Rejected tool does not execute domain service。
- Edited draft recomputes hash。
- NotionSyncCard edit mapping produces edited approval response。
- Legacy `pending_confirmation` still works under rollback flag。