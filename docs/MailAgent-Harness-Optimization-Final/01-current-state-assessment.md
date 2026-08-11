# MailAgent 当前情况评估

## 1. 当前定位

MailAgent 已从邮件同步系统演进为一个本地办公 Agent 应用，当前核心由三层组成：

```text
邮件、日历、附件、Notion、KOS、报告与 Connector 领域内核
                      ↓
               AI SDK Gateway
                      ↓
           Electron / Web / 飞书交互面
```

AI SDK Gateway 已是主 Agent Harness。现阶段不需要更换运行时，而应修补长 Session、Agent 委派、多 Trigger 和 Skill 生产体验。

## 2. 已有 Harness 能力

### 2.1 模型与会话

- AI SDK 7 `streamText`；
- 多 Provider 与模型注册表；
- per-turn effort / thinking；
- assistant-ui runtime；
- UIMessage 原生持久化；
- Detached Run；
- ActiveRunRegistry；
- 显式 Stop；
- 后台运行完成后刷新；
- Session 自动标题、置顶、星标、归档和未读。

关键源码：

- `frontend/src/ai-gateway/chatRun.ts`
- `frontend/src/ai-gateway/server.ts`
- `frontend/src/ai-gateway/activeRuns.ts`
- `frontend/src/shared/assistant/runtime/useMailAgentAiSdkRuntime.ts`
- `frontend/src/electron/main/chat_db/`

### 2.2 工具、审批和安全

- 内置邮件、日历、报告、KOS、Web、Exec、Profile、Session、Skill、Custom Agent 工具；
- 工具 class 与运行来源矩阵；
- `auto / ask / off`；
- ApprovalGuard；
- 邮件发送双 Guard 与幂等；
- 外部内容围栏；
- Tool audit；
- Connector 服务端二次授权；
- Skill 供应链与 Exec Gate。

关键源码：

- `frontend/src/ai-gateway/tools/index.ts`
- `frontend/src/ai-gateway/tools/policy.ts`
- `frontend/src/ai-gateway/tools/types.ts`
- `frontend/src/ai-gateway/tools/connector.ts`
- `frontend/src/ai-gateway/tools/exec.ts`
- `src/connectors/service.py`
- `src/api/routers/exec.py`

### 2.3 Custom Agent

当前已经支持：

- `custom_agent_list/get/create/update/delete/run_now`；
- Prompt、模型、enabled、Trigger、能力、Skill、Connector 和预算；
- Cron、结构化 Schedule 与 Email Filter；
- 每次 Headless 运行创建独立 AI SDK Session；
- `origin='agent'`、`agent_id`、`agent_job_id`；
- 最近运行、Session ID、状态、审批和错误；
- 服务端权威 spec 回拉；
- 每 Agent 工具收窄；
- 审批暂停和恢复。

关键源码：

- `frontend/src/ai-gateway/tools/agents.ts`
- `frontend/src/ai-gateway/agentRun.ts`
- `src/api/routers/agent_runs.py`
- `src/agents/trigger.py`
- `src/agents/email_dispatch.py`
- `src/skills/docs/custom_agent/SKILL.md`

### 2.4 Connector 与 Skill

Connector 已支持：

- MCP Streamable HTTP；
- OAuth/凭证；
- 工具 manifest 同步；
- 动态 AI SDK Tool；
- per-tool `auto / ask / off`；
- CRUD ceiling；
- Headless grant；
- 输出截断与 `UNTRUSTED_MCP_TOOL` 围栏。

Skill 已支持：

- builtin 与 third-party Skill；
- Skill 安装、确认、卸载和读取；
- quarantine、安全解压和 hash；
- manifest Secret；
- 脚本完整性与首次运行记录；
- 绝对路径 argv；
- 固定环境变量；
- 无 `shell=True`；
- 结构化 Exec 白名单。

## 3. 已经存在、无需重建的能力

前期方案曾把以下能力列为“大建设项”，但代码核对后应视为已有：

