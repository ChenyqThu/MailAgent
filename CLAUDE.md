# CLAUDE.md

为 Claude Code 提供的项目指南。

> **本文件是精简索引** —— 只保留每个 session 必须在场的核心约束、导航、速查。
> 深度内容（架构内核、各子系统运维、CLI 全表）按需下沉到 `docs/reference/<子系统>/`，
> 需要时用「文档地图」里的指针去 `Read`，不要全量塞进 context。
> 改完某子系统的运行语义后，同步更新它在 `docs/reference/` 的常青文档，别把流水账堆回这里。
>
> **文档规范** → [`docs/DOC-GUIDE.md`](./docs/DOC-GUIDE.md)：常青参考进 `docs/reference/`，过程产物（handoff/complete/phaseN/prN）进 `docs/archive/{年-月}/`；**新增常青文档必须在下面「文档地图」加一行**，否则无人发现。

## 通用指南

- 被要求做具体修改时，直接动手。不要花大量时间读文件或反复确认简单任务，偏向行动。
- macOS 环境下 **没有 sudo**，不要尝试 sudo 命令。
- 不要在嵌套 session 中做 CLI 更新或全局变更。
- 遇到环境问题时，优先检查已知的 macOS 限制（FDA 权限、symlink、沙盒）再尝试修复。

## 文档地图（渐进式加载索引）

| 主题 | 何时读 | 路径 |
|---|---|---|
| 架构内核（v3 流程 / 重试 / Processing Status / webhook / 线程 / Sprint15 outbox / Sprint16 dual-backend） | 改正/反向 sync、webhook、状态机前 | [`architecture/architecture-internals.md`](./docs/reference/architecture/architecture-internals.md) |
| DavMail 写路径 trace + Notion 反向链路(B1) 退役决策依据（写op×路径 / B1 现状 / outbox 灰度死分支 / AppleScript fallback 链） | 退役 Notion 反向链路 / 清 outbox 死分支 / 动 reverse_sync·handlers 前 | [`architecture/davmail-write-path-trace.md`](./docs/reference/architecture/davmail-write-path-trace.md) |
| **架构整体 Review 2026-07 + E0-E4 收敛路线**（P0=CI 测试闸/数据安全网；P1=半程迁移收口：Backend 契约/减法 Sprint/配置治理/可靠性；EWS=跟随 davmail 上游零工程，仅留 watch 项） | 启动 E0-E4 任一收敛 epic / 排架构债优先级前 | [`architecture-review-2026-07/README.md`](./docs/plans/architecture-review-2026-07/README.md)（docs/plans，含 e0-e4 五份实施方案） |
| LLM Agent（本地 LLM 分类，fallback / cache / 监控 / payload） | 改邮件分类、prompt、cache 前 | [`llm-agent/llm-agent.md`](./docs/reference/llm-agent/llm-agent.md) + [`llm-agent/LLM_AGENT_SETUP.md`](./docs/reference/llm-agent/LLM_AGENT_SETUP.md) |
| 项目周报同步（外挂模块，xlsx → Notion） | 动 `src/project_progress/` 前 | [`project-progress/project-progress-sync.md`](./docs/reference/project-progress/project-progress-sync.md) |
| 报告 Agent 系统（日/周/月报，ReportDoc 块模型 + 定时生成 + 前端渲染 + KOS 工具桥） | 动 `src/reports/` / 报告 / Custom AI Agents 区前 | [`remote-chat-report/report-agent-prd.md`](./docs/reference/remote-chat-report/report-agent-prd.md) |
| Calendar Module（CalDAV → SQLite SSoT） | 动日历同步 / `calendar_event` 表前 | [`calendar/calendar-ops.md`](./docs/reference/calendar/calendar-ops.md) + [`calendar/calendar-module-prd.md`](./docs/reference/calendar/calendar-module-prd.md) |
| v4 SQLite-SSoT（body/附件 SSoT + FTS5 全文搜索） | 动 `EmailRepository` / 双写 / 搜索前 | [`architecture/v4-ssot-ops.md`](./docs/reference/architecture/v4-ssot-ops.md) + [`architecture/architecture_v4_sqlite_ssot.md`](./docs/reference/architecture/architecture_v4_sqlite_ssot.md) |
| 后端服务层（统一写面：`src/services/` 应用服务 + CLI/serve-api 薄适配器 in-process + async-jobs + 双层鉴权 + 前端 daemon 转发） | 改写操作（flag/resync/archive/pin/llm/compose/send）/ 加传输端 / 动 `src/services/` 前 | [`architecture/service-layer-architecture.md`](./docs/reference/architecture/service-layer-architecture.md) + `~/.claude/plans/cli-streamed-brook.md` |
| AI Agent Harness + KOS（前端 chat 多轮 agent + 跨域知识图；**S3 起 AI SDK Gateway 是唯一引擎，旧自研 harness 已删除**） | 动前端 chat / gateway / KOS 集成前 | [`llm-agent/ai-sdk-gateway-architecture.md`](./docs/reference/llm-agent/ai-sdk-gateway-architecture.md)（**唯一引擎权威**：embedded gateway / 工具 / HITL 审批 / A2UI / memory / standing-context / serve-api 代理，§13）+ [`llm-agent/kos-integration-design.md`](./docs/reference/llm-agent/kos-integration-design.md) |
| Skill Delivery API（对外 agent 交付面：scoped Bearer key 第四腿 + Python Skill manifest + `/api/skills(+invoke)` + MCP stdio + skill pack） | 动 scoped key / `src/skills` / `/api/skills` / MCP / pack 前 | [`llm-agent/skill-delivery-api.md`](./docs/reference/llm-agent/skill-delivery-api.md) |
| Capability & Context Foundation（Phase -1/0A：backend `agent_config.db` + Standing Context 文档体系 + installed skill registry + @mention scope 激活 + 配置快照 hash） | 动 `src/agent_config` / `/api/agent/*` / standing-context prompt / installed skill / @mention 前 | [`llm-agent/capability-context-foundation.md`](./docs/reference/llm-agent/capability-context-foundation.md) |
| V2.1 远程 chat + report/agent（B-pure-unified 传输层；一份 serve-api；本地 token webRequest / 远程 CF cookie；chat 引擎 = embedded AI SDK Gateway（Electron main 进程内，S3 起唯一引擎，旧 `shared/chat` 已删）；远程 web 经 serve-api `ai_gateway_proxy`(httpx stream 反代) → loopback gateway:8300，恒 ai-sdk、无 flag） | 动远程 web chat / serve-api chat 端点 / chat 引擎语义前 | [`remote-chat-report/remote-chat-report-architecture.md`](./docs/reference/remote-chat-report/remote-chat-report-architecture.md) + [设计](./docs/reference/remote-chat-report/v2.1-stage3-chat-platform-design.md) + [看板](./docs/reference/remote-chat-report/v2.1-remote-chat-report-matrix.md) |
| **Agent 体验大版本专项**（P0-P4 换引擎 **✅ cutover v0.20.0**；mem0 记忆核心重构 **M1-M5 ✅ + web→ai-sdk(任务A) ✅ + Settings 身份文档编辑器 ✅**（M1-M4 随 **v1.0.1**；M5b[agent_memory_kv 退役] + 4 flag cutover 默认 ON 随 **v1.1.0**）；**任务B[删 legacy harness] ✅**（S3，见 `07-02-s3-remove-legacy-harness` task）；P0-P4 过程档已归 `docs/archive/2026-06/`，M1-M5 计划档已归 `docs/archive/2026-07/agent-experience-epic/`） | 理解 mem0 记忆演进史 / 跑 agent 回归网前 | 引擎架构 [`llm-agent/ai-sdk-gateway-architecture.md`](./docs/reference/llm-agent/ai-sdk-gateway-architecture.md) §13.18 + M1-M5 计划（已归档）[`memory-skill-core-refactor.md`](./docs/archive/2026-07/agent-experience-epic/memory-skill-core-refactor.md) + 回归网 `tests/agent_eval/` |
| CLI 完整命令表 + 退出码 + schema 契约 | 查命令明细 / 加 CLI 命令前 | [`cli/cli-reference.md`](./docs/reference/cli/cli-reference.md) + [`cli/agent-cli-rfc.md`](./docs/reference/cli/agent-cli-rfc.md) |
| 存档/草稿箱 + 多文件夹同步（folder_sync） | 动 folder 同步前 | [`folder-sync/multi-folder-sync-design.md`](./docs/reference/folder-sync/multi-folder-sync-design.md) + [`folder-sync/folder-ui-prd.md`](./docs/reference/folder-sync/folder-ui-prd.md) |
| Webhook / SSE / Openclaw / Notion API（集成面） | 动 webhook-server / 事件流 / 飞书回调前 | [`integrations/`](./docs/reference/integrations/) |
| 邮件搜索（**单核 CORE#1** + Query DSL + 多模式 FTS5 + agentic AI 搜索） | 改搜索语法 / 检索引擎 / agentic 前 | [`search/search-query-syntax.md`](./docs/reference/search/search-query-syntax.md) |
| 灵动岛 Ping Island 集成 | 动通知/ack 中心前 | `~/.claude/plans/ultrathink-session-curious-cloud.md` |
| 前端动效 + 列表性能铁律（Electron renderer：GSAP §8 动效 / snippet 懒取 / 线程批量 / 查询缓存 / 正文 iframe 链接） | 动前端列表/正文/动效前 | [`frontend/ARCHITECTURE.md`](./frontend/ARCHITECTURE.md) §7.1-7.2 + [`frontend/docs/motion-gsap.md`](./frontend/docs/motion-gsap.md) |
| 桌面 App 打包 / 发布（一体化 .app + 版本号机制 + 签名闸 + 故障排查） | 出新版 / 发布 App 前 | [`packaging/packaging-release.md`](./docs/reference/packaging/packaging-release.md) |

