# 已接受的架构与产品决策

> 本文是 Grill Q1–Q100 与 G1–G9 的冻结结果。当前没有未回答的产品问题；开发应以本文件为需求真源。

## A. 产品与用户

| 决策 | 结果 |
|---|---|
| 目标用户 | 单个企业办公人员，尤其是邮件沟通为主的产品经理 |
| 协作 | 不做团队账号或协作平台；通过 Agent/配置 JSON 导入导出分享 |
| 部署 | 数据和执行本地，可远程访问 |
| 产品中心 | 邮件、Session、Custom Agent；不引入 WorkItem/Workspace |
| Notion | MCP 知识与写入源，不复制项目数据模型 |
| 开源/商业 | 个人开源项目，不围绕商业化设计 |
| 成功标准 | 用户能真实用 Agent 完成日常工作，优先回答与执行质量 |

## B. Harness

| 决策 | 结果 |
|---|---|
| Runtime | 继续 Vercel AI SDK |
| Runtime 抽象 | 不做 |
| 第三方框架 | 学设计，不整体替换 |
| Plan | 恢复最小 `plan_update` UI Tool；第一版卡片只读、仅模型可更新 |
| Compact | `/compact` + 90% 自动 + Overflow Recovery |
| Compact 模型 | 第一版当前 Session 模型、minimal effort；以后可配置 |
| Steering | 第一阶段 Run 完成后的持久 Follow-up Queue；后续等待 AI SDK 再做 Tool-boundary |
| 工具时间线 | 复用现有 ToolTraceCard |
| 失败纪律 | 现有 Prompt 已有；可后续补相同错误确定性 Guard |

## C. Custom Agent

| 决策 | 结果 |
|---|---|
| 定义 | Prompt + Skill + Connector/Tool + 模型 + Trigger + 预算 |
| Workflow | 不单独建设，流程写进 Prompt，复杂确定性部分用 Skill |
| 每次运行 | 独立 Session |
| 跨 Session | 通过 Session 查询按需读取，不自动注入全部历史 |
| 项目跟踪 | 使用邮件和 Notion；不建 MailAgent Project 实体 |
| 输出 | Prompt 规定；复杂格式做 Skill |
| 主 Agent 创建 | 主 Agent 主动建议、生成配置、用户确认；自动 Trigger 默认关闭 |
| Description | 新增简短描述 |
| ID | 标题生成稳定 slug，冲突加后缀，创建后不可改 |
| UI | Agent 列表、编辑、启停、运行、最近运行、权限预览、Dry Run、导入导出 |
| 模板 | 标案、会前、产品项目、重要邮件、周报等少量模板 |

## D. Session 与历史

| 决策 | 结果 |
|---|---|
| 来源字段 | agent_id/job_id 基础上增加 trigger_id/kind/fired_at |
| Agent 身份 | Headless System Prompt 注入可信 agent identity |
| 查询 | 统一组合查询：FTS + agent/trigger/origin/time 等过滤 |
| 自己历史 | Custom Agent 默认可查自己的运行 |
| 全部历史 | 需要 Knowledge and sessions = on |
| Agent Catalog | 只读 ID、标题、描述、Trigger 摘要和最近状态 |
| 未读 | 打开具体 Session 才清除；主导航与 Agent 行聚合红点 |
|父子关系 | parent_session_id、parent_tool_call_id、invoked_by |

## E. Agent 委派

| 决策 | 结果 |
|---|---|
| 谁可调用 | 第一阶段仅人工主 Agent |
| 工具 | 新增 `custom_agent_call`，不替换 `run_now` |
| 临时输入 | 允许 instruction，不覆盖固定 Prompt |
| 上下文 | 结构化引用 + 有界 context_note，不复制父 Session |
| 等待 | 内部固定 180 秒；不暴露配置；完成则返回，否则后台 Session |
| 结果 | 父 Session 显示有界结果卡和子 Session 入口 |
| 审批 | 低风险可自动；高风险主动委派默认显示调用卡；接受模型自报 `user_requested=true` 跳过外层卡，但子工具仍独立审批并审计该标记 |
| 子审批 | 只在子 Session 操作 |
| 停止 | 父结果卡可停止子运行 |
| 并发 | 第一阶段串行 |
| 父停止 | 尚未开始的调用取消；已开始的子 Agent 默认继续后台 |
| 自动恢复父模型 | 第一阶段不做 |

