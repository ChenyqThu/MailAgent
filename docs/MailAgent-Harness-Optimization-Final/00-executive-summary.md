# 执行摘要

> Q1–Q100 与 G1–G9 已全部冻结，当前没有阻塞开发的产品未决问题。

## 1. 最终产品判断

MailAgent 应继续沿着现有路线演进：

> **一个面向单个企业办公人员、以邮件和 Session 为中心、能够读取邮件与 Notion、创建专项 Custom Agent、持续跟进长期任务并安全执行工具的本地办公 Agent 伙伴。**

近期不把 MailAgent 改造成团队协作平台、项目管理系统或多运行时 Agent 平台。当前用户只有一个人，数据与凭证都在本地，远程访问只是现有本地能力的延伸。

## 2. 当前方案中被明确否决的方向

以下内容从近期主线中删除：

- Runtime-neutral `AgentRuntime` SPI；
- Pi Runtime、Craft Runtime 或 Graph Runtime；
- `CompiledRunPlan` 大改造；
- 全新的 Canonical AgentEvent 平台；
- WorkItem、Workspace、Project、Work Inbox；
- 通用 Workflow/Graph 编排系统；
- 组织账号、多租户和团队权限；
- 云 SaaS 数据平面；
- Custom Agent 递归调用 Custom Agent；
- 通用 Webhook Trigger 第一阶段实现。

这些方向并非永远不能做，而是与当前用户规模、人力和风险承受能力不匹配。

## 3. 必须保留的既有资产

MailAgent 已经拥有大量成熟能力，优化应建立在这些资产之上，而不是重新建设：

- AI SDK 7 `streamText` Tool Loop；
- assistant-ui 原生 UIMessage 流与持久化；
- `manual_chat / untrusted_trigger / cron_headless / im_chat` 运行来源矩阵；
- 工具 class、Skill gating 和 Context Mode 过滤；
- `auto / ask / off` 工具权限；
- ApprovalGuard、输入 hash、过期、one-shot 与恢复；
- Detached Run、显式 Stop 与同 Session 并发保护；
- Python 邮件、日历、报告、Notion、Connector 和 Exec 执行权威；
- MCP Connector 工具动态注册、CRUD 天花板和服务端二次授权；
- Skill quarantine、文件 hash、Secret 声明、完整性检查和无 Shell Exec；
- Custom Agent 手动、Schedule/Cron、Email Filter 运行；
- Headless Agent Session、最近运行、未读状态和审批暂停；
- ToolTraceCard、报告 Artifact 和 Agent Eval。

## 4. 核心目标

### 4.1 主 Agent 更像真正的办公伙伴

主 Agent 应能：

- 理解用户提出的长期或重复工作；
- 自动建议建立专项 Custom Agent；
- 根据当前对话生成 Prompt、工具、Skill、Connector、Trigger 与预算配置；
- 在用户确认后创建 Agent；
- 根据当前任务调用已有 Custom Agent；
- 把子 Agent 结果以摘要卡片反馈到父 Session；
- 继续通过邮件、Notion、日历和 Session 工具完成办公任务。

### 4.2 Custom Agent 更适合长期跟进

Custom Agent 的目标形态：

```text
身份与描述
+ Prompt 工作方法
+ 模型
+ Skill 与工具能力
+ Connector 授权
+ 多 Trigger
+ 预算
+ 每次独立 Session
+ 可查询的历史运行
```

不增加独立 Workflow 产品。复杂流程继续写进 Prompt；确定性、可复用或脚本化部分抽成 Skill。

### 4.3 长 Session 更可靠

近期重点补齐：

- 恢复轻量 `plan_update`；
- `/compact` 手动压缩；
- 已知上下文窗口达到 90% 后自动压缩；
- Context Overflow 后分块压缩并重试一次；
- 运行中允许输入 Follow-up Queue；
- 队列可编辑、删除、持久化；
- 后续等待 AI SDK 原生能力成熟后再做真正 Tool-boundary Steering。

## 5. 技术方案总览

```text
现有 Electron / Web UI
        │
        ▼
现有 AI SDK Gateway
  ├─ plan_update UI tool
  ├─ compact endpoint + context selector
  ├─ queued follow-up dispatcher
  ├─ custom_agent_call
  └─ 现有 Tool/Approval/Connector 路径不变
        │
        ▼
Python Serve API / Domain Kernel
  ├─ Agent v2 Trigger 校验
  ├─ Session 组合查询
  ├─ Agent Catalog
  ├─ Agent Run Queue
  ├─ Connector 二次授权
  ├─ Skill Supply / Exec Gate
  └─ Mail / Calendar / Notion / Report
        │
        ▼
现有本地数据库
  ├─ ai_chat.db：Session、消息、队列、Compact、父子来源
  ├─ agent_config.db / report agent：Agent 与 Trigger 配置
  └─ sync_store.db：邮件、日历与领域 SSoT
```

## 6. P0–P9 实施顺序

```text
P0  plan_update 最小恢复
P1  Session 查询、Agent 身份和 Trigger 来源
P2  custom_agent_call 与父子 Session
P3  手动 /compact
P4  90% 自动 Compact 与 Overflow Recovery
P5  Follow-up Steering Queue
P6  多 Trigger v2 与 email thread 过滤
P7  Calendar 创建/更新与会前 Trigger
P8  Skill Creator 与可信 Skill 版本
P9  Agent Plugins Skill 导入/导出
```

每一步均要求：

- 独立 Feature Flag；
- 不依赖下一阶段；
- migration 可回退或兼容旧数据；
- 现有 Eval 与安全测试全绿；
- 不削弱审批、工具矩阵和 Python 二次授权。

## 7. North Star

近期不需要复杂商业指标。成功标准是：

> 用户能够真正使用主 Agent 与专项 Custom Agent 完成日常邮件、Notion、会议准备和项目跟进工作。

建议观察：

- 每周实际运行的 Custom Agent 数；
- 运行成功率；
- 用户打开并阅读结果的比例；
- 报告或 Notion 输出被采用的比例；
- 重复失败、Context Overflow 与审批过期率；
- 用户手工修改 Agent Prompt 的比例；
- 用户主动再次运行或保留模板的比例。
