"""Phase 2.1 RSVP orchestration 单测.

覆盖:
- ``_extract_organizer_email`` mailto: 剥 / plain email / empty / 非 email 字段
- ``send_rsvp``:
  · happy path (caldav source 命中 → build → SMTP → update_response_status)
  · source=None 自动 fallback caldav → email_ics
  · source 显式不 fallback (找不到 raise)
  · invalid response_status → ValueError
  · row not found → ValueError (listing sources tried)
  · organizer 字段空 → ValueError
  · organizer 不像 email → ValueError
  · dry_run → 不发 SMTP, 返 body_preview
  · update_response_status 失败 → 仅 warning, 不抛
  · recurrence_id 透传给 build_itip_reply
"""
from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from src.calendar_sync.rsvp import (
    _extract_organizer_email,
    _parse_recurrence_id,
    send_rsvp,
)


# ---------------------------------------------------------------------------
# _extract_organizer_email
# ---------------------------------------------------------------------------

def test_extract_mailto_prefix():
    assert _extract_organizer_email("mailto:alice@example.com") == "alice@example.com"


def test_extract_mailto_uppercase_prefix():
    assert _extract_organizer_email("MAILTO:bob@example.com") == "bob@example.com"


def test_extract_plain_email():
    assert _extract_organizer_email("carol@example.com") == "carol@example.com"


def test_extract_empty_returns_none():
    assert _extract_organizer_email("") is None


def test_extract_whitespace_returns_none():
    assert _extract_organizer_email("   ") is None


def test_extract_non_email_returns_none():
    """会议室名 / 显示名等非 email 字段 → None (RSVP 拒绝)."""
    assert _extract_organizer_email("Conference Room A") is None


# ---------------------------------------------------------------------------
# send_rsvp fixtures
# ---------------------------------------------------------------------------

def _make_row(
    *,
    id_=1,
    ical_uid="uid-test",
    recurrence_id=None,
    summary="Team Sync",
    organizer="alice@example.com",
    source="caldav",
    sequence=0,
):
    return SimpleNamespace(
        id=id_,
        ical_uid=ical_uid,
        recurrence_id=recurrence_id,
        sequence=sequence,
        calendar_name="日历",
        summary=summary,
        description="",
        location="",
        organizer=organizer,
        attendees=[],
        dtstart_utc=datetime(2026, 5, 23, 14, 0, tzinfo=timezone.utc),
        dtend_utc=datetime(2026, 5, 23, 15, 0, tzinfo=timezone.utc),
        is_all_day=False,
        rrule="",
        exdates=[],
        rdates=[],
        status="CONFIRMED",
        response_status="NEEDS-ACTION",
        url="",
        ics_raw="",
        source=source,
        notion_page_id=None,
        related_email_internal_id=None,
        last_synced_at=datetime.now(timezone.utc),
        deleted_at=None,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )


def _mock_cfg():
    return SimpleNamespace(
        user_email="bob@example.com",
        davmail_imap_host="127.0.0.1",
        davmail_smtp_port=1025,
        davmail_cipher_key="test-key",
        davmail_poc_mode=False,
    )


# ---------------------------------------------------------------------------
# send_rsvp — validation
# ---------------------------------------------------------------------------

def test_send_rsvp_invalid_response_status_raises():
    repo = MagicMock()
    cfg = _mock_cfg()
    with pytest.raises(ValueError, match="response_status must be one of"):
        send_rsvp(repo, cfg, ical_uid="x", response_status="MAYBE")


def test_send_rsvp_row_not_found_raises_lists_sources():
    repo = MagicMock()
    repo.get_by_ical_uid.return_value = None
    cfg = _mock_cfg()
    with pytest.raises(ValueError, match="not found"):
        send_rsvp(repo, cfg, ical_uid="ghost", response_status="ACCEPTED")


def test_send_rsvp_organizer_empty_raises():
    """task 07-15 问题2 — 空 organizer 入口显式拒绝, 专用文案。

    文案不得含 'not found'/'missing' — serve-api / CLI 的 ValueError 分流按
    这两个词映射 404 / CliNotFoundError, 空 organizer 必须走 400 E_INVALID_ARG。
    """
    row = _make_row(organizer="")
    repo = MagicMock()
    repo.get_by_ical_uid.return_value = row
    cfg = _mock_cfg()
    with pytest.raises(ValueError) as ei:
        send_rsvp(repo, cfg, ical_uid="x", response_status="ACCEPTED")
    msg = str(ei.value)
    assert "事件无组织者" in msg
    assert "missing" not in msg.lower()
    assert "not found" not in msg


