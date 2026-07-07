"""web 联网工具端点 (src/api/routers/web.py) — S1 R3 agent openness wave1.

覆盖重心 = **SSRF 防护全矩阵**（本 wave 安全验收）：
  - IP 分类拒斥（loopback/private/link-local/reserved/multicast/unspecified/CGNAT + v6 内嵌 v4）；
  - scheme / userinfo 拒斥；
  - **连接钉死已校验 IP**（Host header 保原主机名 = 证明连的是 pinned IP 而非再解析）；
  - redirect 逐跳重校验（重定向到内网 → 拒）；
  - size cap 截断 / content-type 415；
  - DDG 搜索解析 + uddg 解包 + 非 200 明确错误；
  - 鉴权（verify_cf_access 关闭 bypass → 401）。

实现策略：真起 loopback ``ThreadingHTTPServer`` 当被抓站点（非 mock，走真 socket + 真 httpx 钉 IP
路径）。因 fake server 在 127.0.0.1（SSRF 本应拒），fetch 管道测试 monkeypatch ``web._check_ip``
放行 loopback（非 loopback 仍走**真** validator），从而在不弱化真校验的前提下端到端跑管道；
SSRF 分类矩阵则直接单测**真** validator（无 server、无放行）。DDG 搜索把 ``_DDG_HTML_URL`` 指向
同一 fake server，测真 httpx.get + 真解析。全部离线，不依赖外网。
"""

from __future__ import annotations

import gzip
import ipaddress
import socket
import threading
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Iterator, Optional
from urllib.parse import urlparse

import pytest
from fastapi.testclient import TestClient

import src.api.auth as auth_mod
import src.api.routers.web as web
from src.api.app import app

# ---------------------------------------------------------------------------
# DDG HTML fixture (structure = html.duckduckgo.com/html/ stable anchors)
# ---------------------------------------------------------------------------

_DDG_FIXTURE = """<!DOCTYPE html><html><body>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a"
         href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fq3-plan&amp;rut=abc">Q3 Plan Overview</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fq3-plan">
      The Q3 plan ships with three milestones.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a"
         href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Froadmap&amp;rut=def">Roadmap 2026</a>
    </h2>
    <a class="result__snippet">Next milestones and dates.</a>
  </div>
</div>
</body></html>"""

_HTML_PAGE = (
    "<html><head><title>Example Page</title></head>"
    "<body><script>var x=1;</script><h1>Heading</h1>"
    "<p>The quarterly plan ships in Q3.</p></body></html>"
)


class _FakeSiteHandler(BaseHTTPRequestHandler):
    """最小 fake 被抓站点/搜索端点，按 path 路由。"""

    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # noqa: D401 — 静音
        pass

    def _send(self, status: int, body: bytes, content_type: str, extra: Optional[dict] = None):
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # client capped the read and closed the conn (size-cap test) — expected.

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/page":
            self._send(200, _HTML_PAGE.encode(), "text/html; charset=utf-8")
        elif path == "/echo-host":
            # 回显收到的 Host header —— 证明钉 IP 后连接落在 pinned IP、Host 仍是原主机名。
            host = self.headers.get("Host", "")
            self._send(200, f"host={host}".encode(), "text/plain")
        elif path == "/redirect-rel":
            self._send(302, b"", "text/plain", {"Location": "/page"})
        elif path == "/redirect-internal":
            self._send(302, b"", "text/plain", {"Location": "http://10.0.0.1/secret"})
        elif path == "/big":
            # > 2 MiB → 客户端流式 cap 截断。
            self._send(200, b"A" * (web._MAX_RESPONSE_BYTES + 100_000), "text/html")
        elif path == "/octet":
            self._send(200, b"\x00\x01\x02binary", "application/octet-stream")
        elif path == "/json":
            self._send(200, b'{"ok": true, "n": 3}', "application/json")
        elif path == "/gzipped":
            # 上游无视 Accept-Encoding: identity 强行压缩 → client 侧应 fail-closed 拒。
            self._send(
                200, gzip.compress(_HTML_PAGE.encode()), "text/html", {"Content-Encoding": "gzip"}
            )
        elif path == "/identity-enc":
            self._send(
                200,
                _HTML_PAGE.encode(),
                "text/html; charset=utf-8",
                {"Content-Encoding": "identity"},
            )
        elif path == "/echo-accept-encoding":
            enc = self.headers.get("Accept-Encoding", "")
            self._send(200, f"accept-encoding={enc}".encode(), "text/plain")
        elif path == "/no-ct":
            # 不发 Content-Type（fail-open 回归：缺标注也必须拒）。
            body = b"no content type header"
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif path == "/ddg-big":
            # 2 个正常 result + 2 MiB padding + cap **之外**的第三个 result：bounded 读生效
            # 则第三个永不进解析（count==2）；若全量 buffer 则 html.parser 会解出 3 个。
            third = (
                b'<div class="result"><h2 class="result__title">'
                b'<a class="result__a" href="https://evil.test/past-cap">Past Cap</a></h2></div>'
            )
            body = _DDG_FIXTURE.encode() + b" " * web._MAX_RESPONSE_BYTES + third
            self._send(200, body, "text/html; charset=utf-8")
        elif path == "/ddg":
            self._send(200, _DDG_FIXTURE.encode(), "text/html; charset=utf-8")
        elif path == "/ddg-503":
            self._send(503, b"rate limited", "text/plain")
        else:
            self._send(404, b"nope", "text/plain")


