# 源码修改地图

> 原则：修改点尽量贴近现有模块，不建立新的 `agent-platform/` 大目录。

## P0：Plan

### 新增

- `frontend/src/ai-gateway/tools/plan.ts`
- `frontend/src/shared/assistant/tools/generic/PlanCard.tsx`（第一版只读）
- tests：Tool、Card、Prompt parity

### 修改

- `frontend/src/ai-gateway/tools/index.ts`：注册 `plan_update`
- `frontend/src/ai-gateway/tools/policy.ts`：class 建议 `artifact` 或 `read` 类 local tool
- `frontend/src/shared/assistant/tools/registerToolUIs.tsx`
- `frontend/src/shared/components/chat/tool_steps.ts`
- `tests/agent_eval/tool_catalog.json`
- `src/agent_config/templates.py::AGENT_TEMPLATE`：更新真实使用说明

## P1：Session 来源与查询

### Schema

- `frontend/src/electron/main/chat_db/connection.ts`
  - bump `CHAT_DB_VERSION`
  - additive columns：trigger_id/kind/fired_at
- `frontend/src/electron/main/chat_db/sessions.ts`
  - `createAgentSession` 接收来源
  - list projection 增加字段
- `frontend/src/shared/chat_model.ts`
- `frontend/src/shared/api/types/chat.ts`
- `src/chat/db.py` 镜像
- `tests/config/test_chat_type_mirror_parity.py`

### Agent Spec

- `src/api/routers/agent_runs.py::_assemble_spec`
  - 输出 triggerId/firedAt
- `frontend/src/shared/api/types/chat.ts::AgentRunSpec`
- `frontend/src/ai-gateway/agentRun.ts`
  - 传 Agent Identity 给 System Prompt
- `frontend/src/ai-gateway/systemPrompt.ts`
  - 渲染 trusted agent identity

### Query

- `src/chat/db.py`：统一组合查询
- `src/api/routers/chat.py`：query params/schema
- `frontend/src/ai-gateway/python/domainClient.ts`
- `frontend/src/ai-gateway/tools/sessions.ts`
- `frontend/src/ai-gateway/tools/agents.ts` 或新 `agent_catalog.ts`

### UI

- Agent 主菜单未读 aggregate；
- Agent 行未读数；
- 打开 Session 更新 last_read_at。

## P2：Custom Agent Call

### Schema

- Session additive columns：
  - parent_session_id
  - parent_tool_call_id
  - invoked_by

### Tool

- `frontend/src/ai-gateway/tools/agents.ts`
  - `custom_agent_call`
  - 输入 schema（含审计用 `user_requested`，不含可配置 wait）
  - 固定 180 秒内部等待
  - 动态审批信息
- `frontend/src/ai-gateway/tools/schemas.ts`
- Tool Catalog/i18n/UI registry

### Backend

- 扩展 `src/agents/run_queue.py` enqueue params：
  - invocation instruction
  - context refs
  - parent provenance
- `src/api/routers/agent_runs.py::_assemble_spec`
  - Prompt 加 invocation instruction
  -上下文引用进入受控 envelope
- `frontend/src/electron/main/chat_db/sessions.ts::createAgentSession`
  - parent metadata
- 增加 job poll/wait endpoint 或复用现有 run history

### Result Card

- `CustomAgentCallCard.tsx`
- 状态轮询：queued/running/paused/completed/failed
- 打开子 Session
- 停止子 Run

## P3/P4：Compact

### Gateway

- `frontend/src/ai-gateway/compact.ts`
- `POST /api/ai/compact`
- 复用 `resolveModelFactory`
- tools = none
- effort minimal

### DB

优先复用 `ai_chat_messages`：

- metadata.kind = compact
- 写 ui_message_json
- 如需要索引，可加 `compact_valid` metadata，不先建表

### Context Assembly

- `frontend/src/ai-gateway/chatRun.ts`
  - 在 `convertToModelMessages` 前选择最新 Compact 边界
- 新纯函数：`selectMessagesForModelContext`
- 测试旧消息完整保留、模型只收摘要+最近消息

### UI

- Slash Command `/compact`
- Context Usage Ring 菜单
- Compact Card
- 状态/完成提示
- 自动 Compact 设置

## P5：Follow-up Queue

### DB

建议新表 `chat_queued_input`，见附录 B。

### Gateway

- Queue CRUD endpoint
- ActiveRun 结束后 dispatcher
- idempotent claim
- 启动下一轮
- 重启恢复逻辑
- Stop 时 queued/claimed 恢复为 `restored`，不清空

### Runtime/UI

- 放开 Composer 输入但不直接 send
- 检测 session active → enqueue
- 队列条 UI
- 编辑取回 Composer
- 删除

### 注意

现有 `sendDisabled` 测试要改成：

```text
Run active：普通即时发送禁用
但 Queue enqueue 路径可用
```

## P6：多 Trigger

### Parser

- `src/agents/trigger.py`
  - TriggerV1/TriggerSetV2
  - stable ID validation
  - unknown kind fail-closed
- `frontend/src/shared/api/types/*`
- Config UI schema

### Workers

- Schedule worker 遍历 enabled triggers
- Email dispatch 遍历 email triggers
- enqueue 参数写 trigger_id
- dedupe key
- per-Agent serial queue

### Email Thread

- `EmailFilterTrigger.thread_ids`
- `AgentEmailMatcher` 增加 thread_id 输入
- watcher/dispatch 传递真实 thread_id

## P7：Calendar Trigger

- 复用 `calendar_event` SSoT；
- 新增 diff projector（业务内容 hash 排除纯开始/结束时间变化）；
- 新增 trigger worker；
- Event ID + hash + 60 秒合并窗口；
- 时间变化时重排 before_start；
- 时区和 lead_time；
- Calendar payload 围栏；
- Session trigger provenance。

## P8：Skill Creator

### Builtin Skill

- `src/skills/builtin/skill_creator.py`
- `src/skills/docs/skill_creator/SKILL.md`

### Draft Store

- agent_config DB 增加 skill draft 或使用 quarantine 扩展；
- 生成文件树；
- 静态校验；
- 发布 endpoint；
- UI Draft Drawer。

### Trust

- 扩展 first-run/trust record：package hash + entrypoint policy；
- 设置页展示；
- 版本变化撤销；
- Headless evaluate 加 trust version 条件。

## P9：Agent Plugins

- `src/skills/plugin_import.py`
- plugin.json schema
- ZIP/dir containment
- 组件独立结果
- 导入到 Skill Draft
- 导出 package
- 第三方 NOTICE/License 保留。

## 不应修改的主干

除非某个阶段明确需要，不应重写：

- `auditedWriteTool` 主审批梯；
- Connector invoke service；
- Exec endpoint 安全地板；
- Send Tool 双 guard；
- ActiveRunRegistry 基本语义；
- AI SDK `streamText` 主 Tool Loop；
- Python 邮件同步和 SQLite SSoT。
