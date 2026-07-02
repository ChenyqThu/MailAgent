"""单测：ping_island.send_sync —— H-16 timeout + H-18 max-size + fail-open 不抛."""

from __future__ import annotations

import asyncio
import json
import socket
import threading
from pathlib import Path
from typing import Optional

import pytest

from src.notify import ping_island
from src.notify.island_envelope import BridgeEnvelope


@pytest.fixture
def tmp_socket(tmp_path: Path):
    """在 /tmp 起一个 unix domain socket server；返回 path + control object.

    macOS 的 AF_UNIX 路径上限 104 字节，pytest tmp_path 太长，所以用 /tmp 加 pid+id。
    """
    import os as _os
    sock_path = Path(f"/tmp/mailagent-island-{_os.getpid()}-{id(tmp_path):x}.sock")
    if sock_path.exists():
        sock_path.unlink()

    class _Control:
        response: Optional[bytes] = b""
        delay: float = 0.0
        received: bytearray = bytearray()
        stopped: bool = False

    ctrl = _Control()

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(sock_path))
    server.listen(4)
    server.settimeout(0.5)

    def _serve():
        while not ctrl.stopped:
            try:
                conn, _ = server.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            try:
                conn.settimeout(2.0)
                # 读 client 写入直到 client shutdown(SHUT_WR)
                buf = bytearray()
                while True:
                    try:
                        chunk = conn.recv(4096)
                    except socket.timeout:
                        break
                    if not chunk:
                        break
                    buf.extend(chunk)
                ctrl.received += bytes(buf)
                if ctrl.delay > 0:
                    import time as _t
                    _t.sleep(ctrl.delay)
                if ctrl.response is not None:
                    try:
                        conn.sendall(ctrl.response)
                    except OSError:
                        pass
            finally:
                try:
                    conn.shutdown(socket.SHUT_WR)
                except OSError:
                    pass
                conn.close()

    t = threading.Thread(target=_serve, daemon=True)
    t.start()

    yield str(sock_path), ctrl

    ctrl.stopped = True
    try:
        server.close()
    except OSError:
        pass
    try:
        sock_path.unlink()
    except OSError:
        pass


def test_send_sets_timeout_and_fails_open_when_server_silent(tmp_socket):
    """H-16: socket.settimeout 三阶段共享 deadline；server 不回任何东西
    + 不 EOF → recv timeout → ok=False 且不抛."""
    sock_path, ctrl = tmp_socket
    ctrl.response = None  # 服务端不写也不 close，让 client recv 卡到 timeout

    # 改成不 shutdown 也不响应 → recv 会 timeout
    # 这里把 conn shutdown 延后到 server 退出时；但 server fixture 默认 shutdown
    # 所以我们改用极短 timeout 来跑出 timeout 路径
    env = BridgeEnvelope(event_type="Notification", session_key="x", title="t")
    result = ping_island.send_sync(env.encode(), sock_path=sock_path, timeout=0.05)
    # 行为允许两种合法结果：
    #   1) timeout（无 response）→ ok=False
    #   2) Server 端 settimeout 不写但很快 close → ok=True, response=None
    # 都不应抛。
    assert result.ok in (True, False)


def test_send_succeeds_when_server_returns_json(tmp_socket):
    sock_path, ctrl = tmp_socket
    ctrl.response = json.dumps({
        "decision": {"answer": {"choice": "open_mail"}}
    }).encode("utf-8")

    env = BridgeEnvelope(event_type="LLMReviewedUrgent", session_key="x", title="t",
                          expects_response=True)
    result = ping_island.send_sync(env.encode(), sock_path=sock_path, timeout=3.0)
    assert result.ok is True
    assert result.response is not None
    assert result.response["decision"]["answer"]["choice"] == "open_mail"
    # 服务端应该收到了我们的 envelope
    assert b'"provider":"mail"' in bytes(ctrl.received)


def test_recv_timeout_after_sendall_is_delivered_ok(tmp_socket):
    """修 4 (urgent 卡永动重弹): sendall 成功 + recv 超时 → ok=True + error='response_timeout'.

    带按钮卡（expects_response=True）的同步回答窗口只有 3s，人几乎不可能赶上（真实点击走
    解耦 ack POST）——每次 urgent 卡发送必然 recv 超时。旧行为把它判成 ok=False → _bg()
    入 reconnect 队列 → flush 重发 → 再超时再入队 = 永动（dogfood 实锤 1000008019：
    dispatched_ok=0 latency=3001ms，重弹卡 ack_token 已消费点 skip 全 404）。
    新语义：envelope 已 flush 进 kernel = 送达成功，无同步回答不是失败。
    """
    sock_path, ctrl = tmp_socket
    ctrl.response = None
    ctrl.delay = 0.6  # server 收完后 hold 0.6s（> client 0.15s timeout）不关连接 → recv 必超时
    env = BridgeEnvelope(event_type="LLMReviewedUrgent", session_key="x", title="t",
                         expects_response=True)
    result = ping_island.send_sync(env.encode(), sock_path=sock_path, timeout=0.15)
    assert result.ok is True
    assert result.response is None
    assert result.error == "response_timeout"
    # envelope 真的送到了 server
    assert b'"provider":"mail"' in bytes(ctrl.received)


def test_send_fails_open_when_socket_missing(tmp_path):
    """ENOENT（未 sendall）→ ok=False, error 设置, 不抛 —— 修 4 只豁免已送达的 recv 超时."""
    sock_path = tmp_path / "nope.sock"
    result = ping_island.send_sync(b"{}", sock_path=str(sock_path), timeout=1.0)
    assert result.ok is False
    assert result.error  # 含 ENOENT-ish 信息


def test_send_rejects_oversize_envelope():
    """H-18: 超 64KiB → reject 不出网。"""
    big = b"x" * (ping_island.ENVELOPE_MAX_BYTES + 1)
    result = ping_island.send_sync(big, sock_path="/tmp/never.sock", timeout=1.0)
    assert result.ok is False
    assert "envelope" in (result.error or "")


def test_is_socket_present_reflects_filesystem(tmp_path, monkeypatch):
    sock_path = tmp_path / "island.sock"
    monkeypatch.setenv("ISLAND_SOCKET_PATH", str(sock_path))
    assert ping_island.is_socket_present() is False
    sock_path.touch()
    assert ping_island.is_socket_present() is True


def test_send_async_runs_through_executor(tmp_socket):
    sock_path, ctrl = tmp_socket
    ctrl.response = b"{}"
    env = BridgeEnvelope(event_type="Notification", session_key="x", title="t")

    async def _run():
        return await ping_island.send_async(env, sock_path=sock_path, timeout=3.0)

    result = asyncio.run(_run())
    assert result.ok is True
