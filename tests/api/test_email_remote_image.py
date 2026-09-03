"""远程图片代理端点 (src/api/routers/email_remote_image.py) — H3a。

覆盖重心 = PRD 的 **SSRF 九条**，逐条一测（编号与端点 docstring / PRD 一致）：
  ① scheme 仅 http/https                  → test_rejects_non_http_scheme
  ② 拒 loopback/私网/link-local/保留段      → test_rejects_blocked_address_family（v4/v6/v4-mapped）
  ③ 拒 URL 内嵌凭证                        → test_rejects_url_with_credentials
  ④ redirect 逐跳重校验 + 跳数上限          → test_redirect_to_private_is_blocked /
                                            test_redirect_chain_over_cap
  ⑤ Content-Type 必须 image/*              → test_rejects_non_image_content_type /
                                            test_rejects_missing_content_type
  ⑥ 10 MiB 上限 + 流式截断                  → test_rejects_oversize_declared /
                                            test_rejects_oversize_streamed
  ⑦ 连接与总超时                            → test_slow_upstream_times_out
  ⑧ 出站不带 cookie / Referer / 本机凭证     → test_outbound_carries_no_credentials
  ⑨ 只回图片字节 + 安全响应头，不透传上游头   → test_success_returns_image_only

另一半重心 = **签名闸**（0903 返工批 B2）：邮件正文自己写的代理 URL 拿不到签名 ⇒ 取不到图。
  → test_rejects_unsigned / test_rejects_tampered_url / test_rejects_expired_signature /
    test_grant_* 一组

🔴 因此 ``_get`` 默认**带签名**打端点 —— 上面九条测的是「拿到放行票之后」的 SSRF 防线，
不签的话它们会全部停在 403 验签这一步（测试仍绿，但测的东西没了）。验签本身用
``_get_unsigned`` 单独测。

实现策略沿用 tests/api/test_web.py：真起 loopback ``ThreadingHTTPServer`` 当上游站点（走真
socket + 真 httpx 钉 IP 路径）。因 fake server 在 127.0.0.1（SSRF 本应拒），管道测试
monkeypatch 模块级 ``_check_ip`` 放行 loopback，**非 loopback 仍走真 validator**；SSRF 分类
矩阵则直接打端点、不放行，验真 validator。全部离线。
"""

from __future__ import annotations

import ipaddress
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Iterator, Optional
from urllib.parse import urlparse

import pytest
from fastapi.testclient import TestClient

import src.api.routers.email_remote_image as rimg
from src.api.app import app

# 1x1 透明 PNG（真图片字节，能被 <img> 解出来）。
_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06"
    b"\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\xdac\xfc\xff\xff?\x00\x05\xfe"
    b"\x02\xfe\xa7\x35\x81\x84\x00\x00\x00\x00IEND\xaeB`\x82"
)

# 收到的请求头（⑧ 断言用）。fake server 每次 do_GET 覆写。
_LAST_HEADERS: dict[str, str] = {}