@pytest.fixture(scope="module")
def fake_site() -> Iterator[int]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _FakeSiteHandler)
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
    """放行 loopback（供 fetch 管道测试打 fake server）；**非 loopback 仍走真 validator**。"""
    real_check = web._check_ip

    def _check(ip_str: str) -> None:
        bare = ip_str.split("%", 1)[0]
        if ipaddress.ip_address(bare).is_loopback:
            return
        real_check(ip_str)

    monkeypatch.setattr(web, "_check_ip", _check)


@pytest.fixture(autouse=True)
def tavily_cfg(monkeypatch: pytest.MonkeyPatch):
    """Stub ``web.get_settings()`` → 可设的 ``tavily_api_key``（默认 '' = DDG 回落路径）。

    autouse 使所有 search 测试独立于真实 Config（CI 无 .env 也稳，复刻其它 get_settings-
    消费端点测试的 stub 惯例）。fetch 测试不读它 → 无副作用。Tavily 测试把 ``holder['key']``
    设成逗号分隔 key 串来走 Tavily 路径。"""
    holder = {"key": ""}
    monkeypatch.setattr(
        web, "get_settings", lambda: types.SimpleNamespace(tavily_api_key=holder["key"])
    )
    return holder


def _raise_boom(msg: str):
    """返回一个被调用即 raise AssertionError 的桩 —— 断言某回落分支绝不被走到。"""

    def _f(*args, **kwargs):
        raise AssertionError(msg)

    return _f


# ===========================================================================
# 1) SSRF 分类矩阵 — 直接单测真 validator（无 server / 无放行）
# ===========================================================================

_BLOCKED_IPS = [
    "127.0.0.1",  # loopback v4
    "10.0.0.1",  # private A
    "172.16.5.5",  # private B
    "192.168.1.1",  # private C
    "169.254.169.254",  # link-local (cloud metadata!)
    "0.0.0.0",  # unspecified
    "224.0.0.1",  # multicast
    "100.64.0.1",  # CGNAT (RFC6598) — not global
    "198.18.0.1",  # benchmarking
    "192.0.2.1",  # documentation (TEST-NET-1)
    "::1",  # loopback v6
    "fc00::1",  # unique-local v6
    "fe80::1",  # link-local v6
    "::ffff:127.0.0.1",  # v4-mapped loopback
    "::ffff:10.0.0.1",  # v4-mapped private
    "2001:db8::1",  # documentation v6
]

_ALLOWED_IPS = ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]


@pytest.mark.parametrize("ip", _BLOCKED_IPS)
def test_check_ip_blocks_non_public(ip: str) -> None:
    from src.api.app import APIError

    with pytest.raises(APIError) as exc:
        web._check_ip(ip)
    assert exc.value.code == "E_SSRF_BLOCKED"
    assert exc.value.http_status == 400


@pytest.mark.parametrize("ip", _ALLOWED_IPS)
def test_check_ip_allows_public(ip: str) -> None:
    web._check_ip(ip)  # must not raise


def test_resolve_and_validate_rejects_when_any_ip_private(monkeypatch: pytest.MonkeyPatch) -> None:
    """DNS 返回含私网 IP → 拒（保守：任一不合规即拒，不管我们最终钉哪个）。"""
    from src.api.app import APIError

    def fake_addrinfo(host: str, port: int):
        return [
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("1.2.3.4", port)),
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("10.0.0.5", port)),
        ]

    monkeypatch.setattr(web, "_addrinfo", fake_addrinfo)
    with pytest.raises(APIError) as exc:
        web._resolve_and_validate("rebind.test", 80)
    assert exc.value.code == "E_SSRF_BLOCKED"