技能（按需触发，正文不常驻）：`/deploy`（部署验证）、`/debug`（系统化排查）、`/health`（健康巡检）、`/db-migration`（schema 升级）、`/sprint-handoff`（交接文档）。

## 项目概述

**MailAgent** 是一个 macOS 邮件实时同步系统，将 Mail.app / Outlook 邮件同步到 Notion，支持：
- 邮件内容、附件、线程关系同步 + 会议邀请（iCalendar）→ 日程
- AI 分类与处理（本地 LLM / Notion Custom Agent）
- 双向 Flag 同步（Mail.app ↔ Notion，Sprint 15 起统一走 outbox + FanoutWorker 异步派发）
- 飞书应用机器人通知（重要邮件推送 + 交互式回复按钮 → Openclaw）
- Notion Webhook → Redis → Mail.app 实时事件驱动
- Office 附件自动转换（docx/pptx→PDF, xlsx→CSV）

**当前架构状态**（演进叠加，详见 [`docs/reference/architecture/architecture-internals.md`](./docs/reference/architecture/architecture-internals.md)）：
- **v3 SQLite-First**（2026-01）：`internal_id`（ROWID = AppleScript id）主键，`whose id is <int>` 查询比旧方式快 127 倍，支持 6-7 万封大邮箱。
- **Sprint 15 SQLite SSoT inversion**（2026-05）：所有 mutating 操作反转方向，SQLite 是写入 intent 聚合点，FanoutWorker 异步派发到 Mail.app + Notion，统一走 `email_outbox`（E2 2026-07 起 outbox **恒启用**，灰度开关 `MAILAGENT_OUTBOX_ENABLED` 与老直调分支已退役；三处 flag→outbox 入队归一 `src/sync/outbox_intents.py`）。
- **Sprint 16 Dual-Backend**（2026-05-22 cutover）：抽象 `IMailBackend` Protocol，**davmail 模式为当前主路径**（IMAP/SMTP/CalDAV 桥 EWS），AppleScript 保留作 emergency fallback。
- **v4 SQLite-SSoT**（2026-05，Phase 1-4 已上线/灰度）：SQLite 是邮件正文 + 附件的 SSoT，Notion 退化为镜像，FTS5 全文搜索就位。

**死硬约束**：
- DavMail 当前用 Outlook for Windows well-known client_id 伪装（PoC），**不可上生产** —— 需走公司 IT 审批（推荐直接申请 Graph API）。
- EWS 2026-10-01 关停，DavMail 6.7 仍走 EWS，Graph 路线图（Issue #404）未 merge —— 见 [`docs/reference/architecture/roadmap-post-cutover.md`](./docs/reference/architecture/roadmap-post-cutover.md) §5.1。
- AppleScript fallback 路径**始终可用** —— 任何重构都必须保证 emergency 回切不丢数据（回切步骤见 architecture-internals.md）。

**技术栈**：Python ≥3.9（本地 3.11+，远程 webhook-server 3.9+）· AppleScript（fallback）· DavMail 6.7 JVM（主路径）· SQLite（状态 + v4 SSoT + FTS5）· Notion API · BeautifulSoup/lxml · Pydantic · Redis · FastAPI · LibreOffice headless · pandas + python-calamine。

## 关键开关现状（代码默认值；★ = 生产已偏离默认）

