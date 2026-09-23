---
title: "命令组参考"
description: "mailagent 全部 16 个命令组（email / attachment / llm / kos / notion / calendar / debug / backfill / project-progress / init / folder / report / api-key / im / contact / admin）的 synopsis、关键 flag 与 jq 调用样例。"
---

本页是全部 16 个命令组的速查：每组给 synopsis、关键 flag、可复制的 `-o json | jq` 样例。完整字段契约见 [输出格式](/agent/output-formats/)，退出码见 [退出码契约](/agent/exit-codes/)，写命令鉴权见 [鉴权契约](/agent/auth/)。

:::tip[读法]
全局 flag（`-o json` / `--db-path` / `--api-key`）写在 `<resource> <action>` **之前**。下面样例为简洁多把 `-o json` 写在最前。带 ✏️ 的是写命令（需 `MAILAGENT_CLI_API_KEY`）。
:::

## `email` — 邮件 CRUD / 搜索 / 重传 / flag / 置顶 / 归档 / 草稿 / 发送 / 退订

```
email get <internal_id> [--include {body,attachments,all}]
email list [--mailbox/--status/--since/--until/--from/--subject/--is-read/--is-flagged/--has-notion/--limit/--offset/--source]
email body <internal_id> [--format {markdown,html,raw}]
email search <query> [--mailbox/--since/--until/--limit/--no-snippet/--raw]
email resync <id|--range LO-HI|--ids 1,2,3> [--replace-existing/--no-parent/--dry-run/--max-failures/--resume-from/--progress-every/--allow-concurrent]   ✏️
email flag <id|--ids 1,2,3> [--is-read/--no-is-read][--is-flagged/--no-is-flagged][--processing-status STATUS][--dry-run/--allow-concurrent]   ✏️
email pin <internal_id> [--dry-run]      ✏️
email unpin <internal_id> [--dry-run]    ✏️
email list-pinned
email archive <internal_id> [--dry-run]   ✏️  (davmail-only: IMAP MOVE 收件箱→Archive)
email draft <internal_id> [--mode reply|reply-all|forward][--extra-to/--extra-cc/--to/--cc/--bcc/--subject/--attach/--dry-run]   ✏️
email send <internal_id> [--mode ...][--yes]   ✏️  (SMTP 真实发送，不可逆)
email unsubscribe <internal_id> [--dry-run/--no-mark-done]   ✏️
```

关键点：`email get` 默认只返 metadata，`--include` 选择性附加；`email body --format raw` 仅返 `raw_mime_sha256` 哈希（不带原 MIME）；`email search` 是 FTS5 全文（语法见 [搜索 DSL](/agent/search-dsl/)）；`email flag` 把 intent 写 SQLite + `email_outbox` 双 target，FanoutWorker 异步派发到 Mail.app + Notion；`email pin`/`unpin` 只是本地/前端持久化标记，mail-sync 主进程不读不写；`email send` 复用 `email draft` 的构造逻辑保证「草稿预览 = 实际发送内容」，text 模式走交互确认，json 模式（前端/自动化）不带 `--yes` 直接拒绝；`email unsubscribe` 解析 `List-Unsubscribe` header（RFC 2369/8058）智能执行 one-click POST / 打开链接 / 打开 mailto，默认退订后标记邮件已完成。

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

# ✏️ 置顶 / 列出置顶
mailagent -o json email pin 53675 | jq '.status'
mailagent -o json email list-pinned | jq '.data'

# ✏️ 归档收件箱邮件（davmail-only）
mailagent -o json email archive 53675 --dry-run | jq '.data'

