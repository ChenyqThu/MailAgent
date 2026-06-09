# CLAUDE.md

为 Claude Code 提供的项目指南。

> **本文件是精简索引** —— 只保留每个 session 必须在场的核心约束、导航、速查。
> 深度内容（架构内核、各子系统运维、CLI 全表）按需下沉到 `docs/claude/` 与 `docs/`，
> 需要时用「文档地图」里的指针去 `Read`，不要全量塞进 context。
> 改完某子系统的运行语义后，同步更新它在 `docs/claude/` 的下沉文档，别把流水账堆回这里。

## 通用指南

- 被要求做具体修改时，直接动手。不要花大量时间读文件或反复确认简单任务，偏向行动。
- macOS 环境下 **没有 sudo**，不要尝试 sudo 命令。
- 不要在嵌套 session 中做 CLI 更新或全局变更。
- 遇到环境问题时，优先检查已知的 macOS 限制（FDA 权限、symlink、沙盒）再尝试修复。

## 文档地图（渐进式加载索引）

| 主题 | 何时读 | 路径 |
|---|---|---|
| 架构内核（v3 流程 / 重试 / Processing Status / webhook / 线程 / Sprint15 outbox / Sprint16 dual-backend） | 改正/反向 sync、webhook、状态机前 | [`docs/claude/architecture-internals.md`](./docs/claude/architecture-internals.md) |
| LLM Agent（本地 LLM 分类，fallback / cache / 监控 / payload） | 改邮件分类、prompt、cache 前 | [`docs/claude/llm-agent.md`](./docs/claude/llm-agent.md) + [`docs/LLM_AGENT_SETUP.md`](./docs/LLM_AGENT_SETUP.md) |
| 项目周报同步（外挂模块，xlsx → Notion） | 动 `src/project_progress/` 前 | [`docs/claude/project-progress-sync.md`](./docs/claude/project-progress-sync.md) |
| 报告 Agent 系统（日/周/月报，ReportDoc 块模型 + 定时生成 + 前端渲染 + KOS 工具桥） | 动 `src/reports/` / 报告 / Custom AI Agents 区前 | [`docs/report-agent-prd.md`](./docs/report-agent-prd.md) + [前端 handoff](./docs/report-agent-frontend-handoff.md) |
| Calendar Module（CalDAV → SQLite SSoT） | 动日历同步 / `calendar_event` 表前 | [`docs/claude/calendar-ops.md`](./docs/claude/calendar-ops.md) + [`docs/calendar-module-prd.md`](./docs/calendar-module-prd.md) |
| v4 SQLite-SSoT（body/附件 SSoT + FTS5 全文搜索） | 动 `EmailRepository` / 双写 / 搜索前 | [`docs/claude/v4-ssot-ops.md`](./docs/claude/v4-ssot-ops.md) + [`docs/architecture_v4_sqlite_ssot.md`](./docs/architecture_v4_sqlite_ssot.md) |
| 后端服务层（统一写面：`src/services/` 应用服务 + CLI/serve-api 薄适配器 in-process + async-jobs + 双层鉴权 + 前端 daemon 转发） | 改写操作（flag/resync/archive/pin/llm/compose/send）/ 加传输端 / 动 `src/services/` 前 | [`docs/claude/service-layer-architecture.md`](./docs/claude/service-layer-architecture.md) + `~/.claude/plans/cli-streamed-brook.md` |
| AI Agent Harness + KOS（前端 chat 多轮 agent + 跨域知识图） | 动前端 chat / KOS 集成前 | [`docs/claude/agent-harness-kos.md`](./docs/claude/agent-harness-kos.md) + [`docs/kos-integration-design.md`](./docs/kos-integration-design.md) |
| V2.1 远程 chat + report/agent（B-pure-unified：一份引擎 `shared/chat` + 一份 serve-api + 一份 HttpChatPlatform；本地 token webRequest / 远程 CF cookie；cutover 后 chat 引擎跑 UI 进程） | 动远程 web chat / serve-api chat 端点 / chat 引擎 cutover 后语义前 | [`docs/claude/remote-chat-report-architecture.md`](./docs/claude/remote-chat-report-architecture.md) + [设计](./docs/v2.1-stage3-chat-platform-design.md) + [看板](./docs/v2.1-remote-chat-report-matrix.md) |
| CLI 完整命令表 + 退出码 + schema 契约 | 查命令明细 / 加 CLI 命令前 | [`docs/claude/cli-reference.md`](./docs/claude/cli-reference.md) + [`docs/agent-cli-rfc.md`](./docs/agent-cli-rfc.md) |
| 存档/草稿箱双入口（folder_sync） | 动 folder 同步前 | [`docs/folder-ui-prd.md`](./docs/folder-ui-prd.md) + [`docs/folder-next-session-handoff.md`](./docs/folder-next-session-handoff.md) |
| Compose 回复/转发 + SMTP 发送 | 动 compose / 发送前 | [`docs/compose-reply-forward-handoff.md`](./docs/compose-reply-forward-handoff.md) |
| 灵动岛 Ping Island 集成 | 动通知/ack 中心前 | `~/.claude/plans/ultrathink-session-curious-cloud.md` |
| 前端动效 + 列表性能铁律（Electron renderer：GSAP §8 动效 / snippet 懒取 / 线程批量 / 查询缓存 / 正文 iframe 链接） | 动前端列表/正文/动效前 | [`frontend/ARCHITECTURE.md`](./frontend/ARCHITECTURE.md) §7.1-7.2 + [`frontend/MOTION-PERF-HANDOFF.md`](./frontend/MOTION-PERF-HANDOFF.md) + [`frontend/docs/motion-gsap.md`](./frontend/docs/motion-gsap.md) |
| 桌面 App 打包 / 发布（一体化 .app + 版本号机制 + 签名闸 + 故障排查） | 出新版 / 发布 App 前 | [`docs/claude/packaging-release.md`](./docs/claude/packaging-release.md) |

