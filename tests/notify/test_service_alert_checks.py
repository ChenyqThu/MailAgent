"""E4 WP2 — src/service.py _check_and_alert 新增/修复分支单测.

覆盖:
  - 🔴 :894 回归: davmail fetch 突增告警 send_alert 必须用 content= (原 message=
    kwarg 触发即 TypeError 被 except 吞掉, 告警从未发出)。FakeAlerter **必须带
    真实 send_alert 签名** — 通用 __getattr__ mock 吞掉一切 kwargs 测不出这个 bug。
  - outbox 积压: 行龄 ≥5min 的 pending (lt_30m+gt_30m) > 阈值 → alert_outbox_backlog
  - 重启频次: 24h 内启动 > 5 次 → alert_restart_frequency
  - _record_start_history: 追加 + 48h 裁剪
  - _count_recent_starts: 窗口计数 + 脏数据容错
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
import time
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


@pytest.fixture(autouse=True)
def _stub_main_config_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """src.service import 期会拉 src.config; 提供最小必填 env (镜像
    tests/mail/test_expansion_loop.py 的既有 pattern, 逐测试还原)。"""
    monkeypatch.setenv("NOTION_TOKEN", "test")
    monkeypatch.setenv("EMAIL_DATABASE_ID", "test")
    monkeypatch.setenv("USER_EMAIL", "test@example.com")
    monkeypatch.setenv("MAIL_ACCOUNT_NAME", "test")


class _SignatureFakeAlerter:
    """带**真实 send_alert 签名**的 FakeAlerter (:894 回归的关键).

    通用 ``__getattr__`` 动态 mock 会吞掉任意 kwargs — 旧代码的 ``message=``
    错误关键字在那种 mock 下不报错, 测不出 TypeError bug。这里签名逐字对齐
    FeishuAlertNotifier.send_alert, 传错 kwarg 立即 TypeError。
    """

    def __init__(self):
        self.send_alert_calls: list[dict] = []
        self.method_calls: list[tuple] = []

    async def send_alert(
        self, level, title, content,
        source="MailAgent", details=None, alert_key="",
    ):
        self.send_alert_calls.append({
            "level": level, "title": title,
            "content": content, "alert_key": alert_key,
        })
        return True

    async def alert_outbox_backlog(self, aged_pending, threshold):
        self.method_calls.append(("alert_outbox_backlog", aged_pending, threshold))

    async def alert_restart_frequency(self, count_24h, threshold):
        self.method_calls.append(("alert_restart_frequency", count_24h, threshold))


class _FakeStateStore:
    """最小 sync_store 替身: get_state/set_state dict 存取."""

    def __init__(self, state=None):
        self.state: dict = dict(state or {})

    def get_state(self, key):
        return self.state.get(key)

    def set_state(self, key, value):
        self.state[key] = value
        return True


def _outbox_stats(lt_30m: int = 0, gt_30m: int = 0):
    return SimpleNamespace(
        by_status={}, by_target={},
        age_buckets={"lt_1m": 0, "lt_5m": 0, "lt_30m": lt_30m, "gt_30m": gt_30m},
        total=lt_30m + gt_30m,
    )


def _build_app(
    *, alerter, backend_origin="applescript",
    outbox_stats=None, state=None,
):
    """EmailNotionSyncApp.__new__ + 只挂 _check_and_alert 需要的属性
    (镜像 tests/mail/test_expansion_loop.py 的既有 pattern)。"""
    from src.service import EmailNotionSyncApp

    app = EmailNotionSyncApp.__new__(EmailNotionSyncApp)
    app.alerter = alerter
    watcher = MagicMock()
    watcher.get_stats.return_value = {
        "consecutive_errors": 0,
        "healthy": True,
        "sync_store": {"dead_letter": 0},
        "radar": {"available": True},
    }
    watcher.sync_store = _FakeStateStore(state)
    app.watcher = watcher
    app.redis_consumer = None
    app.backend = SimpleNamespace(backend_origin=backend_origin)
    stats = outbox_stats if outbox_stats is not None else _outbox_stats()
    app.outbox_repo = SimpleNamespace(get_stats=lambda: stats)
    return app


# ---------------------------------------------------------------------------
# 🔴 :894 回归 — davmail fetch 突增告警必须真的发得出去 (content= 不是 message=)
# ---------------------------------------------------------------------------


def test_davmail_fetch_burst_alert_sends_with_real_signature(
    tmp_path, monkeypatch,
):
    """3 封最近 10min fetch_failed → send_alert 成功调用 (真实签名 FakeAlerter).

    旧代码 ``send_alert(message=...)`` 在真实签名下抛 TypeError 被分支内
    except 吞掉 → send_alert_calls 为空 → 本断言失败, 即可抓住回归。
    """
    from src import service as service_module

    db = tmp_path / "sync_store.db"
    conn = sqlite3.connect(str(db))
    conn.execute(
        "CREATE TABLE email_metadata ("
        "internal_id INTEGER PRIMARY KEY, sync_status TEXT, "
        "backend_origin TEXT, updated_at REAL)"
    )
    now = time.time()
    for i in range(3):
        conn.execute(
            "INSERT INTO email_metadata VALUES (?, 'fetch_failed', 'davmail', ?)",
            (i + 1, now),
        )
    conn.commit()
    conn.close()
    monkeypatch.setattr(service_module.config, "sync_store_db_path", str(db))

    alerter = _SignatureFakeAlerter()
    app = _build_app(alerter=alerter, backend_origin="davmail")

    asyncio.run(app._check_and_alert())

    assert len(alerter.send_alert_calls) == 1, (
        "davmail fetch 突增告警必须真的发出 — send_alert(message=...) 的旧 bug "
        "会在这里表现为零调用 (TypeError 被分支 except 吞掉)"
    )
    call = alerter.send_alert_calls[0]
    assert call["alert_key"] == "davmail_fetch_burst"
    assert call["level"] == "error"
    assert "fetch_email_by_id" in call["content"]


def test_davmail_fetch_burst_below_threshold_no_alert(tmp_path, monkeypatch):
    from src import service as service_module

    db = tmp_path / "sync_store.db"
    conn = sqlite3.connect(str(db))
    conn.execute(
        "CREATE TABLE email_metadata ("
        "internal_id INTEGER PRIMARY KEY, sync_status TEXT, "
        "backend_origin TEXT, updated_at REAL)"
    )
    conn.execute(
        "INSERT INTO email_metadata VALUES (1, 'fetch_failed', 'davmail', ?)",
        (time.time(),),
    )
    conn.commit()
    conn.close()
    monkeypatch.setattr(service_module.config, "sync_store_db_path", str(db))

    alerter = _SignatureFakeAlerter()
    app = _build_app(alerter=alerter, backend_origin="davmail")
    asyncio.run(app._check_and_alert())
    assert alerter.send_alert_calls == []


# ---------------------------------------------------------------------------
# outbox 积压 (E4 WP2)
# ---------------------------------------------------------------------------


def test_outbox_backlog_alert_fires_above_threshold():
    """行龄 ≥5min 的 pending (lt_30m+gt_30m) > 阈值(默认100) → alert_outbox_backlog."""
    alerter = _SignatureFakeAlerter()
    app = _build_app(alerter=alerter, outbox_stats=_outbox_stats(60, 50))
    asyncio.run(app._check_and_alert())
    assert ("alert_outbox_backlog", 110, 100) in alerter.method_calls


def test_outbox_backlog_no_alert_at_threshold():
    """恰好等于阈值不告警 (条件是 >), 新鲜 pending (lt_5m) 不计入."""
    alerter = _SignatureFakeAlerter()
    stats = _outbox_stats(50, 50)
    stats.age_buckets["lt_5m"] = 500  # 正常处理中的短暂排队, 不算积压
    app = _build_app(alerter=alerter, outbox_stats=stats)
    asyncio.run(app._check_and_alert())
    assert alerter.method_calls == []


# ---------------------------------------------------------------------------
# 重启频次 (E4 WP2)
# ---------------------------------------------------------------------------


def test_restart_frequency_alert_fires_above_threshold():
    """① 首次超阈值 (无冷却 state) → 发送, 且写回 episode 冷却时间戳."""
    now = time.time()
    history = [now - i * 600 for i in range(6)]  # 24h 内 6 次 > 阈值 5
    alerter = _SignatureFakeAlerter()
    app = _build_app(
        alerter=alerter,
        state={"service.start_history": json.dumps(history)},
    )
    asyncio.run(app._check_and_alert())
    assert ("alert_restart_frequency", 6, 5) in alerter.method_calls
    stored = app.watcher.sync_store.state.get("service.restart_freq_last_alert")
    assert stored is not None
    assert abs(float(stored) - time.time()) < 60  # 写回的是"现在"


def test_restart_frequency_suppressed_within_episode_cooldown():
    """② 冷却时间戳 < 24h → 不重发 (episode 内静默), 且不覆盖时间戳."""
    now = time.time()
    history = [now - i * 600 for i in range(6)]
    last_alert = now - 3600  # 1h 前刚发过
    alerter = _SignatureFakeAlerter()
    app = _build_app(
        alerter=alerter,
        state={
            "service.start_history": json.dumps(history),
            "service.restart_freq_last_alert": str(last_alert),
        },
    )
    asyncio.run(app._check_and_alert())
    assert alerter.method_calls == []
    assert app.watcher.sync_store.state[
        "service.restart_freq_last_alert"
    ] == str(last_alert)


def test_restart_frequency_resends_after_24h_cooldown():
    """③ 冷却时间戳 > 24h → 重新发送, 并刷新时间戳."""
    now = time.time()
    history = [now - i * 600 for i in range(6)]
    last_alert = now - 25 * 3600  # 上次告警已过 24h
    alerter = _SignatureFakeAlerter()
    app = _build_app(
        alerter=alerter,
        state={
            "service.start_history": json.dumps(history),
            "service.restart_freq_last_alert": str(last_alert),
        },
    )
    asyncio.run(app._check_and_alert())
    assert ("alert_restart_frequency", 6, 5) in alerter.method_calls
    stored = float(
        app.watcher.sync_store.state["service.restart_freq_last_alert"]
    )
    assert stored > last_alert  # 已刷新为本次发送时间


def test_restart_frequency_garbage_cooldown_state_fails_open():
    """④ 冷却 state 值损坏 (非数字) → 视为可发送, 不抛异常."""
    now = time.time()
    history = [now - i * 600 for i in range(6)]
    alerter = _SignatureFakeAlerter()
    app = _build_app(
        alerter=alerter,
        state={
            "service.start_history": json.dumps(history),
            "service.restart_freq_last_alert": "not-a-number",
        },
    )
    asyncio.run(app._check_and_alert())
    assert ("alert_restart_frequency", 6, 5) in alerter.method_calls
    # 写回后覆盖为合法时间戳
    float(app.watcher.sync_store.state["service.restart_freq_last_alert"])


def test_restart_frequency_old_entries_outside_24h_not_counted():
    now = time.time()
    history = [now - 25 * 3600] * 10 + [now]  # 24h 外 10 条 + 24h 内 1 条
    alerter = _SignatureFakeAlerter()
    app = _build_app(
        alerter=alerter,
        state={"service.start_history": json.dumps(history)},
    )
    asyncio.run(app._check_and_alert())
    assert alerter.method_calls == []


# ---------------------------------------------------------------------------
# _record_start_history / _count_recent_starts
# ---------------------------------------------------------------------------


def test_record_start_history_appends_and_prunes_48h():
    now = time.time()
    old = now - 49 * 3600  # 超 48h → 应被裁掉
    recent = now - 3600
    app = _build_app(
        alerter=_SignatureFakeAlerter(),
        state={"service.start_history": json.dumps([old, recent])},
    )
    app._record_start_history()
    stored = json.loads(app.watcher.sync_store.state["service.start_history"])
    assert len(stored) == 2  # recent + 本次; old 被裁
    assert all(t >= now - 48 * 3600 for t in stored)

    app._record_start_history()
    stored = json.loads(app.watcher.sync_store.state["service.start_history"])
    assert len(stored) == 3


def test_count_recent_starts_tolerates_garbage_state():
    app = _build_app(
        alerter=_SignatureFakeAlerter(),
        state={"service.start_history": "not-json{{"},
    )
    assert app._count_recent_starts(24 * 3600) == 0
    app.watcher.sync_store.state["service.start_history"] = json.dumps(
        {"not": "a list"}
    )
    assert app._count_recent_starts(24 * 3600) == 0
    app.watcher.sync_store.state["service.start_history"] = json.dumps(
        [time.time(), "junk", None]
    )
    assert app._count_recent_starts(24 * 3600) == 1
