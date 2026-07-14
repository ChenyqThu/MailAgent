"""calendar WRITE endpoints (src/api/routers/calendar.py — 阶段 3.1 #11).

POST /events · PATCH /events/{uid} (三分支) · DELETE /events/{uid} ·
POST /events/{uid}/rsvp · POST /events/{uid}/replay。

CalendarService 写方法全部 monkeypatch 掉 (同 sync-trigger 测试模式) — 不打真
CalDAV/SMTP/Notion。覆盖:
  - 参数透传 (camelCase body → service kwargs; ISO+tz → UTC datetime 换算);
  - update 三分支 dispatch (整系列 / recurrenceId=改这次 / +splitFuture=改未来);
  - attendees 三态 (缺席/null/空数组=None 保留 — 逐字对齐 Electron 面
    `opts.attendees || []`; clearAttendees=[] 清空; 非空列表=替换) + 两互斥 400;
  - rsvp response alias (大小写不敏感 accept/yes/maybe/no → PARTSTAT 三值域);
  - 错误 envelope: ValueError "not found" → 404 E_NOT_FOUND; 其它 ValueError →
    400 E_INVALID_ARG; CalDAV 炸 → 502 E_CALDAV; SMTP/Notion 上游炸 → 502 E_UPSTREAM;
  - 鉴权拒绝: AUTH_DISABLED off + 无 JWT → 五个写端点全 401。
"""

from __future__ import annotations

from datetime import datetime, timezone

import src.api.auth as auth_mod
from src.calendar_sync.service import CalendarService


def _ok(payload: dict) -> None:
    assert payload["status"] == "success"
    assert payload["error"] is None
    # mutating 端点 → meta.source='cli' (对齐 email 写面 / sync-trigger)。
    assert payload["meta"]["source"] == "cli"


def _err(payload: dict, *, code: str) -> None:
    assert payload["status"] == "error"
    assert payload["data"] is None
    assert payload["error"]["code"] == code


# ===========================================================================
# POST /api/calendar/events — create
# ===========================================================================


def test_create_param_passthrough(cal_folder_client, monkeypatch):
    captured: dict = {}

    def fake_create(self, **kw):
        captured.update(kw)
        return {"action": "created", "ical_uid": "uid-new", "calendar_name": "Work",
                "dtstart_iso": "2026-06-01T02:00:00+00:00"}

    monkeypatch.setattr(CalendarService, "create_event", fake_create)

    r = cal_folder_client.post("/api/calendar/events", json={
        "summary": "Design review",
        "startIso": "2026-06-01T10:00:00+08:00",
        "endIso": "2026-06-01T11:00:00+08:00",
        "location": "Room A",
        "description": "agenda",
        "attendees": [{"email": "a@example.com", "name": "Alice"},
                      {"email": "b@example.com"}],
        "calendarName": "Work",
        "status": "TENTATIVE",
        "rrule": "FREQ=WEEKLY;BYDAY=MO",
        "isAllDay": False,
    })
    assert r.status_code == 200
    body = r.json()
    _ok(body)
    assert body["data"]["ical_uid"] == "uid-new"  # data = writer 结果透传

    # ISO+08:00 → UTC datetime 归一 (镜像 CLI _parse_iso_datetime_strict)。
    assert captured["dtstart_utc"] == datetime(2026, 6, 1, 2, 0, tzinfo=timezone.utc)
    assert captured["dtend_utc"] == datetime(2026, 6, 1, 3, 0, tzinfo=timezone.utc)
    assert captured["summary"] == "Design review"
    assert captured["location"] == "Room A"
    assert captured["description"] == "agenda"
    assert captured["attendees"] == [
        {"email": "a@example.com", "name": "Alice"},
        {"email": "b@example.com"},
    ]
    assert captured["calendar_name"] == "Work"
    assert captured["status"] == "TENTATIVE"
    assert captured["rrule"] == "FREQ=WEEKLY;BYDAY=MO"
    assert captured["is_all_day"] is False