| 开关 | 代码默认 | 说明 |
|---|---|---|
| `MAILAGENT_BACKEND` | `applescript` | ★ 生产 = `davmail`（Sprint 16 cutover 后） |
| `DRAFTS_SYNC_ENABLED` | `true` | 草稿箱同步（davmail-only）：Exchange Drafts 全量 UID 对账进 `email_metadata`（mailbox='草稿箱'，编辑/发送/删除会同步删本地行），仅本地（列表/数量/正文/FTS），不进 Notion / LLM / 飞书 / KOS / 报告 |
| `BODY_DUAL_WRITE_ENABLED` | `true` | v4 双写总开关；失败仅 warning 不阻断 |
| `NOTION_READ_FROM_SQLITE` | `true` | v4 Phase 4；2026-07-11 生产观察窗口拍板（07-05~07-11 263 hit / 0 fallback_miss / 0 fallback_error）默认翻 true，sync/resync 走 SQLite SSoT，miss fallback 老路径；`.env` 显式 false 应急回退 |
| `SEARCH_TRIGRAM_ENABLED` | `true` | 中文子串全文检索（并行 trigram FTS5 表路由）；Phase A 起默认开，设 false 则 CJK 搜索退回 unicode61 + smart 字符级 fallback。详见 search-query-syntax.md §9 |
| `LLM_AGENT_ENABLED` | `false` | 本地 LLM 分类总开关（启用前必看 llm-agent.md 防双跑）；模型/fallback 支持预处理 Agent 行级覆写（`report_agent.model` / `fallback_models_json`，空/NULL=跟随全局 `LLM_MODEL` / `LLM_FALLBACK_MODELS`，保存即生效） |
| `CALENDAR_CALDAV_SYNC_ENABLED` | `false` | CalendarSyncWorker 总开关 |
| `SYNC_FOLDERS` | `[]`（空） | 多文件夹同步白名单（JSON 数组的 imap_name，davmail-only）；空=零激活=逐字节同现状；勾选的自定义 Exchange 文件夹走 `email_metadata` 主链路（AI/Notion/FTS/线程/写操作全等同收件箱）。配套 `FOLDER_NOTIFY_ENABLED`（自定义文件夹默认不推飞书，JSON 白名单 opt-in）/ `FOLDER_LLM_DISABLED`（默认全跑 LLM，JSON 黑名单可关）/ `FOLDER_SYNC_PAST_DAYS`(90) / `FOLDER_SYNC_MAX_MESSAGES`(2000)。详见 architecture-internals.md「多文件夹同步」 |
| `PROJECT_PROGRESS_SYNC_ENABLED` | `false` | 项目周报 CLI + 钩子**总闸**（env 权威，镜像 `LLM_AGENT_ENABLED`）。S5 W5a 起项目周报迁进 custom agent 框架的**专型行**（`type='project_progress'` 单例，**DB v31** seed）：trigger 配置（sender/subject）从 env 搬进**行内热读**（new_watcher hook 1 每封裸 sqlite3 读行→重建 `ProjectProgressDetector`，Settings 可编辑），env 值仅作首次 seed 默认、行落地后**行权威**；`_DATABASE_ID`/`_FILTER_BU` 仍 env 权威（v1.3.x dogfood 批起在 agent 抽屉可编辑，env PATCH+重启生效；Settings→集成 旧配置区已移除）。执行历史：`GET /api/project-progress/runs` + 抽屉「执行历史」section。runner/xlsx/detector 逐字不变、执行仍 Python 直调不进 gateway（确定性 ETL 不塞 LLM loop）。详见 project-progress-sync.md |
| `MAILAGENT_STANDING_CONTEXT_ENABLED` | `true` | Standing Context 分层 prompt（不可弱化 `PRODUCT_SAFETY_FLOOR` + `SOUL/AGENT/RULES/USER` 由 backend `agent_config.db` 组装）；**默认 ON**，OFF 回退旧 `SOUL_MARKDOWN`（字节一致，应急回切）。`standingContextActive` 在 /chat/config 可观测。详见 capability-context-foundation.md |
| `MAILAGENT_AGENT_CONFIG_DB_PATH` | —（空） | backend-owned `agent_config.db` 路径覆盖（默认 sync_store 同目录）；不进 `DB_VERSION`，镜像 api_keys 纪律 |
| `MAILAGENT_MEM0_CAPTURE` / `_RETRIEVAL` / `MAILAGENT_USER_MD_COMPILE` / `MEMORY_MD_BUDGET_CHARS`(5000) / `MEMORY_CAPTURE_MODEL`(haiku) | `true`（前 3，2026-07-02 cutover） | **memory.md 记忆 epic**（07-01 Hermes 式有界记忆重定型，前 3 默认开 —— 2026-07-02 cutover，env 显式 false 应急回退）：CAPTURE=chat turn 完成 onFinish 后台把持久偏好/事实**合并进有界 memory.md**（agent_config.db 的 MEMORY doc，去重 + 超 `MEMORY_MD_BUDGET_CHARS` 写入时同 haiku 淘汰）；RETRIEVAL=**恒注入 memory.md**（经 /chat/config `memorySummary` → MEMORY fence untrusted 背景，读侧再 clamp 到预算；**非**旧 M2 query 召回）；USER_MD_COMPILE=Settings 手动从 memory.md 编译偏好合并进 `user.md`（恒注入身份文档，before/after diff + rollback）；`MEMORY_CAPTURE_MODEL`=合并/淘汰模型（默认 haiku，Settings「记忆抽取模型」下拉可设）。CAPTURE 由 Node gateway env 读；RETRIEVAL 由 serve-api /chat/config 热读 .env（即时）；USER_MD_COMPILE / `MEMORY_MD_BUDGET_CHARS` / `MEMORY_CAPTURE_MODEL` 由 config.py pydantic（翻需重启 serve-api）。详见 [`agent-experience-epic/memory-skill-core-refactor.md`](./docs/archive/2026-07/agent-experience-epic/memory-skill-core-refactor.md)（已归档存史） |
| `MAILAGENT_SKILL_SELF_MOUNT` | `true` | mem0/skill epic **M4a**（gateway skill→tool 门控，纯后端 main env，**不加 vite define**；默认开 —— 2026-07-02 cutover，env 显式 false 应急回退）：on 时 embedded AI SDK Gateway 工具注册受 skill 启用态驱动——关掉某 skill 其读工具不再注册给模型（收 cutover 后「关了 skill 工具仍可调」真 bug）。Python `/chat/config.advertisedSkills`（业务态）+ Node `applySkillGating`（工具集结构）。范围 = email/search/report 读工具；`email_search`(collision-exempt) + kos/memory/write/send(core) 永不门控。off → gateway ToolSet 字节级同 cutover（/chat/config 字段恒发、值可 null）。M4b(update_system_md 全文人审 edit-tier)/M4c(discover_skills+set_skill_enabled) 已落地，且 flag 还门控这 3 个自挂载工具（off 不注册）；含 codex HIGH-1 审批 guard 收紧（approval.verify 对所有 tier 拒 raw-changed input，identity 不可 retarget）。详见同 epic 计划档 |
| `MAILAGENT_STANDING_DOCS_EDITOR` | `true` | mem0/skill epic 收尾（2026-06-30，随 v1.0.1）：Settings「身份文档」编辑器（AI tab → Custom AI 区，`StandingDocsSection`）显隐开关。on（默认）→ `/chat/config.standingDocsEditorEnabled=true` → owner 可在设置里查看/编辑 **SOUL/AGENT/RULES/USER** 全文 + 保存（`setProfileDoc` updatedBy='user'）+ 每文档 history/rollback；RULES 经 `validate_rules_content` 拒越权、空内容后端拒（防搞坏恒注入身份文档）、SOUL/AGENT/RULES 高危红样式。off → section 字节级不渲染（编辑仍可经 agent `update_system_md` 工具 / `/api/agent/profile/docs` API）。Python pydantic（翻需重启 serve-api）。 |
| `MAILAGENT_KOS_INGEST_ENABLED` / `_CONSUMER_ENABLED` / `_L1_HOT_BLOCK_ENABLED` | `false` | KOS 集成三层，全默认 OFF |
| `MAILAGENT_REPORT_AGENT_ENABLED` | `false` | 报告 Agent worker（日/周/月报，`src/reports`）；per-agent 还需 `report_agent.enabled`（种子 daily 默认关） |
| `MAILAGENT_ISLAND_AGENT_ENABLED` | `true` | **默认开（E3 cutover 2026-07-06，owner 终拍；见 [决策表](docs/plans/architecture-review-2026-07/e3-defaults-decision-table.md)）；无岛（Ping Island 未装/未跑）= announce 静默 fail-open（有单测），env 显式 false 应急回退**。harness 审批上灵动岛（Part B，v1.2.0）：gateway 审批暂停时 stash+announce 岛卡（与 R2#3 redacted persist 共存），岛点批准 → serve-api `POST /api/island/ack`(kind=agent) → gateway `/api/ai/approval/decide` 服务端 resume（chat 面板关着也能批+真执行）；resume 终态回推面板 live-refresh。main-env-only（lifecycle `envBool` 读，**无 vite define**）；Python 侧 `island_agent_enabled` 用 validation_alias。off = 字节级 inert。Part A 解耦 ack 通道（`island_ack` SQLite 单次消费 + §9 幂等/dedup/re-check）不受此 flag 门控。设计档 `docs/plans/agent-experience-epic/harness-island-integration-design.md` |
| `MAILAGENT_OPENNESS_SESSION_TOOLS` / `_CONFIG_TOOLS` / `_WEB_TOOLS` | `true` | **默认开（E3 cutover 2026-07-06，见 [决策表](docs/plans/architecture-review-2026-07/e3-defaults-decision-table.md)）；env 显式 false 应急回退 → `buildGatewayTools` 字节级回退**。Agent 开放性 epic **S1**（task 07-02）：flag-gated 分面把「已在位未暴露的读能力 + 联网」接成 gateway 工具；main-env-only **不加 vite define**，off → `buildGatewayTools` 字节级不变（有测试断言）。SESSION=会话检索 3 读工具（`chat_session_list/search/get`；ai_chat.db 新增 FTS5 trigram `ai_chat_messages_fts`，**CHAT_DB_VERSION 16→17**；返回恒 `UNTRUSTED_CHAT_HISTORY` 围栏——历史会话含邮件引用=二阶注入面）· CONFIG=配置读补全 4 工具（`agent_profile_read/history`[silent]+`agent_profile_restore`[edit 恒人审]+`agent_memory_update`[edit 恒人审]；memory 读恒 `UNTRUSTED_MEMORY` 围栏；rollback 路径补 `validate_rules_content` 闸防越权 RULES 历史版本复活）· WEB=联网 2 工具（`web_fetch/web_search`，**manual edit 恒人审不进 auto-approve**；TS 薄壳 → Python `src/api/routers/web.py` 执行；SSRF 防护=逐 IP `not is_global`+钉 IP 防 rebinding+逐跳 redirect 重校验+`Accept-Encoding: identity` 防解压炸弹+size/time cap；返回恒 `UNTRUSTED_WEB_CONTENT` 围栏；**S6 起 class outbound→web 迁移，custom agent headless 经 `grant_web` 三档赋权[off/gated 域名白名单免卡/open 全开放]，manual 恒人审不变，§13.21**）。9 新工具全 `CORE_UNGATED`（开关权在 flag 非 skill 门控）+ 入 `tool_catalog.json`（R4 完整性闸守）。详见 `.trellis/tasks/07-02-s1-openness-wave1/` |
| `MAILAGENT_OPENNESS_EXEC_TOOLS` / `_SKILL_INSTALL` | `true` | **默认开（E3 cutover 2026-07-06，见 [决策表](docs/plans/architecture-review-2026-07/e3-defaults-decision-table.md)）；env 显式 false 应急回退**。安全地板不变：exec 无白名单命中恒 HITL、skill 安装 capability_change 恒 HITL。Agent 开放性 epic **S2**（task 07-02，两份 frozen ADR）：本机执行 + skill 供应链自装。EXEC=3 工具（`run_command/file_read/file_write`，**edit-tier + tool_class=exec = manual_chat 专属恒人审**；执行权威 Python `/api/exec/*`[仅本地 token]：无 shell 显式 argv + 固定 env 白名单绝不继承全局密钥 + inode 级 deny 地板；免卡仅经 owner **结构化白名单** `policy_rules`——审批卡「总是允许」全 PIN 派生或 Settings，模型零建规则通道，ask/异常/超时 fail-closed 弹卡，免卡 audit `approval_status='auto_whitelist'`+`whitelist_rule_id`，**CHAT_DB_VERSION 17→18**）· SKILL_INSTALL=4 工具（`skill_install/skill_install_confirm`[两段两卡]+`skill_uninstall`+`skill_read`，前三 **edit-tier + tool_class=capability_change 恒 HITL**；供应链 = SSRF 硬化下载→quarantine 安全解包→manifest v2[script⇒零工具]→逐文件 sha256→**confirm re-hash TOCTOU 比对**→atomic promote；confirm 审批卡按 quarantineId **服务端事实渲染**；skill 脚本执行期逐文件 hash 校验 + **首跑闸**[绑 version+entrypoint hash，判定在白名单 auto_allow 之前，盲区形状恒 ask]；per-skill secret = Fernet+Keychain master key，注入恒 declared∩stored + 输出脱敏；三方 skill 文本恒 `UNTRUSTED_SKILL_DOC` 围栏+32KB）+ Settings 安装/配置/卸载 UI（`/chat/config.skillInstallEnabled` 显隐）。均 main-env-only 无 vite define，off → gateway 工具集字节级不变。详见 `.trellis/tasks/07-02-s2-exec-skill-install/` + architecture §13.17 |
| `MAILAGENT_CUSTOM_AGENTS_ENABLED` | `true` | **默认开（E3 cutover 2026-07-06，见 [决策表](docs/plans/architecture-review-2026-07/e3-defaults-decision-table.md)）；env 显式 false 应急回退 → hook/worker/端点/CRUD 工具全灭字节级回 S4 前**。per-agent 仍需 report_agent.enabled + type='custom' 才激活（on 不配 grant/规则 = 恒 HITL）。Agent 开放性 epic **S4 内核 + S5 产品化**（task 07-02）。**S4 内核**：`report_agent` 泛化 type='custom'（**DB v30** trigger_json/tool_policy_json/budget_json），cron(croniter UTC marker)/email_filter(new_watcher 第 5 hook) 触发 → async_jobs(两族分区) → AgentRunWorker poke → gateway `POST /api/ai/agent-run` headless 路径 C（spec CAS one-shot + contextMode 从 trigger.kind 派生 + 矩阵地板 + allowed_tools 交集只减不加 + budget 三维 + session origin='agent' **CHAT_DB v19**）；**`status=succeeded && outcome='paused_handoff'` 永不渲染为成功**（读态唯一入口 `src/agents/run_state.py::derive_agent_run_state`）；app 关=全停，cron 重启单次 catch-up。**S5 产品化**（ADR-004）：Settings 全字段建/改/看 custom agent + run 历史 8 值域 + 对话式 CRUD 六工具（`custom_agent_*`，全 tool_class=capability_change 恒人审、headless 注册期缺席，catalog **42**）；per-agent「全自动」= 独立白名单（domain_write policyEvaluate headless-only 注入 + exec 显式修订矩阵 `AgentModeGrants{exec?}` 仅 exec 键 + pinned-entrypoint 唯一形状 + policy_rules `context_mode+agent_id` 双键与全局 manual 物理隔离 + 免卡审计 `auto_whitelist`）；custom agent `allowed_tools` NULL 语义修订为「默认安全集」；三案例迁框架（preprocess 定性/项目周报专型行 **DB v31**/DMS 两级形态）。per-agent exec 免卡额外叠加依赖 `MAILAGENT_OPENNESS_EXEC_TOOLS`。off → hook/worker/REST custom 分支/run 历史端点/岛结果通知/CRUD 六工具/Settings 入口全灭，ToolSet 字节级回 S4 前终态；**on 不配 grant/规则 = 恒 HITL**（per-agent opt-in = 天然开关）。**S6**：每次执行输入输出经执行记录反查（打开该 run 的 `origin='agent'` session，read-mostly composer 禁用）+ in-app 审批红点链四层（run 行→卡 badge→区 dot→TitleBar，pending 真值 = live 查 gateway `ApprovalRunStash` miss 404、token 不出 gateway）+ per-agent web grant 三态（off/gated 域名白名单/open 全开放，web 存在性叠加 `MAILAGENT_OPENNESS_WEB_TOOLS`）与 skill 挂载与 CRUD 三键全字段（恒人审 custom-agent 卡 + before/after diff）。详见 ai-sdk-gateway-architecture.md §13.19（S4）+ §13.20（S5）+ §13.21（S6） |
| `FEISHU_NOTIFY_ENABLED` / `REDIS_EVENTS_ENABLED` / `ALERT_ENABLED` | `false` | 通知 / 事件消费 / 告警 |