| 能力 | 当前状态 |
|---|---|
| 工具执行时间线 | 已有成熟 ToolTraceCard、耗时、参数、结果和状态 |
| 重复失败纪律 | 已在系统 Prompt 恒注入，尚可补确定性检测但不是从零 |
| Source/Connector Awareness | 已有 Skill/Connector Catalog 与描述 |
| PreToolUse 安全管线 | 分散在装配、wrapper、policy 与 Python endpoint，但功能已存在 |
| Artifact | 已有 report_write、报告存储与 Notion 输出能力 |
| Headless Run Session | 已有 origin/agent/job 回链与历史 UI |
| Custom Agent CRUD | 已有对话式创建、更新和运行 |

因此近期不为了代码“看起来统一”而重构这些路径。

## 4. 真实缺口

### 4.1 Prompt 要求 `plan_update`，工具已经退役

`src/agent_config/templates.py::AGENT_TEMPLATE` 仍要求复杂任务调用 `plan_update`，但 AI SDK Tool Catalog 只把它当旧历史显示名称。模型可能被要求调用不存在的工具。

这是 P0，应该用最小 UI Tool 修复。

### 4.2 Context 只可观察，不能压缩

当前已有 `context_tokens` 和上下文占用环，但没有正式 Compact：

- 无 `/compact`；
- 无摘要边界；
- 无自动 90% 压缩；
- 无 Overflow Recovery。

### 4.3 运行期间完全禁用输入

当前 Composer 在 Run active 时禁止所有发送路径。用户只能 Stop，不能把补充要求排队到当前 Run 之后。

### 4.4 Custom Agent 缺少自然委派接口

`custom_agent_run_now` 只能运行固定 Prompt。主 Agent 尚不能：

- 传一次性 instruction；
- 传结构化上下文引用；
- 短暂等待结果；
- 显示父子结果卡；
- 记录父子 Session 关系。

### 4.5 Custom Agent 身份没有进入模型上下文

服务端和权限系统知道 `agent_id`，但 Headless 模型只收到 `taskPrompt + emailEnvelope`。模型无法可靠表达“查询我自己的历史运行”。

### 4.6 Session 查询缺少组合过滤

已有 FTS 搜索和 `agent_id` 字段，但 Agent 工具还不够方便地按以下维度组合查询：

- agent_id；
- agent_job_id；
- trigger_id / trigger_kind；
- 时间范围；
- origin；
- 运行状态；
- 全文 query。

### 4.7 Trigger 仍是单对象

当前 `trigger_json` 只能表达一个 Trigger，Email Filter 不支持 Thread ID，Calendar 也未纳入 Custom Agent Trigger。

### 4.8 Skill Creator 缺失

MailAgent 能安装 Skill，但没有内建流程把当前 Session 中的成功工作方法转成 Skill 草稿、测试并发布。

### 4.9 外部插件包缺少兼容格式

Agent Plugins 可以作为 Skill 与 MCP 的外部包格式，但当前 MailAgent 没有 importer/exporter。它不影响 Harness 主线，放在最后。

## 5. 风险判断

| 风险 | 处理原则 |
|---|---|
| 大规模 Harness 重构导致审批回退 | 不做 Runtime 抽象，只做局部新增 |
| Compact 丢失事实或副作用 | 完整历史不删；固定摘要结构；保留来源和已执行动作 |
| Steering 与并行 Tool Call 冲突 | 先做 Run 完成后的 Follow-up Queue，不拦截当前 Tool Loop |
| Agent 委派递归和成本失控 | 第一阶段仅人工主 Agent 可调用，Custom Agent 不可调用其他 Agent |
| 多 Trigger 重复运行 | trigger_id + dedupe_key + per-Agent 串行队列 |
| Skill 脚本扩大为任意 Shell | 保持显式 argv、hash、entrypoint 和结构化权限 |
| Agent Plugins 绕过安装与授权 | 仅作为导入格式，仍走现有 Skill/Connector 生命周期 |
