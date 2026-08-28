"""GET /api/calendar/agenda — 三源聚合读端点（P3 月视图）。

跑在**真 schema** 的临时 SQLite 上（`SyncStore._init_database()` 建全表），经真
FastAPI 栈 + 真 `CalendarService` / `ReportStore` / `schedule_rule`，不 mock 聚合层。

三源各自要锁的判据：
  - mail   —— 窗口过滤 · `hot` 批量 JOIN 命中与不命中 · multiDay 按 tz 判定
  - matter —— 已完成 / 已归档 / 已删除排除 · 行动项 kind='action' 过滤
  - agent  —— schedule 与 cron 两型展开 · 报告 agent 新老两形状 · 非排程 type 不进
"""

from __future__ import annotations

import json
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from src.api.app import app

# 窗口：2026-06-01（周一）00:00 UTC 起 7 天，右开。
WINDOW_FROM = "2026-06-01T00:00:00+00:00"
WINDOW_TO = "2026-06-08T00:00:00+00:00"

# calendar_event 的 ical_uid（🔴 dtstart_utc 是 epoch **秒**，不是毫秒）。
AG_HOT_UID = "ag-hot"          # email_ics → 源邮件 ai_priority='🔴 紧急'
AG_COLD_UID = "ag-cold"        # email_ics → 源邮件 ai_priority='🟢 一般'
AG_SPAN_UID = "ag-span"        # 全天跨 2 天 → multiDay 恒 true
AG_ALLDAY_UID = "ag-allday"    # 单天全天（DTEND 排他）→ multiDay 恒 false
AG_TZNIGHT_UID = "ag-tznight"  # 23:00Z→次日 00:30Z：UTC 下跨天，LA 下同一天
AG_RRULE_UID = "ag-weekly"     # FREQ=DAILY;COUNT=3 → 窗口内展开 3 次
AG_OUT_UID = "ag-out"          # 窗口外

HOT_EMAIL_ID = 7001
COLD_EMAIL_ID = 7002


def _sec(y: int, m: int, d: int, hh: int = 0, mm: int = 0) -> float:
    return datetime(y, m, d, hh, mm, tzinfo=timezone.utc).timestamp()


def _ms(y: int, m: int, d: int, hh: int = 0, mm: int = 0) -> int:
    return int(datetime(y, m, d, hh, mm, tzinfo=timezone.utc).timestamp() * 1000)


def _rule(**over) -> dict:
    """schedule 契约 §1 的 rule：10 键必填，缺一个 parse_rule 就拒。"""
    base = {
        "freq": "daily", "interval": 1, "weekdays": [], "monthMode": "date",
        "monthDay": 1, "ordinal": 1, "weekday": 0, "hour": 8, "minute": 0,
        "clamp": False,
    }
    base.update(over)
    return base


