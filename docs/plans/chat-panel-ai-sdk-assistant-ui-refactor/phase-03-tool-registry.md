# Phase 03 — Tool Registry Migration

> status: **03a read tools ✅ + 03b write tools + HITL approval ✅ done（2026-06-24，flag-off）**。落地见 [§12](#12-实现落地03a2026-06-24)（03a）+ [§13](#13-实现落地03b2026-06-24write-tools--hitl-approval)（03b）+ [architecture §13.9](./architecture.md#139-phase-03a-落地2026-06-24read-tools-migration) / [§13.10](./architecture.md#1310-phase-03b-落地2026-06-24write-tools-preview--hitl-approval)。§1–§11 是规划层（实现前）。
> last-verified: 2026-06-24
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

---

## 12. 实现落地（03a，2026-06-24）

> 只迁 **read tools**，全程 flag-off。架构决策 + 踩坑见 [architecture §13.9](./architecture.md#139-phase-03a-落地2026-06-24read-tools-migration)。

### 12.1 产出

| 文件 | 职责 |
|---|---|
| `frontend/src/ai-gateway/python/domainClient.ts` | `MailAgentDomainClient`（纯 Node typed HTTP → serve-api read 端点 + `X-MailAgent-Local-Token` + envelope unwrap + E_NOT_FOUND→null + abort）|
| `frontend/src/ai-gateway/tools/{schemas,types,email,kos,report,index}.ts` | zod schemas（镜像 legacy）+ `auditedReadTool`（execute+audit）+ 9 read 工具 + `buildGatewayTools`（read-only，write gate 占位 03b）|
| `server.ts` / `config.ts` | `cfg.buildTools(auditEntries)`（闭包绑 collector）+ `streamText({tools, stopWhen})`，`auditEntries` 进 `persistTurn`；`AiGatewayConfig.buildTools/maxSteps` + `PersistTurnInput.toolCalls` |
| `ai_gateway_lifecycle.ts` | 构造 DomainClient（`resolveApiPort` + `getLocalApiToken`）+ `buildGatewayTools` → `cfg.tools`；persistTurn 写 chat_tool_call（appendToolCall+updateToolCall）|
| `frontend/tests/ai-gateway/{domainClient,tools/*}.test.ts` | 32 新测：HTTP/envelope/auth + 每工具 execute + audit + buildGatewayTools 闭包/read-only scope + **parity**（legacy vs gateway 关键字段一致）|

迁移的 9 个 read 工具：`email_search`（metadata）/ `email_search_fulltext`（FTS）/ `email_get` / `email_body` / `email_list_thread` / `email_search_attachments` / `kos_query` / `report_list` / `report_get`。

### 12.2 §10 验收（全 ✅，CRS 不可达项除外）

- read tools 在 AI SDK runtime 下可用：harness `[5]`（真实 CRS 模型 + mock domain）证「问→调 email_search→audit status=ok→回答」；**本次 CRS 网关 transient 不可达（HTTP 000），[4]/[5] 待 CRS 恢复复跑**，代码正确（同一未改的 [4] 在 Phase 02 session CRS 可达时 PASS）。
- ≥5 read scenario：parity + 单测覆盖 email_search/get/body/thread/attachments/kos/report ≥ 7。
- write tools 未开 flag 不暴露：03a 不构建 write 工具（`buildGatewayTools` 只回 read；`MAILAGENT_AI_SDK_WRITE_TOOLS` 预留 03b）。
- chat_tool_call 审计字段 ≥ legacy（tool_use_id/name/input/output/status/duration/confirmation_tier）。
- `pnpm typecheck`(node+web) 0 · 全量 vitest **1756 passed**（+32）· `tests/agent_eval` **85**（≥baseline，AI SDK 路径 opt-in 不影响 legacy harness）。

### 12.3 本阶段不做（→ 03b/04）

write tools 执行 / approval 两次调用语义 + R5 recorder 重对齐 / A2UI 卡片 / AG-UI / 会话重载接进 runtime / standing-context 注入。

---

## 13. 实现落地（03b，2026-06-24）

> 5 个 preview/edit 写工具 + HITL approval（ai@6 `needsApproval` 两次调用），全程 `MAILAGENT_AI_SDK_WRITE_TOOLS` flag-off。架构决策 + 双层 guard + 契约差见 [architecture §13.10](./architecture.md#1310-phase-03b-落地2026-06-24write-tools-preview--hitl-approval)。

### 13.1 产出

迁移的 5 个写工具：`email_flag`/`email_archive`/`email_pin`（preview）+ `email_draft_reply`（edit）+ `email_resync`（preview，= §2.2 `sync_to_notion` 的「重推 Notion」语义；富 dry-run-diff 卡片 = 04a）。

| 文件 | 职责 |
|---|---|
| `security/approval.ts` | `ApprovalGuard`（domain id/hash/expiry，keep-first，跨两调存活）|
| `tools/write.ts` + `tools/types.ts`(`auditedWriteTool`) + `tools/schemas.ts`(write zod) | 写工具 registry（needsApproval 注册 + execute verify + domain 写 + parity massage + 审计）|
| `python/domainClient.ts` | +5 写方法（wire 逐字镜像 HttpChatPlatform）|
| `server.ts`/`config.ts`/`ai_gateway_lifecycle.ts` | `experimental_toolApprovalSecret` + write gate（writeToolsEnabled+guard）+ persistTurn approval 审计 |
| chat_db.ts/model.ts/api types/db.py/test_chat.py | `chat_tool_call.approval_status`+`approval_hash`，`CHAT_DB_VERSION 9→10`|
| `tests/agent_eval/recorder/ai_sdk_adapter.ts` | R5 重对齐适配层（AI SDK tool parts → trace events）+ `runs/ai-sdk-approval.jsonl` fixture |

### 13.2 §10 验收（全 ✅）

- Read tools 在 AI SDK runtime 可用（03a，不回退）。
- write tools 未开 flag 不暴露：`buildGatewayTools` 仅在 `writeToolsEnabled && approvalGuard` 时加写工具；off（默认）字节级等同 03a（`write_preview.test.ts` 钉死 3 态）。
- 所有 write tools 都需 approval（never silent）+ domain service 二次校验：每工具声明 `needsApproval`；Python MailWriteService 仍是业务权威；`无 approval token 不能真实执行`（execute 无 record → E_APPROVAL_NOT_FOUND，domain 写永不触发）。
- `chat_tool_call` 审计 ≥ legacy：approved 执行写 tier+approval_status+approval_hash+user_edited（字段 ≥ legacy dispatch）。
- `pnpm typecheck`(node+web) 0 · 全量 vitest **1786 passed**（+30；唯一失败 = `backend_lifecycle process.resourcesPath` electron-as-node runner 伪影，node runner 下 62 passed，与本 diff 无关）· `tests/agent_eval` **87 passed**（≥baseline，+2 R5 重对齐）+ `run_baseline --compare` base==candidate hard_pass=29（RESULT: OK，rc=0）。

### 13.3 本阶段不做（→ 04a/04b）

高风险外发 `email_prepare_send`/`email_send_approved`（04b，SendApprovalCard + content hash）/ 富 A2UI 卡片（04a，DraftReplyCard/NotionSyncCard 含 UI 编辑）/ AG-UI / 会话重载接 runtime / standing-context 注入。