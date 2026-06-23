# Phase 01 — assistant-ui Shell

> status: planning
> last-verified: 2026-06-22
> goal: 在不切 AI orchestration 的前提下，先把聊天视图层迁移到 assistant-ui。

## 1. 目标

Phase 01 只替换视图层，不替换模型调用、不迁移工具执行、不改变 Python domain services。

目标架构：

```txt
AIChatPanel
  → MailAgentAssistantRuntimeProvider
  → assistant-ui Thread / Message / Composer
  → legacy useEmailChat via ExternalStore adapter
  → current shared/chat/runtime.ts
```

这样能先验证 assistant-ui 的视觉一致性、交互能力和 legacy event 映射，避免同时迁移 UI 与后端导致风险叠加。

## 2. 新增目录

```txt
frontend/src/shared/assistant/
  components/
    thread.tsx
    message.tsx
    composer.tsx
    action-bar.tsx
    markdown-text.tsx
  runtime/
    MailAgentRuntimeProvider.tsx
    useLegacyExternalStoreRuntime.ts
    legacyMessageMapper.ts
  tools/
    registerToolUIs.tsx
    generic/ToolTraceCard.tsx
  context/
    useAgentContextSnapshot.ts
```

## 3. 实施步骤

### P1.1 安装依赖

```txt
@assistant-ui/react
```

暂不强制引入 AI SDK runtime 包。Phase 01 使用 ExternalStore adapter。

### P1.2 Runtime Provider

```tsx
export function MailAgentRuntimeProvider(props: {
  chat: UseEmailChatReturn | UseGeneralChatReturn;
  children: React.ReactNode;
}) {
  const runtime = useLegacyExternalStoreRuntime(props.chat);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <MailAgentToolUIs />
      {props.children}
    </AssistantRuntimeProvider>
  );
}
```

### P1.3 Legacy message mapper

映射：

```txt
ChatMessage.content      → assistant text part
ChatMessage.thinking     → data-thinking part
liveToolCalls            → tool part
pendingConfirmations     → tool part / requires action metadata
ChatMessage.status       → message status
chat_tool_call rows      → persisted tool parts
```

### P1.4 Assistant UI shell

`AIChatPanel.tsx` behind flag：

```tsx
if (flags.assistantUiPanel) {
  return <AssistantUIChatPanel {...props} />;
}
return <LegacyAIChatPanel {...props} />;
```

### P1.5 Visual parity

assistant-ui components 必须使用 MailAgent token：

- `bg-background`
- `text-foreground`
- `border-border`
- `accent` CSS variables
- existing `Button` / `Card` / `Dialog` primitives

## 4. 功能范围

必须支持：

- 文本 streaming。
- stop generating。
- retry last。
- edit user message。
- session history 切换。
- context chips。
- pending tool trace 显示。
- legacy ConfirmToolDialog fallback。

不要求：

- AI SDK Gateway。
- AI SDK tools。
- A2UI rich cards 全量。
- AG-UI。

## 5. 测试

新增测试：

```txt
frontend/tests/shared/assistant/legacyMessageMapper.test.ts
frontend/tests/components/AssistantUIChatPanel.test.tsx
```

场景：

- assistant text chunk append。
- thinking part 展示。
- tool_use + tool_result 变成 tool step。
- pending confirmation 不丢失。
- done / error status 映射。

## 6. 验收

- `MAILAGENT_ASSISTANT_UI_PANEL=1` 时新 shell 可完整完成基础对话。
- flag off 时旧 UI 完全不变。
- 同一会话在旧 UI 和新 UI 展示内容一致。
- 视觉与右侧面板宽度、header、composer、scroll 行为一致。
- 不新增 LLM provider 调用路径。

## 7. 回滚

```txt
MAILAGENT_ASSISTANT_UI_PANEL=0
MAILAGENT_CHAT_RUNTIME=legacy
```

保留新代码但不启用。

## 8. 06-22 Phase 2 UX 诉求映射（superseded → assistant-ui shell 承载）

> 来源：`06-22-harness-agent-polish` roadmap 的 **Phase 2（UX Fluidity）** 已 **superseded**
> （决策见 [agent-experience-epic roadmap](../agent-experience-epic/roadmap.md) **P3**）。原本计划在 legacy
> `MessageList`/`Composer`/`ConfirmToolDialog`（chat-panel phase-06 要删的主路径）上做的体验打磨，
> 改由本 shell 的 assistant-ui primitive **被动展示（baseline）** 承载；需要富交互 / 审批的部分
> 升级到 [`phase-04-generative-ui-hitl.md`](./phase-04-generative-ui-hitl.md) §12 的 A2UI cards。
> **不在 legacy UI 单独做。**

| 06-22 Phase 2 诉求 | 本 shell 的 assistant-ui primitive（baseline 承载） | 说明 / 升级去向 |
|---|---|---|
| ① Tool timeline（tool_use/result 可读性、duration/status/recover） | `tool` part + `generic/ToolTraceCard.tsx`（§2、§4） | liveToolCalls / 持久化 `chat_tool_call` rows → tool part 时间线，ToolTraceCard 渲染每步；duration/status 由 tool part metadata + message status 承载。**recover action / 专用卡片 → phase-04 §12 ①** |
| ② Thinking 展示（可折叠、不打扰、区分推理 vs 证据） | `data-thinking` part（§P1.3 legacyMessageMapper） | `ChatMessage.thinking → data-thinking part`，assistant-ui 原生可折叠、默认收起。**phase-04 不另做，沿用本 part** |
| ③ Confirmation polish（文案、高风险一眼可辨、编辑后 input 下一轮可见） | `pending tool part (requires-action)` + legacy `ConfirmToolDialog` fallback（§4）+ `action-bar` edit（§4） | pendingConfirmations → tool part / requires-action metadata（§P1.3）；编辑后可见 = action-bar edit user message + ExternalStore 回写。**富文案 / 风险分级 / send 审批 → phase-04 §12 ③** |
| ④ Error recovery（timeout/unavailable/auth/disabled 给下一步、不甩技术错误） | `message status`（done/error）映射（§5） | phase-01 shell 只做 error 态可视化。**下一步建议 / 技术错误转写 → phase-04 §12 ④（output-error card）**；skill 禁用/不可用四类解释**已在 06-23 P2c 落地**（view-agnostic，不依赖本 shell） |
| ⑤ Latency/cost signals（首 token/工具耗时/总耗时/cost） | 不前台；沿用 `tests/agent_eval` trace metrics | shell 不前台展示；指标走 eval trace（[`recorder-contract.md`](../../../tests/agent_eval/recorder-contract.md)）。前台时间信号（approval expiry countdown）在 phase-04 §12 ⑤ |