# docs/reference —— 常青参考层

> MailAgent 的「当前真相」参考文档，按子系统分层。每个子目录有 `index.md`（何时读表）。

> 全局导航总索引是仓库根的 [`CLAUDE.md`](../../CLAUDE.md)「文档地图」；本页是它的展开。

> 文档规范见 [`../DOC-GUIDE.md`](../DOC-GUIDE.md)。过程产物在 [`../archive/`](../archive/)（按年-月，冻结存史）。

## 子系统

| 子系统 | 内容 |
|---|---|
| [`architecture/`](./architecture/index.md) | 架构内核 —— MailAgent 的系统级架构、状态机、SSoT 演进与后端服务化。 |
| [`cli/`](./cli/index.md) | CLI —— mailagent agent-friendly CLI 的命令、契约与设计。 |
| [`llm-agent/`](./llm-agent/index.md) | LLM Agent / Harness / KOS —— 本地 LLM 邮件分类、前端 chat 多轮 agent、跨域知识图 KOS。 |
| [`calendar/`](./calendar/index.md) | Calendar 模块 —— CalDAV → SQLite SSoT 的日历同步。 |
| [`folder-sync/`](./folder-sync/index.md) | 存档/草稿箱 + 多文件夹同步 —— folder_sync：自定义 Exchange 文件夹并入主链路。 |
| [`remote-chat-report/`](./remote-chat-report/index.md) | 远程 chat + 报告 Agent —— V2.1 远程 web chat/report，与日/周/月报告 Agent 系统。 |
| [`project-progress/`](./project-progress/index.md) | 项目周报同步 —— 外挂模块：xlsx → Notion 项目周报。 |
| [`packaging/`](./packaging/index.md) | 打包 / 发布 / Onboarding —— 前后端一体化 .app 打包、发布、新老用户 onboarding。 |
| [`web-remote/`](./web-remote/index.md) | V2 远程访问运维 —— Cloudflare Tunnel + serve-api + PWA 远程访问上线。 |
| [`integrations/`](./integrations/index.md) | 集成面（Webhook / SSE / Openclaw / Notion） —— 对外集成的 API 与回调契约。 |
| [`notify-center/`](./notify-center/index.md) | 统一通知中心 —— 铃铛 + 持久化通知面，后台任务完成/待办/系统告警的第一公民载体。 |
| [`search/`](./search/index.md) | 邮件搜索 —— 搜索 Query DSL 的双端契约。 |
| [`ops/`](./ops/index.md) | 运维 / 验收 —— 跨子系统的运维 Runbook 与真机验收。 |