技能（按需触发，正文不常驻）：`/deploy`（部署验证）、`/debug`（系统化排查）、`/health`（健康巡检）、`/db-migration`（schema 升级）、`/sprint-handoff`（交接文档）。

## 项目概述

**MailAgent** 是一个 macOS 邮件实时同步系统，将 Mail.app / Outlook 邮件同步到 Notion，支持：
- 邮件内容、附件、线程关系同步 + 会议邀请（iCalendar）→ 日程
- AI 分类与处理（本地 LLM / Notion Custom Agent）
- 双向 Flag 同步（Mail.app ↔ Notion，Sprint 15 起统一走 outbox + FanoutWorker 异步派发）
- 飞书应用机器人通知（重要邮件推送 + 交互式回复按钮 → Openclaw）
- Notion Webhook → Redis → Mail.app 实时事件驱动
- Office 附件自动转换（docx/pptx→PDF, xlsx→CSV）

**当前架构状态**（演进叠加，详见 [`docs/claude/architecture-internals.md`](./docs/claude/architecture-internals.md)）：
- **v3 SQLite-First**（2026-01）：`internal_id`（ROWID = AppleScript id）主键，`whose id is <int>` 查询比旧方式快 127 倍，支持 6-7 万封大邮箱。
- **Sprint 15 SQLite SSoT inversion**（2026-05）：所有 mutating 操作反转方向，SQLite 是写入 intent 聚合点，FanoutWorker 异步派发到 Mail.app + Notion，统一走 `email_outbox`。
- **Sprint 16 Dual-Backend**（2026-05-22 cutover）：抽象 `IMailBackend` Protocol，**davmail 模式为当前主路径**（IMAP/SMTP/CalDAV 桥 EWS），AppleScript 保留作 emergency fallback。
- **v4 SQLite-SSoT**（2026-05，Phase 1-4 已上线/灰度）：SQLite 是邮件正文 + 附件的 SSoT，Notion 退化为镜像，FTS5 全文搜索就位。

**死硬约束**：
- DavMail 当前用 Outlook for Windows well-known client_id 伪装（PoC），**不可上生产** —— 需走公司 IT 审批（推荐直接申请 Graph API）。
- EWS 2026-10-01 关停，DavMail 6.7 仍走 EWS，Graph 路线图（Issue #404）未 merge —— 见 [`docs/roadmap-post-cutover.md`](./docs/roadmap-post-cutover.md) §5.1。
- AppleScript fallback 路径**始终可用** —— 任何重构都必须保证 emergency 回切不丢数据（回切步骤见 architecture-internals.md）。

**技术栈**：Python ≥3.9（本地 3.11+，远程 webhook-server 3.9+）· AppleScript（fallback）· DavMail 6.7 JVM（主路径）· SQLite（状态 + v4 SSoT + FTS5）· Notion API · BeautifulSoup/lxml · Pydantic · Redis · FastAPI · LibreOffice headless · pandas + python-calamine。

## 关键开关现状（代码默认值；★ = 生产已偏离默认）

