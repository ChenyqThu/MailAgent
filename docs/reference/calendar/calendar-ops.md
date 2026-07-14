# Calendar Module 运维速查（从 CLAUDE.md 下沉）

> Phase 0+1+2+3+1.5 已上线（2026-05-23）。设计 PRD 见 [`docs/calendar-module-prd.md`](calendar-module-prd.md)，
> 下次 session handoff 见 [`docs/calendar-next-session-handoff.md`](../../archive/2026-05/calendar-next-session-handoff.md)。
>
> **SSoT**: SQLite `calendar_event` 表 (DB v15)。DavMail CalDAV → SQLite → 前端日历视图 / CLI / Notion mirror 单一数据源。

## 数据流

```
Outlook (公司 Exchange)
     ↑↓ EWS
DavMail JVM (127.0.0.1:1080 CalDAV)
     ↑ caldav Python lib (expand=False, 返 master + RRULE)
CalendarSyncWorker (mail-sync 进程内 asyncio loop, 60s 轮询)
     ↓ upsert
SQLite calendar_event (master events + RRULE)
     ↓ 直读 (better-sqlite3 + npm rrule 客户端展开)
     ├─ 前端 IPC handlers (~5ms)
     └─ mailagent calendar CLI (today/week/event-get/etc.)
```

## `calendar_event` 表 (DB v15)

```sql
CREATE TABLE calendar_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ical_uid TEXT NOT NULL,                  -- RFC 5545 UID
    recurrence_id TEXT,                       -- 非空 = 单次跳脱 occurrence
    sequence INTEGER DEFAULT 0,
    calendar_name TEXT,                       -- "日历" / "Work" / 共享日历
    summary TEXT, description TEXT, location TEXT,
    organizer TEXT,                           -- mailto 已剥
    attendees_json TEXT,                      -- [{email, name, response, role}]
    dtstart_utc REAL NOT NULL,                -- UTC epoch, 前端 toLocaleString 转本地
    dtend_utc REAL,
    is_all_day INTEGER,
    rrule TEXT,                               -- FREQ=WEEKLY;BYDAY=MO;... (主事件才有)
    exdates_json TEXT, rdates_json TEXT,
    status TEXT,                              -- CONFIRMED / TENTATIVE / CANCELLED
    response_status TEXT,                     -- ACCEPTED / DECLINED / TENTATIVE / NEEDS-ACTION
    url TEXT, ics_raw TEXT,
    source TEXT NOT NULL,                     -- caldav / email_ics / legacy_calendar_app
    notion_page_id TEXT,
    related_email_internal_id INTEGER,        -- 邮件邀请派生时关联邮件
    last_synced_at REAL NOT NULL,
    deleted_at REAL,
    created_at REAL NOT NULL, updated_at REAL NOT NULL,
    CHECK (source IN ('caldav', 'email_ics', 'legacy_calendar_app'))
);
-- UNIQUE INDEX with COALESCE(recurrence_id, '') — NULL 也参与去重
CREATE UNIQUE INDEX idx_calendar_event_unique
    ON calendar_event(ical_uid, COALESCE(recurrence_id, ''), source);
```

`source` 三态共存:
- `caldav` — CalendarSyncWorker 从 DavMail CalDAV 拉的 (主路径, 全仓唯一活跃写入方)
- `email_ics` — **预留枚举, 从未实现写入** (生产 0 行, 2026-07 epic 正式判死; `src/mail/meeting_sync.py` 只写 Notion + `recurring_series`, 不写本表)。邮件 ↔ 日历联动的正解 = 按 `ical_uid` 反查 caldav 行 (`idx_calendar_event_uid` 索引现成, **epic 阶段 2.1 已落地, 见下方 email_meeting**), 不要再补 email_ics 写入
- `legacy_calendar_app` — Phase 3 已下线 (2026-05-25); 枚举值保留作 backward compat, 不再写新行

### email_meeting — 邮件 ↔ 日历 ical_uid 映射 (DB v34, epic 阶段 2.1 / P1-3)

一封会议邀请邮件 ↔ 它携带的 vEvent UID。此前 uid 只进 Notion + `recurring_series`
(仅周期会议), raw MIME 不持久化、.ics 附件被 reader skip → 无法事后解析, 双向互跳必须落存储:

```sql
CREATE TABLE email_meeting (
    internal_id INTEGER PRIMARY KEY,          -- FK → email_metadata ON DELETE CASCADE
    ical_uid TEXT NOT NULL,                   -- idx_email_meeting_uid
    method TEXT,                              -- REQUEST/CANCEL/REPLY; NULL = v34 回填行 (不可考)
    recurrence_id TEXT,                       -- override 邀请目标时间 ISO; NULL = master/单次
    sequence INTEGER, is_recurring INTEGER,
    created_at REAL, updated_at REAL
);
```

- **写入方**: `new_watcher` 会议检测 hook (每封解析出 invite 的新邮件, 与 Notion sync 成败无关) +
  `recurring_invite.replay_one` (`mailagent calendar recurring replay` 重新 fetch+解析时顺路补写 = 存量幂等回填路径)。
- **v34 迁移回填覆盖**: 存量周期会议 best-effort (每 series 的 `last_seen_message_id` 那一封, method=NULL);
  存量非周期邀请**不可回填** (无源可解析)。新邮件 (含 SYNC_FOLDERS 自定义文件夹主链路) 全覆盖。
- **查询面** (三面, 全只读): 方向 A 邮件→日历 = uid + 代表 master 行 (`recurrence_id IS NULL` 优先 →
  source 按 caldav→email_ics→legacy → dtstart 最早) + `in_calendar`; 方向 B uid→来源邀请邮件
  (多封同 uid 优先最新 METHOD:REQUEST, 无 REQUEST 取最新任意一封)。
  - Electron IPC: `calendar:emailCalendarLink(internalId)` / `calendar:eventSourceEmail(icalUid)` (better-sqlite3 直读)
  - HTTP: `GET /api/calendar/email-link/{internal_id}` / `GET /api/calendar/events/{event_id}/source-email` (404→前端 null)
  - Service: `CalendarService.get_email_calendar_link` / `get_event_source_email` (+ `CalendarEventRepository.get_master_by_uid`)

## 模块结构

```
src/calendar_sync/  (Phase 1 起新模块; Phase 2/3/4 写能力齐备)
  __init__.py
  repository.py     CalendarEventRepository CRUD + 时间窗口查询 (含 RRULE 展开)
  expander.py       expand_in_window (dateutil.rrule + EXDATE/RDATE/max_count cap)
  reconciler.py     reconcile_full_window (软删除检测) + reconcile_incremental
  worker.py         CalendarSyncWorker asyncio loop (60s ctag 轮询; ctag 取不到 1h time-fallback 兜底)
  caldav_reader.py  CalDAVReader (Phase 3 从 calendar_notion 迁入; cal.search(expand=False) 返 master + RRULE)
  caldav_writer.py  Phase 2/4 — CalDAV PUT/DELETE (create/update/update_occurrence/split_series/delete)
  rsvp.py           Phase 2.1 — RSVP orchestration (读行 → iTIP REPLY → SMTP → 回写 response_status)
  itip_reply.py     Phase 2.1 — iTIP REPLY (RFC 5546) MIME 拼装 + DavMail SMTP 发送
  service.py        Phase 3 — CalendarService facade (CLI / IPC / HTTP 共用业务入口)
  _common.py        跨模块共享 const/helper (SOURCES_TRY_ORDER, RFC 5545 escape, UTC 格式化)

src/calendar_notion/
  recurring_invite.py  discover_recurring (Phase 1.5: 改读 calendar_event WHERE rrule != '')
  sync.py           CalendarNotionSync (Notion 镜像)
  (注: meeting_sync.py 在 src/mail/, 只写 Notion + recurring_series, 不写 calendar_event)

frontend/src/shared/components/calendar/
  CalendarToolbar.tsx   顶部 toolbar (视图切换 + 日期导航 + 同步按钮)
  EventChip.tsx         月/Agenda 单格 chip
  EventBlock.tsx        周/日 timeline 块
  EventDetailDrawer.tsx 右侧详情抽屉
  CalendarPage.tsx      老定期邀请运维表 (view=recurring)
  hooks/useCalendarEvents.ts  react-query + 时间窗口计算
  views/{Day,Week,Month,Agenda}View.tsx

frontend/src/electron/main/handlers/calendar.ts  (注册; 实现拆在 calendar-{read,write,sync,shared}.ts)
  15 个 IPC 通道:
  - 6 个 SQLite 直读: eventsList / eventGet / syncStatus / calendarNames /
    emailCalendarLink / eventSourceEmail (后两个 = 阶段 2.1 email_meeting 双向反查)
  - 9 个写/替身 (经 CLI 子进程): recurringDiscover / recurringReplay / expand /
    syncTrigger / eventReplay / eventRsvp / eventCreate / eventUpdate / eventDelete
```

