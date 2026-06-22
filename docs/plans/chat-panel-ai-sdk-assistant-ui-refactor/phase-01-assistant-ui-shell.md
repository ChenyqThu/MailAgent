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