| 开关 | 代码默认 | 说明 |
|---|---|---|
| `MAILAGENT_BACKEND` | `applescript` | ★ 生产 = `davmail`（Sprint 16 cutover 后） |
| `MAILAGENT_OUTBOX_ENABLED` | —（Sprint 15 灰度） | false 时 handler + reverse_sync 退回老 AppleScript 直调 |
| `BODY_DUAL_WRITE_ENABLED` | `true` | v4 双写总开关；失败仅 warning 不阻断 |
| `NOTION_READ_FROM_SQLITE` | `false` | v4 Phase 4 灰度；切 true 后 sync/resync 走 SQLite SSoT，miss fallback |
| `LLM_AGENT_ENABLED` | `false` | 本地 LLM 分类总开关（启用前必看 llm-agent.md 防双跑） |
| `CALENDAR_CALDAV_SYNC_ENABLED` | `false` | CalendarSyncWorker 总开关 |
| `SYNC_FOLDERS` | `[]`（空） | 多文件夹同步白名单（JSON 数组的 imap_name，davmail-only）；空=零激活=逐字节同现状；勾选的自定义 Exchange 文件夹走 `email_metadata` 主链路（AI/Notion/FTS/线程/写操作全等同收件箱）。配套 `FOLDER_NOTIFY_ENABLED`（自定义文件夹默认不推飞书，JSON 白名单 opt-in）/ `FOLDER_LLM_DISABLED`（默认全跑 LLM，JSON 黑名单可关）/ `FOLDER_SYNC_PAST_DAYS`(90) / `FOLDER_SYNC_MAX_MESSAGES`(2000)。详见 architecture-internals.md「多文件夹同步」 |
| `PROJECT_PROGRESS_SYNC_ENABLED` | `false` | 项目周报 CLI + 钩子总开关 |
| `MAILAGENT_AGENT_HARNESS` | `false` | 前端 chat 多轮 agent（M1 已 ship 未 dogfood） |
| `MAILAGENT_KOS_INGEST_ENABLED` / `_CONSUMER_ENABLED` / `_L1_HOT_BLOCK_ENABLED` | `false` | KOS 集成三层，全默认 OFF |
| `MAILAGENT_REPORT_AGENT_ENABLED` | `false` | 报告 Agent worker（日/周/月报，`src/reports`）；per-agent 还需 `report_agent.enabled`（种子 daily 默认关） |
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

一体化 Electron 前端 + 内嵌 CPython 后端 → 单个 macOS `.app`。**全部在 `main` 上做**（前端是 `frontend/` 子目录，非独立 repo/submodule；打包/onboarding/auto-update 已全合入 main，feature 分支已删）。完整 runbook → [`docs/claude/packaging-release.md`](./docs/claude/packaging-release.md)。

