"""Regression tests for src/mail/davmail_watchdog.py.

覆盖:
  - token age 计算 (mock time.time + token.dat mtime)
  - probe_tcp 通断 (asyncio.open_connection mock)
  - log tail OAuth 失败检测 + 5min 窗口 throttle 计数
  - 没 timestamp 的 stack trace 续行不被误计入
  - alert 跃迁: 进程 down→recovered, oauth 错误新→重复不重发,
    EWS throttle burst 进入/解除时切换 uid_backfill_paused
  - get_snapshot() 返回 in-memory 快照
  - 关键 sync_state keys 全部写入
"""
from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import time
import unittest.mock as um
from datetime import datetime
from pathlib import Path

import pytest

from src.mail.davmail_watchdog import (
    DavMailWatchdog,
    _EWS_THROTTLE_RE,
    _OAUTH_FAIL_RE,
)
from src.mail.sync_store import SyncStore
from src.notify.center import NotifyCenter
from src.notify.episode import AlertEpisodeTracker


# ────────────────────────────────────────────────────────────────
# Fixtures
# ────────────────────────────────────────────────────────────────


@pytest.fixture
def davmail_root(tmp_path: Path) -> Path:
    """构造一个假的 davmail-poc 目录树."""
    root = tmp_path / "davmail-poc"
    (root / "token").mkdir(parents=True)
    (root / "logs").mkdir(parents=True)
    return root


@pytest.fixture
def write_token(davmail_root: Path):
    """返回一个 helper: 写 token.dat 并把 mtime 设到 (now - age_seconds)."""

    def _write(age_seconds: float = 0.0, content: bytes = b"dummy") -> Path:
        p = davmail_root / "token" / "token.dat"
        p.write_bytes(content)
        if age_seconds > 0:
            t = time.time() - age_seconds
            os.utime(p, (t, t))
        return p

    return _write


@pytest.fixture
def write_log(davmail_root: Path):
    """返回 helper: 写 davmail.log."""

    def _write(text: str) -> Path:
        p = davmail_root / "logs" / "davmail.log"
        p.write_text(text)
        return p

    return _write


@pytest.fixture
def sync_store(tmp_path: Path) -> SyncStore:
    return SyncStore(db_path=str(tmp_path / "sync_store.db"))


class _FakeAlerter:
    """记录所有调用而不真发送.

    task 07-14: 真实 ``alert_*`` 现在返回投递结果 bool (token 告警的两阶段提交
    靠它决定是否 commit) → 这里跟着返回 ``self.delivered``; 置 False 可模拟
    投递失败 (飞书挂 / level 门 / cooldown 门)。其余告警不读返回值, 不受影响。
    """

    def __init__(self, delivered: bool = True):
        self.calls: list[tuple[str, tuple, dict]] = []
        self.delivered = delivered

    def __getattr__(self, name):
        async def _cap(*args, **kwargs):
            self.calls.append((name, args, kwargs))
            return self.delivered
        return _cap


# ────────────────────────────────────────────────────────────────
# Regex smoke
# ────────────────────────────────────────────────────────────────


def test_oauth_regex_matches_known_failure_modes():
    samples = [
        "ERROR davmail.exchange javax.crypto.BadPaddingException: Given final block",
        "AADSTS50173: The provided grant has expired",
        "AADSTS70008: refresh token expired",
        "Token refresh failed: refresh_token expired",
        "error: invalid_grant",
        "ERROR refresh_token is invalid",
        "TokenExpiredException: token no longer valid",
    ]
    for s in samples:
        assert _OAUTH_FAIL_RE.search(s), f"should match: {s}"


def test_oauth_regex_ignores_normal_lines():
    for s in [
        "INFO logged in successfully",
        "DEBUG fetching new uid 1234",
        "DEBUG passing through grant for user",  # 没匹配 invalid_grant 全词
    ]:
        assert not _OAUTH_FAIL_RE.search(s), f"should NOT match: {s}"


def test_ews_throttle_regex():
    assert _EWS_THROTTLE_RE.search(
        "EWSThrottlingException: The server cannot service this request right now"
    )
    assert _EWS_THROTTLE_RE.search("davmail.exchange.ews.EWSThrottlingException")
    assert not _EWS_THROTTLE_RE.search("INFO successful fetch")


# ────────────────────────────────────────────────────────────────
# Token age
# ────────────────────────────────────────────────────────────────


def test_token_age_returns_none_when_missing(
    sync_store: SyncStore, davmail_root: Path
):
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root
    )
    age, mtime = wd._compute_token_age()
    assert age is None and mtime is None


def test_token_age_recent_file(
    sync_store: SyncStore, davmail_root: Path, write_token
):
    write_token(age_seconds=86400 * 5)  # 5 天前
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root
    )
    age, _ = wd._compute_token_age()
    assert age is not None
    assert 4.9 < age < 5.1, f"expected ~5d, got {age}"


def test_token_age_thresholds_drive_level(
    sync_store: SyncStore, davmail_root: Path, write_token
):
    # 关键阈值: warning ≥80, critical ≥87
    for age_days, expected_level in [
        (50, "ok"),
        (80, "warning"),
        (86, "warning"),
        (87, "critical"),
        (95, "critical"),
    ]:
        write_token(age_seconds=86400 * age_days)
        wd = DavMailWatchdog(
            sync_store=sync_store, alerter=None, davmail_root=davmail_root
        )
        level = wd._compute_overall_level(
            imap_ok=True,
            smtp_ok=True,
            token_age_days=age_days,
            oauth_error_active=False,
            throttle_burst=False,
        )
        assert level == expected_level, f"age={age_days} → expected {expected_level}, got {level}"


# ────────────────────────────────────────────────────────────────
# Log tail
# ────────────────────────────────────────────────────────────────


def test_log_tail_no_file(sync_store: SyncStore, davmail_root: Path):
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root
    )
    err, throttle = wd._scan_log_tail()
    assert err is None and throttle == 0


def test_log_tail_picks_up_oauth_failure(
    sync_store: SyncStore, davmail_root: Path, write_log
):
    write_log(
        "2026-05-22 14:00:00,000 INFO logged in\n"
        "2026-05-22 14:30:00,000 ERROR refresh_token expired\n"
        "2026-05-22 14:31:00,000 INFO trying again\n"
    )
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root
    )
    err, _ = wd._scan_log_tail()
    assert err is not None
    assert "refresh_token expired" in err


def test_log_tail_throttle_within_5min(
    sync_store: SyncStore, davmail_root: Path, write_log
):
    # 用当前时间生成 4 条 throttle, 最早 4min 前 → 全在 5min 窗口内
    now = time.time()
    lines = []
    for offset_sec in (4 * 60, 3 * 60, 2 * 60, 60):
        ts = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now - offset_sec))
        lines.append(f"{ts},000 ERROR EWSThrottlingException: throttle!")
    write_log("\n".join(lines))
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root
    )
    _, throttle = wd._scan_log_tail()
    assert throttle == 4


def test_log_tail_throttle_ignores_old_events(
    sync_store: SyncStore, davmail_root: Path, write_log
):
    # 10min 前的 throttle 不应进 5min 窗口
    old_ts = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time() - 600))
    write_log(f"{old_ts},000 ERROR EWSThrottlingException: throttle!")
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root
    )
    _, throttle = wd._scan_log_tail()
    assert throttle == 0, "10min ago should be outside 5min window"


