"""单测: mem_guard — env gate + RSS 超限触发链 (task 06-10, prd Fix 2a)."""
from __future__ import annotations

import os
import threading
import time
import tracemalloc
from typing import List

from loguru import logger

from src.utils.mem_guard import (
    _read_footprint_mb,
    _read_mem_mb,
    _read_rss_mb,
    maybe_start_tracemalloc,
    start_mem_guard,
)


def test_disabled_without_env(monkeypatch):
    monkeypatch.delenv("MAILAGENT_MEM_LIMIT_MB", raising=False)
    assert start_mem_guard() is None


def test_invalid_values_warn_disable_and_never_exit(monkeypatch):
    """坏值 ('0'/'abc'/'-5'...) → WARNING 一条 + return None 禁用; exit_fn 绝不被调.

    打包态 Electron 恒注入该 env 且透传用户 .env 的任意非空值 — 坏值若被当
    阈值用会造成「启动即超限 → 退出 → Electron 自拉起 → 再退」的重启循环。
    """
    records: List[dict] = []
    sink_id = logger.add(lambda m: records.append(m.record), level="WARNING")
    exit_calls: List[int] = []
    try:
        for bad in ("0", "abc", "-5", "4096.5"):
            before = len(records)
            monkeypatch.setenv("MAILAGENT_MEM_LIMIT_MB", bad)
            result = start_mem_guard(
                exit_fn=exit_calls.append,
                poll_sec=0.01,
                rss_fn=lambda: 99999.0,
                hard_exit_delay_sec=0.01,
            )
            assert result is None, f"非法值 {bad!r} 不应启动 guard"
            warns = [
                r for r in records[before:]
                if "MAILAGENT_MEM_LIMIT_MB" in str(r["message"])
            ]
            assert len(warns) == 1, f"坏值 {bad!r} 应 WARNING 一条"
    finally:
        logger.remove(sink_id)
    time.sleep(0.1)  # 若 guard 误启动, 0.01s poll 早就触发了
    assert exit_calls == [], "禁用路径 exit_fn 绝不应被调"


def test_disabled_with_whitespace_env_is_silent(monkeypatch):
    """空白值视同未设: 静默禁用, 不告警."""
    records: List[dict] = []
    sink_id = logger.add(lambda m: records.append(m.record), level="WARNING")
    try:
        monkeypatch.setenv("MAILAGENT_MEM_LIMIT_MB", "   ")
        assert start_mem_guard() is None
        assert [
            r for r in records if "MAILAGENT_MEM_LIMIT_MB" in str(r["message"])
        ] == []
    finally:
        logger.remove(sink_id)


def test_breach_calls_on_breach_and_arms_exit_timer(monkeypatch):
    monkeypatch.setenv("MAILAGENT_MEM_LIMIT_MB", "100")
    breached = threading.Event()
    exited = threading.Event()
    codes: List[int] = []

    def fake_exit(code: int) -> None:
        codes.append(code)
        exited.set()

    t = start_mem_guard(
        on_breach=breached.set,
        exit_fn=fake_exit,
        poll_sec=0.02,
        rss_fn=lambda: 200.0,
        hard_exit_delay_sec=0.1,
    )
    assert t is not None
    assert breached.wait(2.0), "RSS 超限未触发 on_breach"
    assert exited.wait(2.0), "硬兜底 Timer 未触发 exit_fn"
    assert codes == [2]
    # one-shot: breach 后 guard 线程结束 (不反复告警)
    t.join(2.0)
    assert not t.is_alive()


def test_below_limit_no_breach(monkeypatch):
    monkeypatch.setenv("MAILAGENT_MEM_LIMIT_MB", "100")
    triggered = threading.Event()

    t = start_mem_guard(
        on_breach=triggered.set,
        exit_fn=lambda code: triggered.set(),
        poll_sec=0.02,
        rss_fn=lambda: 50.0,
        hard_exit_delay_sec=0.1,
    )
    assert t is not None
    assert not triggered.wait(0.2), "低于限值不应触发"
    assert t.is_alive()


def test_rss_read_failure_skips_round_then_recovers(monkeypatch):
    """rss_fn 返回 None (ps 失败) → 静默跳过本轮; 恢复读数后照常检测."""
    monkeypatch.setenv("MAILAGENT_MEM_LIMIT_MB", "100")
    readings = iter([None, None, 200.0])
    breached = threading.Event()

    t = start_mem_guard(
        on_breach=breached.set,
        exit_fn=lambda code: None,
        poll_sec=0.02,
        rss_fn=lambda: next(readings, 200.0),
        hard_exit_delay_sec=5.0,
    )
    assert t is not None
    assert breached.wait(2.0), "恢复读数后未检测到超限"


