# Phase 05 — AG-UI Interop

> status: ✅ done（2026-06-25，flag-gated `MAILAGENT_AG_UI_MIRROR`，默认 off）
> last-verified: 2026-06-25
> goal: 在 AI SDK Gateway 稳定后，输出 AG-UI mirror endpoint，提供标准 agent event / interrupt / state snapshot 互操作能力。
>
> **落地详情 = architecture.md §13.13**（产出表 / 「复用同一 streamText+双 guard，只换编码器」/ 测试取舍 / 验收证据 / 已知 gap）。本文件是设计规格，§13.13 是权威落地记录。
> 实测验收：`pnpm typecheck` 0 + 全量 vitest 1884 passed/1 skipped/0 fail（新增 agui 27 测）+ `tests/agent_eval` 89 passed（rules.py 零改）。assistant-ui AG-UI runtime smoke（§8）以 Gateway 侧 route SSE golden 替代（`@ag-ui/*` 不在依赖树，旁路默认关不加生态运行期依赖）。

## 1. 目标

AG-UI 不作为 MailAgent 第一阶段 chat runtime 主路径。Phase 05 的目标是把已经稳定的 AI SDK UIMessage / A2UI / context snapshot 映射成 AG-UI event stream，用于：

- 后续外部 agent client。
- CopilotKit / AG-UI 生态互操作。
- 更标准的 run lifecycle / state snapshot / interrupt 表达。
- 调试与 replay。

目标链路：

```txt
AI SDK Gateway canonical run
  → UIMessage stream / tool parts / context snapshot
  → AG-UI event adapter
  → /api/ai/agui/chat
  → assistant-ui useAgUiRuntime or external AG-UI client
```

## 2. 非目标

- 不把 MailAgent canonical persistence 改成 AG-UI event log。
- 不要求 assistant-ui 默认 runtime 切 AG-UI。
- 不在 Phase 05 重新实现 tools。
- 不替代 AI SDK Gateway。

## 3. 新增目录

```txt
frontend/src/ai-gateway/agui/
  eventMapper.ts
  aguiRoute.ts
  stateSnapshot.ts
  interruptMapper.ts
  tests/
```

前端可选 runtime：

```txt
frontend/src/shared/assistant/runtime/aguiRuntimeProvider.tsx
```

## 4. Endpoint

```txt
POST /api/ai/agui/chat
Content-Type: application/json
Accept: text/event-stream
```

输入：AG-UI client request 或 MailAgent wrapper request。

输出：AG-UI event stream。

## 5. Event Mapping

| MailAgent / AI SDK canonical event | AG-UI event |
|---|---|
| run start | `RUN_STARTED` |
| context snapshot ready | `STATE_SNAPSHOT` |
| assistant text start / delta / end | `TEXT_MESSAGE_START` / content / end |
| thinking data part | thinking / reasoning event |
| tool input available | `TOOL_CALL_START` + args |
| tool output available | `TOOL_CALL_RESULT` |
| approval request | interrupt / requires-action outcome |
| approval response | resume / follow-up input |
| error | `RUN_ERROR` |
| finish | `RUN_FINISHED` |

## 6. State Snapshot

AG-UI `STATE_SNAPSHOT` 包含：

```ts
export interface MailAgentAgUiState {
  mailagentContext: AgentContextSnapshot;
  thread: {
    sessionId: number | null;
    anchorType: 'email' | 'general';
    anchorId: number | null;
  };
  capabilities: {
    enabledTools: string[];
    enabledSkills: string[];
    highRiskApprovalRequired: true;
  };
}
```

原则：

- 不把完整邮件正文重复塞进每个 delta。
- 大正文仍在 context snapshot 中截断。
- 敏感 token / provider key 不进入 state。

## 7. Interrupt Mapping

AI SDK approval request → AG-UI interrupt：

```ts
export function approvalToAgUiInterrupt(req: ToolApprovalRequestPayload) {
  return {
    id: req.approval.id,
    name: req.toolName,
    payload: {
      toolCallId: req.toolCallId,
      input: req.input,
      a2ui: req.a2ui,
      risk: req.approval.risk,
      reason: req.approval.reason,
      expiresAt: req.approval.expiresAt,
    },
  };
}
```

恢复：

```txt
AG-UI interrupt response
  → ToolApprovalResponsePayload
  → AI SDK Gateway approval handling
```

## 8. assistant-ui AG-UI Runtime Smoke

可选 smoke：

```tsx
const agent = new HttpAgent({ url: '/api/ai/agui/chat' });
const runtime = useAgUiRuntime({ agent });

<AssistantRuntimeProvider runtime={runtime}>
  <Thread />
</AssistantRuntimeProvider>
```

此路径用于验证互操作，不作为默认产品路径。

## 9. 测试

新增：

```txt
frontend/tests/ai-gateway/agui/eventMapper.test.ts
frontend/tests/ai-gateway/agui/interruptMapper.test.ts
frontend/tests/e2e/chat_agui_smoke.spec.ts
```

场景：

- text stream event order。
- tool call args / result。
- approval request interrupt。
- context state snapshot。
- error mapping。
- AG-UI runtime smoke renders Thread。

## 10. 验收

- `MAILAGENT_AG_UI_MIRROR=1` 下 endpoint 可用。
- 不影响 AI SDK runtime 主路径。
- 一条基础对话、一条 tool call、一条 approval scenario 均可通过 AG-UI smoke。
- AG-UI event sequence 有 golden snapshot。

## 11. 回滚

```txt
MAILAGENT_AG_UI_MIRROR=0
MAILAGENT_CHAT_RUNTIME=ai-sdk
```

AG-UI mirror 是旁路能力，关闭后不影响产品主聊天面板。