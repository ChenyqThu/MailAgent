# 附录 E：源码索引

> 路径基于 MailAgent `main` 约 2026-08-07 的实现。开发时应重新确认最新位置。

## MailAgent Harness

| 文件 | 关键职责/函数 |
|---|---|
| `frontend/src/ai-gateway/chatRun.ts` | `prepareChatRun`、`streamText` 装配、持久化输入、模型解析 |
| `frontend/src/ai-gateway/server.ts` | Chat、Stop、Active、Agent Run 等 HTTP 路由 |
| `frontend/src/ai-gateway/activeRuns.ts` | `ActiveRunRegistry`、同 Session 并发、Stop |
| `frontend/src/ai-gateway/agentRun.ts` | `runHeadlessAgent`、`agentRunContextFromSpec`、Context Mode |
| `frontend/src/ai-gateway/systemPrompt.ts` | Stable Prompt、执行纪律、Context Block |
| `frontend/src/shared/assistant/runtime/useMailAgentAiSdkRuntime.ts` | assistant-ui transport、Stop side channel |

## Tool 与审批

| 文件 | 关键职责/函数 |
|---|---|
| `frontend/src/ai-gateway/tools/index.ts` | `buildGatewayTools` |
| `frontend/src/ai-gateway/tools/policy.ts` | Tool Class、Context Mode、动态工具分类 |
| `frontend/src/ai-gateway/tools/types.ts` | `auditedReadTool`、`auditedWriteTool`、needsApproval |
| `frontend/src/ai-gateway/tools/agents.ts` | Custom Agent CRUD/Run |
| `frontend/src/ai-gateway/tools/sessions.ts` | Session list/search/get |
| `frontend/src/ai-gateway/tools/connector.ts` | manifest、动态工具、fence、grant |
| `frontend/src/ai-gateway/tools/exec.ts` | run_command/file tools 与 policy evaluate |
| `frontend/src/ai-gateway/tools/skill_supply.ts` | Skill fetch/confirm/read/uninstall |

## UI

| 文件 | 职责 |
|---|---|
| `frontend/src/shared/assistant/tools/generic/ToolTraceCard.tsx` | 通用 Tool 过程卡 |
| `frontend/src/shared/assistant/tools/registerToolUIs.tsx` | Tool UI 注册 |
| `frontend/src/shared/components/chat/tool_steps.ts` | Tool 标题和分类 |
| `frontend/src/shared/assistant/components/ContextUsageRing.tsx` | Context 占用与详情 |
| `frontend/src/shared/assistant/components/ThreadRunStatusBar.tsx` | 后台运行状态 |
| `frontend/src/shared/components/agents/*` | Agent 列表、会话、配置抽屉 |

## Chat DB

| 文件 | 职责 |
|---|---|
| `frontend/src/electron/main/chat_db/connection.ts` | Schema version 与 migrations |
| `frontend/src/electron/main/chat_db/sessions.ts` | Session CRUD、createAgentSession |
| `frontend/src/shared/chat_model.ts` | Electron 侧类型 |
| `frontend/src/shared/api/types/chat.ts` | API/Renderer 类型镜像 |
| `src/chat/db.py` | Serve API 对 ai_chat.db 的镜像读写与 FTS |
| `src/api/routers/chat.py` | Session API |

## Custom Agent Backend

| 文件 | 职责 |
|---|---|
| `src/api/routers/agent_runs.py` | `_assemble_spec`、spec CAS、approval state |
| `src/agents/trigger.py` | Trigger、Budget、Tool Policy 解析 |
| `src/agents/email_dispatch.py` | Email Trigger 入队 |
| `src/agents/matcher.py` | `AgentEmailMatcher` |
| `src/agents/run_queue.py` | Agent Run enqueue/dedupe |
| `src/skills/docs/custom_agent/SKILL.md` | 对话式 Agent Builder 约定 |
| `src/skills/builtin/custom_agent.py` | 内建 Prompt fragment |

## Connector 与 Exec

| 文件 | 职责 |
|---|---|
| `src/connectors/service.py` | Connector 调用单源闸与执行 |
| `src/api/routers/connector.py` | Connector HTTP API |
| `src/api/routers/exec.py` | Exec endpoint、固定 env、Skill gate |
| `src/skills/exec_gate.py` | Skill 脚本 probe/hash/首次运行 |
| `src/agent_config/tool_prefs.py` | per-tool tier |
| `src/agent_config/policy.py` | 结构化 allow rules |

## Pi Mono

| 文件 | 借鉴点 |
|---|---|
| `packages/agent/src/agent.ts` | `steer`、`followUp`、`transformContext` |
| `packages/agent/src/types.ts` | Agent Message/Event/Tool 类型 |
| Coding Agent Session docs/source | Tree、Fork、Compaction |

## Craft Agents OSS

| 文件 | 借鉴点 |
|---|---|
| `packages/shared/src/agent/base-agent.ts` | 公共 Agent 服务组织 |
| `packages/shared/src/agent/core/source-manager.ts` | Source 状态与修复提示 |
| `packages/shared/src/agent/core/pre-tool-use.ts` | 执行前检查顺序 |
| `packages/shared/src/sessions/storage.ts` | Session 文件与状态 |
| `apps/electron/resources/docs/automations.md` | Trigger/Automation 配置 |

## LobeHub

| 文件 | 借鉴点 |
|---|---|
| `packages/agent-runtime/src/agents/GeneralChatAgent.ts` | Tool intervention 分流 |
| `apps/server/src/services/agentRuntime/HumanInterventionHandler.ts` | 批准/拒绝/继续 |
| `packages/database/src/models/agentOperation.ts` | 父子运行、CAS 恢复 |
| `packages/agent-runtime/src/agents/GraphAgent.ts` | Typed output 和边界限制 |

## Anthropic Skills

| 文件 | 借鉴点 |
|---|---|
| `anthropics/skills/skills/skill-creator/SKILL.md` | Skill 创建与评测流程 |
| `anthropics/skills/skills/skill-creator/LICENSE.txt` | Apache 2.0 许可 |
