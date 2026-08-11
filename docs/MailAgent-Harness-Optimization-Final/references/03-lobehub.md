# LobeHub 研究：借鉴人工干预与父子运行可见性，不复制平台

## 1. 定位

LobeHub 已构建服务端 Agent Runtime、Operation、Human Intervention、Graph Agent、Agent Group、Workspace 和多种 Connector。

MailAgent 最终决策：

- 不建设 Operation 平台；
- 不引入 GraphAgent；
- 不引入 Agent Group；
- 不复制 Workspace/Project；
- 借鉴等待审批的诚实状态、父子运行关联和结果卡。

## 2. 核心源码

### `packages/agent-runtime/src/agents/GeneralChatAgent.ts`

关键：

- `partitionToolsByAllowList()`
- `checkInterventionNeeded()`
- 静态/动态 Human Intervention；
- 安全 Tool 先执行、需审批 Tool 等待。

MailAgent 对比：

MailAgent 已通过 Tool Class、per-tool tier、ApprovalGuard 和 Context Mode 实现更贴合本地办公的审批。

借鉴：

- `waiting_for_human` 不能报告 completed；
- 未知工具默认更保守；
- 审批策略应结合全局与 Tool 自身。

### `apps/server/src/services/agentRuntime/HumanInterventionHandler.ts`

关键：

- `approve()`
- `reject()`
- `rejectAndContinue()`
- `rejectAndHalt()`

值得借鉴：

- 拒绝后继续与拒绝后停止是不同语义；
- 批量 Tool 审批尚未全部解决时不能恢复模型；
- 状态和消息内容同时更新。

MailAgent 落地：

- 子 Agent 审批仍在子 Session；
- 父结果卡只展示 waiting；
- 过期、拒绝、批准不能混为 completed。

### `packages/database/src/models/agentOperation.ts`

关键：

- `recordStart()`
- `recordCompletion()`
- `findLatestParkedOperationId()`
- `tryResumeFromAsyncTool()`
- 父子 usage 汇总。

MailAgent 不建 Operation 表，但借鉴：

- 父子关系必须持久；
- 恢复需 CAS；
- 重复回调不能双计或双执行；
- 状态投影应从权威 Job 读取。

### `packages/agent-runtime/src/agents/GraphAgent.ts`

值得借鉴：

- 节点有输出 schema；
- 路由状态与执行指令分开；
- 有最大 transition 限制；
- 输出验证失败有重试上限。

MailAgent 落地：

- 复杂办公流程仍写 Prompt；
- 需要确定性时做 Skill；
- 不引入 Graph Runtime。

## 3. 许可证与工程形态

LobeHub 平台代码依赖其内部包、服务端数据库和自定义许可证。MailAgent 应学习设计和测试，不复制受限平台实现。

## 4. 最终借鉴表

| LobeHub 设计 | MailAgent 方案 |
|---|---|
| waiting_for_human | 现有 paused_handoff + Agent Result Card |
| Human intervention branches | 子 Session 明确批准/拒绝/过期 |
| Parent operation | parent_session_id + parent_tool_call_id |
| Async completion | 第一阶段卡片轮询，不自动恢复父模型 |
| Graph typed output | Skill/Prompt 结构化输出，不建 Graph Runtime |
