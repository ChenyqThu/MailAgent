---
title: "10 大命令组参考"
description: "mailagent 全部 10 个命令组（email / attachment / llm / backfill / notion / admin / init / calendar / debug / project-progress）的 synopsis、关键 flag 与 jq 调用样例。"
---

本页是 10 个命令组的速查：每组给 synopsis、关键 flag、可复制的 `-o json | jq` 样例。完整字段契约见 [输出格式](/agent/output-formats/)，退出码见 [退出码契约](/agent/exit-codes/)，写命令鉴权见 [鉴权契约](/agent/auth/)。

:::tip[读法]
全局 flag（`-o json` / `--db-path` / `--api-key`）写在 `<resource> <action>` **之前**。下面样例为简洁多把 `-o json` 写在最前。带 ✏️ 的是写命令（需 `MAILAGENT_CLI_API_KEY`）。
:::

## `email` — 邮件 CRUD / 搜索 / 重传 / flag / 草稿

```
email get <internal_id> [--include {body,attachments,all}]
email list [--mailbox/--status/--since/--until/--from/--subject/--is-read/--is-flagged/--has-notion/--limit/--offset/--source]
email body <internal_id> [--format {markdown,html,raw}]
email search <query> [--mailbox/--since/--until/--limit/--no-snippet]
email resync <id|--range LO-HI|--ids 1,2,3> [--replace-existing/--no-parent/--dry-run/--max-failures/--resume-from/--progress-every/--allow-concurrent]   ✏️
email flag <id|--ids 1,2,3> [--is-read/--no-is-read][--is-flagged/--no-is-flagged][--processing-status STATUS][--dry-run/--allow-concurrent]   ✏️
email delete <internal_id> [--yes]   ✏️
email draft <internal_id> [--mode reply|reply-all][--extra-to/--extra-cc/--dry-run]   ✏️
```

关键点：`email get` 默认只返 metadata，`--include` 选择性附加；`email body --format raw` 仅返 `raw_mime_sha256` 哈希（不带原 MIME）；`email search` 是 FTS5 全文（语法见 [搜索 DSL](/agent/search-dsl/)）；`email flag` 把 intent 写 SQLite + `email_outbox` 双 target，FanoutWorker 异步派发到 Mail.app + Notion。

```bash
# 取主题
mailagent -o json email get 53675 | jq -r '.data.subject'

# 列收件箱已同步的前 10 封，提 id + 状态
mailagent -o json email list --mailbox 收件箱 --status synced --limit 10 \
  | jq '.data[] | {id: .internal_id, status: .sync_status}'

# 全文搜索，提 id + 高亮 snippet
mailagent -o json email search "redis AND timeout" --mailbox 收件箱 --limit 20 \
  | jq '.data[] | {id: .internal_id, snippet}'

# 取正文 markdown
mailagent -o json email body 53675 --format markdown | jq -r '.data.content'

# ✏️ 标已读 + 标旗（单封）
mailagent -o json email flag 53675 --is-read --is-flagged | jq '.status'

# ✏️ dry-run 重传（免鉴权，先看 plan）
mailagent -o json email resync 53675 --replace-existing --dry-run | jq '.data'
```

:::caution[中文字面量 flag]
`--mailbox` / `--processing-status` 的值常是**中文字面量**，即便在英文 shell 里也必须传中文：`--mailbox 收件箱`、`--processing-status '已完成'`。带空格 / 中文的值用引号包裹，确保 shell 按 UTF-8 编码传入。
:::

## `attachment` — 附件

```
attachment list <internal_id>
attachment download <attachment_id> [--dest PATH]
attachment derive <internal_id> [--dry-run]            ✏️  (alias → backfill derivatives)
attachment cleanup-orphans [--no-dry-run --yes]        ✏️
```

`download` 默认把二进制写 stdout；给 `--dest` 则写文件并返 JSON 元信息。`derive` 是 `backfill derivatives` 的 alias（会带 deprecation 提示）。

