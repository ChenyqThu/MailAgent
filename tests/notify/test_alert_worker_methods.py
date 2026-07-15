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


def _make_default_levels_notifier(monkeypatch) -> tuple[FeishuAlertNotifier, list[dict]]:
    """🔴 用**生产默认** enabled_levels (不含 info) 构造 —— 上面的 _make_notifier
    显式打开了 info, 正因如此才没抓住「恢复通知一条都发不出」的预存 bug。
    """
    n = FeishuAlertNotifier(webhook_url="https://example.invalid/webhook", cooldown=0)
    sent: list[dict] = []

    async def fake_send(card):
        sent.append(card)
        return True

    monkeypatch.setattr(n, "_send", fake_send)
    return n, sent


# ---------------------------------------------------------------------------
# task 07-14 回归闸 — 恢复通知必须真的投递得出去 (level 门不得挡掉)
# ---------------------------------------------------------------------------


def test_default_enabled_levels_match_config_and_exclude_info():
    """闸的前提: 生产默认 alert_levels 不含 info。若哪天默认放开了 info,
    这条会红 → 提醒重新评估下面几条恢复通知闸是否还必要。"""
    from src.config import Config

    assert FeishuAlertNotifier(webhook_url="x").enabled_levels == {
        "critical", "error", "warning",
    }
    assert Config(USER_EMAIL="t@e.com").alert_levels == "critical,error,warning"


def test_alert_recovery_delivers_under_default_levels(monkeypatch):
    """🔴 预存 bug 回归闸: alert_recovery 曾是 info → 被 level 门挡掉, 零发出.

    owner 拍板「恢复通知必发」(PRD Q3) → 必须 ≥ warning 才发得出去。
    """
    n, sent = _make_default_levels_notifier(monkeypatch)
    _run(n.alert_recovery("死信队列"))  # 预定义方法不回传 send_alert 结果, 看 sent
    assert len(sent) == 1, "恢复通知被 enabled_levels 门挡掉了 (level 必须 ≥ warning)"
    assert sent[0]["header"]["template"] == "yellow"  # warning
    assert "死信队列" in sent[0]["header"]["title"]["content"]


def test_davmail_recovery_alerts_deliver_under_default_levels(monkeypatch):
    """同上, davmail 两条恢复通知 (实测今天恢复两次、通知零发出)."""
    n, sent = _make_default_levels_notifier(monkeypatch)
    _run(n.alert_davmail_process_recovered("IMAP"))
    _run(n.alert_davmail_login_recovered())
    assert len(sent) == 2, "davmail 恢复通知被 level 门挡掉 (level 必须 ≥ warning)"
    assert all(c["header"]["template"] == "yellow" for c in sent)


def test_service_started_stays_info(monkeypatch):
    """service_started 不是恢复通知 → 有意保持 info (超范围不动): 默认 levels
    下不投递, 与 07-14 之前逐字一致。"""
    n, sent = _make_default_levels_notifier(monkeypatch)
    _run(n.alert_service_started(["收件箱"], 5))
    assert sent == []


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
