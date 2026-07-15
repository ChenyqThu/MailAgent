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
    # 应触发 throttle alert + 写 paused=true
    throttle_calls = [c for c in alerter.calls if c[0] == "alert_davmail_ews_throttling"]
    assert len(throttle_calls) == 1
    assert sync_store.get_state("davmail_uid_backfill_paused") == "true"

    # 清空 log 再 tick → 解除暂停
    write_log("")
    await wd._tick()
    assert sync_store.get_state("davmail_uid_backfill_paused") == "false"


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
