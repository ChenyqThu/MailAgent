# MailAgent Chat Panel × assistant-ui × Vercel AI SDK 重构专项

> status: planning
> last-verified: 2026-06-22
> owner: frontend / agent runtime

本目录是 MailAgent 前端聊天面板规范化重构专项的落地文档。它回答一个新的架构问题：**如果后端也切到 Vercel AI SDK，整体是否更优，以及应该如何切**。

结论：**建议切，但不是把 MailAgent 后端全部改成 Vercel AI SDK。** 最优方案是引入一个 TypeScript/Node 的 **AI SDK Gateway** 作为 chat / agent orchestration 层：它负责模型调用、工具 schema、UIMessage 流、tool approval、多步工具循环；Python `serve-api`、mail-sync、SQLite SSoT、Notion 同步、DavMail 写路径继续作为业务域服务层存在。

换句话说：

```txt
assistant-ui = 唯一聊天视图层
Vercel AI SDK Gateway = chat / LLM / tool orchestration 层
Python serve-api + mail-sync = 邮件 / Notion / KOS / SQLite SSoT 业务域层
A2UI = Tool result / approval card 的 typed UI payload
AG-UI = 后续对外 agent event / interrupt / state snapshot 互操作桥
```

## 为什么不是“全后端切 AI SDK”

MailAgent 的核心后端不是普通 chat backend，而是邮件同步、DavMail 写入、Notion 镜像、outbox FanoutWorker、KOS、附件抽取、SQLite SSoT 等业务系统。Vercel AI SDK 的强项是 **LLM provider 标准化、`streamText`、tool calling、UIMessage stream、`useChat`/assistant-ui 生态**；它不应该替换 Python 邮件业务栈。

官方依据：AI SDK 6.x 当前定位为 TypeScript toolkit，Core 统一生成文本、结构化输出、tool calling 和 agent 构建，UI 提供 framework-agnostic chat / generative UI hooks；assistant-ui 也把 Vercel AI SDK Runtime 作为一等 runtime，并推荐新项目使用 v6；AI SDK tool approval 支持敏感工具审批，但其机制是“两次模型调用”，不是原地暂停同一个 `streamText` 调用。

## 文档索引

| 文档 | 何时读 | 内容 |
|---|---|---|
| [`prd.md`](./prd.md) | 明确产品目标和验收口径前 | 用户价值、非目标、SLO、功能需求、验收标准 |
| [`architecture.md`](./architecture.md) | 设计 / review 方案前 | 目标架构、服务边界、数据流、部署形态、关键决策 |
| [`protocol-contracts.md`](./protocol-contracts.md) | 改协议 / runtime adapter / stream 前 | UIMessage、A2UI、AG-UI、legacy ChatStreamEvent 的映射契约 |
| [`context-injection.md`](./context-injection.md) | 改 prompt / 上下文注入前 | `AgentContextSnapshot`、隐式 UI 状态注入、prompt 防注入 |
| [`generative-ui-hitl.md`](./generative-ui-hitl.md) | 改工具卡片 / 审批链路前 | A2UI ComponentRegistry、NotionSyncCard、SendApprovalCard、人类在环 |
| [`roadmap.md`](./roadmap.md) | 拆 PR / 排期前 | 总体阶段图、依赖关系、feature flags、回滚策略 |
| [`phase-00-research-and-spike.md`](./phase-00-research-and-spike.md) | 开始专项前 | 调研、PoC、技术闸口 |
| [`phase-01-assistant-ui-shell.md`](./phase-01-assistant-ui-shell.md) | 替换视图层前 | assistant-ui shell、视觉一致性、legacy UI 并行 |
| [`phase-02-ai-sdk-gateway.md`](./phase-02-ai-sdk-gateway.md) | 引入 Node AI Gateway 前 | AI SDK Gateway、模型调用、UIMessage stream、持久化 |
| [`phase-03-tool-registry.md`](./phase-03-tool-registry.md) | 迁移工具定义前 | AI SDK tools、Python domain tool bridge、审计表兼容 |
| [`phase-04-generative-ui-hitl.md`](./phase-04-generative-ui-hitl.md) | 上线复杂交互卡片前 | A2UI 卡片、approval、外发邮件安全底线 |
| [`phase-05-ag-ui-interop.md`](./phase-05-ag-ui-interop.md) | 接 AG-UI / 对外 agent 协议前 | AG-UI event mirror、interrupt、state snapshot |
| [`phase-06-cutover-and-cleanup.md`](./phase-06-cutover-and-cleanup.md) | 默认切流 / 删除 legacy 前 | cutover、dogfood、回滚、清理旧 harness |
| [`acceptance-checklist.md`](./acceptance-checklist.md) | 每个 PR / phase 验收前 | 功能、性能、安全、回归 checklist |

## 一句话决策

**采用 AI SDK Gateway 后，整体架构更优，但前提是明确边界：AI SDK 接管“LLM 编排层”，不接管“邮件业务域层”。** 这能让前端 assistant-ui 直接走成熟的 AI SDK runtime，又保留 MailAgent 现有 Python 服务层的稳定性和 SSoT。