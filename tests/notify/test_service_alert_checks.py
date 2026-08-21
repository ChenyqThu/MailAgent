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

    task 07-14: 状态型告警的 ``alert_*`` 现在**返回投递结果 bool**(两阶段提交靠
    它决定要不要 commit) → 这里逐字对齐, 并可用 ``delivered=False`` 模拟投递失败
    (飞书挂 / level 门 / cooldown 门)。
    """

    def __init__(self, delivered: bool = True):
        self.send_alert_calls: list[dict] = []
        self.method_calls: list[tuple] = []
        self.delivered = delivered

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
        return self.delivered

    async def alert_restart_frequency(self, count_24h, threshold):
        # 未接 episode (自带 24h 持久冷却) → 调用方不读返回值, 与真实签名一致
        self.method_calls.append(("alert_restart_frequency", count_24h, threshold))

    async def alert_dead_letters(self, count, threshold):
        self.method_calls.append(("alert_dead_letters", count, threshold))
        return self.delivered

    async def alert_service_unhealthy(self, consecutive_errors):
        self.method_calls.append(("alert_service_unhealthy", consecutive_errors))
        return self.delivered

    async def alert_radar_unavailable(self):
        self.method_calls.append(("alert_radar_unavailable",))
        return self.delivered

    async def alert_consecutive_errors(self, count, last_error):
        self.method_calls.append(("alert_consecutive_errors", count, last_error))

    async def alert_recovery(self, component):
        self.method_calls.append(("alert_recovery", component))
        return self.delivered


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
    outbox_stats=None, state=None, watcher_stats=None,
    notify_center=None, redis_consumer=None,
):
    """EmailNotionSyncApp.__new__ + 只挂 _check_and_alert 需要的属性
    (镜像 tests/mail/test_expansion_loop.py 的既有 pattern)。

    task 08-20: ``notify_center`` 默认 None = 只有飞书一个出口 → 上面所有既有
    用例的行为逐字不变 (通知中心分支整段短路)。"""
    from src.service import EmailNotionSyncApp

    app = EmailNotionSyncApp.__new__(EmailNotionSyncApp)
    app.alerter = alerter
    app._notify_center = notify_center
    watcher = MagicMock()
    watcher.get_stats.return_value = watcher_stats or {
        "consecutive_errors": 0,
        "healthy": True,
        "sync_store": {"dead_letter": 0},
        "radar": {"available": True},
    }
    watcher.sync_store = _FakeStateStore(state)
    app.watcher = watcher
    app.redis_consumer = redis_consumer
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
# 注: 本分支自带 24h 持久冷却, task 07-14 的 episode tracker 有意不接管 —— 下面
# 4 条断言的就是那套专用冷却, 保持原样即是「不迁移」的回归闸。
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
# task 07-14 — 状态型告警 episode 化 (_check_and_alert 接线)
# ---------------------------------------------------------------------------


def _stats(*, dead_letter=0, healthy=True, radar_available=True, consecutive=0):
    return {
        "consecutive_errors": consecutive,
        "healthy": healthy,
        "sync_store": {"dead_letter": dead_letter},
        "radar": {"available": radar_available},
    }


def test_dead_letters_constant_count_alerts_once_then_silent():
    """🔴 owner 病根: 死信恒定 10 封 → 只首告一次, 后续每轮静默 (老实现每 5min 一条)."""
    alerter = _SignatureFakeAlerter()
    app = _build_app(alerter=alerter, watcher_stats=_stats(dead_letter=10))

    asyncio.run(app._check_and_alert())
    assert ("alert_dead_letters", 10, 5) in alerter.method_calls

    alerter.method_calls.clear()
    for _ in range(5):  # 5 轮健康检查
        asyncio.run(app._check_and_alert())
    assert alerter.method_calls == []


def test_dead_letters_no_realert_after_process_restart():
    """🔴 持久化: 重启 (新 app 实例, 只共享 sync_state) 后数量未变 → 不重新告警."""
    alerter = _SignatureFakeAlerter()
    app = _build_app(alerter=alerter, watcher_stats=_stats(dead_letter=10))
    asyncio.run(app._check_and_alert())
    assert ("alert_dead_letters", 10, 5) in alerter.method_calls

    # 进程重启: 全新 app + 全新 alerter (=_cooldown_map 清空), 只有 sync_state 存活
    survived_state = dict(app.watcher.sync_store.state)
    alerter2 = _SignatureFakeAlerter()
    app2 = _build_app(
        alerter=alerter2,
        watcher_stats=_stats(dead_letter=10),
        state=survived_state,
    )
    asyncio.run(app2._check_and_alert())
    assert alerter2.method_calls == []


def test_dead_letters_escalate_on_doubling():
    alerter = _SignatureFakeAlerter()
    app = _build_app(
        alerter=alerter,
        watcher_stats=_stats(dead_letter=20),
        state={
            "alert.dead_letters.active": "1",
            "alert.dead_letters.last_alerted_value": "10.0",
        },
    )
    asyncio.run(app._check_and_alert())
    assert ("alert_dead_letters", 20, 5) in alerter.method_calls


def test_dead_letters_recovery_notice_and_reset():
    """回落到阈值下 → 恢复通知 + 复位 (复位后再越阈值能重新 enter)."""
    alerter = _SignatureFakeAlerter()
    app = _build_app(
        alerter=alerter,
        watcher_stats=_stats(dead_letter=0),
        state={
            "alert.dead_letters.active": "1",
            "alert.dead_letters.last_alerted_value": "10.0",
        },
    )
    asyncio.run(app._check_and_alert())
    assert ("alert_recovery", "死信队列") in alerter.method_calls
    assert app.watcher.sync_store.state["alert.dead_letters.active"] == "0"

    # 复位后再次累积 → 新 episode 能正常告警
    app.watcher.get_stats.return_value = _stats(dead_letter=6)
    alerter.method_calls.clear()
    asyncio.run(app._check_and_alert())
    assert ("alert_dead_letters", 6, 5) in alerter.method_calls


def test_dead_letters_undelivered_alert_is_retried_not_silenced():
    """🔴 HIGH-1: 首告投递失败 (飞书挂 / level 门 / cooldown 门 → send_alert 返回
    False) 绝不能提交 episode, 否则这条告警永久标"已告警"却从未送达 = 永久漏告警。
    """
    alerter = _SignatureFakeAlerter(delivered=False)
    app = _build_app(alerter=alerter, watcher_stats=_stats(dead_letter=10))
    for _ in range(3):
        asyncio.run(app._check_and_alert())
    assert alerter.method_calls.count(("alert_dead_letters", 10, 5)) == 3, (
        "投递失败必须每轮重试; 若 evaluate 内部就落盘, 这里只会有 1 次"
    )
    assert app.watcher.sync_store.state == {}, "投递失败不得留下 episode 状态"

    # 飞书恢复 → 投递成功 → 提交 → 之后才静默
    alerter.delivered = True
    asyncio.run(app._check_and_alert())
    assert alerter.method_calls.count(("alert_dead_letters", 10, 5)) == 4
    alerter.method_calls.clear()
    asyncio.run(app._check_and_alert())
    assert alerter.method_calls == []


def test_flag_alerts_undelivered_are_retried_not_silenced():
    """HIGH-1 的布尔态版本 (service_unhealthy / radar_unavailable)."""
    alerter = _SignatureFakeAlerter(delivered=False)
    app = _build_app(
        alerter=alerter,
        watcher_stats=_stats(healthy=False, radar_available=False),
    )
    for _ in range(3):
        asyncio.run(app._check_and_alert())
    assert alerter.method_calls.count(("alert_service_unhealthy", 0)) == 3
    assert alerter.method_calls.count(("alert_radar_unavailable",)) == 3
    assert app.watcher.sync_store.state == {}


def test_flag_alerts_with_corrupt_baseline_still_alert():
    """🔴 HIGH-2: active=1 但 last_alerted_value 缺失 (commit 部分写入) 时,
    布尔调用方必须仍然告警 —— 修复前 evaluate 返回 ESCALATE 而调用方只认 ENTER
    → 不告警却写好基准 → 之后永久静默。
    """
    alerter = _SignatureFakeAlerter()
    app = _build_app(
        alerter=alerter,
        watcher_stats=_stats(healthy=False, radar_available=False),
        state={
            "alert.service_unhealthy.active": "1",
            "alert.radar_unavailable.active": "1",
            # last_alerted_value 缺失 = 部分写入残留
        },
    )
    asyncio.run(app._check_and_alert())
    assert ("alert_service_unhealthy", 0) in alerter.method_calls
    assert ("alert_radar_unavailable",) in alerter.method_calls
    # 自愈: 基准补齐后回到静默
    alerter.method_calls.clear()
    asyncio.run(app._check_and_alert())
    assert alerter.method_calls == []


def test_island_dead_letter_card_converges_with_alert(monkeypatch):
    """R3: 灵动岛 DeadLetterAccum 与告警同源 —— 静默轮不得独立刷屏."""
    from src.notify import island_dispatch

    dispatched: list[tuple] = []
    monkeypatch.setattr(island_dispatch, "is_enabled", lambda: True)
    monkeypatch.setattr(
        island_dispatch,
        "dispatch_dead_letter_accum",
        lambda *, count, threshold: dispatched.append((count, threshold)),
    )

    alerter = _SignatureFakeAlerter()
    app = _build_app(alerter=alerter, watcher_stats=_stats(dead_letter=10))
    for _ in range(4):
        asyncio.run(app._check_and_alert())
    assert dispatched == [(10, 5)], "岛卡只应在 episode 进入时发一次"


def test_service_unhealthy_and_radar_are_edge_triggered():
    """布尔态: 进入告一次 → 静默 → 恢复告一次."""
    alerter = _SignatureFakeAlerter()
    app = _build_app(
        alerter=alerter,
        watcher_stats=_stats(healthy=False, radar_available=False),
    )
    asyncio.run(app._check_and_alert())
    assert ("alert_service_unhealthy", 0) in alerter.method_calls
    assert ("alert_radar_unavailable",) in alerter.method_calls

    alerter.method_calls.clear()
    asyncio.run(app._check_and_alert())
    assert alerter.method_calls == []  # 仍不健康 → 静默

    app.watcher.get_stats.return_value = _stats()
    alerter.method_calls.clear()
    asyncio.run(app._check_and_alert())
    assert ("alert_recovery", "服务健康检查") in alerter.method_calls
    assert ("alert_recovery", "SQLite 雷达") in alerter.method_calls


def test_episode_flag_off_alerts_every_round(monkeypatch):
    """MAILAGENT_ALERT_EPISODE=false → 字节级回退: 每轮都告, 不碰 sync_state."""
    from src import service as service_module

    monkeypatch.setattr(service_module.config, "alert_episode_enabled", False)
    alerter = _SignatureFakeAlerter()
    app = _build_app(
        alerter=alerter,
        watcher_stats=_stats(dead_letter=10, healthy=False, radar_available=False),
    )
    for _ in range(3):
        asyncio.run(app._check_and_alert())

    assert alerter.method_calls.count(("alert_dead_letters", 10, 5)) == 3
    assert alerter.method_calls.count(("alert_service_unhealthy", 0)) == 3
    assert alerter.method_calls.count(("alert_radar_unavailable",)) == 3
    assert not any(c[0] == "alert_recovery" for c in alerter.method_calls)
    assert app.watcher.sync_store.state == {}


def test_consecutive_errors_not_episode_gated():
    """半状态型 (成功即归零) → 不接 tracker, 行为不变: 每轮都告."""
    alerter = _SignatureFakeAlerter()
    app = _build_app(alerter=alerter, watcher_stats=_stats(consecutive=3))
    for _ in range(3):
        asyncio.run(app._check_and_alert())
    assert alerter.method_calls.count(("alert_consecutive_errors", 3, "")) == 3


def test_davmail_fetch_burst_not_episode_gated(tmp_path, monkeypatch):
    """非状态型告警 (davmail_fetch_burst) 不接 tracker → 行为字节级不变: 每轮都发,
    去重仍归 Alerter 的内存冷却。"""
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
    for _ in range(3):
        asyncio.run(app._check_and_alert())
    assert len(alerter.send_alert_calls) == 3


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


# ---------------------------------------------------------------------------
# task 08-20-notification-center 步骤 4c — 系统告警 → 通知中心 (design §8.b)
# ---------------------------------------------------------------------------


@pytest.fixture
def notify_db(tmp_path):
    """真实 sync_store.db (含 v68 notification 表 + email_metadata)。"""
    from src.mail.sync_store import SyncStore

    path = tmp_path / "sync_store.db"
    SyncStore(str(path))
    return str(path)


def _center(db_path):
    from src.notify.center import NotifyCenter

    return NotifyCenter(db_path)


def _notifications(db_path, dedupe_key=None):
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        sql = "SELECT * FROM notification"
        args: tuple = ()
        if dedupe_key is not None:
            sql += " WHERE dedupe_key=?"
            args = (dedupe_key,)
        return [dict(r) for r in conn.execute(sql + " ORDER BY id", args).fetchall()]


class _RecordingLogger:
    """记录 logger 调用 —— 3 个 try/except 段 (davmail burst / outbox / 重启频次)
    会把 AttributeError **吞成一行 debug**, 只断言「函数没抛」抓不到漏掉的
    `if self.alerter` 守卫 (风险 #2)。这里直接断言那三段一声不吭。"""

    def __init__(self):
        self.messages: list[tuple[str, str]] = []

    def _record(self, level):
        def _log(msg, *a, **kw):
            self.messages.append((level, str(msg)))
        return _log

    def __getattr__(self, name):
        return self._record(name)


def test_no_sink_at_all_returns_early():
    """两个出口都不在 (alerter=None + 通知中心=None) → 老行为: 直接 return."""
    app = _build_app(alerter=None, notify_center=None)
    asyncio.run(app._check_and_alert())
    app.watcher.get_stats.assert_not_called()


def test_alerter_none_full_path_never_raises_and_publishes(
    notify_db, monkeypatch,
):
    """🔴 风险 #2 主用例: ALERT_ENABLED=false 的默认安装 (alerter=None) 下,
    `_check_and_alert` **整个函数**要跑完 —— 任意一处漏掉 `if self.alerter`
    守卫都会 AttributeError (段外直接抛, 段内被 try 吞成一行 debug)。

    同时验收断链修复: 四个状态型告警各落一条 system 通知。
    """
    from src import service as service_module

    # 全部判据同时成立: 连续错误 / 不健康 / 死信 / 雷达挂 / redis 断 / outbox 积压
    # / 24h 重启超阈值 / davmail fetch 突增 (fetch_failed 行喂真实 email_metadata)
    with sqlite3.connect(notify_db) as conn:
        for i in range(3):
            conn.execute(
                "INSERT INTO email_metadata (internal_id, sync_status, "
                "backend_origin, updated_at) VALUES (?, 'fetch_failed', "
                "'davmail', ?)",
                (i + 1, time.time()),
            )
    monkeypatch.setattr(service_module.config, "sync_store_db_path", notify_db)
    rec = _RecordingLogger()
    monkeypatch.setattr(service_module, "logger", rec)

    now = time.time()
    app = _build_app(
        alerter=None,
        notify_center=_center(notify_db),
        backend_origin="davmail",
        outbox_stats=_outbox_stats(60, 50),
        redis_consumer=SimpleNamespace(
            get_stats=lambda: {"connected": False, "last_error": "boom"}
        ),
        watcher_stats=_stats(
            dead_letter=10, healthy=False, radar_available=False, consecutive=3
        ),
        state={"service.start_history": json.dumps(
            [now - i * 600 for i in range(6)]
        )},
    )

    asyncio.run(app._check_and_alert())

    swallowed = [m for m in rec.messages if "failed" in m[1]]
    assert swallowed == [], (
        f"try/except 段吞掉了异常 (多半是漏了 if self.alerter 守卫): {swallowed}"
    )
    keys = {row["dedupe_key"] for row in _notifications(notify_db)}
    assert keys == {
        "alert:service_unhealthy", "alert:dead_letters",
        "alert:radar_unavailable", "alert:outbox_backlog",
    }


def test_service_unhealthy_enter_once_then_silent_then_recover(notify_db):
    """默认安装 (无飞书): ENTER → 一条 critical; 静默轮不刷屏; RECOVER → resolved."""
    app = _build_app(
        alerter=None,
        notify_center=_center(notify_db),
        watcher_stats=_stats(healthy=False),
    )
    for _ in range(3):
        asyncio.run(app._check_and_alert())

    rows = _notifications(notify_db, "alert:service_unhealthy")
    assert len(rows) == 1
    assert rows[0]["severity"] == "critical"
    assert rows[0]["category"] == "system"
    assert rows[0]["state"] == "open"
    assert rows[0]["recurrence_no"] == 1, "静默轮不得计次 (nc 水位失效 = 每 60s 刷一条)"
    # nc 水位落在独立命名空间, 不碰飞书那份
    assert app.watcher.sync_store.state["alert.nc.service_unhealthy.active"] == "1"
    assert "alert.service_unhealthy.active" not in app.watcher.sync_store.state

    app.watcher.get_stats.return_value = _stats()
    asyncio.run(app._check_and_alert())
    rows = _notifications(notify_db, "alert:service_unhealthy")
    assert len(rows) == 1 and rows[0]["state"] == "resolved"


def test_feishu_and_notify_center_keep_separate_watermarks(notify_db):
    """🔴 §8.b 各记水位: 飞书投递失败 → 每轮重发 (老行为一字不动); 通知中心
    落库成功 → 只落一条。共用一份水位会让一边把另一边永久静默。"""
    alerter = _SignatureFakeAlerter(delivered=False)
    app = _build_app(
        alerter=alerter,
        notify_center=_center(notify_db),
        watcher_stats=_stats(dead_letter=10),
    )
    for _ in range(3):
        asyncio.run(app._check_and_alert())

    assert alerter.method_calls.count(("alert_dead_letters", 10, 5)) == 3
    rows = _notifications(notify_db, "alert:dead_letters")
    assert len(rows) == 1 and rows[0]["recurrence_no"] == 1
    assert app.watcher.sync_store.state == {
        "alert.nc.dead_letters.active": "1",
        "alert.nc.dead_letters.last_alerted_value": "10.0",
        "alert.nc.dead_letters.entered_at": (
            app.watcher.sync_store.state["alert.nc.dead_letters.entered_at"]
        ),
    }, "飞书那份水位不得被写 (投递失败 = 下轮要重发)"


def test_notify_center_failure_does_not_break_alert_loop(tmp_path, monkeypatch):
    """通知中心落库炸 (库里没这张表) → 只 warning, 飞书链路照常送达."""
    from src import service as service_module
    from src.notify.center import NotifyCenter

    broken = tmp_path / "empty.db"
    sqlite3.connect(str(broken)).close()  # 空库: 没有 notification 表
    rec = _RecordingLogger()
    monkeypatch.setattr(service_module, "logger", rec)

    alerter = _SignatureFakeAlerter()
    app = _build_app(
        alerter=alerter,
        notify_center=NotifyCenter(str(broken)),
        watcher_stats=_stats(dead_letter=10),
    )
    asyncio.run(app._check_and_alert())

    assert ("alert_dead_letters", 10, 5) in alerter.method_calls
    assert any(
        lvl == "warning" and "alert publish failed" in msg
        for lvl, msg in rec.messages
    )
    # 落库失败不得 commit 水位 → 下轮还会重试
    assert app.watcher.sync_store.state.get("alert.nc.dead_letters.active") is None


def test_episode_flag_off_degrades_to_publish_every_round(notify_db, monkeypatch):
    """MAILAGENT_ALERT_EPISODE=false → nc 水位同样退化成「越阈值就 ENTER」:
    每轮 publish 一次 → dedupe 计次 (design §8.b 写实接受的劣化, 不加特判)。"""
    from src import service as service_module

    monkeypatch.setattr(service_module.config, "alert_episode_enabled", False)
    app = _build_app(
        alerter=None,
        notify_center=_center(notify_db),
        watcher_stats=_stats(dead_letter=10),
    )
    for _ in range(3):
        asyncio.run(app._check_and_alert())

    rows = _notifications(notify_db, "alert:dead_letters")
    assert len(rows) == 1, "同 dedupe_key 恒一行 (计次不新开)"
    assert rows[0]["recurrence_no"] == 3
    assert app.watcher.sync_store.state == {}, "flag-off 不碰 sync_state"


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
