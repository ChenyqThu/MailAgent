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
| 架构内核（v3 流程 / 重试 / outbox / dual-backend） | 改正/反向 sync、webhook、状态机前；**在第二处手抄某个常量·枚举·派生表前** | [`architecture/architecture-internals.md`](./docs/reference/architecture/architecture-internals.md) |
| **功能开关全表**（58 个开关的设计推理 / 灰度与 cutover 史 / 安全闸推导 / 已知竞态与「有意不修」的理由） | 改任何开关的行为前；查某个 flag 为什么是这个默认值 | [`architecture/feature-flags-rationale.md`](./docs/reference/architecture/feature-flags-rationale.md) |
| DavMail 写路径 trace + Notion 反向链路退役依据 | 退役 Notion 反向链路 / 清 outbox 死分支 / 动 reverse_sync·handlers 前 | [`architecture/davmail-write-path-trace.md`](./docs/reference/architecture/davmail-write-path-trace.md) |
| **排程规则跨端契约**（`kind:'schedule'` 结构化排程） | 动 custom agent 定时触发 / 报告 Agent 排程 / schedule-builder 预览 / `src/agents/schedule_rule.py` 前 | [`architecture/schedule-rule-contract.md`](./docs/reference/architecture/schedule-rule-contract.md) |
| **L4 个人 Agent 节点规划 2026-08**（战略定位 + 五 workstream） | 启动本 epic 任一批次 / 排 matters·日历·agent 融合优先级前 / 评估团队协作方向前 | [`l4-personal-agent-node/README.md`](./docs/plans/l4-personal-agent-node/README.md)（docs/plans，epic task `08-17-l4-agent-epic-agent-notion`） |
| **架构整体 Review 2026-07 + E0-E4 收敛路线** | 启动 E0-E4 任一收敛 epic / 排架构债优先级前 | [`architecture-review-2026-07/README.md`](./docs/plans/architecture-review-2026-07/README.md)（docs/plans，含 e0-e4 五份实施方案） |
| LLM Agent（本地 LLM 分类，fallback / cache / 监控） | 改邮件分类、prompt、cache 前 | [`llm-agent/llm-agent.md`](./docs/reference/llm-agent/llm-agent.md) + [`llm-agent/LLM_AGENT_SETUP.md`](./docs/reference/llm-agent/LLM_AGENT_SETUP.md) |
| LLM Provider Registry（上游多 provider） | 动 provider 配置 / gateway 模型层 / 协议路由 / 模型选择链 / `MAILAGENT_LLM_PROVIDER_REGISTRY` 前 | [`llm-agent/llm-provider-registry.md`](./docs/reference/llm-agent/llm-provider-registry.md) |
| 项目周报同步（外挂模块，xlsx → Notion） | 动 `src/project_progress/` 前 | [`project-progress/project-progress-sync.md`](./docs/reference/project-progress/project-progress-sync.md) |
| 报告 Agent 系统（日/周/月 + custom artifact） | 动 `src/reports/` / 报告 / Custom AI Agents 区前 | [`remote-chat-report/report-agent-prd.md`](./docs/reference/remote-chat-report/report-agent-prd.md) |
| **Matters（事项）**（把「一件要推进的事」变成第一类对象） | 动 `src/matters/` / 事项前端 / 跟进 Agent / `matter_*` 表前 | [`matters/matters-architecture.md`](./docs/reference/matters/matters-architecture.md)（索引 [`matters/index.md`](./docs/reference/matters/index.md)） |
| **通讯录 Contact Directory**（人级主键 + email 锚点账本） | 动 `src/contacts/` / `contact*` 三表 / `/api/contacts` / 通讯录前端 / compose 预填前 | [`contacts/contact-directory.md`](./docs/reference/contacts/contact-directory.md) |
| Calendar Module（CalDAV → SQLite SSoT） | 动日历同步 / `calendar_event` 表前 | [`calendar/calendar-ops.md`](./docs/reference/calendar/calendar-ops.md) + [`calendar/calendar-module-prd.md`](./docs/reference/calendar/calendar-module-prd.md) |
| v4 SQLite-SSoT（body/附件 SSoT + FTS5 全文搜索） | 动 `EmailRepository` / 双写 / 搜索前 | [`architecture/v4-ssot-ops.md`](./docs/reference/architecture/v4-ssot-ops.md) + [`architecture/architecture_v4_sqlite_ssot.md`](./docs/reference/architecture/architecture_v4_sqlite_ssot.md) |
| 后端服务层（`src/services/` 统一写面 + async-jobs + 双层鉴权） | 改写操作（flag/resync/archive/pin/llm/compose/send）/ 加传输端 / 动 `src/services/` 前 | [`architecture/service-layer-architecture.md`](./docs/reference/architecture/service-layer-architecture.md) + `~/.claude/plans/cli-streamed-brook.md` |
| AI Agent Harness + KOS（**AI SDK Gateway 是唯一引擎**） | 动前端 chat / gateway / KOS 集成前 | [`llm-agent/ai-sdk-gateway-architecture.md`](./docs/reference/llm-agent/ai-sdk-gateway-architecture.md)（**唯一引擎权威**：embedded gateway / 工具 / HITL 审批 / A2UI / memory / standing-context / serve-api 代理，§13）+ [`llm-agent/kos-integration-design.md`](./docs/reference/llm-agent/kos-integration-design.md) |
| Skill Delivery API（对外 agent 交付面） | 动 scoped key / `src/skills` / `/api/skills` / MCP / pack 前 | [`llm-agent/skill-delivery-api.md`](./docs/reference/llm-agent/skill-delivery-api.md) |
| Capability & Context Foundation（配置面 + Standing Context） | 动 `src/agent_config` / `/api/agent/*` / standing-context prompt / installed skill / @mention 前 | [`llm-agent/capability-context-foundation.md`](./docs/reference/llm-agent/capability-context-foundation.md) |
| **MCP Connectors**（外部服务工具面 · 自建直连 + Composio 双轨） | 动 `src/connectors/` / connector 端点 / gateway connector 工具注入 / 第七能力卡 / **`/connectors` 配置台或内置工具审批档 UI** / `MAILAGENT_MCP_CONNECTORS` 前 | [`llm-agent/mcp-connectors.md`](./docs/reference/llm-agent/mcp-connectors.md) |
| **飞书对话**（IM agent 场地 + 飞书内按钮审批闭环） | 动 `src/im/` / `/api/im/*` / gateway `im-chat` 入口 / 设置-AI「飞书对话」区 / `MAILAGENT_IM_FEISHU` 前 | [`llm-agent/im-feishu-chat.md`](./docs/reference/llm-agent/im-feishu-chat.md) |
| V2.1 远程 chat + report/agent（B-pure-unified 传输层） | 动远程 web chat / serve-api chat 端点 / chat 引擎语义前 | [`remote-chat-report/remote-chat-report-architecture.md`](./docs/reference/remote-chat-report/remote-chat-report-architecture.md) + [设计](./docs/reference/remote-chat-report/v2.1-stage3-chat-platform-design.md) + [看板](./docs/reference/remote-chat-report/v2.1-remote-chat-report-matrix.md) |
| **Agent 体验大版本专项**（换引擎 + mem0 记忆重构史） | 理解 mem0 记忆演进史 / 跑 agent 回归网前 | 引擎架构 [`llm-agent/ai-sdk-gateway-architecture.md`](./docs/reference/llm-agent/ai-sdk-gateway-architecture.md) §13.18 + M1-M5 计划（已归档）[`memory-skill-core-refactor.md`](./docs/archive/2026-07/agent-experience-epic/memory-skill-core-refactor.md) + 回归网 `tests/agent_eval/` |
| CLI 完整命令表 + 退出码 + schema 契约 | 查命令明细 / 加 CLI 命令前 | [`cli/cli-reference.md`](./docs/reference/cli/cli-reference.md) + [`cli/agent-cli-rfc.md`](./docs/reference/cli/agent-cli-rfc.md) |
| 存档/草稿箱 + 多文件夹同步（folder_sync） | 动 folder 同步前 | [`folder-sync/multi-folder-sync-design.md`](./docs/reference/folder-sync/multi-folder-sync-design.md) + [`folder-sync/folder-ui-prd.md`](./docs/reference/folder-sync/folder-ui-prd.md) |
| Webhook / SSE / Openclaw / Notion API（集成面） | 动 webhook-server / 事件流 / 飞书回调前 | [`integrations/`](./docs/reference/integrations/) |
| 邮件搜索（**单核 CORE#1** + Query DSL + FTS5 + agentic） | 改搜索语法 / 检索引擎 / agentic 前 | [`search/search-query-syntax.md`](./docs/reference/search/search-query-syntax.md) |
| 灵动岛 Ping Island 集成 | 动通知/ack 中心前 | `~/.claude/plans/ultrathink-session-curious-cloud.md` |
| 前端动效 + 列表性能铁律（Electron renderer） | 动前端列表/正文/动效前 | [`frontend/ARCHITECTURE.md`](./frontend/ARCHITECTURE.md) §7.1-7.2 + [`frontend/docs/motion-gsap.md`](./frontend/docs/motion-gsap.md) |
| **灵动 Bot 头像**（状态化 SVG 单源模块 + v2 参数化 3D 引擎） | 动 `bot-avatar/` 模块 / AgentAvatar / 头像编辑器 / TurnPresence / avatar_json schema / 主 agent 身份前 | [`frontend/docs/bot-avatar.md`](./frontend/docs/bot-avatar.md) |
| **前端设计体系 v3「原生材质」**（token SSoT = index.css） | 改主题/token/选中态/圆角/装饰层前 | [`frontend/DESIGN.md`](./frontend/DESIGN.md)（v3 节）+ 落地台账 [`theme-v3-native-material/README.md`](./docs/plans/theme-v3-native-material/README.md) |
| 桌面 App 打包 / 发布（一体化 .app + 签名闸） | 出新版 / 发布 App 前 | [`packaging/packaging-release.md`](./docs/reference/packaging/packaging-release.md) |
| **Windows Outlook COM backend**（代码完备待真机 PoC） | 动 `outlook_com` backend / win 打包链 / `scripts/poc_win/` 前 | [`architecture/outlook-com-backend.md`](./docs/reference/architecture/outlook-com-backend.md) |

