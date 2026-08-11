# 开发 Handoff

> 本文可直接交给 Coding Agent。实施前先读 `13-accepted-decisions.md`，禁止重新扩大范围。

## 1. 全局约束

### 必须

- AI SDK 继续唯一 Runtime；
- 每个 PR 独立 Feature Flag；
- 保留现有审批与 Python 二次授权；
- 所有 schema 变更 additive 或兼容迁移；
- 同步 TS/Python 类型镜像；
- 更新 Tool Catalog、i18n 和 Eval；
- Feature Flag off 保持旧行为；
- 每个 PR 有回滚说明；
- 只有命中 `grill.md` 的 `[OWNER_CONFIRMATION_REQUIRED]` 条件时才询问 Owner。

### 审批 TTL

- 普通写：24 小时；
- 高风险外发：2 小时；
- 过期必须记录 `approval_expired`。

### 禁止

- 创建 `AgentRuntime`/`CompiledRunPlan` 等新平台抽象；
- 重写 `chatRun.ts` 主 Loop；
- 把 Connector/Exec 移到 Renderer；
- 引入 WorkItem/Workspace；
- 允许 Custom Agent 递归调用；
- 为了 P0–P2 顺便重构所有 tools。

## 2. P0 Handoff：Plan Tool

### 目标

使系统 Prompt 中的 Plan 指令与真实 ToolSet 一致。

### 实现

1. 新建 `createPlanTools()` 或单工具 `plan_update`。
2. Tool 无 `execute` 副作用，仅返回规范化输入。
3. class 使用 local/artifact 语义，所有 Context Mode 可见。
4. UI 注册只读 Plan Card；用户不能直接编辑步骤。
5. 持久化依赖现有 UIMessage。
6. 修改 Prompt：只有复杂任务使用。

### 验收

- [ ] manual/headless ToolSet 都有工具；
- [ ] 简单任务 Eval 不要求 Plan；
- [ ] 计划更新后同一 Card 语义清晰；
- [ ] 旧 `plan_update` 历史仍可渲染；
- [ ] 无数据库新表。

## 3. P1 Handoff：Session 与 Identity

### Schema

`ai_chat_sessions` additive：

```sql
trigger_id TEXT NULL
trigger_kind TEXT NULL
trigger_fired_at INTEGER NULL
```

### Identity

Headless run System Prompt 注入：

```xml
<current_custom_agent>
  <id>...</id>
  <title>...</title>
  <job_id>...</job_id>
  <session_id>...</session_id>
</current_custom_agent>
```

### Query API

支持：query/origin/agentId/jobId/triggerId/kind/time/archived/starred/limit。

### Scope

- self history：服务端强制 current agent id；
- all history：需要 knowledge/sessions grant；
- Catalog：非敏感字段。

### 未读

- Agents 导航 aggregate；
- Agent 行 count；
- 打开具体 Session 才 read。

### 验收

- [ ] v23 旧库迁移成功；
- [ ] Session 创建时间与 firedAt 区分；
- [ ] Agent 能查询自己的历史；
- [ ] 未授权 Agent 不能查询全部；
- [ ] Job 状态投影不复制入 Session；
- [ ] Agent Identity 不来自 request body。

## 4. P2 Handoff：Custom Agent Call

### Tool 输入

使用 `appendices/A-contracts.md`。

### 后端流程

```text
validate target agent
→ compute effective risk summary
→ enqueue agent_run with invocation params
→ create child Session with parent fields
→ poll job for fixed 180 seconds
→ completed: bounded result
→ otherwise: running result
```

### 默认

- 等待时间固定 180 秒；
- Tool schema 与 UI 不暴露等待时间配置；
- 同 tool call 使用 idempotency key；
- 子 answer 上限建议 10K 字符；
- 第一阶段串行。

### 权限

- Tool 仅 manual_chat；
- 目标 Agent 必须 enabled；
- instruction 不能修改 config；
- 上下文引用不自动赋予子 Agent 权限；
- 高风险 Agent 调用卡；`user_requested=true` 时跳过外层卡并审计；
- 子 Tool 独立审批。

### UI

Result Card 状态：

```text
queued
running
waiting_approval
completed
failed
stopped
```