class _FakeUpstreamHandler(BaseHTTPRequestHandler):
    """最小 fake 上游图床，按 path 路由。"""

    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # noqa: D401 — 静音
        pass

    def _send(self, status: int, body: bytes, content_type: Optional[str], extra=None):
        try:
            self.send_response(status)
            if content_type is not None:
                self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # 客户端触 cap 后关连接（size-cap 用例）—— 预期内。

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        _LAST_HEADERS.clear()
        _LAST_HEADERS.update({k.lower(): v for k, v in self.headers.items()})
        if path == "/pixel.png":
            # 上游附带一堆**不该被透传**的响应头（⑨）。
            self._send(
                200,
                _PNG,
                "image/png",
                {
                    "Set-Cookie": "track=abc; Path=/",
                    "X-Upstream-Tracker": "yes",
                    "Cache-Control": "public, max-age=31536000",
                },
            )
        elif path == "/not-image":
            self._send(200, b"<html>gotcha</html>", "text/html; charset=utf-8")
        elif path == "/no-ct":
            self._send(200, _PNG, None)
        elif path == "/huge-declared":
            # Content-Length 谎报超限 → 一字节不读就拒。
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(rimg._MAX_IMAGE_BYTES + 1))
            self.end_headers()
            try:
                self.wfile.write(b"\x00" * 1024)
            except (BrokenPipeError, ConnectionResetError):
                pass
        elif path == "/huge-chunked":
            # 不报 Content-Length（chunked）→ 只能靠流式 cap 兜住。
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            block = b"0" * 65536
            try:
                for _ in range((rimg._MAX_IMAGE_BYTES // len(block)) + 8):
                    self.wfile.write(b"%X\r\n" % len(block) + block + b"\r\n")
                self.wfile.write(b"0\r\n\r\n")
            except (BrokenPipeError, ConnectionResetError):
                pass
        elif path == "/slow":
            time.sleep(2.0)
            self._send(200, _PNG, "image/png")
        elif path == "/redirect-private":
            self._send(302, b"", "text/plain", {"Location": "http://10.0.0.1/pixel.png"})
        elif path == "/redirect-ok":
            self._send(302, b"", "text/plain", {"Location": "/pixel.png"})
        elif path.startswith("/hop"):
            # /hop1 → /hop2 → ... 无限接力，用来撞跳数上限。
            n = int(path[4:] or "1")
            self._send(302, b"", "text/plain", {"Location": f"/hop{n + 1}"})
        elif path == "/boom":
            self._send(500, b"upstream exploded: internal detail leaked", "text/plain")
        else:
            self._send(404, b"nope", "text/plain")


@pytest.fixture(scope="module")
def upstream() -> Iterator[int]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _FakeUpstreamHandler)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        yield port
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture()
def client() -> Iterator[TestClient]:
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


@pytest.fixture()
def allow_loopback(monkeypatch: pytest.MonkeyPatch):
    """放行 loopback（供管道测试打 fake 上游）；**非 loopback 仍走真 validator**。"""
    real_check = rimg._check_ip

    def _check(ip_str: str) -> None:
        bare = ip_str.split("%", 1)[0]
        if ipaddress.ip_address(bare).is_loopback:
            return
        real_check(ip_str)

    monkeypatch.setattr(rimg, "_check_ip", _check)


def _signed_params(url: str, *, ttl: int = 300) -> dict[str, object]:
    """真签一张放行票（用端点自己的 ``_sign``，密钥就是模块里那把进程内随机的）。"""
    exp = int(time.time()) + ttl
    return {"url": url, "exp": exp, "sig": rimg._sign(url, exp)}


def _get(client: TestClient, url: str):
    """带合法签名打端点 —— SSRF 九条测的是「过了签名闸之后」的防线。"""
    return client.get("/api/email/remote-image", params=_signed_params(url))


def _get_unsigned(client: TestClient, url: str, **extra: object):
    """不带（或带坏）签名打端点 —— 专测签名闸本身。"""
    return client.get("/api/email/remote-image", params={"url": url, **extra})


# ===========================================================================
# ①③ URL 基础校验 — scheme / userinfo（不放行 loopback，走真 validator）
# ===========================================================================


@pytest.mark.parametrize(
    "url",
    [
        "ftp://example.com/a.png",
        "file:///etc/passwd",
        "data:image/png;base64,AAAA",
        "cid:image001.png@01D",
    ],
)
def test_rejects_non_http_scheme(client: TestClient, url: str) -> None:
    """① 只允许 http/https。"""
    resp = _get(client, url)
    assert resp.status_code == 400
    assert resp.content == b""


def test_rejects_url_with_credentials(client: TestClient) -> None:
    """③ 拒 ``user:pass@host``（凭据经 URL 泄漏 + 常见 SSRF 混淆 http://trusted@evil/）。"""
    resp = _get(client, "http://user:pass@example.com/a.png")
    assert resp.status_code == 403
    assert resp.content == b""


# ===========================================================================
# ② IP 分类拒斥 —— 端到端打端点（假 DNS 把公网主机名解析到各类内网地址）
# ===========================================================================

_BLOCKED_IPS = [
    "127.0.0.1",  # loopback v4
    "10.0.0.1",  # private A
    "172.16.5.5",  # private B
    "192.168.1.1",  # private C
    "169.254.169.254",  # link-local（云元数据端点！）
    "0.0.0.0",  # unspecified
    "224.0.0.1",  # multicast
    "100.64.0.1",  # CGNAT (RFC6598)
    "198.18.0.1",  # benchmarking
    "192.0.2.1",  # documentation (TEST-NET-1)
]
_BLOCKED_V6 = [
    "::1",  # loopback v6
    "fc00::1",  # unique-local v6
    "fe80::1",  # link-local v6
    "::ffff:127.0.0.1",  # v4-mapped loopback（v6 外壳藏私网 v4）
    "::ffff:169.254.169.254",  # v4-mapped 元数据端点
    "2001:db8::1",  # documentation v6
]


def _pin_dns(monkeypatch: pytest.MonkeyPatch, ip: str, family: int) -> None:
    def fake_addrinfo(host: str, port: int):
        sockaddr = (ip, port) if family == socket.AF_INET else (ip, port, 0, 0)
        return [(family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", sockaddr)]

    monkeypatch.setattr(rimg, "_addrinfo", fake_addrinfo)


@pytest.mark.parametrize("ip", _BLOCKED_IPS)
def test_rejects_blocked_ipv4(client: TestClient, monkeypatch: pytest.MonkeyPatch, ip: str) -> None:
    """② 公网主机名解析到内网 v4 → 403，且**一个字节都没发出去**。"""
    _pin_dns(monkeypatch, ip, socket.AF_INET)
    resp = _get(client, "https://images.example.com/a.png")
    assert resp.status_code == 403
    assert resp.content == b""


@pytest.mark.parametrize("ip", _BLOCKED_V6)
def test_rejects_blocked_ipv6(client: TestClient, monkeypatch: pytest.MonkeyPatch, ip: str) -> None:
    """② v6 同样拒，含 v4-mapped 外壳。"""
    _pin_dns(monkeypatch, ip, socket.AF_INET6)
    resp = _get(client, "https://images.example.com/a.png")
    assert resp.status_code == 403
    assert resp.content == b""


def test_rejects_when_any_resolved_ip_is_private(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """② 保守：DNS 多解里**任一**不合规即拒（不管我们最终会钉哪个）。"""

    def fake_addrinfo(host: str, port: int):
        return [
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("93.184.216.34", port)),
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("10.0.0.5", port)),
        ]

    monkeypatch.setattr(rimg, "_addrinfo", fake_addrinfo)
    resp = _get(client, "https://rebind.example.com/a.png")
    assert resp.status_code == 403


def test_dns_failure_is_502_empty(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """DNS 解析失败 → 502 空体（不把 resolver 错误原文回给邮件作者）。"""

    def boom(host: str, port: int):
        raise socket.gaierror("nxdomain")

    monkeypatch.setattr(rimg, "_addrinfo", boom)
    resp = _get(client, "https://nope.example.com/a.png")
    assert resp.status_code == 502
    assert resp.content == b""


# ===========================================================================
# ④ redirect 逐跳重校验 + 跳数上限
# ===========================================================================


def test_redirect_to_private_is_blocked(
    client: TestClient, upstream: int, allow_loopback
) -> None:
    """④ 首跳合法、Location 指向内网 → 下一跳重校验拦下（403）。"""
    resp = _get(client, f"http://127.0.0.1:{upstream}/redirect-private")
    assert resp.status_code == 403
    assert resp.content == b""


def test_redirect_followed_when_target_allowed(
    client: TestClient, upstream: int, allow_loopback
) -> None:
    """④ 合法跳仍然跟：一跳后拿到真图片。"""
    resp = _get(client, f"http://127.0.0.1:{upstream}/redirect-ok")
    assert resp.status_code == 200
    assert resp.content == _PNG


def test_redirect_chain_over_cap(client: TestClient, upstream: int, allow_loopback) -> None:
    """④ 跳数上限：无限接力的 302 链撞 _MAX_REDIRECTS → 502 空体（不无限跟）。"""
    resp = _get(client, f"http://127.0.0.1:{upstream}/hop1")
    assert resp.status_code == 502
    assert resp.content == b""


# ===========================================================================
# ⑤ Content-Type 必须 image/*
# ===========================================================================


def test_rejects_non_image_content_type(client: TestClient, upstream: int, allow_loopback) -> None:
    """⑤ text/html 上游 → 415 空体（HTML 绝不能经本端点回到 renderer）。"""
    resp = _get(client, f"http://127.0.0.1:{upstream}/not-image")
    assert resp.status_code == 415
    assert resp.content == b""


def test_rejects_missing_content_type(client: TestClient, upstream: int, allow_loopback) -> None:
    """⑤ 缺 Content-Type 也拒（fail-closed，不靠 sniff 猜）。"""
    resp = _get(client, f"http://127.0.0.1:{upstream}/no-ct")
    assert resp.status_code == 415
    assert resp.content == b""


# ===========================================================================
# ⑥ 体积上限（声明值 + 流式）
# ===========================================================================


def test_rejects_oversize_declared(client: TestClient, upstream: int, allow_loopback) -> None:
    """⑥ Content-Length 超限 → 413，body 一字节不读。"""
    resp = _get(client, f"http://127.0.0.1:{upstream}/huge-declared")
    assert resp.status_code == 413
    assert resp.content == b""


def test_rejects_oversize_streamed(client: TestClient, upstream: int, allow_loopback) -> None:
    """⑥ chunked 不报长度 → 流式累计触 cap 即停读并拒（不回半张损坏的图）。"""
    resp = _get(client, f"http://127.0.0.1:{upstream}/huge-chunked")
    assert resp.status_code == 413
    assert resp.content == b""


# ===========================================================================
# ⑦ 超时
# ===========================================================================


def test_slow_upstream_times_out(
    client: TestClient, upstream: int, monkeypatch: pytest.MonkeyPatch, allow_loopback
) -> None:
    """⑦ 总预算耗尽 → 504 空体（把预算压到 0.3s，上游 sleep 2s）。"""
    monkeypatch.setattr(rimg, "_TIMEOUT_SEC", 0.3)
    resp = _get(client, f"http://127.0.0.1:{upstream}/slow")
    assert resp.status_code == 504
    assert resp.content == b""


# ===========================================================================
# ⑧ 出站不带任何凭证
# ===========================================================================


def test_outbound_carries_no_credentials(
    client: TestClient, upstream: int, allow_loopback
) -> None:
    """⑧ 入站请求带 cookie / Referer / 本地 token，出站请求一个都不许带。"""
    resp = client.get(
        "/api/email/remote-image",
        params=_signed_params(f"http://127.0.0.1:{upstream}/pixel.png"),
        headers={
            "Cookie": "CF_Authorization=secret-jwt",
            "Referer": "http://127.0.0.1:8200/api/email/1",
            "Authorization": "Bearer inbound-secret",
            "X-MailAgent-Local-Token": "tok-inbound",
        },
    )
    assert resp.status_code == 200
    for banned in ("cookie", "referer", "authorization", "x-mailagent-local-token"):
        assert banned not in _LAST_HEADERS, f"outbound request leaked {banned}"
    # 出站 UA 不伪装成浏览器；Accept-Encoding 恒 identity（解压炸弹 fail-closed 的前提）。
    assert _LAST_HEADERS.get("user-agent", "").startswith("MailAgent/")
    assert _LAST_HEADERS.get("accept-encoding") == "identity"


# ===========================================================================
# ⑨ 只回图片字节 + 安全响应头
# ===========================================================================


def test_success_returns_image_only(client: TestClient, upstream: int, allow_loopback) -> None:
    """⑨ 成功路径：原字节 + image/png；上游的 Set-Cookie / 追踪头 / 缓存头一律不透传。"""
    resp = _get(client, f"http://127.0.0.1:{upstream}/pixel.png")
    assert resp.status_code == 200
    assert resp.content == _PNG
    assert resp.headers["content-type"].startswith("image/png")
    assert "set-cookie" not in resp.headers
    assert "x-upstream-tracker" not in resp.headers
    assert resp.headers["cache-control"] == "no-store"
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in resp.headers["content-security-policy"]


def test_upstream_error_body_not_leaked(client: TestClient, upstream: int, allow_loopback) -> None:
    """上游 500 的错误原文不回给调用方（空体 502）—— 不做内网探测 oracle。"""
    resp = _get(client, f"http://127.0.0.1:{upstream}/boom")
    assert resp.status_code == 502
    assert resp.content == b""


# ===========================================================================
# 钉 IP（防 DNS rebinding）— 连接落在已校验 IP，Host 仍是原主机名
# ===========================================================================


def test_pins_validated_ip_preserves_host_header(
    client: TestClient, upstream: int, monkeypatch: pytest.MonkeyPatch, allow_loopback
) -> None:
    """假主机名解析到 loopback fake 上游；server 收到的 Host = 原主机名 ⇒ 连接钉在校验过的
    IP 上、没有对 Host 二次解析（关闭 rebinding 窗口）。"""

    def fake_addrinfo(host: str, port: int):
        if host == "pinned.example.com":
            return [
                (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("127.0.0.1", port))
            ]
        return rimg._addrinfo(host, port)

    monkeypatch.setattr(rimg, "_addrinfo", fake_addrinfo)
    resp = _get(client, f"http://pinned.example.com:{upstream}/pixel.png")
    assert resp.status_code == 200
    assert _LAST_HEADERS.get("host") == f"pinned.example.com:{upstream}"


# ===========================================================================
# 鉴权 —— 不因为「是 <img> 请求」就开免鉴权口子
# ===========================================================================


def test_requires_auth(monkeypatch: pytest.MonkeyPatch, upstream: int) -> None:
    """关掉 dev bypass 后无凭证 → 401（与其余 email 端点同一道门）。"""
    import src.api.auth as auth_mod

    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", "")
    with TestClient(app, raise_server_exceptions=False) as c:
        resp = _get(c, f"http://127.0.0.1:{upstream}/pixel.png")
    assert resp.status_code == 401


# ===========================================================================
# 签名闸 (B2) —— 「凭证」不是「授权」：正文自己写的代理 URL 签不出来
#
# 攻击链（复核实测）：renderer CSP 的 img-src 放行 http://127.0.0.1:*，主进程的
# chat_local_bridge 对该端口的**所有**请求无条件注入本地 token ⇒ 正文里硬编码一个
# `…/api/email/remote-image?url=https://tracker/p.png` 就能在打开邮件的瞬间零点击出网。
# 唯一结构性的挡法 = 要求一份正文伪造不出来的签名（正文 iframe 无 allow-scripts）。
# ===========================================================================


def test_rejects_unsigned(client: TestClient, upstream: int, allow_loopback) -> None:
    """🔴 正文里硬编码的代理 URL（带合法 token，但没有签名）→ 403 空体，一个字节都不取。"""
    _LAST_HEADERS.clear()
    resp = _get_unsigned(client, f"http://127.0.0.1:{upstream}/pixel.png")
    assert resp.status_code == 403
    assert resp.content == b""
    # 上游从未被打到 —— 拒在验签，不是拒在取回之后。
    assert _LAST_HEADERS == {}


def test_rejects_signature_without_exp(client: TestClient, upstream: int, allow_loopback) -> None:
    """只带 sig 不带 exp（或反之）也拒 —— 两个都是签名的组成部分。"""
    url = f"http://127.0.0.1:{upstream}/pixel.png"
    signed = _signed_params(url)
    assert _get_unsigned(client, url, sig=signed["sig"]).status_code == 403
    assert _get_unsigned(client, url, exp=signed["exp"]).status_code == 403


def test_rejects_tampered_url(client: TestClient, upstream: int, allow_loopback) -> None:
    """拿到一张给 A 的票，换成 B 打过来 → 403（签名绑定 url）。"""
    signed = _signed_params(f"http://127.0.0.1:{upstream}/pixel.png")
    resp = client.get(
        "/api/email/remote-image",
        params={**signed, "url": f"http://127.0.0.1:{upstream}/boom"},
    )
    assert resp.status_code == 403
    assert resp.content == b""


def test_rejects_expired_signature(client: TestClient, upstream: int, allow_loopback) -> None:
    """过期的票 → 403（票据不长期有效；重新点一次「加载图片」即可）。"""
    resp = client.get(
        "/api/email/remote-image",
        params=_signed_params(f"http://127.0.0.1:{upstream}/pixel.png", ttl=-1),
    )
    assert resp.status_code == 403
    assert resp.content == b""


def test_signing_key_is_not_derivable_from_responses(client: TestClient, upstream: int) -> None:
    """密钥不下发：grant 只回 (url, exp, sig)，响应里出现不了密钥本身。"""
    resp = client.post("/api/email/remote-image/grant", json={"urls": ["https://cdn.example/a.png"]})
    assert resp.status_code == 200
    assert rimg._SIGNING_KEY.hex() not in resp.text


# ── grant 端点 ──────────────────────────────────────────────────────────────


def _grant(client: TestClient, urls: list[str]):
    return client.post("/api/email/remote-image/grant", json={"urls": urls})


def test_grant_then_fetch_round_trip(client: TestClient, upstream: int, allow_loopback) -> None:
    """端到端：换票 → 用票取图 → 200 + 真图字节（前端「点了加载图片」的真实链路）。"""
    url = f"http://127.0.0.1:{upstream}/pixel.png"
    grants = _grant(client, [url]).json()["data"]["grants"]
    assert [g["url"] for g in grants] == [url]

    resp = client.get(
        "/api/email/remote-image",
        params={"url": url, "exp": grants[0]["exp"], "sig": grants[0]["sig"]},
    )
    assert resp.status_code == 200
    assert resp.content == _PNG


def test_grant_drops_unsignable_urls(client: TestClient) -> None:
    """签不了的（scheme 不对 / 内嵌凭证）静默丢掉，其余照签 —— 一条脏 URL 不废掉整封信。"""
    grants = _grant(
        client,
        [
            "https://cdn.example/ok.png",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "http://user:pass@evil.example/a.png",
            "",
        ],
    ).json()["data"]["grants"]
    assert [g["url"] for g in grants] == ["https://cdn.example/ok.png"]


def test_grant_truncates_instead_of_failing_the_whole_batch(client: TestClient) -> None:
    """超过签发上限：丢掉多余的、**其余照签**，不是整批 422。

    整批失败的用户体感是「点了『加载图片』，一张票都没有 + 一句没线索的失败，而且永远修不好」
    —— 计数口径是每条 URL（srcset 每个候选 / CSS 每个 url() 各占一条），长图文新闻信很容易越线。
    """
    urls = [f"https://cdn.example/{i}.png" for i in range(rimg._MAX_GRANT_URLS + 5)]
    resp = _grant(client, urls)
    assert resp.status_code == 200
    grants = resp.json()["data"]["grants"]
    assert len(grants) == rimg._MAX_GRANT_URLS
    # 保序截断：签的是前 N 条，不是随机一批。
    assert grants[0]["url"] == "https://cdn.example/0.png"
    assert grants[-1]["url"] == f"https://cdn.example/{rimg._MAX_GRANT_URLS - 1}.png"


def test_grant_rejects_pathological_request_size(client: TestClient) -> None:
    """请求体条数硬顶仍在 —— 正常邮件够不着，纯粹拦无界列表。"""
    urls = [f"https://cdn.example/{i}.png" for i in range(rimg._MAX_GRANT_REQUEST_URLS + 1)]
    assert _grant(client, urls).status_code == 422


def test_grant_requires_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    """签发口同样在鉴权后面 —— 否则「伪造不出签名」就白说了。"""
    import src.api.auth as auth_mod

    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", "")
    with TestClient(app, raise_server_exceptions=False) as c:
        resp = _grant(c, ["https://cdn.example/a.png"])
    assert resp.status_code == 401


# ===========================================================================
# 可用性护栏 —— 并发取图上限（threadpool 令牌被占满会拖死整个 API）
# ===========================================================================


def test_rejects_when_too_many_fetches_in_flight(
    client: TestClient, upstream: int, monkeypatch: pytest.MonkeyPatch, allow_loopback
) -> None:
    """在途取图数达上限 → 503 空体，不再占 threadpool 令牌。"""
    monkeypatch.setattr(rimg, "_inflight_fetches", rimg._MAX_INFLIGHT_FETCHES)
    resp = _get(client, f"http://127.0.0.1:{upstream}/pixel.png")
    assert resp.status_code == 503
    assert resp.content == b""