完整配置（必填 + 全部可调项）见 [`.env.example`](./.env.example)（380 行）。必填 5 项：`NOTION_TOKEN` / `EMAIL_DATABASE_ID` / `CALENDAR_DATABASE_ID` / `USER_EMAIL` / `MAIL_ACCOUNT_NAME`。

## 命令速查

```bash
# 环境
source venv/bin/activate
pip install -e ".[cli,dev]"             # 装 mailagent CLI

# 运行服务
python3 main.py                          # 前台
pm2 start main.py --name mail-sync --interpreter ./venv/bin/python3  # PM2（必须用 venv python）
pm2 restart mail-sync && sleep 3 && pm2 logs mail-sync --lines 20 --nostream  # 部署后验证（详见 /deploy）

# 初始化同步
mailagent init fetch-cache --inbox-count 3000 --sent-count 500
mailagent init all --yes

# 排查
mailagent debug mail-structure           # 查看邮箱名称
mailagent admin health -o json | jq .data.healthy
tail -f logs/sync.log

# 部署 webhook-server 到远程
./scripts/deploy-webhook.sh
```

**部署环境**：本地 macOS（3.11+，main.py 主服务）· 远程 VPS `170.106.181.89`（3.9+，webhook-server FastAPI，PM2 `mailagent-webhook`，路径 `/opt/MailAgent/webhook-server`，SSH 公钥 `~/.ssh/id_ed25519`）。

