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
import os
import time
import unittest.mock as um
from pathlib import Path

import pytest

from src.mail.davmail_watchdog import (
    DavMailWatchdog,
    _EWS_THROTTLE_RE,
    _OAUTH_FAIL_RE,
)
from src.mail.sync_store import SyncStore


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
    """记录所有调用而不真发送."""

    def __init__(self):
        self.calls: list[tuple[str, tuple, dict]] = []

    def __getattr__(self, name):
        async def _cap(*args, **kwargs):
            self.calls.append((name, args, kwargs))
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
