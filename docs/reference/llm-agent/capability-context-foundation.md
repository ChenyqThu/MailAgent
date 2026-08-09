# Capability & Context Foundation（Phase -1 / 0A）

> 何时读：动 `src/agent_config/` · `/api/agent/*` · standing-context prompt 组装 · installed skill ·
> @mention 激活 · 配置快照 hash 前。
>
> 状态：2026-06-22 合入 main（task `06-22-harness-agent-polish` Phase -1，原始 9 commit +
> GPT-5.5 review 修复 9 commit）。本文是**运行语义**常青参考；详细设计 SSoT 在任务目录
> `foundation-config-framework.md` + 逐条 review 回应 `phase-0a-review-response.md`（task-local）。

## 目的

eval 评测的不是抽象 agent，而是「某套 **agent profile + active skills + memory + rules 版本**」下的
行为。本子系统把「能力配置面 + 站立上下文」做成稳定底座，让 Phase 0 eval 能记录可复现的
`agent_profile_hash / installed_skills_hash / active_skills_hash` 快照。

## 存储 —— `agent_config.db`（backend-owned，**不进 DB_VERSION**）

镜像 `src/security/api_keys.py` 纪律：per-call 短连接、`CREATE TABLE IF NOT EXISTS`、路径解析
`resolve_agent_config_db_path()`（env `MAILAGENT_AGENT_CONFIG_DB_PATH` → sync_store 同目录 →
DATA_ROOT）、`get_agent_config_store()` lru_cache 单例。**绝不写 `ai_chat.db`**（其 schema owner 是
前端 `chat_db.ts`，BASE-3 不变式：`src/chat/db.py` 0 CREATE TABLE）。

🔴 **权威表清单 = `src/agent_config/store.py` 的 `_DDL`（+ `llm_providers.py` 的独立 DDL），不是本节**。
本文档主题只覆盖 Phase -1/0A 的**初始 4 表**：`agent_skills`（统一
registry：builtin 懒 enable-覆盖行 + installed 全行）· `agent_skill_events`（审计）·
`agent_profile_docs`（SOUL/AGENT/RULES/USER 可编辑；**v1.0.1 起 Settings → AI tab → Custom AI 区有「身份文档」编辑器 `StandingDocsSection`**——查看/编辑全文 + 保存 + per-doc rollback，flag `MAILAGENT_STANDING_DOCS_EDITOR` 默认 on；此前仅 agent `update_system_md` 工具 / `/api/agent/profile/docs` API 改）· `agent_profile_history`（full-snapshot rollback）。
后续批次沿同一开库纪律陆续加表（截至 2026-08-08 全库 16 表），各归其批次文档：`skill_secrets`（S2 skill 供应链，per-skill Fernet secret）· `external_credential`（飞书 IM 等外部凭证）· `policy_rules`（exec/web 白名单，S5 ADR-004）· `owner_settings` / `tool_approval_pref`（审批模式与 per-tool 档）· `connector` / `connector_tool`（MCP connectors，见 mcp-connectors.md）· `agent_skill_draft` / `agent_skill_trust`（P8 Skill Creator，见 ai-sdk-gateway-architecture.md §13.24.9）· `llm_provider` / `llm_model` / `llm_provider_meta`（provider registry，见 llm-provider-registry.md）。

## 模块

- `src/agent_config/store.py` —— `AgentConfigStore`：skill CRUD + profile 文档 seed-on-read/写/history/
  rollback + `profile_hash()` + `installed_rows_fingerprint()`。`resolve_enabled` 三级回退
  `row ?? manifest.default ?? code.default`。
- `src/agent_config/templates.py` —— SOUL/AGENT/RULES/USER seed 模板（SOUL **surface-agnostic**，
  不谎称「正在看某封邮件」）。**AGENT 模板 2026-08-07（harness 优化 P0）已更新为 `plan_update`
  真实用法**（复杂多步任务用 / 单检索总结翻译禁）——此前模板要求调用一个不存在的工具；配套幂等
  迁移只升级**未编辑过**的默认 AGENT 文档（`WHERE content=旧默认逐字`，用户改过一个字都不动），
  见 ai-sdk-gateway-architecture.md §13.24.1。
- `src/agent_config/projections.py` —— MEMORY（复用 `ChatDb.memory_summary`）/ SKILLS 只读投影 +
  `compute_installed_skills_hash` + `skill_overrides_map` + `resolved_skills`（Settings 用）。
- `src/agent_config/validator.py` —— RULES deny-list（**negation-aware**：「禁止无需确认发送」放行）。
- `src/skills/installed.py` —— 安装行 → `BoundSkill` 投影，3 类：document-only / existing-tool（仅
  read，复用 builtin handler，scope⊆granted，须 `bind='existing'`）/ mcp（schema-only `available=false`）。
  **全 `external_exposed=False`**（owner-only，不泄漏给外部 Bearer agent）。merge 进
  `src/skills/registry.all_skills()`（per-call no-cache，多 worker 不陈旧）→ 自动流向 `/api/skills`+MCP。
- `src/api/routers/agent.py` —— `/api/agent/*`（owner-only `verify_cf_access`，不挂 Bearer）：profile
  读/写/history/rollback + skill list/enable/install/uninstall。

## Prompt 组装（前端 `custom_api.buildStableSystemPrompt`）

`MAILAGENT_STANDING_CONTEXT_ENABLED`（默认 ON）→ `PRODUCT_SAFETY_FLOOR`（code-owned TS 常量，**逐字**
取自旧 soul.md 安全块，drift-guard 测试钉死，始终 prepend）+ `standingContext`（backend 组装的
SOUL+AGENT+RULES+USER 单字段，无 per-request 变动字节 → cache 稳定）。OFF / store 故障 → `standingContext=""`
→ 回退旧 `SOUL_MARKDOWN`（字节一致）。`/chat/config.standingContextActive` 可观测哪条路径生效。

## @mention 激活（`src/shared/state/skill-activation.ts`）

按 **scopeKey 分桶**（`email:<id>:<kind>` / `general:<sessionId>`）—— 两 surface 共用一个 runtime，
全局 list 会串味。runtime 不读全局：hook 把当前 scope 激活名经 `ChatStartOpts.activatedSkills` 透传，
`buildEngine` 仅为本回合 scope 折叠 force-on（仍过 `advertised = enabled && available` 闸）。

## /chat/config 新增字段（Phase 0 trace 用）

`agentProfileHash`（4 可编辑文档 content_hash 聚合 sha256）· `installedSkillsHash`（builtin 签名 +
安装行指纹 sha256，**不含 enabled**）· `standingContext` + `standingContextActive` · `skillOverrides`
+ `skillOverridesAvailable`（R6 fail-closed：故障 false → runtime 复用 last-known-good，禁用 skill 不复活）。
`active_skills_hash` **客户端**算（`computeActiveSkillNames` + `sha256Hex`，含 @mention 叠加），经
`active_skills_trace.ts` accessor 暴露给 trace recorder（非 console-only）。

## 安全不变式

agent 不能静默装 skill / 扩 scope / 改 SOUL·AGENT·RULES —— 全 confirmation tier（preview/edit 在
dispatch loop 强制，模型控不了）；installed skill 只能请求既有 `KNOWN_SCOPES`（写时校验）；read-only
Bearer key 不越权（仅 `/api/skills`，且看不到 installed skill）。

## 关键开关

见 CLAUDE.md「关键开关现状」：`MAILAGENT_STANDING_CONTEXT_ENABLED`(默认 ON) /
`MAILAGENT_AGENT_CONFIG_DB_PATH`(路径覆盖)。
