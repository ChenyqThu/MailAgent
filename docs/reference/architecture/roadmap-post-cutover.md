# Roadmap — Post DavMail Cutover (2026-05-22 起)

> **Status**: 主路径 = davmail mode, AppleScript 作 emergency fallback. 这份 roadmap 汇总 cutover 后短中长期工作.
> **Companion**: [`sprint16-cutover-complete.md`](../../archive/2026-05/sprint16-cutover-complete.md) 全程纪要 / [`next-session-handoff.md`](../../archive/2026-05/next-session-handoff.md) cold-pickup / [`dual-backend-architecture-handoff.md`](../../archive/2026-05/dual-backend-architecture-handoff.md) 设计 + 决策
> **Last updated**: 2026-05-22 PDT

---

## 0. TL;DR (60 秒掌握当前坐标)

```
当前 backend           : davmail (PoC mode, 本机 IT 未审批)
mail-sync uptime       : 稳定运行 (cutover 后稳定性危机 8h 内修完, 见 §3.4)
DB_VERSION             : 14 (Sprint 16 收尾完整 SSoT 反转)
ps 镜像率              : 100% (6257 全量 backfill + handler 5+2 处 wire 完整)
ai_priority 镜像率    : ~99% (4 NULL = LLM 流转中)
frontend flag 延迟    : ~5ms (IPC 直写 SQLite, 之前 ~500-1000ms CLI fork)
AppleScript 路径       : 保留, .env 切回即激活 (emergency fallback)
关键死线              : EWS 2026-10-01 起默认阻断; 上游 DavMail 6.8.x 已带 Graph backend,
                        授权路线已验证可行(不需 IT 审批), 但成熟度不足 → 2026-08-26 复查后仍等待,
                        两周后(2026-09 上旬)再看; 复查判据 = refresh resource bug 修没修 (§5.1)
最高优先级            : 观察 1-2 周稳定性 → DavMail OAuth 监控 → EWS 关停应对启动
```

---

## 1. 当前坐标 (cutover 后第一手数据)

### 1.1 服务

```
pm2 ls
├── davmail-poc       online   15h+ uptime   IMAP 1143 / SMTP 1025 / CalDAV 1080
└── mail-sync         online   30min+        davmail mode, uid-mapper 后台跑

LaunchAgent           pm2.chenyuanquan.plist (RunAtLoad=true, 重启自恢复)
```

### 1.2 数据 (snapshot)

```
total emails           : 8903
backend_origin         : applescript=8899  +  davmail=4
sync_status            : synced 6543 + skipped 2360 + ... (其余 cutover 前)
imap_uid backfill     : 4593 backfilled / 4284 pending (uid-mapper running)
date_received 格式    : 100% iso_with_tz (DST 自动 PDT/-07:00)
```

### 1.3 文档生态

| 主题 | 文档 |
|---|---|
| Sprint 16 全程纪要 | [`sprint16-cutover-complete.md`](../../archive/2026-05/sprint16-cutover-complete.md) |
| Cold-pickup handoff | [`next-session-handoff.md`](../../archive/2026-05/next-session-handoff.md) |
| Dual-backend 设计 + 决策 | [`dual-backend-architecture-handoff.md`](../../archive/2026-05/dual-backend-architecture-handoff.md) |
| Phase A/B/C 实施 | [`dual-backend-phase-abc-handoff.md`](../../archive/2026-05/dual-backend-phase-abc-handoff.md) |
| 本 roadmap | (本文档) |
| v3 主架构 + Sprint 15 outbox | [`CLAUDE.md`](../../../CLAUDE.md) |
| v4 SQLite SSoT 进展 | [`architecture_v4_sqlite_ssot.md`](./architecture_v4_sqlite_ssot.md), `phase{1,2,3,4}-complete.md` |
| DavMail PoC 验证 | `davmail-poc/POC-RESULTS.md` (gitignored) + memory `project-davmail-poc-2026-05.md` |

---

## 2. P0 — 观察期 (1-2 天, 本周内)

### 2.1 稳定性观察

| 项 | 期望 | 验证命令 |
|---|---|---|
| mail-sync restart 次数 | ≤ 1 / 天 | `pm2 describe mail-sync \| grep restart` |
| davmail-poc 内存稳定 | < 250MB (JVM cutover 后短暂涨到 227MB, 应回落 ~110MB) | `pm2 describe davmail-poc \| grep memory` |
| 新邮件抓回 | ≤ 2min latency (30s 轮询 + 5s LLM + ~30s Notion API) | 自己发一封, 看 Notion 出现时间 |
| 反向 flag 同步 | ≤ 30s outbox + fanout 派发 IMAP STORE 生效 | `mailagent notion update-flag <id> --is-read=true` 后看 Outlook |
| 草稿创建 | ≤ 30s Outlook Drafts 出新草稿, 富文本完整, In-Reply-To 线程折叠 | 前端 AI Chat → Craft 按钮 |

### 2.2 端到端 happy-path 测试 (一次跑通)

自己发一封测试邮件, 全链路走一遍:

```
收到邮件 → davmail UIDNEXT increment 触发 radar
        → SQLite save_email(backend_origin='davmail', internal_id≥10^9)
        → reader.parse_email_source + EmailRepository.commit (含 markdown)
        → NotionSync.create_email_page_from_sqlite
        → LLMRunner (backend.arm IMAP fetch) → AILabels → Notion 写 12 字段
        → Notion automation → webhook → handle_ai_reviewed
        → outbox(target=mailapp) → FanoutWorker → IMAP STORE +\Flagged +\Seen
        → 飞书 App Bot 卡片
```

期望: 全程 ≤ 3min, 任一环节出错 → pm2 logs 看 trace.

### 2.3 cutover-only bug watch

[`sprint16-cutover-complete.md`](../../archive/2026-05/sprint16-cutover-complete.md) §2.3 列了 5 个 cutover 时现场发现的 bug (A-E). 5 个都已 patch, 但**观察期重点关注**:
- `date_received` 在 DST 边界 (11/01 PDT→PST 自动切换) 是否正确
- LLM runner 接 backend 的代码路径在长时间运行下是否泄漏 IMAP connection
- IMAP UID 跨 UIDVALIDITY 变更是否触发 (Microsoft 端 mailbox 重建会 +1 UIDVALIDITY, 极少见)

---

## 3. P1 — 收尾 (1 周内)

### 3.1 uid-mapper backfill 跑完

期望状态: `sync_state['davmail_backfill_progress']` = `completed:processed=8877 backfilled=N missing=M failed=K`. 完成后:
- 反向 flag / fetch 走 `imap_uid` 直接路径 (~200ms vs ~1s message_id 反查)
- `email_metadata.imap_uid IS NULL` 的 row 数应 < 100 (mail.app 时代 message_id 空的历史 row)

