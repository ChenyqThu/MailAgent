"""AppleScriptBackend wrapper tests — mock arm + radar, verify protocol delegation."""
from __future__ import annotations

from unittest.mock import patch

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
    with patch("src.mail.backend.applescript_backend.AppleScriptArm"), \
         patch("src.mail.backend.applescript_backend.SQLiteRadar"):
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


# --------- 雷达面 — 委托 SQLiteRadar ---------


def test_radar_face_delegates(backend):
    backend.radar.is_available.return_value = True
    backend.radar.get_current_max_row_id.return_value = 999
    backend.radar.check_for_changes.return_value = (True, 1010, 10)
    backend.radar.get_new_emails.return_value = [{"internal_id": 1001}]
    backend.radar.get_last_max_row_id.return_value = 888

    assert backend.is_available() is True
    assert backend.get_current_max_row_id() == 999
    assert backend.check_for_changes(1000) == (True, 1010, 10)
    assert backend.get_new_emails(1000) == [{"internal_id": 1001}]
    backend.radar.get_new_emails.assert_called_once_with(since_row_id=1000)
    backend.set_last_max_row_id(1010)
    backend.radar.set_last_max_row_id.assert_called_once_with(1010)
    assert backend.get_last_max_row_id() == 888


# --------- 抓取面 — 委托 AppleScriptArm (legacy dict 透传) ---------


def test_fetch_email_content_by_id_delegates(backend):
    raw = {
        "message_id": "<m@x>", "subject": "Hi", "sender": "a@x",
        "date": "2026", "content": "body", "source": "raw",
        "is_read": True, "is_flagged": False, "thread_id": "<t@x>",
    }
    backend.arm.fetch_email_content_by_id.return_value = raw
    assert backend.fetch_email_content_by_id(42, mailbox="收件箱") is raw
    backend.arm.fetch_email_content_by_id.assert_called_once_with(42, mailbox="收件箱")


def test_fetch_email_content_by_id_none_on_miss(backend):
    backend.arm.fetch_email_content_by_id.return_value = None
    assert backend.fetch_email_content_by_id(42, mailbox="收件箱") is None


def test_fetch_email_by_message_id_delegates(backend):
    backend.arm.fetch_email_by_message_id.return_value = {"subject": "s"}
    assert backend.fetch_email_by_message_id("<m@x>", mailbox="发件箱") == {"subject": "s"}
    backend.arm.fetch_email_by_message_id.assert_called_once_with("<m@x>", mailbox="发件箱")


def test_fetch_emails_by_position_delegates(backend):
    backend.arm.fetch_emails_by_position.return_value = [{"id": 1}]
    assert backend.fetch_emails_by_position(5, mailbox="收件箱") == [{"id": 1}]
    backend.arm.fetch_emails_by_position.assert_called_once_with(count=5, mailbox="收件箱")


# --------- flag 面 — 委托 AppleScriptArm ---------


def test_mark_as_read_by_id_forwards_to_arm(backend):
    backend.arm.mark_as_read_by_id.return_value = True
    ok = backend.mark_as_read_by_id(42, read=True, mailbox="收件箱")
    assert ok is True
    backend.arm.mark_as_read_by_id.assert_called_once_with(42, read=True, mailbox="收件箱")


def test_set_flag_by_id_forwards_to_arm(backend):
    backend.arm.set_flag_by_id.return_value = True
    ok = backend.set_flag_by_id(42, flagged=False, mailbox="发件箱")
    assert ok is True
    backend.arm.set_flag_by_id.assert_called_once_with(42, flagged=False, mailbox="发件箱")


def test_mark_as_read_str_fallback_forwards_to_arm(backend):
    """str message_id fallback 面 (handlers/reverse_sync 三位置参数调用形状)."""
    backend.arm.mark_as_read.return_value = True
    ok = backend.mark_as_read("<m@x>", True, "收件箱")
    assert ok is True
    backend.arm.mark_as_read.assert_called_once_with("<m@x>", read=True, mailbox="收件箱")


def test_set_flag_str_fallback_forwards_to_arm(backend):
    backend.arm.set_flag.return_value = True
    ok = backend.set_flag("<m@x>", False, "收件箱")
    assert ok is True
    backend.arm.set_flag.assert_called_once_with("<m@x>", flagged=False, mailbox="收件箱")


# --------- 草稿对账 — applescript 恒 noop ---------


def test_reconcile_drafts_noop(backend):
    assert backend.reconcile_drafts() == ([], [])


# --------- create_reply_draft.sh 定位 — dev vs 打包 .app 布局 (Issue #41) ---------

from pathlib import Path

from src.mail.backend import applescript_backend as ab
from src.mail.backend.types import DraftRequest


def test_resolve_draft_script_dev_layout():
    """dev 布局: 解析到真实仓库根的 <repo>/scripts/create_reply_draft.sh 且在场。"""
    resolved = ab._resolve_draft_script()
    assert resolved.name == "create_reply_draft.sh"
    assert resolved.parent.name == "scripts"
    assert resolved.exists()


def test_resolve_draft_script_packaged_layout(tmp_path, monkeypatch):
    """模拟 .app 布局: __file__ 落 site-packages 深处 (parents[3] 算错), 脚本在与内嵌
    CPython (sys.prefix) 同级的 Resources/scripts —— 应经 sys.prefix 父目录候选命中。"""
    resources = tmp_path / "Contents" / "Resources"
    site_pkg_backend = (
        resources / "python" / "lib" / "python3.11" / "site-packages"
        / "src" / "mail" / "backend"
    )
    site_pkg_backend.mkdir(parents=True)
    fake_file = site_pkg_backend / "applescript_backend.py"
    fake_file.write_text("# fake module for layout test\n")
    scripts_dir = resources / "scripts"
    scripts_dir.mkdir(parents=True)
    packaged_script = scripts_dir / "create_reply_draft.sh"
    packaged_script.write_text("#!/bin/bash\n")

    monkeypatch.delenv("MAILAGENT_RESOURCES_ROOT", raising=False)
    monkeypatch.setattr(ab, "__file__", str(fake_file))
    monkeypatch.setattr(ab.sys, "prefix", str(resources / "python"))

    # 老 parents[3] 候选落在不存在的 site-packages/scripts —— 坐实打包态确实算错。
    parents3 = fake_file.resolve().parents[3] / "scripts" / "create_reply_draft.sh"
    assert not parents3.exists()

    resolved = ab._resolve_draft_script()
    assert resolved == packaged_script
    assert resolved.exists()


def test_resolve_draft_script_env_override_wins(tmp_path, monkeypatch):
    """MAILAGENT_RESOURCES_ROOT 显式覆盖优先于自动探测。"""
    root = tmp_path / "custom_resources"
    (root / "scripts").mkdir(parents=True)
    script = root / "scripts" / "create_reply_draft.sh"
    script.write_text("#!/bin/bash\n")
    monkeypatch.setenv("MAILAGENT_RESOURCES_ROOT", str(root))
    assert ab._resolve_draft_script() == script


def test_append_draft_missing_script_lists_attempts(backend, monkeypatch):
    """脚本缺失时错误列出尝试过的路径 —— 不误导用户去重装。"""
    monkeypatch.setattr(ab, "_DRAFT_SH", Path("/nonexistent/scripts/create_reply_draft.sh"))
    req = DraftRequest(
        mode="reply", internal_id_for_threading=42, to=["a@x.test"], reply_text="hi"
    )
    res = backend.append_draft(req)
    assert res.success is False
    assert "未找到" in res.error
    assert "已尝试" in res.error
    assert "重装" not in res.error and "reinstall" not in res.error.lower()
