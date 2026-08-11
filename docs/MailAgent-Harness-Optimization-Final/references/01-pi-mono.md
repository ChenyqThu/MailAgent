# Pi Mono 研究：只吸收交互与上下文能力，不替换 Runtime

## 1. 定位

Pi 是轻量、可扩展的终端 Coding Harness。核心价值是简单 Agent Loop、Session Tree、Compaction、Steering、Follow-up、Skill 和 Extension。

MailAgent 最终决策：

- 不引入 Pi Runtime；
- 不建设 Runtime SPI；
- 只借鉴 Compact、Steering/Follow-up 和轻量 Plan/Session 体验。

## 2. 核心源码

### `packages/agent/src/agent.ts`

关键：

- `Agent`
- `steer()`
- `followUp()`
- `dequeueSteeringMessages()`
- `dequeueFollowUpMessages()`
- `transformContext`
- `convertToLlm`

值得借鉴：

- Steering 与 Follow-up 明确分开；
- 队列支持 `one-at-a-time / all`；
- 上下文变换在模型调用前；
- Agent 状态与 UI 事件相对简单。

MailAgent 落地：

- 第一阶段只做 Follow-up Queue；
- Compact 在 `convertToModelMessages` 前选择摘要边界；
- 不复制 Pi Agent Class。

### `packages/agent/src/types.ts`

关键：

- `AgentLoopConfig`
- `AgentMessage`
- `AgentEvent`
- `AgentTool`

值得借鉴：

- Custom message 可不进入 LLM；
- 工具进度与结果分开；
- UI-only 消息和模型消息可分离。

MailAgent 落地：

- Compact Card 用 UIMessage data/custom part；
- Plan Card 也可作为 UI-only Tool Part；
- 不再建设独立 AgentEvent 协议。

### Coding Agent Session/Compaction

参考内容：

- Session JSONL；
- Tree/Fork；
- 自动和手动 Compact；
- full history 保留、模型 context 有损压缩。

MailAgent 落地：

- 完整 SQLite 历史保留；
- 特殊 Compact System Message；
- 最新摘要 + 最近消息；
- 不做 Tree/Fork 近期功能。

## 3. 不适合 MailAgent 的部分

- cwd 与代码仓库为中心；
- 默认 read/write/edit/bash；
- Extension 可任意系统访问；
- 没有 MailAgent 的持久审批和办公领域双闸；
- Session 文件不是 MailAgent 数据 SSoT；
- 完整 Pi 接入会复制 AI SDK、审批和持久化。

## 4. 最终借鉴表

| Pi 能力 | MailAgent 方案 |
|---|---|
| Steering Queue | P5 后续第二阶段 Tool-boundary Steering |
| Follow-up Queue | P5 第一阶段持久队列 |
| Compaction | P3/P4 SQLite Compact Message |
| transformContext | `chatRun.ts` 模型消息选择纯函数 |
| Custom messages | Plan/Compact/Agent Call 卡片 |
| Skill | 延续现有 Skill Registry + Skill Creator |
| Extension | 不开放任意代码扩展 |