技能（按需触发，正文不常驻）：`/deploy`（部署验证）、`/debug`（系统化排查）、`/health`（健康巡检）、`/db-migration`（schema 升级）、`/sprint-handoff`（交接文档）。

## 项目概述

**MailAgent** 是一个 macOS 邮件实时同步系统，将 Mail.app / Outlook 邮件同步到 Notion，支持：
- 邮件内容、附件、线程关系同步 + 会议邀请（iCalendar）→ 日程
- AI 分类与处理（本地 LLM / Notion Custom Agent）
- 双向 Flag 同步（Mail.app ↔ Notion，Sprint 15 起统一走 outbox + FanoutWorker 异步派发）
- 飞书应用机器人通知（重要邮件推送 + 交互式回复按钮 → Openclaw）
- Notion Webhook → Redis → Mail.app 实时事件驱动
- 附件文本化 + 全文检索（anydoc 纯本地提取 / macOS Vision OCR → FTS5）

**当前架构状态**（演进叠加，详见 [`docs/reference/architecture/architecture-internals.md`](./docs/reference/architecture/architecture-internals.md)）：
- **v3 SQLite-First**（2026-01）：`internal_id`（ROWID = AppleScript id）主键，`whose id is <int>` 查询比旧方式快 127 倍，支持 6-7 万封大邮箱。
- **Sprint 15 SQLite SSoT inversion**（2026-05）：所有 mutating 操作反转方向，SQLite 是写入 intent 聚合点，FanoutWorker 异步派发到 Mail.app + Notion，统一走 `email_outbox`（E2 2026-07 起 outbox **恒启用**，灰度开关 `MAILAGENT_OUTBOX_ENABLED` 与老直调分支已退役；三处 flag→outbox 入队归一 `src/sync/outbox_intents.py`）。
- **Sprint 16 Dual-Backend**（2026-05-22 cutover）：抽象 `IMailBackend` Protocol，**davmail 模式为当前主路径**（IMAP/SMTP/CalDAV 桥 EWS），AppleScript 保留作 emergency fallback。
- **v4 SQLite-SSoT**（2026-05，Phase 1-4 已上线/灰度）：SQLite 是邮件正文 + 附件的 SSoT，Notion 退化为镜像，FTS5 全文搜索就位。