# ✏️ 发送（先 dry-run 走 email draft 看预览，再真发）
mailagent -o json email draft 53675 --mode reply-all --dry-run | jq '.data'
mailagent -o json email send 53675 --mode reply-all --yes | jq '.status'
```

:::caution[中文字面量 flag]
`--mailbox` / `--processing-status` 的值常是**中文字面量**，即便在英文 shell 里也必须传中文：`--mailbox 收件箱`、`--processing-status '已完成'`。带空格 / 中文的值用引号包裹，确保 shell 按 UTF-8 编码传入。
:::

## `attachment` — 附件

```
attachment list <internal_id>
attachment download <attachment_id> [--dest PATH]
attachment search <query> [--mailbox/--since/--until/--limit/--no-snippet/--raw]
attachment extract [--pending/--include-missing/--requeue-unsupported/--requeue-extractor NAME/--limit N/--dry-run]   ✏️
attachment cleanup-orphans [--no-dry-run --yes]        ✏️
```

`download` 默认把二进制写 stdout；给 `--dest` 则写文件并返 JSON 元信息。`search` 是附件正文/文件名的 FTS5 全文搜索，跟 `email search` 平行。`extract` 是附件文本抽取的手动补量入口（长驻服务里有 supervised worker 默认消费 pending 队列，`MAILAGENT_ATTACHMENT_TEXT_WORKER_ENABLED` 关闭时靠本命令推进）。

```bash
# 附件个数
mailagent -o json attachment list 53675 | jq '.data | length'

# 下载到文件（返回元信息 JSON）
mailagent -o json attachment download 1024 --dest /tmp/out.pdf | jq '.data'

# 搜附件全文（PDF / docx / pptx / xlsx）
mailagent -o json attachment search "合同" --limit 10 | jq '.data'

# ✏️ dry-run 看待处理的抽取积压
mailagent -o json attachment extract --pending --dry-run | jq '.data'
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
backfill body [--since-date/--until-date/--mailbox/--internal-ids/--all/--limit/--force/--dry-run/--max-failures/--resume-from/--progress-every/--retry-dead/--allow-concurrent]   ✏️
backfill metadata [--source {notion,applescript}/--since-date/--until-date/--mailbox/--internal-ids/--all/--limit/--force/--dry-run/--max-failures/--resume-from/--progress-every/--allow-concurrent]   ✏️
```

`backfill body` 把历史邮件正文双写到 SQLite（v4 SSoT）；`backfill metadata` 补 `to`/`cc`/`sender_name`/`is_important`（不动 body），`--source notion`（默认，快）反拉 Notion page properties，`--source applescript`（慢，需停 pm2）走 AppleScript 拿完整 MIME 头解析。两者都是长任务，遵循 [长任务契约](/agent/long-tasks/)（PM2 检测 / 熔断 / checkpoint）。

```bash
# ✏️ dry-run 回填某区间正文
mailagent -o json backfill body --internal-ids 53000,53001,53002 --dry-run | jq '.data.summary'

# ✏️ 补 metadata（默认走 Notion 反拉，安全与 mail-sync 并发）
mailagent -o json backfill metadata --since-date 2026-01-01 --dry-run | jq '.data.summary'
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

## `admin` — 统计 / 健康 / db-version / 死信 / cleanup / config

```
admin stats [--section {watcher,sync_store,handlers,v4_rollout,outbox,all}]
admin health
admin db-version
admin dead-letter list [--limit/--mailbox]
admin dead-letter retry <internal_id>            ✏️
admin dead-letter delete <internal_id>           ✏️
admin cleanup-deadletter [--older-than N --no-dry-run --yes]   ✏️
admin cleanup-syncstore [--no-dry-run --yes]     ✏️
admin cleanup-duplicates [--no-dry-run --yes]    ✏️
admin repair-parents [--thread-id ID --no-dry-run --yes]   ✏️
admin repair-date-tz [--sample N --no-dry-run --yes]   ✏️
admin fts-health
admin pm2-status
admin queue-depth
admin export-diagnostics [--app-version/--no-quick-check]
admin config show [--key/--show-secrets]
admin config get <key> [--show-secrets]
admin config set <key> <value> [--dry-run/--yes]   ✏️
```

`admin health` 退 `0`=健康 / `1`=不健康。`admin stats` 的指标带 `_source`（`live_query` vs `stats_reporter_last_snapshot`）+ `_snapshot_at` + `_warn_if_stale_sec`——agent 据此判断指标是否 stale（如 mail-sync 停了，snapshot 是旧数据）。`admin config show/get` 默认脱敏敏感字段（`***last4`），加 `--show-secrets` 才需鉴权；`admin config set` 直接写 `.env`（atomic tmp+replace），生效需 `pm2 restart mail-sync`。