def _seed(db_path: Path) -> None:
    from src.mail.sync_store import SyncStore

    SyncStore(str(db_path))  # 真 schema：calendar_event / matter* / report_agent 全建
    now = time.time()
    now_ms = int(now * 1000)

    conn = sqlite3.connect(str(db_path))
    try:
        # ---------------- 源 1：calendar_event + 源邮件 ----------------
        events = [
            (AG_HOT_UID, "Sprint 评审", _sec(2026, 6, 2, 9), _sec(2026, 6, 2, 10),
             0, "email_ics", HOT_EMAIL_ID, None),
            (AG_COLD_UID, "部门周会", _sec(2026, 6, 2, 11), _sec(2026, 6, 2, 12),
             0, "email_ics", COLD_EMAIL_ID, None),
            (AG_SPAN_UID, "出差", _sec(2026, 6, 3), _sec(2026, 6, 5),
             1, "caldav", None, None),
            (AG_ALLDAY_UID, "全天占位", _sec(2026, 6, 4), _sec(2026, 6, 5),
             1, "caldav", None, None),
            (AG_TZNIGHT_UID, "跨夜通话", _sec(2026, 6, 2, 23), _sec(2026, 6, 3, 0, 30),
             0, "caldav", None, None),
            (AG_RRULE_UID, "每日站会", _sec(2026, 6, 2, 14), _sec(2026, 6, 2, 15),
             0, "caldav", None, "FREQ=DAILY;COUNT=3"),
            (AG_OUT_UID, "窗口外", _sec(2026, 7, 2, 9), _sec(2026, 7, 2, 10),
             0, "caldav", None, None),
        ]
        for uid, summary, start, end, all_day, source, email_id, rrule in events:
            conn.execute(
                """INSERT INTO calendar_event
                   (ical_uid, sequence, calendar_name, summary, attendees_json,
                    dtstart_utc, dtend_utc, is_all_day, status, source, rrule,
                    related_email_internal_id, last_synced_at, created_at, updated_at)
                   VALUES (?,0,'Work',?,'[]',?,?,?,'confirmed',?,?,?,?,?,?)""",
                (uid, summary, start, end, all_day, source, rrule, email_id,
                 now, now, now),
            )
        for internal_id, priority in (
            (HOT_EMAIL_ID, "🔴 紧急"),
            (COLD_EMAIL_ID, "🟢 一般"),
        ):
            conn.execute(
                "INSERT INTO email_metadata (internal_id, message_id, subject, sender, "
                "date_received, mailbox, sync_status, ai_priority, created_at, updated_at) "
                "VALUES (?,?,?,'boss@example.com','2026-06-01T09:00:00+08:00','收件箱',"
                "'synced',?,?,?)",
                (internal_id, f"<ag-{internal_id}@x>", f"invite {internal_id}",
                 priority, now, now),
            )

        # ---------------- 源 2：matter / matter_item ----------------
        matters = [
            # public_id, title, status, due_at, archived_at, deleted_at
            ("MAT-001", "季度复盘", "active", _ms(2026, 6, 3, 12), None, None),
            ("MAT-002", "已完成的事", "done", _ms(2026, 6, 3, 13), None, None),
            ("MAT-003", "已归档的事", "active", _ms(2026, 6, 3, 14), now_ms, None),
            ("MAT-004", "窗口外", "active", _ms(2026, 7, 1, 12), None, None),
            ("MAT-005", "已删除的事", "active", _ms(2026, 6, 3, 15), None, now_ms),
        ]
        for public_id, title, status, due_at, archived_at, deleted_at in matters:
            conn.execute(
                "INSERT INTO matter (public_id, title, status, due_at, archived_at, "
                "deleted_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
                (public_id, title, status, due_at, archived_at, deleted_at,
                 now_ms, now_ms),
            )
        live_matter_id = conn.execute(
            "SELECT id FROM matter WHERE public_id='MAT-001'"
        ).fetchone()[0]
        items = [
            # title, kind, status, due_at, deleted_at
            ("发问卷", "action", "open", _ms(2026, 6, 4, 15), None),
            ("已做完的行动项", "action", "done", _ms(2026, 6, 4, 16), None),
            ("已删除的行动项", "action", "open", _ms(2026, 6, 4, 17), now_ms),
            # kind != 'action' 的行按表级 CHECK 不许带 due_at —— 天然进不了日历。
            ("一条笔记", "note", None, None, None),
        ]
        for title, kind, status, due_at, deleted_at in items:
            conn.execute(
                "INSERT INTO matter_item (matter_id, kind, title, status, due_at, "
                "deleted_at, created_by_kind, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?,'user',?,?)",
                (live_matter_id, kind, title, status, due_at, deleted_at,
                 now_ms, now_ms),
            )

        # ---------------- 源 3：report_agent ----------------
        agents = [
            # id, type, enabled, title, schedule_json, trigger_json, timezone
            ("custom-schedule", "custom", 1, "早间巡检", None, json.dumps({
                "v": 2,
                "triggers": [{
                    "id": "trg_daily8", "enabled": True, "kind": "schedule",
                    "rule": _rule(hour=8), "anchor": "2026-06-01", "timezone": "UTC",
                }],
            }), None),
            # 恰好落在窗口两端：起点闭、终点开。
            ("custom-midnight", "custom", 1, "零点巡检", None, json.dumps({
                "v": 2,
                "triggers": [{
                    "id": "trg_mid", "enabled": True, "kind": "schedule",
                    "rule": _rule(hour=0), "anchor": "2026-06-01", "timezone": "UTC",
                }],
            }), None),
            ("custom-cron", "custom", 1, "周一提醒", None, json.dumps({
                "v": 1, "kind": "cron", "cron": "0 12 * * 1", "timezone": "UTC",
            }), None),
            ("custom-off", "custom", 0, "关掉的", None, json.dumps({
                "v": 1, "kind": "cron", "cron": "0 13 * * *", "timezone": "UTC",
            }), None),
            # 「不定时 · 你找它才动」= trigger_json 为空 → 没有可画的时刻。
            ("custom-none", "custom", 1, "随叫随到", None, None, None),
            # 事件型 trigger 没有可预知的时刻。
            ("custom-email", "custom", 1, "收信触发", None, json.dumps({
                "v": 1, "kind": "email_filter", "subject_pattern": "invoice",
            }), None),
            ("report-legacy", "report", 1, "每日简报",
             json.dumps({"cadence": "daily", "hours": [9]}), None, "UTC"),
            ("report-new", "report", 1, "周三周报", json.dumps({
                "kind": "schedule", "timezone": "UTC", "anchor": "2026-06-01",
                "rule": _rule(freq="weekly", weekdays=[3], hour=10),
            }), None, "UTC"),
            # preprocess 没有用户配置的排程语义 —— 即便有 schedule_json 也不进日历。
            ("preprocess", "preprocess", 1, "AI 预处理",
             json.dumps({"cadence": "daily", "hours": [7]}), None, "UTC"),
        ]
        for agent_id, atype, enabled, title, schedule_json, trigger_json, tz in agents:
            conn.execute(
                "INSERT INTO report_agent (id, type, enabled, title, schedule_json, "
                "trigger_json, timezone, updated_at) VALUES (?,?,?,?,?,?,?,?)",
                (agent_id, atype, enabled, title, schedule_json, trigger_json, tz, now),
            )
        conn.commit()
    finally:
        conn.close()