def test_send_rsvp_organizer_whitespace_raises_same():
    row = _make_row(organizer="   ")
    repo = MagicMock()
    repo.get_by_ical_uid.return_value = row
    cfg = _mock_cfg()
    with pytest.raises(ValueError, match="事件无组织者"):
        send_rsvp(repo, cfg, ical_uid="x", response_status="ACCEPTED")


def test_send_rsvp_organizer_not_email_raises():
    row = _make_row(organizer="Conference Room A")
    repo = MagicMock()
    repo.get_by_ical_uid.return_value = row
    cfg = _mock_cfg()
    with pytest.raises(ValueError, match="organizer email missing"):
        send_rsvp(repo, cfg, ical_uid="x", response_status="ACCEPTED")


# ---------------------------------------------------------------------------
# send_rsvp — happy paths
# ---------------------------------------------------------------------------

def test_send_rsvp_happy_path_caldav_source():
    row = _make_row(source="caldav", organizer="alice@example.com")
    repo = MagicMock()
    repo.get_by_ical_uid.return_value = row
    repo.update_response_status = MagicMock()
    cfg = _mock_cfg()
    with patch("src.calendar_sync.rsvp.send_itip_reply_smtp") as smtp_mock:
        result = send_rsvp(
            repo, cfg, ical_uid="uid-test", response_status="ACCEPTED",
        )

    assert result["action"] == "sent"
    assert result["dry_run"] is False
    assert result["to_email"] == "alice@example.com"
    assert result["source"] == "caldav"
    assert result["response_status"] == "ACCEPTED"

    smtp_mock.assert_called_once()
    call_kwargs = smtp_mock.call_args.kwargs
    assert call_kwargs["to_email"] == "alice@example.com"
    assert call_kwargs["subject"].startswith("Accepted:")
    assert "Team Sync" in call_kwargs["subject"]
    assert "BEGIN:VCALENDAR" in call_kwargs["ical_body"]
    assert "METHOD:REPLY" in call_kwargs["ical_body"]
    assert "PARTSTAT=ACCEPTED" in call_kwargs["ical_body"]

    repo.update_response_status.assert_called_once_with(row.id, "ACCEPTED")


def test_send_rsvp_source_none_falls_back_caldav_to_email_ics():
    row = _make_row(source="email_ics")
    repo = MagicMock()
    repo.get_by_ical_uid.side_effect = lambda ical_uid, source, recurrence_id: (
        row if source == "email_ics" else None
    )
    cfg = _mock_cfg()
    with patch("src.calendar_sync.rsvp.send_itip_reply_smtp"):
        result = send_rsvp(repo, cfg, ical_uid="x", response_status="TENTATIVE")

    assert result["source"] == "email_ics"
    sources_queried = [c.kwargs["source"] for c in repo.get_by_ical_uid.call_args_list]
    assert sources_queried == ["caldav", "email_ics"]


def test_send_rsvp_explicit_source_does_not_fallback():
    repo = MagicMock()
    repo.get_by_ical_uid.return_value = None  # caldav miss
    cfg = _mock_cfg()
    with pytest.raises(ValueError, match="not found"):
        send_rsvp(
            repo, cfg, ical_uid="missing",
            response_status="DECLINED", source="caldav",
        )
    assert repo.get_by_ical_uid.call_count == 1


def test_send_rsvp_dry_run_skips_smtp_returns_body_preview():
    row = _make_row()
    repo = MagicMock()
    repo.get_by_ical_uid.return_value = row
    cfg = _mock_cfg()
    with patch("src.calendar_sync.rsvp.send_itip_reply_smtp") as smtp_mock:
        result = send_rsvp(
            repo, cfg, ical_uid="x", response_status="ACCEPTED", dry_run=True,
        )

    assert result["action"] == "would_send"
    assert result["dry_run"] is True
    assert "body_preview" in result
    assert "BEGIN:VCALENDAR" in result["body_preview"]
    smtp_mock.assert_not_called()
    repo.update_response_status.assert_not_called()