操作：打开子 Session、停止子运行。

### 验收

- [ ] 快速完成返回结果；
- [ ] 超时返回 running；
- [ ] 子 Session 有 parent 字段；
- [ ] 重放不重复创建；
- [ ] Custom Agent ToolSet 中无 `custom_agent_call`；
- [ ] 父停止不默认杀已启动子运行；
- [ ] 子审批只有一个可操作面。

## 5. P3/P4 Handoff：Compact

### 手动

- `/compact`；
- 状态卡；
- 当前模型 minimal effort；
- Compact 后上下文目标 25%，整体上限 64K；
- 无工具；
- 固定 Markdown；
- 写 system compact message。

### 自动

- context window known；
- 80% warn；
- 90% current run finish 后；
- user setting；
- unknown window 不自动。

### Overflow

- 识别 Provider 错误；
- 按模型安全输入窗口分块；
- 合并；
- 重试一次；
- 第二次失败结束。

### 验收

- [ ] 完整历史未删；
- [ ] 模型上下文只用最新 Compact；
- [ ] 副作用/拒绝/引用保留；
- [ ] Compact 失败不改变边界；
- [ ] auto 不在 Tool Loop 中途触发；
- [ ] 手动可 Stop。

## 6. P5 Handoff：Follow-up Queue

### DB

新表见附录 B。

### UI

- active run 时 Composer 可编辑；
- Enter 不直接调用 `/api/ai/chat`，而 enqueue；
- 队列在右上；
- 删除；
- 编辑回填 Composer；
- 等待审批提示。

### Dispatcher

- onFinish 后 CAS claim queued rows；
- 按顺序构造下一轮；
- 启动 detached run；
- 成功后 sent；
- 失败恢复 queued；
- 重启发现无 active run → restored，用户确认。

### 验收

- [ ] Session 切换不丢；
- [ ] 重启不自动发送；
- [ ] 不重复 dispatch；
- [ ] 审批消息不变成批准；
- [ ] Stop 后队列统一转 `restored`，不清空；
- [ ] 现有 send gate 安全不回退。

## 7. P6/P7 Handoff：Trigger

### v2 Parser

- v1 读取兼容；
- 写入 v2；
- Trigger ID 自动生成；
- 未知 kind fail；
- 每 Agent 串行。

### Email

- `thread_ids`；
- 传 watcher thread_id；
- dedupe internal_id；
- 线程 UI 快捷创建。

### Calendar

- change diff；
- before_start schedule；
- lead_time；
- timezone；
- Event ID + business content hash + 60 秒合并；
- 纯时间变化不触发 change run，但重排 before_start；
- Calendar 内容围栏。

### 验收

- [ ] 多 Trigger OR；
- [ ] filters AND；
- [ ] disabled 不执行；
- [ ] same dedupe 不重复；
- [ ] manual 永不去重；
- [ ] Calendar 技术字段不触发。

## 8. P8 Handoff：Skill Creator

### 流程

```text
conversation → draft → files/tests → validate → preview → publish → optional enable
```

### Script

模型可生成，但必须输出权限说明。发布不等于 trust。

### Trust

新增结构化 trust record；执行前校验 package hash 与 entrypoint。

### 验收

- [ ] 草稿不执行；
- [ ] 正负触发测试；
- [ ] 发布确认；
- [ ] hash 变化撤销；
- [ ] Headless 四条件；
- [ ] Secret 不进入草稿日志。

## 9. P9 Handoff：Agent Plugins

### Import-only 起步

- plugin.json；
- skills；
- containment；
- 组件独立错误；
- 进入 Skill Draft；
- mcp.json 只展示。

### Export

- 无 Secret；
- 保留许可证；
- 生成稳定目录。

## 10. PR 模板

每个 PR 描述必须包含：

```markdown
## Goal
## Non-goals
## Current behavior
## New behavior
## Security invariants
## Schema/migration
## Feature flag
## Tests
## Agent Eval
## Dogfood evidence
## Rollback
```

## 11. 建议第一个开发任务

直接从 P0 开始：

```text
Task: restore lightweight plan_update for AI SDK runtime
```

不要同时做 Compact 或 Session Schema。P0 完成并 Dogfood 后再进入 P1。