## F. Trigger

| 决策 | 结果 |
|---|---|
| 存储 | `trigger_json` v2 envelope，多 Trigger 数组，兼容 v1 |
| 关系 | Trigger 之间 OR，单 Trigger 条件 AND |
| ID | 系统生成稳定短 ID |
| 当前类型 | manual、schedule/cron、email_filter |
| Email Thread | 在 email_filter 中增加 thread_ids |
| Calendar | event create/update + before_start，lead_time 可配置 |
| Calendar 更新 | 只看业务字段变化；同一 Event 纯时间变化不触发 change run，但重排 before_start |
| 会前准备 | 收到会议时可准备，会前指定时间再次更新 |
|报告复用 | Prompt/Skill 用 Event ID 查找/更新 Notion，不建新模型 |
| Webhook | 暂不支持 |
| 去重 | trigger_id + dedupe_key |
| 并发 | 同 Agent 排队串行 |
| 通知 | Session 未读红点即可；不要求系统通知/飞书 |
| 审批暂停 | 普通写 TTL 24h，高风险外发 2h；过期明确记录 |

## G. Connector、Skill 与权限

| 决策 | 结果 |
|---|---|
| 工具开放 | `auto / ask / off`；开放普通读能力后 Agent 可自然调用 |
|安全地板 | 高风险不能因 auto 绕过 |
| Skill Creator | 先生成 Skill 草稿、测试、用户发布 |
|脚本 | 模型可判断需要并放进草稿，必须说明权限与原因 |
|信任模型 | Builtin / User-created Trusted / Third-party 三层 |
|版本信任 | 绑定 package hash、entrypoint、argv/path/network/secret 约束 |
| Headless Exec | 可信版本 + mounted + grant_exec +结构化规则 |
|发布后 enabled | 发布确认时选择，默认勾选启用 |
| Agent Plugins | 外部兼容层，内部系统不替换 |
|第一版 Plugins | 只导入 Skills；mcp.json 展示但不导入 |
|许可证 | 学习为主；MIT/Apache 可依赖或保留归属复用；LobeHub 不复制受限代码 |

## H. Compact 细节

| 决策 | 结果 |
|---|---|
|历史记录 | 专门 Compact 卡，作为 system message 持久化 |
|上下文 | Summary + first_kept_message_id 后的消息 |
|自动规则 | 80% 提醒、90% Run 后压缩、用户可关闭；不设 85% 二级提醒 |
|Overflow | 分块压缩 + 合并 + 自动重试一次 |
|摘要 | 固定 Markdown 章节；压缩后上下文目标 20%–30%，默认 25%，整体上限 64K |
|删除 | 不删除任何历史消息 |
|状态提醒 | Compact 开始、进行、完成、失败均明确展示 |

## I. Follow-up Queue 细节

| 决策 | 结果 |
|---|---|
| UI | Composer 上方右侧、逐条显示 |
|编辑 | 编辑后回到 Composer |
|删除 | 可逐条删除 |
|多条 | 按顺序合并到下一轮 |
|持久化 | ai_chat.db |
|审批中 | 排队，但不表示审批决定 |
|应用重启 | 恢复待发送，不自动执行 |
|Stop 行为 | 保留未送达消息并转 `restored`，不提供 Stop+清空快捷项 |
|剩余工具 | 第二阶段真正 Steering 时全部 skipped_by_steering |

## J. 实施顺序

已接受：

```text
P0 Plan
P1 Session 来源/查询/身份
P2 Custom Agent Call
P3 手动 Compact
P4 自动 Compact
P5 Follow-up Queue
P6 Multi Trigger + Thread
P7 Calendar Trigger
P8 Skill Creator/Trust
P9 Agent Plugins Skill Import/Export
```

## K. G1–G9 固定实现默认

```text
custom_agent_call wait = 180s（内部常量，无 UI/Tool 配置）
normal approval TTL = 24h
high-risk outbound approval TTL = 2h
compact warning = 80%
compact auto = 90%
compact target = 25% context window, max 64K total context
calendar coalesce window = 60s
plan card = read-only
stop queue behavior = restored
agent plugin v1 = skills only
```

开发 Agent 何时必须向 Owner 询问，见 `grill.md`。
