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


def test_alert_davmail_auth_expiring_is_warning(monkeypatch):
    n, sent = _make_notifier(monkeypatch)
    assert _run(n.alert_davmail_auth_expiring(2.5, "2026-11-27T14:54:00")) is True
    assert len(sent) == 1
    card = sent[0]
    assert card["header"]["template"] == "yellow"  # warning
    assert "2.5" in card["elements"][0]["content"]
    assert "重新认证" in card["elements"][0]["content"]
    assert "登录即将过期" in card["header"]["title"]["content"]


def test_alert_davmail_auth_expired_is_critical(monkeypatch):
    n, sent = _make_notifier(monkeypatch)
    assert _run(n.alert_davmail_auth_expired(None)) is True
    assert len(sent) == 1
    assert sent[0]["header"]["template"] == "red"
    assert "登录已过期" in sent[0]["header"]["title"]["content"]


def test_davmail_alerts_point_to_in_app_reauth(monkeypatch):
    """处理办法统一是 App 里的「重新认证」，不再让人去命令行重走 O365Manual OAuth flow。"""
    n, sent = _make_notifier(monkeypatch)
    _run(n.alert_davmail_oauth_failure("AADSTS70043 refresh token expired"))
    _run(n.alert_davmail_login_degraded(3, 3))
    _run(n.alert_davmail_restart_storm(6, 6))
    assert len(sent) == 3
    for card in sent:
        content = card["elements"][0]["content"]
        assert "重新认证" in content
        assert "O365Manual" not in content


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


def test_alert_davmail_process_recovered_is_warning(monkeypatch):
    """task 07-14: 从 info(blue) 提到 warning(yellow) —— alert_levels 默认不含
    info, 原 info 级恢复通知一条都发不出去 (投递闸见 test_alert_worker_methods)。"""
    n, sent = _make_notifier(monkeypatch)
    _run(n.alert_davmail_process_recovered("IMAP"))
    assert len(sent) == 1
    assert sent[0]["header"]["template"] == "yellow"


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


def test_alert_davmail_login_recovered_is_warning(monkeypatch):
    """task 07-14: 同上, info → warning 才发得出去 (L2a 恢复通知)."""
    n, sent = _make_notifier(monkeypatch)
    _run(n.alert_davmail_login_recovered())
    assert len(sent) == 1
    assert sent[0]["header"]["template"] == "yellow"


def test_alert_davmail_auto_restart_success_warning_failure_critical(monkeypatch):
    """L2b: 自动重启成功 → warning; 失败 → critical (需人工介入)."""
    n, sent = _make_notifier(monkeypatch)
    _run(n.alert_davmail_auto_restart(True, "exit 0", 3, 10))
    _run(n.alert_davmail_auto_restart(False, "exit 1: boom", 3, 10))
    assert len(sent) == 2
    assert sent[0]["header"]["template"] == "yellow"  # 成功 = warning
    assert sent[1]["header"]["template"] == "red"  # 失败 = critical
    assert "boom" in sent[1]["elements"][0]["content"]


def test_alert_davmail_restart_storm_is_critical(monkeypatch):
    n, sent = _make_notifier(monkeypatch)
    _run(n.alert_davmail_restart_storm(6, 6))
    assert len(sent) == 1
    card = sent[0]
    assert card["header"]["template"] == "red"
    assert "6" in card["elements"][0]["content"]


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

    _run(n.alert_davmail_auth_expiring(2.0, None))
    _run(n.alert_davmail_auth_expiring(1.5, None))
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

    _run(n.alert_davmail_auth_expiring(2.0, None))  # warning → skipped
    _run(n.alert_davmail_process_recovered("IMAP"))  # info → skipped
    _run(n.alert_davmail_oauth_failure("bad token"))  # critical → sent
    assert len(sent) == 1
    assert sent[0]["header"]["template"] == "red"