def test_log_tail_does_not_count_stack_trace_continuation(
    sync_store: SyncStore, davmail_root: Path, write_log
):
    """关键回归: stack trace 续行没 log4j timestamp 必须 ignore,
    否则单次 throttle 事件被算成 ≥3 次假性 burst."""
    now_ts = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time() - 30))
    write_log(
        f"{now_ts},000 ERROR The server cannot service this request right now.\n"
        "davmail.exchange.ews.EWSThrottlingException: The server cannot service\n"
        "\tat davmail.exchange.ews.EwsExchangeSession.fetch(...)\n"
        "\tat davmail.imap.ImapConnection.handleCommand(...)\n"
    )
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root
    )
    _, throttle = wd._scan_log_tail()
    assert throttle == 1, f"应只数 1 个 timestamp 头行, got {throttle}"


# ────────────────────────────────────────────────────────────────
# Probe
# ────────────────────────────────────────────────────────────────


async def test_probe_tcp_success(sync_store: SyncStore, davmail_root: Path):
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root
    )

    async def fake_open(*args, **kwargs):
        w = um.MagicMock()
        w.close = um.MagicMock()
        # wait_closed must be a coroutine
        async def _wc():
            return None
        w.wait_closed = _wc
        return (None, w)

    with um.patch("asyncio.open_connection", side_effect=fake_open):
        ok = await wd._probe_tcp("127.0.0.1", 1143)
        assert ok is True


async def test_probe_tcp_refused(sync_store: SyncStore, davmail_root: Path):
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root
    )

    async def fake_refused(*args, **kwargs):
        raise ConnectionRefusedError()

    with um.patch("asyncio.open_connection", side_effect=fake_refused):
        ok = await wd._probe_tcp("127.0.0.1", 1143)
        assert ok is False


async def test_probe_tcp_timeout(sync_store: SyncStore, davmail_root: Path):
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root,
        probe_timeout=0.05,
    )

    async def fake_hang(*args, **kwargs):
        await asyncio.sleep(5)

    with um.patch("asyncio.open_connection", side_effect=fake_hang):
        ok = await wd._probe_tcp("127.0.0.1", 1143)
        assert ok is False


# ────────────────────────────────────────────────────────────────
# End-to-end tick: state writes + alert transitions
# ────────────────────────────────────────────────────────────────


async def _patch_probe(wd, imap_ok: bool, smtp_ok: bool):
    async def fake(host, port):
        if port == wd.imap_port:
            return imap_ok
        if port == wd.smtp_port:
            return smtp_ok
        return False
    wd._probe_tcp = fake  # type: ignore[method-assign]


async def test_tick_writes_all_sync_state_keys(
    sync_store: SyncStore, davmail_root: Path, write_token
):
    write_token(age_seconds=86400 * 5)
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root
    )
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    await wd._tick()

    for key in (
        "davmail.last_probe_at",
        "davmail.imap_reachable",
        "davmail.smtp_reachable",
        "davmail.token_age_days",
        "davmail.token_mtime_iso",
        "davmail.consecutive_imap_failures",
        "davmail.consecutive_smtp_failures",
        "davmail.imap_login_ok",
        "davmail.consecutive_login_failures",
        "davmail.throttle_events_5min",
    ):
        assert sync_store.get_state(key) is not None, f"missing key {key}"

    assert sync_store.get_state("davmail.imap_reachable") == "1"
    assert sync_store.get_state("davmail.smtp_reachable") == "1"


async def test_tick_snapshot_level_ok(
    sync_store: SyncStore, davmail_root: Path, write_token
):
    write_token(age_seconds=86400 * 1)
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root
    )
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    await wd._tick()
    snap = wd.get_snapshot()
    assert snap["level"] == "ok"
    assert snap["imap_reachable"] is True
    assert snap["smtp_reachable"] is True


async def test_process_down_alert_fires_once(
    sync_store: SyncStore, davmail_root: Path
):
    alerter = _FakeAlerter()
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=alerter, davmail_root=davmail_root  # type: ignore[arg-type]
    )
    await _patch_probe(wd, imap_ok=False, smtp_ok=True)
    # 3 次连续失败 → critical
    for _ in range(3):
        await wd._tick()
    process_down_calls = [c for c in alerter.calls if c[0] == "alert_davmail_process_down"]
    assert len(process_down_calls) == 1, "should fire once at threshold"
    # 第 4 次仍然失败但不再 alert
    await wd._tick()
    process_down_calls = [c for c in alerter.calls if c[0] == "alert_davmail_process_down"]
    assert len(process_down_calls) == 1, "should not re-fire while still down"


async def test_process_recovery_alert(
    sync_store: SyncStore, davmail_root: Path
):
    alerter = _FakeAlerter()
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=alerter, davmail_root=davmail_root  # type: ignore[arg-type]
    )
    # 3 次失败触发 down
    await _patch_probe(wd, imap_ok=False, smtp_ok=True)
    for _ in range(3):
        await wd._tick()
    # 恢复
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    await wd._tick()
    recovery_calls = [c for c in alerter.calls if c[0] == "alert_davmail_process_recovered"]
    assert len(recovery_calls) == 1


async def test_token_alert_repeats_every_tick_without_episode_tracker(
    sync_store: SyncStore, davmail_root: Path, write_token
):
    """task 07-14: 未注入 episodes (老调用方 / flag off) → 逐字老行为 = 每轮都告."""
    write_token(age_seconds=82 * 86400)
    alerter = _FakeAlerter()
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=alerter, davmail_root=davmail_root  # type: ignore[arg-type]
    )
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    for _ in range(3):
        await wd._tick()
    calls = [c for c in alerter.calls if c[0] == "alert_davmail_token_expiring"]
    assert len(calls) == 3


async def test_token_alert_episode_fires_once_then_silent(
    sync_store: SyncStore, davmail_root: Path, write_token
):
    """task 07-14: 注入 tracker → 进门槛告一次, 后续静默 (老实现每 5min 一条)."""
    write_token(age_seconds=82 * 86400)
    alerter = _FakeAlerter()
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=alerter, davmail_root=davmail_root,  # type: ignore[arg-type]
        episodes=AlertEpisodeTracker(sync_store),
    )
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    for _ in range(4):
        await wd._tick()
    calls = [c for c in alerter.calls if c[0] == "alert_davmail_token_expiring"]
    assert len(calls) == 1


async def test_token_episode_critical_supersedes_expiring_and_recovers(
    sync_store: SyncStore, davmail_root: Path, write_token
):
    """critical 活跃期间不发 warning 级; 重新 OAuth (age 归零) → 恢复通知 + 复位."""
    write_token(age_seconds=89 * 86400)
    alerter = _FakeAlerter()
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=alerter, davmail_root=davmail_root,  # type: ignore[arg-type]
        episodes=AlertEpisodeTracker(sync_store),
    )
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    await wd._tick()
    await wd._tick()
    assert len([c for c in alerter.calls if c[0] == "alert_davmail_token_critical"]) == 1
    assert [c for c in alerter.calls if c[0] == "alert_davmail_token_expiring"] == []

    # 重新走 O365Manual OAuth → token.dat 刷新, age 归零
    write_token(age_seconds=0)
    await wd._tick()
    assert len([c for c in alerter.calls if c[0] == "alert_recovery"]) == 1
    assert sync_store.get_state("alert.davmail_token_critical.active") == "0"
    assert sync_store.get_state("alert.davmail_token.active") == "0"

    # 复位后再次劣化 → 新 episode 能重新告警 (episode 没卡在 active)
    write_token(age_seconds=82 * 86400)
    await wd._tick()
    assert len([c for c in alerter.calls if c[0] == "alert_davmail_token_expiring"]) == 1