def test_send_rsvp_strips_mailto_prefix_from_organizer():
    row = _make_row(organizer="mailto:alice@example.com")
    repo = MagicMock()
    repo.get_by_ical_uid.return_value = row
    cfg = _mock_cfg()
    with patch("src.calendar_sync.rsvp.send_itip_reply_smtp") as smtp_mock:
        result = send_rsvp(repo, cfg, ical_uid="x", response_status="ACCEPTED")
    # to_email 已剥 mailto: 前缀
    assert result["to_email"] == "alice@example.com"
    assert smtp_mock.call_args.kwargs["to_email"] == "alice@example.com"


def test_send_rsvp_recurrence_id_threaded_through():
    """recurrence_id 应该:
    1. 传给 repo.get_by_ical_uid 找 instance row
    2. 因为 row.recurrence_id 非空, build_itip_reply 加 RECURRENCE-ID 行
    """
    row = _make_row(recurrence_id="2026-05-30T10:00:00+00:00")
    repo = MagicMock()
    repo.get_by_ical_uid.return_value = row
    cfg = _mock_cfg()
    with patch("src.calendar_sync.rsvp.send_itip_reply_smtp") as smtp_mock:
        result = send_rsvp(
            repo, cfg, ical_uid="x", response_status="ACCEPTED",
            recurrence_id="2026-05-30T10:00:00+00:00",
        )
    assert result["recurrence_id"] == "2026-05-30T10:00:00+00:00"
    repo.get_by_ical_uid.assert_called_with(
        "x", source="caldav", recurrence_id="2026-05-30T10:00:00+00:00",
    )
    body = smtp_mock.call_args.kwargs["ical_body"]
    assert "RECURRENCE-ID:20260530T100000Z" in body


def test_send_rsvp_update_response_status_failure_does_not_raise():
    """SQLite 写炸时仅 warning — SMTP 已发, 服务端会异步反映."""
    row = _make_row()
    repo = MagicMock()
    repo.get_by_ical_uid.return_value = row
    repo.update_response_status.side_effect = RuntimeError("db locked")
    cfg = _mock_cfg()
    with patch("src.calendar_sync.rsvp.send_itip_reply_smtp"):
        result = send_rsvp(repo, cfg, ical_uid="x", response_status="DECLINED")
    assert result["action"] == "sent"
    assert result["response_status"] == "DECLINED"


# ---------------------------------------------------------------------------
# Phase 3 §P1-e — organizer freshness check (source='email_ics' only)
# ---------------------------------------------------------------------------

