# 附录 D：术语表

| 术语 | 定义 |
|---|---|
| Main Agent | 用户在人工 Session 中直接交互的通用 MailAgent Agent |
| Custom Agent | 用户配置的专项 Agent，拥有 Prompt、能力、Trigger 和预算 |
| Session | AI 对话和 Agent 运行的主要持久化与查看单元 |
| Agent Run | 一次 Custom Agent 后台运行，对应 job 和独立 Session |
| Trigger | 使 Custom Agent 自动运行的条件 |
| Skill | 一套可复用的方法、文档、资源和可选脚本 |
| Connector | 外部服务连接及其结构化工具 |
| Agent Plugin | 外部可分发目录格式，可包含 Skills 和 MCP 配置 |
| Plan | 当前 Session 中模型维护的轻量步骤卡，不是 Workflow |
| Compact | 把旧消息摘要为模型上下文，同时保留完整数据库历史 |
| Follow-up Queue | 当前 Run 完成后送达模型的持久用户补充消息 |
| Steering | 中途改变当前运行计划；第一版只做 Follow-up，后续做 Tool-boundary |
| Trusted Skill Version | 与 package hash 和结构化入口权限绑定的 Skill 信任 |
| Context Mode | manual_chat、untrusted_trigger、cron_headless、im_chat |
| Tool Class | read、artifact、domain_write、capability_change、exec、web、outbound、connector_write 等 |
| Safety Floor | 用户配置不可削弱的产品安全规则 |
| Dedupe Key | 防止同一 Trigger 事件重复创建运行的稳定键 |
| Parent Session | 启动 Custom Agent 子运行的人工 Session |
| Child Session | 被主 Agent 委派后创建的 Custom Agent 运行 Session |