**死硬约束**：
- DavMail 当前用 Outlook for Windows well-known client_id 伪装（PoC），**不可上生产** —— 需走公司 IT 审批（推荐直接申请 Graph API）。
- EWS **2026-10-01 起默认阻断**、2027-04-01 完全退役。本机跑的是 DavMail **6.7.0**（EWS 模式）；上游 **6.8.0/6.8.1 已发版并带正式 Graph backend**，且 Outlook clientId 伪装在 Graph 下**仍可用、不需要 IT 审批**（`davmail.mode=O365Graph` + `davmail.enableOidc=false`）。**2026-07-31 owner 拍板暂不迁移** —— 卡点不是授权而是成熟度（上游 refresh token 要错 resource 致 1h 后静默 401；#506 Graph 下 IMAP APPEND 400 打中草稿保存；日历/大邮箱未就绪）。迁移不需重灌数据（imapUid 同为 MAPI `0x0e23`、UIDVALIDITY 恒 1），但**必须重认证且回切也要重认证**。完整实证与观察触发条件见 [`docs/reference/architecture/roadmap-post-cutover.md`](./docs/reference/architecture/roadmap-post-cutover.md) §5.1。
- AppleScript fallback 路径**始终可用** —— 任何重构都必须保证 emergency 回切不丢数据（回切步骤见 architecture-internals.md）。

**技术栈**：Python ≥3.9（本地 3.11+，远程 webhook-server 3.9+）· AppleScript（fallback）· DavMail 6.7 JVM（主路径）· SQLite（状态 + v4 SSoT + FTS5）· Notion API · BeautifulSoup/lxml · Pydantic · Redis · FastAPI · firecrawl-anydoc（纯本地 Rust 文档提取）· pandas + python-calamine。
> ⚠️ LibreOffice 已于 2026-08-14 移除（Office→PDF 派生 08-10 退役，老 `.doc` 改走 anydoc）；启动日志里的 `soffice not found` WARNING **不是故障**。

## 关键开关现状（代码默认值；★ = 生产已偏离默认）

