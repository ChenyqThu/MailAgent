"""Phase 2.1 iTIP REPLY 构造 + SMTP 发送单测.

覆盖:
- ``_escape_text`` RFC 5545 §3.3.11 TEXT escape (backslash/semicolon/comma/newline)
- ``_fmt_utc`` naive datetime 视为 UTC + aware datetime 转 UTC
- ``build_itip_reply``:
  · 三态 PARTSTAT (ACCEPTED/TENTATIVE/DECLINED) 正确出现
  · CN parameter 加引号 + 嵌套引号去掉
  · recurrence_id 非空 → 加 RECURRENCE-ID 行
  · invalid response_status / empty ical_uid / empty organizer → ValueError
  · 包含 RFC 5546 必填字段 (METHOD:REPLY / VERSION:2.0 / UID / DTSTAMP / SEQUENCE)
  · line endings CRLF
- ``send_itip_reply_smtp`` mock smtplib: 验 login + send_message 调用 + Content-Type
"""
from __future__ import annotations

from datetime import datetime, timezone
from email.message import Message
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from src.calendar_sync.itip_reply import (
    VALID_RESPONSE_STATUS,
    _escape_text,
    _fmt_utc,
    build_itip_reply,
    send_itip_reply_smtp,
)


# ---------------------------------------------------------------------------
# _escape_text — RFC 5545 §3.3.11
# ---------------------------------------------------------------------------

def test_escape_text_backslash_first():
    """backslash 必须先 escape, 否则后续替换会双重 escape."""
    assert _escape_text("a\\b") == "a\\\\b"


def test_escape_text_semicolon():
    assert _escape_text("foo;bar") == "foo\\;bar"


def test_escape_text_comma():
    assert _escape_text("a,b,c") == "a\\,b\\,c"


def test_escape_text_newline_becomes_literal_backslash_n():
    assert _escape_text("line1\nline2") == "line1\\nline2"


def test_escape_text_crlf_drops_cr():
    """RFC 5545 行尾 \\r\\n, 但 SUMMARY 内部禁用裸 CR — 去掉避免破坏 fold."""
    assert _escape_text("line1\r\nline2") == "line1\\nline2"


def test_escape_text_combined():
    out = _escape_text("a\\b;c,d\ne")
    assert out == "a\\\\b\\;c\\,d\\ne"


def test_escape_text_no_change_for_plain():
    assert _escape_text("Team Sync 2026") == "Team Sync 2026"


# ---------------------------------------------------------------------------
# _fmt_utc
# ---------------------------------------------------------------------------

def test_fmt_utc_naive_datetime_treated_as_utc():
    dt = datetime(2026, 5, 23, 14, 30, 0)
    assert _fmt_utc(dt) == "20260523T143000Z"


def test_fmt_utc_aware_utc_datetime():
    dt = datetime(2026, 5, 23, 14, 30, 0, tzinfo=timezone.utc)
    assert _fmt_utc(dt) == "20260523T143000Z"


def test_fmt_utc_converts_non_utc_to_utc():
    from datetime import timedelta
    tz_plus8 = timezone(timedelta(hours=8))
    dt = datetime(2026, 5, 23, 22, 30, 0, tzinfo=tz_plus8)  # = 14:30 UTC
    assert _fmt_utc(dt) == "20260523T143000Z"


# ---------------------------------------------------------------------------
# build_itip_reply — validation
# ---------------------------------------------------------------------------

def _base_args() -> dict:
    return dict(
        ical_uid="uid-abc-123",
        sequence=0,
        dtstart_utc=datetime(2026, 5, 23, 14, 0, tzinfo=timezone.utc),
        dtend_utc=datetime(2026, 5, 23, 15, 0, tzinfo=timezone.utc),
        summary="Team Sync",
        organizer_email="alice@example.com",
        attendee_email="bob@example.com",
        attendee_name="Bob",
        response_status="ACCEPTED",
        now_utc=datetime(2026, 5, 23, 13, 59, 30, tzinfo=timezone.utc),
    )