@pytest.fixture(scope="module")
def agenda_db(tmp_path_factory: pytest.TempPathFactory) -> Path:
    db = tmp_path_factory.mktemp("agenda") / "agenda_store.db"
    _seed(db)
    return db


@pytest.fixture()
def agenda_client(agenda_db: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    from src.api.deps import get_settings

    # trigger v2 门是热读 .env 的 —— 开发机 .env 里的值不该决定测试结果。钉死成 on
    # （= 代码默认），v1 envelope 仍由 parse_trigger_set 的 v==1 分支覆盖。
    monkeypatch.setattr("src.agents.trigger.trigger_v2_enabled", lambda: True)

    class _StubConfig:
        sync_store_db_path = str(agenda_db)
        calendar_caldav_sync_enabled = False

    app.dependency_overrides[get_settings] = lambda: _StubConfig()
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    app.dependency_overrides.pop(get_settings, None)


def _get(client: TestClient, **params) -> dict:
    query = {"fromIso": WINDOW_FROM, "toIso": WINDOW_TO}
    query.update(params)
    r = client.get("/api/calendar/agenda", params=query)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "success"
    assert body["error"] is None
    assert body["meta"]["source"] == "sqlite"
    return body


def _by_source(entries: list[dict], source: str) -> list[dict]:
    return [e for e in entries if e["source"] == source]


def _titles(entries: list[dict]) -> set[str]:
    return {e["title"] for e in entries}


# ===========================================================================
# envelope / 排序 / 窗口
# ===========================================================================


def test_agenda_envelope_and_meta(agenda_client):
    body = _get(agenda_client)
    assert isinstance(body["data"], list)
    assert body["meta"]["total"] == len(body["data"])
    assert body["meta"]["sources"] == ["mail", "matter", "agent"]
    assert body["meta"]["window"]["from_iso"].startswith("2026-06-01")
    assert body["meta"]["window"]["to_iso"].startswith("2026-06-08")


def test_agenda_sorted_by_start_and_unique_ids(agenda_client):
    entries = _get(agenda_client)["data"]
    starts = [e["startIso"] for e in entries]
    assert starts == sorted(starts)
    ids = [e["id"] for e in entries]
    assert len(ids) == len(set(ids))


def test_agenda_window_filters_all_sources(agenda_client):
    entries = _get(agenda_client)["data"]
    titles = _titles(entries)
    assert "窗口外" not in titles  # 7 月的日历事件 + 7 月截止的 MAT-004 都不在


# ===========================================================================
# 源 1：邮箱日历
# ===========================================================================


def test_agenda_mail_expands_rrule_with_distinct_ids(agenda_client):
    """RRULE 已在 CalendarService 里展开 —— 同一 master 的多次 occurrence 共享
    (icalUid, recurrenceId)，所以聚合 id 必须带上 occurrence 起点，否则整串重复。"""
    occs = [
        e for e in _by_source(_get(agenda_client)["data"], "mail")
        if e["icalUid"] == AG_RRULE_UID
    ]
    assert len(occs) == 3  # FREQ=DAILY;COUNT=3 → 06-02 / 06-03 / 06-04
    assert len({e["id"] for e in occs}) == 3
    assert [e["startIso"][:10] for e in occs] == ["2026-06-02", "2026-06-03", "2026-06-04"]


def test_agenda_mail_hot_join(agenda_client):
    mail = {e["icalUid"]: e for e in _by_source(_get(agenda_client)["data"], "mail")}
    assert mail[AG_HOT_UID]["hot"] is True     # 源邮件 ai_priority='🔴 紧急'
    assert mail[AG_COLD_UID]["hot"] is False   # 源邮件 ai_priority='🟢 一般'
    assert mail[AG_SPAN_UID]["hot"] is False   # caldav，压根没有源邮件


def test_agenda_mail_locator_fields(agenda_client):
    hot = next(
        e for e in _by_source(_get(agenda_client)["data"], "mail")
        if e["icalUid"] == AG_HOT_UID
    )
    assert isinstance(hot["eventId"], int)
    assert hot["recurrenceId"] is None
    assert hot["endIso"].startswith("2026-06-02T10:00")
    # 「按日历筛选」的前端判据 (seed 全部落在 'Work' 日历)。
    assert hot["calendarName"] == "Work"
    # 后端不掺前端路由知识。
    assert "href" not in hot


def test_agenda_calendar_name_only_on_mail_entries(agenda_client):
    """mail 条目带 calendarName; matter/agent 条目不带此键 —— 前端「按日历筛选」
    只对 mail 生效, matter/agent 恒显示的判据就是键缺席。"""
    entries = _get(agenda_client)["data"]
    mail = _by_source(entries, "mail")
    assert mail, "seed 必须有 mail 条目"
    assert all(e.get("calendarName") == "Work" for e in mail)
    for source in ("matter", "agent"):
        rest = _by_source(entries, source)
        assert rest, f"seed 必须有 {source} 条目"
        assert all("calendarName" not in e for e in rest)


def test_agenda_multi_day_uses_utc_by_default(agenda_client):
    mail = {e["icalUid"]: e for e in _by_source(_get(agenda_client)["data"], "mail")}
    assert mail[AG_SPAN_UID]["multiDay"] is True      # 06-03 → 06-05（全天两天）
    assert mail[AG_SPAN_UID]["allDay"] is True
    # DTEND 排他：单天全天事件的 06-05T00:00 不该把它算成跨天。
    assert mail[AG_ALLDAY_UID]["multiDay"] is False
    assert mail[AG_TZNIGHT_UID]["multiDay"] is True   # 23:00Z → 次日 00:30Z


def test_agenda_multi_day_follows_tz_param(agenda_client):
    mail = {
        e["icalUid"]: e
        for e in _by_source(
            _get(agenda_client, tz="America/Los_Angeles")["data"], "mail"
        )
    }
    # LA 下 23:00Z→00:30Z 是同一天的 16:00→17:30，不再跨天。
    assert mail[AG_TZNIGHT_UID]["multiDay"] is False
    # 全天跨两天在任何时区都跨天。
    assert mail[AG_SPAN_UID]["multiDay"] is True


# ===========================================================================
# 源 2：事项
# ===========================================================================


def test_agenda_matter_live_set_only(agenda_client):
    matter = _by_source(_get(agenda_client)["data"], "matter")
    titles = _titles(matter)
    assert "季度复盘" in titles
    assert "已完成的事" not in titles    # status='done'
    assert "已归档的事" not in titles    # archived_at 非空
    assert "已删除的事" not in titles    # deleted_at 非空


def test_agenda_matter_action_items(agenda_client):
    matter = _by_source(_get(agenda_client)["data"], "matter")
    titles = _titles(matter)
    assert "发问卷" in titles
    assert "已做完的行动项" not in titles
    assert "已删除的行动项" not in titles
    assert "一条笔记" not in titles      # kind != 'action'

    item = next(e for e in matter if e["title"] == "发问卷")
    assert item["matterId"] == "MAT-001"
    assert item["itemId"].isdigit()
    assert item["id"] == f"matter-item:{item['itemId']}"
    # 截止日是时间点，没有跨度。
    assert item["endIso"] is None
    assert item["multiDay"] is False
    assert item["startIso"].startswith("2026-06-04T15:00")

    head = next(e for e in matter if e["title"] == "季度复盘")
    assert head["id"] == "matter:MAT-001"
    assert head["matterId"] == "MAT-001"
    assert "itemId" not in head


# ===========================================================================
# 源 3：Agent 排程
# ===========================================================================


def _agent_starts(entries: list[dict], agent_id: str) -> list[str]:
    return [e["startIso"] for e in entries if e.get("agentId") == agent_id]


def test_agenda_agent_schedule_kind_expands_daily(agenda_client):
    entries = _by_source(_get(agenda_client)["data"], "agent")
    starts = _agent_starts(entries, "custom-schedule")
    assert len(starts) == 7                      # 06-01 .. 06-07，每天 08:00 UTC
    assert starts[0].startswith("2026-06-01T08:00")
    assert starts[-1].startswith("2026-06-07T08:00")
    one = next(e for e in entries if e["agentId"] == "custom-schedule")
    assert one["title"] == "早间巡检"
    assert one["endIso"] is None and one["multiDay"] is False and one["hot"] is False


def test_agenda_agent_window_is_half_open(agenda_client):
    """窗口 [start, end)：恰好落在起点的那次要进来，恰好落在终点的那次不进来。"""
    entries = _by_source(_get(agenda_client)["data"], "agent")
    starts = _agent_starts(entries, "custom-midnight")
    assert starts[0] == "2026-06-01T00:00:00+00:00"   # == window_start，闭
    assert starts[-1] == "2026-06-07T00:00:00+00:00"  # 06-08T00:00 == window_end，开
    assert len(starts) == 7


def test_agenda_agent_cron_kind_expands(agenda_client):
    entries = _by_source(_get(agenda_client)["data"], "agent")
    starts = _agent_starts(entries, "custom-cron")
    # 「每周一 12:00」在 [06-01, 06-08) 里只有 06-01 一次（06-08 12:00 已出窗）。
    assert starts == ["2026-06-01T12:00:00+00:00"]


def test_agenda_agent_report_legacy_shape(agenda_client):
    entries = _by_source(_get(agenda_client)["data"], "agent")
    starts = _agent_starts(entries, "report-legacy")
    # 🔴 老 {cadence,hours} 形状必须经 rules_from_legacy_schedule 展开，漏了这一支
    # 存量报告 agent 会整批不上日历。
    assert len(starts) == 7
    assert starts[0].startswith("2026-06-01T09:00")


def test_agenda_agent_report_new_shape(agenda_client):
    entries = _by_source(_get(agenda_client)["data"], "agent")
    # weekdays=[3] 是契约口径（0=周日）→ 周三 = 2026-06-03。
    assert _agent_starts(entries, "report-new") == ["2026-06-03T10:00:00+00:00"]


def test_agenda_agent_excludes_non_scheduled(agenda_client):
    ids = {e.get("agentId") for e in _by_source(_get(agenda_client)["data"], "agent")}
    assert "custom-off" not in ids       # enabled=0
    assert "custom-none" not in ids      # 不定时档（trigger_json 为空）
    assert "custom-email" not in ids     # 事件型 trigger 没有可预知时刻
    assert "preprocess" not in ids       # 非排程 type


# ===========================================================================
# 参数
# ===========================================================================


def test_agenda_sources_filter(agenda_client):
    body = _get(agenda_client, sources="matter")
    assert body["meta"]["sources"] == ["matter"]
    assert {e["source"] for e in body["data"]} == {"matter"}

    body = _get(agenda_client, sources="agent,mail")
    assert body["meta"]["sources"] == ["mail", "agent"]  # 恒按 AGENDA_SOURCES 的顺序
    assert {e["source"] for e in body["data"]} == {"mail", "agent"}


def test_agenda_calendar_name_filter(agenda_client):
    body = _get(agenda_client, calendarName="Nope", sources="mail")
    assert body["data"] == []


def test_agenda_rejects_bad_args(agenda_client):
    for params in (
        {"sources": "mail,bogus"},
        {"tz": "Mars/Olympus"},
        {"fromIso": WINDOW_TO, "toIso": WINDOW_FROM},
    ):
        query = {"fromIso": WINDOW_FROM, "toIso": WINDOW_TO}
        query.update(params)
        r = agenda_client.get("/api/calendar/agenda", params=query)
        assert r.status_code == 400, (params, r.text)
        assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_agenda_default_window_is_7d(agenda_client):
    r = agenda_client.get("/api/calendar/agenda")
    assert r.status_code == 200
    meta = r.json()["meta"]
    start = datetime.fromisoformat(meta["window"]["from_iso"])
    end = datetime.fromisoformat(meta["window"]["to_iso"])
    assert (end - start).days == 7
    assert (start.hour, start.minute, start.second) == (0, 0, 0)
