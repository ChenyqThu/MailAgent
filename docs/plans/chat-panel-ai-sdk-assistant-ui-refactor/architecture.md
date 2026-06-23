# Architecture — assistant-ui × Vercel AI SDK Gateway × MailAgent Domain Services

> status: planning
> last-verified: 2026-06-23
> decision: use AI SDK for chat orchestration, not for MailAgent domain backend replacement
> **Phase 00 spike：✅ 已完成（2026-06-23），裁决 = GO。实测结论 + 证据见 [§13](#13-phase-00-spike-实测结论2026-06-23go)。**
> 本文 §1–§12 是规划设计（spike 前），§13 是 spike 实测层（验证/修正了 §1–§12 的关键假设）。

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

---

## 13. Phase 00 Spike 实测结论（2026-06-23，GO）

> 本节是 spike 的**实测层**：用最小可运行 PoC 验证/修正了 §1–§12 的关键假设。全程 **flag-off，不改默认行为**。
> 复现入口：`frontend/scripts/poc/run-ai-gateway-poc.ts`（gateway）+ `frontend/vite.poc.config.ts`（assistant-ui 截图）。
> 任务规格见 `.trellis/tasks/06-23-chat-panel-phase00-spike/`；本节对应 `phase-00-research-and-spike.md` 的 §2 结论闸口 + S0.1–S0.5。

### 13.0 裁决：GO

assistant-ui + Node AI SDK Gateway 作为换引擎方向**值得推进**。理由：三项核心技术风险（视图层 token 集成、Gateway 嵌入 main、AI SDK 真实流式）全部以最小 PoC 打通，无阻断性 gap；approval 语义差异有明确、低风险的重对齐路径（recorder 适配层，R5 规则语义不变）。

### 13.1 S0.1 官方能力确认（依据 = 已装包的版本与类型声明，非凭记忆）

实装并以 `npm view` + 包内 `.d.ts` 核验（`frontend/package.json` devDependencies）：

| 包 | 实装版本 | 关键事实 |
|---|---|---|
| `ai` | **6.0.208** | 导出 `streamText`/`generateText`/`tool`/`stepCountIs`/`convertToModelMessages`；`StreamTextResult` 暴露 `textStream`、`toUIMessageStreamResponse()`、`pipeUIMessageStreamToResponse(res)`、`pipeTextStreamToResponse(res)`（**可直接 pipe 到 Node `http.ServerResponse`**）；peer `zod ^3.25.76 || ^4.1.8` |
| `@ai-sdk/anthropic` | **3.0.85** | `createAnthropic({ baseURL, apiKey, headers })`；baseURL 须含 `/v1`（见 §13.2 踩坑） |
| `@assistant-ui/react` | **0.14.23** | 只发 **headless primitives**（`ThreadPrimitive`/`MessagePrimitive`/`ComposerPrimitive`）+ runtime（`useExternalStoreRuntime`/`useLocalRuntime`/`AssistantRuntimeProvider`）+ HITL 原语（`hitl`/`hitlTool`/`makeAssistantToolUI`/`ToolApprovalResponse`）；**peer `react ^18 || ^19` ✅** |
| `@assistant-ui/react-ai-sdk` | **1.3.37** | `useChatRuntime`/`useAISDKRuntime`/`AssistantChatTransport`；deps `ai ^6.0.205` + `@ai-sdk/react ^3.0.207`（与 ai@6 对齐）；peer `react ^18 || ^19` ✅ |
| `zod` | **4.4.3** | AI SDK tool inputSchema 用（protocol-contracts §9 已写 `ai-sdk-v6`，对齐） |

→ 修正 §1/§8/§10 的一处隐含假设：assistant-ui **不提供 styled Thread**，样式 100% 由消费方 className 决定。这不是缺点 —— 它正是「视觉 parity 可达」的根因：不必去覆盖它的默认皮肤（它没有皮肤），MailAgent token 零冲突注入即可。AI SDK v6 还**内建 tool-approval**（`InvalidToolApprovalSignatureError` = 自带签名/hash 校验），与 §5.3 / PRD F5 的「域内 hash guard」是叠加关系而非替代（见 §13.4）。

### 13.2 S0.2 + S0.3 Gateway PoC：实测 4/4 PASS

`frontend/src/electron/main/ai_gateway_poc.ts`（纯 Node 核：仅依赖 `node:http` + `ai` + `@ai-sdk/anthropic`，**不 import electron/keytar**，故可被纯 Node harness 拉起）。harness `scripts/poc/run-ai-gateway-poc.ts` 实测：

```txt
✅ [1-health]      GET /health → {status:ok, model, hasKey, baseUrl}
✅ [2-echo]        POST /api/ai/echo-stream → 6 帧 SSE 重建出原文 + finish（transport 通，不依赖 key）
✅ [3-abort]       client abort 后 ~2 帧即停（共 10 token，证明 abort 生效，省 token）
✅ [4-streamText]  POST /api/ai/chat → 经 @ai-sdk/anthropic + CRS 真实 streamText，
                   出 5 帧文本 + usage{inputTokens:40, outputTokens:33}（端到端打通）
— 结果：4 PASS / 0 FAIL / 0 SKIP —
```

**踩坑（写进 §7.2 Domain Client 注意事项）**：`@ai-sdk/anthropic` 对 baseURL 只追加 `/messages`（默认 baseURL 本含 `/v1`），而 CRS 真实端点是 `…/api/v1/messages`、Python 侧 chat.py 是对 base 拼 `/v1/messages`。故 AI SDK 的 baseURL 必须归一成 `…/api/v1`（PoC 里 `anthropicBaseUrl()` 处理），否则命中 `…/api/messages` → CRS 404（实测踩过并修复）。

**Electron 嵌入**：index.ts 经 **flag-gated 动态 import** 接入（`MAILAGENT_AI_SDK_GATEWAY==='true'` 才 `await import('./ai_gateway_poc')`）。flag-off（默认）时该块整条短路、重依赖永不加载 → **默认行为字节级不变**。端口 `MAILAGENT_AI_GATEWAY_PORT`（默认 8300，避开 serve-api 8200 / SSE 9200）。

### 13.3 第三进程成本评估（叠加 serve-api Python + DavMail JVM）

回答 goal 关切。两种形态：

| 形态 | 进程账 | 成本 | 何时用 |
|---|---|---|---|
| **A. 嵌入 Electron main**（PoC 采用，= §4.3 Phase 2） | **不新增 OS 进程**：一个 loopback `http.Server` + `ai`/anthropic JS 进 main 堆（懒 chunk，flag-off 不载） | ≈ 几 MB 堆 + 1 个 loopback 端口；生命周期 = 跟随 Electron main（before-quit 关）；打包 = 随 electron-vite 进 main bundle，**零新增安装步骤** | **Phase 02–05 推荐**：复用 main 的 Node runtime + 退出链，最省 |
| **B. 独立 Node 进程**（= §4.3 Phase 3+ 远景，「真·第三常驻进程」） | 新增 1 个常驻 Node 进程，叠在 serve（mail-sync Py）+ serve-api（uvicorn Py，BackendLifecycleManager 托管）+ DavMail JVM（~150–250MB，用户 pm2）之上 | Node 基线 ~30–50MB RSS + main↔gateway 的 HTTP/IPC + 须 mirror `BackendLifecycleManager`（spawn/health/crash-restart/SIGTERM/log-drain/孤儿防护）+ 打包须确保可执行 Node 入口 | 仅当需崩溃域隔离 / 远程独立部署时（Phase 06+ 再议） |

**结论**：默认走 A（嵌入 main），把「第三常驻进程」成本降到几乎为零；B 留作后置选项，不在 Phase 01–05 引入。这与 §11「Node Gateway 增加一个本地服务」风险项的缓解一致 —— 嵌入式形态下该风险基本消解。

### 13.4 approval 心智模型差异 + eval R5 重对齐（S0.4）

**当前 MailAgent（`awaitConfirmation`，`frontend/src/shared/chat/`）**：harness 遇 `confirmationTier ∈ {preview,edit}` 的写工具 → emit `pending_confirmation` 事件 → `await awaitConfirmation(toolUseId, …)` **在同一 JS 执行内挂起**，等 `chat:confirmTool` IPC 回复（可带 userEdited）→ 同一函数原地恢复、执行工具、出 `tool_result`。**单进程 suspend-resume，不重新 call 模型。**

**AI SDK v6（`needsApproval`，两次调用）**：模型 emit 需审批的 tool call → `streamText` 不执行，**首次调用以 `tool-approval-request` part 结束**（run 终止，非函数内暂停）→ 前端渲染审批卡 → 用户 approve/reject/edit → 前端回 `tool-approval-response` → **第二次 `streamText`**（approval-response 进 message history）→ 工具在二调执行 → result 流回。

| 维度 | 当前 awaitConfirmation | AI SDK v6 needsApproval |
|---|---|---|
| 挂起机制 | 同进程 JS `await`（函数暂停） | 流结束于 approval-request part（run 终止） |
| 恢复机制 | promise resolve，原函数继续 | **第二次模型调用**（response 进 history） |
| 状态载体 | JS 闭包/内存（重载即丢） | 序列化进 UIMessage parts（**可持久化、跨重载存活**） |
| 编辑输入 | resume 时 userEdited patch | approval-response.editedInput → 二调 |
| 签名/hash 守卫 | MailAgent 自定义（规划中） | **内建** `InvalidToolApprovalSignatureError` + MailAgent 域内 hash 叠加 |

**eval R5 重对齐（关键，不回退的判据）**：R5 语义 = 「每个写工具（tier≠silent）的 dispatch 必须有同 id、tool_name+tier 匹配、位于 use 后 result 前的 `pending_confirmation`」。在 AI SDK 世界里：
- 无单一 `pending_confirmation` 事件类型，取而代之是 assistant 消息里的 `tool-approval-request` part + 下一轮的 `tool-approval-response`；
- 审批通过的工具，其 `tool_use`（input-available）与 `tool_result`（output-available）跨**两次调用/两条 assistant 消息**。
- → **重对齐落点 = recorder 适配层**（`tests/agent_eval/recorder-contract.md` 的 live recorder）：把 AI SDK 的 `tool-approval-request` 映射成 trace 的 `pending_confirmation`（同 tool_use_id/tool_name/tier）、把二调的 output-available 映射成 `tool_result`、首调结束于 approval-request 未决 → `final.status='needs_confirmation'`（R5 H2 例外，已放行）。
- **R5 规则逻辑零改动**（rules.py 不动），改的是「事件来源」（自研 pending_confirmation → AI SDK approval-request 映射）。Phase 03b/04b 落 write tools + approval 后，`tests/agent_eval` baseline 必须在新 recorder 下重过、不回退（roadmap §2 原则 6）。

### 13.5 assistant-ui 视觉 parity（交付物①，已截图）

`frontend/src/electron/renderer/poc/AssistantUiThreadPoc.tsx`（headless primitives + MailAgent token class，`useExternalStoreRuntime` 喂静态消息）+ `vite.poc.config.ts` 独立 harness 截图。实测渲染 4 组（证据 `frontend/poc/assistant-ui/shots/`，gitignored）：

- **dark+coral / light+coral / dark+teal / light+cobalt** 全部正确：用户气泡走 `--c-accent`（暗=近黑前景、亮=白前景，AA 对齐）、助手气泡走 `bg-ink-3`+`--hairline`、Composer 走 `bg-ink-2`/`bg-ink-3`/accent 发送钮、Composer 空输入时 Send 自动 disabled（assistant-ui 原生状态正确）。
- **证明主题三态（light/dark）与 6 accent 正交**：仅切 `data-theme`/`data-accent`（与 `appearance.ts` 写的是同两个属性），assistant-ui primitives 经同一套 CSS 变量**零组件改动**整体重皮肤。

→ 验证 §G1 / §8：换视图层不换设计系统可行；生产将把静态 runtime 换成 `@assistant-ui/react-ai-sdk` 的 `useChatRuntime` 接 Gateway（§8）。

### 13.6 已知 gap / 留给后续 phase

- Tool UI 卡片（A2UI ComponentRegistry）未在本 spike 渲染（Phase 04，goal 非目标）；本 PoC 只覆盖 text 气泡 + composer。
- `toUIMessageStreamResponse()` 原生消费未在 PoC 接通（PoC 手工转 SSE 便于与 echo 统一取证）；Phase 02 接 `useChatRuntime` 时才走原生 UIMessage stream。
- streamText PoC 直连 CRS 取 key（main 侧，不过 renderer）；生产 Phase 02 决定「Gateway 直连 provider」vs「Gateway 经 serve-api /api/llm-proxy 转发」（后者零改 key 路径，见 protocol-contracts §6）。
- Persistence（S0.5，UIMessage JSON ↔ ai_chat schema）本 spike 未写代码验证 —— 但 `ai` 导出 `readUIMessageStream`/`safeValidateUIMessages` 已确认存在，§6 双写策略可行，留 Phase 02b。

### 13.7 GO → Phase 01 起 PR 拆分

沿用 [roadmap.md §4](./roadmap.md#4-pr-拆分建议)（spike 验证其可行，无需重写），最小可用路径 `00 → 01 → 02 → 03a → 04a → 04b → 03b → 06`。Phase 00 产出（本 PoC + 文档）= **PR-00a（文档）已落 + PR-00b（依赖与 scaffold）由本 spike 部分预置**（已装 5 个 devDeps + flag-gated gateway/assistant-ui scaffold，均 flag-off）。下一步开 Phase 01（assistant-ui shell + ExternalStore adapter）实现 task。