- **版本 SSoT** = `frontend/package.json` 的 `version`（electron-builder 据此写 `Info.plist` + 产物名 + auto-update feed `latest-mac.yml`）。流程：bump version → build → 装机验证 → `git tag -a vX.Y.Z`。semver：`0.1.0`=首个 beta，bug 修复走 patch。已发至 **v0.5.0**（GitHub Releases published + 完整 feed 产物，对外发布流程=`pnpm build:mac` → push main+tag → `gh release create` 传 5 件产物：latest-mac.yml + zip/dmg + 各自 blockmap）。**🔴 勿改 package.json `name`（`mailagent-frontend`）**—— 它决定 userData 目录 `~/Library/Application Support/mailagent-frontend/`，改了已装用户数据/`.env` 易主。
- **前置**（`frontend/` 下，均 gitignored 本地产物）：`node_modules`（`pnpm install`）+ `resources/python`（`bash scripts/build-python-venv.sh`，~200M 可重定位嵌入式 CPython；本机已 provision，换机/新 clone 必先跑）。
- **构建**：本地装用 `pnpm run build && npx electron-builder --dir --arm64`（只出 `.app`，避开 flaky 的 dmg）；完整 feed 产物（dmg+zip+blockmap+latest-mac.yml）用 `pnpm build:mac`。**🔴 要含远程 web（`mail.chenge.ink/app`）必先 `pnpm build:web`**（出 `out/web` → electron-builder `from: out/web` 打进 `.app/Resources/web` → serve-api 经 `MAILAGENT_SPA_DIR` mount `/app`）；`pnpm run build` **不含** web SPA，漏跑则远程根 `/` 返 `{"detail":"Not Found"}`（`build:mac` 已含 `build:web`，仅 `--dir` 装机路径需手动补 `pnpm build:web &&`）。
- **🔴 头号坑①（python）**：`resources/python` 缺失 → afterPack（`scripts/afterPack.cjs`）**跳过整个签名** → `.app` 无后端 + `codesign` FAIL。build 前必确认它在。
- **🔴 头号坑②（ABI，0.2.3 踩过）**：build 前**绝不跑 `pnpm rebuild:node`**（把 better-sqlite3 编成 Node ABI）；electron-builder `npmRebuild:false` **不自动切回 Electron ABI** → 装进 app 的 `better_sqlite3.node` ABI 不匹配 → 所有 SQLite IPC（`email:listEnriched`）崩（renderer 报 `NODE_MODULE_VERSION`、界面全空）+ `probeDbReady` 失败致启动卡 120s。**跑过单测（`pnpm test` 含 rebuild:node）后 build 前必 `pnpm rebuild:electron`**。验证：`ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -e "require('better-sqlite3')"`（不报错=对）。
- **验证**（每次 build 后）：`codesign --verify --deep --strict <app>` 必 OK + `Info.plist` 版本号对 + `Resources/python/bin/python3.11` 在。
- **装机/升级**：退出旧 app → `ditto dist/mac-arm64/MailAgent.app /Applications/` → open。userData 跨重装保留 → 升级**跳过 onboarding**（detect `'configured'`）+ 后端启动自动 DB 迁移。用 `.app` 时 pm2 `mail-sync` 必须停（防双写）；davmail 用户 `davmail-poc` 留 pm2（EWS 桥，不打进 app）。
- **改 Python 后端**后：必先 `bash frontend/scripts/build-python-venv.sh` 重 provision 才进包；只改前端 TS/CSS 不用。
- **自动更新**仍卡 Developer ID 签名（ad-hoc `quitAndInstall` 装不上更新，`AUTO_UPDATE_ENABLED` 默认关）→ 现走手动替换；P6 见 [`docs/packaging/05-auto-update-handoff.md`](./docs/packaging/05-auto-update-handoff.md)。

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
| `health_check.py` | 健康检查（发现遗漏邮件） |
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
| `src/reports/` | 报告 Agent 系统（日/周/月报）：`models`(ReportDoc 块模型) / `data`(取数+分组) / `summarizer`(LLM tool_use) / `assembler`(防幻觉权威回填) / `worker`(tick_loop 定时) / `store`(report_agent+report 表)。见 [`docs/report-agent-prd.md`](./docs/report-agent-prd.md) |
| `src/stats_reporter.py` | 定期上报运行统计到远程看板 |
| `webhook-server/` | FastAPI（接收 Notion Automation webhook → Redis 路由 + 看板 API，端口 8100）|

## CLI

`mailagent` CLI = agent-friendly 接口，10 个 group：`email` / `admin` / `attachment` / `llm` / `notion` / `calendar` / `debug` / `backfill` / `project-progress` / `init`。读命令无 auth，写命令需 token（`MAILAGENT_CLI_API_KEY` + `--api-key`，`--dry-run` 跳过）。Batch 写命令有长任务契约（SIGINT 二次 / 熔断 / checkpoint resume / PM2 检测）+ 退出码体系（0/1/2/4/5/6/7/8/9/130）。

**完整命令表 / 退出码 / schema 契约 / 调用样例** → [`docs/claude/cli-reference.md`](./docs/claude/cli-reference.md)。

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
- SQLite schema 升级：用 `/db-migration` skill（bump DB_VERSION + idempotent migration + 一致性更新）。**bump `DB_VERSION` 必同步前端 `frontend/src/electron/main/backend_lifecycle.ts` 的 `EXPECTED_DB_VERSION`**（TS 手抄 Python 常量，漏改 → 打包 app 启动门控 `waitReady` 卡 120s 降级；判据已 `>=` 容错 + `frontend/tests/main/db_version_consistency.test.ts` 兜底）

## 文件位置

- 日志：`logs/sync.log` · 数据库：`data/sync_store.db` · 附件：`data/attachments/{internal_id}/` · 临时附件：`/tmp/email-notion-sync/{md5}/` · 配置：`.env`（示例 `.env.example`）
- 优化文档：`docs/applescript_id_optimization.md` · Webhook Server：`webhook-server/`（一键部署 `./scripts/deploy-webhook.sh`）
- 下沉的深度文档：`docs/claude/` · 设计/handoff 文档：`docs/`

## 迁移与运维

```bash
# v3 架构迁移（v2 → internal_id 主键）
python3 scripts/migrate_sync_store_v3.py

# 监控重点
sqlite3 data/sync_store.db "SELECT sync_status, COUNT(*) FROM email_metadata GROUP BY sync_status"
sqlite3 data/sync_store.db "SELECT internal_id, sync_status, retry_count FROM email_metadata WHERE sync_status IN ('fetch_failed','failed')"
```

各子系统的运维 SQL / 验收命令 / 回滚开关 见对应下沉文档（见「文档地图」）。