def test_create_all_day_flag(cal_folder_client, monkeypatch):
    captured: dict = {}

    def fake_create(self, **kw):
        captured.update(kw)
        return {"ical_uid": "uid-allday"}

    monkeypatch.setattr(CalendarService, "create_event", fake_create)

    r = cal_folder_client.post("/api/calendar/events", json={
        "summary": "Offsite",
        "startIso": "2026-06-01T00:00:00Z",
        "endIso": "2026-06-02T00:00:00Z",
        "isAllDay": True,
    })
    assert r.status_code == 200
    assert captured["is_all_day"] is True
    assert captured["status"] == "CONFIRMED"  # 默认
    assert captured["attendees"] == []
    assert captured["rrule"] is None


def test_create_missing_summary_400(cal_folder_client):
    r = cal_folder_client.post("/api/calendar/events", json={
        "startIso": "2026-06-01T00:00:00Z", "endIso": "2026-06-01T01:00:00Z",
    })
    assert r.status_code == 400
    _err(r.json(), code="E_INVALID_ARG")


def test_create_naive_datetime_400(cal_folder_client):
    r = cal_folder_client.post("/api/calendar/events", json={
        "summary": "x",
        "startIso": "2026-06-01T10:00:00",  # 无 tz → 拒绝 (CLI strict 同款)
        "endIso": "2026-06-01T11:00:00Z",
    })
    assert r.status_code == 400
    _err(r.json(), code="E_INVALID_ARG")


def test_create_bad_attendee_400(cal_folder_client):
    r = cal_folder_client.post("/api/calendar/events", json={
        "summary": "x",
        "startIso": "2026-06-01T10:00:00Z", "endIso": "2026-06-01T11:00:00Z",
        "attendees": [{"email": "not-an-email"}],
    })
    assert r.status_code == 400
    _err(r.json(), code="E_INVALID_ARG")


def test_create_service_valueerror_400(cal_folder_client, monkeypatch):
    def bad(self, **kw):
        raise ValueError("dtend_utc must be > dtstart_utc")

    monkeypatch.setattr(CalendarService, "create_event", bad)
    r = cal_folder_client.post("/api/calendar/events", json={
        "summary": "x",
        "startIso": "2026-06-01T11:00:00Z", "endIso": "2026-06-01T10:00:00Z",
    })
    assert r.status_code == 400
    _err(r.json(), code="E_INVALID_ARG")


def test_create_caldav_fail_502(cal_folder_client, monkeypatch):
    def boom(self, **kw):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(CalendarService, "create_event", boom)
    r = cal_folder_client.post("/api/calendar/events", json={
        "summary": "x",
        "startIso": "2026-06-01T10:00:00Z", "endIso": "2026-06-01T11:00:00Z",
    })
    assert r.status_code == 502
    _err(r.json(), code="E_CALDAV")


# ===========================================================================
# PATCH /api/calendar/events/{uid} — update 三分支 dispatch
# ===========================================================================


def _patch_all_update_methods(monkeypatch, calls: dict):
    """三个 update 家族方法全部替换; calls 记录 (method, kwargs)。"""

    def make(name):
        def fake(self, **kw):
            calls.setdefault(name, []).append(kw)
            return {"action": name, "ical_uid": kw.get("ical_uid"), "sequence": 1,
                    "calendar_name": "Work"}
        return fake

    monkeypatch.setattr(CalendarService, "update_event", make("update_event"))
    monkeypatch.setattr(CalendarService, "update_occurrence", make("update_occurrence"))
    monkeypatch.setattr(CalendarService, "split_series", make("split_series"))


def test_update_whole_series_branch(cal_folder_client, monkeypatch):
    calls: dict = {}
    _patch_all_update_methods(monkeypatch, calls)

    r = cal_folder_client.patch("/api/calendar/events/uid-1", json={
        "summary": "new title",
        "startIso": "2026-06-01T10:00:00+08:00",
        "rrule": "",  # 空串 = 删除 RRULE (周期→单次), 不是「未传」
        "noSequenceBump": True,
    })
    assert r.status_code == 200
    _ok(r.json())
    assert list(calls.keys()) == ["update_event"]  # 另两分支未触发
    kw = calls["update_event"][0]
    assert kw["ical_uid"] == "uid-1"
    assert kw["summary"] == "new title"
    assert kw["dtstart_utc"] == datetime(2026, 6, 1, 2, 0, tzinfo=timezone.utc)
    assert kw["rrule"] == ""
    assert kw["sequence_bump"] is False
    assert kw["attendees"] is None  # 缺席 = 保留原与会者
    assert kw["is_all_day"] is None  # 缺席 = 保持原全天状态


