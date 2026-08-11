# 办公场景与预设模板

## 1. 模板原则

- 模板只是普通 Custom Agent 配置；
- 不写专用运行代码；
- 用户可通过主 Agent 自然语言定制；
- 输出格式放在 Prompt；
- 重复的格式和步骤抽成 Skill；
- 项目数据继续以邮件和 Notion 为真源。

## 2. 标案跟进助手

### Description

跟踪标案相关邮件、附件与 Notion 标案资料，识别截止时间、资格要求、材料缺口、责任人与风险。

### 建议 Trigger

- Email Filter：主题/发件人/Thread ID；
- Schedule：工作日早上检查；
- 可选 Calendar：答疑会、截止日更新。

### 建议能力

```text
Email: read
Calendar: read
Knowledge and sessions: on
Reports: produce
Notion connector: update
Web: gated
Files/commands: 按需
```

### Prompt 要点

- 读取命中邮件正文与附件；
- 查询指定 Notion Database；
- 按标案编号去重；
- 提取资格条件、交付日期和材料；
- 对邮件与 Notion 不一致处单列；
- 生成报告并更新对应 Notion 页面；
- 不自动发送外部邮件。

## 3. 会前准备

> 同一会议仅调整开始/结束时间时，不重复生成 change-run 报告；系统只把会前再次检查任务移动到新的会议时间。

### Trigger

```text
calendar_event_change
calendar_before_start(lead_time=1 day)
```

也可在首次收到会议邀请邮件时由 Email Trigger 运行。

### 工作方法

1. 读取会议标题、参与人、时间和议程；
2. 检索相关邮件线程；
3. 检索 Notion PRD、需求池和历史会议纪要；
4. 输出背景、最新进展、争议、待决策和建议问题；
5. 用 Calendar Event ID 在 Notion 中查找已有 Brief；
6. 找到则更新，未找到则创建。

### Skill

建议提供 `meeting-brief` Skill，固定页面结构与查找规则。

## 4. 产品项目跟进助手

不在 MailAgent 建 Project 实体。Prompt 维护项目识别线索：

```text
项目名称与别名
相关联系人
邮件关键词与 Thread
Notion Page/Database
固定报告页面
```

### Trigger

- 相关 Thread 新邮件；
- 主题或发件人过滤；
- 每周 Schedule；
- 关键会议创建/更新。

### 输出

- 本周进展；
- 需求变化；
- 风险与依赖；
- 待确认；
- 下一步；
- 证据引用。

## 5. 重要邮件与待办梳理

### Trigger

- 工作日早上 Schedule；
- 特定文件夹新邮件。

### 工作方法

- 扫描未处理或高优先级邮件；
- 读取正文，不只看 snippet；
- 识别需要回复、决策、跟进和等待事项；
- 按紧急/重要分组；
- 生成 Session 报告或本地 Report；
- 只生成草稿，不发送。

## 6. 每周产品进展总结

### 数据源

- 本周项目邮件；
- Notion 需求池；
- 会议纪要；
- 过去一周 Agent Session；
- 可选 Calendar。

### 输出格式

```markdown
# 本周进展
## 已完成
## 需求变化
## 风险与阻塞
## 待决策
## 下周计划
## 证据
```

## 7. 主 Agent 自动生成模板

当用户描述新的长期工作时，主 Agent 应：

- 判断是否已有接近模板；
- 有则复制并改写；
- 无则从空白生成；
- 明确 Prompt、Trigger、能力、Connector、预算和输出；
- 自动 Trigger 默认关闭；
- 引导一次手动试运行。

## 8. 模板验证

每个内置模板至少有：

- 一个成功 fixture；
- 一个无命中 fixture；
- 一个外部内容注入 fixture；
- 一个 Connector 不可用 fixture；
- 一个审批暂停 fixture；
- 输出格式断言。
