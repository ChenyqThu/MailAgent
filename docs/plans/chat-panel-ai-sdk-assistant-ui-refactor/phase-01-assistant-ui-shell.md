# Phase 01 — assistant-ui Shell

> status: ✅ done（2026-06-23，commit b82ee24e，全程 flag-off）
> last-verified: 2026-06-23
> goal: 在不切 AI orchestration 的前提下，先把聊天视图层迁移到 assistant-ui。
> **实现落地结论见 [§9](#9-实现落地2026-06-23)。** §1–§8 是规划层（实现前），§9 是落地层。

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

---

## 9. 实现落地（2026-06-23）

> commit `b82ee24e`（24 files, +1972/-204）。全程 **flag-off 默认**；code-reviewer(opus) APPROVE（0 CRITICAL/HIGH/MEDIUM）。

### 9.1 产出（对照 §2 目录）

实际落地为 `frontend/src/shared/assistant/`：

```txt
runtime/
  flags.ts                       MAILAGENT_ASSISTANT_UI_PANEL / _CHAT_RUNTIME 解析
  legacyMessageMapper.ts         ChatMessage(+toolSteps/isStreaming) → ThreadMessageLike
  useLegacyExternalStoreRuntime.ts  useExternalStoreRuntime adapter（非 AI SDK）
  MailAgentRuntimeProvider.tsx
components/  thread / message / composer / action-bar / markdown-text(.tsx)
tools/       registerToolUIs.tsx + generic/ToolTraceCard.tsx
context/     useChatContextChips.ts
AssistantUIChatPanel.tsx         flag-on 邮件面板
```

- thinking → **`reasoning` part**（assistant-ui 原生可折叠），非 §P1.3 写的 `data-thinking`：ExternalStore 世界里 reasoning 是 data-thinking 的原生等价（protocol-contracts §4 的 data-thinking 是 Phase 02 AI SDK UIMessage 层目标）。
- AIChatPanel 经 `lazy()` 分流：flag-off → `LegacyAIChatPanel`（body 与原 AIChatPanel **字节级一致**，reviewer 机械证明），assistant-ui 重依赖只在 flag-on 进 chunk；flag-on → `AssistantUIChatPanel`。
- markdown 复用 legacy `TranslatedBody`(Streamdown)；tool 走 generic `tools.Fallback`（ToolTraceCard）；pending confirmation 走 legacy `ConfirmToolDialog` fallback（Thread `pendingSlot`）。
- flag 投递：`electron.vite.config.ts` + `vite.web.config.ts` per-flag `define`（**不用 `envPrefix:['MAILAGENT_']`**，否则会把 `MAILAGENT_CLI_API_KEY` 等 secret 打进 renderer bundle）。`.env.example` 已登记。

### 9.2 §6 验收（全 ✅）

- `pnpm typecheck`(node+web) 0 · 全量 vitest **1700 passed / 1 skipped / 0 failed**（+22 新：legacyMessageMapper golden 16 + AssistantUIChatPanel shell 6）· eslint clean。
- flag-off 字节级不变（reviewer diff 证明）；不新增 LLM provider 路径（send/edit 仍走 `chat.send`→`mailApi.chat.start` 既有 dispatcher）。
- 视觉 parity：4 组 theme/accent 截图（dark/light × coral/teal/cobalt），主题三态 × accent 正交、零组件改动重皮肤。
- `tests/agent_eval` 85 passed（≥ baseline，view-only 未影响 harness/trace）。

### 9.3 Phase 01 内有意延后（非本 shell 范围）

assistant-ui composer 暂不带：@mention / 附件 chips、in-composer 模型 picker、extended-thinking 开关（legacy composer 特性，send 固定 `thinking:false`）；富 DraftPreviewCard / KOS-Notion footer → phase-04 A2UI。send 键为 assistant-ui 原生 Enter（Shift+Enter 换行），非 legacy ⌘↩。`getChatRuntimeMode()` 为 Phase 02 预留（当前 shell 恒走 ExternalStore）。下一步按 roadmap §8 开 **Phase 02（AI SDK Gateway）**。