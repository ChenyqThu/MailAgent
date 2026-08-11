# 产品愿景与范围

## 1. 目标用户

第一目标用户是：

> 以邮箱沟通为主要工作方式的单个企业办公人员，当前核心画像是产品经理。

特点：

- 每天处理大量邮件、附件、会议邀请和跨部门沟通；
- PRD、需求池、会议纪要和项目资料主要在 Notion；
- 需要持续跟进产品项目、标案、承诺和会议；
- 希望通过本地应用降低 Notion Custom Agent 等云服务成本；
- 不需要团队账号、组织管理或多人协作平台。

## 2. 产品愿景

MailAgent 不只是邮件分类器，也不是通用聊天壳。它应逐步成为：

> 能理解邮件、Notion、日历和历史 Session，帮助用户创建专项 Agent，持续跟进长期工作，并在安全边界内执行办公动作的个人 Agent 伙伴。

## 3. 产品中心

近期继续保持：

```text
收件箱 / 邮件详情
+ 通用 Agent Session
+ Custom Agent 页面与运行 Session
+ Connectors / Skills / Settings
```

Session 是用户理解和检查 Agent 工作的主要载体。每一次自动 Custom Agent 运行都创建独立 Session；用户手动聊天是否延续旧 Session，继续由用户决定。

不建设：

- WorkItem；
- Workspace；
- 内建 Project；
- 团队任务中心；
- 复杂统一主页。

真实产品项目仍存在于邮件和 Notion 中，MailAgent 通过 Prompt、Connector 和 Session 理解它们。

## 4. 核心场景

### 4.1 邮件理解与处理

现有能力继续强化：

- 分类与重要性判断；
- 邮件和线程检索；
- 附件阅读；
- 总结、翻译和草稿；
- 承诺、截止时间与风险识别；
- 结合 Notion 验证邮件信息。

### 4.2 Notion 知识与写入

Notion 始终通过 MCP Connector 接入：

- 搜索 Database/Page；
- 读取 PRD、需求池、会议纪要；
- 跨页面综合；
- 结合邮件分析；
- 创建或更新页面；
- 按 Prompt 或 Skill 规定的格式输出报告。

MailAgent 不复制 Notion 的项目和数据库模型。

### 4.3 长期专项跟进

用户提出重复或长期需求时，主 Agent 可以建议并创建 Custom Agent，例如：

- 标案跟进；
- 产品项目进展；
- 特定邮件线程跟进；
- 需求反馈整理；
- 每周进展报告；
- 重要会议准备；
- 客户或合作方承诺检查。

### 4.4 会前准备

Custom Agent 可配置：

- Calendar Event 创建或业务字段更新时运行；
- 会前指定提前量再次运行；
- 读取相关邮件、Notion 页面和历史会议；
- 创建或更新 Notion 会前报告。

报告复用与页面格式通过 Prompt 或 `meeting-brief` Skill 表达，不建设 Meeting Report 子系统。

### 4.5 主 Agent 委派专项 Agent

主 Agent 可以：

- 列出已有 Agent；
- 读取它们的描述与状态；
- 选择最合适的专项 Agent；
- 传一次性 instruction 与结构化引用；
- 内部固定等待 180 秒；
- 获得结果或后台 Session 链接。

第一阶段只有人工主 Agent可以调用 Custom Agent，避免 Agent 递归。

## 5. Custom Agent、Skill 与 Connector 的分工

```text
Custom Agent
  谁长期负责什么、何时运行、拥有哪些能力

Prompt
  具体工作方法与输出要求

Skill
  可复用的方法、参考资料与可选确定性脚本

Connector
  连接外部系统并提供结构化工具
```

不单独建设 Workflow 产品。复杂工作流程写在 Prompt 中；重复且稳定的方法抽成 Skill。

## 6. 输出原则

近期不增加复杂 `output_target` 后端模型。输出由 Prompt 规定：

- 当前 Session 回答；
- 写入本地 Report；
- 创建/更新 Notion 页面；
- 生成邮件草稿；
- 读取或更新 Connector 对象。

复杂输出规范应通过 Skill 封装，例如：

- 周报结构；
- 标案风险表；
- 会议 Brief 页面模板；
- Notion Database 字段映射。

## 7. 自主性原则

```text
工具不可见 / off  → Agent 不能调用
工具 auto          → Agent 可自动调用
工具 ask           → 调用时审批
平台安全底线       → 即使 auto 也不能绕过
```

一旦用户把普通读能力开放给 Agent，Agent 应自然使用，不反复询问。写入、外发、Exec 和能力变更继续按风险控制。

## 8. 非目标

- 团队协作；
- 账号与登录；
- 多租户；
- 通用项目管理；
- 多 Runtime；
- 自由多 Agent 群聊；
- 可视化 Workflow Builder；
- 云端统一执行；
- 大规模插件市场；
- 近期商业化设计。
