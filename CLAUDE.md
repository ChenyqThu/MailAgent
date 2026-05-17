# CLAUDE.md

为 Claude Code 提供的项目指南。

## 通用指南

- 被要求做具体修改时，直接动手。不要花大量时间读文件或反复确认简单任务，偏向行动。
- macOS 环境下 **没有 sudo**，不要尝试 sudo 命令。
- 不要在嵌套 session 中做 CLI 更新或全局变更。
- 遇到环境问题时，优先检查已知的 macOS 限制（FDA 权限、symlink、沙盒）再尝试修复。

## 调试流程

调试服务（PM2、gateway、bots）时，按此顺序排查：

1. **进程存活**：`pm2 status` 确认进程 online
2. **环境变量/密钥**：检查 `.env` 中 token/secret 是否有效
3. **网络/代理**：检查 Redis 连接、webhook URL、代理设置
4. **日志**：`pm2 logs <name> --lines 30 --nostream` 查看具体错误
5. **数据库**：`sqlite3 data/sync_store.db` 检查状态分布

**不要**：
- 尝试 `sudo` 或交互式命令
- 在没检查基础项的情况下就改代码
- 用错误的 SSH 凭证重试（本项目 SSH 公钥认证：`~/.ssh/id_ed25519`）

## 部署验证

部署任何代码变更后，**必须**验证服务正常：

```bash
# 1. 重启并等待
pm2 restart <name> && sleep 3

# 2. 确认进程状态
pm2 status

# 3. 检查启动日志（无 error）
pm2 logs <name> --lines 20 --nostream

# 4. 检查关键组件
# - Redis consumer 已连接
# - SQLite 雷达正常
# - Webhook handler 已注册
```

不要假设部署成功 —— Pydantic schema 变更、handler 未注册、依赖缺失都可能导致静默失败。

## 项目概述

**MailAgent** 是一个 macOS 邮件实时同步系统，将 Mail.app 邮件同步到 Notion，支持：
- 邮件内容、附件、线程关系同步
- 自动识别邮件中的会议邀请（iCalendar）并创建日程
- AI 分类与处理（通过 Notion）
- 双向 Flag 同步（已读/旗标状态 Mail.app ↔ Notion）
- 飞书应用机器人通知（重要邮件推送 + 交互式回复按钮 → Openclaw）
- Notion Webhook → Redis → Mail.app 实时事件驱动
- Office 附件自动转换（docx/pptx→PDF, xlsx→CSV）并作为额外附件上传

**架构版本：v3 SQLite-First**（2026-01 优化）
- 使用 `internal_id`（SQLite ROWID = AppleScript id）作为主键
- AppleScript 查询性能提升 **127 倍**（~1s vs ~100s）
- 支持大邮箱（6-7 万封邮件）

**技术栈：**
- Python >=3.9（本地开发 3.11+，远程 webhook-server 3.9+）
- AppleScript（Mail.app 交互）
- SQLite（状态存储 + 变化检测）
- Notion API（notion-client）
- BeautifulSoup/lxml（HTML 解析）
- Pydantic（配置管理）
- Redis（Notion→Mail 事件队列）
- FastAPI（Webhook Server）
- LibreOffice headless（Office→PDF 转换）
- pandas + python-calamine（xlsx→CSV 转换）

## CLI（v4 Phase 5 起接管 scripts/*，PR-5 全部 inline 已上线）

`mailagent` CLI 提供 agent-friendly 接口给本机调用 / 外部 agent / 看板。底层走 `src/cli/`（typer + rich），所有数据从 SQLite SSoT（`data/sync_store.db`）+ EmailRepository 读，写命令调 NotionSync。

**安装**：
```bash
pip install -e ".[cli,dev]"     # cli: typer/rich/pyyaml; dev: pytest + jsonschema>=4.18 + referencing
which mailagent                  # 应是 venv/bin/mailagent
mailagent --version              # 3.0.0
mailagent --help                 # 列 10 个 group (email/admin/attachment/llm/notion/calendar/debug + backfill/project-progress/init) + global flags
```

