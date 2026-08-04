"""worker gate / 冲突路径 / episode 告警 / 停机（src/im/worker.py）。

全部离线：``FeishuConnection`` 与 ``detect_pm2_conflict`` 都被替身掉，
一次也不 import lark_oapi、不建任何真连接。
"""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

import pytest

from src.im import state as im_state
from src.im import worker as im_worker
from src.im.worker import FeishuImWorker, _LazySender, feishu_im_ready
from src.notify.episode import AlertEpisodeTracker
from tests.im.conftest import FakeAlerter, FakeStateStore


def _cfg(*, enabled=True, app_id="cli_x", secret="s"):
    return SimpleNamespace(
        im_feishu_enabled=enabled,
        feishu_im_app_id=app_id,
        feishu_im_app_secret=secret,
    )


# ── spawn gate ──────────────────────────────────────────────────────────────


class TestSpawnGate:
    def test_flag_off_is_inert_and_never_touches_credentials(self, monkeypatch):
        """🔴 flag off = 零激活：连凭证层（Keychain / agent_config.db）都不碰。"""
        touched = []
        monkeypatch.setattr(
            im_worker, "ensure_credentials", lambda *a, **k: touched.append(1)
        )
        ready, reason = feishu_im_ready(_cfg(enabled=False))
        assert ready is False
        assert "MAILAGENT_IM_FEISHU=false" in reason
        assert touched == []

    def test_flag_on_without_credentials_does_not_spawn(self, monkeypatch):
        """🔴 「没配凭证」必须在 spawn 前拦：supervise 会把 worker 的正常 return
        当成死亡并进退避重启循环。"""
        monkeypatch.setattr(im_worker, "ensure_credentials", lambda *a, **k: None)
        ready, reason = feishu_im_ready(_cfg())
        assert ready is False
        assert "FEISHU_IM_APP_ID" in reason

    def test_ready_when_flag_on_and_credentials_present(self, monkeypatch):
        monkeypatch.setattr(
            im_worker,
            "ensure_credentials",
            lambda *a, **k: SimpleNamespace(app_id="cli_abcdefgh", app_secret="s"),
        )
        ready, reason = feishu_im_ready(_cfg())
        assert ready is True
        assert "cli_abcd" in reason
        assert "s" not in reason.replace("app_id=", "")  # 不回显 secret


# ── 多实例冲突：命中即不建连 ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_conflict_means_no_connection_at_all(monkeypatch):
    monkeypatch.setattr(im_worker, "CONFLICT_RECHECK_SEC", 0.02)
    monkeypatch.setattr(im_worker, "MONITOR_POLL_SEC", 0.01)
    monkeypatch.setattr(
        im_worker, "detect_pm2_conflict", lambda **_k: "pm2 的 mail-sync 正在运行"
    )

    def _must_not_connect(*_a, **_k):  # pragma: no cover - 触发即失败
        raise AssertionError("冲突时绝不该构造 FeishuConnection")

    monkeypatch.setattr(im_worker, "FeishuConnection", _must_not_connect)
    monkeypatch.setattr(
        im_worker, "ensure_credentials", lambda *a, **k: SimpleNamespace(
            app_id="cli_x", app_secret="s"
        )
    )

    store = FakeStateStore()
    w = FeishuImWorker(cfg=_cfg(), sync_store=store)
    task = asyncio.create_task(w.run())
    await asyncio.sleep(0.08)
    assert store.data[im_state.STATE_CONFLICT] == "1"
    assert store.data[im_state.STATE_CONNECTION_STATUS] == im_state.STATUS_CONFLICT
    assert store.data[im_state.STATE_CONFLICT_REASON]

    w.stop()
    await asyncio.wait_for(task, timeout=2)
    assert store.data[im_state.STATE_CONNECTION_STATUS] == im_state.STATUS_STOPPED