async def test_token_critical_downgrade_to_warning_zone_is_not_a_recovery(
    sync_store: SyncStore, davmail_root: Path, write_token
):
    """🔴 HIGH-3: 89 → 82 (仍在 ≥80 warning 区间) 绝不能报「token 已恢复」.

    两个平级 episode 的写法下, 89 时 critical/expiring 都被标 active, 82 时
    critical 判 RECOVER → 误发恢复通知, 而 token 其实还在告警区间。
    """
    write_token(age_seconds=89 * 86400)
    alerter = _FakeAlerter()
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=alerter, davmail_root=davmail_root,  # type: ignore[arg-type]
        episodes=AlertEpisodeTracker(sync_store),
    )
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    await wd._tick()
    assert len([c for c in alerter.calls if c[0] == "alert_davmail_token_critical"]) == 1

    # age 降到 82: 严重度回落但仍在 warning 区间 → 不是恢复
    write_token(age_seconds=82 * 86400)
    await wd._tick()
    assert [c for c in alerter.calls if c[0] == "alert_recovery"] == [], (
        "token 仍 ≥80 天, 不得报恢复"
    )
    # episode 本体仍 active (用户已知情), 只有 severity marker 复位
    assert sync_store.get_state("alert.davmail_token.active") == "1"
    assert sync_store.get_state("alert.davmail_token_critical.active") == "0"

    # 真正重走 OAuth (age→0) 才发恢复, 且只发一条
    write_token(age_seconds=0)
    await wd._tick()
    assert len([c for c in alerter.calls if c[0] == "alert_recovery"]) == 1


async def test_token_warning_then_critical_then_downgrade_then_recover(
    sync_store: SyncStore, davmail_root: Path, write_token
):
    """HIGH-3 全序列 82 → 89 → 82 → 0: 各阶段恰好一条消息, 无重复无假恢复."""
    alerter = _FakeAlerter()
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=alerter, davmail_root=davmail_root,  # type: ignore[arg-type]
        episodes=AlertEpisodeTracker(sync_store),
    )
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)

    def _names():
        return [c[0] for c in alerter.calls if c[0].startswith(("alert_davmail_token", "alert_recovery"))]

    write_token(age_seconds=82 * 86400)
    await wd._tick()
    await wd._tick()  # 第二轮静默
    assert _names() == ["alert_davmail_token_expiring"]

    write_token(age_seconds=89 * 86400)  # 升级到 critical
    await wd._tick()
    await wd._tick()
    assert _names() == ["alert_davmail_token_expiring", "alert_davmail_token_critical"]

    write_token(age_seconds=82 * 86400)  # 降级回 warning 区间 → 静默, 无假恢复
    await wd._tick()
    assert _names() == ["alert_davmail_token_expiring", "alert_davmail_token_critical"]

    write_token(age_seconds=0)  # 重走 OAuth → 真恢复
    await wd._tick()
    await wd._tick()
    assert _names() == [
        "alert_davmail_token_expiring",
        "alert_davmail_token_critical",
        "alert_recovery",
    ]


async def test_token_alert_undelivered_is_retried_not_silenced(
    sync_store: SyncStore, davmail_root: Path, write_token
):
    """HIGH-1 (watchdog 侧): token 告警投递失败 → 不提交 → 下轮重发."""
    write_token(age_seconds=82 * 86400)
    alerter = _FakeAlerter(delivered=False)
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=alerter, davmail_root=davmail_root,  # type: ignore[arg-type]
        episodes=AlertEpisodeTracker(sync_store),
    )
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    for _ in range(3):
        await wd._tick()
    assert len([c for c in alerter.calls if c[0] == "alert_davmail_token_expiring"]) == 3
    assert sync_store.get_state("alert.davmail_token.active") in (None, "")

    alerter.delivered = True
    await wd._tick()
    await wd._tick()  # 投递成功后才静默
    assert len([c for c in alerter.calls if c[0] == "alert_davmail_token_expiring"]) == 4


async def test_ews_throttle_burst_pauses_uid_backfill(
    sync_store: SyncStore, davmail_root: Path, write_log
):
    alerter = _FakeAlerter()
    # 注入 4 条 fresh throttle 事件 → burst (>=3) 触发
    now = time.time()
    lines = []
    for off in (200, 150, 100, 50):
        ts = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now - off))
        lines.append(f"{ts},000 ERROR EWSThrottlingException")
    write_log("\n".join(lines))
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=alerter, davmail_root=davmail_root  # type: ignore[arg-type]
    )
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    await wd._tick()
    # 应触发 throttle alert + 写 paused=true + fresh 时间戳 (消费侧 staleness 兜底用)
    throttle_calls = [c for c in alerter.calls if c[0] == "alert_davmail_ews_throttling"]
    assert len(throttle_calls) == 1
    assert sync_store.get_state("davmail_uid_backfill_paused") == "true"
    paused_at = sync_store.get_state("davmail_uid_backfill_paused_at")
    assert paused_at is not None and float(paused_at) > 0

    # 清空 log 再 tick → 解除暂停 + 清时间戳
    write_log("")
    await wd._tick()
    assert sync_store.get_state("davmail_uid_backfill_paused") == "false"
    assert sync_store.get_state("davmail_uid_backfill_paused_at") == ""


def test_init_reseeds_throttle_burst_from_persistent_flag(
    sync_store: SyncStore, davmail_root: Path
):
    """🔴 blocker 修复: 持久 flag='true' → __init__ 回种内存态 True。

    否则进程重启后若 throttle 已消退, set 分支 (要 in_burst) 与复位分支 (要内存 True)
    都进不去 → 持久 flag 永久卡 'true' → 两个消费者 (uid-mapper / watcher) 永久停摆。
    """
    sync_store.set_state("davmail_uid_backfill_paused", "true")
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root
    )
    assert wd._announced_throttle_burst is True


def test_init_throttle_burst_defaults_false_without_flag(
    sync_store: SyncStore, davmail_root: Path
):
    """flag 缺省 / 'false' → 回种 False (不误判为限流中)。"""
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root
    )
    assert wd._announced_throttle_burst is False

    sync_store.set_state("davmail_uid_backfill_paused", "false")
    wd2 = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root
    )
    assert wd2._announced_throttle_burst is False


async def test_reseeded_pause_self_heals_after_throttle_clears(
    sync_store: SyncStore, davmail_root: Path, write_log
):
    """blocker 修复端到端: 上一进程置 flag='true' 后崩溃 → 本进程 __init__ 回种
    memory True → throttle 已消退 (log 干净) 的第一轮 tick 走复位分支把持久 flag
    写回 'false' → 消费者恢复。这是「自愈链」的完整证明。"""
    sync_store.set_state("davmail_uid_backfill_paused", "true")
    # 陈旧 log: throttle 早已消退, 本轮 throttle_count==0
    write_log("2020-01-01 00:00:00,000 INFO nothing throttling here\n")

    alerter = _FakeAlerter()
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=alerter, davmail_root=davmail_root  # type: ignore[arg-type]
    )
    assert wd._announced_throttle_burst is True  # 回种

    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    await wd._tick()

    # 干净一轮 (throttle_count==0 且内存 True) → 复位分支触发 → 自愈
    assert sync_store.get_state("davmail_uid_backfill_paused") == "false"
    assert wd._announced_throttle_burst is False


