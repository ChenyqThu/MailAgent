"""Memory watermark guard — RSS 超限自愈护栏 + tracemalloc 诊断 dump.

背景 (task 06-10-memleak-orphan, prd Fix 2a): 生产打包 app 的 Python 后端
footprint 涨到 17GB 拖死 16GB Mac。隔离 repro 未复现 tick 路径线性泄漏 (malloc
warmup 后平台化), 因此加水位护栏止血: 超限 → 留诊断证据 → 优雅退出 → 60s 硬
兜底退出。Electron 侧已实现 serve / serve-api 崩溃自拉起
(backend_lifecycle.maybeRestartAfterCrash), 进程重启即内存清零。

env gates (直读 os.environ 的 env-only flag, 不进 pydantic config, 与 main.py
顶部 load_dotenv 注释的既有模式一致):

- ``MAILAGENT_MEM_LIMIT_MB``: RSS 水位线 (MB)。未设 / 非正整数 = 完全禁用
  (pm2/dev 零行为变更); 打包态由 Electron buildBaseEnv 注入 (默认 4096)。
- ``MAILAGENT_MEM_DIAG=1``: 进程启动即 ``tracemalloc.start(10)`` (常驻 ~5-10%
  内存开销, 默认关); breach dump 时才有 Python 分配栈可看。
"""
from __future__ import annotations

import os
import subprocess
import threading
import time
import tracemalloc
from typing import Callable, Optional

from loguru import logger

# breach 后硬兜底退出的等待秒数 (优雅退出卡住也必死)。可注入便于单测。
_HARD_EXIT_DELAY_SEC = 60.0


def maybe_start_tracemalloc() -> bool:
    """env ``MAILAGENT_MEM_DIAG=1`` 时启动 tracemalloc (10 帧栈深).

    放进程入口处调 (serve / serve-api), 让 mem_guard breach dump 时能打出
    Python 层分配栈。默认关 — tracemalloc 常驻有 ~5-10% 内存/CPU 开销。

    Returns:
        是否处于 tracing 状态。
    """
    if os.environ.get("MAILAGENT_MEM_DIAG", "") != "1":
        return False
    if not tracemalloc.is_tracing():
        tracemalloc.start(10)
        logger.info(
            "[mem-guard] tracemalloc started (MAILAGENT_MEM_DIAG=1, 10 frames)"
        )
    return True