def test_on_breach_exception_still_arms_timer(monkeypatch):
    monkeypatch.setenv("MAILAGENT_MEM_LIMIT_MB", "100")
    exited = threading.Event()

    def bad_breach() -> None:
        raise RuntimeError("boom")

    t = start_mem_guard(
        on_breach=bad_breach,
        exit_fn=lambda code: exited.set(),
        poll_sec=0.02,
        rss_fn=lambda: 999.0,
        hard_exit_delay_sec=0.1,
    )
    assert t is not None
    assert exited.wait(2.0), "on_breach 抛异常时硬兜底 Timer 仍应触发"


def test_read_rss_mb_real_process():
    """真实 ps 路径: 读自身 RSS 应为正数 (macOS/Linux `ps -o rss=` 通用)."""
    rss = _read_rss_mb(os.getpid())
    assert rss is not None
    assert rss > 0


def test_read_footprint_mb_real_process():
    """macOS 真实 libproc 路径: phys_footprint 应为正且量级合理 (07-03 加固).

    07-03 复现: 内存压力下压缩器把冷页搬进压缩池, ps RSS 下降而 footprint
    (Activity Monitor 同源) 继续涨 → 旧 ps 度量让 4096MB 护栏全天零 breach。
    """
    import sys

    fp = _read_footprint_mb(os.getpid())
    if sys.platform == "darwin":
        assert fp is not None
        assert 10 < fp < 100_000  # 正数且量级合理 (MB)
    else:
        assert fp is None  # 非 macOS 静默 None → 回落 ps


def test_read_footprint_mb_bad_pid_returns_none():
    assert _read_footprint_mb(2**30) is None


def test_read_mem_prefers_footprint_falls_back_to_ps(monkeypatch):
    import src.utils.mem_guard as mg

    monkeypatch.setattr(mg, "_read_footprint_mb", lambda pid: 123.0)
    assert _read_mem_mb(os.getpid()) == 123.0
    monkeypatch.setattr(mg, "_read_footprint_mb", lambda pid: None)
    monkeypatch.setattr(mg, "_read_rss_mb", lambda pid: 45.0)
    assert _read_mem_mb(os.getpid()) == 45.0


def test_blind_guard_warns_after_3_failures(monkeypatch):
    """读数 3 连败 → WARNING (旧代码静默 continue = 护栏永瘫不可观测)."""
    monkeypatch.setenv("MAILAGENT_MEM_LIMIT_MB", "100")
    records: List[dict] = []
    sink_id = logger.add(lambda m: records.append(m.record), level="WARNING")
    try:
        t = start_mem_guard(
            exit_fn=lambda code: None,
            poll_sec=0.01,
            warn_poll_sec=0.01,
            rss_fn=lambda: None,
            hard_exit_delay_sec=5.0,
        )
        assert t is not None
        deadline = time.time() + 2.0
        while time.time() < deadline:
            if any("effectively blind" in str(r["message"]) for r in records):
                break
            time.sleep(0.02)
        assert any(
            "effectively blind" in str(r["message"]) for r in records
        ), "3 连败未打失明 WARNING"
    finally:
        logger.remove(sink_id)


def test_high_watermark_tightens_poll_and_warns(monkeypatch):
    """≥70% 水位 → 打 high watermark WARNING 并切密轮 (仍低于 limit 不 breach)."""
    monkeypatch.setenv("MAILAGENT_MEM_LIMIT_MB", "100")
    records: List[dict] = []
    sink_id = logger.add(lambda m: records.append(m.record), level="WARNING")
    calls: List[float] = []

    def reading() -> float:
        calls.append(time.time())
        return 75.0  # 70% < 75 < 100: 预警区但不 breach

    breached = threading.Event()
    try:
        t = start_mem_guard(
            on_breach=breached.set,
            exit_fn=lambda code: breached.set(),
            poll_sec=0.5,
            warn_poll_sec=0.01,
            rss_fn=reading,
            hard_exit_delay_sec=5.0,
        )
        assert t is not None
        time.sleep(1.5)
        assert not breached.is_set(), "75% 水位不应 breach"
        assert any(
            "high watermark" in str(r["message"]) for r in records
        ), "进入预警区应打 WARNING"
        # 密轮生效: 首轮 0.5s 后进入预警区, 之后 0.01s/轮 → 1.5s 内远超 3 次采样
        assert len(calls) > 5, f"密轮未生效, 采样仅 {len(calls)} 次"
    finally:
        logger.remove(sink_id)


def test_read_rss_mb_bad_pid_returns_none():
    assert _read_rss_mb(2 ** 30) is None


def test_maybe_start_tracemalloc_gated(monkeypatch):
    monkeypatch.delenv("MAILAGENT_MEM_DIAG", raising=False)
    before = tracemalloc.is_tracing()
    assert maybe_start_tracemalloc() is False
    assert tracemalloc.is_tracing() == before  # 状态不被改动


def test_maybe_start_tracemalloc_on(monkeypatch):
    monkeypatch.setenv("MAILAGENT_MEM_DIAG", "1")
    already_tracing = tracemalloc.is_tracing()
    try:
        assert maybe_start_tracemalloc() is True
        assert tracemalloc.is_tracing()
    finally:
        if not already_tracing:
            tracemalloc.stop()