```bash
# 附件个数
mailagent -o json attachment list 53675 | jq '.data | length'

# 下载到文件（返回元信息 JSON）
mailagent -o json attachment download 1024 --dest /tmp/out.pdf | jq '.data'
```

## `llm` — LLM 分类 / 健康 / 统计 / 路径对比

```
llm run <internal_id> [--dry-run/--force/--no-overwrite]   ✏️
llm selftest
llm retry-failed [--limit N --dry-run]                     ✏️
llm stats [--days N]
llm compare-paths [--count N|--internal-ids LIST][--dry-run/--no-dry-run --yes]
```

`llm run` 对单封跑分类填 Notion AI 字段，输出含 label+key 双字段（`priority_key`/`priority_label` 等，见 [输出格式](/agent/output-formats/)）；`llm selftest` 是 gateway 健康检查，不烧 token、不写 Notion。

```bash
# gateway 是否健康
mailagent -o json llm selftest | jq '.data.healthy'

# ✏️ dry-run 看分类结果（免鉴权）
mailagent -o json llm run 53675 --dry-run | jq '.data.labels'

# 近 7 天缓存命中率
mailagent -o json llm stats --days 7 | jq '.data.cost.cache_hit_rate_pct'
```

## `backfill` — 历史回填（长任务）

```
backfill body [--since-date/--until-date/--mailbox/--internal-ids/--all/--limit/--force/--dry-run/--resume-from/--retry-dead]   ✏️
backfill derivatives [--internal-id N --dry-run]   ✏️
```

`backfill body` 把历史邮件正文双写到 SQLite（v4 SSoT），`backfill derivatives` 补 Office 衍生（docx→PDF / xlsx→CSV）。两者都是长任务，遵循 [长任务契约](/agent/long-tasks/)（PM2 检测 / 熔断 / checkpoint）。

```bash
# ✏️ dry-run 回填某区间正文
mailagent -o json backfill body --internal-ids 53000-53100 --dry-run | jq '.data.summary'
```

## `notion` — Notion 直接操作（写为主）

```
notion resync <internal_id>                               ✏️  (alias of email resync)
notion update-flag <internal_id> [--is-read/--is-flagged/--processing-status]   ✏️
notion create-task <internal_id> [--as-meeting/--no-mark-done/--dry-run]   ✏️
notion archive <page_id> --yes                            ✏️
notion page-orphans [--dry-run]
notion file-link-audit [--internal-id N --dry-run]
```

`page-orphans` / `file-link-audit` 默认 `--dry-run`（只读审计、免鉴权）；加真修复 flag 后才变写命令。`create-task` 用 LLM 决策填日程库字段并标原邮件已完成。

```bash
# 审计某封的 Notion 文件链接状态（只读）
mailagent -o json notion file-link-audit --internal-id 53675 | jq '.data'

# 扫 Notion 有 page 但本地无 metadata 的孤儿（只读）
mailagent -o json notion page-orphans --dry-run | jq '.data | length'
```

## `admin` — 统计 / 健康 / db-version / 死信 / cleanup

```
admin stats [--section {watcher,handlers,llm,reverse,all}]
admin health
admin db-version
admin dead-letter list [--limit/--mailbox]
admin dead-letter retry <internal_id>            ✏️
admin cleanup-deadletter [--older-than N --no-dry-run --yes]   ✏️
admin cleanup-syncstore [--no-dry-run --yes]     ✏️
admin cleanup-duplicates [--no-dry-run --yes]    ✏️
admin repair-parents [--thread-id ID --no-dry-run --yes]   ✏️
```

`admin health` 退 `0`=健康 / `1`=不健康。`admin stats` 的指标带 `_source`（`live_query` vs `stats_reporter_last_snapshot`）+ `_snapshot_at` + `_warn_if_stale_sec`——agent 据此判断指标是否 stale（如 mail-sync 停了，snapshot 是旧数据）。

