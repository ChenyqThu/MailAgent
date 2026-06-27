# LLM Agent / Harness / KOS

> 本地 LLM 邮件分类、前端 chat 多轮 agent、跨域知识图 KOS。

> 常青参考文档。过程产物（handoff/phase/complete）见 `docs/archive/{年-月}/`。

## 何时读哪篇

| 文件 | 何时读 | 内容 |
|---|---|---|
| [`llm-agent.md`](./llm-agent.md) | 改邮件分类 / prompt / cache 前 | 本地 LLM 分类运维（fallback / cache / 监控 / payload，防双跑） |
| [`LLM_AGENT_SETUP.md`](./LLM_AGENT_SETUP.md) | 启用本地 LLM 接管 Notion Agent 前 | 本地 LLM 启用清单 + 防双跑配置 |
| [`ai-sdk-gateway-architecture.md`](./ai-sdk-gateway-architecture.md) | **理解 post-cutover（v0.20.0）agent 引擎前（首选）** | **AI SDK Gateway 权威架构**：embedded Node gateway（electron main）+ serve-api 代理（web）+ 工具注册 / HITL 审批 / A2UI / memory / standing-context / AG-UI mirror（§13）。换引擎落地真源 |
| [`architecture_agent_harness.md`](./architecture_agent_harness.md) | 理解**旧自研 harness**（v0.20.0 cutover 前）时 | ⚠️ **post-cutover 已被 `ai-sdk-gateway-architecture.md` 取代**（旧 TS 单 loop harness，cutover 后 legacy 路径仅 `MAILAGENT_CHAT_RUNTIME=legacy` 可达、待删）。历史参考：M1-M4、tool calling、chat_db schema |
| [`agent-harness-design.md`](./agent-harness-design.md) | 理解旧 harness 工程实施时 | ⚠️ **同上，post-cutover 已被 gateway 取代**。历史参考：旧 harness 工程级实施指南 |
| [`agent-harness-kos.md`](./agent-harness-kos.md) | 动前端 chat / KOS 集成前 | 前端 chat 多轮 agent + KOS 集成下沉文档 |
| [`kos-integration-design.md`](./kos-integration-design.md) | 对接 Jarvis KOS 前 | MailAgent ⇄ Jarvis KOS 集成设计（M2 Wiki 路径） |
| [`chat-history-design.md`](./chat-history-design.md) | 动 chat 持久化 / retrieval 前 | Chat 历史持久化 + KOS ingest + 时间衰减 retrieval 设计 |