## 打包 / 发布（桌面 App）

一体化 Electron 前端 + 内嵌 CPython 后端 → 单个 macOS `.app`。**全部在 `main` 上做**（前端是 `frontend/` 子目录，非独立 repo/submodule；打包/onboarding/auto-update 已全合入 main，feature 分支已删）。完整 runbook → [`docs/reference/packaging/packaging-release.md`](./docs/reference/packaging/packaging-release.md)。

- **版本 SSoT** = `frontend/package.json` 的 `version`（electron-builder 据此写 `Info.plist` + 产物名 + auto-update feed `latest-mac.yml`）。semver：`0.1.0`=首个 beta，bug 修复走 patch；功能性内容走 minor。已发至 **v1.2.1**（GitHub Releases published）。**🔴 对外发布流程（CI 驱动，实测 v0.6.3→v0.14.0 每次都这样）= bump `version` → 提交 → `git push origin main` → `git tag -a vX.Y.Z -m "…"` → `git push origin vX.Y.Z`**：CI `.github/workflows/build-mac.yml` 监听 `v*` tag **先过测试闸**（E0 起：`ci-test.yml` pytest 全量 + agent_eval 四道闸 + vitest，经 workflow_call 复用；测试红 = 不产 draft）再自动 build(macos-14 arm64) + `electron-builder --publish always` 把 5 件 feed（latest-mac.yml + zip/dmg + 各自 blockmap）**上传到一个 draft release**，`gh run watch <id> --exit-status` 盯完成（build ~3-4min + 测试闸 ~5min）。**🔴 CI 完成后 release 仍是 draft、`releases/latest` 不会更新 —— 必须转正式：推荐 Actions → Promote release（`promote-release.yml`，输入 tag，自动 edit 转正 + 置 latest + 校验 `releases/latest`==tag，E0 WP4）**；手动 fallback = `gh release edit vX.Y.Z --draft=false --latest --title "MailAgent vX.Y.Z" --notes-file <notes>`，再验 `gh api repos/ChenyqThu/MailAgent/releases/latest --jq .tag_name` == vX.Y.Z。本地 `pnpm build:mac` **仅用于 tag 前 dogfood**，CI 会从 tagged commit 重新构建发布字节。**不要手动 `gh release create`/上传产物**——push tag 已触发 CI 传 draft，手动 create 会与 CI 撞车。**🔴 装机三步 `quit→ditto→open` 必串行单线**——多个 ditto 覆盖 `/Applications/MailAgent.app` 期间被 open 拉起 = torn bundle → dyld `libffmpeg.dylib` missing → SIGABRT（易误判成「启动崩溃/DB 版本 bug」；判据=崩溃 .ips `termination.namespace=DYLD`「Library missing」+ `codesign --verify --deep --strict /Applications/MailAgent.app` 报「sealed resource is missing or invalid」，但 dist 源 app codesign OK ⇒ Release 产物干净、只 /Applications 副本 torn ⇒ `rm -rf`+单次 ditto 重装即修）。**🔴 勿改 package.json `name`（`mailagent-frontend`）**—— 它决定 userData 目录 `~/Library/Application Support/mailagent-frontend/`，改了已装用户数据/`.env` 易主。
- **前置**（`frontend/` 下，均 gitignored 本地产物）：`node_modules`（`pnpm install`）+ `resources/python`（`bash scripts/build-python-venv.sh`，~425M 可重定位嵌入式 CPython——mem0 epic 引入 onnxruntime/faiss 等本地 embedding 栈后的基线；本机已 provision，换机/新 clone 必先跑）。
- **构建**：本地装用 `pnpm run build && npx electron-builder --dir --arm64`（只出 `.app`，避开 flaky 的 dmg）；完整 feed 产物（dmg+zip+blockmap+latest-mac.yml）用 `pnpm build:mac`。**🔴 要含远程 web（`mail.chenge.ink/app`）必先 `pnpm build:web`**（出 `out/web` → electron-builder `from: out/web` 打进 `.app/Resources/web` → serve-api 经 `MAILAGENT_SPA_DIR` mount `/app`）；`pnpm run build` **不含** web SPA，漏跑则远程根 `/` 返 `{"detail":"Not Found"}`（`build:mac` 已含 `build:web`，仅 `--dir` 装机路径需手动补 `pnpm build:web &&`）。
- **🔴 头号坑①（python）**：`resources/python` 缺失 → afterPack（`scripts/afterPack.cjs`）**跳过整个签名** → `.app` 无后端 + `codesign` FAIL。build 前必确认它在。
- **🔴 头号坑②（ABI，0.2.3 踩过）**：build 前**绝不跑 `pnpm rebuild:node`**（把 better-sqlite3 编成 Node ABI）；electron-builder `npmRebuild:false` **不自动切回 Electron ABI** → 装进 app 的 `better_sqlite3.node` ABI 不匹配 → 所有 SQLite IPC（`email:listEnriched`）崩（renderer 报 `NODE_MODULE_VERSION`、界面全空）+ `probeDbReady` 失败致启动卡 120s。**跑过单测（`pnpm test` 含 rebuild:node）后 build 前必 `pnpm rebuild:electron`**。验证：`ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -e "require('better-sqlite3')"`（不报错=对）。
- **验证**（每次 build 后）：`codesign --verify --deep --strict <app>` 必 OK + `Info.plist` 版本号对 + `Resources/python/bin/python3.11` 在。
- **装机/升级**：退出旧 app → `ditto dist/mac-arm64/MailAgent.app /Applications/` → open。userData 跨重装保留 → 升级**跳过 onboarding**（detect `'configured'`）+ 后端启动自动 DB 迁移。用 `.app` 时 pm2 `mail-sync` 必须停（防双写）；davmail 用户 `davmail-poc` 留 pm2（EWS 桥，不打进 app）。
- **改 Python 后端**后：必先 `bash frontend/scripts/build-python-venv.sh` 重 provision 才进包；只改前端 TS/CSS 不用。**改 Python 依赖（requirements.txt / pyproject extras）必须重新生成 `requirements.lock.txt`**——E0 WP5 起 provision 只认 lock（108 包全 `==` pin，保打包再现性），漏生成 = 依赖改动不进包；生成方法见 lock 文件头注释。
- **自动更新**自 v1.0.0（P6）上线：Developer ID 签名 + 公证 + `AUTO_UPDATE_ENABLED` **packaged 默认开**（`readMasterFlag()` = `!is.dev`；`=0` 应急回退，仍保留检测提醒）。CI 全量 build 产 `latest-mac.yml` feed，正式 release 装机后自动检测/下载/安装。**🔴 例外：本地 `electron-builder --dir` dogfood 包不含 `app-update.yml`（走 ENOENT → `markUpdaterUnavailable`）+ 通常未公证 → 无法自更新、需手动替换，且装了 --dir 包 = 暂时脱离自更新轨道，需再装一次正式 CI/`build:mac` 包才恢复**。P6 见 [`docs/reference/packaging/05-auto-update-handoff.md`](./docs/reference/packaging/05-auto-update-handoff.md)。