async def test_throttle_pause_heartbeat_keeps_pause_fresh_past_staleness(
    sync_store: SyncStore, davmail_root: Path, monkeypatch
):
    """心跳: burst 持续超过 30min staleness 阈值, 消费侧仍判 paused。

    PAUSE_AT_KEY = watchdog 存活心跳 (每轮 tick 刷新), 而非置位时刻 → 持续限流
    >30min 不再被 staleness 误放行 (原盲区: backfill+poll 恢复发请求反而加剧 throttle)。
    alerter=None (生产默认 ALERT_ENABLED=false) 下 pause 仍被管理 (独立于
    _evaluate_alerts 的 alerter-None 早退)。
    """
    from src.mail.throttle_pause import (
        PAUSE_AT_KEY,
        PAUSE_KEY,
        is_uid_backfill_paused,
    )

    clock = {"t": 1_000_000.0}
    monkeypatch.setattr(time, "time", lambda: clock["t"])

    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root
    )

    # tick 1: 进入 burst → 置 flag + 心跳时间戳 (alerter=None 也照置)
    await wd._update_throttle_pause(throttle_count=4)
    assert sync_store.get_state(PAUSE_KEY) == "true"
    assert float(sync_store.get_state(PAUSE_AT_KEY)) == 1_000_000.0
    assert is_uid_backfill_paused(sync_store) is True

    # 时间推进 45min (> 30min 默认上限), burst 仍持续 → 心跳刷新时间戳
    clock["t"] += 2700.0
    await wd._update_throttle_pause(throttle_count=4)
    # 心跳把时间戳刷到当前 → age≈0 → 消费侧仍判 paused (无 30min 反噬)
    assert float(sync_store.get_state(PAUSE_AT_KEY)) == 1_002_700.0
    assert is_uid_backfill_paused(sync_store) is True

    # 反证: 若时间戳停在 tick1 的旧值 (无心跳), 此刻 age=2700>1800 会被判超龄放行
    sync_store.set_state(PAUSE_AT_KEY, "1000000.0")
    assert is_uid_backfill_paused(sync_store) is False


async def test_reseeded_pause_backfills_timestamp_while_in_burst(
    sync_store: SyncStore, davmail_root: Path, write_log
):
    """旧版无时间戳 paused=true 重启且仍在 burst → __init__ 回种 announced=True,
    下一轮 tick 心跳补写时间戳 → 消费侧从 (无时间戳被误放行) 恢复 paused。

    走完整 _tick 且 alerter=None → 证明 pause 管理不被 _evaluate_alerts 的
    alerter-None 早退挡住。"""
    from src.mail.throttle_pause import (
        PAUSE_AT_KEY,
        PAUSE_KEY,
        is_uid_backfill_paused,
    )

    # 上一进程留下无时间戳的 pause (老数据 / 崩溃前只写了 flag)
    sync_store.set_state(PAUSE_KEY, "true")
    assert is_uid_backfill_paused(sync_store) is False  # 无时间戳 → 此刻被放行

    # 仍在真实 burst: fresh throttle log (>=3 事件)
    now = time.time()
    lines = [
        f"{time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(now - off))},000 "
        f"ERROR EWSThrottlingException"
        for off in (200, 150, 100, 50)
    ]
    write_log("\n".join(lines))

    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root
    )
    assert wd._announced_throttle_burst is True  # 从持久 flag 回种

    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    await wd._tick()

    # 心跳补写时间戳 → 消费侧恢复 paused (不再被 missing-ts 误放行)
    paused_at = sync_store.get_state(PAUSE_AT_KEY)
    assert paused_at is not None and float(paused_at) > 0
    assert is_uid_backfill_paused(sync_store) is True
    assert sync_store.get_state(PAUSE_KEY) == "true"


async def test_throttle_pause_heartbeat_survives_hysteresis_band(
    sync_store: SyncStore, davmail_root: Path, monkeypatch
):
    """滞回区间 (throttle_count 徘徊 1-2) 心跳不停更 (codex R2 finding-1)。

    进入门槛 (>=3) 高于解除门槛 (==0): 4 → 2 徘徊时 in_burst=False 但 announced
    pause 仍在。若只有 in_burst 刷心跳, 这段心跳停更 → 30min 后消费侧误判 stale
    放行 (watchdog 明明活着且认为 paused)。断言滞回区间仍刷心跳、消费侧仍 paused;
    再 2 → 0 走复位分支正常解除。
    """
    from src.mail.throttle_pause import (
        PAUSE_AT_KEY,
        PAUSE_KEY,
        is_uid_backfill_paused,
    )

    clock = {"t": 1_000_000.0}
    monkeypatch.setattr(time, "time", lambda: clock["t"])

    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root
    )

    # tick 1: 进入 burst (4) → 置 flag + 心跳时间戳
    await wd._update_throttle_pause(throttle_count=4)
    assert wd._announced_throttle_burst is True
    assert sync_store.get_state(PAUSE_KEY) == "true"
    assert float(sync_store.get_state(PAUSE_AT_KEY)) == 1_000_000.0

    # tick 2: 时间推进 45min (>30min 上限), throttle 落回 2 (滞回区间, in_burst=False)
    clock["t"] += 2700.0
    await wd._update_throttle_pause(throttle_count=2)
    # 心跳仍刷新 → age≈0 → 消费侧仍 paused (未被 staleness 误放行)
    assert sync_store.get_state(PAUSE_KEY) == "true"
    assert float(sync_store.get_state(PAUSE_AT_KEY)) == 1_002_700.0
    assert is_uid_backfill_paused(sync_store) is True
    assert wd._announced_throttle_burst is True  # 未复位 (仅完全干净一轮才解除)

    # 反证: 若滞回区间不刷心跳, 时间戳会停在 tick1 → age=2700>1800 → 被误放行
    sync_store.set_state(PAUSE_AT_KEY, "1000000.0")
    assert is_uid_backfill_paused(sync_store) is False

    # tick 3: 完全干净一轮 (0) → 复位分支解除 pause
    await wd._update_throttle_pause(throttle_count=0)
    assert sync_store.get_state(PAUSE_KEY) == "false"
    assert sync_store.get_state(PAUSE_AT_KEY) == ""
    assert wd._announced_throttle_burst is False


async def test_throttle_pause_written_before_alert_await(
    sync_store: SyncStore, davmail_root: Path
):
    """保护面先落盘再告警 (codex R2 finding-2): alerter 被 await 时 flag 已 'true'。

    告警走网络 I/O (webhook 单次超时 10s), 若排在 pause 写入前, 网络阻塞会推迟
    backend 保护落盘。断言 alert_davmail_ews_throttling 被 await 的瞬间 sync_state
    里 PAUSE_KEY / PAUSE_AT_KEY 均已置位。
    """
    from src.mail.throttle_pause import PAUSE_AT_KEY, PAUSE_KEY

    seen: dict = {}

    class _OrderCapturingAlerter:
        async def alert_davmail_ews_throttling(self, count):
            seen["flag"] = sync_store.get_state(PAUSE_KEY)
            seen["ts"] = sync_store.get_state(PAUSE_AT_KEY)
            return True

    wd = DavMailWatchdog(
        sync_store=sync_store,
        alerter=_OrderCapturingAlerter(),  # type: ignore[arg-type]
        davmail_root=davmail_root,
    )

    await wd._update_throttle_pause(throttle_count=4)

    assert seen["flag"] == "true", "pause flag 应在告警 await 前已落盘"
    assert seen["ts"] and float(seen["ts"]) > 0, "pause 时间戳应在告警 await 前已落盘"


