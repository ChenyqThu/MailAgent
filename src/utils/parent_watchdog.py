"""Parent-death watchdog — 打包态 Electron 子进程的孤儿自杀兜底.

背景 (task 06-10-memleak-orphan, prd Fix 1b): 打包 app 里 Python 后端 (serve /
serve-api) 由 Electron main spawn。Electron 被 force-quit / crash 时 ``before-quit``
钩子根本不跑, SIGTERM→SIGKILL 升级链断掉 → Python 进程被 launchd 收养 (PPID→1)
成孤儿, 继续占内存吃 CPU (生产实证: 17GB footprint 孤儿只能手动 kill)。

本模块起 daemon 线程, 每 ``poll_sec`` 检查 ``os.getppid() == 1`` (macOS 上父进程
死亡 = 被 launchd PID 1 收养), 命中即 ``exit_fn(0)`` (默认 ``os._exit``)。

为什么 ``os._exit`` 而非 graceful shutdown:
- 孤儿场景下 graceful 清理正是事故根源 —— 17GB 被换出态下 cancel 十几个 task +
  网络调用 (alert/stats) 每碰一页都要从 swap 换回, 慢到分钟级甚至卡死。
- SQLite 全程 WAL 模式, crash-safe; ``os._exit`` 等价 SIGKILL 语义, 安全。

env gate: 仅 ``MAILAGENT_PARENT_WATCHDOG=1`` 时启动 (打包态由 Electron
buildBaseEnv 注入; env-only flag 直读 os.environ, 不进 pydantic config, 与
main.py 顶部 load_dotenv 注释的既有模式一致)。pm2 / dev 不设 → return None
零行为变更 (pm2 daemon 重启等 PPID 变化场景不误杀)。
"""
from __future__ import annotations

import os
import threading
import time
from typing import Callable, Optional

from loguru import logger


def start_parent_watchdog(
    *,
    exit_fn: Callable[[int], None] = os._exit,
    poll_sec: float = 5.0,
) -> Optional[threading.Thread]:
    """按 env gate 启动 parent-death watchdog daemon 线程.

    Args:
        exit_fn: 触发时调用的退出函数 (可注入便于单测, 默认 ``os._exit``)。
        poll_sec: PPID 检查间隔秒数。

    Returns:
        已启动的线程; env 未开启时 None (零行为变更)。
    """
    if os.environ.get("MAILAGENT_PARENT_WATCHDOG", "") != "1":
        return None

    def _watch() -> None:
        while True:
            if os.getppid() == 1:
                logger.warning(
                    "[parent-watchdog] parent process died (PPID=1, adopted by "
                    "launchd) — exiting now via os._exit(0). Graceful shutdown "
                    "is intentionally skipped: in the orphan scenario it can "
                    "stall for minutes under swap pressure (root cause of the "
                    "17GB orphan incident); SQLite WAL is crash-safe."
                )
                exit_fn(0)
                # 测试注入的 exit_fn 不会真正终止进程 — 显式 return 结束线程,
                # 避免假 exit 后继续空转。
                return
            time.sleep(poll_sec)

    t = threading.Thread(target=_watch, name="parent-watchdog", daemon=True)
    t.start()
    logger.info(f"[parent-watchdog] started (poll={poll_sec}s)")
    return t