def test_build_invalid_response_status_raises():
    args = _base_args()
    args["response_status"] = "MAYBE"
    with pytest.raises(ValueError, match="response_status must be one of"):
        build_itip_reply(**args)


def test_build_empty_ical_uid_raises():
    args = _base_args()
    args["ical_uid"] = "  "
    with pytest.raises(ValueError, match="ical_uid is required"):
        build_itip_reply(**args)


def test_build_empty_organizer_email_raises():
    args = _base_args()
    args["organizer_email"] = ""
    with pytest.raises(ValueError, match="organizer_email is required"):
        build_itip_reply(**args)


def test_build_empty_attendee_email_raises():
    args = _base_args()
    args["attendee_email"] = ""
    with pytest.raises(ValueError, match="attendee_email is required"):
        build_itip_reply(**args)


# ---------------------------------------------------------------------------
# build_itip_reply — output content
# ---------------------------------------------------------------------------

def test_build_contains_required_rfc5546_fields():
    body = build_itip_reply(**_base_args())
    assert "BEGIN:VCALENDAR\r\n" in body
    assert "METHOD:REPLY\r\n" in body
    assert "VERSION:2.0\r\n" in body
    assert "BEGIN:VEVENT\r\n" in body
    assert "END:VEVENT\r\n" in body
    assert "END:VCALENDAR\r\n" in body
    assert "UID:uid-abc-123\r\n" in body
    assert "SEQUENCE:0\r\n" in body
    assert "DTSTAMP:20260523T135930Z\r\n" in body
    assert "DTSTART:20260523T140000Z\r\n" in body
    assert "DTEND:20260523T150000Z\r\n" in body
    assert "SUMMARY:Team Sync\r\n" in body
    assert "ORGANIZER:mailto:alice@example.com\r\n" in body


def test_build_partstat_accepted():
    body = build_itip_reply(**_base_args())
    assert "ATTENDEE;PARTSTAT=ACCEPTED;CN=\"Bob\":mailto:bob@example.com\r\n" in body


def test_build_partstat_tentative():
    args = _base_args()
    args["response_status"] = "TENTATIVE"
    body = build_itip_reply(**args)
    assert "PARTSTAT=TENTATIVE" in body
    assert "PARTSTAT=ACCEPTED" not in body


def test_build_partstat_declined():
    args = _base_args()
    args["response_status"] = "DECLINED"
    body = build_itip_reply(**args)
    assert "PARTSTAT=DECLINED" in body


def test_build_cn_param_with_name():
    body = build_itip_reply(**_base_args())
    assert ';CN="Bob"' in body


def test_build_no_cn_when_name_empty():
    args = _base_args()
    args["attendee_name"] = None
    body = build_itip_reply(**args)
    assert "CN=" not in body
    assert "ATTENDEE;PARTSTAT=ACCEPTED:mailto:bob@example.com" in body


def test_build_cn_strips_embedded_quotes():
    args = _base_args()
    args["attendee_name"] = 'Bob "the Builder"'
    body = build_itip_reply(**args)
    # 内嵌 " 被去掉, 不破坏 CN="..." 包裹
    assert ';CN="Bob the Builder"' in body


def test_build_recurrence_id_when_passed():
    args = _base_args()
    args["recurrence_id_utc"] = datetime(2026, 5, 30, 14, 0, tzinfo=timezone.utc)
    body = build_itip_reply(**args)
    assert "RECURRENCE-ID:20260530T140000Z" in body


def test_build_no_recurrence_id_for_master():
    body = build_itip_reply(**_base_args())
    assert "RECURRENCE-ID" not in body


def test_build_summary_escapes_special_chars():
    args = _base_args()
    args["summary"] = "Q1 plan; revised, v2\nfollow-up"
    body = build_itip_reply(**args)
    # 各个特殊字符都已 escape
    assert "SUMMARY:Q1 plan\\; revised\\, v2\\nfollow-up\r\n" in body


