---
title: "运维 / 健康检查 / 监控自动化"
description: "用 mailagent admin health / db-version / stats、stale 检测、dead-letter 监控、SQLite 状态分布查询、pm2、llm selftest 给自动化把运行状态钉死。"
---

这一节是给**自动化巡检**用的：怎么用 `mailagent admin *` + 几条 SQLite 查询，让脚本/agent 判断 MailAgent 到底活着没、同步有没有堆积、有没有死信。

:::tip[巡检三连]
`admin health`（活着没）→ `admin stats`（堆积没 + 数据新不新）→ dead-letter 查询（卡住没）。三个都绿 = 系统健康。
:::

## 健康检查 `admin health`

跑 health_check（SyncStore 可达 + db_version + 必备表检查），exit `0` 健康 / `1` 不健康。这是巡检的第一道 gate：

```bash
mailagent admin health -o json | jq -e '.data.healthy' >/dev/null \
  && echo "OK" || echo "UNHEALTHY"
```

```jsonc
// admin health -o json
{ "status": "success", "data": { "healthy": true, "checks": [ /* … */ ] },
  "meta": { "duration_ms": 12 } }
```

## DB 版本 `admin db-version`

打印当前 `db_version` + expected + compatible。打包 app 启动门控、迁移后验证都看它：

```bash
mailagent admin db-version -o json | jq '.data | {db_version, expected, compatible}'
```

:::caution[DB_VERSION 双源]
`DB_VERSION` 是 Python 常量，前端 `EXPECTED_DB_VERSION`（`backend_lifecycle.ts`）是手抄副本。bump 时两处必须同步，否则打包 app 启动门控会卡。`compatible:false` = 版本不匹配，需迁移。
:::

## 服务统计 `admin stats` + stale 检测

`admin stats` 汇总服务运行状态，按 section 输出，每个 section 带 `_source` 标识数据从哪来：

```bash
mailagent admin stats -o json | jq '.data'
mailagent admin stats --section watcher -o json
```

```jsonc
{
  "watcher":    { "polls": 12453, "emails_synced": 8421, "errors": 12,
                  "consecutive_errors": 0, "_source": "stats_reporter_last_snapshot" },
  "sync_store": { "total_emails": 8493,
                  "by_status": { "synced": 7891, "dead_letter": 12, "fetch_failed": 5,
                                 "failed": 3, "skipped": 582 },
                  "db_size_mb": 234.5, "_source": "live_query" },
  "v4_rollout": { "from_sqlite_hit": 421, "fallback_miss": 0, "fallback_error": 0,
                  "_source": "stats_reporter_last_snapshot",
                  "_snapshot_at": "2026-05-16T01:30:00+08:00",
                  "_warn_if_stale_sec": 300 }
}
```

**`_source` 语义**（决定能不能信这个数）：

| `_source` | 含义 | 信任度 |
|---|---|---|
| `live_query` | CLI 直接查 SQLite 算出 | 实时，永远可信 |
| `stats_reporter_last_snapshot` | 来自 mail-sync 进程上报的快照 | 看 `_snapshot_at` 判 stale |

:::caution[CLI 是短进程，内存计数器永远是 0]
`watcher` / `handlers` / `v4_rollout` 等 section 的真实命中数在 PM2 `mail-sync` 进程内存里。CLI 是短命进程，拿到的是**持久化快照**而非实时。**stale 检测**：`now - _snapshot_at > _warn_if_stale_sec`（默认 300s）→ 说明 mail-sync 可能停了，这些数是旧的，别据此下结论。
:::

```bash
# stale 检测：快照超过 _warn_if_stale_sec 就告警
mailagent admin stats --section v4_rollout -o json | jq '
  .data.v4_rollout as $r
  | ($r._snapshot_at | fromdateiso8601) as $t
  | (now - $t) as $age
  | if $age > $r._warn_if_stale_sec
    then "STALE: snapshot \($age|floor)s old" else "fresh" end'
```

## 死信监控（dead-letter）

死信 = 重试达上限、卡住不动的邮件，是巡检要盯的核心异常信号。

```bash
# 列死信（读命令，无 auth）
mailagent admin dead-letter list -o json | jq '.data'
mailagent admin dead-letter list --limit 50 --mailbox 收件箱 -o json

# 重置某封死信为 pending（写命令，需 auth），下次 poll 重跑
mailagent admin dead-letter retry 53675 --api-key "$MAILAGENT_CLI_API_KEY" -o json

# 清理超 N 天的死信记录
mailagent admin cleanup-deadletter --older-than 30 --no-dry-run --yes \
  --api-key "$MAILAGENT_CLI_API_KEY"
```

## SQLite 状态分布查询（兜底，绕过 CLI）

CLI 不可用时（或要更细的口径），直接查 `data/sync_store.db`：

```bash
# 各状态计数（同步是否健康一眼看清）
sqlite3 data/sync_store.db \
  "SELECT sync_status, COUNT(*) FROM email_metadata GROUP BY sync_status"

# 死信数
sqlite3 data/sync_store.db \
  "SELECT COUNT(*) FROM email_metadata WHERE sync_status='dead_letter'"

# 卡在重试的明细
sqlite3 data/sync_store.db \
  "SELECT internal_id, sync_status, retry_count FROM email_metadata
   WHERE sync_status IN ('fetch_failed','failed')"
```

