# Phase 02 — AI SDK Gateway

> status: ✅ done（2026-06-24，全程 flag-off）。**落地结论见 [§13](#13-实现落地2026-06-24)** + [architecture §13.8](./architecture.md#138-phase-02-落地2026-06-24embedded-ai-sdk-gateway)。§1–§12 是规划层（实现前）。
> last-verified: 2026-06-24
> goal: 引入 Node / TypeScript AI SDK Gateway，先完成纯文本 streaming 与 UIMessage 持久化。
>
> **🔴 与 Phase 00 spike + Phase 01 现实对齐（本文 §2/§5 写于 spike 前，按下列三点为准）：**
> 1. **Gateway 嵌入 Electron main，非独立 OS 进程**（architecture [§13.3](./architecture.md#133-第三进程成本评估叠加-serve-api-python--davmail-jvm) 裁决形态 A）。spike 已有 `frontend/src/electron/main/ai_gateway_poc.ts`（纯 Node 核 `node:http`+`ai`+`@ai-sdk/anthropic`，**不 import electron/keytar**）+ `index.ts` 经 `MAILAGENT_AI_SDK_GATEWAY` **flag-gated 动态 import**（flag-off 字节级不变）+ `scripts/poc/run-ai-gateway-poc.ts` harness 4/4。Phase 02 = 把 PoC 正式化（§2 的 `frontend/src/ai-gateway/` 模块由 main 嵌入式拉起，不是 §4.3 Phase 3 的独立进程）。
> 2. **flag 地基已在 Phase 01 就位**：`frontend/src/shared/assistant/runtime/flags.ts` 已有 `MAILAGENT_CHAT_RUNTIME`（`getChatRuntimeMode()`：legacy / external-store，`ai-sdk`/`ag-ui` 当前折叠回 external-store）+ vite per-flag `define`（**禁用 `envPrefix:['MAILAGENT_']`**，否则泄漏 `MAILAGENT_CLI_API_KEY`）。Phase 02 在此加 `ai-sdk` 分支（§8）+ `MAILAGENT_AI_SDK_GATEWAY` 端口发现，**不重造 flag 层**。
> 3. **provider key 路径决策（architecture §13.6 留给本 phase）**：spike 直连 CRS 取 key（main 侧）。Phase 02 二选一并写清：(A) Gateway 直连 provider；(B) Gateway 经 serve-api `/api/llm-proxy` 转发（零改 key 路径，key 仍只在 Python 侧）。**🔴 CRS 踩坑**：`@ai-sdk/anthropic` baseURL 须含 `/v1`（默认只追加 `/messages`→命中 `…/api/messages` 404，须归一 `…/api/v1`，见 architecture §13.2）。
> 4. **eval 闸**：Phase 02 是 text-only + AI SDK 路径 opt-in（flag-off 默认仍走 legacy harness），故 `tests/agent_eval`（录的是 legacy harness trace）**≥ baseline 应天然成立**；真正的 R5 recorder 重对齐在 Phase 03b/04b（write tools + approval）落，见 architecture §13.4。

## 1. 目标

Phase 02 开始引入 Vercel AI SDK，但只接管 chat orchestration 层，不碰 Python domain services 的业务权威。

目标架构：

```txt
assistant-ui
  → AI SDK runtime / useChat transport
  → Node AI SDK Gateway
  → streamText
  → provider / AI Gateway / OpenAI-compatible endpoint
  → UIMessage stream back to assistant-ui
```

Phase 02 不迁移复杂 tools，只完成：

- Gateway lifecycle。
- 纯文本 stream。
- `UIMessage` request / response。
- basic persistence。
- Electron / Web 访问路径。

## 2. 新增目录

```txt
frontend/src/ai-gateway/
  server.ts
  config.ts
  routes/
    health.ts
    chat.ts
    threads.ts
  persistence/
    chatStore.ts
    uiMessageMapper.ts
  context/
    buildSystemPrompt.ts
    normalizeContextSnapshot.ts
  python/
    domainClient.ts
  security/
    auth.ts
```

如果后续独立 package：

```txt
services/ai-gateway/
  package.json
  src/...
```

第一版建议放在 `frontend/src/ai-gateway`，复用前端 TS tooling。

## 3. Gateway Server

最小接口：

```txt
GET  /health
GET  /api/ai/config
POST /api/ai/chat
GET  /api/ai/threads/:id
POST /api/ai/threads
```

健康检查：

```json
{
  "ok": true,
  "service": "mailagent-ai-gateway",
  "version": "0.1.0",
  "pythonApi": "ok",
  "modelConfigured": true
}
```

## 4. Chat Endpoint

```ts
export async function handleChat(req: Request): Promise<Response> {
  const body = await parseMailAgentAIChatRequest(req);
  const context = await normalizeContextSnapshot(body.contextSnapshot, domainClient);

  const result = streamText({
    model: resolveModel(body.backend),
    system: buildSystemPrompt({ context }),
    messages: convertToModelMessages(body.messages),
    tools: {},
    abortSignal: req.signal,
  });

  return result.toUIMessageStreamResponse({
    onFinish: async ({ messages, responseMessage, usage }) => {
      await chatStore.persistTurn({
        sessionId: body.sessionId,
        messages,
        responseMessage,
        usage,
      });
    },
  });
}
```

实际 API 以所安装 AI SDK 版本为准，Phase 02 的工程目标是“保持 AI SDK UIMessage stream 为前后端契约”。

## 5. Electron lifecycle

新增 Electron main 管理：

```txt
frontend/src/electron/main/ai_gateway_lifecycle.ts
```

职责：

- 选择可用端口。
- 启动 Node Gateway。
- 注入 Python serve-api base URL。
- 注入 auth token / local-only guard。
- `/health` polling。
- app quit 时关闭。

Renderer 获取：

```txt
?aiGatewayPort=NNNN
```

或通过 preload API：

```ts
window.mailagent.aiGateway.baseUrl
```

## 6. Web remote path

远程 Web：

```txt
Browser
  → Cloudflare Access
  → local AI Gateway /api/ai/chat
  → local Python serve-api
```

鉴权：

- Browser 不持有 API key。
- Gateway 验 CF Access / local token。
- Gateway 到 Python serve-api 使用内部 token。

## 7. Persistence v1

Phase 02 可先双写：

```txt
ai_chat_messages.content        legacy text
ai_chat_messages.ui_message_json new canonical JSON
ai_chat_messages.metadata       model / usage / gateway metadata
```

如果 schema 迁移风险较高，可先通过 Python chat endpoint 增加：

```txt
POST /api/chat/messages/ui
GET  /api/chat/sessions/:id/ui-messages
```

再由 Python `src/chat/db.py` 统一写 `ai_chat.db`。

## 8. Runtime selection

前端 runtime flag：

```ts
switch (MAILAGENT_CHAT_RUNTIME) {
  case 'ai-sdk':
    return useMailAgentAISDKRuntime();
  case 'external-store':
    return useLegacyExternalStoreRuntime();
  default:
    return legacyUseEmailChatView();
}
```

新会话默认仍 legacy，直到 `MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT=1`。

## 9. 本阶段不做

- 不迁移 tools。
- 不启用 write actions。
- 不删除 legacy harness。
- 不接 AG-UI。
- 不要求旧会话全部变成 UIMessage canonical。

## 10. 测试

新增：

```txt
frontend/tests/ai-gateway/health.test.ts
frontend/tests/ai-gateway/chat_stream.test.ts
frontend/tests/ai-gateway/ui_message_persistence.test.ts
frontend/tests/e2e/chat_ai_sdk_basic.spec.ts
```

场景：

- health ok。
- pure text streaming。
- abort stream。
- model key missing returns typed error。
- UIMessage persisted and reloaded。
- Electron renderer can discover Gateway port。

## 11. 验收

- `MAILAGENT_AI_SDK_GATEWAY=1` 下 Gateway 可启动。
- `MAILAGENT_CHAT_RUNTIME=ai-sdk` 下新建临时会话可流式回复。
- 默认 flag off 不影响现有 chat。
- Renderer 未接触 provider key。
- `pnpm typecheck` / `pnpm test` 通过。

## 12. 回滚

```txt
MAILAGENT_AI_SDK_GATEWAY=0
MAILAGENT_CHAT_RUNTIME=legacy
```

Gateway 进程未启动时，前端自动隐藏 AI SDK runtime 入口。

---

## 13. 实现落地（2026-06-24）

> 全程 **flag-off 默认**。完整架构决策 + 踩坑见 [architecture §13.8](./architecture.md#138-phase-02-落地2026-06-24embedded-ai-sdk-gateway)。

### 13.1 产出（对照 DoD）

| DoD | 落地 |
|---|---|
| (1) 正式化 Gateway | `frontend/src/ai-gateway/{server,config}.ts`（纯 Node 核，spike `ai_gateway_poc.ts` 收编后删）+ `electron/main/ai_gateway_lifecycle.ts`（impure wrapper：llm_settings/persistTurn/health-poll/before-quit）。endpoints `/health` + `/api/ai/config` + `/api/ai/chat`（`streamText`→`pipeUIMessageStreamToResponse` 纯文本 UIMessage 流 + abort + onFinish 持久化）。`index.ts` flag-gated 动态 import wrapper；`createWindow` 注入 `?aiGatewayPort=`。|
| (2) provider key 路径 | **(A) Gateway 直连 provider**（key 仅 main，renderer 不接触；CRS baseURL 归一含 `/v1`）。决策依据 architecture §13.8.2。|
| (3) 前端 AI SDK runtime 分支 | `flags.ts` `getChatRuntimeMode→'ai-sdk'` + `isAiSdkGatewayEnabled` + `resolveAiGatewayBaseUrl`；`AiSdkRuntimeProvider`(useChatRuntime+AssistantChatTransport)；`AssistantUIChatPanel` 据 mode 分流，默认 legacy/external-store 字节级不变。vite per-flag define 加 `__MAILAGENT_AI_SDK_GATEWAY__`。|
| (4) UIMessage 持久化 v1 | chat_db v9 加 `ui_message_json` 列（双写 canonical + content + usage/model）；纯 mapper `shared/assistant/uiMessage.ts`（重载转 UIMessage / 旧会话从 content 合成）；`src/chat/db.py` 头注释 + 列镜像。**不动 EXPECTED_DB_VERSION**。|
| (5) 测试 | `frontend/tests/ai-gateway/{health,chat_stream,ui_message_persistence,port_discovery}.test.ts`（24 passed）+ gateway harness 4/4。|

### 13.2 §11 验收（全 ✅）

- `MAILAGENT_AI_SDK_GATEWAY=1` → Gateway 启动 + `/health` ok（harness 实测 service=`mailagent-ai-gateway` v0.2.0）。
- `MAILAGENT_CHAT_RUNTIME=ai-sdk` → 新会话经 AI SDK 流式回复（harness `[4]` 经 CRS 真实 streamText → UIMessage 流重建中文文本端到端）。
- 默认 flag off 现有 chat 字节级不变（panel lazy 分流 + per-flag define，重依赖 flag-off 不加载）。
- renderer 未接触 provider key（key 仅 `llm_settings` in main；renderer 只拿 loopback 端口）。
- `pnpm typecheck`(node+web) 0 · 全量 vitest 1725 passed · `tests/agent_eval` 85 passed（≥ baseline）。

### 13.3 有意延后（§9）

不迁 tools / 不启 write actions / 不删 legacy harness / 不接 AG-UI / 不强制旧会话全变 UIMessage。standing-context 注入 + A2UI 卡片 + approval 两次调用语义 + eval R5 recorder 重对齐 → phase-03/04。