```bash
# 健康闸
mailagent -o json admin health | jq -e '.data.healthy == true'

# 各状态分布
mailagent -o json admin stats --section all | jq '.data.sync_store.by_status'

# 读一个配置字段（不带 --show-secrets 免鉴权）
mailagent -o json admin config get MAILAGENT_BACKEND | jq '.data'

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

## `calendar` — 日历 / 会议 CRUD（CalDAV，Phase 2）

```
calendar events [--from/--to/--calendar/--source/--limit/--no-expand]
calendar today
calendar week
calendar event-get <ical_uid> [--recurrence-id/--source]
calendar sync-status
calendar sync-now                                  ✏️
calendar create --summary S --start ISO --end ISO [--location/--description/--attendee/--calendar/--status/--rrule/--all-day]   ✏️
calendar update <ical_uid> [--summary/--start/--end/--attendee/--clear-attendees/--rrule/--all-day/--recurrence-id/--split-future/...]   ✏️
calendar delete <ical_uid> --yes [--calendar]      ✏️
calendar rsvp <ical_uid> <accept|tentative|decline> [--recurrence-id/--source/--dry-run]   ✏️
calendar expand [--horizon-weeks W --dry-run]      ✏️ (--no-dry-run)
calendar replay <internal_id|--ids LIST> [--dry-run]   ✏️
calendar recurring discover [--since DATE --discover-limit N]
calendar recurring replay <internal_id|--ids LIST> [--dry-run]   ✏️
```

`events`/`today`/`week`/`event-get`/`sync-status` 都是只读：`events` 读 `calendar_event` 表已展开的 occurrence（默认按 RRULE 展开，`--no-expand` 只看主事件）；`create`/`update`/`delete` 直接 CalDAV PUT/DELETE 写 Exchange（`update` 传 `--recurrence-id` 只改单次 occurrence，`--split-future` 从该次起拆分新 series）；`rsvp` 发 iTIP REPLY 给原 invite 的 organizer；`sync-now` 手动触发一次 CalDAV → SQLite 同步（mail-sync 进程内 worker 会自动跑）；`expand` 是周期会议 occurrence 滚动展开的单次手动触发；`replay`/`recurring replay` 对指定邀请重跑 `meeting_sync`（历史 recurring mis-sync 修复用）；`recurring discover` 扫带 RRULE 的邀请（只读）。

```bash
# 读今天的日程
mailagent -o json calendar today | jq '.data'

# ✏️ 创建一个单次事件
mailagent -o json calendar create --summary "评审会" \
  --start 2026-10-01T14:00:00+08:00 --end 2026-10-01T15:00:00+08:00 --api-key "$MAILAGENT_CLI_API_KEY"

# ✏️ dry-run 接受一个邀请
mailagent -o json calendar rsvp <ical-uid> accept --dry-run | jq '.data.body_preview'

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

## `kos` — KOS 入库台账统计（只读）

```
kos stats
```

`kos_ingest_log` 表统计：status 分布 + 错误码分布 + 重试积压 + 健康。需 `MAILAGENT_KOS_INGEST_ENABLED` 开启才有数据。

```bash
mailagent -o json kos stats | jq '.data'
```

## `folder` — 存档 / 草稿文件夹管理（davmail-only）

```
folder discover [--counts]
folder enable <imap_name> [--dry-run]           ✏️
folder disable <imap_name> [--dry-run]          ✏️
folder create <name> [--parent PARENT]          ✏️
folder rename <imap_name> <new_name>            ✏️
folder delete-folder <imap_name>                ✏️  (不可撤销)
folder cleanup <imap_name>                      ✏️  (只删本地副本, 不碰 Exchange)
```

`discover` 发现 Exchange 全部文件夹（层级 + special-use + 是否在 `SYNC_FOLDERS` 白名单），默认不取邮件数（大邮箱慢），加 `--counts` opt-in。`enable`/`disable` 写 `.env` 的 `SYNC_FOLDERS` 白名单，需 `pm2 restart mail-sync` 生效。`create`/`rename`/`delete-folder` 直接操作 Exchange 文件夹（IMAP CREATE/RENAME/DELETE），系统文件夹一律拒绝。`cleanup` 反过来只清本地已同步副本，不触碰 Exchange。