> 本表只列「是什么 + 默认值」。**每个开关的设计推理、灰度 / cutover 历史、安全闸推导、已知竞态与「有意不修」的理由、跨语言载体与 parity 闸** → [`architecture/feature-flags-rationale.md`](./docs/reference/architecture/feature-flags-rationale.md) 的**同名条目**。
> 🔴 改任何开关的行为之前先读那里 —— 本表的一句话**不足以**支撑改动决策。

| 开关 | 代码默认 | 说明 |
|---|---|---|
| `MAILAGENT_BACKEND` | `applescript` | ★生产=`davmail`。三值：`applescript`(mac) / `davmail`(主路径) / `outlook_com`(win-only，代码完备待真机 PoC) |
| `DRAFTS_SYNC_ENABLED` | `true` | 草稿箱同步（davmail-only）：Exchange Drafts 对账进 `email_metadata`；**仅本地**，不进 Notion / LLM / 飞书 / KOS |
| `MAILAGENT_INBOUND_READ_RECONCILE_ENABLED` | `false` | 入向「未读→已读」单向回收（davmail-only，issue #58）。🔴 五道安全闸 + 一处有意保留的竞态 |
| `MAILAGENT_INBOUND_READ_RECONCILE_INTERVAL_SEC` | `300` | 上一项的独立低频节拍（秒）。🔴 绝不挂 5s radar poll（会重现 EWS 全量枚举限流） |
| `MAILAGENT_INBOX_RECONCILE_ENABLED` | `false` | 收件箱对账兜底（davmail-only，2026-08-11 丢邮件事故）。🔴 判据是 Message-ID 不是 UID；**只补不删** |
| `MAILAGENT_INBOX_RECONCILE_INTERVAL_SEC` | `1800` | 对账节拍（30min）。🔴 同样绝不挂 5s radar poll |
| `MAILAGENT_INBOX_RECONCILE_WINDOW_DAYS` | `2` | 对账回看窗口（天）。🔴 上限受 `DAVMAIL_FOLDER_SIZE_LIMIT` 截断视图约束，建议 ≤7 |
| `MAILAGENT_RECONCILE_NOTIFY_MAX_AGE_SEC` | `7200` | 补抓邮件的飞书通知年龄上限。🔴 判据是「补抓来源 AND 超龄」，只判年龄会误伤正常积压 |
| `DAVMAIL_FOLDER_SIZE_LIMIT` | `500` | IMAP 视图只留最近 N 封（2026-07-24 停摆事故）。🔴 是 DavMail 自己的参数，改后须重启 davmail 才生效 |
| `BODY_DUAL_WRITE_ENABLED` | `true` | v4 双写总开关；失败仅 warning 不阻断 |
| `NOTION_READ_FROM_SQLITE` | `true` | v4 Phase 4（2026-07-11 cutover）：sync/resync 走 SQLite SSoT，miss 回落老路径 |
| `SEARCH_TRIGRAM_ENABLED` | `true` | 中文子串全文检索（trigram FTS5 并行表路由）。配套子开关 `SEARCH_LATIN_TRIGRAM_ENABLED` |
| `MAILAGENT_ATTACHMENT_OCR_ENABLED` | `true` | 附件 OCR：图片 + 无文本层 PDF 走 macOS Vision，本地识别无网络出口 |
| `MAILAGENT_ANYDOC_ENABLED` | `true` | anydoc 附件提取（2026-08-10 cutover）。收原生 docx **丢字**缺陷；任何失败恒回落原生 extractor |
| `MAILAGENT_ANYDOC_LANES` | `office,legacy` | 上一项的生效范围。🔴 `pdf` 有意不在默认值里（实测 3 份回归，且无判据可拦） |
| `LLM_AGENT_ENABLED` | `false` | 本地 LLM 分类总闸（启用前必看 llm-agent.md 防双跑）。模型 / 上下文源支持行级覆写，保存即生效 |
| `LLM_PREPROCESS_CONTEXT_SOURCE` | `""`（仅 seed） | 分类 prompt 参考源二选一（`standing_docs` \| `notion_context`，互斥）。🔴 运行时权威已迁 DB 行 |
| `MAILAGENT_LLM_PROVIDER_REGISTRY` | `true` | 多 Provider 体系（2026-07-13 cutover）：配置权威在 `agent_config.db` 双表，引用格式 `providerId:modelId` |
| `CALENDAR_CALDAV_SYNC_ENABLED` | `false` | ★生产=`true`。CalendarSyncWorker 总开关 |
| `SYNC_FOLDERS` | `[]`（空） | 多文件夹同步白名单（davmail-only）。🔴 **数组序 = 用户自定义显示顺序**，读侧不得 `sorted()` |
| `PROJECT_PROGRESS_SYNC_ENABLED` | `false` | 项目周报 CLI + 钩子总闸。trigger 配置已迁 DB 行内热读，env 仅作首次 seed |
| `MAILAGENT_STANDING_CONTEXT_ENABLED` | `true` | Standing Context 分层 prompt（SOUL / AGENT / RULES / USER 由 `agent_config.db` 组装） |
| `MAILAGENT_AGENT_CONFIG_DB_PATH` | —（空） | `agent_config.db` 路径覆盖（默认 sync_store 同目录）；不进 `DB_VERSION` |
| `MAILAGENT_MEM0_CAPTURE` / `_RETRIEVAL` / `MAILAGENT_USER_MD_COMPILE` | `true`（2026-07-02 cutover） | memory.md 有界记忆：捕获 / 恒注入 / 编译进 user.md。配套 `MEMORY_MD_BUDGET_CHARS`(5000)、`MEMORY_CAPTURE_MODEL`(haiku) |
| `MAILAGENT_SKILL_SELF_MOUNT` | `true` | skill→tool 门控：关掉某 skill 其读工具不再注册给模型。core 工具永不门控 |
| `MAILAGENT_STANDING_DOCS_EDITOR` | `true` | Settings「身份文档」编辑器显隐（全文编辑 + 每文档 history / rollback） |
| `MAILAGENT_KOS_INGEST_ENABLED` / `_CONSUMER_ENABLED` / `_L1_HOT_BLOCK_ENABLED` | `false` | KOS 集成三层，全默认 OFF |
| `KOS_REQUIRE_LABELED` | `false` | 只放行已跑过 LLM 标注的邮件（issue #49）。默认 false 时未标注邮件（实测约 89%）全部放行 |
| `MAILAGENT_KOS_RETRY_ENABLED` | `true` | KOS 推送失败重试 + 台账 `kos_ingest_log`（DB v41）。挂主 tick 第 6c 步；探活不可用整段跳过 |
| `MAILAGENT_REPORT_AGENT_ENABLED` | `false` | 报告 Agent worker（日 / 周 / 月报）；per-agent 还需 `report_agent.enabled` |
| `MAILAGENT_ISLAND_AGENT_ENABLED` | `true` | harness 审批上灵动岛（2026-07-06 cutover）。🔴 审批以**无岛**方案为主路径，本 flag 只管上岛面 |
| `MAILAGENT_CHAT_DETACHED_RUNS` | `true` | chat run 与客户端连接解耦：切会话 / 关面板不中断流。配 `/run/active` + `/run/stop` |
| `MAILAGENT_OPENNESS_SESSION_TOOLS` / `_CONFIG_TOOLS` / `_WEB_TOOLS` | `true` | 开放性 S1（2026-07-06 cutover）：会话检索 3 + 配置读 4 + web 2 工具 |
| `MAILAGENT_OPENNESS_EXEC_TOOLS` / `_SKILL_INSTALL` | `true` | 开放性 S2。🔴 安全地板不变：`run_command` 无白名单命中恒 HITL、skill 安装恒 HITL |
| `MAILAGENT_CUSTOM_AGENTS_ENABLED` | `true` | Custom AI Agents（2026-07-06 cutover）。on 但不配 grant = 恒 HITL；per-agent 另需 `report_agent.enabled` |
| `MAILAGENT_ALERT_EPISODE` | `true` | 状态型告警的 episode 语义：进异常告一次 → 静默 → 值翻倍才再告 → 恢复发 recovery |
| `MAILAGENT_CALENDAR_AGENT_TOOLS` | `true` | gateway 5 个日历工具（2 读 + 改期 / RSVP / 删除）。三个写工具出厂默认弹卡 |
| `MAILAGENT_NOTION_AGENT_TOOL` | `true` | `notion_agent_chat` 工具（委派 notion-agent CLI，edit-tier 出厂弹卡）。⚠️ 真开关是 Skills 里的 `notion_agent` 条目，本 flag 只是 kill-switch |
| `MAILAGENT_MCP_CONNECTORS` | `false` | MCP connector 总闸（灰度中）。双轨：Notion / Atlassian 自建直连 + 其余 14 家 Composio；per-tool 三档 `auto\|ask\|off` |
| `MAILAGENT_MEMORY_LAYERS` | `false` | memory.md 分层抽取（5 层 + 兜底），按层预算截断。🔴 只门控写侧，读侧判据是文档结构 |
| `MAILAGENT_SKILL_CATALOG_PROMPT` | `false` | 技能名单注入 system prompt 可缓存前缀（仅 manual chat）。🔴 是导航用的能力事实，**不是**权威开关态 |
| `MAILAGENT_IM_FEISHU` | `true` | 飞书对话总闸（2026-08-04 cutover）。🔴 与通知 bot 完全隔离；没配凭证 = 零启动零连接 |
| `MAILAGENT_IM_WEB_ENABLED` | `false` | 飞书会话里允不允许 AI 上网。🔴 是 venue 开关**不是** grant；开了也恒 HITL |
| `MAILAGENT_PLAN_TOOL` | `true` | `plan_update` 零副作用 silent 工具 + 只读 PlanCard（用户无编辑路径） |
| `MAILAGENT_SESSION_PROVENANCE` | `true` | 会话溯源（CHAT_DB v24）：headless 可信身份注入 + 会话组合过滤 + Agents 未读红点 |
| `MAILAGENT_CUSTOM_AGENT_CALL` | `true` | `custom_agent_call` 仅 manual_chat（Custom Agent **递归禁止**）+ 父子 Session + 审批 TTL 差异化 |
| `MAILAGENT_CHAT_COMPACT` | `true` | 手动 `/compact` 压成固定十节摘要，完整历史一条不删 |
| `MAILAGENT_CHAT_AUTO_COMPACT` | `true` | 自动压缩：80% 提醒 / 90% Run 结束后自动 + overflow 重试恰一次。**依赖上一项** |
| `MAILAGENT_CHAT_QUEUED_INPUT` | `true` | Run 期间 Enter 入队，onFinish 后按序合并为信封自动发送（CHAT_DB v26） |
| `MAILAGENT_TRIGGER_V2` | `true` | `trigger_json` v2 envelope：多 Trigger OR / 单 Trigger 条件 AND / 稳定 ID / 单独启停 + per-trigger marker |
| `MAILAGENT_CALENDAR_TRIGGER` | `true` | 两个日历 trigger kind（业务字段变化 / 会前 N 秒）。运行前提 `CALENDAR_CALDAV_SYNC_ENABLED` |
| `MAILAGENT_SKILL_CREATOR` | `true` | 对话内把工作方法转成 Skill：草稿 → 校验 → 恒 ask 发布。🔴 草稿**永不执行**（三重强制，不受 flag 控制） |
| `MAILAGENT_AGENT_PLUGINS` | `true` | Agent Plugins 1.0 导入 / 导出 + 会前准备模板。🔴 导入强制 `enabled=false` 落地 |
| `MAILAGENT_MATTERS_ENABLED` | `true` | Matters / 事项总闸（2026-08-12 cutover）：一级导航 + 63 端点 + 13 件工具 |
| `MAILAGENT_MATTER_AGENT_ENABLED` | `false` | 事项跟进 Agent。有意保持关：**无人值守 + 有网络出口**。工具天花板按 class 推导，不按名单 |
| `MAILAGENT_INTERNAL_AGENT_TOOLS` | `true` | 主 agent 可读写四类**内建** agent 配置 + 事项跟进逐条配置。写工具恒 ask；白名单字段须有真实消费点 |
| `MAILAGENT_CONTACTS_ENABLED` | `false` | 通讯录总闸（灰度关）：L0/L1 扫描 + 端点面 + 一级导航 + gateway 读/轻写工具。身份判据只有归一 email。0819 起双载体 |
| `MAILAGENT_CONTACT_PROFILE_ENABLED` | `false` | 联系人 AI 画像 dream worker（WP6，DB v63）。AND 行 enabled；off 时读投影照常（unconfigured 态）；手动 refresh 只要求 env 开 |
| `MAILAGENT_CONTACT_AGENT_ENABLED` | `false` | 通讯录治理台（WP7，DB v64）：每日扫描 + 待审队列 + propose 三工具注入。场地天花板=第六 mode `contact_governance`（无 web/exec）。🔴 无人值守 + 消费邮件正文 |
| `FEISHU_NOTIFY_ENABLED` / `REDIS_EVENTS_ENABLED` / `ALERT_ENABLED` | `false` | 通知 / 事件消费 / 告警 |