def test_resolve_and_validate_dns_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    from src.api.app import APIError

    def boom(host: str, port: int):
        raise socket.gaierror("nxdomain")

    monkeypatch.setattr(web, "_addrinfo", boom)
    with pytest.raises(APIError) as exc:
        web._resolve_and_validate("nope.test", 80)
    assert exc.value.code == "E_UPSTREAM"


# ===========================================================================
# 2) URL 基础校验 — scheme / userinfo
# ===========================================================================


@pytest.mark.parametrize(
    "url,code",
    [
        ("ftp://example.com/x", "E_INVALID_ARG"),  # scheme
        ("file:///etc/passwd", "E_INVALID_ARG"),  # scheme
        ("http://user:pass@example.com/", "E_SSRF_BLOCKED"),  # userinfo
    ],
)
def test_validate_url_rejects(url: str, code: str) -> None:
    from src.api.app import APIError

    with pytest.raises(APIError) as exc:
        web._validate_url(url)
    assert exc.value.code == code


# ===========================================================================
# 3) fetch 管道（真 fake server + 放行 loopback）
# ===========================================================================


def test_fetch_html_extracts_markdown_and_title(
    client: TestClient, fake_site: int, allow_loopback
) -> None:
    resp = client.post("/api/web/fetch", json={"url": f"http://127.0.0.1:{fake_site}/page"})
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["status"] == 200
    assert data["title"] == "Example Page"
    assert "The quarterly plan ships in Q3." in data["text"]
    # script 内容被 bs4 剥离，不进正文。
    assert "var x=1" not in data["text"]
    assert data["content_type"] == "text/html"


def test_fetch_pins_validated_ip_preserves_host_header(
    client: TestClient, fake_site: int, monkeypatch: pytest.MonkeyPatch, allow_loopback
) -> None:
    """假主机名解析到 loopback fake server；断言 server 收到的 Host = 原主机名 → 证明连接钉在
    pinned IP（127.0.0.1）上、而非对 Host 再解析（防 rebinding 的关键行为）。"""

    def fake_addrinfo(host: str, port: int):
        if host == "pinned.test":
            return [
                (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("127.0.0.1", port))
            ]
        return socket.getaddrinfo(host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)

    monkeypatch.setattr(web, "_addrinfo", fake_addrinfo)
    resp = client.post(
        "/api/web/fetch", json={"url": f"http://pinned.test:{fake_site}/echo-host"}
    )
    assert resp.status_code == 200
    # fake server 回显它收到的 Host —— 应是原主机名 pinned.test（连接却落在 127.0.0.1）。
    assert "host=pinned.test" in resp.json()["data"]["text"]