def _read_rss_mb(pid: int) -> Optional[float]:
    """读取进程当前 RSS (MB)。

    macOS 无 /proc 且不引 psutil 新依赖 → ``ps -o rss=`` (rss 单位 KB, macOS /
    Linux 通用)。任何失败返回 None, 调用方静默跳过本轮。
    """
    try:
        out = subprocess.run(
            ["ps", "-o", "rss=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if out.returncode != 0:
            return None
        raw = out.stdout.strip()
        if not raw:
            return None
        return int(raw) / 1024.0
    except Exception:
        return None


def _parse_limit_mb() -> Optional[int]:
    """解析 ``MAILAGENT_MEM_LIMIT_MB``; 未设/空 → None (静默禁用, pm2/dev 常态).

    设了但是坏值 → WARNING 一条 + None (禁用护栏)。打包态 Electron 恒注入该
    env (默认 '4096') 且透传用户 .env 里的任意非空值 (含 '0'/负数/非数字) —
    坏值绝不能当阈值用: 0/负数阈值会造成「启动即超限 → 退出 → Electron 自拉起
    → 再退」的重启循环。``int()`` 解析顺带排除非有限数 ('inf'/'nan'/小数)。
    """
    raw = os.environ.get("MAILAGENT_MEM_LIMIT_MB", "").strip()
    if not raw:
        return None
    try:
        limit = int(raw)
    except ValueError:
        logger.warning(
            f"[mem-guard] invalid MAILAGENT_MEM_LIMIT_MB={raw!r} "
            f"(not an integer) — memory guard disabled"
        )
        return None
    if limit <= 0:
        logger.warning(
            f"[mem-guard] invalid MAILAGENT_MEM_LIMIT_MB={raw!r} "
            f"(must be > 0) — memory guard disabled"
        )
        return None
    return limit


def _dump_diagnostics(rss_mb: float, limit_mb: int) -> None:
    """breach 时把诊断证据打到 ERROR 日志 (文件 sink 留档)."""
    header = (
        f"[mem-guard] RSS {rss_mb:.0f}MB exceeded limit {limit_mb}MB — "
        f"initiating self-heal exit (Electron auto-restarts the service)"
    )
    if not tracemalloc.is_tracing():
        logger.error(
            f"{header}. tracemalloc not running — set MAILAGENT_MEM_DIAG=1 to "
            f"capture Python allocation stacks on the next occurrence."
        )
        return

    try:
        traced, peak = tracemalloc.get_traced_memory()
        traced_mb = traced / (1024 * 1024)
        peak_mb = peak / (1024 * 1024)
        top = tracemalloc.take_snapshot().statistics("lineno")[:20]
        # str(stat) = "file.py:lineno: size=X KiB, count=Y, average=Z B" — 必须
        # 用它而非 traceback.format()[-1]: 后者在源码可读时 (打包 app 场景源码
        # 恒在) 只返回裸代码行, 丢掉 file:lineno 定位信息 (dump 的核心价值)。
        lines = [f"  #{i + 1} {stat}" for i, stat in enumerate(top)]
        # RSS 与 tracemalloc traced 的 gap: gap 巨大 = 泄漏在 native/C 层
        # (sqlite3 / lxml / ssl 等, tracemalloc 不可见), 需 MallocStackLogging
        # 级工具 (leaks / malloc_history) 定位, Python 层栈帮不上。
        gap_mb = rss_mb - traced_mb
        if gap_mb > max(512.0, traced_mb):
            gap_hint = (
                f" — gap {gap_mb:.0f}MB ≫ traced: leak is likely in native/C "
                f"allocations invisible to tracemalloc; use MallocStackLogging-"
                f"grade tooling (leaks/malloc_history) to locate"
            )
        else:
            gap_hint = (
                " — gap modest: leak is likely Python-level object retention; "
                "the top-20 allocation sites below should point at it"
            )
        logger.error(
            f"{header}\n"
            f"  tracemalloc traced={traced_mb:.0f}MB peak={peak_mb:.0f}MB "
            f"rss-traced gap={gap_mb:.0f}MB{gap_hint}\n"
            f"  top-20 allocation sites:\n" + "\n".join(lines)
        )
    except Exception as e:
        logger.error(f"{header}. tracemalloc dump itself failed: {e}")


def start_mem_guard(
    *,
    on_breach: Optional[Callable[[], None]] = None,
    exit_fn: Callable[[int], None] = os._exit,
    poll_sec: float = 60.0,
    rss_fn: Optional[Callable[[], Optional[float]]] = None,
    hard_exit_delay_sec: float = _HARD_EXIT_DELAY_SEC,
) -> Optional[threading.Thread]:
    """按 env gate 启动内存水位守护 daemon 线程.

    超过 ``MAILAGENT_MEM_LIMIT_MB`` 时 (one-shot, 触发即结束线程):
      ① ERROR 日志 dump 诊断证据 (RSS / 限值 / tracemalloc top-20 + gap 分析);
      ② 调 ``on_breach()`` 触发优雅退出 (serve 注入 = set shutdown_event;
         None 则跳过, 直接靠 ③);
      ③ 起 ``hard_exit_delay_sec`` 的 daemon Timer 兜底 ``exit_fn(2)``
         (优雅退出卡住也必死; Electron 侧自拉起, 重启即内存清零)。

    Args:
        on_breach: 优雅退出回调 (跨线程调用 — asyncio 侧需自行
            ``call_soon_threadsafe``)。
        exit_fn: 硬兜底退出函数 (可注入便于单测, 默认 ``os._exit``)。
        poll_sec: RSS 采样间隔秒数。
        rss_fn: RSS 读取函数 (MB), 可注入便于单测; 默认 ``ps -o rss=`` 读自身。
        hard_exit_delay_sec: breach → 硬退出的等待秒数。

    Returns:
        已启动的线程; env 未设 / 非法时 None (零行为变更)。
    """
    limit_mb = _parse_limit_mb()
    if limit_mb is None:
        return None

    read_rss = rss_fn if rss_fn is not None else (lambda: _read_rss_mb(os.getpid()))

    def _guard() -> None:
        while True:
            time.sleep(poll_sec)
            rss = read_rss()
            if rss is None:
                # RSS 读失败 (ps 异常等) 静默跳过本轮
                continue
            if rss < limit_mb:
                continue

            # ① 诊断证据
            _dump_diagnostics(rss, limit_mb)

            # ② 优雅退出回调
            if on_breach is not None:
                try:
                    on_breach()
                except Exception as e:
                    logger.error(f"[mem-guard] on_breach callback failed: {e}")

            # ③ 硬兜底: 优雅退出卡死 (换页地狱 / 网络调用挂起) 也必死
            timer = threading.Timer(hard_exit_delay_sec, exit_fn, args=(2,))
            timer.daemon = True
            timer.start()
            logger.error(
                f"[mem-guard] hard-exit timer armed: os._exit(2) in "
                f"{hard_exit_delay_sec:.0f}s unless graceful shutdown completes"
            )
            # one-shot: breach 后结束线程, 不反复告警 (进程即将退出/重启)
            return

    t = threading.Thread(target=_guard, name="mem-guard", daemon=True)
    t.start()
    logger.info(f"[mem-guard] started (limit={limit_mb}MB poll={poll_sec}s)")
    return t
