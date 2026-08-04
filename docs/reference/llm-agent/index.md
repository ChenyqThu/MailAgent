# LLM Agent / Harness / KOS

> 本地 LLM 邮件分类、前端 chat 多轮 agent、跨域知识图 KOS。

> 常青参考文档。过程产物（handoff/phase/complete）见 `docs/archive/{年-月}/`。

## 何时读哪篇

| 文件 | 何时读 | 内容 |
|---|---|---|
| [`llm-agent.md`](./llm-agent.md) | 改邮件分类 / prompt / cache 前 | 本地 LLM 分类运维（fallback / cache / 监控 / payload，防双跑） |
| [`LLM_AGENT_SETUP.md`](./LLM_AGENT_SETUP.md) | 启用本地 LLM 接管 Notion Agent 前 | 本地 LLM 启用清单 + 防双跑配置 |
| [`ai-sdk-gateway-architecture.md`](./ai-sdk-gateway-architecture.md) | **理解 agent 引擎前（首选，唯一引擎，S3 起旧自研 harness 已删除）** | **AI SDK Gateway 权威架构**：embedded Node gateway（electron main）+ serve-api 代理（web）+ 工具注册 / HITL 审批 / A2UI / memory / standing-context / AG-UI mirror（§13） |
| [`kos-integration-design.md`](./kos-integration-design.md) | 对接 Jarvis KOS 前 | MailAgent ⇄ Jarvis KOS 集成设计（M2 Wiki 路径，已 ship，三层 flag 默认关） |
| [`mcp-connectors.md`](./mcp-connectors.md) | 动 `src/connectors/` / connector 端点 / gateway connector 工具 / 第七能力卡前 | **MCP Connectors**（我们当 MCP client 接外部服务）：`agent_config.db` 双表 + OAuth 2.1/PKCE/DCR + 状态机（needs_reauth / orphan）+ 四调用方授权矩阵 + `UNTRUSTED_MCP_TOOL` 围栏 + 灰度 flag `MAILAGENT_MCP_CONNECTORS` |
| [`im-feishu-chat.md`](./im-feishu-chat.md) | 动 `src/im/` / `/api/im/*` / gateway `im-chat` 入口 / 设置-AI「飞书对话」区前 | **飞书对话**（agent 的第四个场地）：lark-oapi 长连接挂 serve + `im_chat` 工具矩阵（读免批 / 写恒 HITL / exec·capability_change·outbound 不注册）+ 飞书内按钮审批闭环（含 `repaused` 非终态陷阱）+ 会话映射与桌面可见 + `im:feishu` 凭证与绑定码 + 与通知 bot 的隔离边界 + 灰度 flag `MAILAGENT_IM_FEISHU` |