def test_fetch_follows_relative_redirect(
    client: TestClient, fake_site: int, allow_loopback
) -> None:
    resp = client.post(
        "/api/web/fetch", json={"url": f"http://127.0.0.1:{fake_site}/redirect-rel"}
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert "The quarterly plan ships in Q3." in data["text"]
    assert data["final_url"].endswith("/page")


def test_fetch_redirect_to_internal_is_blocked(
    client: TestClient, fake_site: int, allow_loopback
) -> None:
    """hop1 = loopback fake server（放行）→ 302 到 http://10.0.0.1/ → hop2 走真 validator 拒。"""
    resp = client.post(
        "/api/web/fetch", json={"url": f"http://127.0.0.1:{fake_site}/redirect-internal"}
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_SSRF_BLOCKED"


# ---------------------------------------------------------------------------
# gated per-agent redirect origin 白名单（S6 W3，ADR-004 rev3.1 D-fix-1）
# 聚合集 = policyEvaluate 同候选集（enabled + 双键 candidate_policy_rules）∪ 首跳 origin；
# disabled / 错 context_mode 规则不在集内；SSRF 地板叠加不弱化。
# ---------------------------------------------------------------------------

_GATED = {"agent_id": "dms", "context_mode": "untrusted_trigger"}


def _web_rule(store, origin: str, *, agent_id: str = "dms",
              context_mode: str = "untrusted_trigger", enabled: bool = True):
    import json as _json

    rule = store.create_policy_rule(
        "web", _json.dumps({"v": 1, "origin": origin}),
        context_mode=context_mode, agent_id=agent_id,
    )
    if not enabled:
        store.set_policy_rule(rule.id, enabled=False)
    return rule


def test_gated_fetch_redirect_within_whitelisted_origin(
    client: TestClient, fake_site: int, allow_loopback, fresh_agent_cfg
) -> None:
    _web_rule(fresh_agent_cfg, f"http://127.0.0.1:{fake_site}")
    resp = client.post(
        "/api/web/fetch",
        json={"url": f"http://127.0.0.1:{fake_site}/redirect-rel", **_GATED},
    )
    assert resp.status_code == 200
    assert "The quarterly plan ships in Q3." in resp.json()["data"]["text"]


def test_gated_fetch_redirect_to_disabled_rule_origin_aborts(
    client: TestClient, fake_site: int, allow_loopback, fresh_agent_cfg
) -> None:
    """D-fix-1（P0）负例：enabled 规则 A 覆盖首跳，redirect 指向 **disabled** 规则 B 的 origin →
    B 不在聚合集（enabled 过滤 = policyEvaluate 同候选集，绝非 raw list）→ 中止，结构化 403 ——
    且先于 SSRF 判（若误用 raw list_policy_rules 取集，B 会混入、此处变成 400 E_SSRF_BLOCKED）。"""
    _web_rule(fresh_agent_cfg, f"http://127.0.0.1:{fake_site}")
    _web_rule(fresh_agent_cfg, "http://10.0.0.1", enabled=False)
    resp = client.post(
        "/api/web/fetch",
        json={"url": f"http://127.0.0.1:{fake_site}/redirect-internal", **_GATED},
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "E_WEB_ORIGIN_FORBIDDEN"


def test_gated_fetch_ssrf_floor_not_weakened_inside_set(
    client: TestClient, fake_site: int, allow_loopback, fresh_agent_cfg
) -> None:
    """控制组：同一 redirect 目标的规则 **enabled** → 过了 origin 白名单，仍被 SSRF 地板拒
    （两层叠加，白名单绝不豁免 SSRF）。与上一测试成对，证明 403/400 的分野恰是 enabled 位。"""
    _web_rule(fresh_agent_cfg, f"http://127.0.0.1:{fake_site}")
    _web_rule(fresh_agent_cfg, "http://10.0.0.1")
    resp = client.post(
        "/api/web/fetch",
        json={"url": f"http://127.0.0.1:{fake_site}/redirect-internal", **_GATED},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_SSRF_BLOCKED"


def test_gated_fetch_wrong_context_mode_rule_not_in_set(
    client: TestClient, fake_site: int, allow_loopback, fresh_agent_cfg
) -> None:
    """错 context_mode 的规则不进聚合集（双键严格等值；dormant 规则无放行力）。"""
    _web_rule(fresh_agent_cfg, f"http://127.0.0.1:{fake_site}")
    _web_rule(fresh_agent_cfg, "http://10.0.0.1", context_mode="cron_headless")
    resp = client.post(
        "/api/web/fetch",
        json={"url": f"http://127.0.0.1:{fake_site}/redirect-internal", **_GATED},
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "E_WEB_ORIGIN_FORBIDDEN"


def test_gated_fetch_initial_origin_unioned(
    client: TestClient, fake_site: int, allow_loopback, fresh_agent_cfg
) -> None:
    """首跳 origin ∪ 进聚合集：人批（审批卡）放行的 gated fetch 同样带约束参数 —— owner 批的
    URL 自身 origin 可达（零规则下同源 redirect 成功），但出集（跨 origin）redirect 仍中止。
    免卡 fetch 的首跳本就 ∈ 候选集，∪ 不扩大任何免卡面。"""
    resp = client.post(
        "/api/web/fetch",
        json={"url": f"http://127.0.0.1:{fake_site}/redirect-rel", **_GATED},
    )
    assert resp.status_code == 200
    resp2 = client.post(
        "/api/web/fetch",
        json={"url": f"http://127.0.0.1:{fake_site}/redirect-internal", **_GATED},
    )
    assert resp2.status_code == 403
    assert resp2.json()["error"]["code"] == "E_WEB_ORIGIN_FORBIDDEN"


def test_fetch_without_agent_params_unconstrained(
    client: TestClient, fake_site: int, allow_loopback, fresh_agent_cfg
) -> None:
    """无 agent_id（manual / open 档）→ 无 origin 约束（即便库里有规则），仅 SSRF 地板 ——
    wire 缺省形状行为与 S1 字节不变。"""
    _web_rule(fresh_agent_cfg, f"http://127.0.0.1:{fake_site}")
    resp = client.post(
        "/api/web/fetch", json={"url": f"http://127.0.0.1:{fake_site}/redirect-internal"}
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_SSRF_BLOCKED"


def test_gated_fetch_invalid_context_mode_400(client: TestClient, fresh_agent_cfg) -> None:
    """agent_id 在场 + 非法 context_mode → 400（调用方 bug 早暴露，绝不静默降级成无约束）。"""
    resp = client.post(
        "/api/web/fetch",
        json={"url": "https://example.com/", "agent_id": "dms", "context_mode": "bogus"},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_INVALID_ARG"


def test_fetch_size_cap_truncates(client: TestClient, fake_site: int, allow_loopback) -> None:
    resp = client.post("/api/web/fetch", json={"url": f"http://127.0.0.1:{fake_site}/big"})
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["truncated"] is True


def test_fetch_content_type_415(client: TestClient, fake_site: int, allow_loopback) -> None:
    resp = client.post("/api/web/fetch", json={"url": f"http://127.0.0.1:{fake_site}/octet"})
    assert resp.status_code == 415
    assert resp.json()["error"]["code"] == "E_CONTENT_TYPE"


def test_fetch_json_passthrough(client: TestClient, fake_site: int, allow_loopback) -> None:
    resp = client.post("/api/web/fetch", json={"url": f"http://127.0.0.1:{fake_site}/json"})
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["content_type"] == "application/json"
    assert '"ok": true' in data["text"]


def test_fetch_max_chars_clamped_by_schema(client: TestClient, fake_site: int) -> None:
    """max_chars 超上限 → Pydantic 422（body 校验）。"""
    resp = client.post(
        "/api/web/fetch", json={"url": f"http://127.0.0.1:{fake_site}/page", "max_chars": 9_999_999}
    )
    assert resp.status_code == 422


def test_fetch_blocks_loopback_without_allow(client: TestClient, fake_site: int) -> None:
    """无放行 fixture → 真 validator 拒 loopback（端到端证明默认 SSRF 生效）。"""
    resp = client.post("/api/web/fetch", json={"url": f"http://127.0.0.1:{fake_site}/page"})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_SSRF_BLOCKED"


def test_fetch_requests_identity_encoding(
    client: TestClient, fake_site: int, allow_loopback
) -> None:
    """解压炸弹第一翼：请求必须声明 Accept-Encoding: identity（不请压缩）。"""
    resp = client.post(
        "/api/web/fetch", json={"url": f"http://127.0.0.1:{fake_site}/echo-accept-encoding"}
    )
    assert resp.status_code == 200
    assert "accept-encoding=identity" in resp.json()["data"]["text"]


def test_fetch_rejects_compressed_content_encoding(
    client: TestClient, fake_site: int, allow_loopback
) -> None:
    """解压炸弹第二翼 fail-closed：上游无视 identity 强行返回 Content-Encoding: gzip →
    读 body 前直接拒（cap 恒作用于真实传输字节，永不解压）。"""
    resp = client.post("/api/web/fetch", json={"url": f"http://127.0.0.1:{fake_site}/gzipped"})
    assert resp.status_code == 502
    err = resp.json()["error"]
    assert err["code"] == "E_UPSTREAM"
    # message 断言区分「fail-closed 拒」vs「fake server 崩恰好也 502」。
    assert "content-encoding" in err["message"]


def test_fetch_allows_identity_content_encoding(
    client: TestClient, fake_site: int, allow_loopback
) -> None:
    """显式 Content-Encoding: identity（= 未压缩）→ 正常通过。"""
    resp = client.post(
        "/api/web/fetch", json={"url": f"http://127.0.0.1:{fake_site}/identity-enc"}
    )
    assert resp.status_code == 200
    assert "The quarterly plan ships in Q3." in resp.json()["data"]["text"]


def test_fetch_missing_content_type_rejected(
    client: TestClient, fake_site: int, allow_loopback
) -> None:
    """缺 Content-Type → 415（fail-closed，不再放行无标注响应）。"""
    resp = client.post("/api/web/fetch", json={"url": f"http://127.0.0.1:{fake_site}/no-ct"})
    assert resp.status_code == 415
    assert resp.json()["error"]["code"] == "E_CONTENT_TYPE"


def test_fetch_body_read_deadline_times_out(
    client: TestClient, fake_site: int, allow_loopback, monkeypatch: pytest.MonkeyPatch
) -> None:
    """慢速逐 chunk 读（每块都在 per-op timeout 内到）不得无限占线程 —— body 读循环内的总
    deadline 检查兜底。monkeypatch web 命名空间的 time（不污染全局 time 模块）：①deadline
    计算 ②hop 预算 正常，③首个 body chunk 检查时已越过 deadline → 504 失败（非静默截断）。"""
    seq = iter([0.0, 1.0])  # ① deadline=0+15 ② remaining=15-1=14（OK）；之后恒 100 > deadline
    monkeypatch.setattr(web, "time", types.SimpleNamespace(monotonic=lambda: next(seq, 100.0)))
    resp = client.post("/api/web/fetch", json={"url": f"http://127.0.0.1:{fake_site}/page"})
    assert resp.status_code == 504
    assert resp.json()["error"]["code"] == "E_UPSTREAM"


# ===========================================================================
# 4) search（DDG fixture 经 fake server）
# ===========================================================================


def test_search_parses_and_unwraps_uddg(
    client: TestClient, fake_site: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(web, "_DDG_HTML_URL", f"http://127.0.0.1:{fake_site}/ddg")
    resp = client.post("/api/web/search", json={"query": "q3 plan", "limit": 5})
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["count"] == 2
    first = data["results"][0]
    assert first["title"] == "Q3 Plan Overview"
    # uddg 解包成真实 URL（非 //duckduckgo.com/l/ 包装）。
    assert first["url"] == "https://example.com/q3-plan"
    assert "milestones" in first["snippet"]


def test_search_limit_caps_results(
    client: TestClient, fake_site: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(web, "_DDG_HTML_URL", f"http://127.0.0.1:{fake_site}/ddg")
    resp = client.post("/api/web/search", json={"query": "q3 plan", "limit": 1})
    assert resp.status_code == 200
    assert resp.json()["data"]["count"] == 1


def test_search_upstream_non_200_is_explicit_error(
    client: TestClient, fake_site: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    """DDG 限流/非 200 → 明确 E_UPSTREAM，非静默空。"""
    monkeypatch.setattr(web, "_DDG_HTML_URL", f"http://127.0.0.1:{fake_site}/ddg-503")
    resp = client.post("/api/web/search", json={"query": "x", "limit": 5})
    assert resp.status_code == 502
    assert resp.json()["error"]["code"] == "E_UPSTREAM"


def test_search_size_cap_bounds_read(
    client: TestClient, fake_site: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    """超大响应流式 bounded 读（不全量 buffer）：cap 之外的第三个 result 永不进解析
    （count==2 即证只读到 cap 内字节），截断后的前部 HTML 解析照常工作。"""
    monkeypatch.setattr(web, "_DDG_HTML_URL", f"http://127.0.0.1:{fake_site}/ddg-big")
    resp = client.post("/api/web/search", json={"query": "q3 plan", "limit": 10})
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["count"] == 2  # cap 生效：越界的 "Past Cap" result 被截掉
    assert data["results"][0]["title"] == "Q3 Plan Overview"
    assert all(r["url"] != "https://evil.test/past-cap" for r in data["results"])


# ===========================================================================
# 4b) search — Tavily provider (R7: 逗号分隔多 key 额度轮换) — mock httpx, 不打网络
# ===========================================================================

_TAVILY_PAYLOAD = {
    "query": "q3 plan",
    "results": [
        {
            "title": "Q3 Plan",
            "url": "https://example.com/q3",
            "content": "The Q3 plan ships with three milestones.",
            "score": 0.9,
        },
        {
            "title": "Roadmap",
            "url": "https://example.org/roadmap",
            "content": "Next milestones and dates.",
            "score": 0.8,
        },
    ],
}


class _FakeTavilyResp:
    """最小 httpx.Response 替身（只用 status_code + json()）。"""

    def __init__(self, status_code: int, payload: Optional[dict] = None) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> dict:
        if self._payload is None:
            raise ValueError("no json body")
        return self._payload


def _install_fake_tavily(monkeypatch: pytest.MonkeyPatch, by_key: dict) -> list:
    """Patch ``web.httpx.Client`` 使 ``_tavily_search`` 的 ``client.post`` 按 Bearer key 返回
    预置响应（by_key: key → _FakeTavilyResp | Exception），并记录调用顺序。不打真实网络。"""
    calls: list = []

    class _Client:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args) -> bool:
            return False

        def post(self, url, headers=None, json=None):
            token = (headers or {}).get("Authorization", "").replace("Bearer ", "", 1)
            calls.append({"url": url, "key": token, "json": json})
            outcome = by_key[token]
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

    monkeypatch.setattr(web.httpx, "Client", _Client)
    return calls


def test_search_tavily_maps_results(
    client: TestClient, tavily_cfg, monkeypatch: pytest.MonkeyPatch
) -> None:
    """配了单 key → 走 Tavily：结果映射（content→snippet），打 api.tavily.com（非 DDG），
    Bearer 认证，max_results 映射 limit。"""
    tavily_cfg["key"] = "tvly-a"
    calls = _install_fake_tavily(monkeypatch, {"tvly-a": _FakeTavilyResp(200, _TAVILY_PAYLOAD)})
    resp = client.post("/api/web/search", json={"query": "q3 plan", "limit": 5})
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["count"] == 2
    first = data["results"][0]
    assert first["title"] == "Q3 Plan"
    assert first["url"] == "https://example.com/q3"
    assert first["snippet"] == "The Q3 plan ships with three milestones."  # content→snippet
    assert calls[0]["url"] == "https://api.tavily.com/search"
    assert calls[0]["json"]["max_results"] == 5


def test_search_tavily_single_key_success(
    client: TestClient, tavily_cfg, monkeypatch: pytest.MonkeyPatch
) -> None:
    """单 key（无逗号）仍正常。"""
    tavily_cfg["key"] = "tvly-solo"
    _install_fake_tavily(monkeypatch, {"tvly-solo": _FakeTavilyResp(200, _TAVILY_PAYLOAD)})
    resp = client.post("/api/web/search", json={"query": "x", "limit": 5})
    assert resp.status_code == 200
    assert resp.json()["data"]["count"] == 2


def test_search_tavily_rotates_on_usage_exhausted(
    client: TestClient, tavily_cfg, monkeypatch: pytest.MonkeyPatch
) -> None:
    """首个 key 429 额度用尽 → 自动切第二个成功；两 key 按序试过（含空格证明 strip）。"""
    tavily_cfg["key"] = "tvly-a, tvly-b"
    calls = _install_fake_tavily(
        monkeypatch,
        {"tvly-a": _FakeTavilyResp(429), "tvly-b": _FakeTavilyResp(200, _TAVILY_PAYLOAD)},
    )
    resp = client.post("/api/web/search", json={"query": "q3 plan", "limit": 5})
    assert resp.status_code == 200
    assert resp.json()["data"]["count"] == 2
    assert [c["key"] for c in calls] == ["tvly-a", "tvly-b"]


def test_search_tavily_rotates_on_invalid_key(
    client: TestClient, tavily_cfg, monkeypatch: pytest.MonkeyPatch
) -> None:
    """首个 key 401 无效 → 也跳到下一个（成功）。"""
    tavily_cfg["key"] = "tvly-bad,tvly-good"
    calls = _install_fake_tavily(
        monkeypatch,
        {"tvly-bad": _FakeTavilyResp(401), "tvly-good": _FakeTavilyResp(200, _TAVILY_PAYLOAD)},
    )
    resp = client.post("/api/web/search", json={"query": "x", "limit": 3})
    assert resp.status_code == 200
    assert [c["key"] for c in calls] == ["tvly-bad", "tvly-good"]


def test_search_tavily_all_exhausted_error(
    client: TestClient, tavily_cfg, monkeypatch: pytest.MonkeyPatch
) -> None:
    """全部 key 429 → 「全部额度已用尽」清晰错误，绝不静默回落 DDG。"""
    tavily_cfg["key"] = "tvly-a,tvly-b"
    monkeypatch.setattr(web, "_ddg_search", _raise_boom("must not fall back to DDG"))
    _install_fake_tavily(
        monkeypatch, {"tvly-a": _FakeTavilyResp(429), "tvly-b": _FakeTavilyResp(429)}
    )
    resp = client.post("/api/web/search", json={"query": "x", "limit": 5})
    assert resp.status_code == 502
    err = resp.json()["error"]
    assert err["code"] == "E_UPSTREAM"
    assert "额度已用尽" in err["message"]


def test_search_tavily_all_invalid_error(
    client: TestClient, tavily_cfg, monkeypatch: pytest.MonkeyPatch
) -> None:
    """全部 key 401/403 → 「无效或无权限」清晰错误（区分 vs 额度用尽）。"""
    tavily_cfg["key"] = "tvly-a,tvly-b"
    _install_fake_tavily(
        monkeypatch, {"tvly-a": _FakeTavilyResp(401), "tvly-b": _FakeTavilyResp(403)}
    )
    resp = client.post("/api/web/search", json={"query": "x", "limit": 5})
    assert resp.status_code == 502
    err = resp.json()["error"]
    assert err["code"] == "E_UPSTREAM"
    assert "无效或无权限" in err["message"]


def test_search_tavily_mixed_failure_error(
    client: TestClient, tavily_cfg, monkeypatch: pytest.MonkeyPatch
) -> None:
    """混合（429 + 401）→ 「均不可用」清晰错误。"""
    tavily_cfg["key"] = "tvly-a,tvly-b"
    _install_fake_tavily(
        monkeypatch, {"tvly-a": _FakeTavilyResp(429), "tvly-b": _FakeTavilyResp(401)}
    )
    resp = client.post("/api/web/search", json={"query": "x", "limit": 5})
    assert resp.status_code == 502
    assert "均不可用" in resp.json()["error"]["message"]


def test_search_tavily_timeout_no_ddg_fallback(
    client: TestClient, tavily_cfg, monkeypatch: pytest.MonkeyPatch
) -> None:
    """网络超时（非 key 相关）→ 清晰 504，不静默回落 DDG。"""
    tavily_cfg["key"] = "tvly-a"
    monkeypatch.setattr(web, "_ddg_search", _raise_boom("must not fall back to DDG on network error"))
    _install_fake_tavily(monkeypatch, {"tvly-a": web.httpx.TimeoutException("boom")})
    resp = client.post("/api/web/search", json={"query": "x", "limit": 5})
    assert resp.status_code == 504
    assert resp.json()["error"]["code"] == "E_UPSTREAM"


def test_search_empty_tavily_key_falls_back_to_ddg(
    client: TestClient, fake_site: int, tavily_cfg, monkeypatch: pytest.MonkeyPatch
) -> None:
    """无 key → 走 DDG（非 Tavily）：断言 _tavily_search 绝不被调用、DDG fixture 正常解析。"""
    tavily_cfg["key"] = ""  # 默认即空，显式声明
    monkeypatch.setattr(web, "_DDG_HTML_URL", f"http://127.0.0.1:{fake_site}/ddg")
    monkeypatch.setattr(web, "_tavily_search", _raise_boom("Tavily must not be called when key empty"))
    resp = client.post("/api/web/search", json={"query": "q3 plan", "limit": 5})
    assert resp.status_code == 200
    assert resp.json()["data"]["count"] == 2  # DDG fixture 解析


def test_search_reads_key_via_get_settings_not_os_getenv(
    client: TestClient, fake_site: int, tavily_cfg, monkeypatch: pytest.MonkeyPatch
) -> None:
    """key 经 get_settings() 读、非 os.getenv：设 os.environ 但 get_settings 返回空 → 走 DDG
    （证明 os.environ 不驱动 provider 选择，符合 serve-api 不 load_dotenv 的约束）。"""
    monkeypatch.setenv("TAVILY_API_KEY", "tvly-from-os-environ")
    tavily_cfg["key"] = ""  # get_settings 权威（空）
    monkeypatch.setattr(web, "_DDG_HTML_URL", f"http://127.0.0.1:{fake_site}/ddg")
    monkeypatch.setattr(web, "_tavily_search", _raise_boom("os.getenv must not drive provider selection"))
    resp = client.post("/api/web/search", json={"query": "q3 plan", "limit": 5})
    assert resp.status_code == 200
    assert resp.json()["data"]["count"] == 2  # 走 DDG → 证明没读 os.environ


# ===========================================================================
# 5) 鉴权 — 关闭 bypass → 401（与 domainClient 消费的既有端点一致）
# ===========================================================================


def test_web_endpoints_require_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    """bypass off + 无 token → verify_cf_access 401（fetch 与 search 都挂了鉴权）。"""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", "")
    monkeypatch.setattr(auth_mod, "CF_AUDIENCE", "aud")  # 让鉴权层有 CF 腿可校验
    with TestClient(app, raise_server_exceptions=False) as c:
        r1 = c.post("/api/web/fetch", json={"url": "https://example.com"})
        r2 = c.post("/api/web/search", json={"query": "x"})
    assert r1.status_code == 401
    assert r2.status_code == 401
