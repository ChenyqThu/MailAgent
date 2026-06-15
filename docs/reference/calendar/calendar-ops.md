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
- `caldav` — CalendarSyncWorker 从 DavMail CalDAV 拉的 (主路径)
- `email_ics` — meeting_sync.py 从邮件 .ics 派生 (`related_email_internal_id` 关联)
- `legacy_calendar_app` — Phase 3 已下线 (2026-05-25); 枚举值保留作 backward compat, 不再写新行

## 模块结构

```
src/calendar_sync/  (Phase 1 新模块, ~900 LOC)
  __init__.py
  repository.py     CalendarEventRepository CRUD + 时间窗口查询 (含 RRULE 展开)
  expander.py       expand_in_window (dateutil.rrule + EXDATE/RDATE/max_count cap)
  reconciler.py     reconcile_full_window (软删除检测) + reconcile_incremental
  worker.py         CalendarSyncWorker asyncio loop (60s ctag 轮询; ctag 不可用 1h time-fallback)

src/calendar_notion/
  caldav_reader.py  CalDAVReader (Phase 1.5: cal.search(expand=False) 返 master + RRULE)
  meeting_sync.py   邮件 .ics → calendar_event (source='email_ics')
  recurring_invite.py  discover_recurring (Phase 1.5: 改读 calendar_event WHERE rrule != '')
  sync.py           CalendarNotionSync (Notion 镜像)

frontend/src/shared/components/calendar/
  CalendarToolbar.tsx   顶部 toolbar (视图切换 + 日期导航 + 同步按钮)
  EventChip.tsx         月/Agenda 单格 chip
  EventBlock.tsx        周/日 timeline 块
  EventDetailDrawer.tsx 右侧详情抽屉
  CalendarPage.tsx      老定期邀请运维表 (view=recurring)
  hooks/useCalendarEvents.ts  react-query + 时间窗口计算
  views/{Day,Week,Month,Agenda}View.tsx

frontend/src/electron/main/handlers/calendar.ts
  5 个新 IPC: events:list / events:get / sync:status / sync:trigger / calendarNames
  + 3 个老 IPC: recurringDiscover / recurringReplay / expand
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
| `FRONTEND_CALENDAR_V2_ENABLED` | `false` | 前端日历模块灰度开关 (Phase 4 用) |
| `DAVMAIL_CALDAV_PORT` | `1080` | DavMail CalDAV 端口 |
| `LLM_CALDAV_CONTEXT_ENABLED` | `false` | LLM agent 注入"今日日程" context |

## 已知限制

1. **CTag 取不到**: DavMail 6.7 PROPFIND getctag XML 格式跟 caldav lib 不一致, ctag 始终 null. worker 走 1h time-fallback 兜底. 用户改日历最多 1h 延迟; 急用按 [同步] 按钮.
2. **caldav-only events `related_email_internal_id=0`**: Replay 按钮无效, Phase 2 改"基于 calendar_event 重导出 Notion"语义.
3. **窗口外 master 也保留**: `expand=False` 后, 即使 master dtstart 在 2025 年, 只要 RRULE 在 2026 仍 valid, 行都保留. 客户端 expander 按窗口过滤显示.
4. **多 calendar 支持有限**: 当前只默认 `日历` (Outlook 默认 calendar name 中文). 共享日历需 toolbar chip + worker 拉所有 calendars.

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
