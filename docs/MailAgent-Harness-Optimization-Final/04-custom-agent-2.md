# Custom Agent 2.0

## 1. 定位

Custom Agent 是 MailAgent 中承担长期、重复或专项办公工作的配置单元：

```text
Prompt 工作方法
+ Skill 与工具
+ Connector 授权
+ Trigger
+ 预算
+ 每次独立 Session
```

它不是独立 Runtime，也不是 Workflow Graph。

## 2. 最小 Agent 规范

```yaml
id: bid-followup
version: 2

title: 标案跟进助手
description: 跟踪标案邮件、附件和 Notion 资料，识别截止时间、资格条件、缺口和风险。

prompt: |
  你的任务是……

model: null
enabled: true

capabilities:
  email: read
  calendar: read
  knowledge_and_sessions: on
  reports: produce
  web: gated
  files_and_commands: off

skills:
  - bid-review

grant_connectors:
  notion: update

triggers:
  - id: trg_bid_mail
    enabled: false
    kind: email_filter
    subject_pattern: "标案|招标"
    folders: ["收件箱"]

budget:
  max_runs_per_day: 8
  max_run_seconds: 1800
```

后端仍可以保存为现有 `report_agent` 行和 JSON 字段，不要求一次性改变所有 API 名称。

## 3. Agent Description

新增可选 `description`：

- 1–3 句话；
- 说明擅长什么；
- 说明何时适合调用；
- 不复制完整 Prompt；
- 进入 Agent Catalog、模板、导入导出和委派卡。

## 4. ID

- 根据标题生成 slug；
- 冲突时追加短后缀；
- 创建后不可修改；
- 标题可以任意修改；
- 用户界面主要显示标题，不强迫用户理解 ID。

## 5. Agent 与 Trigger 两级开关

```text
agent.enabled
  是否允许手动运行、被主 Agent 调用、执行自动 Trigger

trigger.enabled
  该 Trigger 是否自动触发
```

新建带自动 Trigger 的 Agent：

```text
agent.enabled = true
trigger.enabled = false
```

因此 Agent 可以先手动测试，再单独发布自动化。

## 6. 主 Agent 自动创建 Agent

### 6.1 触发时机

当用户提出：

- 长期跟进；
- 固定周期报告；
- 重复检查；
- 某邮件线程持续监控；
- 会前自动准备；
- 标案或项目专项追踪；

主 Agent 应主动建议创建 Custom Agent。

### 6.2 创建流程

```text
识别重复/长期需求
→ 说明适合建立 Custom Agent
→ 复用当前 Session 已有信息
→ 只追问缺失 Trigger、权限和输出
→ 生成完整配置摘要
→ 用户确认
→ custom_agent_create 审批卡
→ 创建 Agent
→ 自动 Trigger 默认关闭
```

### 6.3 输出要求

输出继续写在 Prompt 中，例如：

```text
每周生成 Markdown 报告，并使用 Notion Connector：
1. 在指定 Database 中按项目名查找现有页面；
2. 找到则更新；
3. 未找到则创建；
4. 页面包含进展、风险、待确认和来源链接。
```

复杂格式抽成 Skill，不增加 output engine。

## 7. 多 Trigger v2

### 7.1 存储

旧 v1：

```json
{ "v": 1, "kind": "email_filter", "subject_pattern": "..." }
```

新 v2：

```json
{
  "v": 2,
  "triggers": [
    {
      "id": "trg_01JABC",
      "enabled": true,
      "kind": "email_filter",
      "subject_pattern": "..."
    }
  ]
}
```

读取旧 v1 时内存转换为单元素数组；第一次编辑后写回 v2。

### 7.2 Trigger 语义

- Trigger 之间 OR；
- 同一个 Trigger 中条件 AND；
- 每条 Trigger 有稳定 ID；
- 可单独启停；
- 每次 Session 记录 trigger ID、kind 和 firedAt。

### 7.3 Email Filter

新增：

```yaml
thread_ids:
  - <mail thread id>
```

匹配：

```text
folder AND sender AND subject AND thread_id
```

未配置的条件恒 True。

UI 在邮件线程上提供：

```text
为此线程建立跟进 Agent
```

自动填充 Thread ID。

### 7.4 Calendar Trigger

首批支持：

```text
calendar_event_change
calendar_before_start
```

业务字段变化：

- 新建；
- 标题；
- 组织者；
- 参与人；
- 地点或会议链接；
- 议程/正文；
- 取消状态。

