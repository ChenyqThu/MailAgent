"""Memory watermark guard — RSS 超限自愈护栏 + tracemalloc 诊断 dump.

背景 (task 06-10-memleak-orphan, prd Fix 2a): 生产打包 app 的 Python 后端
footprint 涨到 17GB 拖死 16GB Mac。隔离 repro 未复现 tick 路径线性泄漏 (malloc
warmup 后平台化), 因此加水位护栏止血: 超限 → 留诊断证据 → 优雅退出 → 60s 硬
兜底退出。Electron 侧已实现 serve / serve-api 崩溃自拉起
(backend_lifecycle.maybeRestartAfterCrash), 进程重启即内存清零。

env gates (直读 os.environ 的 env-only flag, 不进 pydantic config, 与 main.py
顶部 load_dotenv 注释的既有模式一致):

- ``MAILAGENT_MEM_LIMIT_MB``: 内存水位线 (MB)。未设 / 非正整数 = 完全禁用
  (pm2/dev 零行为变更); 打包态由 Electron buildBaseEnv 注入 (默认 4096)。
- ``MAILAGENT_MEM_DIAG=1``: 进程启动即 ``tracemalloc.start(10)`` (常驻 ~5-10%
  内存开销, 默认关); breach dump 时才有 Python 分配栈可看。

07-03 复现教训 (task 07-03-dogfood-bugs, research/bug3): 合盖唤醒后进程冲到
13-15GB 而 4096MB 护栏全天零 breach —— ``ps -o rss=`` 的 RSS 在 macOS 内存压力
下会随压缩器把冷页搬进压缩池而**下降**, 与 Activity Monitor 显示的
phys_footprint (含压缩池, 即「这个进程真正占了多少内存」) 严重背离, 护栏在最
需要时失明; thrash 时 ps 子进程 fork 还会失败 → 旧代码静默 continue = 永瘫不可
观测。因此: ① 度量改 libproc ``proc_pid_rusage`` 的 ``ri_phys_footprint``
(零 fork + 与 Activity Monitor 同源), ps RSS 只作 fallback; ② 连续读数失败打
WARNING; ③ ≥70% 水位切 10s 密轮 (截住唤醒后的快速冲高); ④ wall/monotonic
漂移 >120s 打唤醒锚点日志 (macOS monotonic 不含睡眠时长)。
"""
from __future__ import annotations

import ctypes
import os
import subprocess
import sys
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


_RUSAGE_INFO_V0 = 0


class _RUsageInfoV0(ctypes.Structure):
    """XNU resource.h ``struct rusage_info_v0`` (V0 即含 ri_phys_footprint)。"""

    _fields_ = [
        ("ri_uuid", ctypes.c_uint8 * 16),
        ("ri_user_time", ctypes.c_uint64),
        ("ri_system_time", ctypes.c_uint64),
        ("ri_pkg_idle_wkups", ctypes.c_uint64),
        ("ri_interrupt_wkups", ctypes.c_uint64),
        ("ri_pageins", ctypes.c_uint64),
        ("ri_wired_size", ctypes.c_uint64),
        ("ri_resident_size", ctypes.c_uint64),
        ("ri_phys_footprint", ctypes.c_uint64),
        ("ri_proc_start_abstime", ctypes.c_uint64),
        ("ri_proc_exit_abstime", ctypes.c_uint64),
    ]


_libproc: Optional[ctypes.CDLL] = None
if sys.platform == "darwin":
    try:
        _libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        _libproc.proc_pid_rusage.restype = ctypes.c_int
    except Exception:  # libproc 不可用 (异常环境) → 回落 ps 路径
        _libproc = None


def _read_footprint_mb(pid: int) -> Optional[float]:
    """libproc ``proc_pid_rusage`` 读 phys_footprint (MB); 失败 / 非 macOS → None。

    phys_footprint = 私有内存 + 压缩池贡献, 与 Activity Monitor「内存」列同源。
    进程内读自身无需特权、零 fork —— thrash 时 ps 会 fork 失败, 这条路不会。
    """
    if _libproc is None:
        return None
    try:
        info = _RUsageInfoV0()
        ret = _libproc.proc_pid_rusage(
            ctypes.c_int(pid), ctypes.c_int(_RUSAGE_INFO_V0), ctypes.byref(info)
        )
        if ret != 0:
            return None
        footprint = int(info.ri_phys_footprint)
        if footprint <= 0:
            return None
        return footprint / (1024.0 * 1024.0)
    except Exception:
        return None


def _read_mem_mb(pid: int) -> Optional[float]:
    """进程内存读数 (MB): phys_footprint 优先, 失败回落 ps RSS。"""
    mb = _read_footprint_mb(pid)
    if mb is not None:
        return mb
    return _read_rss_mb(pid)


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


