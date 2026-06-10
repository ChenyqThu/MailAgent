"""单测: parent_watchdog — env gate + PPID==1 触发 exit_fn (task 06-10, prd Fix 1b)."""
from __future__ import annotations

import os
import threading
from typing import List

from src.utils.parent_watchdog import start_parent_watchdog


def test_disabled_without_env(monkeypatch):
    monkeypatch.delenv("MAILAGENT_PARENT_WATCHDOG", raising=False)
    assert start_parent_watchdog() is None


def test_disabled_with_non_one_value(monkeypatch):
    # gate 严格 == "1" (Electron buildBaseEnv 注入的就是 "1"); 其它值一律不启动
    monkeypatch.setenv("MAILAGENT_PARENT_WATCHDOG", "true")
    assert start_parent_watchdog() is None


def test_orphan_triggers_exit_fn(monkeypatch):
    monkeypatch.setenv("MAILAGENT_PARENT_WATCHDOG", "1")
    monkeypatch.setattr(os, "getppid", lambda: 1)

    exited = threading.Event()
    codes: List[int] = []

    def fake_exit(code: int) -> None:
        codes.append(code)
        exited.set()

    t = start_parent_watchdog(exit_fn=fake_exit, poll_sec=0.02)
    assert t is not None
    assert exited.wait(2.0), "PPID==1 时 watchdog 未触发 exit_fn"
    assert codes == [0]
    # 触发后线程结束 (注入的 exit_fn 不真退出, 靠显式 return)
    t.join(2.0)
    assert not t.is_alive()


def test_alive_parent_does_not_exit(monkeypatch):
    monkeypatch.setenv("MAILAGENT_PARENT_WATCHDOG", "1")
    # 真实 getppid: 父进程是 pytest, 不是 launchd (PID 1)
    assert os.getppid() != 1
    exited = threading.Event()

    t = start_parent_watchdog(exit_fn=lambda code: exited.set(), poll_sec=0.02)
    assert t is not None
    assert not exited.wait(0.2), "父进程存活时不应触发 exit_fn"
    assert t.is_alive()