忽略同步时间戳、ETag 等技术变化。对同一 Calendar Event，若只有开始/结束时间改变，不触发 `calendar_event_change`；系统只重排该 Event 的 `calendar_before_start`。若时间变化同时伴随其他业务字段变化，则按业务内容变化正常触发。

`calendar_before_start` 的 `lead_time` 可配置，模板默认 1 天。Calendar change 去重使用 `event_id + business_content_hash`，默认 60 秒合并窗口。

### 7.5 去重和并发

```text
相同 trigger_id + dedupe_key → 幂等
不同 trigger_id             → 独立运行
manual run-now              → 不被自动 Trigger 去重
```

默认 key：

- email：internal_id/message_id；
- calendar_event_change：event_id + business_content_hash；
- calendar_before_start：event_id + scheduled_start + lead_time；
- schedule：scheduled occurrence。

同一 Agent 固定串行；新运行排队，不并行。

## 8. 每次运行独立 Session

自动运行与委派运行均创建独立 Session。

Custom Agent 可以通过 Session 查询工具读取过去记录，但不自动注入所有历史。

使用原则：

```text
需要了解过去执行情况
→ 先按 agent_id 查询最近 Session
→ 读摘要或命中片段
→ 必要时读取完整 Session
→ 仍需用邮件/Notion检查最新事实
```

## 9. Agent Catalog

增加纯只读：

```text
agent_catalog_list
agent_catalog_get
```

仅在 `Knowledge and sessions = on` 时给 Custom Agent 注册。

返回：

- id；
- title；
- description；
- enabled；
- Trigger 摘要；
- 最近运行时间和状态。

不返回：

- 完整 Prompt；
- 详细权限规则；
- Secret；
- 修改、删除或启动入口。

## 10. 主 Agent 调用 Custom Agent

### 10.1 工具

新增 `custom_agent_call`，保留 `custom_agent_run_now`。

```ts
interface CustomAgentCallInput {
  agent_id: string;
  instruction: string;
  context_note?: string;
  source_session_id?: number;
  email_internal_ids?: number[];
  email_thread_ids?: string[];
  calendar_event_ids?: string[];
  notion_refs?: Array<{
    connector_id: string;
    object_id: string;
    object_type?: string;
  }>;
  report_ids?: string[];
  user_requested?: boolean;
}
```

`instruction` 是本次用户消息，不能覆盖固定 Prompt，也不能扩大工具权限。

### 10.2 调用范围

第一阶段只有人工 `manual_chat` 主 Agent 可调用。

Custom Agent：

- 可以发现其他 Agent；
- 可以查询获准范围的 Session；
- 不能调用、创建、更新或删除其他 Agent。

### 10.3 同步与后台

内部固定等待 180 秒，第一版不向用户或模型开放等待时间配置：

```text
快速完成 → 返回 final_answer、引用和 Session
未完成   → 返回 running、job_id、session_id
```

结果卡持续更新，但完成后不自动重新唤醒父模型。

### 10.4 父子 Session

子 Session 记录：

```text
parent_session_id
parent_tool_call_id
invoked_by = main_agent | user
```

一次性 instruction 已作为第一条用户消息保存，不在 Session 行重复。

### 10.5 审批

- 只读/报告型 Agent 调用可自动；
- 拥有写、开放 Web、Exec 或外发能力的 Agent，主 Agent 主动委派时默认显示调用确认卡；
- 第一版接受模型在 `manual_chat` 中自报 `user_requested=true`：为 true 时跳过**外层 Agent 调用卡**；该字段必须进入审计；
- `user_requested` 只影响是否显示外层调用卡，不能改变目标 Agent 的 ToolSet、Connector ceiling、Exec 规则或子 Tool 审批；
- 子 Agent 的具体 Tool Call 仍走自身审批；
- 子 Agent 审批只在子 Session 操作；
- 父结果卡显示“等待确认”并提供入口。

### 10.6 结果卡

显示：

- Agent 名称；
- 运行状态；
- 耗时；
- 简短结论；
- Artifact/Notion 引用；
- 子 Session 入口；
- 审批或错误；
- 停止子运行按钮。

## 11. 模板

首批模板只做 3–5 个已验证场景：

- 标案跟进；
- 会前准备；
- 产品项目跟进；
- 重要邮件与待办梳理；
- 每周进展总结。

模板只是普通 Custom Agent JSON，不写特殊代码。