async def test_tick_writes_pause_before_evaluate_alerts(
    sync_store: SyncStore, davmail_root: Path, write_log
):
    """跨方法顺序锁 (test_throttle_pause_written_before_alert_await 只锁了
    _update_throttle_pause 内部顺序, 锁不住 _tick 里两个方法调用本身的先后)。

    走完整 _tick(), 把 wd._evaluate_alerts 换成 async spy: 断言它被调用时
    sync_state 里 PAUSE_KEY/PAUSE_AT_KEY 已经落盘 (即 _update_throttle_pause
    排在 _evaluate_alerts 之前), 且 spy 确实被调用过 (防 monkeypatch 失效
    平凡绿)。
    """
    from src.mail.throttle_pause import PAUSE_AT_KEY, PAUSE_KEY

    # 造一个真实 burst: fresh throttle log (>=3 事件, 抄
    # test_reseeded_pause_backfills_timestamp_while_in_burst 的喂法)
    now = time.time()
    lines = [
        f"{time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(now - off))},000 "
        f"ERROR EWSThrottlingException"
        for off in (200, 150, 100, 50)
    ]
    write_log("\n".join(lines))

    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root
    )
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)

    seen: dict = {}

    async def fake_evaluate_alerts(**kwargs):
        seen["flag"] = sync_store.get_state(PAUSE_KEY)
        seen["ts"] = sync_store.get_state(PAUSE_AT_KEY)
        seen["called"] = True

    wd._evaluate_alerts = fake_evaluate_alerts  # type: ignore[method-assign]

    await wd._tick()

    assert seen.get("called") is True, "spy 未被调用, 断言无效 (monkeypatch 失效)"
    assert seen["flag"] == "true", "pause flag 应在 _evaluate_alerts 调用前已落盘"
    assert seen["ts"] and float(seen["ts"]) > 0, (
        "pause 时间戳应在 _evaluate_alerts 调用前已落盘"
    )


async def test_oauth_alert_dedupes_repeat_same_error(
    sync_store: SyncStore, davmail_root: Path, write_log
):
    write_log("2026-05-22 14:30:00,000 ERROR refresh_token expired")
    alerter = _FakeAlerter()
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=alerter, davmail_root=davmail_root  # type: ignore[arg-type]
    )
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    await wd._tick()
    await wd._tick()  # 同样的 error 不应重复发
    oauth_calls = [c for c in alerter.calls if c[0] == "alert_davmail_oauth_failure"]
    assert len(oauth_calls) == 1


# ────────────────────────────────────────────────────────────────
# IMAP LOGIN 探测 (L2a, fork 31a50011 上游化)
# ────────────────────────────────────────────────────────────────


def _make_login_wd(
    sync_store: SyncStore,
    davmail_root: Path,
    alerter=None,
    *,
    login_ok: bool = False,
    **kw,
):
    """构造带 cfg 的 watchdog (启用 login 探测), login 探测打桩."""
    wd = DavMailWatchdog(
        sync_store=sync_store,
        alerter=alerter,  # type: ignore[arg-type]
        davmail_root=davmail_root,
        cfg=object(),  # type: ignore[arg-type] — 仅需非 None 启用 login 探测
        **kw,
    )
    wd._probe_imap_login = lambda: login_ok  # type: ignore[method-assign]
    return wd


async def test_login_success_resets_failure_counter(
    sync_store: SyncStore, davmail_root: Path
):
    wd = _make_login_wd(sync_store, davmail_root, login_ok=False)
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    await wd._tick()
    await wd._tick()
    assert wd._consecutive_login_fails == 2
    assert sync_store.get_state("davmail.imap_login_ok") == "0"
    assert sync_store.get_state("davmail.consecutive_login_failures") == "2"

    wd._probe_imap_login = lambda: True  # type: ignore[method-assign]
    await wd._tick()
    assert wd._consecutive_login_fails == 0
    assert sync_store.get_state("davmail.imap_login_ok") == "1"
    assert sync_store.get_state("davmail.consecutive_login_failures") == "0"


async def test_consecutive_login_failures_drive_critical_and_alert_once(
    sync_store: SyncStore, davmail_root: Path, write_token
):
    write_token(age_seconds=86400 * 5)  # token 新鲜, critical 只能来自 login
    alerter = _FakeAlerter()
    wd = _make_login_wd(sync_store, davmail_root, alerter, login_ok=False)
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)

    await wd._tick()
    await wd._tick()
    degraded = [c for c in alerter.calls if c[0] == "alert_davmail_login_degraded"]
    assert degraded == [], "未达阈值 (2 次) 不应告警"
    assert wd.get_snapshot()["level"] == "ok"

    await wd._tick()  # 第 3 次 → 阈值
    degraded = [c for c in alerter.calls if c[0] == "alert_davmail_login_degraded"]
    assert len(degraded) == 1, "达阈值应告警一次"
    assert degraded[0][1] == (3, 3)  # (consecutive_fails, threshold)
    assert wd.get_snapshot()["level"] == "critical"

    await wd._tick()  # 第 4 次持续失败不重发
    degraded = [c for c in alerter.calls if c[0] == "alert_davmail_login_degraded"]
    assert len(degraded) == 1, "持续劣化不应重发 (announce-once-until-cleared)"


async def test_login_recovery_announces_and_resets(
    sync_store: SyncStore, davmail_root: Path, write_token
):
    write_token(age_seconds=86400 * 5)
    alerter = _FakeAlerter()
    wd = _make_login_wd(sync_store, davmail_root, alerter, login_ok=False)
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    for _ in range(3):
        await wd._tick()

    wd._probe_imap_login = lambda: True  # type: ignore[method-assign]
    await wd._tick()
    recovered = [c for c in alerter.calls if c[0] == "alert_davmail_login_recovered"]
    assert len(recovered) == 1
    assert wd._consecutive_login_fails == 0
    assert wd.get_snapshot()["level"] == "ok"


async def test_login_probe_skipped_when_tcp_down(
    sync_store: SyncStore, davmail_root: Path
):
    """TCP 不可达时跳过 login 探测 (进程死亡走独立告警路径, 不误判 token 劣化)."""
    wd = _make_login_wd(sync_store, davmail_root)

    def boom():
        raise AssertionError("TCP down 时不应跑 login 探测")

    wd._probe_imap_login = boom  # type: ignore[method-assign]
    await _patch_probe(wd, imap_ok=False, smtp_ok=True)
    await wd._tick()
    assert sync_store.get_state("davmail.imap_login_ok") == ""


async def test_login_probe_skipped_without_cfg(
    sync_store: SyncStore, davmail_root: Path
):
    """未注入 cfg (老调用方) → 不跑 login 探测, 行为与改动前一致."""
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root
    )

    def boom():
        raise AssertionError("cfg=None 时不应跑 login 探测")

    wd._probe_imap_login = boom  # type: ignore[method-assign]
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    await wd._tick()
    assert sync_store.get_state("davmail.imap_login_ok") == ""