class TestOrganizerFreshness:
    """Phase 3 §P1-e: source='email_ics' 时检查 organizer 信息是否 stale.

    caldav row 实时从 Outlook 拉, 永远 fresh; email_ics row 来自原邮件解析快照,
    原邮件被删 / dead_letter 时 row.organizer 可能 stale.
    """

    def test_caldav_source_returns_no_warning(self):
        """source='caldav' 跳过检查, 不返 warning."""
        row = _make_row(source="caldav", organizer="alice@example.com")
        repo = MagicMock()
        repo.get_by_ical_uid.return_value = row
        cfg = _mock_cfg()
        with patch("src.calendar_sync.rsvp.send_itip_reply_smtp"):
            result = send_rsvp(repo, cfg, ical_uid="x", response_status="ACCEPTED")
        assert "organizer_freshness_warning" not in result

    def test_email_ics_no_related_internal_id_no_warning(self):
        """source='email_ics' 但 related_email_internal_id=None → 无法 check, 不警告."""
        row = _make_row(
            source="email_ics", organizer="alice@example.com",
        )
        # related_email_internal_id defaults None in _make_row
        repo = MagicMock()
        repo.get_by_ical_uid.return_value = row
        cfg = _mock_cfg()
        with patch("src.calendar_sync.rsvp.send_itip_reply_smtp"):
            result = send_rsvp(repo, cfg, ical_uid="x", response_status="ACCEPTED")
        assert "organizer_freshness_warning" not in result

    def test_email_ics_source_email_missing_warns(self, repo, make_event):
        """email_ics row 的 related_email_internal_id 在 email_metadata 没找到 → warning."""
        from src.calendar_sync.rsvp import send_rsvp as real_send_rsvp

        ev = make_event(uid="freshness-test", summary="Stale invite")
        # 强制写 organizer + related_internal_id (没真邮件 row 在 email_metadata)
        eid = repo.upsert_from_caldav_event(
            ev, source="email_ics", related_email_internal_id=999999,
        )
        # 更新 organizer 字段
        with repo._conn_ctx() as conn:
            conn.execute(
                "UPDATE calendar_event SET organizer = ? WHERE id = ?",
                ("missing@example.com", eid),
            )
            conn.commit()

        cfg = _mock_cfg()
        with patch("src.calendar_sync.rsvp.send_itip_reply_smtp"):
            result = real_send_rsvp(
                repo, cfg,
                ical_uid="freshness-test",
                response_status="ACCEPTED",
                source="email_ics",
            )
        assert "organizer_freshness_warning" in result
        warning = result["organizer_freshness_warning"]
        assert "999999" in warning
        assert "stale" in warning.lower() or "stale" in warning

    def test_email_ics_source_email_present_no_warning(
        self, repo, make_event, fresh_db,
    ):
        """related_email_internal_id 存在 email_metadata + sync_status正常 → 无警告."""
        from src.calendar_sync.rsvp import send_rsvp as real_send_rsvp
        import sqlite3 as _sql

        ev = make_event(uid="fresh-invite", summary="Fresh invite")
        eid = repo.upsert_from_caldav_event(
            ev, source="email_ics", related_email_internal_id=12345,
        )
        with repo._conn_ctx() as conn:
            conn.execute(
                "UPDATE calendar_event SET organizer = ? WHERE id = ?",
                ("alice@example.com", eid),
            )
            conn.commit()

        # 插一行 email_metadata (绕过 ORM, 直 SQL)
        conn = _sql.connect(fresh_db)
        try:
            conn.execute(
                "INSERT INTO email_metadata (internal_id, sync_status, mailbox) "
                "VALUES (?, 'synced', 'INBOX')",
                (12345,),
            )
            conn.commit()
        finally:
            conn.close()

        cfg = _mock_cfg()
        with patch("src.calendar_sync.rsvp.send_itip_reply_smtp"):
            result = real_send_rsvp(
                repo, cfg, ical_uid="fresh-invite",
                response_status="DECLINED", source="email_ics",
            )
        assert "organizer_freshness_warning" not in result

    def test_email_ics_source_email_dead_letter_warns(
        self, repo, make_event, fresh_db,
    ):
        """related_email_internal_id 在 email_metadata 但 sync_status='dead_letter' → warning."""
        from src.calendar_sync.rsvp import send_rsvp as real_send_rsvp
        import sqlite3 as _sql

        ev = make_event(uid="dead-invite", summary="Dead invite")
        eid = repo.upsert_from_caldav_event(
            ev, source="email_ics", related_email_internal_id=54321,
        )
        with repo._conn_ctx() as conn:
            conn.execute(
                "UPDATE calendar_event SET organizer = ? WHERE id = ?",
                ("bob@example.com", eid),
            )
            conn.commit()

        conn = _sql.connect(fresh_db)
        try:
            conn.execute(
                "INSERT INTO email_metadata (internal_id, sync_status, mailbox) "
                "VALUES (?, 'dead_letter', 'INBOX')",
                (54321,),
            )
            conn.commit()
        finally:
            conn.close()

        cfg = _mock_cfg()
        with patch("src.calendar_sync.rsvp.send_itip_reply_smtp"):
            result = real_send_rsvp(
                repo, cfg, ical_uid="dead-invite",
                response_status="TENTATIVE", source="email_ics",
            )
        assert "organizer_freshness_warning" in result
        assert "dead_letter" in result["organizer_freshness_warning"]


def test_send_rsvp_smtp_failure_propagates():
    """SMTP 抛 → caller 接 (不 catch in send_rsvp)."""
    import smtplib
    row = _make_row()
    repo = MagicMock()
    repo.get_by_ical_uid.return_value = row
    cfg = _mock_cfg()
    with patch(
        "src.calendar_sync.rsvp.send_itip_reply_smtp",
        side_effect=smtplib.SMTPException("server rejected"),
    ):
        with pytest.raises(smtplib.SMTPException, match="server rejected"):
            send_rsvp(repo, cfg, ical_uid="x", response_status="ACCEPTED")
    # SMTP fail 后不应回写 response_status
    repo.update_response_status.assert_not_called()