def test_update_occurrence_branch(cal_folder_client, monkeypatch):
    calls: dict = {}
    _patch_all_update_methods(monkeypatch, calls)

    r = cal_folder_client.patch("/api/calendar/events/uid-1", json={
        "recurrenceId": "2026-06-08T10:00:00+08:00",
        "location": "Room B",
    })
    assert r.status_code == 200
    assert list(calls.keys()) == ["update_occurrence"]
    kw = calls["update_occurrence"][0]
    assert kw["recurrence_id_utc"] == datetime(2026, 6, 8, 2, 0, tzinfo=timezone.utc)
    assert kw["location"] == "Room B"
    # occurrence override 分支不带 rrule/attendees/sequence_bump (CLI 同款忽略)。
    assert "rrule" not in kw and "attendees" not in kw and "sequence_bump" not in kw


def test_update_split_future_branch(cal_folder_client, monkeypatch):
    calls: dict = {}
    _patch_all_update_methods(monkeypatch, calls)

    r = cal_folder_client.patch("/api/calendar/events/uid-1", json={
        "recurrenceId": "2026-06-08T02:00:00Z",
        "splitFuture": True,
        "summary": "moved",
    })
    assert r.status_code == 200
    assert list(calls.keys()) == ["split_series"]
    kw = calls["split_series"][0]
    assert kw["split_recurrence_id_utc"] == datetime(2026, 6, 8, 2, 0, tzinfo=timezone.utc)
    assert kw["summary"] == "moved"


def test_update_attendees_three_state(cal_folder_client, monkeypatch):
    calls: dict = {}
    _patch_all_update_methods(monkeypatch, calls)

    # ① 空数组 = 不动 (None) — 逐字对齐 Electron runEventUpdate `opts.attendees || []`
    #    循环零次不传 --attendee; 清空必须走 clearAttendees。
    r = cal_folder_client.patch("/api/calendar/events/uid-1", json={"attendees": []})
    assert r.status_code == 200
    assert calls["update_event"][0]["attendees"] is None

    # ② clearAttendees=true → [] 显式清空。
    r = cal_folder_client.patch(
        "/api/calendar/events/uid-1", json={"clearAttendees": True}
    )
    assert r.status_code == 200
    assert calls["update_event"][1]["attendees"] == []

    # ③ 非空列表 → 整表替换。
    r = cal_folder_client.patch("/api/calendar/events/uid-1", json={
        "attendees": [{"email": "c@example.com", "name": "Carol"}],
    })
    assert r.status_code == 200
    assert calls["update_event"][2]["attendees"] == [
        {"email": "c@example.com", "name": "Carol"}
    ]


def test_update_clear_and_attendees_mutex_400(cal_folder_client):
    r = cal_folder_client.patch("/api/calendar/events/uid-1", json={
        "clearAttendees": True,
        "attendees": [{"email": "a@example.com"}],
    })
    assert r.status_code == 400
    _err(r.json(), code="E_INVALID_ARG")


def test_update_clear_with_recurrence_mutex_400(cal_folder_client):
    r = cal_folder_client.patch("/api/calendar/events/uid-1", json={
        "clearAttendees": True,
        "recurrenceId": "2026-06-08T02:00:00Z",
    })
    assert r.status_code == 400
    _err(r.json(), code="E_INVALID_ARG")


def test_update_not_found_404(cal_folder_client, monkeypatch):
    def missing(self, **kw):
        raise ValueError("event not found by UID: 'uid-x'")

    monkeypatch.setattr(CalendarService, "update_event", missing)
    r = cal_folder_client.patch("/api/calendar/events/uid-x", json={"summary": "y"})
    assert r.status_code == 404
    _err(r.json(), code="E_NOT_FOUND")