@pytest.mark.asyncio
async def test_missing_credentials_at_runtime_backs_off_without_dying(monkeypatch):
    """凭证行被删/损坏 → 落 error 状态 + 退避重判，**不 return**（否则 supervise 判死亡）。"""
    monkeypatch.setattr(im_worker, "CREDENTIAL_RECHECK_SEC", 0.02)
    monkeypatch.setattr(im_worker, "MONITOR_POLL_SEC", 0.01)
    monkeypatch.setattr(im_worker, "detect_pm2_conflict", lambda **_k: None)
    monkeypatch.setattr(im_worker, "ensure_credentials", lambda *a, **k: None)

    store = FakeStateStore()
    w = FeishuImWorker(cfg=_cfg(), sync_store=store)
    task = asyncio.create_task(w.run())
    await asyncio.sleep(0.08)
    assert store.data[im_state.STATE_CONNECTION_STATUS] == im_state.STATUS_ERROR
    assert not task.done()  # 还活着，没把「没配置」表达成 return

    w.stop()
    await asyncio.wait_for(task, timeout=2)


# ── episode 告警 ────────────────────────────────────────────────────────────


def _worker_with_alerts(delivered=True):
    store = FakeStateStore()
    alerter = FakeAlerter(delivered=delivered)
    tracker = AlertEpisodeTracker(store, enabled=True)
    w = FeishuImWorker(
        cfg=_cfg(), sync_store=store, alerter=alerter, episodes=tracker
    )
    return w, store, alerter


@pytest.mark.asyncio
async def test_below_threshold_stays_silent():
    w, _, alerter = _worker_with_alerts()
    w._unavailable_since = time.monotonic() - 10
    await w._alert_tick(force=True)
    assert alerter.alerts == []


@pytest.mark.asyncio
async def test_enter_then_silent_then_recover():
    w, _, alerter = _worker_with_alerts()

    w._unavailable_since = time.monotonic() - (im_worker.UNAVAILABLE_ALERT_SEC + 1)
    await w._alert_tick(force=True)
    assert len(alerter.alerts) == 1
    assert alerter.alerts[0]["level"] == "warning"

    # episode 内无显著变化（没翻倍）→ 静默，不刷屏
    w._unavailable_since = time.monotonic() - (im_worker.UNAVAILABLE_ALERT_SEC + 20)
    await w._alert_tick(force=True)
    assert len(alerter.alerts) == 1

    # 恢复：一条恢复通知（🔴 必须 ≥ warning，info 会被 ALERT_LEVELS 门吞掉）
    w._clear_unavailable()
    await w._alert_tick(force=True)
    assert alerter.recoveries == ["飞书对话长连接"]


@pytest.mark.asyncio
async def test_two_phase_commit_redelivers_when_send_fails():
    """🔴 投递失败不 commit —— 否则永久标「已告警」却从未送达 = 永久漏告警。"""
    w, store, alerter = _worker_with_alerts(delivered=False)
    w._unavailable_since = time.monotonic() - (im_worker.UNAVAILABLE_ALERT_SEC + 1)
    await w._alert_tick(force=True)
    await w._alert_tick(force=True)
    assert len(alerter.alerts) == 2  # 重发, 不是静默
    assert store.data.get(f"alert.{im_state.EPISODE_UNAVAILABLE}.active") != "1"


@pytest.mark.asyncio
async def test_critical_marker_does_not_false_recover():
    """🔴 一个 episode + 一个 severity marker：值从 critical 区间回落到 warning 区间时
    **不能**报「已恢复」（两个平级 episode 就会）。"""
    w, _, alerter = _worker_with_alerts()

    w._unavailable_since = time.monotonic() - (im_worker.UNAVAILABLE_CRITICAL_SEC + 1)
    await w._alert_tick(force=True)
    assert alerter.alerts[-1]["level"] == "critical"

    # 回落到 [300, 1800) —— 仍然是坏的，只是没那么坏
    w._unavailable_since = time.monotonic() - (im_worker.UNAVAILABLE_ALERT_SEC + 60)
    await w._alert_tick(force=True)
    assert alerter.recoveries == []  # 绝不能误报恢复