**当前 (PR-5) 支持的命令** — 10 个 group（全部 inline，PR-5 起 5 个 stub 接通 + 7 个 subprocess wrap 改 inline，scripts/* 加 DeprecationWarning + dev/archive 子目录归位）：

读命令（只读, 无 auth）：

| 命令 | 说明 |
|---|---|
| `email get <internal_id> [--include {body,attachments,all}]` | 读单封 metadata + 可选 body/attachments |
| `email list [--mailbox/--status/--since/--from/--subject/--is-read/--is-flagged/--has-notion/--limit/--offset]` | 列表 (text 表格 / json wrapper / ndjson 流) |
| `email body <internal_id> [--format {markdown,html,raw}]` | 邮件正文（markdown 默认；raw 仅哈希） |
| `email search <query> [--mailbox/--since/--until/--limit/--no-snippet]` | FTS5 全文搜索 |
| `admin stats [--section]` | 服务统计 (PR-2 仅 sync_store live_query; 其余 _source: not_implemented_in_pr2) |
| `admin health` | SQLite 可达 + db_version + 必备表检查 (exit 0/1) |
| `admin db-version` | 打印 db_version + expected + compatible |
| `attachment list <internal_id>` | 列邮件附件（含 derived） |
| `attachment download <attachment_id> [--dest PATH]` | 默认 stdout 二进制 / --dest 写文件返回 JSON 元信息 |
| `llm selftest` | LLM gateway 健康检查（不烧 token） |
| `llm stats [--days N]` | llm_processing 表统计 (status / cost / cache hit / latency) |
| `llm compare-paths [--count N \| --internal-ids LIST] [--dry-run/--no-dry-run] [--yes]` | R-15 灰度质量闸（PR-5 真实现：默认 dry-run + cost preview，实跑 `--no-dry-run --yes` 双路径 diff AILabels） |
| `notion page-orphans --dry-run` | 扫 Notion 有 page 但本地无 metadata 的孤儿（PR-5 加 `--archive-orphan-pages` / `--insert-stub-metadata` 真修复） |
| `notion file-link-audit [--internal-id N] --dry-run` | 审计 email_attachment.notion_file_id 状态（PR-5 加 `--no-dry-run --yes` 真修复：NULL → upload） |
| `calendar expand [--horizon-weeks W] [--dry-run/--no-dry-run]` | PR-5 真实现：单次 expansion tick（取代 main.py loop 触发；逻辑抽到 `src/calendar_notion/expansion.py:run_expansion_tick`） |
| `calendar recurring discover [--since DATE]` | 扫 SyncStore 找带 RRULE 的邀请 |
| `debug email-source <internal_id> [--save-to PATH]` | 打印 / 保存 raw MIME（AppleScript 重抽） |
| `debug mail-structure` | 列 Mail.app accounts + mailboxes |
| `debug inline-images <internal_id>` | 分析 cid: 引用 vs attachment 行 |
| `debug applescript-fetch <internal_id> [--mailbox X]` | 仅跑 AppleScriptArm.fetch（绕 SQLite SSoT） |
| `debug notion-page <page_id>` | Notion API 拉 page properties summary |

写命令（需 auth；`--dry-run` 跳过；PR-4 起所有 batch 写命令默认走 PM2 检测，可 `--allow-concurrent` 绕过）：

| 命令 | 说明 |
|---|---|
| `email resync <internal_id\|--range LO-HI\|--ids 1,2,3> [--dry-run/--replace-existing/--no-parent/--max-failures/--resume-from/--progress-every/--allow-concurrent]` | 重传到 Notion（PR-4 batch + 长任务契约：SIGINT 二次 / 熔断 / checkpoint resume / PM2 检测） |
| `attachment derive <internal_id> [--dry-run]` | PR-5 alias → `backfill derivatives` (deprecation warning + `data.deprecated_alias=true`) |
| `attachment cleanup-orphans [--no-dry-run --yes]` | 删 data/attachments 下孤儿目录 |
| `backfill body [--since-date/--until-date/--mailbox/--internal-ids/--all/--limit/--force/--dry-run/--resume-from/--retry-dead]` | v4 历史邮件正文 backfill (PR-5 inline + LongTaskContext: 真 max-failures / checkpoint resume / SIGINT 二次 / dead-letter 表) |
| `backfill derivatives [--internal-id N --dry-run]` | v4 衍生附件 (docx→PDF / xlsx→CSV) 补齐 (PR-5 inline) |
| `project-progress sync [--internal-id/--all-history/--limit/--sheets/--dry-run/--force/--backfill-project-start/--first-migration-dry-run]` | 项目周报同步 (PR-5 inline 直调 ProjectProgressRunner) |
| `init {fetch-cache,analyze,fix-properties,fix-critical,update-parents,sync-new,all} [...]` | 初始化同步 7 个 sub-action (PR-5 inline 直调 InitialSync) |
| `llm run <internal_id> [--dry-run/--force/--no-overwrite]` | 单封 LLM 分类 + Notion 写 AI 字段 |
| `llm retry-failed [--limit N --dry-run]` | 跑 LLM retry queue |
| `notion resync <internal_id>` | alias of `email resync` |
| `notion update-flag <internal_id> [--is-read/--is-flagged/--processing-status]` | 手改 Notion 邮件页 flags |
| `notion archive <page_id> --yes` | archive Notion page (move to Trash) |
| `calendar recurring replay [--internal-id N \| --ids LIST --dry-run]` | 重跑指定 internal_id 的邀请 |
| `admin dead-letter list [--limit/--mailbox]` | 列 dead_letter 邮件 (PR-4 读命令, 无 auth) |
| `admin dead-letter retry <internal_id>` | 重置 dead_letter 为 pending (PR-4) |
| `admin cleanup-deadletter [--older-than N --no-dry-run --yes]` | 清理超 N 天的 dead_letter (PR-4, 内置) |
| `admin cleanup-syncstore [--no-dry-run --yes]` | dry-run → show_stats; --no-dry-run --yes → reset_sync_status (PR-5 inline) |
| `admin cleanup-duplicates [--no-dry-run --yes]` | 扫 message_id 重复的 Notion page → archive 重复 (PR-5 inline) |
| `admin repair-parents [--thread-id ID --no-dry-run --yes]` | 修复 Notion Parent Item 断链 (PR-5 inline NotionDBCleaner.run parent_only=true) |

**PR-4 长任务退出码体系**（RFC §5.2 / `email resync` batch / `backfill` / `init`）：

| 退出码 | 含义 | 触发 |
|---|---|---|
| `0` | 全成功 | 所有 unit `passes: true`，无 failed |
| `6` | partial_failure | 同时 succeeded > 0 + failed > 0，未熔断 |
| `7` | aborted (`E_ABORTED`) | SIGINT 第一次（当前 unit 跑完后退） |
| `8` | max-failures (`E_MAX_FAILURES`) | 连续失败超 `--max-failures` 熔断 |
| `9` | pm2 conflict (`E_PM2_RUNNING`) | PM2 mail-sync 正 online，写命令拒绝 |
| `130` | SIGINT 二次强退 | 在 abort summary 阶段再按 Ctrl-C |

Batch 命令自动写 `cli_checkpoints` 表（每 N=50 unit）；中断后用同 `<command, target_key>` 再跑会自动 resume，从 `last_completed_internal_id+1` 续。

**全局 flags**（写在 subcommand **之前**，例 `mailagent -o json email get 53675`）：`-o/--output {text,json,yaml,ndjson}` / `-q/--quiet` / `-v/--verbose` / `--db-path` / `--api-key` / `--config` / `--no-color` / `--version`。每个 leaf 也暴露 `-o` 供 gh/kubectl 风格的"flag 后置"使用。

**写命令鉴权**（RFC §5.3）：默认要 token。设 `MAILAGENT_CLI_API_KEY` 后写命令必须经 `--api-key` 提供同值；服务端未配且 `MAILAGENT_CLI_ALLOW_UNAUTH_WRITES=true` 时显式放行（仅 dev 模式）。`--dry-run` 跳过鉴权。

**JSON Schema 契约**：[`docs/cli-schema/`](./docs/cli-schema/) 含 45+ schema 文件（含 `_common.schema.json`）+ `error-codes.md` 列 11 个 `E_*` enum（PR-4 新增 `E_MAX_FAILURES` / `E_PM2_RUNNING`）。所有 wrapper 形如 `{status, schema_version: 1, data | error, meta: {duration_ms, ...}}` (RFC §5.1.2)。

**详细 spec**：[`docs/agent-cli-rfc.md`](./docs/agent-cli-rfc.md) §4 / §5 / §6 / §7 + [`docs/archive/pr5-handoff-scripts-migration.md`](./docs/archive/pr5-handoff-scripts-migration.md) + [`docs/archive/pr6-handoff-deprecation-cleanup.md`](./docs/archive/pr6-handoff-deprecation-cleanup.md)。**PR-6 已 ship**: 6 个真 thin wrapper 顶层脚本 git rm（backfill_email_body / backfill_derivatives / sync_project_progress / compare_llm_path / run_llm_on_email / resync_notion），5 个 CLI 依赖 module 删 `__main__` 入口保留 class/函数作 import-only（initial_sync / cleanup_syncstore / cleanup_duplicate_message_ids / cleanup_notion_db / replay_recurring_invite）。旧用法 `python scripts/<wrapper>.py …` 现报 `No such file or directory`；改走 `mailagent <group> <action> …` CLI。DB_VERSION 仍 6，10 个 CLI group / 45+ schema / 退出码体系（0/1/2/4/5/6/7/8/9/130）不变。pytest 655 passed。

**典型 agent 调用样例**：
```bash
mailagent -o json email get 53675 | jq .data.subject
mailagent -o json email search "redis timeout" --mailbox 收件箱 --limit 20 \
  | jq '.data[] | {id: .internal_id, snippet}'
mailagent attachment list 53675 -o json | jq '.data | length'
mailagent attachment download 1024 --dest /tmp/out.pdf -o json
mailagent llm selftest -o json | jq .data.healthy
mailagent llm stats --days 7 -o json | jq .data.cost.cache_hit_rate_pct
mailagent notion file-link-audit --internal-id 53675 -o json
mailagent calendar recurring discover --since 2026-04-01 -o json
mailagent debug mail-structure -o json
mailagent email resync 53675 --dry-run -o json
mailagent admin health -o json | jq .data.healthy
```

## 命令速查

```bash
# 环境准备
source venv/bin/activate
pip install -r requirements.txt

# 测试
python3 scripts/dev/test_notion_api.py  # Notion 连接（dev harness）
python3 scripts/dev/test_mail_reader.py # 邮件读取（dev harness）
mailagent debug mail-structure          # 查看邮箱名称

# 初始化同步（PR-6 起改走 CLI；旧 python scripts/initial_sync.py 已删 __main__）
mailagent init fetch-cache --inbox-count 3000 --sent-count 500
mailagent init analyze
mailagent init all --yes

# 运行服务
python3 main.py                         # 前台运行
pm2 start main.py --name mail-sync --interpreter ./venv/bin/python3  # PM2（必须用 venv python）

# 日志
tail -f logs/sync.log

# 部署 webhook-server 到远程服务器
./scripts/deploy-webhook.sh

# 远程服务器 venv 初始化（首次部署或升级 Python 后）
# ssh 到远程后: cd /home/lighthouse/MailAgent/webhook-server && python3 -m venv venv
```

### 部署环境

| 环境 | Python 版本 | 用途 |
|------|-----------|------|
| 本地 macOS | 3.11+ | main.py 邮件同步主服务 |
| 远程 VPS (170.106.181.89) | 3.9+ | webhook-server FastAPI 服务 |

> `pyproject.toml` 声明 `requires-python = ">=3.9"`，代码已兼容 Python 3.9+。

## 架构

### v3 SQLite-First 架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        v3 架构 (SQLite 优先)                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. SQLite Radar 检测 (~5ms)                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ 检测 max_row_id 变化 → 直接获取新邮件元数据（含 internal_id）        │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              ▼                                              │
│  2. 写入 SyncStore (internal_id 主键, message_id=NULL)                     │
│                              │                                              │
│                              ▼                                              │
│  3. AppleScript 获取完整内容 (~1s/封，使用 `whose id is <int>`)            │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ fetch_email_content_by_id(internal_id, mailbox)                      │   │
│  │ → 返回 message_id, source, thread_id 等                              │   │
│  │ → 更新 SyncStore (填充 message_id)                                   │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              ▼                                              │
│  4. 同步到 Notion                                                          │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ - 解析 MIME 源码（HTML、附件、内联图片）                             │   │
│  │ - 检测会议邀请 (.ics) → 创建日程                                     │   │
│  │ - 创建 Notion 邮件页面（含线程关系）                                 │   │
│  │ - 标记 sync_status='synced'                                          │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  5. 失败重试（统一在 email_metadata 表）                                   │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ - fetch_failed: AppleScript 失败 → 用 internal_id 重试               │   │
│  │ - failed: Notion 失败 → 用 internal_id 重新获取并同步                │   │
│  │ - 指数退避: 1min, 5min, 15min, 1h, 2h                                │   │
│  │ - 超过最大重试 → dead_letter 状态                                    │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 性能对比

| 查询方式 | 耗时 | 说明 |
|---------|------|------|
| `whose message id is "<字符串>"` | ~100 秒 | 旧方式，线性搜索 |
| `whose id is <整数>` | ~1 秒 | **v3 方式，提升 127 倍** |

### 模块说明

#### 邮件模块 (`src/mail/`)

| 模块 | 职责 |
|------|------|
| `new_watcher.py` | 主监听器，v3 架构主循环（SQLite 优先） |
| `sqlite_radar.py` | SQLite 雷达：检测变化 + `get_new_emails()` 获取元数据 |
| `applescript_arm.py` | AppleScript 机械臂：`fetch_email_content_by_id()` 核心方法 |
| `applescript.py` | AppleScript 底层执行封装 |
| `sync_store.py` | SQLite 同步状态存储（**internal_id 主键**，v3 架构） |
| `reader.py` | MIME 邮件解析（HTML、附件、thread_id） |
| `meeting_sync.py` | 会议邀请检测与同步 |
| `icalendar_parser.py` | iCalendar 解析器 |
| `health_check.py` | 健康检查（发现遗漏邮件） |
| `reverse_sync.py` | 反向同步（Notion → Mail.app + 飞书通知 + Processing Status 更新） |

#### 通知模块 (`src/notify/`)

| 模块 | 职责 |
|------|------|
| `feishu.py` | 飞书应用机器人通知（App Bot API + Card 2.0 form 交互：可编辑回复、修改意见、附加收件人/抄送，回调 Openclaw） |
| `alert.py` | 飞书告警机器人（群聊 Webhook Bot，可配置级别/冷却/卡片样式） |

#### 监控模块 (`src/`)

| 模块 | 职责 |
|------|------|
| `stats_reporter.py` | 定期上报运行统计到远程看板（sync/reverse/handlers/alerts） |

#### 事件模块 (`src/events/`)

| 模块 | 职责 |
|------|------|
| `redis_consumer.py` | Redis BLPOP 队列消费者（自动重连） |
| `handlers.py` | Webhook 事件处理器（flag_changed / ai_reviewed / completed / create_draft / query_mail / fetch_mail_content / page_updated） |

#### Webhook Server (`webhook-server/`)

| 模块 | 职责 |
|------|------|
| `app.py` | FastAPI 服务，接收 Notion Automation webhook → Redis 队列路由 + 看板 API |
| `dashboard.html` | 监控看板前端（同步概览、服务状态、告警、Redis 队列） |
| `ecosystem.config.js` | PM2 进程配置（端口 8100） |
| `deploy.md` | 服务器部署指南 |
| `../scripts/deploy-webhook.sh` | 一键部署脚本（`sshpass` + SSH） |

**远程服务器**：`ubuntu@170.106.181.89`，路径 `/opt/MailAgent/webhook-server`，PM2 进程名 `mailagent-webhook`。SSH 认证：公钥（`~/.ssh/id_ed25519`）。

#### Notion 模块 (`src/notion/`)

I-07 拆分后（commit `76abc45`）：`NotionSync` 是 facade，业务逻辑分到 4 个子模块。public API 12 个调用点和构造签名 `NotionSync(*, email_repo, sync_store)` 不变。

| 模块 | 行数 | 职责 |
|------|------|------|
| `client.py` | 427 | Notion API 封装（文件上传、页面操作） |
| `sync.py` | 409 | `NotionSync` facade：构造 4 个子组件 + delegate 所有 public/quasi-public method；R-06 `__new__`/monkeypatch 兼容 hook |
| `pages.py` | 1145 | `PageOps` — 页面 CRUD + v4 SSoT 桥接 + `create_email_page_v2` 灰度路由（含 R-06 record 调用）|
| `threads.py` | 281 | `ThreadOps` — `handle_thread_relations` + `update_sub_items` + 线程查询 helpers |
| `queries.py` | 378 | `QueryOps` — 批量查询 (`query_all_message_ids/row_ids/...`) + reverse sync 写入 (`update_email_flags/update_page_mail_sync_status`) + `update_parent_item` |
| `_common.py` | 122 | `BEIJING_TZ` / `CreateEmailFromSqliteResult` / `RolloutMetrics`（facade 与 `PageOps` 共享同实例，lazy init 兼容测试 `__new__` bypass）|

调用约定：所有外部模块仍 `from src.notion.sync import NotionSync, CreateEmailFromSqliteResult, BEIJING_TZ`；不要直接 import `PageOps/ThreadOps/QueryOps`（内部组件）。

#### 日历模块 (`src/calendar_notion/`)

| 模块 | 职责 |
|------|------|
| `sync.py` | 日历事件同步到 Notion |
| `description_parser.py` | Teams 会议信息提取 |

#### 转换模块 (`src/converter/`)

| 模块 | 职责 |
|------|------|
| `html_converter.py` | HTML → Notion Blocks（含内联图片） |
| `eml_generator.py` | 生成 .eml 归档文件 |
| `office_converter.py` | Office 附件转换（docx/pptx→PDF via LibreOffice, xlsx→CSV via pandas） |

### 关键流程

#### 1. 新邮件检测与同步（v3 架构）

```python
# new_watcher.py
async def _poll_cycle():
    # 1. SQLite 雷达检测变化
    has_new, current_max, estimated = radar.check_for_changes(last_max_row_id)

    if has_new:
        # 2. SQLite 直接获取新邮件元数据（含 internal_id）
        new_emails = radar.get_new_emails(since_row_id=last_max_row_id)

        # 3. 立即写入 SyncStore（internal_id 主键，message_id=NULL）
        for email_meta in new_emails:
            sync_store.save_email({
                'internal_id': email_meta['internal_id'],
                'message_id': None,  # AppleScript 成功后填充
                'sync_status': 'pending',
                ...  # SQLite 元数据
            })

        # 4. 更新 last_max_row_id
        sync_store.set_last_max_row_id(current_max)

    # 5. 处理 pending 邮件
    await _process_pending_emails()

    # 6. 处理重试队列
    await _process_retry_queue()

async def _sync_single_email_v3(email_meta):
    internal_id = email_meta['internal_id']
    mailbox = email_meta['mailbox']

    # 1. AppleScript 通过 internal_id 获取（快速 ~1s）
    full_email = arm.fetch_email_content_by_id(internal_id, mailbox)

    # 2. 更新 SyncStore（填充 message_id、thread_id）
    sync_store.update_after_fetch(internal_id, {
        'message_id': full_email['message_id'],
        'thread_id': full_email['thread_id'],
        ...
    })

    # 3. 检测会议邀请
    if meeting_sync.has_meeting_invite(full_email['source']):
        calendar_page_id = await meeting_sync.process_email(...)

    # 4. 日期过滤
    if email_date < sync_start_date:
        sync_store.mark_skipped(internal_id)
        return

    # 5. 同步到 Notion
    email_obj = reader.parse_email_source(full_email['source'], ...)
    page_id = await notion_sync.create_email_page_v2(email_obj)

    # 6. 标记成功
    sync_store.mark_synced_v3(internal_id, page_id)
```

#### 2. 线程关系处理

```python
# notion/sync.py
async def _find_or_create_parent(email, thread_id):
    # 1. 查找现有 Parent（通过 message_id）
    parent = await query_by_message_id(thread_id)
    if parent:
        return parent['page_id']

    # 2. 检查缓存（线程头找不到）
    if sync_store.is_thread_head_not_found(thread_id):
        return await _use_fallback_parent(thread_id)

    # 3. 尝试获取线程头邮件
    thread_head = arm.fetch_email_by_message_id(thread_id)
    if thread_head:
        parent_page_id = await sync_email(thread_head)
        return parent_page_id

    # 4. 标记为找不到，使用 fallback
    sync_store.mark_thread_head_not_found(thread_id)
    return await _use_fallback_parent(thread_id)
```

#### 3. 重试机制（统一处理）

```python
# new_watcher.py
async def _process_retry_queue():
    # 获取可重试邮件（fetch_failed 或 failed）
    ready_emails = sync_store.get_ready_for_retry(limit=3)

    for record in ready_emails:
        internal_id = record['internal_id']
        mailbox = record['mailbox']

        # 统一用 internal_id 获取 MIME（无论哪种失败）
        full_email = arm.fetch_email_content_by_id(internal_id, mailbox)

        # 后续流程与正常同步相同...
```

**状态流转：**
```
pending → fetch_failed → (重试) → synced
       └───────────────────────→ failed → (重试) → synced
       └───────────────────────→ dead_letter (超过重试次数)
       └───────────────────────→ skipped (发件箱降级 / 日期过滤)
```

**死信降级例外（避免无意义告警）：**
- 发件箱 `fetch_failed` 用尽重试 → 降级为 `skipped`（`sync_error="Skipped (sent box unreachable): ..."`），不进死信。原因：发件箱里 row_id 在 SQLite radar 检测到之后被 Mail.app 重排/清理，AppleScript `whose id = N` 找不到；发件箱漏一封不致命，硬重试只刷告警。逻辑在 `sync_store._update_for_retry`。
- HTML 转 Notion blocks 时 `link.url` 必须是 ASCII + 协议白名单（http/https/mailto/tel）+ 不含空白；非法 URL 被 `html_converter._sanitize_link_url` 退化成纯文本，避免 Notion API 抛 `Invalid URL for link` 把整封邮件卡进死信。

#### 3. Processing Status 生命周期（双向同步）

```
Processing Status 状态流转:

未处理 ──(AI 审核)──→ AI Reviewed ──(反向同步)──→ 已同步 ──(用户处理)──→ 已完成
```

**各状态说明：**

| 状态 | 含义 | 触发方 | 动作 |
|------|------|--------|------|
| `未处理` | 新邮件等待 AI 审核 | 系统自动 | 无 |
| `AI Reviewed` | AI 已设置 Action Type + Priority | AI Automation | 触发反向同步 |
| `已同步` | 已同步到 Mail.app | 反向同步成功后自动 | 不再处理 |
| `已完成` | 用户已处理（如已回复） | 用户手动 / Mail.app 取消旗标 | 移除旗标 |

**反向同步 Action Type 映射：**

| Action Type | Mail.app 操作 | 飞书通知 |
|------------|--------------|---------|
| 需要回复/需要决策/需要Review/需要会议/需要跟进/等待响应 | 标记已读 + 设旗标 | 紧急/重要时推送卡片（含「✨ 优化回复」「📝 创建草稿」按钮 → Openclaw） |
| 仅供参考/已完结 | 标记已读 | 否 |

**双向完成闭环：**
- Mail.app 取消旗标 → 正向同步 → Notion `Is Flagged=False` + `Processing Status=已完成`
- Notion 标记 `已完成` → webhook `?event=completed` → 移除 Mail.app 旗标

**Webhook 事件类型：**

| 事件 | 触发条件 | 处理动作 |
|------|---------|---------|
| `flag_changed` | Is Read / Is Flagged 变化 | 同步到 Mail.app |
| `ai_reviewed` | Processing Status → AI Reviewed | Mail.app 标旗 + 飞书通知 + 状态更新为已同步 |
| `completed` | Processing Status → 已完成 | 移除 Mail.app 旗标 |
| `create_draft` | Notion 按钮触发 | 调用脚本创建 Mail.app 回复草稿 + 状态更新为草稿已创建 |
| `query_mail` | 外部系统查询 | 搜索邮件元数据（支持 `source=syncstore` 已同步 或 `source=mail` 全量 ~24k） |
| `fetch_mail_content` | 外部系统查询 | 通过 internal_id 获取邮件完整正文（AppleScript ~1-3s） |
| `page_updated` | 通用事件 | 自动路由到上述处理器 |

#### 4. 内联图片处理

```python
# converter/html_converter.py
def convert(html, image_map=None):
    """
    image_map: {cid: file_upload_id}

    处理流程：
    1. 解析 HTML，找到 <img src="cid:xxx">
    2. 从 image_map 查找对应的 file_upload_id
    3. 创建 Notion image block
    """
```

**关键点**：AppleScript 无法保存内联图片，必须从 MIME 源码提取。

### SyncStore 数据结构（v3 架构）

```sql
-- 邮件元数据（internal_id 为主键）
CREATE TABLE email_metadata (
    internal_id INTEGER PRIMARY KEY,      -- SQLite ROWID = AppleScript id
    message_id TEXT UNIQUE,               -- AppleScript 成功后填充，用于去重
    thread_id TEXT,
    subject TEXT,
    sender TEXT,
    sender_name TEXT,
    to_addr TEXT,
    cc_addr TEXT,
    date_received TEXT,
    mailbox TEXT,
    is_read INTEGER DEFAULT 0,
    is_flagged INTEGER DEFAULT 0,
    sync_status TEXT DEFAULT 'pending',   -- pending/fetch_failed/synced/failed/skipped/dead_letter
    notion_page_id TEXT,
    notion_thread_id TEXT,
    sync_error TEXT,
    retry_count INTEGER DEFAULT 0,
    next_retry_at REAL,                   -- 指数退避重试时间
    created_at REAL,
    updated_at REAL
);

-- 索引
CREATE UNIQUE INDEX idx_message_id ON email_metadata(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX idx_sync_status ON email_metadata(sync_status);
CREATE INDEX idx_next_retry ON email_metadata(next_retry_at) WHERE sync_status IN ('fetch_failed', 'failed');

-- 同步状态
CREATE TABLE sync_state (
    key TEXT PRIMARY KEY,
    value TEXT
);  -- last_max_row_id, last_sync_time

-- 线程头缓存
CREATE TABLE thread_head_cache (
    thread_id TEXT PRIMARY KEY,
    status TEXT,  -- not_found
    created_at TEXT
);
```

**v3 架构关键变化：**
| 功能 | 旧架构 (v2) | 新架构 (v3) |
|------|------------|------------|
| 主键 | message_id | **internal_id** |
| 去重 | message_id | message_id (UNIQUE) |
| AppleScript 失败处理 | ❌ 无法追踪 | ✅ 用 internal_id 追踪 |
| 重试队列 | sync_failures 表 | **统一在 email_metadata** |
| 查询方式 | `whose message id is` | **`whose id is`** (127x 快) |

## 配置项

### 必填

| 变量 | 说明 |
|------|------|
| `NOTION_TOKEN` | Notion Integration Token |
| `EMAIL_DATABASE_ID` | 邮件数据库 ID |
| `CALENDAR_DATABASE_ID` | 日历数据库 ID |
| `USER_EMAIL` | 邮箱地址 |
| `MAIL_ACCOUNT_NAME` | Mail.app 账户名 |

### 同步配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SYNC_START_DATE` | `2026-01-01` | 只同步此日期后的邮件 |
| `SYNC_MAILBOXES` | `收件箱,发件箱` | 监听的邮箱 |
| `RADAR_POLL_INTERVAL` | `5` | 雷达轮询间隔（秒） |
| `HEALTH_CHECK_INTERVAL` | `3600` | 健康检查间隔（秒） |

### AppleScript 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `INIT_BATCH_SIZE` | `100` | 初始化每批获取数量 |
| `APPLESCRIPT_TIMEOUT` | `200` | 超时时间（秒） |

### 飞书通知配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `FEISHU_APP_ID` | `""` | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | `""` | 飞书应用 App Secret |
| `FEISHU_CHAT_ID` | `""` | 飞书群聊 chat_id |
| `FEISHU_WEBHOOK_URL` | `""` | 飞书自定义机器人 webhook URL（备用） |
| `FEISHU_WEBHOOK_SECRET` | `""` | 签名密钥（可选） |
| `FEISHU_NOTIFY_ENABLED` | `false` | 是否启用飞书通知 |

### Redis 事件消费配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `REDIS_URL` | `""` | Redis 连接 URL |
| `REDIS_DB` | `2` | Redis DB 号（MailAgent 专用） |
| `REDIS_EVENTS_ENABLED` | `false` | 是否启用 Redis 事件消费 |

### 看板统计上报配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `STATS_REPORT_URL` | `""` | 看板上报 URL（如 `https://mailagent.chenge.ink/api/stats/report`） |
| `STATS_REPORT_INTERVAL` | `60` | 上报间隔（秒） |
| `STATS_REPORT_TOKEN` | `""` | 上报认证 token |

### 飞书告警机器人配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ALERT_FEISHU_WEBHOOK_URL` | `""` | 飞书告警机器人 webhook URL |
| `ALERT_FEISHU_WEBHOOK_SECRET` | `""` | webhook 签名密钥 |
| `ALERT_ENABLED` | `false` | 是否启用飞书告警 |
| `ALERT_LEVELS` | `critical,error,warning` | 启用的告警级别（逗号分隔） |
| `ALERT_COOLDOWN` | `300` | 同类告警冷却时间（秒） |
| `ALERT_DEAD_LETTER_THRESHOLD` | `5` | dead_letter 累积告警阈值 |

**告警级别与卡片样式：**

| 级别 | 颜色 | 触发场景 |
|------|------|---------|
| `critical` | 红色 | 服务崩溃、健康检查失败 |
| `error` | 橙色 | 同步失败、API 错误、连续错误、Redis 断连 |
| `warning` | 黄色 | dead_letter 累积、雷达不可用、服务停止 |
| `info` | 蓝色 | 服务启动、恢复通知 |

### Office 附件转换配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OFFICE_CONVERT_ENABLED` | `true` | 是否启用 Office 附件转换（docx/pptx→PDF, xlsx→CSV） |

**依赖安装：**
```bash
# xlsx→CSV（pip 依赖，随 requirements.txt 安装）
pip install pandas openpyxl python-calamine

# docx/pptx→PDF（系统依赖）
brew install --cask libreoffice
brew install --cask font-noto-sans-cjk   # CJK 字体
```

### 防锁屏保活配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `KEEP_ALIVE_ENABLED` | `false` | 是否启用防锁屏保活（集成在 main.py 中） |
| `KEEP_ALIVE_DIM` | `true` | 保活时是否自动调低屏幕亮度 |

**保活机制：**
- 非工作时段自动模拟鼠标微移，防止 MDM 锁屏
- 工作日 9-12, 13-18 自动暂停（用户在工位）
- 检测到真人操作（鼠标大幅移动 >50px）自动暂停并恢复亮度
- 空闲超过 3 分钟自动恢复保活

**一键激活（离开工位时使用）：**
- SIGUSR1 信号切换强制保活：`kill -USR1 $(pm2 pid mail-sync)` 或 `scripts/toggle_keep_alive.sh`
- 强制模式无视工作时段限制，立即调暗屏幕并保活
- 移动鼠标自动退出强制模式并恢复亮度
- macOS 快捷指令绑定：快捷指令 → 运行 Shell 脚本 → `toggle_keep_alive.sh` → 绑定键盘快捷键

### Webhook Server 看板配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DASHBOARD_PASSWORD` | `""` | 看板登录密码（为空则禁用看板） |

## Notion 数据库结构

### 邮件数据库

必需字段：
- `Subject` (Title)
- `Message ID` (Text) - 去重用
- `Thread ID` (Text) - 线程关联
- `From` (Email), `From Name` (Text)
- `To`, `CC` (Text)
- `Date` (Date)
- `Parent Item` (Relation to self) - 线程头
- `Mailbox` (Select)
- `Is Read`, `Is Flagged`, `Has Attachments` (Checkbox)
- `AI Action` (Select) - AI 处理动作
- `AI Priority` (Select) - AI 优先级（Critical/Urgent/Important/Normal/Low）
- `AI Review Status` (Select) - AI 审核状态（Pending/Reviewed）

### 日历数据库

必需字段：
- `Title` (Title)
- `Event ID` (Text) - 去重用
- `Time` (Date) - 起止时间
- `URL` (URL) - Teams 链接
- `Location` (Text)
- `Organizer` (Text)
- `Status` (Select)

## 常见问题

### 邮箱名称错误

```bash
mailagent debug mail-structure
```

### SQLite 无法访问

需要 Full Disk Access：系统设置 → 隐私与安全 → 完全磁盘访问权限

### AppleScript 超时

增大 `APPLESCRIPT_TIMEOUT`（默认 200 秒）

## 开发指南

### 修改邮件解析

编辑 `src/mail/reader.py`，测试：
```bash
python3 scripts/dev/test_mail_reader.py
```

### 修改会议检测

编辑 `src/mail/icalendar_parser.py` 或 `src/calendar_notion/description_parser.py`

### 添加新配置

1. 在 `src/config.py` 添加 Field
2. 在 `.env.example` 添加示例
3. 更新 CLAUDE.md

## 文件位置

- **日志**: `logs/sync.log`
- **数据库**: `data/sync_store.db`
- **临时附件**: `/tmp/email-notion-sync/{md5}/`
- **配置**: `.env`
- **优化文档**: `docs/applescript_id_optimization.md`
- **Webhook Server**: `webhook-server/`（远程部署，一键更新：`./scripts/deploy-webhook.sh`）

## LLM Agent（本地 LLM 接管 Notion Custom Agent）

邮件同步到 Notion 后，由本地 LLM（Anthropic Messages 兼容网关）填 11 个 AI 分类/分析字段 + Daily Digests relation，取代原来 Notion Custom Agent（Email Agent）。**默认关闭**。

### ⚠️ 启用前必做（否则会双跑撞车）

本地 LLM + Notion Custom Agent 都盯同一张页面，必须让其中一边退出，**二选一**：

- **方案 A（推荐）**：在 Notion Email Agent Instructions 页面最前面加一句硬约束「仅处理 `Processing Status = 未处理` 的邮件；其他状态一律跳过」。本地 LLM 处理完后状态是 `AI Reviewed` / `已完成`，Notion Agent 读到就自动跳过。
- **方案 B**：直接禁用 automation（Notion Email Inbox → Automations → Email Agent → Disable）。

没做这一步直接开本地 LLM，两边会同时写同一张页面 → `Processing Status` 被改两次 → webhook 重复触发 → 飞书卡片 + Mail.app 标旗重复跑两次。

详细启用清单：参见 [docs/LLM_AGENT_SETUP.md](./docs/LLM_AGENT_SETUP.md)。

### 启用步骤
1. `.env` 里改开关：
   ```
   LLM_AGENT_ENABLED=true
   LLM_API_KEY=cr_xxx              # https://crs.chenge.ink 签发的 key
   LLM_CONTEXT_PAGE_ID=xxx         # Email Agent Context 页面 ID（可选但强烈建议）
   LLM_DAILY_DIGEST_DATABASE_ID=xxx  # 可选，不填则跳过 Daily Digests relation
   # LLM_MODEL=claude-sonnet-4-6                       # 可选，主模型默认 Sonnet 4.6
   # LLM_FALLBACK_MODELS=gpt-5.4,claude-opus-4-7       # 可选，主模型挂掉时按序兜底
   ```
2. Notion 那边暂停 Email Agent（见上）。
3. `pm2 restart mail-sync` 并确认日志 `[llm-agent] enabled (model=... base=...)`。

### 模型 fallback 链（自动兜底，避免上游单点 outage）

`AnthropicClient.classify` 按 `[LLM_MODEL] + LLM_FALLBACK_MODELS` 顺序调用，第一个成功即返回；任一抛 `LLMCallError`（含 HTTP 5xx / "No available accounts in group" / 协议错 / 超时）就 warning 切下一个。最后一个还失败才上抛由 store 走重试队列。

默认链：`claude-sonnet-4-6 → gpt-5.4 → claude-opus-4-7`。

| 模型 | 协议 | 端点 | 备注 |
|---|---|---|---|
| `claude-*` | Anthropic Messages | `/v1/messages` + native `tool_use` | 走 `anthropic.AsyncAnthropic`，cache_control 生效 |
| `gpt-*` / `gemini-*` / `codex-*` | OpenAI Chat Completions | `/v1/chat/completions` 流式 + `tool_calls` | 走 `httpx` 直连，CRS 强制 `stream=true`；OpenAI 协议无 cache_control，命中数始终 0 |

`client.py:_is_openai_proto` 按模型名前缀路由，前缀写死在常量 `_OPENAI_PROTO_PREFIXES`。CRS 上 `owned_by != anthropic` 的模型都走这条路；要新加路由前缀就改这个常量。

注意：
- 切到 OpenAI 协议时 cache 自动失效（不同协议 + 不同 model = 不同 prefix hash），那次调用算 cache miss；fallback 是兜底而非常态，命中率指标不会被它持续拖累。
- Fallback warning 在 `pm2 logs mail-sync` 里以 `[llm] model=X failed, falling back to Y: ...` 出现，可作为上游异常告警信号。
- 想完全禁用 fallback：`LLM_FALLBACK_MODELS=`（空串）。

### 模块结构

### 模块结构
```
src/llm_agent/
  schema.py          EMAIL_TOOL_SCHEMA（Anthropic tool JSON schema） + enums（匹配 Notion DB）
  client.py          AsyncAnthropic 封装（含 User-Agent 绕 Cloudflare 1010）
  prompt_loader.py   mtime-aware 热重载收/发件箱 prompt .md
  context_loader.py  加载 Email Agent Context markdown（30min TTL）
  md_to_rich_text.py Markdown → Notion rich_text JSON（bold/italic/strike/code/link + 换行）
  digest_resolver.py 日期 → Daily Digest page_id（5min 缓存）
  notion_writer.py   AILabels → pages.update 多字段写入
  processor.py       核心入口：拼 system+user → LLM tool_use → AILabels
  store.py           llm_processing SQLite 表（retry 队列 + cost/latency 记录）
  runner.py          端到端封装（sync_store → arm fetch → parse → LLM → Notion write）
src/cli/commands/llm.py       CLI（`mailagent llm {selftest,run,retry-failed,stats,compare-paths}`；PR-6 起取代旧 scripts/run_llm_on_email.py）
prompts/
  email_inbox.md     收件箱判定规则（mailbox-specific）
  email_sent.md     发件箱 follow-up 判定规则
  README.md         定制说明
```

### 挂钩位置
- 正向钩子：`src/mail/new_watcher.py:_sync_single_email_v3` 中项目周报 hook 之后派发 `self._maybe_trigger_llm_hook(email_obj, internal_id, page_id)` → `asyncio.create_task` fire-and-forget，不阻塞主同步。
- 重试队列：`_poll_cycle` 每轮调 `_process_llm_retry_queue()`，处理 `llm_processing.status='failed'` 且 `next_retry_at <= now` 的邮件（指数退避 1min/5min/15min/1h/2h）。

### 失败兜底
- 单次失败：`retry_count++`，指数退避重试。
- 达到 `LLM_MAX_RETRIES` 次（默认 3）：`status='gave_up'`，**不写任何 AI 字段**、**不动 Processing Status**（保持"未处理"）、飞书告警（warning 级别），由 Notion Custom Agent 自然接手（如果它还活着，否则字段空着手动补）。

### Processing Status 路由（关键语义）
- 收件箱 LLM 处理完 → `Processing Status='AI Reviewed'` → Notion webhook 触发 `handle_ai_reviewed` → Mail.app 标旗 + 飞书卡片 + Processing Status→'已同步'。
- 发件箱 LLM 处理完 → `Processing Status='已完成'`（按原 Email Agent Instructions §发件箱生命周期字面：发件箱不经 AI Reviewed）→ Notion webhook 触发 `handle_completed` → 移除 Mail.app 旗标（发件箱本来就极少标旗，无害）。

### CLI
```bash
# 网关健康检查（不烧 token 做真实 Notion 写入）
mailagent llm selftest

# 单封干跑（看 LLM 输出 + 待写 properties 但不写 Notion）
mailagent llm run 51793 --dry-run

# 单封实跑（覆盖已有字段）
mailagent llm run 51793 --force

# 范围重跑（保留用户已手改的非空字段）
mailagent llm run --internal-ids 51000-51100 --force --no-overwrite
```

### 监控
```bash
# 处理状态分布
sqlite3 data/sync_store.db "SELECT status, COUNT(*) FROM llm_processing GROUP BY status"

# 看最近失败
sqlite3 data/sync_store.db "
  SELECT internal_id, status, retry_count, substr(last_error,1,60)
    FROM llm_processing WHERE status IN ('failed','gave_up')
  ORDER BY updated_at DESC LIMIT 10"

# cost 审计（cache hit 用 cache_read_input_tokens，按 0.1x input 定价）
sqlite3 data/sync_store.db "
  SELECT SUM(input_tokens) as in_tok, SUM(output_tokens) as out_tok,
         SUM(cache_creation_input_tokens) as cache_write,
         SUM(cache_read_input_tokens) as cache_read,
         AVG(latency_ms) as avg_ms, COUNT(*) as n
    FROM llm_processing WHERE status='success'"

# 最近 20 封的缓存命中情况
sqlite3 data/sync_store.db "
  SELECT internal_id, input_tokens, cache_creation_input_tokens, cache_read_input_tokens
    FROM llm_processing WHERE status='success'
    ORDER BY updated_at DESC LIMIT 20"

# 近 7 天命中率（cache_read>0 的请求占比）
sqlite3 data/sync_store.db "
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN cache_read_input_tokens > 0 THEN 1 ELSE 0 END) AS hits,
    ROUND(100.0 * SUM(CASE WHEN cache_read_input_tokens > 0 THEN 1 ELSE 0 END)
          / COUNT(*), 1) AS hit_pct
  FROM llm_processing
  WHERE status='success' AND updated_at > strftime('%s','now','-7 day')"
```

### Prompt Caching（CRS 已落地，默认开启）

- 位置：`src/llm_agent/processor.py:_build_system` 在 system 最后一个稳定 block 加 1 个 `cache_control`，前缀覆盖 tools + header + ctx + mailbox prompt + final constraints。单断点 + 最大前缀 = 稳过 Sonnet 4.6 的 2048 tokens 最低阈值。
- 策略：永远带 `cache_control`，由服务端自动判 hit/miss/write。客户端无状态，不做时机判断（prefix 变了 → 自动 miss 重建；TTL 过期 → 自动 write；都不需要我们操心）。
- TTL：默认 `LLM_CACHE_TTL=1h`（`src/config.py`）。`client.py` 无条件发 `anthropic-beta: extended-cache-ttl-2025-04-11` header，所以 1h TTL 在 CRS 和原生 Anthropic 两条路都生效。想强制 5m 就 `LLM_CACHE_TTL=5m`；留空则让网关决定（CRS 默认 1h、原生 Anthropic 默认 5m，会漂，不推荐）。
- 不伪装 Claude Code：CRS 对非 CC 请求会把 system 迁移到 messages，但会保留 cache_control；只要每次调用 prefix 内容一致，迁移后的 hash 依然稳定、命中照常。伪装（`User-Agent: claude-cli/x.y.z` + `x-app: cli`）在 CRS 检测规则变化时容易碎，**不推荐**。
- 关开关：`LLM_CACHE_ENABLED=false`（非 Anthropic 协议、或定位 cache 相关故障时）。
- 命中验证：对同一 internal_id 跑两次 `mailagent llm run X --force`，第 2 次的 `cache_read_input_tokens` 应 > 0、`cache_creation_input_tokens` 应 = 0（prefix 没变、TTL 没过）。
- 典型收益（Sonnet 4.6，100 封/工作日集中到达）：input 约 4400 uncached + 2500 cached；5m cache 命中率 ~75%，月省 ~$13；1h cache ~95%，月省 ~$17。

### LLM payload vs Notion 页面字段一致性

本地 LLM 替代 Notion Custom Agent 后，两者拿到的邮件上下文语义上等价，字节级不一致——对邮件分类任务这个差异不重要。对照：

| 字段 | `processor._build_user` payload（给 LLM） | Notion page properties（给 Notion Agent） |
|---|---|---|
| 主题 / 发件人 / To / CC / Date / 邮箱 / Thread / Read/Flagged/HasAttachments | ✅ 全部传 | ✅ 全部写 |
| 正文 | `body_text`：plaintext，HTML 剥除，截到 `LLM_BODY_MAX_CHARS`（默认 12000 字符） | HTML → Notion blocks（保留格式、内联图） |
| 附件 | `attachments: [filename, ...]` 只文件名 | 真实文件上传（docx→PDF、xlsx→CSV） |
| 日期 | `date_iso` + `date_utc8_date`（LLM 方便做 digest 归类） | `Date`（完整时间） |
| Message ID / Parent Item / internal_id | ❌ 不传（分类不需要，也避免 LLM 瞎填 relation） | ✅ 写 |

判断依据：邮件分类看 subject / sender / body 语义 + thread / action 等 metadata，不看排版或附件内容；HTML 格式和附件内容对 Notion Custom Agent 的分类决策也没额外价值。所以 **`_build_user` 不需要跟 Notion properties 字节对齐**——判断质量取决于 prompt（`prompts/*.md`）和 context（Email Agent Context 页面），不取决于 payload 形状。

如果未来想让 LLM 看附件内容（比如对合同邮件做深度分析），需要另开一条 pipeline：把 docx→PDF 后上传到 Anthropic Files API、在 `_build_user` 里加 `file_id`，这不在当前 scope 内。

### 多人配置
- 每人 fork/clone 后改自己的 `.env`：`LLM_API_KEY` / `LLM_CONTEXT_PAGE_ID` / `LLM_INBOX_PROMPT_PATH` / `LLM_SENT_PROMPT_PATH`。
- 默认 `prompts/*.md` 跟仓库走；想用自己私人版本就复制成 `prompts/myuser_inbox.md` 等（不会提交），再改 `.env` 指过去。
- Notion email database schema 全员一致；要改 schema（加/改 select option）→ 同步改 `src/llm_agent/schema.py` 并跑 `pytest tests/llm_agent/test_schema.py`。

### 常见问题
- **网关 HTTP 403 + Cloudflare `error code: 1010`**：缺 `User-Agent`。`src/llm_agent/client.py` 默认会加 `MailAgent-LLM/0.1`，绕过即可。
- **HTTP 500 `No available Claude accounts support the requested model`**：网关上游 Claude 账户暂时 exhausted；通常稍等几分钟会恢复。
- **`cache_read_input_tokens` 一直是 0**：
  - 第 1 次调用本来就该是 `cache_creation`，命中要看第 2 次起；
  - 如果第 2 次还是 0：看 context 是否刚被刷新（30min TTL）、prompt .md 是否被改过（mtime 变了）、mailbox 是否和上次不同——这几项任意变都会让 prefix hash 变化、cache 自然 miss；
  - 都没变还是 0：先看缓存段是否低于模型最低阈值（Sonnet 4.6 = 2048 tokens，Opus 4.7 = 4096）——低于阈值会被服务端静默跳过；
  - 最后才怀疑网关或账户不支持。`LLM_CACHE_ENABLED=false` 可临时关掉断点定位问题。

### 测试
```bash
pytest tests/llm_agent/ -v
```
覆盖：`md_to_rich_text` / `schema` enum 一致性 / `digest_resolver` mock 查询 / `processor` sanitizer + 时区 / `writer._build_props` 各种字段组合。全部 mock 不调网关不烧钱。

## 项目周报同步（外挂模块）

独立于主同步的可选外挂模块，消费每周一定期发出的 **《【项目进度】研发项目deadline汇报_市场产品采购》** 邮件，抽取 xlsx 附件中三个 sheet 的项目，过滤 `BU==TPS-ENBU` upsert 到 Notion 项目进度库。

**信源演进**：
- v1（2026-04 之前）：消费某转发版，xlsx 仅 1 个 sheet（`Project  Ongoing`，15 列），项目"完成 / 终止"靠 diff 推断
- v2（2026-04 起）：消费直接发件人版，xlsx 4 个 sheet（多 19/50 列 + 已出货 + 已暂停），状态靠 Sheet 2/3 权威信号
- v3（2026-05 起）：实际发件人会换人（zhouwangfang → liuxiangjiang → …），`PROJECT_PROGRESS_SENDER` 改为可选；默认仅按标题正则匹配，需要严格双判定再显式配置 sender。

### 模块结构
```
src/project_progress/
  detector.py          (可选发件人) + 标题正则匹配（sender 留空仅看 subject；两者全空则永不匹配）
  xlsx_parser.py       4 sheet 解析 + 双行表头检测 + ENBU 过滤 + 1:1 行级 ProjectRow + 母子关系（仅 Ongoing 内）
  slug.py              external_id 生成（英文 slug；含中文加短 sha1 后缀；碰撞后加后缀）
  progress_parser.py   解析 [MM/DD] / [M/D] / [MM/DD/YYYY] / （MM.DD） 等日期头
  priority.py          Project Priority 语义映射（Y-Pledge→军令状项目, Y/是→高优先级, N/否→低优先级, TBD/R&D project 原样）
  sync_store.py        project_progress_sync 表（旧 evelyn_project_sync 自动 ALTER RENAME）
  notion_sync.py       Notion 客户端 + Status 三态路由 + 7 个新字段写入 + Markdown API
  notion_schema.py     启动时 schema bootstrap（5min 缓存，自动建 7 个 property，Suspended status 仅 log）
  runner.py            端到端 runner（sync_from_email）

src/cli/commands/project_progress.py CLI（`mailagent project-progress sync ...`；PR-6 起取代旧 scripts/sync_project_progress.py）
tests/project_progress/             pytest
docs/notion_markdown_api.md         Notion Markdown API 探测记录
```

### xlsx 结构（v2 / 4-sheet 版）

| Sheet | 用途 | 行数（典型）| 列数 | 表头 | ENBU 行（典型）|
|---|---|---|---|---|---|
| `Project  Ongoing`（双空格）| 在研项目 | ~2900 | 34 | 双行（行 1 英文 + 行 2 中文标签）| ~1015 |
| `2026-Project Shipped` | 已出货 → Status=Done | ~1290 | 65 | 双行 | ~457 |
| `Project Suspended` | 已暂停 → Status=Suspended | ~890 | 65 | 双行 | ~119 |
| `Filling-in & Reading Guide` | 字段说明文档 | 52 | - | - | 解析时跳过 |

**双行表头检测**（`_read_sheet_with_dual_header`）：扫描前 5 行找含 `BU` + `Project Name` 的英文 header；下一行如果是中文标签（含'事业部'/'课组'/'研发'等关键词）则跳过，数据从 header+2 起；否则数据紧随 header（兼容 v1 单行表头 fixture）。

### Notion Markdown API
使用 `Notion-Version: 2025-09-03` + `ntn_` token 才可用（参见 `docs/notion_markdown_api.md`）：
- `GET  /v1/pages/{id}/markdown` 读扩展 markdown
- `PATCH /v1/pages/{id}/markdown` 写，支持 `replace_content / insert_content / update_content / replace_content_range`
- Prepend 通过 read-modify-write：GET markdown → 客户端拼 → `replace_content` 写回

### 粒度：行级（一行 = 一个 Notion 页）+ 母子任务

xlsx 每行是一个 `(Project Name, Product Model)` 对。**每行独立一个 Notion 页**，不再按 Project Name 聚合。同一 Project Name 下的多行建立**母子任务关系**（Notion 自带的 `母任务 / 子任务` dual_property）：

- 母任务：同 Project Name 多行中，`earliest_progress_date`（progress_blocks 里最老块的实际日期）最早的那行。平局按 Product Model 字母序
- 子任务：同 Project Name 其余行，`母任务` relation 指向母任务 page_id
- 独立任务：同 Project Name 只有一行的项目，既不是母也不是子

**Dual-property 策略**：脚本只写子任务一侧的 `母任务` relation；`子任务` 字段由 Notion 自动反填。母任务的 properties 永远不含母子字段，避免 update 时误动 relation。

**Upsert 两阶段**（保证 relation 不 dangling）：
1. Phase 1：并发 upsert 所有"母 + 独立"（parent_external_id 为 None），收集 external_id→page_id 映射
2. Phase 2：并发 upsert 所有"子任务"，用 Phase 1 的映射取 parent_page_id 写 `母任务` relation

### 字段映射（xlsx → Notion）
| Notion property | 类型 | xlsx 列 / 规则 |
|---|---|---|
| `项目名称` (title) | title | **Product Model**（每行自己的 SKU 名） |
| `external_id` | rich_text | slug(`Project Name + "__" + Product Model`)；碰撞按 (name, model) hash 后缀 |
| `母任务` | relation (dual) | 子任务指向母任务 page_id（**仅 Ongoing 内**）；Shipped/Suspended 全独立任务 |
| `本周数据期` | rich_text | xlsx 文件名日期 YYYYMMDD → ISO 周 `YYYY-WXX` |
| `优先级` | select | Project Priority **映射后写入**（Y-Pledge→军令状项目, Y/是→高优先级, N/否→低优先级, TBD/R&D project 保留原样）|
| `Product Models` | multi_select | 本行 Product Model 单值 |
| `BU` | select | 固定 `TPS-ENBU` |
| `研发分部` | select | R&D Division |
| `PM` / `协助 PM` / `接口人` | rich_text | Project Manager / Assist PM / Contact Window |
| `参考 DDL` | date | Reference Date for the Business（Terminated / NO MPS 等非日期写入风险项） |
| `美国发货` | checkbox | Shipped to the United States（`Y`→True） |
| `风险项` | rich_text | Project Risk |
| `Status` | status | **Sheet 路由**：Ongoing+create → `In progress`，Ongoing+update → 不覆盖；Shipped → 强制 `Done`；Suspended → 强制 `Suspended` |
| `项目开始时间` | date | create 时写 xlsx 的 `Product Establishment Date`（更准），无则用 `earliest_progress_date`；update 不覆盖 |
| `立项时间` | date | xlsx `Product Establishment Date`（v2 新增） |
| `期望交期` | date | xlsx `Desired shipping Date`（v2 新增） |
| `预计出货` | date | xlsx `Estimated Shipping Date`（v2 新增） |
| `实际出货` | date | xlsx `Actual Shipped Date`（v2 新增，仅 Sheet 2 有值） |
| `暂停时间` | date | xlsx `Suspension Date`（v2 新增，仅 Sheet 3 有值） |
| `进度异常` | rich_text | xlsx `Reasons for the Delay`（v2 新增） |
| `当前状态` | select | xlsx `Current Status`（v2 新增，仅 Sheet 2/3 有值，如 Delivery / Suspended / R&D in progress） |
| `Evelyn 原邮件` | url | 邮件 Notion 页 URL（Notion 历史 property 名，不能改否则丢历史数据） |
| `产品线` | multi_select | xlsx Product Line 直写（Notion 自动创建 option） |
| `出现在会议` | relation | 留空，手动挂 |
| `最后同步` | last_edited_time | 自动 |

### Status 三态语义

```
Sheet Ongoing   → create: 写 In progress  | update: 不写（保留手改）
Sheet Shipped   → 强制 Status=Done       （xlsx 是权威信号，覆盖手改）
Sheet Suspended → 强制 Status=Suspended  （xlsx 是权威信号，覆盖手改）
```

**Mark-missing 兜底**：xlsx 三个 sheet 全部消失的项目（罕见，通常是项目改名）→ 仍标 Done。

### Schema Bootstrap（启动时一次）

`runner._upsert_all` 启动时调 `ProjectProgressSchemaBootstrapper.ensure_schema()`（5min 缓存）：
- `GET /v1/databases/:id` 拉当前 schema
- 缺失的 7 个 property（立项时间 / 期望交期 / 预计出货 / 实际出货 / 暂停时间 / 进度异常 / 当前状态）通过 `PATCH /v1/databases/:id` 自动建
- Notion API **不允许**修改 status 类型 options，所以 `Suspended` option 必须用户**手动**在 Notion 后台加（"已入库"组下）；缺失则 schema bootstrap log warning，但不阻塞 Ongoing/Shipped 同步

### 正文（进度日志）写入
- 采用 Notion **Markdown API**（需 `ntn_` token + `Notion-Version: 2025-09-03`），详见 `docs/notion_markdown_api.md`
- 首次创建：`POST /v1/pages` 建空页 → `PATCH /markdown` `replace_content` 一次性写入全量历史 markdown
- 增量 prepend：`GET /markdown` → 找页面首个 heading 做 anchor → `PATCH /markdown` `update_content` 把 anchor 替换为 "本周块 + anchor"（Notion 内部只重建首个 block，不是整页 rebuild）
- 找不到安全 anchor 或空页 → 降级 `replace_content`
- **幂等 guard**：prepend 前 GET markdown，首段已含 `### {week_tag} ` → skip（一周内多次跑不重复写入）

### Progress 日期 / 年份推断
xlsx 的 `Project Progress` 里日期头格式多样（`[MM/DD]` / `[M/D]` / `[MM/DD/YYYY]` / `（MM.DD）`），很多缺年份。算法：
- 按 xlsx 出现顺序（最新在前）**单调递减**推断年份：每块推出的日期必须 ≤ 前一块日期，否则年份 -1 继续试
- 例：`(01/23/2026) → (3.1) → (11.17) → (11.10)` 被推断为 `2026-01-23 / 2025-03-01 / 2024-11-17 / 2024-11-10`

### 增量同步语义
- `project_progress_sync` 表以 `email_internal_id` 为主键记录每封邮件的处理状态
- 同 internal_id 已 `completed` → 跳过（`--force` 才重跑）
- 同 xlsx_md5 不同 internal_id（转发链）→ 默认跳过
- 行级 upsert：external_id 查 → 无则 create，有则 update properties + prepend 本周 markdown
- **Sheet 2/3 → 状态权威信号**：在 Shipped sheet 出现的项目自动标 `Status=Done`，在 Suspended sheet 出现的项目自动标 `Status=Suspended`，不再依赖"diff 推断"
- **mark-missing 兜底**：仅当项目从 xlsx **三个 sheet 全部消失**才标 Done（罕见，通常是项目改名）

### 数据库迁移（旧表 → 新表）

启动 `ProjectProgressSyncStore.__init__` 时透明执行（idempotent）：
1. 检测旧表 `evelyn_project_sync` → ALTER TABLE RENAME 到 `project_progress_sync`
2. ADD COLUMN：`sheet_ongoing_rows / sheet_shipped_rows / sheet_suspended_rows / projects_marked_done / projects_marked_suspended`（IF NOT EXIST 容错）

### 命令
```bash
# 自动扫最近一封未处理的（默认全 3 sheet）
mailagent project-progress sync

# 指定一封
mailagent project-progress sync --internal-id 52258

# **首次切换迁移 dry-run**（输出预估的 create / Done / Suspended 数量，不写 Notion）
mailagent project-progress sync --internal-id 52258 --first-migration-dry-run

# 仅解析 Ongoing sheet（兼容 v1 行为）
mailagent project-progress sync --internal-id 51793 --sheets ongoing

# 回填历史（按日期升序 N 封）
mailagent project-progress sync --all-history --limit 10

# 干跑（不写 Notion）
mailagent project-progress sync --internal-id 52258 --dry-run

# 强制重跑 (会用 xlsx 整页 replace 正文)
mailagent project-progress sync --internal-id 52258 --force

# 一次性回填"项目开始时间"到所有已入库项目页
mailagent project-progress sync --internal-id 52258 --backfill-project-start
```

### 自动触发（可选）
设置 `PROJECT_PROGRESS_AUTO_SYNC_ENABLED=true` 后，`main.py` 会在每次邮件同步 Notion 成功后检测，匹配到项目周报邮件即 `asyncio.create_task(runner.sync_from_email(...))` 后台触发。任何异常不会影响主同步流程。

### 配置（`.env`）
**默认全部关闭**：其他协作者拉取代码后 CLI 和钩子都不会运行。

**所有过滤条件都可配置**——其他 BU / 其他团队复用本模块：改发件人、标题、数据库 ID、BU 值即可。

```
# 总开关（必须）：CLI / 钩子都依赖它
PROJECT_PROGRESS_SYNC_ENABLED=true

# Notion 目标数据库 ID（必须）——每个人填自己的
PROJECT_PROGRESS_DATABASE_ID=6f528975839940ceaacaf545e47cf25d

# 过滤保留的 BU 值（精确匹配 xlsx 的 BU 列）
PROJECT_PROGRESS_FILTER_BU=TPS-ENBU   # HNBU 团队改成 TPS-HNBU 即可

# 可选：main.py 自动触发钩子（需同时打开上面的总开关）
PROJECT_PROGRESS_AUTO_SYNC_ENABLED=false

# 必填：识别邮件的标题正则
PROJECT_PROGRESS_SUBJECT_PATTERN=<标题正则，含【项目进度】等关键词>

# 可选：识别邮件的发件人（子串匹配，不区分大小写）
# 留空 → 仅按 subject 匹配（推荐，实际发件人会换人，例如 zhouwangfang → liuxiangjiang）
# 配置 → 双判定（sender + subject 都要匹配）
# PROJECT_PROGRESS_SENDER=<weekly-sender-email>
```

`PROJECT_PROGRESS_SYNC_ENABLED=false`（默认）时：
- CLI 直接报错退出（避免误跑）
- `new_watcher` 不初始化 detector（钩子不生效）

### 首次切换迁移操作清单（v1 → v2）

1. **Notion 后台**：在项目进度库的 Status 属性 → "已入库" 组下，**手动**添加 `Suspended` 选项（API 不能加）
2. **代码部署**：拉取最新代码（DB 表迁移会在首次启动 `ProjectProgressSyncStore` 时透明完成）
3. **dry-run 审查**：
   ```bash
   mailagent project-progress sync --internal-id <最新 zwf 邮件 id> --first-migration-dry-run
   ```
   输出形如：
   ```
   ongoing=1015  shipped=457  suspended=119
   Status changes (estimated): Done +457  Suspended +119
   ```
4. **正式执行**：移除 `--first-migration-dry-run` 重跑（预估 13~17 min，按 ~3 req/sec 限流）
5. **校验**：
   ```bash
   sqlite3 data/sync_store.db "
     SELECT sheet_ongoing_rows, sheet_shipped_rows, sheet_suspended_rows,
            projects_created, projects_updated,
            projects_marked_done, projects_marked_suspended
     FROM project_progress_sync ORDER BY completed_at DESC LIMIT 1"
   ```

### 监控
```bash
sqlite3 data/sync_store.db "
  SELECT email_internal_id, week_tag, status,
         sheet_ongoing_rows, sheet_shipped_rows, sheet_suspended_rows,
         projects_total, projects_created, projects_updated,
         projects_marked_done, projects_marked_suspended, projects_failed
  FROM project_progress_sync ORDER BY completed_at DESC LIMIT 5"
```

## 关于 calendar_main.py

`calendar_main.py` 是独立的日历同步服务，直接从 Calendar.app 读取事件。

**一般不需要运行**，因为：
- `main.py` 已包含会议邀请识别（从邮件中的 .ics）
- Calendar.app 中的会议可能不完整
- 邮件中的会议信息更全面

**仅在需要同步历史日程时使用**：
```bash
python3 calendar_main.py --once
```

## v4 架构 SQLite-SSoT（2026-05 立项，**Phase 1 + 2 + 3 已上线 2026-05-15；Phase 4 ship 2026-05-16 灰度期**）

把 SQLite 升级为邮件正文 + 附件的 Single Source of Truth，Notion 退化为镜像。新邮件 sync 时把 body + 附件元数据双写到 SQLite，附件二进制落 `data/attachments/{internal_id}/`。详见 [`docs/architecture_v4_sqlite_ssot.md`](./docs/architecture_v4_sqlite_ssot.md)，Phase 间交接说明见 [`docs/phase1-handoff-to-phase2.md`](./docs/phase1-handoff-to-phase2.md)。

### 关键 schema 速查

| 表 | 主键 | 用途 |
|---|---|---|
| `email_body` | internal_id (FK metadata, CASCADE) | 邮件正文：`body_html`（原始）+ `body_markdown`（markdownify 产物，LLM/RAG/FTS5 通用）+ `raw_mime_sha256` |
| `email_attachment` | id (AUTOINCREMENT) | 附件元数据：`local_path` 指向 `data/attachments/{int_id}/`；`derived_from` 自指 FK 关联 Office 转换产物（docx→pdf） |
| `email_body_fts` | virtual (rowid=internal_id) | FTS5 全文索引（Phase 3 已上线，contentful 模式，3 个 trigger 自动维护） |

### 接口层：`EmailRepository`

```python
from src.repository import EmailRepository, AttachmentStore

repo = EmailRepository(
    db_path="data/sync_store.db",
    attachment_store=AttachmentStore("data/attachments"),
)

# 读
html = repo.get_body_html(internal_id)
md = repo.get_body_markdown(internal_id, max_chars=12000)
atts = repo.get_attachments(internal_id)
content_bytes = repo.get_attachment_bytes(att.id)

# 写（事务：body + attachments 原子提交，附件落盘失败回滚）
id_map = repo.commit_email_with_body(internal_id, body, attachments, message_id=...)

# Notion sync 完成后回写
repo.update_notion_links(internal_id, file_id_map={att_id: notion_file_id})

# CASCADE 删除（含本地文件清理）
repo.delete_email_full(internal_id)

# Phase 3：全文搜索（bm25 排序 + snippet 高亮）
hits = repo.search_email_bodies("redis AND timeout", limit=20, mailbox="收件箱")
for h in hits:
    print(h.internal_id, h.rank, h.subject, h.snippet)
```

### Phase 3 FTS5 全文搜索

`search_email_bodies(query, *, limit=50, mailbox=None, since_date=None, until_date=None)` 支持 FTS5 完整语法：
- 短语：`"team meeting"`
- 布尔：`redis AND timeout`、`meeting NOT canceled`、`team OR group`
- 前缀通配：`meet*`、`产品*`
- 邻近：`redis NEAR(timeout, 5)`

**中文搜索注意**：SQLite 自带的 `unicode61` tokenizer 把**连续 CJK 字符当一个 token**（不分词），精确搜 "产品" 命不中 token "本周产品评审"。变通：用 `产品*` 前缀通配匹配。邮件正文里如果 "产品" 周围有 markdown 标记（`*` / `[` / 空格）会自动切出独立 token，所以生产邮件大多能直接搜中文 —— 但**单测和纯中文文本必须用 `*`**。未来可接 jieba 或 signal-fts5-tokenizer 提升质量。

**Webhook 端**: `search_email_bodies` event（自动从 Redis 消费），响应：
```jsonc
{"status": "success", "query": "...", "total_hits": 2, "latency_ms": 7,
 "hits": [{"internal_id": ..., "subject": ..., "sender": ..., "snippet": "...<mark>...</mark>...",
           "rank": -1.76, "notion_url": "..."}]}
```

详见 [`docs/phase3-complete.md`](./docs/phase3-complete.md)。

### Phase 4 重传 CLI

```bash
# Notion 重传（基于 SQLite，不调 AppleScript）
mailagent email resync 53675 --dry-run                                    # 看 plan
mailagent email resync 53675 --replace-existing                           # archive 老页 → 建新
mailagent email resync --range 53000-53100 --replace-existing
mailagent email resync --ids 53674,53675,53677

# Office 衍生附件补救（追加 derived row，不动现有 row；适合 backfill silent fail）
mailagent backfill derivatives --dry-run                                  # 看候选数
mailagent backfill derivatives --internal-id 53677                        # 单封
mailagent backfill derivatives                                            # 全量补
```

**注意**:
- `mailagent email resync` 默认 `skip_parent_lookup=True`（diff 验证用），新页不会重建线程关系
- `mailagent backfill derivatives` 补完后，Notion 老页**不会**自动出现 derived 附件；要更新需要 `mailagent email resync --replace-existing`
- 灰度切 `NOTION_READ_FROM_SQLITE=true` 操作步骤见 [`docs/phase4-complete.md`](./docs/phase4-complete.md) §6

### 关键开关

| 配置 | 默认 | 说明 |
|---|---|---|
| `BODY_DUAL_WRITE_ENABLED` | `true` | v4 双写总开关；失败仅 warning 不阻断 Notion sync |
| `ATTACHMENT_STORAGE_DIR` | `data/attachments` | 附件本地落盘根目录 |
| `NOTION_READ_FROM_SQLITE` | `false` | v4 Phase 4：`create_email_page_v2` 是否优先走 SQLite SSoT 路径。默认灰度期 false；切 true 后正常 sync + resync 都走 `create_email_page_from_sqlite`，miss 时自动 fallback 老路径 |

### 双写流程（v4 vs v3）

v3 sync 路径：AppleScript → in-memory Email → Notion blocks。

v4 sync 路径：AppleScript → in-memory Email → **build_storage_payloads + repo.commit** → Notion blocks（不变）。

双写点位：`src/mail/new_watcher.py` 的 `_sync_single_email_v3` 与 `_process_retry_queue` 都在 Notion sync 之前调 `_maybe_dual_write_body`。

### Phase 推进

| Phase | 状态 | 内容 |
|---|---|---|
| Phase 1 | ✅ **已上线 2026-05-15** | 双写 MVP；新邮件 sync 时落 SQLite，Web 端可立即切表。43/43 单测通过、生产服务已加载 v4 |
| Phase 2 | ✅ **已上线 2026-05-15** | LLM processor / handle_fetch_mail_content 直读 SQLite（命中 ~4ms vs AppleScript 1-3s）；P99 latency tracker；回归对比工具就位。详见 [`docs/phase2-complete.md`](./docs/phase2-complete.md)。回退开关 `LLM_PREFER_SQLITE_BODY=false` |
| Phase 3 | ✅ **已上线 2026-05-15** | FTS5 全文索引 + `search_email_bodies` agent 工具；webhook bm25 排序 + snippet 高亮 + mailbox/date 过滤。274/274 单测通过。详见 [`docs/phase3-complete.md`](./docs/phase3-complete.md) |
| Phase 4 | ✅ **已 ship 2026-05-16（灰度期）** | `create_email_page_from_sqlite` 主入口 + v2 wrapper 路由 (`NOTION_READ_FROM_SQLITE`) + `mailagent email resync` + `mailagent backfill derivatives` CLI（PR-6 起取代旧 `scripts/resync_notion.py` / `scripts/backfill_derivatives.py`）。上传后 `notion_file_id` 回写 SQLite。295/295 单测、3 封灰度切换实测 OK。详见 [`docs/phase4-complete.md`](./docs/phase4-complete.md) |
| Phase 5 | 未来 | Electron / Web 前端（接口已就位） |
| **T-01** | ⛔ 决定不迁 | Notion sync 迁 Markdown API — 评估后 Notion Markdown API 仅支持 page 正文 markdown，不支持 inline image / file_upload block / 复杂 properties，对邮件复杂渲染（cid 内联图、附件 block、AI 字段写入）**不可替代**当前 blocks API 路径。保留现状 |

### 关键文件

- `src/repository/` 整个目录（EmailRepository / AttachmentStore / build_storage_payloads / search_email_bodies）
- `src/converter/html_to_markdown.py`（markdownify 主路径）
- `src/mail/sync_store.py:95-410`（DB_VERSION=5，含 email_body / email_attachment / email_body_fts + trigger）
- `src/mail/new_watcher.py:114-130, 380-393, 450-490, 733-740`（双写入口）
- `src/events/handlers.py:745-855`（`handle_search_email_bodies` webhook）
- `tests/repository/`（单测，含 `TestSearchEmailBodies`）+ `tests/events/test_search_email_bodies.py`

### 运维

```bash
# 看新邮件双写是否正常（pm2 重启后等 5-10 min）
sqlite3 data/sync_store.db "SELECT COUNT(*) FROM email_body WHERE fetched_at > strftime('%s','now','-10 min')"

# 看 body / attachment 存量
sqlite3 data/sync_store.db "
  SELECT
    (SELECT COUNT(*) FROM email_body) AS bodies,
    (SELECT COUNT(*) FROM email_attachment) AS attachments,
    (SELECT COUNT(*) FROM email_attachment WHERE derived_from IS NOT NULL) AS office_converted
"

# 看附件目录大小
du -sh data/attachments/

# Phase 3：FTS5 索引健康度（body ↔ fts 行数应该一致）
sqlite3 data/sync_store.db "
  SELECT
    (SELECT COUNT(*) FROM email_body) AS bodies,
    (SELECT COUNT(*) FROM email_body_fts) AS fts_rows,
    (SELECT COUNT(*) FROM email_body) - (SELECT COUNT(*) FROM email_body_fts) AS gap"

# 手测一次 search（不走 webhook）
python -c "
from src.repository import EmailRepository
for h in EmailRepository('data/sync_store.db').search_email_bodies('meeting', limit=3):
    print(f'{h.internal_id} bm25={h.rank:.2f} | {h.subject[:50]}')"

# 单测
pytest tests/repository/ tests/events/ -v

# 紧急回滚：关 v4 双写
# 在 .env 加: BODY_DUAL_WRITE_ENABLED=false 然后 pm2 restart mail-sync
```

### T-02 历史邮件 backfill ✅ 已完成（2026-05-15 跑完，PR-6 起 CLI 改走 `mailagent backfill body`）

Phase 1 之前已 sync 到 Notion 的历史邮件正文已回填到 SQLite，让 LLM 路径口径统一。
当前覆盖率：**6031 / 6134 = 98.3%**（差额 103 封是 `fetch_failed` / `dead_letter`，不是 backfill 漏跑）。
FTS5 索引同步（6031 rows）。详见 [`docs/phase2-complete.md`](./docs/phase2-complete.md) §7。

剩余 103 封死信邮件可走 `mailagent admin dead-letter retry <internal_id>` 单封触发重试，
backfill 工具本身无需再跑。下方命令保留作回放 / 应急参考：

```bash
# 单封验证（dry-run）
mailagent backfill body --internal-ids 53675 --dry-run

# 全量后台跑（必须先 stop pm2 mail-sync 避免 AppleScript 拥塞）
pm2 stop mail-sync
nohup mailagent backfill body --all > logs/backfill.log 2>&1 &
# 进度：tail -f logs/backfill.log 或 sqlite3 data/sync_store.db "SELECT COUNT(*) FROM email_body"
# 跑完：pm2 start mail-sync
```

---

## 迁移与运维

### v3 架构迁移

如需从 v2 迁移到 v3（internal_id 主键）：
```bash
python3 scripts/migrate_sync_store_v3.py
```

### 监控重点

```bash
# 查看 dead_letter 队列（需人工介入）
sqlite3 data/sync_store.db "SELECT COUNT(*) FROM email_metadata WHERE sync_status='dead_letter'"

# 查看重试队列
sqlite3 data/sync_store.db "SELECT internal_id, sync_status, retry_count FROM email_metadata WHERE sync_status IN ('fetch_failed', 'failed')"

# 查看同步统计
sqlite3 data/sync_store.db "SELECT sync_status, COUNT(*) FROM email_metadata GROUP BY sync_status"
```