Sprint 15 outbox（SSoT inversion）的派发队列健康，盯 `email_outbox`：

```bash
# outbox 状态分布
sqlite3 data/sync_store.db "SELECT status, COUNT(*) FROM email_outbox GROUP BY status"
# 死信无异常增长
sqlite3 data/sync_store.db "SELECT COUNT(*) FROM email_outbox WHERE status='dead_letter'"
# pending 堆积 >30min（突增即排查 FanoutWorker）
sqlite3 data/sync_store.db \
  "SELECT COUNT(*) FROM email_outbox
   WHERE status='pending' AND created_at < strftime('%s','now')-1800"
# 长任务（async_jobs）终态分布
sqlite3 data/sync_store.db "SELECT status, COUNT(*) FROM async_jobs GROUP BY status"
```

:::note[需要 Full Disk Access]
直接查 `data/sync_store.db` 需 macOS 完全磁盘访问权限（系统设置 → 隐私与安全 → 完全磁盘访问权限）。无 FDA → SQLite 无法访问。
:::

## PM2 进程巡检

主同步服务跑在 PM2（进程名 `mail-sync`），远程 webhook 在 `mailagent-webhook`：

```bash
pm2 status                                          # 进程存活
pm2 logs mail-sync --lines 30 --nostream            # 近 30 行日志（无 error）
pm2 restart mail-sync && sleep 3 \
  && pm2 logs mail-sync --lines 20 --nostream       # 重启后验证
```

:::caution[PM2 与桌面 app 不可双写]
用桌面 `.app` 时 PM2 `mail-sync` **必须停**（防双写同一库）。davmail 用户的 `davmail-poc` 进程留着（EWS 桥）。写命令（batch resync / backfill）启动前会检测 PM2 `mail-sync` 是否 online，online 则拒绝退出 `9`（`E_PM2_RUNNING`），需 `--allow-concurrent` 绕过（见 [长任务契约](/agent/long-tasks/)）。
:::

## LLM gateway 自检 `llm selftest`

不烧 token、不写 Notion，纯探活 LLM 网关：

```bash
mailagent llm selftest -o json | jq '.data.healthy'
# LLM 处理统计（status 分布 + cost + cache 命中率 + latency）
mailagent llm stats --days 7 -o json | jq '.data.cost.cache_hit_rate_pct'
```

## EWS 2026-10-01 关停 —— 运维必知

:::danger[关键死线]
生产 davmail 模式下，所有 Mail.app 写操作经 **DavMail 6.7 → EWS 桥接 Exchange**。Microsoft 已公布 **Exchange Web Services for Office 365 于 2026-10-01 关停**，DavMail 6.7 仍依赖 EWS、Graph 路线图（[Issue #404](https://github.com/mguessan/davmail/issues/404)）未 merge。

双轨应对（Path A: DavMail Graph 模式 / Path B: 原生 Graph SDK 重写）+ DavMail OAuth token 监控（token.dat 过期最致命）+ EWS throttling burst 监控见 **`docs/reference/architecture/roadmap-post-cutover.md` §5.1**。AppleScript fallback 始终可用作 last-resort 兜底。
:::

运维侧已知风险点：cutover 当天曾因 mail-sync 反复 probe `SELECT INBOX` 触发 EWS searchMessages throttling 死锁（已改 `NOOP` probe，8.5s→150ms）。日志里出现 `EWSThrottlingException: The server cannot service this request right now` 即 throttling 信号。

## 巡检脚本骨架

```bash
#!/usr/bin/env bash
set -euo pipefail
DB="data/sync_store.db"

# 1. 活着没
mailagent -o json admin health | jq -e '.data.healthy' >/dev/null \
  || { echo "::FAIL:: unhealthy"; exit 1; }

# 2. 死信卡住没
DL=$(sqlite3 "$DB" "SELECT COUNT(*) FROM email_metadata WHERE sync_status='dead_letter'")
[ "$DL" -gt 20 ] && echo "::WARN:: dead_letter=$DL"

# 3. outbox pending 堆积没
PEND=$(sqlite3 "$DB" "SELECT COUNT(*) FROM email_outbox WHERE status='pending' AND created_at < strftime('%s','now')-1800")
[ "$PEND" -gt 0 ] && echo "::WARN:: outbox pending>30min=$PEND"

# 4. stats 是否 stale（mail-sync 停了？）
mailagent -o json admin stats --section v4_rollout | jq -e '
  .data.v4_rollout as $r | ($r._snapshot_at | fromdateiso8601) as $t
  | (now - $t) <= $r._warn_if_stale_sec' >/dev/null \
  || echo "::WARN:: stats snapshot stale — mail-sync may be down"

echo "::OK:: health pass"
```

---

## 深入了解

- [`docs/reference/cli/cli-reference.md`](https://github.com/)（admin 命令明细 + 典型 agent 调用样例）
- [`docs/reference/ops/backend-service-e2e-runbook.md`](https://github.com/)（写操作三传输端真机验收 + 迁移监控 SQL）
- [`docs/reference/architecture/roadmap-post-cutover.md`](https://github.com/) §5.1（EWS 关停双轨方案 + 监控告警）
- 同站：[退出码契约](/agent/exit-codes/) · [长任务契约](/agent/long-tasks/) · [SSE 事件流](/agent/sse/)
