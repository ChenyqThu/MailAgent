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


def test_create_backend_davmail_probe_retries_until_success(monkeypatch):
    """开机时序: davmail JVM 未就绪时 probe 失败应重试, 恢复后正常创建 backend."""
    import src.mail.backend.factory as factory_mod

    cfg = _MockConfig()
    cfg.mailagent_backend = "davmail"

    probe_calls = {"n": 0}

    def fake_probe(self):
        probe_calls["n"] += 1
        if probe_calls["n"] <= 3:
            return False, "TCP probe failed: 127.0.0.1:1143 unreachable"
        return True, "DavMail OK"

    sleeps = []
    monkeypatch.setattr(factory_mod.time, "sleep", lambda s: sleeps.append(s))
    from src.mail.backend.davmail_backend import DavMailBackend

    monkeypatch.setattr(DavMailBackend, "probe_readiness", fake_probe)

    backend = create_backend(
        cfg,
        sync_store=_MockSyncStore(),
        probe_max_attempts=factory_mod.DAVMAIL_PROBE_MAX_ATTEMPTS,
    )
    assert isinstance(backend, DavMailBackend)
    assert probe_calls["n"] == 4  # 3 失败 + 1 成功
    assert sleeps == [factory_mod.DAVMAIL_PROBE_RETRY_INTERVAL_S] * 3


def test_create_backend_davmail_probe_exhausted_raises(monkeypatch):
    """重试耗尽 (全部失败) 后仍 raise BackendStartupError."""
    import src.mail.backend.factory as factory_mod

    cfg = _MockConfig()
    cfg.mailagent_backend = "davmail"

    probe_calls = {"n": 0}

    def fake_probe(self):
        probe_calls["n"] += 1
        return False, "TCP probe failed: 127.0.0.1:1143 unreachable"

    monkeypatch.setattr(factory_mod.time, "sleep", lambda s: None)
    from src.mail.backend.davmail_backend import DavMailBackend

    monkeypatch.setattr(DavMailBackend, "probe_readiness", fake_probe)

    with pytest.raises(BackendStartupError) as exc:
        create_backend(cfg, sync_store=_MockSyncStore(), probe_max_attempts=5)
    assert probe_calls["n"] == 5
    assert "TCP probe failed" in str(exc.value)


def test_create_backend_davmail_default_no_retry(monkeypatch):
    """默认 probe_max_attempts=1: CLI 等调用方 probe 失败快速 raise, 不重试."""
    import src.mail.backend.factory as factory_mod

    cfg = _MockConfig()
    cfg.mailagent_backend = "davmail"

    probe_calls = {"n": 0}

    def fake_probe(self):
        probe_calls["n"] += 1
        return False, "TCP probe failed: 127.0.0.1:1143 unreachable"

    def fail_sleep(s):
        raise AssertionError("default path must not sleep/retry")

    monkeypatch.setattr(factory_mod.time, "sleep", fail_sleep)
    from src.mail.backend.davmail_backend import DavMailBackend

    monkeypatch.setattr(DavMailBackend, "probe_readiness", fake_probe)

    with pytest.raises(BackendStartupError):
        create_backend(cfg, sync_store=_MockSyncStore())
    assert probe_calls["n"] == 1


def test_create_backend_applescript_probe_failure_no_retry(monkeypatch):
    """applescript 路径即使传了 probe_max_attempts 也不重试, 立即 raise."""
    import src.mail.backend.factory as factory_mod

    cfg = _MockConfig()  # mailagent_backend = "applescript"

    probe_calls = {"n": 0}

    def fake_probe(self):
        probe_calls["n"] += 1
        return False, "Envelope Index not readable"

    def fail_sleep(s):
        raise AssertionError("applescript path must not sleep/retry")

    monkeypatch.setattr(factory_mod.time, "sleep", fail_sleep)
    from src.mail.backend.applescript_backend import AppleScriptBackend

    monkeypatch.setattr(AppleScriptBackend, "probe_readiness", fake_probe)

    with pytest.raises(BackendStartupError):
        create_backend(
            cfg,
            sync_store=_MockSyncStore(),
            probe_max_attempts=factory_mod.DAVMAIL_PROBE_MAX_ATTEMPTS,
        )
    assert probe_calls["n"] == 1


def test_backend_startup_error_fields():
    e = BackendStartupError(
        backend="davmail", reason="IMAP timeout", fallback_hint="切回 applescript",
    )
    assert e.backend == "davmail"
    assert e.reason == "IMAP timeout"
    assert e.fallback_hint == "切回 applescript"
    assert "davmail" in str(e)
    assert "IMAP timeout" in str(e)
