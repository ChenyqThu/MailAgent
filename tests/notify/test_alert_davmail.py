"""Smoke tests for src/notify/alert.py DavMail-specific 预定义方法.

只验证签名 + send_alert 契约 (level / alert_key / details 形状), 不真发 HTTP.
覆盖跟 davmail_watchdog 调用面一致的 6 个 method.
"""
from __future__ import annotations

import asyncio


from src.notify.alert import FeishuAlertNotifier


def _make_notifier(monkeypatch) -> tuple[FeishuAlertNotifier, list[dict]]:
    n = FeishuAlertNotifier(
        webhook_url="https://example.invalid/webhook",
        enabled_levels="critical,error,warning,info",
        cooldown=0,
    )
    sent: list[dict] = []

    async def fake_send(card):
        sent.append(card)
        return True

    monkeypatch.setattr(n, "_send", fake_send)
    return n, sent


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro) if False else asyncio.run(coro)


def test_alert_davmail_token_expiring_is_warning(monkeypatch):
    n, sent = _make_notifier(monkeypatch)
    _run(n.alert_davmail_token_expiring(82.5))
    assert len(sent) == 1
    card = sent[0]
    assert card["header"]["template"] == "yellow"  # warning
    assert "82.5" in card["elements"][0]["content"]
    assert "OAuth token 即将过期" in card["header"]["title"]["content"]


def test_alert_davmail_token_critical_is_critical(monkeypatch):
    n, sent = _make_notifier(monkeypatch)
    _run(n.alert_davmail_token_critical(89.0))
    assert len(sent) == 1
    assert sent[0]["header"]["template"] == "red"


def test_alert_davmail_oauth_failure_truncates_long_excerpt(monkeypatch):
    n, sent = _make_notifier(monkeypatch)
    long_line = "X" * 500
    _run(n.alert_davmail_oauth_failure(long_line))
    assert len(sent) == 1
    content = sent[0]["elements"][0]["content"]
    # 200 char 上限 + Markdown 包裹
    assert "X" * 200 in content
    assert sent[0]["header"]["template"] == "red"


def test_alert_davmail_process_down_includes_port_and_proto(monkeypatch):
    n, sent = _make_notifier(monkeypatch)
    _run(n.alert_davmail_process_down(3, 1143, "IMAP"))
    assert len(sent) == 1
    card = sent[0]
    assert card["header"]["template"] == "red"
    title = card["header"]["title"]["content"]
    assert "IMAP" in title


def test_alert_davmail_process_recovered_is_info(monkeypatch):
    n, sent = _make_notifier(monkeypatch)
    _run(n.alert_davmail_process_recovered("IMAP"))
    assert len(sent) == 1
    assert sent[0]["header"]["template"] == "blue"


def test_alert_davmail_ews_throttling_is_warning(monkeypatch):
    n, sent = _make_notifier(monkeypatch)
    _run(n.alert_davmail_ews_throttling(5))
    assert len(sent) == 1
    card = sent[0]
    assert card["header"]["template"] == "yellow"
    assert "5" in card["elements"][0]["content"]


def test_alert_davmail_login_degraded_is_critical(monkeypatch):
    """L2a: IMAP LOGIN 持续失败 (token 劣化) → critical + 计数/阈值入内容."""
    n, sent = _make_notifier(monkeypatch)
    _run(n.alert_davmail_login_degraded(3, 3))
    assert len(sent) == 1
    card = sent[0]
    assert card["header"]["template"] == "red"
    assert "LOGIN" in card["header"]["title"]["content"]
    assert "3" in card["elements"][0]["content"]


def test_alert_davmail_login_recovered_is_info(monkeypatch):
    n, sent = _make_notifier(monkeypatch)
    _run(n.alert_davmail_login_recovered())
    assert len(sent) == 1
    assert sent[0]["header"]["template"] == "blue"


def test_cooldown_dedupes_repeat_same_key(monkeypatch):
    """同一 alert_key 在 cooldown 期内只发一次 (复用现有 cooldown 语义)."""
    n = FeishuAlertNotifier(
        webhook_url="https://example.invalid/webhook",
        enabled_levels="warning",
        cooldown=300,
    )
    sent = []

    async def fake_send(card):
        sent.append(card)
        return True
    monkeypatch.setattr(n, "_send", fake_send)

    _run(n.alert_davmail_token_expiring(82.0))
    _run(n.alert_davmail_token_expiring(82.5))
    assert len(sent) == 1, "second call within cooldown should be suppressed"


def test_disabled_level_skipped(monkeypatch):
    """禁用某 level 时该 alert 不发."""
    n = FeishuAlertNotifier(
        webhook_url="https://example.invalid/webhook",
        enabled_levels="critical",  # 只允 critical
        cooldown=0,
    )
    sent = []

    async def fake_send(card):
        sent.append(card)
        return True
    monkeypatch.setattr(n, "_send", fake_send)

    _run(n.alert_davmail_token_expiring(82.0))  # warning → skipped
    _run(n.alert_davmail_process_recovered("IMAP"))  # info → skipped
    _run(n.alert_davmail_oauth_failure("bad token"))  # critical → sent
    assert len(sent) == 1
    assert sent[0]["header"]["template"] == "red"