## CLI 命令

```bash
# 读 (无需 auth)
mailagent calendar today                                  # 今天 0:00-24:00
mailagent calendar week                                   # 未来 7 天
mailagent calendar events --from 2026-05-01 --to 2026-06-01 --calendar 日历
mailagent calendar event-get <ical_uid> [--recurrence-id ID] [--source caldav]
mailagent calendar sync-status                            # 列 calendar_sync_state 表
mailagent calendar recurring discover [--since YYYY-MM-DD]  # RRULE master 列表

# 写 (需 auth, --api-key 或 MAILAGENT_CLI_ALLOW_UNAUTH_WRITES)
mailagent calendar sync-now [--full/--incremental] [--calendar X]
mailagent calendar recurring replay <internal_id>  # 注: Phase 1.5 后 caldav-only events internal_id=0 无效, Phase 2 重做
mailagent calendar expand --no-dry-run             # 周期会议 Notion 镜像 expansion
```

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `CALENDAR_CALDAV_SYNC_ENABLED` | `false` | CalendarSyncWorker 总开关 |
| `CALENDAR_CALDAV_SYNC_POLL_INTERVAL_SEC` | `60` | ctag 轮询间隔 |
| `CALENDAR_CALDAV_SYNC_WINDOW_PAST_DAYS` | `30` | 全量 sync 窗口左边界 (今天 - N 天) |
| `CALENDAR_CALDAV_SYNC_WINDOW_FUTURE_DAYS` | `180` | 全量 sync 窗口右边界 |
| `DAVMAIL_CALDAV_PORT` | `1080` | DavMail CalDAV 端口 |
| `LLM_CALDAV_CONTEXT_ENABLED` | `false` | LLM agent 注入"今日日程" context |

## 双端可写 lost-update 语义 (P2-7, 2026-07 epic 阶段 3.4 文档化)

