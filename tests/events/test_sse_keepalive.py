"""验 sse_server 对 aiohttp tcp_keepalive 的 macOS 兼容 patch。

aiohttp 3.9.1 RequestHandler.connection_made 无条件 setsockopt(SO_KEEPALIVE),
macOS 上对某些 SSE 连接 socket 报 OSError [Errno 22] 刷 error log。sse_server import
时 monkeypatch web_protocol.tcp_keepalive 成失败静默版。
"""
import socket
from unittest.mock import MagicMock

import aiohttp.web_protocol as _wp

# import 触发 patch (module-level monkeypatch)
import src.sse_server  # noqa: F401,E402


def test_sse_import_patches_tcp_keepalive():
    """import sse_server 后 web_protocol.tcp_keepalive 被替换成安全版。"""
    assert getattr(_wp.tcp_keepalive, "_mailagent_safe", False) is True


def test_safe_tcp_keepalive_swallows_oserror():
    """setsockopt 抛 OSError(Errno 22) 时 patched tcp_keepalive 不抛 (吞掉)。"""
    sock = MagicMock()
    sock.setsockopt.side_effect = OSError(22, "Invalid argument")
    transport = MagicMock()
    transport.get_extra_info.return_value = sock

    _wp.tcp_keepalive(transport)  # 不应抛

    sock.setsockopt.assert_called_once()  # 确实尝试了 setsockopt


def test_safe_tcp_keepalive_still_sets_when_ok():
    """正常 socket (setsockopt 成功) 时 keepalive 仍被设置 (不退化功能)。"""
    sock = MagicMock()  # setsockopt 不抛
    transport = MagicMock()
    transport.get_extra_info.return_value = sock

    _wp.tcp_keepalive(transport)

    sock.setsockopt.assert_called_once_with(
        socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1
    )


def test_safe_tcp_keepalive_noop_when_no_socket():
    """transport 无 socket 时不报错 (原逻辑: sock is None 直接返回)。"""
    transport = MagicMock()
    transport.get_extra_info.return_value = None

    _wp.tcp_keepalive(transport)  # 不应抛