## 官网（公开 Landing + 101）

仓库根 `site/` 是**独立的公开官网**（Astro 6 + Starlight，与 `frontend/` electron app、Python 后端并列，同在 `main`）：营销 landing（复刻 `frontend/docs/landing/` 设计稿，14 区块，暗/亮 + 6 强调色 + 中英双语，**用真实 React mock 组件替代截图**）+ 双语「101」使用指南（用户 16 页 / agent 13 页，zh 全量、en 关键页 + 缺译 fallback）。**与 `mail.chenge.ink/app`（在 CF Access 鉴权墙后的产品 app）是两套独立部署** —— 公开站**已上线**为**不在 Access 后**的独立 Cloudflare Pages 项目（`mailagent-site`），线上 **https://mailagent.chenge.ink**（2026-06-16 上线）。

- **内容 markdown 驱动**：101 文档 = `site/src/content/docs/{101,agent}/<slug>.md`（zh root + `en/`，Starlight 同名文件自动关联 + 缺译 fallback）；营销文案 = `site/src/content/landing/{zh-CN,en}.yaml`（改 yaml 即更新，零碰组件）。加语言 = 加 locale + 目录 + yaml。
- **设计 token** = `site/src/styles/tokens.css`，**从产品 `frontend/src/electron/renderer/index.css` 派生**（用产品 oklch coral `248 138 125`，非参考稿旧 `#E5654B`）；`pnpm check:tokens` 校验漂移。mock 组件在 `site/src/components/mock/`（纯展示、假数据、零真实 API）。
- **命令**：`cd site && pnpm install`（独立 pnpm 项目）；`pnpm dev`（开发）/ `pnpm build`（→ `dist/`，静态）/ `pnpm astro check`（类型闸，build 默认不 typecheck）/ `pnpm preview`。**Astro 6 不兼容 `@astrojs/tailwind`** —— Tailwind v3 走 PostCSS，勿重新引入。
- **规划/设计文档**（PRD/架构/101 内容规格）：`.trellis/tasks/06-15-landing-page-101-redesign/{prd,architecture,content-spec-101}.md`。
- **部署**：✅ 已上线 **Cloudflare Pages**（项目 `mailagent-site`，生产分支 `main`，公开不在 Access 后）→ 自定义域 **https://mailagent.chenge.ink**（proxied CNAME → `mailagent-site.pages.dev`）。发布 = `cd site && pnpm build` 后 `npx wrangler pages deploy site/dist --project-name=mailagent-site`。🔴 `pages deploy` 在无 TTY 的 shell 拒用 OAuth（报 non-interactive），需交互终端跑或设 `CLOUDFLARE_API_TOKEN`；CF 部署/域名 token 存 `~/.config/cloudflare/mailagent-site.env`（**repo 外，勿入库**）。自定义域改指/DNS 操作走 custom API token（`Account·Pages:Edit` + `Zone·DNS:Edit` + `Zone:Read`）—— CF 的 OAuth token 不被 REST API 接受。

