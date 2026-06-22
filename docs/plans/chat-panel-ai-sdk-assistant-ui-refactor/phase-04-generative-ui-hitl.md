# Phase 04 — Generative UI & Human-in-the-loop

> status: planning
> last-verified: 2026-06-22
> goal: 在 AI SDK Gateway runtime 下启用 A2UI 原生工具卡片与高风险工具审批。

## 1. 目标

Phase 04 把复杂工具交互从 trace / JSON / modal 升级为 assistant-ui inline tool cards，并把高风险写操作统一接入 AI SDK approval flow 与 MailAgent domain guard。

目标链路：

```txt
AI SDK tool call / approval request
  → UIMessage tool part
  → A2UI payload
  → ComponentRegistry
  → assistant-ui Tool UI card
  → user approves / edits / rejects
  → AI SDK Gateway resumes via approval response
  → Python domain service validates and executes
```

## 2. 交付内容

新增：

```txt
frontend/src/shared/assistant/tools/
  ComponentRegistry.tsx
  a2ui.ts
  registerToolUIs.tsx
  generic/ToolTraceCard.tsx
  notion/NotionSyncCard.tsx
  notion/NotionPropertyMappingCard.tsx
  mail/DraftReplyCard.tsx
  mail/SendApprovalCard.tsx

frontend/src/ai-gateway/security/
  approval.ts
  hashOutboundPayload.ts
  approvalStore.ts
```

Python domain side 新增或扩展：

```txt
src/api/routers/email.py
  POST /api/email/send-approved

src/api/routers/notion.py or existing service endpoint
  POST /api/notion/sync-preview
  POST /api/notion/sync-apply
```

## 3. A2UI ComponentRegistry

Phase 04 的第一步是 registry，不依赖所有卡片一次到位：

```ts
export const componentRegistry = createComponentRegistry([
  genericToolTraceRegistration,
  draftReplyRegistration,
  notionSyncRegistration,
  sendApprovalRegistration,
]);
```

要求：

- 已注册工具渲染专用 card。
- 未注册工具走 generic fallback。
- registry miss 不阻断对话。
- 所有 A2UI payload 进入 `chat_tool_call.ui_payload_json` 审计字段。

## 4. 优先卡片

### 4.1 DraftReplyCard

用途：显示 Agent 准备创建的回复草稿。

必须支持：

- 预览正文。
- 用户编辑 markdown。
- 创建草稿前确认。
- 创建成功后展示 draft id / mailbox。

风险级别：`edit`。

### 4.2 NotionSyncCard

用途：显示 Notion sync dry-run 与字段映射。

必须支持：

- 显示目标 database / page。
- 显示 property mapping。
- 显示 proposed values 与 conflict warning。
- 用户修改 mapping 后确认。

风险级别：

- 单条新建 / 更新：`preview`。
- 批量 / 覆盖字段 / 删除字段：`blocking`。

### 4.3 SendApprovalCard

用途：所有真实外发动作的最终人工确认。

必须支持：

- To / CC / BCC。
- Subject。
- Body editor。
- 附件列表。
- 外部收件人 / 敏感词 / 异常附件 warning。
- approval expiry countdown。
- “允许发送”“修改后继续”“取消”。

风险级别：`blocking`。

## 5. Approval Service

AI SDK Gateway 新增 ApprovalService：

```ts
export interface ApprovalRecord {
  approvalId: string;
  sessionId: number;
  messageId: string;
  toolCallId: string;
  toolName: string;
  risk: 'preview' | 'edit' | 'blocking';
  inputHash: string;
  status: 'requested' | 'approved' | 'rejected' | 'expired' | 'used';
  expiresAt: number;
  createdAt: number;
  decidedAt?: number;
}
```

职责：

1. 创建 approval request。
2. 生成 A2UI payload。
3. 校验用户响应。
4. 写 `chat_tool_call` 审计。
5. 生成 domain service 可验证的 approval token。

## 6. 外发邮件 domain guard

真实发送必须同时通过 Gateway 和 Python domain 校验。

Gateway 校验：

```txt
approval exists
approval not expired
approval status approved / edited
hash(finalDraft) == approval.contentHash
idempotency_key not used in Gateway scope
```

Python domain 校验：

```txt
approval token signature valid
approval token not expired
payload hash matches
idempotency_key not used in MailAgent send ledger
current backend supports send path
```

如果任意一步失败：

```txt
tool_result.status = error / canceled
email not sent
audit row records error code
```

## 7. UIMessage / Tool part 状态

映射：

| AI SDK / Gateway 状态 | UI 展示 |
|---|---|
| `input-streaming` | tool call skeleton |
| `input-available` | card preview / waiting approval |
| `approval-requested` | card requires action |
| `approval-approved` | card shows authorized banner |
| `approval-rejected` | card shows canceled banner |
| `output-available` | result card |
| `output-error` | error card |

## 8. Legacy 兼容

旧 `pending_confirmation` 仍可映射到相同卡片：

```txt
pending_confirmation + toolName=email_draft_reply
  → DraftReplyCard
  → actions.approve calls legacy chat.confirmTool
```

这样 Phase 01 的 assistant-ui shell 也能先用 A2UI cards，不必等待 AI SDK Gateway 完全上线。

## 9. 测试

新增：

```txt
frontend/tests/assistant/tools/ComponentRegistry.test.tsx
frontend/tests/assistant/tools/NotionSyncCard.test.tsx
frontend/tests/assistant/tools/SendApprovalCard.test.tsx
frontend/tests/ai-gateway/approval.test.ts
frontend/tests/ai-gateway/outbound_hash.test.ts
```

场景：

- registry hit / miss。
- A2UI schema invalid fallback。
- approval expired。
- hash mismatch。
- edited draft recomputes hash。
- rejected approval does not execute tool。
- successful approval writes audit and calls domain service once。

## 10. 验收

- `MAILAGENT_A2UI_TOOL_CARDS=1` 下 tool cards 正常渲染。
- `email_draft_reply` 可编辑后创建草稿。
- `sync_to_notion` 可 dry-run、修改 mapping、确认 apply。
- 外发动作无 approval token 时无法执行。
- hash mismatch 不会执行外发动作。
- legacy fallback 仍可关闭 A2UI cards。

## 11. 回滚

```txt
MAILAGENT_A2UI_TOOL_CARDS=0
MAILAGENT_AI_SDK_HIGH_RISK_APPROVAL=0
MAILAGENT_AI_SDK_WRITE_TOOLS=0
```

注意：如果 approval 逻辑出现问题，必须禁用相关高风险工具，而不是允许工具绕过审批。