监控:
```bash
sqlite3 data/sync_store.db "SELECT value FROM sync_state WHERE key='davmail_backfill_progress'"
# running:processed=N backfilled=B missing=M failed=K
# 目标: status → completed
```

### 3.2 文档 cutover 同步 (本 commit 范围)

- [x] `docs/roadmap-post-cutover.md` (本文档)
- [x] `CLAUDE.md` 加 Sprint 16 dual-backend 章节 (类似已有的 Sprint 15 outbox 段)
- [x] `README.md` 加 dual-backend 章节 — 数据源不再只有 Mail.app
- [x] `.env.example` 加 davmail 9 字段 (MAILAGENT_BACKEND / DAVMAIL_*)

### 3.3 还没做的收尾 (待 next session 推进)

- [ ] `mailagent admin health` 加 backend probe 段: davmail-poc 进程存活 + IMAP login + UIDNEXT 可读
- [ ] webhook-server dashboard 加 `backend_origin` 维度统计 (davmail vs applescript)
- [ ] `mailagent admin backend-stats` 新 CLI: 每天每 backend 邮件量 + 失败率 + 平均 latency

### 3.4 cutover 后 8h 稳定性危机 + SSoT 反转完整化 ✅ 本 session ship

**stability crisis 5 个真 bug + Sprint 15 D 块 SSoT wiring gap 一次性修完**:

| commit | 内容 |
|---|---|
| `c1a6e25` | `handle_ai_reviewed` + `handle_completed` 补 `processing_status` 镜像 (5 处) |
| `33e057d` | codex 审 P0/P1 — `reverse_sync:230/340` 补 `processing_status` + `handle_completed` early return 收紧 |
| `d0a8086` | v14 schema: AI 字段提升主表列 `ai_priority/ai_action` + 2 索引 + `LLMProcessingStore.upsert_external_labels` + 961 行 backfill |
| `f3ba543` | frontend IPC 直写 SQLite — flag/read/processing_status `~500ms → ~5ms` (Sprint 15 D 块最后一步) |

**cutover-day 紧急 bug (8h 内修完)**:
- mail-sync crash-loop 221 次 = probe `SELECT INBOX` 触发 EWS searchMessages → Microsoft throttling 死锁 (改成 `NOOP` probe 8.5s→150ms, 58× 减负)
- crash-loop 接着 218 次 = `except` 块 `import asyncio` 触发 `UnboundLocalError` (P0 bug, 我自己埋的雷拆除)
- 1000000002 body 空 = Outlook 端 UID 重排 (147766→147767), 原代码 stale UID 无 fallback → 加 `message_id` 反查 + sync_store 回写新 UID
- uid-mapper 后台并发打爆 davmail = batch 50 无 sleep → 限流 (batch 50→20 + sleep 3s + `DAVMAIL_UID_BACKFILL_ENABLED` 可关 + `DAVMAIL_FETCH_TIMEOUT_SEC` 60s→120s)
- 错误信息硬编码 "AppleScript fetch failed" 在 davmail 模式下完全误导 → 改 `backend={name}` 真实标识

**数据回填 (无 commit, 纯运维)**:
- 4 封 davmail 邮件 ps 即时补 (cutover 当下 4 封 davmail-origin)
- 166 封最近 3 天 ps backfill (cutover 期前后流转半途)
- **6257 封全量历史邮件 ps 3 轮 backfill** (cutover 前从 v3 时代直到 Sprint 15 D 的累积 — SQLite 列从 v13 起一直 NULL, 因为 Sprint 15 D 漏 wire)
- 961 封 ai_priority/ai_action 主表列 backfill

**修复后 SQLite SSoT 状态**:
```
total emails          : 8908
ps 镜像率             : 100% (除 skipped/deleted 2361 封, 这些正确为空)
ai_priority 镜像率   : ~99% (4 NULL = LLM 流转中)
真 drift             : 0
未来新 drift 风险    : 0 (handler 5 处 + reverse_sync 2 处 + handle_completed early return 全 wire)
frontend flag 延迟  : ~5ms (IPC 直写 SQLite, 之前 ~500-1000ms CLI fork)
```

**新加的告警 hook**:
- `_check_alerts` 加 第 6 项 davmail mode 最近 10min `fetch_failed≥3` → 飞书 critical 告警
- `main.py` `BackendStartupError` 启动失败时一次性飞书告警 (probe 失败立即告)

---

## 4. P2 — 巩固 (1 月内)

### 4.1 AppleScript 路径下架评估

观察期满 (~1 周稳定) 后, 评估是否完全下架 AppleScript 路径:

候选删除范围:
- `src/mail/applescript_arm.py` (~600 行)
- `src/mail/applescript.py` (底层封装)
- `src/mail/sqlite_radar.py` (Mail.app SQLite radar)
- `src/mail/backend/applescript_backend.py` (wrapper)
- `scripts/create_reply_draft.sh` + `html_clipboard.py` (旧 NSPasteboard 注入)

**判断标准**:
- davmail mode 3 个月零事故 → 可删
- 否则保留作 emergency fallback (代码体量可接受, 维护成本低)

**短期不删的理由**:
- EWS 2026-10 关停未解决, 上游 Graph backend 已发版但成熟度不足 (§5.1) → AppleScript 仍是 last-resort 兜底
- 跨 backend marker 不兼容 (见 [`next-session-handoff.md`](../../archive/2026-05/next-session-handoff.md) §3.1), 删了反而不好回切

### 4.2 监控告警建设

| 告警项 | 阈值 | 现状 |
|---|---|---|
| `davmail-poc` 进程挂掉 | PM2 down event 立即 alert | ❌ 现在没 watchdog |
| `mail-sync restart_count > 5/day` | 滚动 24h 窗口 | ❌ |
| `imap_uid IS NULL` 邮件数突增 | > 1000 (uid-mapper stalled) | ❌ |
| DavMail OAuth refresh 失败 | 单次 ERROR | ❌ (davmail-poc logs 内, 没接 stats_reporter) |
| `email_outbox` pending > 100 持续 5min | fanout worker 卡 | ❌ |

实现路径: 接 `src/notify/alert.py` (已有飞书告警机器人) + 接 `STATS_REPORT_URL` (已有看板上报). 写在 `src/stats_reporter.py` 加新 metric.

### 4.3 cross-backend marker 分独立 key (设计层面遗留)