## 调试 & 部署

调试服务按固定顺序排查（详见 `/debug` skill）：① `pm2 status` 进程存活 → ② `.env` token/secret → ③ Redis/webhook/代理 → ④ `pm2 logs <name> --lines 30 --nostream` → ⑤ `sqlite3 data/sync_store.db` 状态分布。**不要**：sudo / 交互式命令 / 没查基础项就改代码 / 错误 SSH 凭证重试。

部署后**必须**验证（详见 `/deploy` skill）：重启 → `pm2 status` online → 启动日志无 error → Redis consumer 连接 / SQLite 雷达 / webhook handler 已注册。不要假设部署成功 —— Pydantic schema 变更、handler 未注册、依赖缺失都可能静默失败。

```bash
# 死信 / 重试队列监控
sqlite3 data/sync_store.db "SELECT sync_status, COUNT(*) FROM email_metadata GROUP BY sync_status"
sqlite3 data/sync_store.db "SELECT COUNT(*) FROM email_metadata WHERE sync_status='dead_letter'"
```

## 模块地图

#### 邮件模块 (`src/mail/`)

| 模块 | 职责 |
|------|------|
| `new_watcher.py` | 主监听器，v3 主循环（SQLite 优先）+ LLM/项目周报/KOS hook 派发点 |
| `sqlite_radar.py` | SQLite 雷达：检测变化 + `get_new_emails()` |
| `applescript_arm.py` / `applescript.py` | AppleScript 机械臂（`fetch_email_content_by_id()`）+ 底层执行封装（fallback 路径）|
| `backend/` | Sprint 16 双 backend 抽象（`IMailBackend` / davmail / applescript / imap_client）|
| `sync_store.py` | SQLite 同步状态存储（internal_id 主键，DB schema 演进点）|
| `reader.py` | MIME 解析（HTML、附件、thread_id） |
| `meeting_sync.py` / `icalendar_parser.py` | 会议邀请检测 + iCalendar 解析 |
| `reverse_sync.py` | 反向同步（Notion → SQLite intent + outbox，Sprint 15 后不直调 AppleScript） |

#### 其他模块

| 目录/模块 | 职责 |
|------|------|
| `src/notify/feishu.py` / `alert.py` | 飞书应用机器人通知（Card 2.0 form 交互）/ 飞书告警机器人 |
| `src/events/redis_consumer.py` / `handlers.py` | Redis BLPOP 消费者 / Webhook 事件处理器（flag_changed/ai_reviewed/completed/create_draft/query_mail/fetch_mail_content/search_email_bodies/page_updated）|
| `src/notion/` | I-07 后 facade 拆分：`sync.py`(facade) + `client.py` + `pages.py` + `threads.py` + `queries.py` + `_common.py`。外部统一 `from src.notion.sync import NotionSync, CreateEmailFromSqliteResult, BEIJING_TZ`，勿直接 import 子组件 |
| `src/calendar_notion/` | `sync.py` 日历→Notion · `caldav_reader.py` CalDAV 读 · `meeting_sync.py` 邮件 .ics → calendar_event |
| `src/calendar_sync/` | Sprint 后新模块：repository / expander / reconciler / worker（CalDAV → SQLite SSoT） |
| `src/converter/` | `html_converter.py`(HTML→Notion blocks+内联图) · `eml_generator.py` · `office_converter.py` · `attachment_text.py`(附件文本化) · `html_to_markdown.py` |
| `src/repository/` | v4 `EmailRepository` / `AttachmentStore` / FTS5 搜索 |
| `src/llm_agent/` / `src/project_progress/` / `src/kos/` | 见对应下沉文档 |
| `src/agent_config/` | Capability & Context 配置面（Phase -1/0A，backend-owned `agent_config.db`）：`store`(统一 skill registry + Standing Context 文档 SOUL/AGENT/RULES/USER + history/rollback) · `templates`(seed) · `projections`(MEMORY/SKILLS 投影 + 配置快照 hash) · `validator`(RULES deny-list, negation-aware)。配 `src/skills/installed.py`(安装行→BoundSkill 投影，owner-only) + `src/api/routers/agent.py`(`/api/agent/*`)。见 [`capability-context-foundation.md`](./docs/reference/llm-agent/capability-context-foundation.md) |
| `src/reports/` | 报告 Agent 系统（日/周/月报）：`models`(ReportDoc 块模型) / `data`(取数+分组) / `summarizer`(LLM tool_use) / `assembler`(防幻觉权威回填) / `worker`(tick_loop 定时) / `store`(report_agent+report 表)。见 [`docs/reference/remote-chat-report/report-agent-prd.md`](./docs/reference/remote-chat-report/report-agent-prd.md) |
| `src/agents/` | Custom agent 内核 + 产品化（S4+S5，flag `MAILAGENT_CUSTOM_AGENTS_ENABLED` 默认 off）：`trigger`(trigger_json 判别式解析+保存时深校验+**S5 `parse_tool_policy` typed 严格化 grant_exec**) / `matcher`(AgentEmailMatcher 邮件事件匹配) / `trigger_worker`(cron croniter UTC marker) / `email_dispatch`+`run_queue`(第 5 hook 分发+enqueue 幂等/runs-day 门) / `run_worker`(AgentRunWorker claim→poke gateway→终态回写+**S5 岛结果通知 completed/error**) / `fence`(UNTRUSTED_EMAIL_BODY envelope 围栏) / `run_state`(paused_handoff 读态唯一入口，8 值域)。**S5 产品面**分散于 `src/api/routers/agent_runs.py`(run 历史 `GET /api/agent-runs` + tool-options 端点 + `DEFAULT_CUSTOM_AGENT_ALLOWED_TOOLS` 默认安全集投影 + 免卡 badge 投影) · `src/api/routers/agent.py`(per-agent 规则 CRUD `/policy/rules` + `/skills/entrypoints`) · `src/agent_config/policy.py`+`store.py`(domain_write capability + `context_mode+agent_id` 双键物理隔离 + pinned-entrypoint 形状闸) · gateway `tools/agents.ts`(对话式 CRUD 六工具)+`tools/policy.ts`(`AgentModeGrants` 矩阵第三参)+`tools/write.ts`(headless-only policyEvaluate 注入)。**S6** 加执行记录反查（`agent_runs.py` state 过滤/pending-count + gateway `/api/ai/approval/pending` 真值端点）+ per-agent web grant/skill 挂载（`policy.py` `WebMatcher{origin}` + canonical `_normalize_origin` 单源 + `web.py` redirect 聚合集[candidate ∪ 首跳]，gateway `tools/web.ts` 三档免卡）+ custom-agent A2UI 审批卡（`a2ui.ts` before/after diff）。见 ai-sdk-gateway-architecture.md §13.19（S4）+ §13.20（S5）+ §13.21（S6） |
| `src/stats_reporter.py` | 定期上报运行统计到远程看板 |
| `webhook-server/` | FastAPI（接收 Notion Automation webhook → Redis 路由 + 看板 API，端口 8100）|