async def test_login_probe_skipped_when_disabled(
    sync_store: SyncStore, davmail_root: Path
):
    """DAVMAIL_LOGIN_PROBE_ENABLED=false → 不探测 (应急回退老三信号)."""
    wd = _make_login_wd(sync_store, davmail_root, login_probe_enabled=False)

    def boom():
        raise AssertionError("开关关时不应跑 login 探测")

    wd._probe_imap_login = boom  # type: ignore[method-assign]
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    await wd._tick()
    assert sync_store.get_state("davmail.imap_login_ok") == ""


def test_login_degraded_drives_level_critical(
    sync_store: SyncStore, davmail_root: Path
):
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root
    )
    level = wd._compute_overall_level(
        imap_ok=True,
        smtp_ok=True,
        token_age_days=5.0,
        oauth_error_active=False,
        throttle_burst=False,
        login_degraded=True,
    )
    assert level == "critical"


def test_probe_imap_login_success_and_failure(
    sync_store: SyncStore, davmail_root: Path, monkeypatch
):
    """真实现: imap_connect 成功 → True; DavMailConnectionError → False (不冒泡)."""
    import src.mail.backend.imap_client as imap_client_mod
    from src.mail.backend.imap_client import DavMailConnectionError

    wd = DavMailWatchdog(
        sync_store=sync_store,
        alerter=None,
        davmail_root=davmail_root,
        cfg=object(),  # type: ignore[arg-type]
    )

    class _FakeImap:
        def logout(self):
            pass

    monkeypatch.setattr(
        imap_client_mod, "imap_connect", lambda cfg, *, timeout: _FakeImap()
    )
    assert wd._probe_imap_login() is True

    def _raise(cfg, *, timeout):
        raise DavMailConnectionError("IMAP LOGIN error: token expired")

    monkeypatch.setattr(imap_client_mod, "imap_connect", _raise)
    assert wd._probe_imap_login() is False


# ────────────────────────────────────────────────────────────────
# 自动恢复 restart_callback (L2b)
# ────────────────────────────────────────────────────────────────


def _make_restart_wd(
    sync_store: SyncStore,
    davmail_root: Path,
    alerter=None,
    *,
    restart_ok: bool = True,
    **kw,
):
    """构造带注入 restart_callback 的 watchdog (login 恒失败), 返回 (wd, 调用记录)."""
    restart_calls: list[float] = []

    async def fake_restart():
        restart_calls.append(time.time())
        return (restart_ok, "exit 0" if restart_ok else "exit 1: boom")

    wd = _make_login_wd(
        sync_store,
        davmail_root,
        alerter,
        login_ok=False,
        restart_callback=fake_restart,
        **kw,
    )
    return wd, restart_calls


async def test_auto_restart_callback_invoked_on_threshold(
    sync_store: SyncStore, davmail_root: Path
):
    alerter = _FakeAlerter()
    wd, restart_calls = _make_restart_wd(sync_store, davmail_root, alerter)
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)

    await wd._tick()
    await wd._tick()
    assert restart_calls == [], "未达阈值 (2 次) 不应重启"
    await wd._tick()
    assert len(restart_calls) == 1, "第 3 次连续失败应触发重启"

    # 成功重启 → 计数清零 (下一轮真实探测重新说话) + 时间戳落盘
    assert wd._consecutive_login_fails == 0
    assert sync_store.get_state("davmail.last_auto_restart_at")
    restart_alerts = [
        c for c in alerter.calls if c[0] == "alert_davmail_auto_restart"
    ]
    assert len(restart_alerts) == 1
    assert restart_alerts[0][1][0] is True  # ok=True → warning 级


async def test_auto_restart_cooldown_prevents_flapping(
    sync_store: SyncStore, davmail_root: Path
):
    """冷却期内即使继续 LOGIN 失败也不再触发第二次重启 (成败都进冷却)."""
    wd, restart_calls = _make_restart_wd(sync_store, davmail_root, restart_ok=False)
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)

    for _ in range(3):
        await wd._tick()
    assert len(restart_calls) == 1
    assert wd._consecutive_login_fails == 3, "重启失败不清零计数"

    for _ in range(5):
        await wd._tick()
    assert len(restart_calls) == 1, "冷却期 (600s) 内不应重复重启"

    # 把上次重启时间拨出冷却期 → 持续失败应再触发
    wd._last_auto_restart_ts = time.time() - 700
    await wd._tick()
    assert len(restart_calls) == 2, "冷却期过后持续失败应再次重启"


async def test_auto_restart_max_per_day_stops_and_alerts_critical(
    sync_store: SyncStore, davmail_root: Path
):
    """24h 滚动窗口达上限 → 停自动重启 + 风暴告警一次 (镜像 crashloop_stopped)."""
    alerter = _FakeAlerter()
    wd, restart_calls = _make_restart_wd(
        sync_store,
        davmail_root,
        alerter,
        restart_ok=False,
        auto_restart_cooldown=0,  # 关冷却, 单测风暴上限
        auto_restart_max_per_day=2,
    )
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)

    for _ in range(6):
        await wd._tick()
    assert len(restart_calls) == 2, "达 max_per_day 后停止自动重启"
    storm = [c for c in alerter.calls if c[0] == "alert_davmail_restart_storm"]
    assert len(storm) == 1, "风暴告警只发一次"
    assert storm[0][1] == (2, 2)  # (count_24h, max_per_day)


async def test_no_callback_alert_only(
    sync_store: SyncStore, davmail_root: Path
):
    """默认 restart_callback=None → 仅 degraded 告警, 无重启动作/无落盘时间戳."""
    alerter = _FakeAlerter()
    wd = _make_login_wd(sync_store, davmail_root, alerter, login_ok=False)
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    for _ in range(4):
        await wd._tick()
    degraded = [c for c in alerter.calls if c[0] == "alert_davmail_login_degraded"]
    assert len(degraded) == 1
    restart_alerts = [
        c for c in alerter.calls if c[0] == "alert_davmail_auto_restart"
    ]
    assert restart_alerts == []
    assert sync_store.get_state("davmail.last_auto_restart_at") is None


async def test_restart_callback_exception_treated_as_failure(
    sync_store: SyncStore, davmail_root: Path
):
    """callback 抛异常 → 按失败处理 (计数保留 + critical 告警), 不挂 watchdog."""
    alerter = _FakeAlerter()

    async def boom():
        raise RuntimeError("pm2 exploded")

    wd = _make_login_wd(
        sync_store, davmail_root, alerter, login_ok=False, restart_callback=boom
    )
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    for _ in range(3):
        await wd._tick()  # 不抛
    assert wd._consecutive_login_fails == 3
    restart_alerts = [
        c for c in alerter.calls if c[0] == "alert_davmail_auto_restart"
    ]
    assert len(restart_alerts) == 1
    assert restart_alerts[0][1][0] is False  # ok=False → critical 级


def test_auto_restart_disabled_no_callback():
    """DAVMAIL_AUTO_RESTART_ENABLED=false (默认) → 不注入 callback; true → 注入."""
    from src.mail.davmail_restart import (
        build_restart_callback,
        restart_davmail_via_pm2,
    )

    class _Cfg:
        davmail_auto_restart_enabled = False

    assert build_restart_callback(_Cfg()) is None
    _Cfg.davmail_auto_restart_enabled = True
    assert build_restart_callback(_Cfg()) is restart_davmail_via_pm2


