"""共享 SSRF 硬化件 —— 出网前的 URL/IP 校验 + 钉 IP 发送（S2 W2 自 web.py 抽出）。

原为 ``src/api/routers/web.py`` 的模块私有四件套（``_validate_url`` / ``_check_ip`` /
``_resolve_and_validate`` / ``_pinned_send``）。S2 W2 把 skill 供应链下载器（``pack_fetch``）
也接上同一防护 → 抽成本模块单一真源，两处消费（web fetch/search + skill pack 下载）。

**web.py 对外行为字节级零变化**是硬标准：``resolve_and_validate`` 保留 ``addrinfo`` /
``check_ip`` 注入点，web.py 的薄壳 wrapper 透传其模块级名字，故 tests/api/test_web.py 里对
``web._addrinfo`` / ``web._check_ip`` 的 monkeypatch 仍原样生效（校验语义未动，只是实现搬家）。

安全语义（逐条保留，勿弱化）：
  - scheme 仅 http/https；拒 userinfo（``user:pass@host`` = 凭据经 URL 泄漏面 + SSRF 混淆）
  - DNS 解析后**逐 IP** 校验（``socket.getaddrinfo`` 全部结果，v4+v6，含 v4-mapped / 6to4 /
    teredo 内嵌 v4）：``not is_global`` 主闸 + 显式类别 belt-and-suspenders
  - **连接钉死已校验 IP**（防 DNS rebinding TOCTOU）：URL host 改写成 IP 字面量 → httpcore
    不再二次解析；``Host`` header 保原 host（vhost）+ ``sni_hostname`` extension 保原 host →
    TLS SNI + 证书按**原 host** 校验
  - 逐跳 redirect 由 caller 手动循环、每跳重走全套校验（本模块只提供单跳原语）
"""

from __future__ import annotations

import ipaddress
import socket
from typing import Any, Callable, Optional

import httpx

from src.api.app import APIError


def ssrf_error(message: str) -> APIError:
    """SSRF 拦截统一 400（E_SSRF_BLOCKED 不在 ERROR_CODE_TO_HTTP → 显式 http_status）。"""
    return APIError("E_SSRF_BLOCKED", message, http_status=400, source="web")


def check_ip(ip_str: str) -> None:
    """校验单个 IP 是否为可出网的公网 unicast 地址；否则 raise ``ssrf_error``。

    逐类拒：loopback / private / link-local / reserved / multicast / unspecified。
    v6 额外拆解内嵌 v4（v4-mapped ``::ffff:127.0.0.1`` / 6to4 / teredo）——否则可用 v6 外壳
    藏一个私网 v4 目标绕过。
    """
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError as e:  # getaddrinfo 不该返回非法 IP；兜底 fail-closed。
        raise ssrf_error(f"unparseable address: {ip_str}") from e

    candidates: list[ipaddress._BaseAddress] = [ip]
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            candidates.append(ip.ipv4_mapped)
        if ip.sixtofour is not None:
            candidates.append(ip.sixtofour)
        if ip.teredo is not None:
            # teredo = (server_ipv4, client_ipv4) —— 两个 v4 都要校验。
            candidates.extend(ip.teredo)

    for c in candidates:
        # `not is_global` 是主闸——它 subsumes 全部特殊段（private/loopback/link-local/
        # reserved/multicast/unspecified）**并且**含单独列不全的 CGNAT 100.64/10、
        # benchmarking、documentation 等段。显式类别保留仅为错误信息更具体（belt-and-suspenders）。
        if (
            not c.is_global
            or c.is_loopback
            or c.is_private
            or c.is_link_local
            or c.is_reserved
            or c.is_multicast
            or c.is_unspecified
        ):
            raise ssrf_error(f"blocked non-public address: {ip_str}")


# 间接层：caller 可 monkeypatch 一个替身把假主机名映射到 loopback fake server，从而在**不放宽真实
# check_ip** 的前提下端到端跑管道（见 tests/api/test_web.py）。
def default_addrinfo(host: str, port: int) -> list[Any]:
    return socket.getaddrinfo(host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)


