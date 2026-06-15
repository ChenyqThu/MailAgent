# LLM Agent / Harness / KOS

> 本地 LLM 邮件分类、前端 chat 多轮 agent、跨域知识图 KOS。

> 常青参考文档。过程产物（handoff/phase/complete）见 `docs/archive/{年-月}/`。

## 何时读哪篇

| 文件 | 何时读 | 内容 |
|---|---|---|
| [`llm-agent.md`](./llm-agent.md) | 改邮件分类 / prompt / cache 前 | 本地 LLM 分类运维（fallback / cache / 监控 / payload，防双跑） |
| [`LLM_AGENT_SETUP.md`](./LLM_AGENT_SETUP.md) | 启用本地 LLM 接管 Notion Agent 前 | 本地 LLM 启用清单 + 防双跑配置 |
| [`architecture_agent_harness.md`](./architecture_agent_harness.md) | 理解 chat harness 架构前 | Agent Harness 架构总览（M1-M4、tool calling、chat_db schema） |
| [`agent-harness-design.md`](./agent-harness-design.md) | 实施前端 chat agent 前 | Agent Harness 工程级实施指南（M1 权威 ref） |
| [`agent-harness-kos.md`](./agent-harness-kos.md) | 动前端 chat / KOS 集成前 | 前端 chat 多轮 agent + KOS 集成下沉文档 |
| [`kos-integration-design.md`](./kos-integration-design.md) | 对接 Jarvis KOS 前 | MailAgent ⇄ Jarvis KOS 集成设计（M2 Wiki 路径） |
| [`chat-history-design.md`](./chat-history-design.md) | 动 chat 持久化 / retrieval 前 | Chat 历史持久化 + KOS ingest + 时间衰减 retrieval 设计 |
