"""单测: mem_guard — env gate + RSS 超限触发链 (task 06-10, prd Fix 2a)."""
from __future__ import annotations

import os
import threading
import time
import tracemalloc
from typing import List

from loguru import logger

from src.utils.mem_guard import (
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