写路径 (`caldav_writer.py` 直接 PUT + #11 起的远程 HTTP 写端点) 与 Outlook/OWA 端
同时可写同一事件, 而 CalDAV PUT 是**整资源替换**且我们**不带 If-Match/ETag 条件头**
(库源码层面核实: caldav 3.2.0 `_put` 在 Event 对象携带 etag 时**会**自动发 If-Match,
但我们的读回路径 `event_by_uid` 走 REPORT calendar-query 只请求 calendar-data 不请求
getetag → `.etag` 恒 None → 恒无条件 PUT; 未来做条件写第一步就是读回时补 getetag prop):
`update_event` 先读原 VEVENT 字段再合并整体 PUT, 两次操作之间服务端若被另一端改过,
后写方会用自己读到的旧快照覆盖 → **last-writer-wins, 静默丢字段**。典型场景: 用户在
OWA 改了地点, 几秒内又在 MailAgent 改标题 —— MailAgent PUT 携带的是读取时的旧地点,
OWA 那次修改被无声回退。同理反向 (MailAgent 写完、下一个 60s sync 窗口内 OWA 覆盖)。

**ETag 条件写 (If-Match) 判 icebox, 理由**:
① 冲突窗口实际是"读-改-写"的秒级窗口 × 单用户双端同时编辑同一事件, 概率极低, 且
worker 60s 轮询会把服务端最新态拉回 SQLite (最终一致, 丢的是并发那一次修改而非持续
漂移); ② DavMail 桥的 ETag 支持度未经验证 (getctag 都需要 BaseElement workaround,
见上), 做条件写需先补一轮真日历验证 + 409 冲突的 UI 交互 (重读/重试/合并提示), 成本
与收益不成比例。若未来出现真实 dogfood 冲突案例或多写入端 (agent 写工具高频化), 再
从 `evt.save()` 前捕获 ETag + If-Match 头做起。

## 已知限制

1. ~~**CTag 取不到**~~ **已修复** (`e2526373`, caldav 3.x BaseElement 取法): 生产 ctag 有值, 60s 轮询 ctag 变更即增量 sync; 1h time-fallback 只剩 ctag 偶发取不到时的兜底角色.
2. **caldav-only events `related_email_internal_id=0`**: Replay 按钮无效, Phase 2 改"基于 calendar_event 重导出 Notion"语义.
3. **窗口外 master 也保留**: `expand=False` 后, 即使 master dtstart 在 2025 年, 只要 RRULE 在 2026 仍 valid, 行都保留. 客户端 expander 按窗口过滤显示.
4. ~~**多 calendar 支持有限**~~ **已解决** (worker F8): 启动即 discover 全部 calendars, 之后每 ~1h (60 ticks) 重 list + diff (新增 cal 单独全量 sync, 移除 cal 保留行); 前端 toolbar 有多日历 chips.
5. **DavMail 更新 PUT 返 200** (2026-07-14 #9 真日历验证实锤): caldav 3.2.0 只认 201/204, 会先盲重 PUT 一次再误抛 PutError → writer 已内置 `_save_existing_event` workaround (200 吞成功). 副作用: 每次更新实际 PUT 两次, DavMail 日志成对 `Overwritten event` WARN 是正常指纹非异常.
6. **写路径时区错位两连 (真 bug, 待 tzid task 修)**: ① `update_occurrence` 的 override DTSTART 裸 `Z` 时间被 DavMail→EWS 当邮箱本地墙钟解释 (实测 +7h 错位); ② `split_series` 的 UNTIL 被 Exchange 归一成日期粒度 EndDate → split 后头 1-2 天新老系列重叠重复. 且 **CalDAV 返 200 ≠ EWS 端成功** (DavMail 吞 EWS 业务错误照返 200, 如 DAILY 系列 ErrorOccurrenceCrossingBoundary). 详见 `.trellis/tasks/07-13-epic-issue-ui-ux/research/real-calendar-verification.md` (F1/F2/F6).
7. **CalDAV 调用可能被 EWS 挂起永久吊死**: caldav 传的 `timeout=30` 保护不到响应 body 读 (niquests/urllib3-future 裸 `sock.recv`), EWS 节流/挂起时调用线程无限等 (实测 17 分钟). worker/CLI/serve-api 写路径共享此暴露面; 加固方向见验证报告 F5.

## 重启 / 验收命令

```bash
# 启用 + 重启
echo 'CALENDAR_CALDAV_SYNC_ENABLED=true' >> .env
pm2 restart mail-sync

# 验收
KEY=$(grep "^MAILAGENT_CLI_API_KEY=" .env | cut -d= -f2-)
mailagent --api-key "$KEY" calendar sync-status -o json | jq '.data.calendars'
mailagent --api-key "$KEY" calendar today -o json | jq '.data.total'
mailagent --api-key "$KEY" calendar recurring discover -o json | jq '.data.total_series'

# 数据分布
sqlite3 -header data/sync_store.db "
SELECT source, COUNT(*) AS n,
       SUM(CASE WHEN rrule != '' THEN 1 ELSE 0 END) AS with_rrule,
       SUM(CASE WHEN recurrence_id IS NULL THEN 1 ELSE 0 END) AS masters
FROM calendar_event WHERE deleted_at IS NULL GROUP BY source"

# 前端
cd frontend && pnpm dev   # /admin/calendar?view=week 默认
```

## legacy `calendar_main.py` — Phase 3 已下线 (2026-05-25)

老的独立日历同步服务 (root `calendar_main.py` + `src/calendar/` 整目录 + PM2 `calendar-sync` 进程) 已删除. CalendarSyncWorker 在 `mail-sync` 进程内 asyncio loop 完整接管 CalDAV → SQLite SSoT.

DB schema CHECK 约束保留 `'legacy_calendar_app'` 枚举值作 backward compat; SOURCES_TRY_ORDER / _VALID_SOURCES 等常量同样保留. 实际无任何 row 跑过该 source (cutover 前已确认 zero rows 含 soft-deleted).
