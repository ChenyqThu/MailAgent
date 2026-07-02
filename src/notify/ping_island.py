"""AF_UNIX socket sender 到 ping-island Swift daemon.

Wire 协议来源：``frontend/ISLAND-PLUGIN.md`` §3.1 + REVIEW-LOG H-16 / H-17 / H-18。

设计要点（写在前面以免反复回头查）：
- ``socket.settimeout(3.0)`` 三阶段（connect / sendall / recv）共享 deadline
- 发送：``connect → sendall → shutdown(SHUT_WR) → recv until EOF`` —— Swift NIO half-close
- response 上限 1 MiB（防 OOM）
- envelope 上限 64 KiB（``island_envelope`` 内部已 truncate metadata，这里再 hard reject）
- fail-open：任何 socket / 协议异常 → ``log.debug`` + 入 reconnect queue（H-17）+ 不抛
- 同步 IO 在线程池执行，避免阻塞 asyncio 主 loop
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

from src.notify.island_envelope import BridgeEnvelope, ENVELOPE_MAX_BYTES

log = logging.getLogger(__name__)

DEFAULT_SOCKET_PATH = "/tmp/island.sock"
DEFAULT_TIMEOUT_SEC = 3.0
RESPONSE_MAX_BYTES = 1 << 20  # 1 MiB


class ProtocolError(RuntimeError):
    """Wire 协议违规（超大 envelope / 超大 response 等）."""


@dataclass
class SendResult:
    """``send_sync`` / ``send_async`` 返回结果."""

    ok: bool
    response: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    latency_ms: int = 0


def _socket_path() -> str:
    return os.environ.get("ISLAND_SOCKET_PATH", DEFAULT_SOCKET_PATH)


def _socket_timeout() -> float:
    raw = os.environ.get("ISLAND_SOCKET_TIMEOUT", str(DEFAULT_TIMEOUT_SEC))
    try:
        val = float(raw)
        return val if val > 0 else DEFAULT_TIMEOUT_SEC
    except ValueError:
        return DEFAULT_TIMEOUT_SEC


def is_socket_present() -> bool:
    """``/tmp/island.sock`` 文件存在性探测（sleep/wake 后 Swift 端会删除并重建）."""
    try:
        return Path(_socket_path()).exists()
    except OSError:
        return False


def send_sync(envelope_bytes: bytes, *, sock_path: Optional[str] = None,
              timeout: Optional[float] = None) -> SendResult:
    """同步发送 envelope；fail-open，永不抛 socket 异常.

    Args:
        envelope_bytes: ``BridgeEnvelope.encode()`` 输出
        sock_path: 覆盖默认路径；None 时读 env
        timeout: 覆盖默认 3s；None 时读 env

    Returns:
        ``SendResult``。``ok=True`` 表示 envelope 已 flush，response 解析成功（或 expectsResponse=false 时为 None）。
    """
    import time

    t0 = time.monotonic()

    if len(envelope_bytes) > ENVELOPE_MAX_BYTES:
        # 已被 envelope.encode() 截短过仍超限 → 拒绝发送，避免 OOM 对端
        msg = f"envelope > {ENVELOPE_MAX_BYTES} bytes ({len(envelope_bytes)})"
        log.warning("[island] %s", msg)
        return SendResult(ok=False, error=msg)

    path = sock_path or _socket_path()
    deadline = timeout if timeout is not None else _socket_timeout()

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(deadline)
    sent = False  # sendall 完成 = envelope 已 flush 进 kernel（island socket 常开必收到）
    try:
        sock.connect(path)
        sock.sendall(envelope_bytes)
        sent = True
        try:
            sock.shutdown(socket.SHUT_WR)
        except OSError:
            # 某些 Swift NIO 实现下 shutdown 可能在已关闭 channel 上 raise；忽略即可
            pass

        buf = bytearray()
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf.extend(chunk)
            if len(buf) > RESPONSE_MAX_BYTES:
                raise ProtocolError(f"response > {RESPONSE_MAX_BYTES} bytes")

        latency_ms = int((time.monotonic() - t0) * 1000)
        if not buf:
            return SendResult(ok=True, response=None, latency_ms=latency_ms)
        try:
            resp = json.loads(buf.decode("utf-8"))
            if not isinstance(resp, dict):
                resp = {"raw": resp}
            return SendResult(ok=True, response=resp, latency_ms=latency_ms)
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            log.debug("[island] response not JSON: %s", e)
            return SendResult(ok=True, response=None, latency_ms=latency_ms)

    except (socket.timeout, FileNotFoundError, ConnectionRefusedError, BrokenPipeError,
            ConnectionResetError, ProtocolError, OSError) as e:
        latency_ms = int((time.monotonic() - t0) * 1000)
        # 已 sendall 成功后的 recv 超时 ≠ 送达失败：带按钮卡（expects_response=True）的同步
        # 回答窗口只有 3s，人几乎不可能赶上（真实点击走解耦 ack POST /api/island/ack）——
        # 每次 urgent 卡发送必然 recv 超时。误判 ok=False 会入 island_reconnect 队列 →
        # flush 重发 → 再超时再入队 = 永动重弹（且重弹卡的 ack_token 已被首次消费，按钮全
        # 404）。此处返回 ok=True（无同步回答）：不入队、dispatch 记 ok=1（§9-2 持久 dedup
        # 也因此生效）。其余异常（connect 拒绝 / 未完成 sendall / 协议违规）保持 ok=False。
        if sent and isinstance(e, socket.timeout):
            log.debug("[island] delivered, no sync response within %.1fs (async ack path)",
                      deadline)
            return SendResult(ok=True, response=None, error="response_timeout",
                              latency_ms=latency_ms)
        log.debug("[island] dispatch failed (fail-open): %s", e)
        return SendResult(ok=False, error=str(e), latency_ms=latency_ms)
    finally:
        try:
            sock.close()
        except OSError:
            pass


async def send_async(envelope: BridgeEnvelope, *, sock_path: Optional[str] = None,
                     timeout: Optional[float] = None) -> SendResult:
    """``send_sync`` 的 asyncio 包装，避免阻塞主 loop."""
    data = envelope.encode()
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _send_sync_partial(data, sock_path, timeout))


def _send_sync_partial(data: bytes, sock_path: Optional[str], timeout: Optional[float]):
    def _runner() -> SendResult:
        return send_sync(data, sock_path=sock_path, timeout=timeout)
    return _runner
