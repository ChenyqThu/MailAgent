"""共享 SSRF 硬化件 src/api/ssrf.py 直接单测（S2 W2 抽取后锁契约）。

web fetch/search 的端到端 SSRF 矩阵（钉 IP / 逐跳 redirect / cap）由 tests/api/test_web.py 守（它经
web.py 薄壳委托 ssrf）；本文件直接单测四件套关键语义 —— check_ip 分类 / validate_url / resolve
注入点 + 逐 IP 拒 / pinned_send 保原主机名。
"""

from __future__ import annotations

import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Iterator

import httpx
import pytest

from src.api import ssrf
from src.api.app import APIError

# ── check_ip 分类矩阵 ──────────────────────────────────────────────────────────────────

_BLOCKED_IPS = [
    "127.0.0.1",  # loopback
    "10.0.0.1",  # private
    "169.254.169.254",  # link-local (cloud metadata)
    "100.64.0.1",  # CGNAT
    "::1",  # loopback v6
    "::ffff:10.0.0.1",  # v4-mapped private
]
_ALLOWED_IPS = ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"]


@pytest.mark.parametrize("ip", _BLOCKED_IPS)
def test_check_ip_blocks_non_public(ip):
    with pytest.raises(APIError) as exc:
        ssrf.check_ip(ip)
    assert exc.value.code == "E_SSRF_BLOCKED"


@pytest.mark.parametrize("ip", _ALLOWED_IPS)
def test_check_ip_allows_public(ip):
    ssrf.check_ip(ip)  # must not raise


# ── validate_url ───────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "url,code",
    [
        ("ftp://example.test/x", "E_INVALID_ARG"),
        ("file:///etc/passwd", "E_INVALID_ARG"),
        ("http://user:pass@example.test/", "E_SSRF_BLOCKED"),  # userinfo
    ],
)
def test_validate_url_rejects(url, code):
    with pytest.raises(APIError) as exc:
        ssrf.validate_url(url)
    assert exc.value.code == code


def test_validate_url_accepts_plain_https():
    u = ssrf.validate_url("https://example.test/a?b=1")
    assert u.host == "example.test"


# ── resolve_and_validate（注入点 + 逐 IP 拒 + DNS 失败）────────────────────────────────────


def test_resolve_rejects_when_any_ip_private():
    def fake_addrinfo(host, port):
        return [
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("1.2.3.4", port)),
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("10.0.0.5", port)),
        ]

    with pytest.raises(APIError) as exc:
        ssrf.resolve_and_validate("rebind.test", 80, addrinfo=fake_addrinfo)
    assert exc.value.code == "E_SSRF_BLOCKED"


def test_resolve_dns_failure_is_upstream():
    def boom(host, port):
        raise socket.gaierror("nxdomain")

    with pytest.raises(APIError) as exc:
        ssrf.resolve_and_validate("nope.test", 80, addrinfo=boom)
    assert exc.value.code == "E_UPSTREAM"


def test_resolve_returns_first_validated_ip():
    def fake_addrinfo(host, port):
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("93.184.216.34", port))]

    assert ssrf.resolve_and_validate("ok.test", 80, addrinfo=fake_addrinfo) == "93.184.216.34"


def test_resolve_check_injection_point():
    """check 注入点：可放行 loopback（web.py 薄壳靠这个让 test_web 打 fake server）。"""
    def fake_addrinfo(host, port):
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("127.0.0.1", port))]

    ssrf.resolve_and_validate("local.test", 80, addrinfo=fake_addrinfo, check=lambda ip: None)


# ── pinned_send：保原 Host（连 pinned IP，证书按原 host）───────────────────────────────────


class _EchoHostHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # noqa: D401 — silence
        pass

    def do_GET(self):  # noqa: N802
        host = self.headers.get("Host", "")
        body = f"host={host}".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture()
def echo_server() -> Iterator[int]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _EchoHostHandler)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        yield port
    finally:
        server.shutdown()
        server.server_close()


def test_pinned_send_preserves_host_header(echo_server):
    """URL host = 假主机名，pinned_ip = 127.0.0.1 → server 收到的 Host 仍是原主机名（证明连接钉在
    pinned IP，非对 Host 再解析）。"""
    url = ssrf.validate_url(f"http://pinned.test:{echo_server}/x")
    headers = {"User-Agent": "t", "Accept-Encoding": "identity"}
    with httpx.Client(trust_env=False, follow_redirects=False) as client:
        resp = ssrf.pinned_send(client, url, "127.0.0.1", headers, 5.0, stream=True)
        try:
            body = b"".join(resp.iter_bytes())
        finally:
            resp.close()
    assert f"host=pinned.test:{echo_server}" in body.decode()
