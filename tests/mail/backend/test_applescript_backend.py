"""AppleScriptBackend wrapper tests — mock arm + radar, verify protocol mapping."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from src.mail.backend import IMailBackend
from src.mail.backend.applescript_backend import AppleScriptBackend


class _MockConfig:
    sync_mailboxes = "收件箱,发件箱"
    mail_account_name = "Exchange"
    mail_inbox_name = "收件箱"
    mail_account_url_prefix = "ews://"


@pytest.fixture
def cfg():
    return _MockConfig()


@pytest.fixture
def backend(cfg):
    """Constructor 内 import arm + radar — 用 patch 避开实际 Mail.app 依赖."""
    with patch("src.mail.backend.applescript_backend.AppleScriptArm") as MArm, \
         patch("src.mail.backend.applescript_backend.SQLiteRadar") as MRadar:
        # 让 MArm()._stats 字典可用
        MArm.return_value._stats = {"applescript_calls": 0}
        b = AppleScriptBackend(cfg)
    return b


def test_satisfies_protocol(backend):
    assert isinstance(backend, IMailBackend)
    assert backend.backend_origin == "applescript"


def test_probe_radar_unavailable(backend):
    backend.radar.is_available.return_value = False
    ok, detail = backend.probe_readiness()
    assert ok is False
    assert "Envelope Index unreadable" in detail


def test_probe_radar_available(backend):
    backend.radar.is_available.return_value = True
    backend.radar.get_current_max_row_id.return_value = 12345
    ok, detail = backend.probe_readiness()
    assert ok is True
    assert "max_row_id=12345" in detail


def test_detect_new_emails_baseline(backend):
    backend.radar.get_current_max_row_id.return_value = 999
    tick = backend.detect_new_emails(None)
    assert tick.has_new is False
    assert tick.current_marker == 999


def test_detect_new_emails_has_new(backend):
    backend.radar.check_for_changes.return_value = (True, 1010, 10)
    backend.radar.get_new_emails.return_value = [
        {"internal_id": 1001, "message_id": "<a@x>", "subject": "s1",
         "sender": "f1", "date_received": "2026", "is_read": False, "is_flagged": False},
    ]
    tick = backend.detect_new_emails(marker=1000)
    assert tick.has_new is True
    assert tick.current_marker == 1010
    assert tick.estimated_new_count == 10
    assert len(tick.new_emails) == 1
    assert tick.new_emails[0].internal_id == 1001
    assert tick.new_emails[0].subject == "s1"


def test_fetch_email_by_id_success(backend):
    backend.arm.fetch_email_content_by_id.return_value = {
        "message_id": "<m@x>", "subject": "Hi", "sender": "a@x",
        "date": "2026", "content": "body", "source": "raw",
        "is_read": True, "is_flagged": False, "thread_id": "<t@x>",
    }
    ec = backend.fetch_email_by_id(42, mailbox="收件箱")
    assert ec is not None
    assert ec.internal_id == 42
    assert ec.message_id == "<m@x>"
    assert ec.subject == "Hi"
    assert ec.mailbox == "收件箱"


def test_fetch_email_by_id_returns_none_on_miss(backend):
    backend.arm.fetch_email_content_by_id.return_value = None
    assert backend.fetch_email_by_id(42, mailbox="收件箱") is None


def test_mark_as_read_forwards_to_arm(backend):
    backend.arm.mark_as_read_by_id.return_value = True
    ok = backend.mark_as_read(42, read=True, mailbox="收件箱")
    assert ok is True
    backend.arm.mark_as_read_by_id.assert_called_once_with(42, read=True, mailbox="收件箱")


def test_set_flag_forwards_to_arm(backend):
    backend.arm.set_flag_by_id.return_value = True
    ok = backend.set_flag(42, flagged=False, mailbox="发件箱")
    assert ok is True
    backend.arm.set_flag_by_id.assert_called_once_with(42, flagged=False, mailbox="发件箱")


def test_health_status_includes_applescript_calls(backend):
    backend.radar.is_available.return_value = True
    backend.radar.get_current_max_row_id.return_value = 500
    backend.radar.db_path = "/fake/Envelope Index"
    backend.arm._stats = {"applescript_calls": 7}
    h = backend.health_status()
    assert h.healthy is True
    assert h.backend == "applescript"
    assert h.details["applescript_calls"] == 7