def test_update_caldav_fail_502(cal_folder_client, monkeypatch):
    def boom(self, **kw):
        raise RuntimeError("PUT 500")

    monkeypatch.setattr(CalendarService, "update_event", boom)
    r = cal_folder_client.patch("/api/calendar/events/uid-1", json={"summary": "y"})
    assert r.status_code == 502
    _err(r.json(), code="E_CALDAV")


# ===========================================================================
# DELETE /api/calendar/events/{uid}
# ===========================================================================


def test_delete_ok_passthrough(cal_folder_client, monkeypatch):
    captured: dict = {}

    def fake_delete(self, **kw):
        captured.update(kw)
        return {"action": "deleted", "ical_uid": kw["ical_uid"], "calendar_name": "Work"}

    monkeypatch.setattr(CalendarService, "delete_event", fake_delete)
    r = cal_folder_client.delete(
        "/api/calendar/events/uid-1", params={"calendarName": "Work"}
    )
    assert r.status_code == 200
    body = r.json()
    _ok(body)
    assert body["data"]["action"] == "deleted"
    assert captured == {"ical_uid": "uid-1", "calendar_name": "Work"}


def test_delete_not_found_404(cal_folder_client, monkeypatch):
    def missing(self, **kw):
        raise ValueError("event not found by UID: 'uid-x'")

    monkeypatch.setattr(CalendarService, "delete_event", missing)
    r = cal_folder_client.delete("/api/calendar/events/uid-x")
    assert r.status_code == 404
    _err(r.json(), code="E_NOT_FOUND")


# ===========================================================================
# POST /api/calendar/events/{uid}/rsvp
# ===========================================================================


def _fake_rsvp(captured: dict, *, preview: bool = False):
    def fake(self, **kw):
        captured.update(kw)
        out = {
            "action": "rsvp_dry_run" if kw.get("dry_run") else "rsvp_sent",
            "ical_uid": kw["ical_uid"],
            "recurrence_id": kw.get("recurrence_id"),
            "source": kw.get("source") or "caldav",
            "response_status": kw["response_status"],
            "to_email": "boss@example.com",
            "dry_run": bool(kw.get("dry_run")),
        }
        if preview:
            out["body_preview"] = "REPLY preview"
        return out
    return fake


def test_rsvp_accept_alias_passthrough(cal_folder_client, monkeypatch):
    captured: dict = {}
    monkeypatch.setattr(CalendarService, "send_rsvp", _fake_rsvp(captured))

    r = cal_folder_client.post("/api/calendar/events/uid-1/rsvp", json={
        "response": "accept",
        "recurrenceId": "2026-06-08T02:00:00Z",
        "source": "caldav",
    })
    assert r.status_code == 200
    body = r.json()
    _ok(body)
    # alias → PARTSTAT 值域 (RSVP_RESPONSE_ALIAS, CLI 同源)。
    assert captured["response_status"] == "ACCEPTED"
    assert captured["recurrence_id"] == "2026-06-08T02:00:00Z"
    assert captured["source"] == "caldav"
    assert captured["dry_run"] is False
    # data 形状 = CLI rsvp emit。
    assert body["data"]["response_status"] == "ACCEPTED"
    assert body["data"]["to_email"] == "boss@example.com"
    assert body["data"]["dry_run"] is False
    assert "body_preview" not in body["data"]


def test_rsvp_alias_case_insensitive(cal_folder_client, monkeypatch):
    captured: dict = {}
    monkeypatch.setattr(CalendarService, "send_rsvp", _fake_rsvp(captured))

    r = cal_folder_client.post(
        "/api/calendar/events/uid-1/rsvp", json={"response": "Maybe"}
    )
    assert r.status_code == 200
    assert captured["response_status"] == "TENTATIVE"

    r = cal_folder_client.post(
        "/api/calendar/events/uid-1/rsvp", json={"response": "NO"}
    )
    assert r.status_code == 200
    assert captured["response_status"] == "DECLINED"


def test_rsvp_bad_response_400(cal_folder_client):
    r = cal_folder_client.post(
        "/api/calendar/events/uid-1/rsvp", json={"response": "shrug"}
    )
    assert r.status_code == 400
    _err(r.json(), code="E_INVALID_ARG")


