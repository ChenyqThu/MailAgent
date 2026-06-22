# Phase 03 — Tool Registry Migration

> status: planning
> last-verified: 2026-06-22
> goal: 将 MailAgent agent tools 从 legacy harness registry 逐步迁移到 AI SDK Gateway tools，同时保持 Python domain service 权威。

## 1. 目标

Phase 03 迁移工具定义与执行编排，不一次性删除 legacy `shared/chat/tools/*`。

目标架构：

```txt
AI SDK Gateway tools
  → zod inputSchema
  → needsApproval policy
  → execute(ctx)
      → MailAgentDomainClient
          → Python serve-api domain endpoints
              → SQLite SSoT / Notion / DavMail / KOS
  → UIMessage tool part / A2UI payload
```

## 2. 迁移顺序

### 2.1 Read tools first

优先迁移无副作用工具：

| Tool | 来源 | Python endpoint / service | 备注 |
|---|---|---|---|
| `email_search` | legacy builtin | `/api/email/search` | 搜索邮件 metadata / FTS |
| `email_get` | legacy builtin | `/api/email/{id}` | 获取邮件 metadata |
| `email_body` | legacy builtin | `/api/email/{id}/body` | 获取 markdown/html/raw |
| `email_list_thread` | legacy builtin | `/api/email/thread/{threadId}` | 当前线程 |
| `email_search_attachments` | legacy builtin | attachment FTS endpoint | 附件全文 |
| `kos_query` | legacy builtin | `/api/chat/kos-call` | KOS consumer |
| `report_list` / `report_get` | legacy builtin / manifest | `/api/reports/*` | 报告 Agent |

### 2.2 Preview write tools

第二步迁移低风险 / 可逆写工具，但默认需要 approval：

| Tool | 风险 | 迁移策略 |
|---|---|---|
| `email_flag` | preview | 需要确认，调用 flag service |
| `email_archive` | preview | 需要确认，调用 archive service |
| `email_pin` | preview | 需要确认 |
| `email_draft_reply` | edit | 用户可编辑草稿正文后创建草稿 |
| `sync_to_notion` | preview/blocking | dry-run diff + confirm apply |

### 2.3 High-risk tools

最后迁移：

| Tool | 风险 | 必须条件 |
|---|---|---|
| `email_prepare_outbound` | blocking | SendApprovalCard + hash guard |
| `email_send_approved` | blocking | 不直接暴露给模型，或仅接受 approval token |
| `notion_bulk_update` | blocking | batch preview + explicit approval |
| `email_move_batch` | blocking | selected ids + approval |

## 3. AI SDK Tool 定义模板

```ts
import { tool } from 'ai';
import { z } from 'zod';

export function createEmailSearchTool(ctx: ToolFactoryContext) {
  return tool({
    description: 'Search MailAgent emails by natural language / query DSL.',
    inputSchema: z.object({
      query: z.string().min(1),
      mailbox: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    execute: async (input) => {
      const result = await ctx.domain.email.search(input);
      return {
        ...result,
        a2ui: {
          protocol: 'a2ui.mailagent',
          version: '1.0',
          component: 'SearchResultCard',
          props: { query: input.query, hits: result.items },
        },
      };
    },
  });
}
```

## 4. Domain Client

新增：

```txt
frontend/src/ai-gateway/python/domainClient.ts
```

职责：

- 封装所有 Python serve-api 调用。
- 统一 envelope unwrap / error code。
- 注入 local auth token。
- 加 request timeout / abort signal。
- 不直接读 SQLite 文件。

示例：

```ts
export class MailAgentDomainClient {
  constructor(private readonly baseUrl: string, private readonly auth: InternalAuth) {}

  async getEmail(id: number): Promise<EmailDetail> {
    return this.req('GET', `/email/${id}`);
  }

  async flagEmail(id: number, input: FlagInput): Promise<FlagResult> {
    return this.req('POST', `/email/${id}/flag`, { body: input });
  }
}
```

## 5. Tool Context

```ts
export interface ToolFactoryContext {
  domain: MailAgentDomainClient;
  contextSnapshot: AgentContextSnapshot;
  session: {
    id: number;
    uiThreadId: string;
  };
  audit: ToolAuditWriter;
  approval: ApprovalService;
  signal: AbortSignal;
}
```

工具不得从 React 状态、global singleton 或 renderer API 读取上下文。所有上下文来自 `ToolFactoryContext`。

## 6. Audit 写入

每个 tool call 都写：

```txt
chat_tool_call.tool_call_id
chat_tool_call.tool_name
chat_tool_call.input_json
chat_tool_call.ui_payload_json
chat_tool_call.status
chat_tool_call.duration_ms
chat_tool_call.output_json
chat_tool_call.approval_status
```

AI SDK Gateway 的 tool lifecycle：

```txt
input-available → approval-requested? → running → output-available / error / canceled
```

映射到旧状态：

```txt
pending / confirmed / running / ok / error / canceled
```

## 7. Legacy 并存策略

- `backend_kind='custom-api'` 的旧 session 继续使用 legacy harness。
- `backend_kind='ai-sdk'` 的新 session 使用 Gateway tools。
- 同名工具允许两套实现并存，但必须共享 schema fixture。
- 每迁移一个工具，保留 parity test：legacy result 与 Gateway result 的关键字段一致。

## 8. Tool schema 权威

Phase 03 期间 schema 权威逐步迁移：

```txt
legacy ToolDef.inputSchema
  → shared fixture / JSON schema
  → AI SDK zod schema
```

要求：

- schema 文件放在 `frontend/src/shared/assistant/tools/toolSchemas.ts` 或 `frontend/src/ai-gateway/tools/schemas.ts`。
- `zod` schema 可导出 JSON Schema 供文档 / tests 使用。
- Python endpoint 仍做最终 validation。

## 9. 测试

新增：

```txt
frontend/tests/ai-gateway/tools/email_search.test.ts
frontend/tests/ai-gateway/tools/email_get.test.ts
frontend/tests/ai-gateway/tools/kos_query.test.ts
frontend/tests/ai-gateway/tools/write_preview.test.ts
frontend/tests/ai-gateway/tools/parity.test.ts
```

场景：

- input schema invalid。
- Python endpoint error mapped to tool error。
- Abort signal cancels HTTP request。
- Read tools never request approval。
- Write tools always request approval when flag enabled。
- Tool audit rows written。

## 10. 验收

- Read tools 在 AI SDK runtime 下可用。
- 至少 5 个历史 eval scenario 通过。
- Write tools 未开启 approval flag 时不暴露。
- 所有 write tools 都有 domain service 二次校验。
- `chat_tool_call` 审计不比 legacy 少字段。

## 11. 回滚

```txt
MAILAGENT_CHAT_RUNTIME=legacy
MAILAGENT_AI_SDK_WRITE_TOOLS=0
```

可单工具禁用：

```txt
MAILAGENT_AI_SDK_DISABLED_TOOLS=email_archive,sync_to_notion
```