# Phase 00 — Research & Spike

> status: planning
> last-verified: 2026-06-22
> goal: 在不改变默认行为的前提下，完成 AI SDK / assistant-ui / AG-UI 技术验证和边界确认。

## 1. 目标

Phase 00 是专项启动阶段，只做调研、架构 spike、依赖风险确认和最小 scaffold，不切任何默认路径。

核心问题：

1. Vercel AI SDK 是否适合接管 MailAgent chat orchestration？
2. assistant-ui 最佳 runtime 是 AI SDK Runtime、ExternalStoreRuntime 还是 AG-UI Runtime？
3. AI SDK Gateway 是否应该成为 Node 独立服务，还是嵌在 Electron main？
4. 现有 `ChatStreamEvent` / `ai_chat.db` / `chat_tool_call` 如何兼容？
5. 高风险工具审批是否能从 `awaitConfirmation` 迁移到 AI SDK approval flow？

## 2. 结论闸口

Phase 00 结束必须给出以下结论：

| 问题 | 预期结论 |
|---|---|
| AI SDK 是否引入 | 是，引入为 Gateway orchestration 层 |
| Python domain services 是否保留 | 是，继续是业务权威 |
| assistant-ui runtime 第一目标 | AI SDK Runtime；legacy 兼容用 ExternalStoreRuntime |
| AG-UI 是否主路径 | 否，后置 mirror / interop |
| approval 语义差异 | 接受从 promise-resume 转为 approval-response second-call |

## 3. 交付物

文档：

```txt
README.md
prd.md
architecture.md
protocol-contracts.md
context-injection.md
generative-ui-hitl.md
roadmap.md
acceptance-checklist.md
phase-*.md
```

代码 scaffold：

```txt
frontend/src/shared/assistant/
  runtime/
  components/
  tools/
  context/

frontend/src/ai-gateway/     # empty scaffold / health only
```

Feature flags：

```txt
MAILAGENT_ASSISTANT_UI_PANEL=false
MAILAGENT_CHAT_RUNTIME=legacy
MAILAGENT_AI_SDK_GATEWAY=false
MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT=false
MAILAGENT_A2UI_TOOL_CARDS=false
```

## 4. Spike 任务

### S0.1 官方能力确认

确认并记录：

- AI SDK Core 支持 provider 标准化、text generation、tool calling、multi-step loop。
- AI SDK UI 支持 framework-agnostic chat UI hooks / UIMessage stream。
- assistant-ui 支持 AI SDK runtime。
- assistant-ui Tool UI 支持工具调用的原生 UI 渲染。
- AG-UI runtime 可作为后续 interop。

### S0.2 Gateway 最小 server

验证一个本地 Node server：

```txt
GET /health
POST /api/ai/echo-stream
```

要求：

- Electron dev 可启动。
- 端口可注入 renderer。
- 打包路径可推导。
- 不读取真实 LLM key。

### S0.3 AI SDK pure text PoC

不接 MailAgent UI，仅在脚本或 test 中验证：

```ts
streamText({ model, messages })
```

要求：

- 可通过当前 LLM_API_KEY / LLM_API_BASE 或 Vercel AI Gateway 配置调用。
- SSE / UIMessage stream 可被前端消费。
- abort signal 生效。

### S0.4 Tool approval PoC

验证一个 dummy high-risk tool：

```txt
tool call → approval request → user approval response → second call executes
```

记录和当前 `awaitConfirmation` 的差异。

### S0.5 Persistence PoC

验证：

```txt
UIMessage JSON → ai_chat_messages.ui_message_json → read back → assistant-ui render
```

不改现有 schema，先用 test fixture 或临时表。

## 5. 不做事项

- 不替换 `AIChatPanel` 默认渲染。
- 不启用真实 write tools。
- 不迁移旧会话。
- 不删除 legacy harness。
- 不改 Python service-layer 行为。

## 6. 验收

- 文档完整落地。
- `pnpm typecheck` 无新增错误。
- `pnpm test` 无新增失败。
- Gateway scaffold 不启动时默认行为完全不变。
- Spike 结论写入 `architecture.md` 和 `roadmap.md`。

## 7. 回滚

Phase 00 不改默认运行路径，回滚方式是删除 scaffold / flags / docs 之外的实验代码。