@pytest.mark.asyncio
async def test_alert_tick_is_rate_limited():
    w, _, alerter = _worker_with_alerts()
    w._unavailable_since = time.monotonic() - (im_worker.UNAVAILABLE_ALERT_SEC + 1)
    await w._alert_tick(force=True)
    await w._alert_tick()  # 未到 ALERT_TICK_SEC → 不判定
    assert len(alerter.alerts) == 1


@pytest.mark.asyncio
async def test_no_alerter_is_not_a_crash():
    store = FakeStateStore()
    w = FeishuImWorker(cfg=_cfg(), sync_store=store, alerter=None, episodes=None)
    w._unavailable_since = time.monotonic() - 10_000
    await w._alert_tick(force=True)  # 不抛


# ── 杂项 ────────────────────────────────────────────────────────────────────


class TestLazySender:
    def test_unbound_sender_fails_loudly_not_silently(self):
        assert _LazySender().create_message("ou_x", "text", {"text": "hi"}) is None

    def test_binds_to_connection_sender(self):
        sent = []

        class _S:
            def create_message(self, receive_id, msg_type, content):
                sent.append((receive_id, msg_type, content))
                return "om_1"

        proxy = _LazySender()
        proxy.bind(SimpleNamespace(sender=_S()))
        assert proxy.create_message("ou_x", "text", {"text": "hi"}) == "om_1"
        assert sent


def test_stop_is_idempotent():
    w = FeishuImWorker(cfg=_cfg(), sync_store=FakeStateStore())
    w.stop()
    w.stop()  # 不抛


class TestLazySenderPatch:
    def test_unbound_patch_fails_loudly(self):
        assert _LazySender().patch_message("om_x", {"schema": "2.0"}) is False

    def test_patch_proxies_to_connection_sender(self):
        patched = []

        class _S:
            def patch_message(self, message_id, content):
                patched.append((message_id, content))
                return True

        proxy = _LazySender()
        proxy.bind(SimpleNamespace(sender=_S()))
        assert proxy.patch_message("om_1", {"schema": "2.0"}) is True
        assert patched == [("om_1", {"schema": "2.0"})]


@pytest.mark.asyncio
async def test_serve_connection_wires_bridge_and_card_handler(monkeypatch):
    """PR-3 接线闸：_serve_connection 必须把 bridge 的 owner_handler 与
    card_action_handler（非 None）接进连接 —— 漏接 = 审批按钮点了没人理。"""
    captured = {}

    class _FakeConn:
        def __init__(self, app_id, app_secret, **kwargs):
            captured.update(kwargs)
            self.fatal_error = None
            self.sender = None
            self.api_client = None

        def start(self, **_k):
            return True

        def is_alive(self):
            return False  # 立刻退出监控循环

        def is_connected(self):
            return False

        def stop(self):
            pass

    monkeypatch.setattr(im_worker, "FeishuConnection", _FakeConn)
    monkeypatch.setattr(im_worker, "detect_pm2_conflict", lambda **_k: None)
    monkeypatch.setattr(
        im_worker,
        "ensure_credentials",
        lambda *a, **k: SimpleNamespace(app_id="cli_x", app_secret="s"),
    )
    monkeypatch.setattr(im_worker, "RECONNECT_RETRY_SEC", 0.01)
    monkeypatch.setattr(im_worker, "MONITOR_POLL_SEC", 0.01)

    w = FeishuImWorker(cfg=_cfg(), sync_store=FakeStateStore())
    task = asyncio.create_task(w.run())
    await asyncio.sleep(0.1)
    w.stop()
    await asyncio.wait_for(task, timeout=2)

    assert callable(captured.get("message_handler"))
    # 🔴 卡片回调必须接上（wrap_card_action_handler 包过的 callable）
    assert callable(captured.get("card_action_handler"))