async def test_restart_davmail_via_pm2_not_found(monkeypatch):
    """pm2 解析不到 (纯 .app 无 node bin) → (False, 'pm2 not found...') 降级仅告警."""
    import src.mail.davmail_restart as dr

    monkeypatch.setattr(dr.shutil, "which", lambda name: None)
    monkeypatch.setattr(dr, "_PM2_FALLBACK_PATHS", ())
    ok, detail = await dr.restart_davmail_via_pm2()
    assert ok is False
    assert "pm2 not found" in detail


# ────────────────────────────────────────────────────────────────
# F3: pm2 子进程 PATH 前置 (launchd 起 .app 时 env 找不到 node → exit 127)
# ────────────────────────────────────────────────────────────────


def test_subprocess_env_prepends_pm2_paths(monkeypatch):
    """F3: _subprocess_env 把 node/pm2 常见目录前置到 PATH, 保留原 PATH 在后。"""
    import src.mail.davmail_restart as dr

    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    env = dr._subprocess_env()
    assert env["PATH"].startswith("/opt/homebrew/bin:/usr/local/bin:")
    assert env["PATH"].endswith("/usr/bin:/bin")


async def test_restart_passes_env_to_subprocess(monkeypatch):
    """F3 接线: restart_davmail_via_pm2 把 _subprocess_env() 传给 create_subprocess_exec
    (否则打包 .app 经 launchd 起 pm2 shebang 找不到 node → 恒 exit 127)。"""
    import src.mail.davmail_restart as dr

    monkeypatch.setattr(dr, "_resolve_pm2", lambda: "/opt/homebrew/bin/pm2")
    monkeypatch.setenv("PATH", "/usr/bin:/bin")

    captured: dict = {}

    class _FakeProc:
        returncode = 0

        async def communicate(self):
            return (b"", b"")

    async def fake_exec(*args, **kwargs):
        captured["kwargs"] = kwargs
        return _FakeProc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    ok, _ = await dr.restart_davmail_via_pm2()
    assert ok is True
    assert "env" in captured["kwargs"], "必须传 env= 否则 launchd PATH 找不到 node"
    assert captured["kwargs"]["env"]["PATH"].startswith(
        "/opt/homebrew/bin:/usr/local/bin:"
    )


# ────────────────────────────────────────────────────────────────
# F4: 风暴防护状态持久化 (跨 MailAgent 进程重启存活)
# ────────────────────────────────────────────────────────────────


def test_restart_state_reseeds_from_sync_state(
    sync_store: SyncStore, davmail_root: Path
):
    """F4: 构造 watchdog 时从 sync_state 回种冷却时间戳 + 24h 窗口计数,
    load 时 prune 掉窗口外的时间戳。"""
    now = time.time()
    sync_store.set_state(
        "davmail.last_auto_restart_at",
        datetime.fromtimestamp(now - 100).isoformat(timespec="seconds"),
    )
    # 两个近期 + 一个 25h 前 (窗口外, 应被 prune)
    sync_store.set_state(
        "davmail.auto_restart_times",
        json.dumps([now - 100, now - 200, now - 25 * 3600]),
    )
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root
    )
    assert abs(wd._last_auto_restart_ts - (now - 100)) < 2  # ISO 秒精度
    assert len(wd._restart_times) == 2, "25h 前的应被 prune 出 24h 窗口"


async def test_restart_times_persisted_after_restart(
    sync_store: SyncStore, davmail_root: Path
):
    """F4: 每次自动重启后把 24h 窗口计数落盘 davmail.auto_restart_times (JSON)。"""
    wd, restart_calls = _make_restart_wd(sync_store, davmail_root)
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    for _ in range(3):
        await wd._tick()
    assert len(restart_calls) == 1
    raw = sync_store.get_state("davmail.auto_restart_times")
    assert raw is not None
    parsed = json.loads(raw)
    assert isinstance(parsed, list) and len(parsed) == 1


def test_restart_state_bad_json_fail_open(
    sync_store: SyncStore, davmail_root: Path
):
    """F4: 坏 JSON / 坏 ISO 一律 fail-open 按空/0, 不挂 watchdog 构造。"""
    sync_store.set_state("davmail.auto_restart_times", "{not valid json")
    sync_store.set_state("davmail.last_auto_restart_at", "garbage-not-iso")
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root
    )
    assert wd._restart_times == []
    assert wd._last_auto_restart_ts == 0.0


async def test_restart_storm_survives_process_restart(
    sync_store: SyncStore, davmail_root: Path
):
    """F4 的价值: 上一进程已达 max_per_day → 回种后本进程立即在风暴上限,
    不再重启 + 风暴告警 (内存清零绕过上限的 bug 被根治)。"""
    now = time.time()
    sync_store.set_state(
        "davmail.auto_restart_times", json.dumps([now - 300, now - 100])
    )
    alerter = _FakeAlerter()
    wd, restart_calls = _make_restart_wd(
        sync_store,
        davmail_root,
        alerter,
        restart_ok=False,
        auto_restart_cooldown=0,
        auto_restart_max_per_day=2,
    )
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    for _ in range(4):
        await wd._tick()
    assert restart_calls == [], "回种的 2 次已达上限, 本进程不应再重启"
    storm = [c for c in alerter.calls if c[0] == "alert_davmail_restart_storm"]
    assert len(storm) == 1


# ────────────────────────────────────────────────────────────────
# F5: 生效阈值经 sync_state 传播
# ────────────────────────────────────────────────────────────────


async def test_write_state_persists_login_fail_threshold(
    sync_store: SyncStore, davmail_root: Path
):
    """F5: watchdog 每轮把生效 login 阈值落盘 davmail.login_fail_threshold,
    供 admin router / electron 读同一值 (不再各自硬编码 3)。"""
    wd = DavMailWatchdog(
        sync_store=sync_store,
        alerter=None,
        davmail_root=davmail_root,
        login_fail_threshold=5,
    )
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    await wd._tick()
    assert sync_store.get_state("davmail.login_fail_threshold") == "5"


# ────────────────────────────────────────────────────────────────
# task 08-20-notification-center 步骤 4c — critical 组 → 通知中心
# ────────────────────────────────────────────────────────────────


def _notifications(sync_store: SyncStore, dedupe_key: str | None = None):
    with sqlite3.connect(str(sync_store.db_path)) as conn:
        conn.row_factory = sqlite3.Row
        sql = "SELECT * FROM notification"
        args: tuple = ()
        if dedupe_key is not None:
            sql += " WHERE dedupe_key=?"
            args = (dedupe_key,)
        return [dict(r) for r in conn.execute(sql + " ORDER BY id", args).fetchall()]


def _center(sync_store: SyncStore) -> NotifyCenter:
    return NotifyCenter(sync_store.db_path)


async def test_no_notify_center_keeps_alerter_none_early_return(
    sync_store: SyncStore, davmail_root: Path
):
    """两个出口都不在 → _evaluate_alerts 老行为 (整段早退, 连 announce 都不置)."""
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root
    )
    await _patch_probe(wd, imap_ok=False, smtp_ok=False)
    for _ in range(3):
        await wd._tick()
    assert wd._announced_process_down_imap is False
    assert _notifications(sync_store) == []