# ---------------------------------------------------------------------------
# _parse_recurrence_id — Critical fix: 多种 RFC 5545 格式 + 解析失败 fallback
# ---------------------------------------------------------------------------

def test_parse_recurrence_id_iso_with_tz():
    """``caldav_reader.py`` 写入的标准 ISO + tz 格式 → datetime."""
    d = _parse_recurrence_id("2026-05-30T14:00:00+00:00")
    assert d == datetime(2026, 5, 30, 14, 0, 0, tzinfo=timezone.utc)


def test_parse_recurrence_id_iso_with_z_suffix():
    """``Z`` 后缀 (Python 3.11+ fromisoformat 支持, 更老 fall back compat)."""
    d = _parse_recurrence_id("2026-05-30T14:00:00Z")
    assert d == datetime(2026, 5, 30, 14, 0, 0, tzinfo=timezone.utc)


def test_parse_recurrence_id_iso_no_tz_defaults_utc():
    """无 tz ISO → 视作 UTC (避免歧义)."""
    d = _parse_recurrence_id("2026-05-30T14:00:00")
    assert d == datetime(2026, 5, 30, 14, 0, 0, tzinfo=timezone.utc)


def test_parse_recurrence_id_iso_date_only():
    """ISO DATE-only (``2026-05-30``) → UTC 00:00."""
    d = _parse_recurrence_id("2026-05-30")
    assert d == datetime(2026, 5, 30, 0, 0, 0, tzinfo=timezone.utc)


def test_parse_recurrence_id_compact_datetime_utc():
    """RFC 5545 compact ``20260530T140000Z`` → datetime."""
    d = _parse_recurrence_id("20260530T140000Z")
    assert d == datetime(2026, 5, 30, 14, 0, 0, tzinfo=timezone.utc)


def test_parse_recurrence_id_compact_datetime_naive():
    """Compact naive ``20260530T140000`` → 视作 UTC."""
    d = _parse_recurrence_id("20260530T140000")
    assert d == datetime(2026, 5, 30, 14, 0, 0, tzinfo=timezone.utc)


def test_parse_recurrence_id_compact_date_only():
    """Compact DATE ``20260530`` → UTC 00:00 — 这是 Critical fix 修复的关键
    格式, 老代码 ``datetime.fromisoformat`` 直接抛 ValueError 崩溃 RSVP."""
    d = _parse_recurrence_id("20260530")
    assert d == datetime(2026, 5, 30, 0, 0, 0, tzinfo=timezone.utc)


def test_parse_recurrence_id_empty_returns_none():
    assert _parse_recurrence_id("") is None
    assert _parse_recurrence_id(None) is None
    assert _parse_recurrence_id("   ") is None


def test_parse_recurrence_id_invalid_returns_none_no_raise():
    """非法格式 → None + warning log, 不抛异常 (RSVP 应 fallback 整系列)."""
    assert _parse_recurrence_id("not-a-date") is None
    assert _parse_recurrence_id("2026/05/30") is None  # 错的分隔符
    assert _parse_recurrence_id("xxxxxxxx") is None


def test_send_rsvp_with_unparseable_recurrence_id_does_not_raise():
    """关键修复: row.recurrence_id 是垃圾 (e.g. TZID 前缀奇怪格式) 时,
    RSVP 应 fallback 整系列 REPLY (recurrence_id_utc=None), 不能崩溃."""
    row = _make_row(recurrence_id="TZID=Asia/Shanghai:20260530T140000")  # 奇怪格式
    repo = MagicMock()
    repo.get_by_ical_uid.return_value = row
    cfg = _mock_cfg()
    with patch("src.calendar_sync.rsvp.send_itip_reply_smtp") as smtp_mock, \
         patch("src.calendar_sync.rsvp.build_itip_reply", return_value="BEGIN:VCALENDAR\nEND:VCALENDAR") as build_mock:
        result = send_rsvp(repo, cfg, ical_uid="x", response_status="ACCEPTED")
    assert result["action"] == "sent"
    # 关键断言: build_itip_reply 收到 recurrence_id_utc=None (fallback 整系列)
    assert build_mock.call_args.kwargs["recurrence_id_utc"] is None
    smtp_mock.assert_called_once()
