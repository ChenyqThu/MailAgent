"""E4 WP1/WP2 — src/notify/alert.py 新增 4 个预定义告警方法单测.

镜像 tests/notify/test_alert_davmail.py 的手法: mock _send 验证 level 模板 /
标题 / 内容 / alert_key (经 cooldown 去重路径间接验证), 不真发 HTTP。
"""
from __future__ import annotations

import asyncio

from src.notify.alert import FeishuAlertNotifier


def _make_notifier(monkeypatch) -> tuple[FeishuAlertNotifier, list[dict]]:
    n = FeishuAlertNotifier(
        webhook_url="https://example.invalid/webhook",
        enabled_levels="critical,error,warning,info",
        cooldown=300,
    )
    sent: list[dict] = []

    async def fake_send(card):
        sent.append(card)
        return True

    monkeypatch.setattr(n, "_send", fake_send)
    return n, sent


def _run(coro):
    return asyncio.run(coro)


def test_alert_worker_crashed_is_error(monkeypatch):
    n, sent = _make_notifier(monkeypatch)
    _run(n.alert_worker_crashed("fanout", "RuntimeError('boom')", 2))
    assert len(sent) == 1
    card = sent[0]
    assert card["header"]["template"] == "orange"  # error
    assert "fanout" in card["header"]["title"]["content"]
    assert "RuntimeError" in card["elements"][0]["content"]


def test_alert_worker_crashed_cooldown_dedup_per_worker(monkeypatch):
    """同 worker 冷却期内去重, 不同 worker 互不影响 (alert_key 含 name)."""
    n, sent = _make_notifier(monkeypatch)
    _run(n.alert_worker_crashed("fanout", "err", 1))
    _run(n.alert_worker_crashed("fanout", "err", 2))  # 冷却内 → 抑制
    _run(n.alert_worker_crashed("watcher", "err", 1))  # 不同 key → 放行
    assert len(sent) == 2


def test_alert_worker_crashloop_stopped_is_critical(monkeypatch):
    n, sent = _make_notifier(monkeypatch)
    _run(n.alert_worker_crashloop_stopped("calendar_sync", 5))
    assert len(sent) == 1
    card = sent[0]
    assert card["header"]["template"] == "red"  # critical
    assert "calendar_sync" in card["header"]["title"]["content"]
    assert "5" in card["elements"][0]["content"]


def test_alert_outbox_backlog_is_warning(monkeypatch):
    n, sent = _make_notifier(monkeypatch)
    _run(n.alert_outbox_backlog(150, 100))
    assert len(sent) == 1
    card = sent[0]
    assert card["header"]["template"] == "yellow"  # warning
    assert "150" in card["elements"][0]["content"]
    assert "100" in card["elements"][0]["content"]


def test_alert_restart_frequency_is_warning(monkeypatch):
    n, sent = _make_notifier(monkeypatch)
    _run(n.alert_restart_frequency(8, 5))
    assert len(sent) == 1
    card = sent[0]
    assert card["header"]["template"] == "yellow"  # warning
    assert "8" in card["elements"][0]["content"]