def resolve_and_validate(
    host: str,
    port: int,
    *,
    addrinfo: Optional[Callable[[str, int], list[Any]]] = None,
    check: Optional[Callable[[str], None]] = None,
) -> str:
    """DNS 解析 host → 校验**每一个**返回 IP（任一不合规即拒，保守）→ 返回首个校验过的 IP
    作为钉死连接目标。host 本身是 IP 字面量时 getaddrinfo 原样返回、照样校验。

    ``addrinfo`` / ``check`` 注入点：web.py 薄壳透传其模块级 ``_addrinfo`` / ``_check_ip``，让既有
    test_web.py 的 monkeypatch（放行 loopback / 假 DNS）在实现搬家后仍原样生效；缺省用本模块函数
    （pack 下载器等无 loopback 放行的严格路径）。
    """
    _addrinfo = addrinfo or default_addrinfo
    _check = check or check_ip
    try:
        infos = _addrinfo(host, port)
    except socket.gaierror as e:
        raise APIError(
            "E_UPSTREAM", f"DNS resolution failed for {host}: {e}", http_status=502, source="web"
        ) from e
    if not infos:
        raise APIError("E_UPSTREAM", f"no DNS results for {host}", http_status=502, source="web")

    resolved: list[str] = []
    for info in infos:
        sockaddr = info[4]
        ip_str = sockaddr[0]
        # v6 scoped 地址（fe80::1%en0）—— 去掉 zone id 再校验（link-local 本就会被拒）。
        if "%" in ip_str:
            ip_str = ip_str.split("%", 1)[0]
        _check(ip_str)
        resolved.append(ip_str)
    return resolved[0]


def host_port_scheme(url: httpx.URL) -> tuple[str, int, str]:
    scheme = url.scheme
    host = url.host
    port = url.port or (443 if scheme == "https" else 80)
    return host, port, scheme


def validate_url(raw: str) -> httpx.URL:
    """解析 + 基础校验（scheme / userinfo / host）；raise APIError 于非法输入。"""
    try:
        url = httpx.URL(raw)
    except (httpx.InvalidURL, ValueError) as e:
        raise APIError("E_INVALID_ARG", f"invalid url: {e}", http_status=400, source="web") from e
    if url.scheme not in ("http", "https"):
        raise APIError(
            "E_INVALID_ARG",
            f"unsupported scheme '{url.scheme}' (only http/https)",
            http_status=400,
            source="web",
        )
    if url.username or url.password:
        # 拒 userinfo：凭据经 URL 泄漏面 + 常见 SSRF 混淆（http://trusted@evil/）。
        raise ssrf_error("url must not contain userinfo (user:pass@host)")
    if not url.host:
        raise APIError("E_INVALID_ARG", "url has no host", http_status=400, source="web")
    return url


def pinned_send(
    client: httpx.Client,
    url: httpx.URL,
    pinned_ip: str,
    headers: dict[str, str],
    timeout: float,
    *,
    stream: bool = True,
) -> httpx.Response:
    """对**已校验**的 pinned_ip 发起一次请求（钉死连接、防 rebinding）：改写 URL host 成 IP
    字面量（httpcore 不再解析）+ Host header 保原 host + sni_hostname extension 保原 host
    （TLS 证书按原 host 校验）。``headers`` 由 caller 提供（fetch 与 pack 下载器不同 Accept，
    但都必须含 ``Accept-Encoding: identity`` 防解压炸弹）。"""
    original_host = url.host
    req = client.build_request("GET", url, headers=headers, timeout=timeout)
    # build 时 Host 已从原 URL 生成（含非默认端口），先存下来。
    host_header = req.headers.get("Host") or original_host
    req.url = req.url.copy_with(host=pinned_ip)
    req.headers["Host"] = host_header
    req.extensions = {**req.extensions, "sni_hostname": original_host}
    return client.send(req, stream=stream, follow_redirects=False)
