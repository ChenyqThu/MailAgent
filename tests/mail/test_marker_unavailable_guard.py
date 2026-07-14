"""L3 (task 07-14, fork d9b90ecb 上游化): marker 查询失败不得伪装成 0。

洞: get_current_max_row_id 失败曾 return 0, 与「真实 marker 0」(applescript 空邮箱)
不可区分; 首次 baseline (new_watcher.start) 把 0 持久化 → 下轮 check_for_changes
拿真实 UIDNEXT 与 0 求差误判几十万封 → get_new_emails(0) 对 INBOX 发 `UID 1:*`
全量重刷 (7万+ INBOX 实测 STATUS 超时触发过)。

修后语义 (本文件锚死):
- 查询失败 raise MarkerUnavailableError (davmail STATUS 超时 / Envelope Index 打不开);
- check_for_changes 捕获 → (False, last, 0) 本轮跳过, marker 不动, 下轮自愈;
- 首次 baseline: 带 backoff 重试 3 次, 仍失败 raise RuntimeError (宁可不启动,
  绝不落 0 毒 marker); 真实 0 (applescript 空邮箱) 仍照常落库 (`is None` 判定)。

davmail backend 侧 (timeout 可配 DAVMAIL_STATUS_TIMEOUT_SEC + raise) 的用例在
tests/mail/backend/test_davmail_backend.py。
"""
from __future__ import annotations

import asyncio
import sqlite3

import pytest

from src.mail.backend.base import MarkerUnavailableError
from src.mail.new_watcher import NewWatcher
from src.mail.sqlite_radar import SQLiteRadar
from src.mail.sync_store import SyncStore


# =========================================================================
# SQLiteRadar: 真实 0 (空邮箱) vs 查询失败 (raise)
# =========================================================================


def _radar(db_path):
    radar = SQLiteRadar.__new__(SQLiteRadar)
    radar.db_path = db_path
    radar.mailboxes = ["收件箱"]
    radar.account_url_prefix = ""
    radar._last_max_row_id = 0
    return radar


def test_radar_empty_mailbox_returns_real_zero(tmp_path):
    """真实空邮箱 → 返回 0 且不 raise (合法 baseline, 与失败区分开)."""
    db = tmp_path / "Envelope Index"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE messages (mailbox INTEGER, deleted INTEGER)")
    conn.execute("CREATE TABLE mailboxes (url TEXT)")
    conn.commit()
    conn.close()
    assert _radar(db).get_current_max_row_id() == 0


def test_radar_query_failure_raises(tmp_path):
    """Envelope Index 打不开 → raise MarkerUnavailableError (不再塌成 0)."""
    radar = _radar(tmp_path / "nonexistent-dir" / "Envelope Index")
    with pytest.raises(MarkerUnavailableError):
        radar.get_current_max_row_id()


def test_radar_no_db_path_raises():
    """db_path 未配置 → 同样按失败 raise (原 return 0)."""
    with pytest.raises(MarkerUnavailableError):
        _radar(None).get_current_max_row_id()


def test_radar_check_for_changes_failsafe(tmp_path):
    """查询失败 → 本轮 (False, last, 0) 跳过, marker 不动."""
    radar = _radar(tmp_path / "nonexistent-dir" / "Envelope Index")
    assert radar.check_for_changes(last_max_row_id=100) == (False, 100, 0)


def test_radar_has_new_emails_failsafe_keeps_state(tmp_path):
    """has_new_emails 经 check_for_changes fail-safe: 不误推进内部 _last_max_row_id."""
    radar = _radar(tmp_path / "nonexistent-dir" / "Envelope Index")
    radar._last_max_row_id = 100
    assert radar.has_new_emails() == (False, 0)
    assert radar._last_max_row_id == 100


# =========================================================================
# NewWatcher.start 首次 baseline: 失败绝不落 0
# =========================================================================


class _MarkerBackend:
    """get_current_max_row_id 按脚本依次返回 (Exception 实例则 raise)."""

    def __init__(self, results):
        self._results = list(results)
        self.set_marker_calls = []

    def is_available(self):
        return True

    def get_current_max_row_id(self):
        r = self._results.pop(0)
        if isinstance(r, Exception):
            raise r
        return r

    def set_last_max_row_id(self, row_id):
        self.set_marker_calls.append(row_id)


def _baseline_watcher(tmp_path, backend):
    """NewWatcher harness: 只跑 start() 的 baseline 段, 主循环一轮即停."""
    w = NewWatcher.__new__(NewWatcher)
    w.sync_store = SyncStore(str(tmp_path / "t.db"))
    w.backend = backend
    w._running = False
    w._stats = {"polls": 0, "errors": 0, "consecutive_errors": 0}
    w.poll_interval = 0
    w._check_health = lambda: True

    async def _stop_loop():
        w._running = False

    w._poll_cycle = _stop_loop

    async def _noop_flush():
        return

    w._flush_v4_rollout_stats_loop = _noop_flush
    return w


def _patch_fast_sleep(monkeypatch):
    """把 baseline backoff 的 asyncio.sleep(2) 加速成 sleep(0) (仍让出控制权)."""
    real_sleep = asyncio.sleep

    async def fast_sleep(delay, *args, **kwargs):
        await real_sleep(0)

    monkeypatch.setattr(asyncio, "sleep", fast_sleep)


def test_first_run_baseline_never_persists_zero_on_failure(tmp_path, monkeypatch):
    """3 次重试耗尽 → raise RuntimeError; 全程未落任何 marker (更未落 0)."""
    _patch_fast_sleep(monkeypatch)
    backend = _MarkerBackend([
        MarkerUnavailableError("t1"),
        MarkerUnavailableError("t2"),
        MarkerUnavailableError("t3"),
    ])
    w = _baseline_watcher(tmp_path, backend)
    with pytest.raises(RuntimeError, match="baseline marker"):
        asyncio.run(w.start())
    assert w.sync_store.get_state("last_max_row_id") is None  # 从未持久化
    assert w.sync_store.get_state("marker_backend") is None   # 归属也未盖
    assert backend.set_marker_calls == []


def test_first_run_baseline_recovers_after_transient_failure(tmp_path, monkeypatch):
    """前 2 次瞬时失败、第 3 次成功 → baseline 落真值 (重试容错)."""
    _patch_fast_sleep(monkeypatch)
    backend = _MarkerBackend([
        MarkerUnavailableError("t1"),
        MarkerUnavailableError("t2"),
        250_000,
    ])
    w = _baseline_watcher(tmp_path, backend)
    asyncio.run(w.start())
    assert w.sync_store.get_last_max_row_id() == 250_000
    assert w.sync_store.get_state("marker_backend") is not None  # issue #34 归属已盖
    assert backend.set_marker_calls == [250_000]


def test_first_run_baseline_accepts_genuine_zero(tmp_path):
    """applescript 空邮箱真实 baseline 0 → 照常落库不 raise (`is None` 而非 `not` 的边界)."""
    backend = _MarkerBackend([0])
    w = _baseline_watcher(tmp_path, backend)
    asyncio.run(w.start())
    assert w.sync_store.get_state("last_max_row_id") == "0"  # 真实 0 已持久化
    assert backend.set_marker_calls == [0]