必填项：**硬必填仅 `USER_EMAIL`**；`MAIL_ACCOUNT_NAME` 有默认 `Exchange` 但需与实际账户名一致；Notion 三键（`NOTION_TOKEN` / `EMAIL_DATABASE_ID` / `CALENDAR_DATABASE_ID`）**可选**，空 = 本地-only 模式。全部可调项见 [`.env.example`](./.env.example)。

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

一体化 Electron 前端 + 内嵌 CPython 后端 → 单个 macOS `.app`（Windows 侧 2026-08-17 owner 验收通过，已入正式发布轨）。**全部在 `main` 上做**（前端是 `frontend/` 子目录，非独立 repo）。完整 runbook（前置 / 构建 / 装机 / 自动更新 / 故障排查 / Windows 链）→ [`packaging/packaging-release.md`](./docs/reference/packaging/packaging-release.md)。

- **版本 SSoT** = `frontend/package.json` 的 `version`（electron-builder 据此写 Info.plist + 产物名 + 自更新 feed）。当前版本以该文件为准，本文**不再抄写**（抄一次就过时一次：2026-08-18 刚把 v1.2.1 更正为 v2.15.0，隔天就到了 2.16.0）。🔴 勿改 package.json 的 `name`（`mailagent-frontend`）——它决定 userData 目录。
- **发布流程**：bump `version` → 提交 → `git push origin main` → `git tag -a vX.Y.Z` → `git push origin vX.Y.Z` → CI 过测试闸后自动 build 并上传到一个 **draft** release → 🔴 **CI 完成后仍是 draft，必须转正式**（Actions → Promote release，或 `gh release edit vX.Y.Z --draft=false --latest`）。**不要**手动 `gh release create`（会与 CI 撞车）。正式发版的 Release 由 promote-release 自动附加 Windows 安装包 + `latest.yml`。
- 🔴 **头号坑①**：`frontend/resources/python` 缺失 → afterPack **跳过整个签名** → `.app` 无后端且 codesign FAIL。build 前必确认它在。
- 🔴 **头号坑② ABI**：`pnpm test` 本身就是 `rebuild:node && vitest run`，**跑一次前端测试就把 ABI 翻回 Node** → 因此 build 前**每一次**都要重新 `pnpm rebuild:electron`（不是一次性动作）。⚠️ `require('better-sqlite3')` **是无效探针**（`.node` 懒加载，ABI 对错都通过）；有效探针是 `process.dlopen` 双向验证，见 runbook。
- 🔴 **装机三步 `quit → ditto → open` 必串行单线** —— 重叠执行会产出 torn bundle（dyld library missing → SIGABRT，极易误判成「启动崩溃 / DB 版本 bug」）。
- 改 Python 后端后必先 `bash frontend/scripts/build-python-venv.sh` 重 provision 才进包；改 Python 依赖必重新生成 `requirements.lock.txt`（provision 只认 lock，漏了依赖改动不进包）。
- 要含远程 web（`mail.chenge.ink/app`）必先 `pnpm build:web`；`pnpm run build` **不含** SPA，漏跑则远程根返 `{"detail":"Not Found"}`（`build:mac` 已含，仅 `--dir` 路径需手动补）。
- **自动更新**自 v1.0.0 上线（packaged 默认开）。⚠️ 本地 `--dir` dogfood 包不含 `app-update.yml` 且通常未公证 → 无法自更新，且**装了 --dir 包 = 暂时脱离自更新轨道**，需再装一次正式包才恢复。

