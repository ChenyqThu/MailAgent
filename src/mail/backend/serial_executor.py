"""backend-io 单线程串行执行器 — 把阻塞的 backend 调用移出事件循环线程且保序.

为什么必须单线程 (而非默认 ``asyncio.to_thread`` 的多线程池):
  两条 ``IMailBackend`` 实现都非并发安全, 且都没有任何显式锁:
    - ``DavMailBackend``: 每次调用新建一个独立的 ``imaplib.IMAP4`` socket 连到本机
      davmail-poc 桥 (桥内部再转译成 EWS 调用发给 Exchange); 并发多个 LOGIN + EWS
      调用会加剧 EWS throttling —— ``DavMailWatchdog`` 专门监测 ``EWSThrottlingException``
      突增, 说明这个风险历史上真实发生过。
    - ``AppleScriptBackend``: ``subprocess`` 调 ``osascript`` 走 Apple Event 跟
      Mail.app 通信; macOS Apple Event 对同一 target app 的并发调用不可靠。

  在 WP3 之前, 这些同步 backend 调用天然跑在单个事件循环线程里, 被"事件循环单线程
  顺序执行"这个隐式副作用串行化 —— 一封慢邮件却因此卡住整个 loop (fanout / reverse /
  island 等所有 worker 的 tick 全被延后)。把它们 ``to_thread`` 化能让 loop 不再被阻塞,
  但也解除了那层隐式串行保护。``mailapp_fanout`` 早先已用默认 ``asyncio.to_thread``
  (多线程池) + ``concurrency=3`` 在并发打同一个 backend 实例 (无锁无护栏)。

  统一收编到本模块的单线程 ``ThreadPoolExecutor(max_workers=1)`` 后, 所有 backend
  阻塞调用排一条队: 既离开事件循环线程 (不阻塞其他 worker 的 tick), 又显式保序
  (不并发命中 backend)。相对改动前无吞吐回退 —— 此前同步 fetch 卡整个 loop 时,
  fanout 的写调用本来也在排队等着。

关于进程退出: 本模块的 executor 惰性单例, 进程生命周期内不主动 ``shutdown()``
——``ThreadPoolExecutor`` 的 worker 线程是非 daemon 线程, 若退出时恰有一个慢
fetch (davmail 上限 ``davmail_fetch_timeout_sec`` 默认 120s) 卡在里面, Python
的 ``concurrent.futures`` atexit 钩子理论上会 join 到它完成才放行正常退出。
实际不构成风险: ``service.py`` 的 ``_handle_signal``（SIGTERM/SIGINT）已有独立
30s 硬退兜底 Timer（``os._exit(1)``, daemon, task 06-10 引入）, 优先于该 atexit
钩子触发, 上限已被封住, 本模块无需重复处理。
"""
from __future__ import annotations

import asyncio
import functools
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Optional, TypeVar

_T = TypeVar("_T")

# 惰性单例 — 首次 run_backend_io 时创建, 进程生命周期内复用同一个单线程 executor,
# 保证所有 backend 调用共享同一条串行队列。
_executor: Optional[ThreadPoolExecutor] = None


def _get_executor() -> ThreadPoolExecutor:
    global _executor
    if _executor is None:
        _executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="backend-io")
    return _executor


async def run_backend_io(fn: Callable[..., _T], *args: Any, **kwargs: Any) -> _T:
    """在单线程 backend-io executor 里跑同步阻塞的 backend 调用.

    等价于 ``asyncio.to_thread(fn, *args, **kwargs)``, 但用的是一个进程级
    ``max_workers=1`` 的专属线程池 —— 所有 backend 调用排一条串行队列, 既不阻塞
    事件循环, 又不并发命中 backend (见模块 docstring)。
    """
    loop = asyncio.get_running_loop()
    call = functools.partial(fn, *args, **kwargs)
    return await loop.run_in_executor(_get_executor(), call)
