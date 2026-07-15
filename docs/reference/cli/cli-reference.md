# mailagent CLI 完整命令参考（从 CLAUDE.md 下沉）

> `mailagent` CLI 提供 agent-friendly 接口给本机调用 / 外部 agent / 看板。底层走 `src/cli/`（typer + rich），所有数据从 SQLite SSoT（`data/sync_store.db`）+ EmailRepository 读，写命令调 NotionSync。
> 详细 spec：[`docs/agent-cli-rfc.md`](agent-cli-rfc.md) §4 / §5 / §6 / §7。

## 安装

```bash
pip install -e ".[cli,dev]"     # cli: typer/rich/pyyaml; dev: pytest + jsonschema>=4.18 + referencing
which mailagent                  # 应是 venv/bin/mailagent
mailagent --version              # 3.0.0
mailagent --help                 # 列 10 个 group (email/admin/attachment/llm/notion/calendar/debug + backfill/project-progress/init) + global flags
```

## 读命令（只读, 无 auth）

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

## 写命令（需 auth；`--dry-run` 跳过；PR-4 起所有 batch 写命令默认走 PM2 检测，可 `--allow-concurrent` 绕过）

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
| `email draft <internal_id> [--mode reply-all\|reply/--extra-to/--extra-cc/--subject/--force-subject/--attach <path>…/--dry-run]` | 灵动岛 F1: 读 SQLite `llm_processing.labels_json.reply_suggestion_md` (SSoT, 含用户改过的) → 构造 DraftRequest → `backend.append_draft` (davmail IMAP APPEND / applescript sh) 创建回复草稿。`--attach <本地路径>` 可重复 (draft/send 同款): in-process 直读 bytes 附加为附件, 总大小 cap 20MB, 文件不存在报 E_INVALID_ARG。**reply/reply-all 下 `--subject` 与原主题规范化后 (剥 Re:/回复:/答复: 前缀) 不同 → E_INVALID_ARG**（改主题断 Outlook/Gmail 会话线程; draft/send 同款, dry-run 也拦）; 确需改题用 `--mode forward` 或 `--force-subject` |
| `notion resync <internal_id>` | alias of `email resync` |
| `notion update-flag <internal_id> [--is-read/--is-flagged/--processing-status]` | 手改 Notion 邮件页 flags |
| `notion create-task <internal_id> [--as-meeting/--no-mark-done/--dry-run]` | 灵动岛 F3/F5: LLM (`task_extractor`) 决策填字段 (精炼 title / 智能 time / 日程类型 / 优先级) → 写日程库 (CALENDAR_DATABASE_ID) page + Email Inbox relation → 标原邮件已完成. `--as-meeting` 抽邮件提到的会议实际时间 (add_to_calendar), 默认建议处理时间 (convert_to_notion_task) |
| `notion archive <page_id> --yes` | archive Notion page (move to Trash) |
| `calendar recurring replay [--internal-id N \| --ids LIST --dry-run]` | 重跑指定 internal_id 的邀请 |
| `admin dead-letter list [--limit/--mailbox]` | 列 dead_letter 邮件 (PR-4 读命令, 无 auth) |
| `admin dead-letter retry <internal_id>` | 重置 dead_letter 为 pending (PR-4) |
| `admin cleanup-deadletter [--older-than N --no-dry-run --yes]` | 清理超 N 天的 dead_letter (PR-4, 内置) |
| `admin cleanup-syncstore [--no-dry-run --yes]` | dry-run → show_stats; --no-dry-run --yes → reset_sync_status (PR-5 inline) |
| `admin cleanup-duplicates [--no-dry-run --yes]` | 扫 message_id 重复的 Notion page → archive 重复 (PR-5 inline) |
| `admin repair-parents [--thread-id ID --no-dry-run --yes]` | 修复 Notion Parent Item 断链 (PR-5 inline NotionDBCleaner.run parent_only=true) |

## PR-4 长任务退出码体系（RFC §5.2 / `email resync` batch / `backfill` / `init`）

| 退出码 | 含义 | 触发 |
|---|---|---|
| `0` | 全成功 | 所有 unit `passes: true`，无 failed |
| `6` | partial_failure | 同时 succeeded > 0 + failed > 0，未熔断 |
| `7` | aborted (`E_ABORTED`) | SIGINT 第一次（当前 unit 跑完后退） |
| `8` | max-failures (`E_MAX_FAILURES`) | 连续失败超 `--max-failures` 熔断 |
| `9` | pm2 conflict (`E_PM2_RUNNING`) | PM2 mail-sync 正 online，写命令拒绝 |
| `130` | SIGINT 二次强退 | 在 abort summary 阶段再按 Ctrl-C |

Batch 命令自动写 `cli_checkpoints` 表（每 N=50 unit）；中断后用同 `<command, target_key>` 再跑会自动 resume，从 `last_completed_internal_id+1` 续。

## 全局 flags

写在 subcommand **之前**，例 `mailagent -o json email get 53675`：`-o/--output {text,json,yaml,ndjson}` / `-q/--quiet` / `-v/--verbose` / `--db-path` / `--api-key` / `--config` / `--no-color` / `--version`。每个 leaf 也暴露 `-o` 供 gh/kubectl 风格的"flag 后置"使用。

## 写命令鉴权（RFC §5.3）

默认要 token。设 `MAILAGENT_CLI_API_KEY` 后写命令必须经 `--api-key` 提供同值；服务端未配且 `MAILAGENT_CLI_ALLOW_UNAUTH_WRITES=true` 时显式放行（仅 dev 模式）。`--dry-run` 跳过鉴权。

## JSON Schema 契约

[`docs/cli-schema/`](../../cli-schema) 含 45+ schema 文件（含 `_common.schema.json`）+ `error-codes.md` 列 11 个 `E_*` enum（PR-4 新增 `E_MAX_FAILURES` / `E_PM2_RUNNING`）。所有 wrapper 形如 `{status, schema_version: 1, data | error, meta: {duration_ms, ...}}` (RFC §5.1.2)。

## PR-6 scripts 迁移现状

**PR-6 已 ship**: 6 个真 thin wrapper 顶层脚本 git rm（backfill_email_body / backfill_derivatives / sync_project_progress / compare_llm_path / run_llm_on_email / resync_notion），5 个 CLI 依赖 module 删 `__main__` 入口保留 class/函数作 import-only（initial_sync / cleanup_syncstore / cleanup_duplicate_message_ids / cleanup_notion_db / replay_recurring_invite）。旧用法 `python scripts/<wrapper>.py …` 现报 `No such file or directory`；改走 `mailagent <group> <action> …` CLI。DB_VERSION 仍 6，10 个 CLI group / 45+ schema / 退出码体系（0/1/2/4/5/6/7/8/9/130）不变。pytest 655 passed。

详见 [`docs/archive/pr5-handoff-scripts-migration.md`](../../archive/2026-05/pr5-handoff-scripts-migration.md) + [`docs/archive/pr6-handoff-deprecation-cleanup.md`](../../archive/2026-05/pr6-handoff-deprecation-cleanup.md)。

## 典型 agent 调用样例

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