## 官网（公开 Landing + 101）

仓库根 `site/` 是独立的公开官网（Astro 6 + Starlight，独立 pnpm 项目，Cloudflare Pages `mailagent-site`，线上 **https://mailagent.chenge.ink**；与 CF Access 后的 `mail.chenge.ink/app` 是两套独立部署）。内容结构 / 设计 token / 命令 / 部署与 🔴 wrangler token 坑 → 动 `site/` 时自动加载 [`site/CLAUDE.md`](./site/CLAUDE.md)。

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
| `src/agent_config/` | Capability & Context 配置面（backend-owned `agent_config.db`）：统一 skill registry + Standing Context 文档 + history/rollback + 投影 + RULES 校验。配 `src/skills/installed.py` + `src/api/routers/agent.py` |
| `src/reports/` | 报告 Agent 系统（日/周/月 + custom）：19 种 ReportDoc 块的 Python canonical vocabulary（TS 镜像有跨语言闸）+ 取数/摘要/装配 + worker + store |
| `src/agents/` | Custom agent 内核 + 产品化：trigger 解析 / 两项预算 / tool policy / 幂等 enqueue / run_state 9 值读态 / 六能力卡。🔴 **档位向上取整**——显示的档恒 ⊇ 实际启用工具（闸 `frontend/tests/shared/customAgentCapabilities.test.ts`）。🔴 **重复失败纪律恒注入 manual + headless**（08-02 F4 拍板） |
| `src/matters/` | Matters/事项域（17 文件，`service.py` 独占 ~4600 行）：域服务单写面 / repository / run spec 与 worker / trigger envelope / 关注信号 / 资料身份归一 / 时间线。🔴 **三条入口安全姿态不同，不许合成一条路径**（创建带调研=纯读端点 / 定时跟进=headless run / 事项对话=交互式）。🔴 跟进 run 的 `allowedTools` 恒 `[]`、`grantExec` 永不写。🔴 v52 contact 索引独立常量**不进** `MATTER_INDEX_DDLS`（老库重放会炸）。🔴 时间线 `ON DELETE CASCADE`——永久删除的审计只能落日志 |
| `src/contacts/` | 通讯录域：taxonomy 枚举单源（TS 镜像有闸）/ L0+L1 增量扫描 / service 治理写面单源 / repository。身份判据**只有归一 email**（名字永不作自动合并判据）。🔴 三表 DDL 单源 `sync_store.py::CONTACT_TABLE_DDLS`，**不进** `MATTER_*_DDLS` |
| `src/stats_reporter.py` | 定期上报运行统计到远程看板 |
| `webhook-server/` | FastAPI（接收 Notion Automation webhook → Redis 路由 + 看板 API，端口 8100）|

