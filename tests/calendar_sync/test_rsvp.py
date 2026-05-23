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

from src.calendar_sync.rsvp import _extract_organizer_email, send_rsvp


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
    row = _make_row(organizer="")
    repo = MagicMock()
    repo.get_by_ical_uid.return_value = row
    cfg = _mock_cfg()
    with pytest.raises(ValueError, match="organizer email missing"):
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
