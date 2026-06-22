# Phase 02 — AI SDK Gateway

> status: planning
> last-verified: 2026-06-22
> goal: 引入 Node / TypeScript AI SDK Gateway，先完成纯文本 streaming 与 UIMessage 持久化。

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