def test_rsvp_dry_run_preview(cal_folder_client, monkeypatch):
    captured: dict = {}
    monkeypatch.setattr(
        CalendarService, "send_rsvp", _fake_rsvp(captured, preview=True)
    )
    r = cal_folder_client.post("/api/calendar/events/uid-1/rsvp", json={
        "response": "decline", "dryRun": True,
    })
    assert r.status_code == 200
    assert captured["dry_run"] is True
    assert r.json()["data"]["body_preview"] == "REPLY preview"


def test_rsvp_not_found_404(cal_folder_client, monkeypatch):
    def missing(self, **kw):
        raise ValueError("calendar_event not found: ical_uid='uid-x'")

    monkeypatch.setattr(CalendarService, "send_rsvp", missing)
    r = cal_folder_client.post(
        "/api/calendar/events/uid-x/rsvp", json={"response": "accept"}
    )
    assert r.status_code == 404
    _err(r.json(), code="E_NOT_FOUND")


def test_rsvp_smtp_fail_502_upstream(cal_folder_client, monkeypatch):
    import smtplib

    def boom(self, **kw):
        raise smtplib.SMTPException("SMTP 1025 refused")

    monkeypatch.setattr(CalendarService, "send_rsvp", boom)
    r = cal_folder_client.post(
        "/api/calendar/events/uid-1/rsvp", json={"response": "accept"}
    )
    assert r.status_code == 502
    _err(r.json(), code="E_UPSTREAM")


# ===========================================================================
# POST /api/calendar/events/{uid}/replay
# ===========================================================================


def test_replay_param_passthrough(cal_folder_client, monkeypatch):
    captured: dict = {}

    def fake_replay(self, **kw):
        captured.update(kw)
        return {"action": "updated", "page_id": "pg-1", "ical_uid": kw["ical_uid"],
                "recurrence_id": None, "source": "caldav", "dry_run": False}

    monkeypatch.setattr(CalendarService, "replay_event_to_notion", fake_replay)
    r = cal_folder_client.post("/api/calendar/events/uid-1/replay", json={
        "source": "caldav",
    })
    assert r.status_code == 200
    body = r.json()
    _ok(body)
    assert body["data"]["page_id"] == "pg-1"
    assert captured == {
        "ical_uid": "uid-1", "recurrence_id": None,
        "source": "caldav", "dry_run": False,
    }


def test_replay_not_found_404(cal_folder_client, monkeypatch):
    def missing(self, **kw):
        raise ValueError("calendar_event not found: ical_uid='uid-x'")

    monkeypatch.setattr(CalendarService, "replay_event_to_notion", missing)
    r = cal_folder_client.post("/api/calendar/events/uid-x/replay", json={})
    assert r.status_code == 404
    _err(r.json(), code="E_NOT_FOUND")


def test_replay_upstream_fail_502(cal_folder_client, monkeypatch):
    def boom(self, **kw):
        raise RuntimeError("notion 503")

    monkeypatch.setattr(CalendarService, "replay_event_to_notion", boom)
    r = cal_folder_client.post("/api/calendar/events/uid-1/replay", json={})
    assert r.status_code == 502
    _err(r.json(), code="E_UPSTREAM")


# ===========================================================================
# 鉴权拒绝 — AUTH_DISABLED off + 无 JWT/本地 token → 五写端点全 401
# ===========================================================================


def test_write_endpoints_reject_unauthenticated(cal_folder_client, monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)

    reqs = [
        ("post", "/api/calendar/events", {"summary": "x"}),
        ("patch", "/api/calendar/events/uid-1", {"summary": "x"}),
        ("delete", "/api/calendar/events/uid-1", None),
        ("post", "/api/calendar/events/uid-1/rsvp", {"response": "accept"}),
        ("post", "/api/calendar/events/uid-1/replay", {}),
    ]
    for method, path, payload in reqs:
        kwargs = {"json": payload} if payload is not None else {}
        r = getattr(cal_folder_client, method)(path, **kwargs)
        assert r.status_code == 401, f"{method.upper()} {path} → {r.status_code}"
