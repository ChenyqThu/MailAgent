# Craft Agents OSS 研究：借鉴 Source 与执行前检查，不引入 Backend 平台

## 1. 定位

Craft Agents 是桌面 Agent 平台，支持多个 Agent Backend、Workspace Session、Sources、Permissions、Automation 和 Headless Server。

MailAgent 最终决策：

- 不引入 `AgentBackend`；
- 不建设 Workspace/Project；
- 不复制 Craft 平台；
- 借鉴 Source Awareness、PreToolUse 思路、组件级失败隔离和简单 Trigger。

## 2. 核心源码

### `packages/shared/src/agent/base-agent.ts`

关键：

- `BaseAgent`
- `PermissionManager`
- `SourceManager`
- `PromptBuilder`
- `UsageTracker`
- `PrerequisiteManager`

值得借鉴：

- 通用状态与 Provider 逻辑分开；
- Source、权限、使用量和 Prompt 各有职责；
- Source 激活后可重启/重试当前任务。

MailAgent 现状：

- 已有 Tool/Policy/Connector 分层；
- 近期不为代码整齐重构；
- 可把 Agent Catalog、Connector 状态和 Skill 可用性继续做得更明确。

### `packages/shared/src/agent/core/source-manager.ts`

关键：

- `SourceManager`
- `updateActiveState()`
- `formatSourceState()`
- `detectInactiveSourceToolError()`
- `getAuthToolName()`

值得借鉴：

- 区分“用户希望启用”和“实际工具可用”；
- 给模型可执行的修复提示；
- 一个 Source 失败不阻断其他；
- 新 Source 的说明渐进展示。

MailAgent 落地：

- Connector Catalog 继续显示 connected/enabled/tools/needs_auth；
- Agent Plugins 导入时组件级验证；
- Connector 错误继续给用户可执行的 Connectors Console 指引。

### `packages/shared/src/agent/core/pre-tool-use.ts`

关键：

- `runPreToolUseChecks()`
- `shouldPromptInAskMode()`

Pipeline：

1. Permission Mode；
2. Source 是否 active；
3. prerequisite；
4.特殊工具拦截；
5.输入变换；
6.审批判定。

MailAgent 对比：

MailAgent 功能上已具备类似层次，只是分布在：

- Tool assembly；
- `policy.ts`；
- audited wrappers；
- Python endpoints。

最终选择：不做大统一重构，新增功能沿现有层次接入并补测试。

### Automations 与 Session Storage

值得借鉴：

- Trigger/Automation 有稳定 ID；
- Session 状态与附件/计划/长结果明确；
- 配置可校验和 lint；
- 事件与动作分离。

MailAgent 落地：

- Trigger v2 稳定 ID；
- Plan/Compact 作为 Session 可见记录；
- 不建设通用 Automation Action Engine。

## 3. 不适合 MailAgent 的部分

- 多 Backend 抽象；
- Workspace Root/CWD；
- 通用 Bash 与文件权限；
- Session 文件夹模型；
- 大型 Automation 配置；
- Pi subprocess RPC。

## 4. 最终借鉴表

| Craft 设计 | MailAgent 方案 |
|---|---|
| SourceManager | 现有 Connector Catalog 继续强化状态与错误 |
| PreToolUse | 保留现有多层闸，新增能力按同样顺序接入 |
| Component isolation | Agent Plugin 每 Skill 独立验证 |
| Session status | Agent Result Card 与 Job 状态投影 |
| Automation ID | Multi Trigger v2 stable id |
| Config lint | Skill Creator、Trigger 与 Plugin import 校验 |