```bash
# 发现文件夹树（只读）
mailagent -o json folder discover | jq '.data.tree'

# ✏️ 把某文件夹加入同步白名单
mailagent -o json folder enable "INBOX.Projects" --dry-run | jq '.data'
```

## `report` — 报告 Agent（/agents 页 IPC 后端）

```
report run [--agent ID --cadence daily|weekly|monthly]        ✏️
report list [--cadence/--agent/--limit/--offset]
report get <report_id>
report delete <report_id>                                     ✏️
report config-get [--agent ID]
report config-set --patch JSON [--agent ID]                   ✏️
report agent-create --id ID [--type report|search|custom --title/--enabled/--model/--prompt/--tools-json]   ✏️
report agent-delete --agent ID                                ✏️
```

`run` 立即跑一次报告生成（`runNow`），返回 `{report_id, status, headline, cadence, report_date}`；`list`/`get` 不含/含 `blocks_json`；`config-get`/`config-set` 是 agent 配置的读写面（`config-set` 走 friendly patch → DB 列映射，如 `schedule` → `schedule_json`）；`agent-create` 的 `type=custom` 需 `MAILAGENT_CUSTOM_AGENTS_ENABLED`。

```bash
# ✏️ 立即跑一次日报
mailagent -o json report run --agent daily_email_digest | jq '.data'

# 报告列表
mailagent -o json report list --cadence daily --limit 10 | jq '.data'

# 读单份报告
mailagent -o json report get daily_email_digest:daily:2026-06-02 | jq '.data.headline'
```

## `api-key` — scoped Bearer agent key（headless agent 接入）

```
api-key create --label LABEL [--scopes a,b,c | --preset readonly|handoff|drafter|writer] [--expires-at EPOCH]   ✏️
api-key list [--active-only]
api-key revoke <key_id>                        ✏️
api-key rotate <key_id>                        ✏️
```

给 Skill Delivery API（[`/api/skills`](/agent/skill-delivery/)）签发/管理 scoped Bearer key。`create` 返回的 `key`（`mak_…` 明文）**仅此一次可见**；`list` 只见 metadata，不含明文/hash；`revoke` 立即 fail-closed；`rotate` 换新明文、旧明文立即失效。

```bash
# ✏️ 签发一把只读 key
mailagent api-key create --label my-agent --preset readonly | jq '.data.key'

mailagent -o json api-key list | jq '.data'
```

## `im` — 飞书对话绑定

```
im pair [--rebind]      ✏️
im status
```

`pair` 生成一次性绑定码（6 位数字，TTL 10 分钟），在飞书私聊里把这串数字发给 bot 完成绑定；已绑定时默认拒绝再出码，换设备用 `--rebind`。`status` 读 `sync_state` 的 `im.feishu.*` 连接/绑定状态。本组写命令刻意不做 PM2 冲突检测——飞书 bot 只在长驻服务跑着时才收得到消息。

```bash
mailagent -o json im status | jq '.data'
```

## `contact` — 通讯录 backfill

```
contact backfill [--rescan/--calibrate-only/--batch-size N/--dry-run]   ✏️
```

催跑通讯录 L0+L1 扫描并校准聚合缓存（`mail_count`/`sent_to_count`/首末时间）。`--dry-run` 只报告积压量，免鉴权；`--rescan` 把 watermark 重置为 0 全量重扫；`--calibrate-only` 跳过扫描只重算聚合缓存。

```bash
# 只看积压量（免鉴权）
mailagent -o json contact backfill --dry-run | jq '.data'
```

## 深入了解

- [全局 flag 与输出格式](/agent/output-formats/) — JSON wrapper / label+key / NDJSON
- [退出码契约](/agent/exit-codes/) — batch partial_failure / pm2 conflict
- [长任务契约](/agent/long-tasks/) — backfill / init / resync batch
- [写命令鉴权契约](/agent/auth/) — ✏️ 命令的 token 要求
- 完整命令表：[`cli-reference.md`](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/cli/cli-reference.md) · 命令树 spec：[`agent-cli-rfc.md` §4](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/cli/agent-cli-rfc.md)