```bash
# 健康闸
mailagent -o json admin health | jq -e '.data.healthy == true'

# 各状态分布
mailagent -o json admin stats --section all | jq '.data.sync_store.by_status'

# db 版本是否匹配
mailagent -o json admin db-version | jq '{current: .data.db_version, expected: .data.expected}'

# 死信列表
mailagent -o json admin dead-letter list --limit 50 | jq '.data | length'
```

## `init` — 初始化同步（长任务）

```
init fetch-cache [--inbox-count N --sent-count M]   ✏️
init analyze [--input PATH --report-out PATH --skip-fetch]   ✏️
init fix-properties [--yes --report-in PATH]        ✏️
init fix-critical [--yes --report-in PATH]          ✏️
init update-parents [--yes --report-in PATH]        ✏️
init sync-new [--yes]                               ✏️
init all [--yes --inbox-count N --sent-count M --report-out PATH]   ✏️
```

`init all` 按序跑 7 个 sub-action（fetch-cache → analyze → fix-properties → fix-critical → update-parents → sync-new）。大邮箱耗时较长，遵循 [长任务契约](/agent/long-tasks/)。

```bash
# ✏️ 一键初始化（自动化用 --yes）
mailagent -o json init all --yes --inbox-count 3000 --sent-count 500 | jq '.data.summary'
```

## `calendar` — 日历 / 会议展开

```
calendar expand [--horizon-weeks W --dry-run]      ✏️ (--no-dry-run)
calendar recurring discover [--since DATE --discover-limit N]
calendar recurring replay <internal_id|--ids LIST> [--dry-run]   ✏️
```

`calendar expand` 是周期会议 occurrence 滚动展开的单次手动触发；`recurring discover` 扫带 RRULE 的邀请（只读）；`recurring replay` 对指定邀请重跑 `meeting_sync`。

```bash
# 扫周期会议（只读）
mailagent -o json calendar recurring discover --since 2026-04-01 | jq '.data'
```

## `debug` — 调试工具（全只读）

```
debug email-source <internal_id> [--save-to PATH]
debug mail-structure
debug inline-images <internal_id>
debug applescript-fetch <internal_id> [--mailbox X]
debug notion-page <page_id>
```

`debug mail-structure` 列 Mail.app accounts + mailboxes，是配 `SYNC_MAILBOXES` / 排查邮箱名的起点。`debug applescript-fetch` 绕过 SQLite SSoT 直接跑 AppleScript（fallback 路径取证）。

```bash
# 列邮箱结构（配置 / 排错用）
mailagent -o json debug mail-structure | jq '.data'
```

:::caution[EWS 关停]
`debug applescript-fetch` 与 DavMail / EWS 链路：生产主路径走 DavMail 6.7 桥 EWS，**EWS 2026-10-01 关停**。详见 [`roadmap-post-cutover.md` §5.1](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/architecture/roadmap-post-cutover.md)。AppleScript fallback 不受影响。
:::

## `project-progress` — 项目周报同步外挂

```
project-progress sync [--internal-id/--all-history/--limit/--sheets {ongoing,shipped,suspended,all}/--dry-run/--force/--backfill-project-start/--first-migration-dry-run]   ✏️
```

把邮件附件里的项目进度 xlsx 同步进 Notion。需开 `PROJECT_PROGRESS_SYNC_ENABLED`。

```bash
# ✏️ dry-run 同步单封的进度表
mailagent -o json project-progress sync --internal-id 52258 --dry-run | jq '.data'
```

## 深入了解

- [全局 flag 与输出格式](/agent/output-formats/) — JSON wrapper / label+key / NDJSON
- [退出码契约](/agent/exit-codes/) — batch partial_failure / pm2 conflict
- [长任务契约](/agent/long-tasks/) — backfill / init / resync batch
- [写命令鉴权契约](/agent/auth/) — ✏️ 命令的 token 要求
- 完整命令表：[`cli-reference.md`](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/cli/cli-reference.md) · 命令树 spec：[`agent-cli-rfc.md` §4](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/cli/agent-cli-rfc.md)