## CLI

`mailagent` CLI = agent-friendly 接口，14 个 group：`email` / `admin` / `attachment` / `llm` / `kos` / `notion` / `calendar` / `debug` / `backfill` / `project-progress` / `init` / `folder` / `report` / `api-key`。读命令无 auth，写命令需 token（`MAILAGENT_CLI_API_KEY` + `--api-key`，`--dry-run` 跳过）。Batch 写命令有长任务契约（SIGINT 二次 / 熔断 / checkpoint resume / PM2 检测）+ 退出码体系（0/1/2/4/5/6/7/8/9/130）。

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
- **mailbox 判定/查询单源**：一律走 `src/mail/mailbox_semantics.py`（前端镜像 `frontend/src/shared/lib/mailboxSemantics.ts`）的常量/判定集/SQL 辅助，**禁止**新增 mailbox 字面量枚举比较（`== "发件箱"` 类，漏一种写法即静默 bug —— issue #42 C 案收敛，2026-07-17）。**列表/计数面**（含内建视图过滤、徽标聚合、view↔mailbox 映射）用 `filter_labels_for_mailbox()` / 前端 `mailboxFilterLabels()` 展开成变体集，**禁止**对内建 canonical 用 `= ?` 精确匹配（否则变体行在专属视图不可见、或徽标与列表口径分裂 —— issue #42 提交者后续反馈收敛，2026-07-20）；自定义文件夹维持精确匹配。两侧变体集成员由 `frontend/tests/shared/lib/mailboxSemantics.test.ts` 跨语言锁死，改集合两边同步
- 改会议检测：`src/mail/icalendar_parser.py` 或 `src/calendar_notion/description_parser.py`
- 加新配置：① `src/config.py` 加 Field → ② `.env.example` 加示例 → ③ 必要时更新本文件「关键开关现状」表
- **加新文档**（防再次乱套，完整规范见 [`docs/DOC-GUIDE.md`](./docs/DOC-GUIDE.md)）：先判类型 —— **常青参考**（描述系统"现在如何"、会反复读）放 `docs/reference/<子系统>/`，**且必须在上方「文档地图」加一行**（否则无人发现）；**过程产物**（handoff / complete / phaseN / prN / sprint / 验收 matrix / 交接 / dogfood）放 `.trellis/tasks/<task>/`，已成历史的归 `docs/archive/{年-月}/` —— **禁止堆回 `docs/` 顶层或 `docs/reference/`**。判据：*半年后还有人为"现在怎么回事"来读吗？* 是→reference，否→archive。
- SQLite schema 升级：用 `/db-migration` skill（bump DB_VERSION + idempotent migration + 一致性更新）。**bump `DB_VERSION` 必同步前端 `frontend/src/electron/main/backend_lifecycle.ts` 的 `EXPECTED_DB_VERSION`**（TS 手抄 Python 常量，漏改 → 打包 app 启动门控 `waitReady` 卡 120s 降级；判据已 `>=` 容错 + `frontend/tests/main/db_version_consistency.test.ts` 兜底）
- **改公共函数签名后必 grep 测试目录调用点**：`pnpm typecheck` 的 `tsconfig.web.json` **只 include `src/**`，不覆盖 `frontend/tests/`**，vitest 又用 esbuild 抹掉类型照跑 —— 所以「typecheck 绿」不代表测试里的调用点跟上了。危险形态是类型错了但运行时不抛，测试**保持绿**而功能静默失效（2026-08-18 排序批实例：第二参 `ReadonlySet<string>`→`readonly string[]` 后测试仍传 `new Set()`，而 `Set.forEach` 第二参是 value 不是 index → comparator 出 `NaN` → V8 稳定排序"碰巧"保持原序 ⇒ 排序完全没生效、两道闸全绿）。配套：**新断言要做变异验证**（把被测逻辑临时改坏确认会红再还原；恰好等于"未修改前行为"的期望值 = 恒绿装饰），变异一律用编辑工具单点改还原、**禁止脚本批量写源文件**。
- **跨边界手抄常量必建一致性闸**：一个常量 / 枚举 / 派生表 / 类型形状要在**第二处**手抄，先问能不能消灭镜像（单源导出 / **零依赖叶子模块** —— issue #68 一半工作量是这个，"不能 import 因为对方顶层拉了 electron/keytar/SyncStore" 的正解是下沉常量，不是照抄一份加句"同源"注释）；消灭不了才建闸。**现存二十闸（数量与清单以 internals 台账为准）**，边界不止语言（跨部署 `webhook-server` / 跨构件种类 Python↔JSON Schema / SQL `CHECK` 字符串 / 跨进程 main↔renderer 都算）。清单、canonical 源选法、**「抽取失败必须红」**、以及写抽取器的两个实战坑（部分抽取比抽不到更毒 / 同名结构不止一个）见 [`architecture/architecture-internals.md`](./docs/reference/architecture/architecture-internals.md)「跨语言手抄常量的一致性闸」。漏建 = 改一处漏一处、测试全绿运行时静默错。
- **改 agent 排程语义**（custom agent 定时触发 / 报告 Agent 排程 / 前端运行预览）：语义单源 = [`architecture/schedule-rule-contract.md`](./docs/reference/architecture/schedule-rule-contract.md)，**先改契约再两侧同步**；改完必跑黄金 fixture 闸（`pytest tests/agents/test_schedule_fixture.py tests/agents/test_schedule_rule.py` + `frontend` 的 `scheduleParity`），改实现忘了重新生成 fixture 会红。
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