当前: `sync_state['last_max_row_id']` 在 applescript 模式 = Mail.app ROWID (~54200), 在 davmail 模式 = IMAP UIDNEXT (~147000). cutover 时需要 manual reset (这次 cutover 已做).

**短期决定不做** — 用户明示 "仅考虑一次切换". 但如果未来需要支持来回切, 应该:
- `sync_state['applescript_last_rowid']` / `sync_state['davmail_last_uidnext']` 分独立 key
- 启动时 backend 拿对应 key, 不冲突
- migration 一次性 split 现有 marker

工作量: ~2h. 优先级低, 仅在确定需要双向切换时再做.

### 4.4 DST 边界回归测试

`_normalize_date_received_iso` + `_local_tz()` 用 `/etc/localtime` 解析 IANA zone, 应自动处理 11/01 PDT→PST 切换. 但实测一次:
- 11/01 PST 生效后, 跑 `scripts/dev/fix_date_received_tz.py --dry-run`, 确认没有需要二次 backfill 的 row
- 否则一次性 backfill 跨 DST 边界邮件

### 4.5 DavMail 后端切换跟进 (cutover 后 1 个月内必做)

cutover 当天暴露的稳定性问题已 §3.4 修完, 但 davmail 模式作为新主路径还有几个跟进项, 优先级 P1 (影响生产可用性):

#### 4.5.1 DavMail OAuth refresh token 监控告警 (高优)

**风险**: refresh_token 90 天有效, 期间每次成功续期会被 Microsoft rotate; 但如果 davmail-poc 长时间 idle 或 OAuth 续期失败连续 N 次, refresh_token 可能过期 → 必须重走 OAuth manual flow.

**实施**:
- `src/notify/alert.py` 加 `alert_davmail_token_expiring(days_left)` — token.dat mtime > 80 天接近过期时 warning
- `src/notify/alert.py` 加 `alert_davmail_oauth_failure(error)` — davmail-poc logs 出 BadPaddingException / refresh_token expired 时 critical
- watchdog: `mailagent admin health` 加 `davmail.token.mtime` + `davmail.token.age_days` 指标

#### 4.5.2 davmail-poc 进程死亡 watchdog (高优)

**风险**: mail-sync probe 失败时已有告警, 但 davmail-poc 自己挂掉而 mail-sync 不在 poll 期 (cycle 5s 间隙) 不会立即触发. PM2 down event 无 alert hook.

**实施**:
- `main.py` 主循环加每 60s `probe_tcp(127.0.0.1, 1143)` 探测, 失败 ≥3 次 → 飞书 critical
- 或 PM2 ecosystem 加 `post_stop_script` 直接 curl 飞书 webhook (更轻量)

#### 4.5.3 EWS throttling burst 监控 (中优)

cutover 时发现的死锁场景: davmail logs 出 `EWSThrottlingException: The server cannot service this request right now`, 跟我们的 `davmail_fetch_burst` 告警 (最近 10min `fetch_failed≥3`) 间接相关, 但**没直接抓 EWS throttling stack trace**.

**实施**:
- mail-sync 起一个 sidecar 进程 / log tail 监控 `davmail-poc` PM2 stderr
- 匹配 `EWSThrottlingException` → 累计 5min 内 ≥3 次 → 飞书 warning + 自动暂停 uid-mapper backfill (写 `sync_state['davmail_uid_backfill_paused']=true`)
- throttling 自然解除 (10-30min) 后恢复

> **✅ 已完整落地（2026-07-17，PR #43 + follow-up）**：flag 接上两个消费者——uid-mapper
> backfill 批循环挂起（60s 重查）+ watcher `_poll_cycle` 整轮跳过。语义单源
> `src/mail/throttle_pause.py::is_uid_backfill_paused()`：`PAUSE_AT_KEY` 是 **watchdog
> 存活心跳**（in_burst 每轮 tick 刷新），watchdog 活着 pause 无时限；心跳停更 30min
> 后消费侧自愈放行（防 watchdog 死掉 → 整同步永久停摆）。watchdog `__init__` 从持久
> flag 回种内存态（跨进程重启自愈复位）。pause 置位/复位在 `_update_throttle_pause()`
> 由 `_tick` 直调，**不依赖 ALERT_ENABLED**（原挂 `_evaluate_alerts` 内、告警关闭时
> 整个退避形同虚设，已修）。applescript 模式 flag 恒非 'true'，行为不变。

#### 4.5.4 uid-mapper 跑完后效果验证 + 落地报告 (低优, 可观测)

cutover 后 uid-mapper 限流模式 (batch 20 + sleep 3s) 预计 ~22min 跑完剩余 ~2664 封. 跑完后应该:
- `imap_uid > 0` 邮件数从 5473 → ~8800+ (99% 覆盖)
- 反向 flag / fetch 路径全部走 imap_uid 快路径 (~200ms vs message_id 反查 ~1s)
- 跑 `scripts/dev/audit_davmail_vs_sqlite.py --hours 168` 跑一周对账, 期望 MISS ≤ 5

#### 4.5.5 cross-backend marker 分独立 key (低优, 仅在需要双向切时做)

`sync_state['last_max_row_id']` 当前用作 applescript Mail.app ROWID 跟 davmail UIDNEXT 共用 key, cutover 时手动 reset 跳过历史. 如果未来要支持来回切, 应该 split 成:
- `sync_state['applescript_last_rowid']`
- `sync_state['davmail_last_uidnext']`

工作量 ~2h. 跟 §4.3 重复, 这里 inline 是为了 DavMail 跟进章节完整.

#### 4.5.6 handle_create_draft '草稿已创建' 没镜像 SQLite (codex P2)

