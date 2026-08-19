"""Loopback 事件投递 —— 把「没有 sse_server 的进程」发出的事件送到 serve 进程 (S1)。

## 为什么需要它

前端的 SSE 与 REST 走**两个不同的 Python 进程**:

- SSE: electron main 连 ``127.0.0.1:9200/api/events/stream`` —— ``serve`` 进程的 aiohttp
  (``src/sse_server.py``), 它在启动时 ``bind_loop()`` 了进程内总线。
- REST: 前端 / gateway 的 agent 工具 / 远程 web / 飞书全打 ``127.0.0.1:8200``
  —— ``serve-api`` 进程 (FastAPI), 那里的 ``InProcessEventBus`` 从未绑过 loop。

于是 serve-api 里的 ``safe_publish`` 是 **no-op** (``inprocess_bus`` 文件头把这条记为
已知盲区, 列了三个候选方案并注明「等症状出现再驱动选型」)。症状在 2026-08-18 出现:
「Agent 改完事项要切走再切回才看得到」。owner 拍板走候选① —— 本模块即候选①的投递端。

## 契约 (四条都是硬要求, 违反任何一条都会把主链路烧穿)

1. **绝不阻塞调用方**。``safe_publish`` 是同步函数, 会在 FastAPI 的 async 端点里被调到;
   在那里做同步 HTTP 等于卡住整个 event loop。故走 ``max_workers=1`` 的 executor
   fire-and-forget。单线程即天然保序 (事件顺序 = 提交顺序)。
2. **绝不抛**。serve 没起 / 9200 被占 / 网络栈抽风, 写操作都必须照常成功。
   一切异常落 ``logger.debug``, 与 ``safe_publish`` 现有纪律一致。
3. **有界**。executor 队列满则丢。这条总线本来就是 lossy 的 (见 ``inprocess_bus``
   文件头: 「新增状态类事件必须自带查询/轮询兜底」) —— 丢事件的代价是少刷一次,
   不能是把内存吃穿。
4. **短超时**。本地回环正常 ~1ms; 1s 超时足够宽, 又不会让线程长期挂死。
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from queue import Full
from typing import Optional

from loguru import logger


#: serve 进程 SSE server 的默认端口。🔴 与 ``src/service.py`` 的 ``start_sse_server()``
#: 调用、``frontend/src/electron/main/backend_lifecycle.ts`` 的 ``SSE_LOCAL_PORT`` 同源。
DEFAULT_SSE_PORT = 9200
#: 内部 publish 端点路径 (``src/sse_server.py::make_app``)。
PUBLISH_PATH = "/api/events/publish"
#: 🔴 必须与 ``src/api/auth.py`` / ``src/sse_server.py`` / ``local_token.ts`` 一致。
LOCAL_TOKEN_HEADER = "X-MailAgent-Local-Token"
#: 单次投递超时 (秒)。本地回环 ~1ms, 1s 是宽到不可能误杀的上限。
TIMEOUT_SEC = 1.0
#: 待投递队列上限。满则丢 (lossy bus 纪律)。一轮 agent run 撑死几十条, 256 有充足余量。
MAX_PENDING = 256


_executor: Optional[ThreadPoolExecutor] = None


def _get_executor() -> ThreadPoolExecutor:
    """惰性单线程 executor。单线程 = 投递保序, 且不会因为事件多而起一堆线程。"""
    global _executor
    if _executor is None:
        _executor = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="mailagent-evt-loopback"
        )
    return _executor


def _endpoint() -> str:
    port = os.environ.get("SSE_LOCAL_PORT", "").strip() or str(DEFAULT_SSE_PORT)
    return f"http://127.0.0.1:{port}{PUBLISH_PATH}"


def _post(payload: dict) -> None:
    """在 worker 线程上运行: 一次 POST, 任何失败只 debug。"""
    body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    request = urllib.request.Request(
        _endpoint(), data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    token = os.environ.get("MAILAGENT_LOCAL_API_TOKEN", "").strip()
    if token:
        request.add_header(LOCAL_TOKEN_HEADER, token)
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SEC) as response:
            if response.status >= 400:
                logger.debug(f"[loopback] publish rejected: HTTP {response.status}")
    except (urllib.error.URLError, OSError, ValueError) as e:
        # serve 没起 / 端口不通 / token 不匹配 —— 全部无害: 退化成「这次没有实时刷新」。
        logger.debug(f"[loopback] publish failed ({payload.get('event_type')}): {e}")


def publish_loopback(payload: dict) -> None:
    """把一条已构造好的事件 payload 投给 serve 进程。同步返回, 绝不抛。

    Args:
        payload: ``publisher._build_payload()`` 的产物 (event_type / ts / internal_id /
            data / source)。这里原样转发, 由 serve 侧重新构造 —— serve 侧会补自己的 ts,
            两侧差几毫秒对 invalidation hint 无意义。
    """
    try:
        executor = _get_executor()
        if executor._work_queue.qsize() >= MAX_PENDING:  # noqa: SLF001 — 无公开 API
            logger.debug("[loopback] pending queue full, dropping event")
            return
        executor.submit(_post, payload)
    except (Full, RuntimeError) as e:
        # RuntimeError: interpreter shutdown 中 submit —— 进程都要没了, 丢弃即可。
        logger.debug(f"[loopback] submit skipped: {e}")
    except Exception as e:  # 兜底: 这条路绝不能把调用方烧穿
        logger.debug(f"[loopback] submit swallowed: {e}")


def _shutdown_for_tests() -> None:
    """单测收尾: 关掉 executor 并清单例, 免得线程跨用例泄漏。"""
    global _executor
    if _executor is not None:
        _executor.shutdown(wait=True)
        _executor = None