## CLI

`mailagent` CLI = agent-friendly 接口，10 个 group：`email` / `admin` / `attachment` / `llm` / `notion` / `calendar` / `debug` / `backfill` / `project-progress` / `init`。读命令无 auth，写命令需 token（`MAILAGENT_CLI_API_KEY` + `--api-key`，`--dry-run` 跳过）。Batch 写命令有长任务契约（SIGINT 二次 / 熔断 / checkpoint resume / PM2 检测）+ 退出码体系（0/1/2/4/5/6/7/8/9/130）。

**完整命令表 / 退出码 / schema 契约 / 调用样例** → [`docs/reference/cli/cli-reference.md`](./docs/reference/cli/cli-reference.md)。

```bash
mailagent -o json email get 53675 | jq .data.subject
mailagent -o json email search "redis timeout" --mailbox 收件箱 --limit 20
mailagent email resync 53675 --dry-run -o json
```

## Notion 数据库结构

**邮件数据库**必需字段：`Subject`(Title) · `Message ID`(Text,去重) · `Thread ID`(Text,线程) · `From`(Email) / `From Name`(Text) · `To` / `CC`(Text) · `Date`(Date) · `Parent Item`(Relation self,线程头) · `Mailbox`(Select) · `Is Read` / `Is Flagged` / `Has Attachments`(Checkbox) · `AI Action`(Select) · `AI Priority`(Select: Critical/Urgent/Important/Normal/Low) · `AI Review Status`(Select: Pending/Reviewed)。

**日历数据库**必需字段：`Title`(Title) · `Event ID`(Text,去重) · `Time`(Date,起止) · `URL`(URL,Teams) · `Location`(Text) · `Organizer`(Text) · `Status`(Select)。

> 改 email DB schema（加/改 select option）→ 同步改 `src/llm_agent/schema.py` 并跑 `pytest tests/llm_agent/test_schema.py`（有 `schema-consistency-reviewer` subagent 校验四处一致性）。

## 常见问题

- **邮箱名称错误**：`mailagent debug mail-structure`
- **SQLite 无法访问**：需 Full Disk Access（系统设置 → 隐私与安全 → 完全磁盘访问权限）
- **AppleScript 超时**：增大 `APPLESCRIPT_TIMEOUT`（默认 200 秒）

## 开发指南

- 改邮件解析：编辑 `src/mail/reader.py`，测 `python3 scripts/dev/test_mail_reader.py`
- 改会议检测：`src/mail/icalendar_parser.py` 或 `src/calendar_notion/description_parser.py`
- 加新配置：① `src/config.py` 加 Field → ② `.env.example` 加示例 → ③ 必要时更新本文件「关键开关现状」表
- **加新文档**（防再次乱套，完整规范见 [`docs/DOC-GUIDE.md`](./docs/DOC-GUIDE.md)）：先判类型 —— **常青参考**（描述系统"现在如何"、会反复读）放 `docs/reference/<子系统>/`，**且必须在上方「文档地图」加一行**（否则无人发现）；**过程产物**（handoff / complete / phaseN / prN / sprint / 验收 matrix / 交接 / dogfood）放 `.trellis/tasks/<task>/`，已成历史的归 `docs/archive/{年-月}/` —— **禁止堆回 `docs/` 顶层或 `docs/reference/`**。判据：*半年后还有人为"现在怎么回事"来读吗？* 是→reference，否→archive。
- SQLite schema 升级：用 `/db-migration` skill（bump DB_VERSION + idempotent migration + 一致性更新）。**bump `DB_VERSION` 必同步前端 `frontend/src/electron/main/backend_lifecycle.ts` 的 `EXPECTED_DB_VERSION`**（TS 手抄 Python 常量，漏改 → 打包 app 启动门控 `waitReady` 卡 120s 降级；判据已 `>=` 容错 + `frontend/tests/main/db_version_consistency.test.ts` 兜底）
- **跑 agent 行为回归网**：改 chat agent 的 prompt / 工具 / 编排引擎后**必跑** `venv/bin/python -m pytest tests/agent_eval -q`（零-LLM hard rules R1-R8 + 37 curated tasks[v0.13.0 baseline 27 + phase04b/selfmount/skillsupply/s4agents lanes 10] + **gateway↔catalog 完整性闸**[新 gateway 工具漏 `tool_catalog.json` 必红]，~0.1s）。这是「换 agent 引擎不回退」的金标准——回归闸 `python -m runner.run_baseline --compare`（在 `tests/agent_eval/` 下跑），总分不得低于 baseline。规格见 `tests/agent_eval/schema.md` + `recorder-contract.md`；**judge / live recorder 是 manual lane，不进 CI**（fixtures 全 `.test` 合成域，零真实 PII）。整合大版本规划见 `.trellis/tasks/06-23-agent-eval-memory-skill-assistant-ui-ai-sdk/`。

## 文件位置

- 日志：`logs/sync.log` · 数据库：`data/sync_store.db` · 附件：`data/attachments/{internal_id}/` · 临时附件：`/tmp/email-notion-sync/{md5}/` · 配置：`.env`（示例 `.env.example`）
- 优化文档（已归档）：`docs/archive/2026-01/applescript_id_optimization.md` · Webhook Server：`webhook-server/`（一键部署 `./scripts/deploy-webhook.sh`）
- 常青参考：`docs/reference/<子系统>/`（索引见各 `index.md` 与上方文档地图）· 过程归档：`docs/archive/{年-月}/` · 文档规范：`docs/DOC-GUIDE.md`

## 迁移与运维

```bash
# v3 架构迁移（v2 → internal_id 主键）
python3 scripts/migrate_sync_store_v3.py

# 监控重点
sqlite3 data/sync_store.db "SELECT sync_status, COUNT(*) FROM email_metadata GROUP BY sync_status"
sqlite3 data/sync_store.db "SELECT internal_id, sync_status, retry_count FROM email_metadata WHERE sync_status IN ('fetch_failed','failed')"
```

各子系统的运维 SQL / 验收命令 / 回滚开关 见对应下沉文档（见「文档地图」）。