codex 审报告 [`docs/roadmap-post-cutover.md`](#) §3 提到的剩余 SSoT gap: `handle_create_draft` 在 [`src/events/handlers.py:618`](../../../src/events/handlers.py) / [`:758`](../../../src/events/handlers.py) 直接调 `update_page_mail_sync_status(..., processing_status='草稿已创建')` 写 Notion, 但没回写 SQLite `email_metadata.processing_status`. 跟 §3.4 一致的 SSoT 反转思路, 补一行 `update_local_flags(..., processing_status='草稿已创建')`.

**实施**: ~10min, 同 §3.4 同源.

#### 4.5.7 `mailagent admin backfill-processing-status` CLI (低优, 运维工具化)

本 session 跑了 3 轮 inline Python script backfill 6257 封, 每次都得现写. 加 CLI 命令把这固化下来:

```
mailagent admin backfill-processing-status [--since-date=YYYY-MM-DD] [--mailbox=收件箱] [--concurrency=3] [--dry-run]
```

未来加新 schema 列 (例 `is_starred`, `notion_archived`) 需要 backfill 时复用. ~1h.

---

## 5. P3 — 长期 (3-6 月)

### 5.1 EWS 2026-10 关停应对 (最重要)

> **2026-07-31 调研更新**: 上游 Graph backend 已发版, Path A 成立且**不需要 IT 审批** —— 决策从
> "二选一" 收敛为 "跟随上游, 等成熟"。owner 当日拍板: **暂不迁移 PoC**, 成熟度不够, 继续观察。
> 以下为该次调研的实证结论, 取代此前 "#404 未 merge / 需 IT 审批" 的判断。
>
> **2026-08-26 复查更新**: 仍无 6.9, 最新正式版仍是 6.8.1。但 trunk 已累积 115 个 commit,
> 三条观察触发条件中**两条在 trunk 满足、一条完全没动**(那一行 refresh resource bug)。
> owner 当日拍板: **继续等待, 两周后(2026-09 上旬)再看**。复查判据见本节末尾。

**微软侧时间线**:
- 2026-07-01: frontline/kiosk SKU 邮箱先行阻断
- **2026-10-01: EWS 开始默认阻断**
- 2027-04-01: 完全退役

**上游状态 (2026-07-31 核查)**:

| 版本 | 内容 |
|---|---|
| 6.8.0 (2026-06-12) | **首个把 Graph 做成正式可选 backend 的版本**。配置重构: `mode`(协议) 与 `authentication`(认证) 拆成两个键, 新增 `O365EWS` / `O365Graph` / `ExchangeEWS` |
| 6.8.1 (2026-06-30) | 当前最新正式版。带回 `davmail.folderFetchPageSize`(默认 500) 修 Graph 大文件夹分页 |
| trunk (2026-07 全月) | delta sync (`davmail.graph.deltaSync=true`) / folder 全量缓存 / 限流重试 / recurrence 修正 —— **尚未发版** |
| trunk (2026-08-26 核查, HEAD `003d76c`) | 自 6.8.1 起 **115 commit**。关键: 8-14 `Graph: add missing datereceived mapping` 修 #506; 8-16 **delta sync 默认开启**; 8-14 `O365: fix scope check in O365Token` 新增 token 兼容性检查(见下 a 项, 放大了 refresh bug 的后果) —— **仍未发版** |

**三条观察触发条件的状态 (2026-08-26 核查)**:

| 触发条件 | 状态 | 依据 |
|---|---|---|
| delta sync 进正式版 | ⚠️ 进 trunk, **未发版** | 7-11 实现, 8-16 默认开启; [#500](https://github.com/mguessan/davmail/issues/500) 作者 8-22 实测 20k 文件夹正常 |
| [#506](https://github.com/mguessan/davmail/issues/506) APPEND 修复 | ✅ trunk 已修, **未发版** | 8-14 mguessan 回帖 "fixed in trunk", issue 仍 open |
| refresh resource bug 修复 | ❌ **完全没动** | `O365Token.java:255` 仍写死 `getOutlookUrl()` |

⇒ **可以做 PoC, 不能切生产**。且 PoC 必须自建 trunk + 一行 patch —— 等 6.9 是被动等待,
而这一行不修, 任何 Graph 实例都活不过 1 小时。

[Issue #404](https://github.com/mguessan/davmail/issues/404) 仍 open, 但作者 2026-05-02 明确表态
"应该能赶上十月的 deadline"。**本项目 = 跟随上游, 零自研工程** (见 memory `feedback_mailagent_ews_davmail_scope`)。

#### 授权路线: Outlook clientId 伪装在 Graph 下仍然可用 (关键结论)

上游**显式为这条路留了门**, 见 `O365Authenticator.java` 的 `buildAuthorizeUrl`:

```java
if (Settings.isGraphEnabled()) {
    if (Settings.getBooleanProperty("davmail.enableOidc", true)) {
        // OIDC compliant, use this with default DavMail clientId, requires admin consent
        → v2.0 endpoint + scope
    } else {
        // Outlook desktop can work with classic resource based endpoint for authorization
        → v1 /oauth2/authorize + resource=https://graph.microsoft.com
    }
}
```

- 🔴 `requires admin consent` 挂在 **DavMail 自有 clientId** 分支上, **不是** Outlook clientId 这条。
- 该分支注释列出了 Outlook desktop clientId 在 graph endpoint 上**已预授权的 scope 清单**, 逐条覆盖
  DavMail 所需: `Mail.ReadWrite` / `Mail.Send` / `Calendars.ReadWrite` / `Contacts.ReadWrite` /
  `Tasks.ReadWrite` / `People.Read`。
- 我们现有的 **O365Manual + `urn:ietf:wg:oauth:2.0:oob` 手动粘贴流程可原样保留** —— Graph +
  `enableOidc=false` 走的仍是 v1 authorize endpoint, 与 urn:oob 配套。

⚠️ 反面教训: `Settings.getOauthScope()` 里有一段 "redirectUri 以 `urn:` 开头 → scope 退化为
`openid profile offline_access`" 的逻辑, 初看像是把这条路堵死了。**该分支在 `enableOidc=false`
路径下根本不会被调用**(走的是 `resource` 参数而非 `scope` 参数) —— 只读半段代码会得出相反的错误结论。

**切换所需配置** (davmail.properties, 非 .env):

```properties
davmail.mode=O365Graph
davmail.enableOidc=false        # 关键, 默认 true(= DavMail clientId + admin consent 那条路)
davmail.authentication=O365Manual
# clientId / redirectUri 不动
```

#### 阻塞项 (为什么 2026-07-31 决定不迁移)

**a) 上游一行 bug —— refresh 后静默失效**。`O365Token.java::refreshToken()`:

```java
if (!Settings.getBooleanProperty("davmail.enableOidc", true)) {
    parameters.add(new BasicNameValuePair("resource", Settings.getOutlookUrl()));  // ← 写死 outlookUrl
}
```

authorize 阶段要的是 `getGraphUrl()`, refresh 阶段却要 `getOutlookUrl()`。v1 的 refresh token 是
multi-resource 的, 要哪个给哪个 → 首个 access token 过期(约 1h)后换回 EWS 资源 token → 之后所有
Graph 调用 401。**进程不退出, 表现为"跑了一阵突然全线 401"**。该 bug 由 commit
`O365: set resource parameter on token request only if OIDC is explicitly set to false`(2026-06-15)
引入, 说明**这条路作者自己没跑过**。处置: 报上游 issue, 或自行 patch + Ant build。

> **2026-08-26 更新 —— 后果比 7 月判断更严重**。上游 8-14 给 `setJsonToken` 加了 token 兼容性检查
> (`O365Token.java:190-195`):
> ```java
> if (Settings.isGraphEnabled()) {
>     if (scope != null && (!scope.contains("Mail.ReadWrite") || scope.contains(Settings.getOutlookUrl()))) {
>         Settings.storeRefreshToken(username, "");        // ← 清空存储的 refresh token
>         throw new IOException("Found EWS stored token, incompatible with Graph API");
>     }
> }
> ```
> refresh 换回 EWS 资源 token 后, 若响应 `scope` 含 outlook url 即命中该分支 ⇒ 1h 后不再只是
> "静默 401", 而可能是**refresh token 被清空、必须重新人工 OAuth**。走哪条取决于 v1 token 响应里
> `scope` 字段的实际形态(短名列表 vs 完整 URI), **这是 PoC 的头号必测项**。
> 🔴 直接推论: PoC **必须用独立 token 目录** —— 指向生产 `token.dat` 时一次失败就清掉生产凭证。
>
> **patch (一行, 可同时提给上游)**:
> ```java
> // src/java/davmail/exchange/auth/O365Token.java:254
> if (!Settings.getBooleanProperty("davmail.enableOidc", Settings.isGraphEnabled())) {
>     parameters.add(new BasicNameValuePair("resource",
>             Settings.isGraphEnabled() ? Settings.getGraphUrl() : Settings.getOutlookUrl()));
> }
> ```
> 默认值一并从 `true` 改为 `Settings.isGraphEnabled()`, 与同文件 `buildTokenUrl:105` 对齐(两处不一致
> 本身就是隐患)。`getGraphUrl()` 返回 `https://graph.microsoft.com`(不含 `/beta`, 版本前缀由
> `GraphRequestBuilder` 另拼), 正好可直接作 v1 resource。
>
> ⚠️ 评估过一个零构建替代: 设 `davmail.outlookUrl=https://graph.microsoft.com` 让 refresh 的 resource
> 自然变成 graph。能 work, 但会连带污染 `getO365Url()`(变成 `https://graph.microsoft.com/EWS/Exchange.asmx`),
> 影响 `O365ManualAuthenticator:49` 的 `ewsUrl`, 同时把上面那段 scope 检查的判据一起改掉 ——
> 用一个键表达两处相反语义, **仅在构建链完全卡住时作为应急**。

**b) Graph backend 成熟度 —— 按本项目实际用到的能力分项**:

| 能力 | Graph 下状态 |
|---|---|
| 读邮件 / 增量同步 | 能用。但报告者实测 20k 邮箱比 EWS **慢 2.5 倍**(1m40s vs 40s); 可能撞 [#501](https://github.com/mguessan/davmail/issues/501) `ErrorRestrictionTooComplex`(加载直接失败, 未修) |
| SMTP 发信 | 未见 issue, 大概率 OK |
| **草稿保存 / 移动归档** | 🔴 [#506](https://github.com/mguessan/davmail/issues/506) **明确坏** —— Graph 模式 IMAP APPEND 返 400 `UnableToDeserializePostBody`。本项目保存草稿走的正是 APPEND(`davmail_backend.py:964`, `imap_folder_reader.py:548`) |
| 日历 CalDAV | 成熟度最低。作者原话: Graph 下"不再有服务端 caldav parser"; 2026-07 整月仍在修 recurrence / 时区 / 全天事件 |
| 大邮箱 SELECT | [#500](https://github.com/mguessan/davmail/issues/500)。6.8.1 的 `folderFetchPageSize=500` 已缓解, 真正的解法(delta sync)在 trunk 未发版 |

另: Graph backend 默认打 `graph.microsoft.com/**beta**` 端点 (`davmail.graphPrefix=beta`), 非 v1.0。

#### 迁移时的已知成本 (调研已验, 迁移时不必重查)

- **必须重新走一次 OAuth**, 且是**双向**的。`O365Token.java` 显式挡死跨模式复用:
  ```java
  if (Settings.isGraphEnabled()) {   // 存的是 EWS token
      Settings.storeRefreshToken(username, "");
      throw new IOException("Found EWS stored token, incompatible with Graph API");
  } else { ... "Found Graph stored token, incompatible with EWS" }
  ```
  🔴 **回切 EWS 同样要重认证** → AppleScript/EWS "随时可无人值守回切"的纪律在 Graph 后不再成立, 回滚含人工步骤。
  ⚠️ 判据是 `if (scope != null && ...)`; 我们走 v1 resource-based 流程, token 响应的 scope 字段是否有值未实测 ——
  若为 null 则该保护**不触发**, 旧 token 被直接拿去打 Graph → 静默 401 而非清晰报错。实测时必须盯这条。
- **本地数据不作废, 不需要全量重新同步** ✅ (决定了迁移是"改配置重启"而非"重灌一万封"):
  - Graph 侧 `imapUid` 映射到 MAPI **`0x0e23`**(`GraphField.java:69`), 与 EWS 路径用的
    `PropertyTag="0xe23"` 是**同一个属性** → IMAP UID 跨后端稳定。
  - UIDVALIDITY 在 `ImapConnection.java` 中**硬编码为 1**, 与后端无关 → 切换后不变。
  - ⇒ `email_metadata.imap_uid` / `imap_uidvalidity` 不失效。
- `davmail.folderSizeLimit` 在 Graph 模式下**仍生效**(见 #500 讨论), `src/mail/davmail_properties.py`
  那套单键同步无需改动。
- **配置必须改写, 不是"换版本就到 Graph"** (2026-08-26 查明的 legacy fallback 边界):
  - 现有 PoC 配置是 6.7 旧格式 `davmail.mode=O365Manual`(那时 mode 兼管协议与认证)。6.8 起
    `mode`(协议) 与 `authentication`(认证) 拆键。
  - 旧配置**向后兼容**: `ExchangeSessionFactory:160-168` 先读 `davmail.authentication`, 取不到才
    `getAuthenticatorClass(mode)` "fallback to legacy modes"。而 `setDefaultSettings()` 里
    `davmail.authentication=O365Interactive` 这个默认值**只在配置文件不存在时写**(`Settings.load():161-170`
    —— 文件存在则只 load, 不设默认) ⇒ 我们的文件没写该键 = 取到 null = 走 legacy fallback ✅
  - ⇒ **单纯升级 jar 是安全的**(`isGraphEnabled()` 判 `mode=O365Graph`, 旧值仍走 EWS, 行为不变),
    但也意味着**不改配置就不会切到 Graph**。
  - 🔴 一旦把 mode 改成 `O365Graph`, legacy fallback 就不再兜底 ⇒ **必须显式补写
    `davmail.authentication=O365Manual`**, 否则 authenticatorClass 为 null, 落到不带 authenticator 的
    老式认证分支。

#### 当前决策与下一步

**2026-08-26 owner 拍板: 继续等待, 两周后(2026-09 上旬)复查。** 距 10-01 默认阻断仍有约 5 周余量。
(前次 2026-07-31 拍板不迁移, 理由 = 上表 b) 的成熟度, 与授权无关 —— 该判断依然成立。)

- 🔴 **复查判据不是"有没有 6.9", 而是"那一行修没修"**: 若 6.9 发版但 `O365Token.java` 的 refresh
  resource 仍写死 `getOutlookUrl()`, 方案不变(仍需自建 + patch), 换版本解决不了。
  一条命令即可判定:
  ```bash
  curl -sL https://raw.githubusercontent.com/mguessan/davmail/master/src/java/davmail/exchange/auth/O365Token.java \
    | sed -n '245,260p'
  ```
- **次要复查项**: 6.9 是否发版(delta sync + #506 修复随之进正式版) / [#501](https://github.com/mguessan/davmail/issues/501)
  `ErrorRestrictionTooComplex` 是否有结论(打中我们两处 `uid search HEADER Message-ID`)。
- **真正动手前的第一道闸(半天)**: 影子实例验授权 —— 独立端口(IMAP 1243 / SMTP 1125 / CalDAV 1082)
  + 独立 config + **独立 token 目录**, 不碰 pm2 上的生产实例; 只验两件事:
  ① `mode=O365Graph` + `enableOidc=false` 能否拿到 Graph token(**记下日志里 `Obtained token for scopes:`
  的确切形态**), ② 放置 65min 后 refresh 是否 401 / 是否清空 token.dat。这是唯一可能"结构性堵死"的一关。
- **过闸后的回归项**(全部打在我们实际用的 IMAP 命令上): 大文件夹 SELECT(delta sync) /
  草稿 APPEND(#506 回归) / `uid search HEADER Message-ID`(#501) / `uid copy` + `store \Deleted`(归档) /
  SMTP 发信 / CalDAV 日历读。
- **兜底**: 若 2026-09 上游仍不可用 → 才需要重新评估自研 Graph backend(`src/mail/backend/graph_backend.py`,
  复用 IMailBackend Protocol, 估 3-4 周), 该路径依赖公司 IT 的 Azure app 注册审批, **非当前计划**。

### 5.2 SQLite SSoT Inversion (Sprint 13 后单独 Sprint)

**memory 记录**: v4 SQLite SSoT 落地后, 所有 mutating 操作 (flag 三态、archive、createDraft 等) 应反转方向: 前端 → SQLite → 单向 fanout 到 Mail.app + Notion, 废弃 v3 时代 "Notion → webhook → Mail.app" 反向同步链路.

**当前状态 (cutover 后)**:
- Sprint 15 outbox 已经把 fanout 模式建好了, 但仅适用于反向 sync 的写入
- 前端 callsites (EmailRow.tsx:208/211/218/229) 仍调 `mailApi.notion.updateFlag`, 写 Notion 不写 SQLite
- `handle_flag_changed` / `handle_completed` / `handle_ai_reviewed` 仍是"Notion → handler → outbox → Mail.app" 流向 (Sprint 15 已加 SQLite intent 写入, 但语义仍是 Notion-driven)

**需要做的**:
1. 新增 `email.flag` / `email.updateLocalFlag` IPC, 直写 `email_metadata` + 排两条 fanout (Mail.app / Notion)
2. handler 退化成"Notion 意图通知 → 写 SQLite intent", 不再直接写 Mail.app
3. 前端 callsites 切到新 IPC
4. SyncStore 加 `email_flag_pending` 表 + idempotency 校验

**估工作量**: 1-2 周 (有 outbox 模型作底).
**触发条件**: davmail mode 稳定 + frontend Sprint 18 Settings 完成后启动.

### 5.3 Frontend Sprint 19 — AI Agent Harness ✅ M1 ship (待 dogfood)

> ⚠️ S3（2026-07-03）更新：本节描述的自研 TS harness 已被 AI SDK Gateway 完全取代并删除，当前引擎架构见 [`ai-sdk-gateway-architecture.md`](../llm-agent/ai-sdk-gateway-architecture.md)。以下为 Sprint 19 M1/M2 历史记录，仅存参考。

**状态**：✅ M1 已 ship 6 commits 到 `feat/agent-harness` 分支（2026-05-22/23，~6261 LOC，146 tests 全过）；⚠️ **尚未 dogfood**，默认 `MAILAGENT_AGENT_HARNESS=0` 关，满足 eval gate (≥70%) 后翻默认 flag 合 main

**M1 已 ship**（PR-1a → PR-1d.2）：
- chat_db v3 schema：`chat_tool_call` audit + `wiki_pages` / `wiki_fts` / `agent_memory_kv` (M2 才填)
- ToolRegistry + 10 builtin tool（7 read silent / 3 write preview/edit）
- Anthropic tool_use SSE 解析 + cache_control 双 breakpoint
- harness 外循环 (MAX_ITER=8 / MAX_COST_USD=0.5 / abort / cost cap)
- ConfirmToolDialog renderer 接通 (preview/edit dialog + IPC chat:confirmTool)

**测试覆盖**：
- 9 test files / 146 tests pass (chat_db v3 migration + dispatcher legacy 不破坏 + Anthropic SSE state machine + dispatch confirm flow + harness 端到端 + ConfirmToolDialog UI + builtin tool catalog)
- typecheck:node + typecheck:web exit 0
- 不破坏 Sprint 4-18 任何 chat 现有测试 (legacy single-turn path 保留)

**Dogfood TODO（历史记录，已跑完 —— harness 现已删除）**：
- `MAILAGENT_AGENT_HARNESS=1 pnpm electron:dev` + 切 Custom AI 后端
- 跑 [`email_scenarios.md`](../../archive/2026-05/eval/email_scenarios.md) 20 scenario
- 记 pass rate → `docs/archive/2026-05/eval/p1-baseline.md`
- 期望 ≥ 70% (≥ 14/20) 才翻默认 flag

**M2 起点 — 决策反转 (2026-05-23)**：原"自研 SQLite wiki"撤销，**改为接入用户已有的 Jarvis KOS v2** (gbrain fork on mac mini @ `kos.chenge.ink` + `127.0.0.1:7225`)。MailAgent 作为 KOS 的第 4 个消费者（Notion Knowledge Agent / OpenClaw / Feishu signal detector 已在用）。完整设计：[`kos-integration-design.md`](../llm-agent/kos-integration-design.md)。

PR 拆分（7 PR，~3-4 周）：
- PR-2a FTS5 中文 smart wrapper — **本地 fallback**
- PR-2b 附件文本化 (pypdf/python-docx/python-pptx) + `email_attachment_fts` — **本地 fallback**
- PR-2c **KOS client** (TS + Py) + config + health check + retry + circuit breaker
- PR-2d **Producer**：mail-sync 邮件 sync 完异步 `/ingest`（path `mail/{internal_id}` + `scope:mail-agent` frontmatter）
- PR-2e **Consumer tools**：`kos_query` + `kos_digest` 加 `defaultToolRegistry`
- PR-2f **L1 hot block 注入**：chat 启动时按 sender 异步拉 `kos_digest(people/{slug})`
- PR-2g dogfood + eval (5 KOS 专属 scenario)

**保留**：chat_db v3 `wiki_pages` / `wiki_fts` / `agent_memory_kv` 表（PR-1a 已建）保留**不主动写**，M3 评估是否做"KOS 不可达时的离线缓存层"。

**为何转**：KOS 已有 entity extraction (24k people / 5k companies) / 知识图谱多跳 / 混合检索 (vector + BM25 + RRF + ZeroEntropy rerank) / Facts trajectory / 夜间 consolidate；用户其他 agent (Notion / OpenClaw / Feishu) 已在用同一个 KOS — MailAgent 自维护 wiki 等于建邮件孤岛，丢跨域 entity 合并的最大价值。

**关联文档**：
- 架构（已归档存史）：[`architecture_agent_harness.md`](../../archive/2026-06/architecture_agent_harness.md)
- 设计 ref（已归档存史）：[`agent-harness-design.md`](../../archive/2026-06/agent-harness-design.md)
- 当前引擎架构：[`ai-sdk-gateway-architecture.md`](../llm-agent/ai-sdk-gateway-architecture.md)
- Eval gate（已归档存史）：[`email_scenarios.md`](../../archive/2026-05/eval/email_scenarios.md)
- Dogfood handoff：[`../frontend/SPRINT19-M1-HANDOFF.md`](../../../frontend/archive/2026-05/SPRINT19-M1-HANDOFF.md)
- 决策记录：`~/.claude/plans/subagent-plan-lexical-moler.md`

---

### 5.4 Frontend Sprint 18 — Settings 页面重做

[`frontend/SPRINT18-SETTINGS-HANDOFF.md`](../../../frontend/archive/2026-05/SPRINT18-SETTINGS-HANDOFF.md) 已有 handoff. 当前 SettingsPage.tsx 1174 行存在但需要 audit / refactor. 跟 dual-backend cutover 后的关联:
- 加 backend 切换 UI (MAILAGENT_BACKEND 配置项)
- 加 davmail 健康状态展示 (probe 结果)
- 加 davmail 子配置面板 (host / ports / mailbox names)

**触发条件**: davmail mode 观察期满 + UID backfill 完成.

### 5.5 CalDAV 集成 (机会主义, 不阻塞)

`src/calendar_notion/caldav_reader.py` + `build_llm_caldav_context` 已经写好 (Phase C). 但没在 LLM processor 里 inject. 加 3 行代码:

```python
# src/llm_agent/processor.py 加 user_msg 拼接前
from src.calendar_notion.caldav_reader import build_llm_caldav_context
ctx = build_llm_caldav_context(self.cfg, horizon='today')
if ctx:
    user_msg = f"今日日程 (来自 Outlook 日历):\n{ctx}\n\n---\n{user_msg}"
```

**估工作量**: 1h (代码) + 半天 (prompt 调优 + A/B 测对比 LLM 输出质量).
**优先级**: 低, 仅当 LLM 误判被日程上下文能救回的真实 case ≥ 5 个再做.

---

### 5.6 前后端一体化打包 + Onboarding (Epic, **下一步落地**)

把「独立 Electron 前端 + Python 后端 + DavMail JVM + PM2」收敛为单个可分发 `.app`，新用户装完即用、老用户继承+幂等迁移、插件按需独立开关。完整方案三件套 (2026-05-29 产出, 经批判复审修订):

- [`docs/packaging/01-architecture-analysis.md`](../packaging/01-architecture-analysis.md) — 架构分析 + 打包三方案对比 (推荐**嵌入式 CPython venv via extraResources**) + 插件控制面 + §11 评审修订 (C-1~C-11)
- [`docs/packaging/02-landing-plan.md`](../packaging/02-landing-plan.md) — P0–P6 路线图 (~37–55 人天 MVP) + 文件级落点 + 风险册 + M1–M5 里程碑
- [`docs/packaging/03-onboarding-prd.md`](../packaging/03-onboarding-prd.md) — 四类用户检测矩阵 + 新/老/半装流程 + 插件子流程 + 状态机图

**核心约束**: ① 后端长驻服务须新增 `mailagent serve` 子命令 (`EmailNotionSyncApp` 迁入 `src/service.py`, P1-4a 前置), `BackendLifecycleManager` 取代 PM2; ② 全量 userData 化 (`DATA_ROOT=~/Library/Application Support/MailAgent`) + `config.py` 路径绝对化; ③ 首发默认 AppleScript backend (零依赖零合规, 不捆绑 JRE/DavMail); ④ 对外发布前必须申请 Apple Developer + 公证 (P6-1 升为与 P0 并行的零号任务)。**MVP = 内部 ad-hoc, 对外可用 = MVP + 公证。**
**落地方式**: 独立 `feat/packaging-onboarding` worktree, 每 Phase 子分支 PR, 里程碑合 main。

### 5.7 前后端技术栈统一 — Python → TypeScript 增量绞杀 (**远期, ROI 拐点决定终点**)

> **状态: roadmap 草案, 不进入当前 Sprint。** 仅在 §5.6 方式 2 稳定交付后才启动。详见 [`docs/packaging/04-tech-stack-unification.md`](../packaging/04-tech-stack-unification.md) (经批判复审修订 D-1~D-10)。

完整方案: 后端 57k 行 Python 按「叶子纯函数 → 读侧/HTTP → 写侧经 outbox 缝 → 皇冠明珠 sync_store/主循环」**四波增量绞杀**到 TS, 借三条已存在的语言中立缝 (SQLite 表 / `email_outbox` / CLI JSON) 让 TS 与剩余 Python 共存灰度。

**铁律 (必须记住)**: **只要还剩一个 Python 模块在跑, 就仍须打包整个 venv (~281MB)** —— 打包瘦身是「全有或全无」的阶跃终局, 增量迁移过程中的正当理由**只能是 DX / 降耦**, 不是体积。

**规划工作量**: 约 **180–260 人天 (≈ 9–13 人月)**, 跨多个 minor 版本 (v2.0→v3.x)。
**默认终点不是「全迁完摘 venv」, 而是「迁到 ROI 拐点为止」** —— 很可能停在 Wave 3 后 (读写侧 TS、皇冠明珠 + caldav/pptx/pdf 永久 Python) 的健康混合态。「摘 venv」是需 §6.2 七条判据全绿才解锁的**可选**终局。
**落地方式**: 每一波独立 worktree/分支、独立可发布、独立可回滚, 不与 §5.6 打包落地共线。

---

## 6. 已知隐患 trace (持续观察)

(详见 [`next-session-handoff.md`](../../archive/2026-05/next-session-handoff.md) §3)

| # | 隐患 | 等级 | 触发条件 | 应对 |
|---|---|---|---|---|
| H-1 | marker 跨 backend 不兼容 | 中 | 重新切回 applescript 时 | 手动 reset marker (P2 §4.3 永久解决) |
| H-2 | EWS 2026-10 关停 | 高 | 自动触发 | P3 §5.1 跟随上游 6.9+, 授权已验证可行, 等成熟度 |
| H-3 | mail.app 时代 message_id 空 row (~10 封) | 低 | uid-mapper missing | 接受现状, 不修 |
| H-4 | cross-backend merge guard 浪费 sequence | 极低 | cutover 时 | 无害 (10^9 起点几百万年用不完) |
| H-5 | davmail-poc JVM 内存涨 | 低 | 长时间运行 | P2 §4.2 监控告警, 内存 > 250MB 重启 |
| H-6 | DavMail OAuth refresh_token 过期 | 高 | 90 天 idle / 公司 IT 政策变 | §4.5.1 80 天告警 + watchdog (待做 P1) |
| H-7 | IT 政策变化 / 风控触发 | 中 | 不可预测 | AppleScript fallback 兜底 |
| H-8 | DavMail IMAP UID 越过 INT64 (极少) | 极低 | UID 超 2^63 | 不会发生 (Microsoft 通常 ≤ 10^7) |
| H-9 | EWS searchMessages throttling 死锁 | **中** | uid-mapper 后台并发 + mail-sync 反复 probe | cutover 当天踩中, §3.4 改 probe NOOP + uid-mapper 限流修. §4.5.3 加 burst 监控 |
| H-10 | frontend IPC 直写 vs mail-sync writer 并发 | 低 | 用户点 flag 跟 reverse_sync poll 同时改同行 | WAL 单 writer 锁 + busy_timeout=500ms 兜底. 极端 race 用户看到 retry latency ~10ms |

---

## 7. 进度看板 (持续更新)

```
[●●●●●●●●●●] dual-backend Phase A-C 实施 + cutover 执行 (Sprint 16)        ✅ 2026-05-22
[●●●●●●●●●●] cutover-day stability crisis 5 bug 修完 + 文档同步 (§3.4)     ✅ 2026-05-22
[●●●●●●●●●●] SQLite SSoT 反转完整化 (handler 5+2+1 处 wire + v14)          ✅ 2026-05-22
[●●●●●●●●●●] frontend IPC 直写 SQLite (flag ~5ms, Sprint 15 D 最后一步)    ✅ 2026-05-22
[●●●●●●●●●●] 全量历史邮件 ps backfill 3 轮 (6257 封, 真 drift=0)            ✅ 2026-05-22
[●●●●●●●●●○] uid-mapper backfill (限流后跑中, ETA ~22min)                 🟡 进行中
[●●●○○○○○○○] davmail mode 稳定性观察 (P0, 1-2 周)                          🟡 第一天
[○○○○○○○○○○] DavMail 后端切换跟进 (P2 §4.5, 7 项)                          ⚪ 待启动
[○○○○○○○○○○] 监控告警建设 (P2 §4.2 + §4.5.1-3)                            ⚪ 待启 (已加 2 个 hook)
[○○○○○○○○○○] AppleScript 下架评估 (P2 §4.1)                              ⚪ 等观察期满 3 月
[●●●○○○○○○○] EWS 2026-10 关停应对 (P3 §5.1)                              🟡 2026-08-26 复查: 3 条触发条件 2 条在 trunk 满足,
                                                                          refresh bug 未修 → 继续等待, 2026-09 上旬再看
[○○○○○○○○○○] Frontend Sprint 18 Settings 重做 (P3 §5.3)                  ⚪ 等 handoff
[○○○○○○○○○○] 用户自定义 AI 字段 (P3, Settings UI + 动态 schema)          ⚪ 不急
```

---

## 8. 下次 session 立即可做的事

按优先级:

### P0 — 本周
1. **uid-mapper 跑完后效果验证** (§4.5.4) — `sqlite3 ... "SELECT value FROM sync_state WHERE key='davmail_backfill_progress'"`. 期望 `completed:processed=8877 ...`. 跑完 audit_davmail_vs_sqlite.py 一周对账.
2. **端到端测试** — 自己发一封测试邮件, 走完 §2.2 全链路, 验证 SSoT 镜像新代码生效 (新邮件 ps 自动写入 SQLite).

### P1 — 本月
3. **DavMail OAuth token 监控** (§4.5.1) — `alert_davmail_token_expiring(days_left)` + watchdog. **token.dat 过期最致命**, 优先做.
4. **davmail-poc 进程死亡 watchdog** (§4.5.2) — `main.py` 加 60s `probe_tcp` 探测, 失败 ≥3 飞书 critical.
5. **EWS throttling burst 监控** (§4.5.3) — sidecar log tail + 自动暂停 uid-mapper backfill.
6. **handle_create_draft '草稿已创建' 镜像 SQLite** (§4.5.6) — codex P2 剩余 SSoT gap, ~10min.
7. **`mailagent admin backfill-processing-status` CLI** (§4.5.7) — 把本 session 3 轮 inline script 固化, ~1h.

### P2 — 季度
8. **AppleScript 路径下架评估** (§4.1) — 观察期满 3 个月零事故后启动.
9. **watch 上游 DavMail 6.9** (§5.1) — 触发条件: delta sync 进正式版 / #506 APPEND 修复 / refresh resource bug 修复. 满足后先跑半天影子实例验授权. ~~跟 IT 沟通 Graph app 注册~~ 已不是必需(Path A 无需 IT 审批), 仅在 2026-09 上游仍不可用时才回到自研兜底.
10. **frontend Sprint 18 Settings 页面重做** (§5.3) — handoff 已写, 等 frontend 工作流推进.

---

签字 / Last updated: 2026-05-22 PDT