def _dump_diagnostics(mem_mb: float, limit_mb: int) -> None:
    """breach 时把诊断证据打到 ERROR 日志 (文件 sink 留档)."""
    header = (
        f"[mem-guard] memory footprint {mem_mb:.0f}MB exceeded limit {limit_mb}MB — "
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
        # footprint 与 tracemalloc traced 的 gap: gap 巨大 = 泄漏在 native/C 层
        # (sqlite3 / lxml / ssl 等, tracemalloc 不可见), 需 MallocStackLogging
        # 级工具 (leaks / malloc_history) 定位, Python 层栈帮不上。
        gap_mb = mem_mb - traced_mb
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
            f"footprint-traced gap={gap_mb:.0f}MB{gap_hint}\n"
            f"  top-20 allocation sites:\n" + "\n".join(lines)
        )
    except Exception as e:
        logger.error(f"{header}. tracemalloc dump itself failed: {e}")


def start_mem_guard(
    *,
    on_breach: Optional[Callable[[], None]] = None,
    exit_fn: Callable[[int], None] = os._exit,
    poll_sec: float = 60.0,
    warn_poll_sec: float = 10.0,
    rss_fn: Optional[Callable[[], Optional[float]]] = None,
    hard_exit_delay_sec: float = _HARD_EXIT_DELAY_SEC,
) -> Optional[threading.Thread]:
    """按 env gate 启动内存水位守护 daemon 线程.

    超过 ``MAILAGENT_MEM_LIMIT_MB`` 时 (one-shot, 触发即结束线程):
      ① ERROR 日志 dump 诊断证据 (footprint / 限值 / tracemalloc top-20 + gap 分析);
      ② 调 ``on_breach()`` 触发优雅退出 (serve 注入 = set shutdown_event;
         None 则跳过, 直接靠 ③);
      ③ 起 ``hard_exit_delay_sec`` 的 daemon Timer 兜底 ``exit_fn(2)``
         (优雅退出卡住也必死; Electron 侧自拉起, 重启即内存清零)。

    07-03 加固 (research/bug3): 度量默认 phys_footprint (fallback ps RSS);
    读数 ≥3 连败打 WARNING (护栏失明可观测); ≥70% 水位切 ``warn_poll_sec``
    密轮 (60s 窗口内的唤醒冲高也截得住); wall/monotonic 漂移 >120s 打唤醒
    锚点 (给「唤醒后 N 分钟冲高」时间线定位)。

    Args:
        on_breach: 优雅退出回调 (跨线程调用 — asyncio 侧需自行
            ``call_soon_threadsafe``)。
        exit_fn: 硬兜底退出函数 (可注入便于单测, 默认 ``os._exit``)。
        poll_sec: 常态采样间隔秒数。
        warn_poll_sec: ≥70% 水位后的密轮间隔秒数。
        rss_fn: 内存读取函数 (MB), 可注入便于单测; 默认 phys_footprint
            (fallback ``ps -o rss=``) 读自身。
        hard_exit_delay_sec: breach → 硬退出的等待秒数。

    Returns:
        已启动的线程; env 未设 / 非法时 None (零行为变更)。
    """
    limit_mb = _parse_limit_mb()
    if limit_mb is None:
        return None

    read_mem = rss_fn if rss_fn is not None else (lambda: _read_mem_mb(os.getpid()))
    warn_mb = limit_mb * 0.7

    def _guard() -> None:
        warn_zone = False
        fail_streak = 0
        last_wall = time.time()
        last_mono = time.monotonic()
        while True:
            time.sleep(warn_poll_sec if warn_zone else poll_sec)

            # ④ 唤醒锚点: macOS monotonic (mach uptime) 不含睡眠时长, wall 含
            # → 差值突增 = 机器睡过觉。合盖唤醒型泄漏的时间线定位靠它。
            wall, mono = time.time(), time.monotonic()
            slept = (wall - last_wall) - (mono - last_mono)
            last_wall, last_mono = wall, mono
            if slept > 120.0:
                logger.info(
                    f"[mem-guard] wake anchor: system appears to have slept "
                    f"~{slept:.0f}s — watching for post-wake memory climb"
                )

            mem = read_mem()
            if mem is None:
                # ② 失明可观测: thrash 时 ps fork 失败 / libproc 异常会连败。
                fail_streak += 1
                if fail_streak == 3:
                    logger.warning(
                        "[mem-guard] memory reading failed 3x in a row — guard "
                        "is effectively blind (system may be thrashing)"
                    )
                continue
            if fail_streak >= 3:
                logger.info(
                    f"[mem-guard] memory reading recovered after "
                    f"{fail_streak} consecutive failures"
                )
            fail_streak = 0

            # ③ 高水位密轮: 进出各打一条, 密轮期间不刷屏。
            if mem >= warn_mb:
                if not warn_zone:
                    warn_zone = True
                    logger.warning(
                        f"[mem-guard] high watermark: {mem:.0f}MB ≥ 70% of "
                        f"{limit_mb}MB — tightening poll to {warn_poll_sec:.0f}s"
                    )
            elif warn_zone:
                warn_zone = False
                logger.info(
                    f"[mem-guard] back below high watermark ({mem:.0f}MB)"
                )

            if mem < limit_mb:
                continue

            # ① 诊断证据
            _dump_diagnostics(mem, limit_mb)

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
    metric = "phys_footprint" if _read_footprint_mb(os.getpid()) is not None else "ps_rss"
    logger.info(
        f"[mem-guard] started (limit={limit_mb}MB poll={poll_sec}s "
        f"warn_poll={warn_poll_sec}s metric={metric})"
    )
    return t