def test_build_uses_crlf_line_endings():
    body = build_itip_reply(**_base_args())
    # 不能含裸 \n (must be \r\n)
    lines = body.split("\r\n")
    assert lines[0] == "BEGIN:VCALENDAR"
    assert lines[-2] == "END:VCALENDAR"  # 末尾 trailing \r\n 后是空 string


def test_build_sequence_passes_through():
    args = _base_args()
    args["sequence"] = 5
    body = build_itip_reply(**args)
    assert "SEQUENCE:5\r\n" in body


def test_valid_response_status_constant():
    """挂载常量供调用方校验; 应该跟 build 内部白名单一致."""
    assert VALID_RESPONSE_STATUS == ("ACCEPTED", "TENTATIVE", "DECLINED")


# ---------------------------------------------------------------------------
# send_itip_reply_smtp — mock smtplib
# ---------------------------------------------------------------------------

def _mock_cfg(**overrides) -> SimpleNamespace:
    defaults = dict(
        user_email="bob@example.com",
        davmail_imap_host="127.0.0.1",
        davmail_smtp_port=1025,
        davmail_cipher_key="test-cipher-key",
        davmail_poc_mode=False,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def test_send_itip_smtp_calls_login_and_send():
    cfg = _mock_cfg()
    body = "BEGIN:VCALENDAR\r\nFOO\r\nEND:VCALENDAR\r\n"
    mock_smtp = MagicMock()
    with patch("src.calendar_sync.itip_reply.smtplib.SMTP") as ctor:
        ctor.return_value.__enter__.return_value = mock_smtp
        send_itip_reply_smtp(
            cfg, ical_body=body, to_email="alice@example.com",
            subject="Accepted: Team Sync",
        )
    # SMTP 构造用 host:port
    ctor.assert_called_once_with("127.0.0.1", 1025, timeout=30)
    mock_smtp.login.assert_called_once_with("bob@example.com", "test-cipher-key")
    mock_smtp.send_message.assert_called_once()
    sent_msg: Message = mock_smtp.send_message.call_args.args[0]
    assert sent_msg["Subject"] == "Accepted: Team Sync"
    assert sent_msg["To"] == "alice@example.com"
    assert sent_msg["From"] == "bob@example.com"
    ct = sent_msg.get_content_type()
    assert ct == "text/calendar"
    assert sent_msg.get_param("method") == "REPLY"


def test_send_itip_smtp_missing_user_email_raises():
    cfg = _mock_cfg(user_email="")
    with pytest.raises(ValueError, match="from_email / cfg.user_email is required"):
        send_itip_reply_smtp(
            cfg, ical_body="x", to_email="a@b.com", subject="s",
        )


def test_send_itip_smtp_missing_cipher_key_raises():
    """get_cipher_key 在 davmail_cipher_key 空 + poc_mode 关时 raise
    DavMailConnectionError, send_itip_reply_smtp 让它原样抛 (CLI 层映射)."""
    from src.mail.backend.imap_client import DavMailConnectionError

    cfg = _mock_cfg(davmail_cipher_key="", davmail_poc_mode=False)
    with pytest.raises(DavMailConnectionError, match="DAVMAIL_CIPHER_KEY required"):
        send_itip_reply_smtp(
            cfg, ical_body="x", to_email="a@b.com", subject="s",
        )


def test_send_itip_smtp_from_name_formats_display_name():
    cfg = _mock_cfg()
    mock_smtp = MagicMock()
    with patch("src.calendar_sync.itip_reply.smtplib.SMTP") as ctor:
        ctor.return_value.__enter__.return_value = mock_smtp
        send_itip_reply_smtp(
            cfg, ical_body="x", to_email="a@b.com", subject="s",
            from_name="Bob the Builder",
        )
    sent_msg = mock_smtp.send_message.call_args.args[0]
    assert sent_msg["From"] == "Bob the Builder <bob@example.com>"