async def test_process_down_publishes_critical_notification_without_alerter(
    sync_store: SyncStore, davmail_root: Path
):
    """默认安装 (ALERT_ENABLED=false → alerter=None): critical 组照样进铃铛,
    announce-once 语义不变 (静默轮不刷屏), 恢复时条目转 resolved。"""
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root,
        notify_center=_center(sync_store),
    )
    await _patch_probe(wd, imap_ok=False, smtp_ok=False)
    for _ in range(4):  # 3 次到阈值 + 1 次仍 down
        await wd._tick()

    rows = _notifications(sync_store)
    assert {r["dedupe_key"] for r in rows} == {
        "alert:davmail:imap_down", "alert:davmail:smtp_down"
    }
    imap_row = _notifications(sync_store, "alert:davmail:imap_down")[0]
    assert imap_row["severity"] == "critical"
    assert imap_row["category"] == "system"
    assert imap_row["source"] == "davmail"
    assert imap_row["recurrence_no"] == 1, "announce-once: 仍 down 的轮次不得计次"
    assert imap_row["state"] == "open"

    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    await wd._tick()
    assert all(r["state"] == "resolved" for r in _notifications(sync_store))


async def test_token_critical_notification_keeps_own_watermark(
    sync_store: SyncStore, davmail_root: Path, write_token
):
    """🔴 §8.b: token 是唯一 episode 化的一项 —— 飞书不在场时 self.episodes 永不
    commit (每轮重判 ENTER), 通知中心必须用自己的 `nc.` 水位, 否则每 60s 计次一次。"""
    write_token(age_seconds=89 * 86400)
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root,
        episodes=AlertEpisodeTracker(sync_store),
        notify_center=_center(sync_store),
    )
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    for _ in range(4):
        await wd._tick()

    rows = _notifications(sync_store, "alert:davmail:token_critical")
    assert len(rows) == 1 and rows[0]["recurrence_no"] == 1
    assert rows[0]["severity"] == "critical"
    # 飞书那份水位没被碰 (没投递过 = 下次配上飞书仍会告)
    assert sync_store.get_state("alert.nc.davmail_token_critical.active") == "1"
    assert sync_store.get_state("alert.davmail_token_critical.active") is None

    # 重走 OAuth → age 归零 → 条目收掉 + nc 水位复位
    write_token(age_seconds=0)
    await wd._tick()
    rows = _notifications(sync_store, "alert:davmail:token_critical")
    assert rows[0]["state"] == "resolved"
    assert sync_store.get_state("alert.nc.davmail_token_critical.active") == "0"


async def test_oauth_failure_publishes_notification(
    sync_store: SyncStore, davmail_root: Path, write_log
):
    """OAuth 失败 (无恢复信号 → 只发不收); 同一行不重复 = 不计次."""
    write_log(
        "2026-08-21 10:00:00,000 ERROR davmail "
        "AADSTS700003 refresh token invalid\n"
    )
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=None, davmail_root=davmail_root,
        notify_center=_center(sync_store),
    )
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    for _ in range(3):
        await wd._tick()

    rows = _notifications(sync_store, "alert:davmail:oauth_failure")
    assert len(rows) == 1 and rows[0]["recurrence_no"] == 1
    assert rows[0]["severity"] == "critical"


async def test_restart_storm_publishes_critical_and_resolves_when_window_rolls(
    sync_store: SyncStore, davmail_root: Path
):
    """M2-B2: 「自动恢复已放弃, 需人工」与 crash-loop 同构 —— 默认安装
    (alerter=None) 此前完全不可见。24h 窗口滚出 = 明确恢复信号 → 收掉条目。"""
    wd, restart_calls = _make_restart_wd(
        sync_store,
        davmail_root,
        None,
        restart_ok=False,
        auto_restart_cooldown=0,
        auto_restart_max_per_day=2,
        notify_center=_center(sync_store),
    )
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    for _ in range(6):
        await wd._tick()

    assert len(restart_calls) == 2, "达上限后停止自动重启 (老行为不变)"
    storm = _notifications(sync_store, "alert:davmail:restart_storm")
    assert len(storm) == 1, "风暴条目只一条 (announce-once)"
    assert storm[0]["severity"] == "critical"
    assert storm[0]["category"] == "system"
    assert storm[0]["source"] == "davmail"
    assert storm[0]["state"] == "open"

    # 24h 窗口滚出 → 自动重启重新可用
    wd._restart_times = []
    wd._last_auto_restart_ts = 0.0
    await wd._tick()
    assert _notifications(sync_store, "alert:davmail:restart_storm")[0][
        "state"
    ] == "resolved"


async def test_auto_restart_failure_publishes_then_resolves_on_success(
    sync_store: SyncStore, davmail_root: Path
):
    """重启失败 → 一条 critical (连续失败计次不刷屏); 之后重启成功 → 收掉。"""
    wd, _calls = _make_restart_wd(
        sync_store,
        davmail_root,
        None,
        restart_ok=False,
        auto_restart_cooldown=0,
        notify_center=_center(sync_store),
    )
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    for _ in range(4):
        await wd._tick()

    rows = _notifications(sync_store, "alert:davmail:auto_restart_failed")
    assert len(rows) == 1, "同一条计次, 不新开"
    assert rows[0]["severity"] == "critical"
    assert rows[0]["recurrence_no"] == 2, "第 4 轮的第二次失败应计次"
    assert "exit 1" in rows[0]["body"]

    async def _ok_restart():
        return (True, "exit 0")

    wd.restart_callback = _ok_restart  # type: ignore[assignment]
    await wd._tick()
    assert _notifications(sync_store, "alert:davmail:auto_restart_failed")[0][
        "state"
    ] == "resolved"


async def test_restart_storm_notification_absent_without_center(
    sync_store: SyncStore, davmail_root: Path
):
    """未注入通知中心 (老调用方 / 单测) → 零条目, 飞书链路一字不动。"""
    alerter = _FakeAlerter()
    wd, _calls = _make_restart_wd(
        sync_store,
        davmail_root,
        alerter,
        restart_ok=False,
        auto_restart_cooldown=0,
        auto_restart_max_per_day=2,
    )
    await _patch_probe(wd, imap_ok=True, smtp_ok=True)
    for _ in range(6):
        await wd._tick()
    assert [c for c in alerter.calls if c[0] == "alert_davmail_restart_storm"]
    assert _notifications(sync_store) == []


async def test_notify_center_failure_does_not_break_watchdog(
    sync_store: SyncStore, davmail_root: Path, tmp_path: Path
):
    """通知落库炸 (空库没有 notification 表) → 巡检照跑, 飞书 announce 照常."""
    broken = tmp_path / "empty.db"
    sqlite3.connect(str(broken)).close()
    alerter = _FakeAlerter()
    wd = DavMailWatchdog(
        sync_store=sync_store, alerter=alerter, davmail_root=davmail_root,  # type: ignore[arg-type]
        notify_center=NotifyCenter(str(broken)),
    )
    await _patch_probe(wd, imap_ok=False, smtp_ok=True)
    for _ in range(3):
        await wd._tick()
    assert len([c for c in alerter.calls if c[0] == "alert_davmail_process_down"]) == 1
    assert wd._announced_process_down_imap is True
