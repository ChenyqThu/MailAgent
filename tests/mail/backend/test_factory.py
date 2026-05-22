"""backend factory + create_backend dispatch tests."""
from __future__ import annotations

import pytest

from src.mail.backend import BackendStartupError, IMailBackend, create_backend


class _MockSyncStore:
    """轻量 sync_store 替身."""
    def get(self, internal_id):
        return None


class _MockConfig:
    """轻量 config 替身, 满足 backend factory + AppleScriptBackend 构造的 attr 要求."""
    mailagent_backend = "applescript"
    sync_mailboxes = "收件箱"
    mail_account_name = "Exchange"
    mail_inbox_name = "收件箱"
    mail_account_url_prefix = "ews://"
    user_email = "test@example.com"
    davmail_imap_host = "127.0.0.1"
    davmail_imap_port = 1143
    davmail_smtp_port = 1025
    davmail_cipher_key = ""
    davmail_drafts_folder = ""


def test_create_backend_unknown_raises_value_error():
    cfg = _MockConfig()
    cfg.mailagent_backend = "graphapi"  # 未实现的 backend
    with pytest.raises(ValueError, match="unknown MAILAGENT_BACKEND"):
        create_backend(cfg, sync_store=_MockSyncStore())


def test_create_backend_davmail_without_sync_store_raises():
    cfg = _MockConfig()
    cfg.mailagent_backend = "davmail"
    with pytest.raises(BackendStartupError) as exc:
        create_backend(cfg, sync_store=None)
    assert "DavMailBackend requires sync_store" in str(exc.value)


def test_backend_startup_error_fields():
    e = BackendStartupError(
        backend="davmail", reason="IMAP timeout", fallback_hint="切回 applescript",
    )
    assert e.backend == "davmail"
    assert e.reason == "IMAP timeout"
    assert e.fallback_hint == "切回 applescript"
    assert "davmail" in str(e)
    assert "IMAP timeout" in str(e)
