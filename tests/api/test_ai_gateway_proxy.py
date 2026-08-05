"""ai-gateway-proxy 路由 (src/api/routers/ai_gateway_proxy.py) — serve-api → loopback gateway 代理。

task A — 远程 web 切 AI SDK。serve-api 把 web 的 chat 请求代理到同机 loopback AI SDK Gateway。
本测试覆盖：
  - 流式转发（/api/ai/chat）：SSE/UIMessage 字节流逐块透传 + status + content-type；
  - 非流式 JSON（/api/ai/config、/api/ai/title 等）：body + status 整体透传；
  - 端口取自 env MAILAGENT_AI_GATEWAY_PORT（缺省 8300）；
  - verify_cf_access 双腿：bypass / 本地 token / CF JWT 过、无凭证 401；
  - 裸 /health 无鉴权（纯存活探针）；
  - 非 2xx 透传（gateway 的 404 mirror-off / 503 等）；
  - gateway 不可达 → 502；
  - abort 机制：流式生成器的 finally → aclose() 在消费方停止时跑（= 关到 gateway 的连接 →
    gateway req.on('close') → LLM abort 的传播链命门）。

实现策略
--------
真起一个 loopback ``ThreadingHTTPServer`` 当 fake gateway（非 mock），把
MAILAGENT_AI_GATEWAY_PORT 指向它真实端口 → 经 FastAPI ``TestClient`` 驱动代理 → 真转发到 fake
gateway。这样端口解析 / 转发 / 流式 / status / header 全走真实 socket 路径。auth 经 dependency
全栈跑（与 test_auth_and_bind.py 一致 monkeypatch AUTH_DISABLED / _LOCAL_API_TOKEN）。
"""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Iterator

import httpx
import pytest
from fastapi.testclient import TestClient

import src.api.auth as auth_mod
import src.api.routers.ai_gateway_proxy as proxy_mod
from src.api.app import app


# ---------------------------------------------------------------------------
# Fake loopback gateway (real HTTP server in a thread)
# ---------------------------------------------------------------------------


class _FakeGatewayHandler(BaseHTTPRequestHandler):
    """最小 fake gateway：回显 path/method + 受控 status/body，支持流式 chunk。

    路由约定（够测代理转发语义即可，非真 gateway 逻辑）：
      - GET  /health               200 {"status":"ok", echo...}
      - GET  /api/ai/config        200 {"service":"fake-gateway", echo...}
      - POST /api/ai/chat          200 text/event-stream，逐块 flush（验流式透传）
      - POST /api/ai/agui/chat     404（模拟 mirror-off：gateway 未注册该路由）
      - POST /api/ai/title         200 {"title":"echo"} + 回读请求体（验 body 转发）；
                                   请求体带 {"fail": true} → 503 {"error":"E_NO_LLM_KEY"}
                                   （验缓冲代理的非 2xx 透传；W6 起 followups 端点已删）
      - 其他                        404
    """

    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # noqa: D401 — 静音测试日志
        pass

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/api/ai/approval/pending"):
            # S6 W1 — 回显 sessionId 查询串，证明代理转发了 query（pending 端点靠它定位会话）。
            from urllib.parse import parse_qs, urlparse

            sid = parse_qs(urlparse(self.path).query).get("sessionId", [None])[0]
            self._json(200, {"pending": True, "echoSessionId": sid})
            return
        if self.path == "/health":
            # mirror the real gateway /health body (server.ts) INCLUDING the infra fields the
            # proxy must STRIP (baseUrl/model/hasKey) — only status/service/version pass through.
            self._json(
                200,
                {
                    "status": "ok",
                    "service": "fake-gateway",
                    "version": "0.2.0",
                    "model": "claude-secret",
                    "hasKey": True,
                    "baseUrl": "https://crs.internal/api",
                },
            )
        elif self.path == "/api/ai/config":
            self._json(200, {"service": "fake-gateway", "modelConfigured": True})
        else:
            self._json(404, {"error": "not_found", "path": self.path})

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if self.path == "/api/ai/chat":
            # 流式：逐块 flush 模拟 AI SDK UIMessage 流（chunked transfer）。
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            # AI SDK pipeUIMessageStreamToResponse 设此 header，assistant-ui 客户端据它解析
            # UIMessage 流 —— 代理必须透传非 hop-by-hop 的自定义 header（不能只回 content-type）。
            self.send_header("x-vercel-ai-ui-message-stream", "v1")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            for i in range(3):
                chunk = f"data: delta-{i}\n\n".encode()
                # chunked framing 手写（HTTP/1.1）。
                self.wfile.write(f"{len(chunk):X}\r\n".encode() + chunk + b"\r\n")
                self.wfile.flush()
                time.sleep(0.005)
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        elif self.path == "/api/ai/agui/chat":
            # mirror-off：gateway 返 404，代理须透传。
            self._json(404, {"error": "not_found", "path": self.path})
        elif self.path == "/api/ai/title":
            # 回读请求体证明 body 被转发；{"fail": true} → 503（非 2xx 透传验证）。
            try:
                sent = json.loads(raw.decode()) if raw else {}
            except ValueError:
                sent = {}
            if sent.get("fail") is True:
                self._json(503, {"error": "E_NO_LLM_KEY"})
            else:
                self._json(200, {"title": "echo", "received": sent})
        elif self.path == "/api/ai/approval/decide":
            # S6 W1 — 回显请求体，证明 decide body（toolCallId/decision/resumeToken）被转发。
            try:
                sent = json.loads(raw.decode()) if raw else {}
            except ValueError:
                sent = {}
            self._json(200, {"status": "completed", "received": sent})
        else:
            self._json(404, {"error": "not_found", "path": self.path})


@pytest.fixture(scope="module")
def fake_gateway() -> Iterator[int]:
    """真起 loopback fake gateway，yield 其端口。"""
    server = ThreadingHTTPServer(("127.0.0.1", 0), _FakeGatewayHandler)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        yield port
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture()
def proxy_client(fake_gateway: int, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """TestClient（auth bypass ON 默认）+ MAILAGENT_AI_GATEWAY_PORT 指向 fake gateway。"""
    monkeypatch.setenv("MAILAGENT_AI_GATEWAY_PORT", str(fake_gateway))
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


# ---------------------------------------------------------------------------
# Port resolution from env
# ---------------------------------------------------------------------------


def test_resolve_gateway_port_default(monkeypatch: pytest.MonkeyPatch):
    """env 未设 → 默认 8300（与 gateway resolveAiGatewayPort 同源）。"""
    monkeypatch.delenv("MAILAGENT_AI_GATEWAY_PORT", raising=False)
    assert proxy_mod._resolve_gateway_port() == 8300


def test_resolve_gateway_port_from_env(monkeypatch: pytest.MonkeyPatch):
    """env 设有效端口 → 取之。"""
    monkeypatch.setenv("MAILAGENT_AI_GATEWAY_PORT", "9412")
    assert proxy_mod._resolve_gateway_port() == 9412


def test_resolve_gateway_port_invalid_falls_back(monkeypatch: pytest.MonkeyPatch):
    """非数字 / 非正 → 回落 8300（fail-safe，不崩）。"""
    monkeypatch.setenv("MAILAGENT_AI_GATEWAY_PORT", "not-a-port")
    assert proxy_mod._resolve_gateway_port() == 8300
    monkeypatch.setenv("MAILAGENT_AI_GATEWAY_PORT", "0")
    assert proxy_mod._resolve_gateway_port() == 8300
    monkeypatch.setenv("MAILAGENT_AI_GATEWAY_PORT", "-5")
    assert proxy_mod._resolve_gateway_port() == 8300


def test_gateway_base_is_loopback(monkeypatch: pytest.MonkeyPatch):
    """基址恒 127.0.0.1（同机 loopback）。"""
    monkeypatch.setenv("MAILAGENT_AI_GATEWAY_PORT", "8765")
    assert proxy_mod._gateway_base() == "http://127.0.0.1:8765"


# ---------------------------------------------------------------------------
# Streaming proxy (/api/ai/chat)
# ---------------------------------------------------------------------------


def test_proxy_chat_streams_chunks(proxy_client: TestClient):
    """POST /api/ai/chat → 流式逐块透传 fake gateway 的 SSE 字节 + content-type。"""
    with proxy_client.stream(
        "POST", "/api/ai/chat", json={"messages": [{"role": "user"}]}
    ) as resp:
        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers.get("content-type", "")
        # 非 hop-by-hop 自定义 header 透传（assistant-ui UIMessage 流解析依赖它）。
        assert resp.headers.get("x-vercel-ai-ui-message-stream") == "v1"
        body = b"".join(resp.iter_bytes())
    text = body.decode()
    assert "delta-0" in text and "delta-1" in text and "delta-2" in text


def test_proxy_chat_forwards_body(proxy_client: TestClient):
    """请求体被原样转发到 gateway（用 /api/ai/title 回显验证，同条 body 转发路径）。"""
    r = proxy_client.post("/api/ai/title", json={"sessionId": 42, "model": "x"})
    assert r.status_code == 200
    data = r.json()
    assert data["title"] == "echo"
    assert data["received"] == {"sessionId": 42, "model": "x"}


# ---------------------------------------------------------------------------
# Non-streaming JSON proxy
# ---------------------------------------------------------------------------


def test_proxy_config_json(proxy_client: TestClient):
    """GET /api/ai/config → 非流式 JSON 透传 status + body。"""
    r = proxy_client.get("/api/ai/config")
    assert r.status_code == 200
    assert r.json()["service"] == "fake-gateway"


def test_proxy_buffered_passes_through_non_2xx(proxy_client: TestClient):
    """gateway 503（无 key）→ 缓冲代理透传 503 + 错误体（前端按 status/code 处理）。

    W6 起 followups 端点已删（追问建议改回合内 suggest_followups 工具），非 2xx 透传
    覆盖搬到同为缓冲代理的 /api/ai/title（fake gateway 以 {"fail": true} 触发 503）。"""
    r = proxy_client.post("/api/ai/title", json={"fail": True})
    assert r.status_code == 503
    assert r.json()["error"] == "E_NO_LLM_KEY"


def test_proxy_agui_passes_through_404(proxy_client: TestClient):
    """mirror-off：gateway 未注册 /api/ai/agui/chat → 404；代理透传 404（不 500）。"""
    r = proxy_client.post("/api/ai/agui/chat", json={"messages": []})
    assert r.status_code == 404


def test_proxy_approval_resolve_routed(proxy_client: TestClient):
    """POST /api/ai/approval/resolve 走代理（fake gateway 无此路由 → 404 透传，验路由接线）。"""
    r = proxy_client.post("/api/ai/approval/resolve", json={"toolCallId": "t"})
    assert r.status_code == 404  # fake gateway 的兜底 404；真 gateway 会 200/4xx


def test_proxy_approval_pending_forwards_query(proxy_client: TestClient):
    """S6 W1 — GET /api/ai/approval/pending 走代理且**转发查询串**（sessionId 靠它定位会话）。"""
    r = proxy_client.get("/api/ai/approval/pending", params={"sessionId": 5})
    assert r.status_code == 200
    data = r.json()
    assert data["pending"] is True
    assert data["echoSessionId"] == "5"  # 查询串抵达 gateway


def test_proxy_approval_decide_forwards_body(proxy_client: TestClient):
    """S6 W1 — POST /api/ai/approval/decide 走代理且**转发请求体**（与岛共用同一 decide 通道）。"""
    body = {"toolCallId": "tc", "decision": "approve", "resumeToken": "rt"}
    r = proxy_client.post("/api/ai/approval/decide", json=body)
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "completed"
    assert data["received"] == body


def test_proxy_approval_decide_requires_auth_401(
    proxy_client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    """decide 是写-resume 面：bypass OFF + 无凭证 → 401（拦在转发前，与 chat 同款鉴权）。"""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    r = proxy_client.post("/api/ai/approval/decide", json={"toolCallId": "t"})
    assert r.status_code == 401


# ---------------------------------------------------------------------------
# Bare /health — no auth (liveness probe)
# ---------------------------------------------------------------------------


def test_health_proxied_no_auth(proxy_client: TestClient, monkeypatch: pytest.MonkeyPatch):
    """裸 /health 无鉴权：bypass OFF 也可达（renderer 健康探针）→ 转发 gateway /health。

    最小披露（code-reviewer LOW）：只回 {status, service, version}，**剥离** gateway /health 的
    baseUrl/model/hasKey 基础设施元数据（裸端点无鉴权，匿名不得读 LLM 上游信息）。"""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    r = proxy_client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["service"] == "fake-gateway"
    assert body.get("version") == "0.2.0"
    # 敏感基础设施字段必须被剥离（最小披露）。
    assert "baseUrl" not in body
    assert "model" not in body
    assert "hasKey" not in body


def test_health_distinct_from_api_health(proxy_client: TestClient):
    """裸 /health（代理 gateway）≠ serve-api 自有 /api/health（liveness）—— 两条独立路径都在。"""
    r_gateway = proxy_client.get("/health")
    r_self = proxy_client.get("/api/health")
    assert r_gateway.json()["service"] == "fake-gateway"  # 代理到 gateway
    assert r_self.json()["status"] == "ok"  # serve-api 自有 liveness
    assert "service" not in r_self.json()  # 自有 liveness 不带 gateway 字段


# ---------------------------------------------------------------------------
# Auth — verify_cf_access on the proxied /api/ai/* endpoints
# ---------------------------------------------------------------------------


def test_proxy_chat_requires_auth_401(proxy_client: TestClient, monkeypatch: pytest.MonkeyPatch):
    """bypass OFF + 无凭证 → /api/ai/chat 401（dependency 拦在转发前）。"""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    r = proxy_client.post("/api/ai/chat", json={"messages": []})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "E_AUTH_FAILED"


def test_proxy_config_requires_auth_401(proxy_client: TestClient, monkeypatch: pytest.MonkeyPatch):
    """bypass OFF + 无凭证 → /api/ai/config 401。"""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    r = proxy_client.get("/api/ai/config")
    assert r.status_code == 401


def test_proxy_local_token_leg_passes(
    proxy_client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    """本地 token 腿：配 token + 正确 header → 放行转发（同机 Electron daemon 写面路径）。"""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", "ephemeral-secret")
    monkeypatch.setattr(auth_mod, "_resolve_allowed_email", lambda: "owner@example.com")
    r = proxy_client.get(
        "/api/ai/config", headers={auth_mod.LOCAL_TOKEN_HEADER: "ephemeral-secret"}
    )
    assert r.status_code == 200
    assert r.json()["service"] == "fake-gateway"


def test_proxy_cf_jwt_leg_passes(proxy_client: TestClient, monkeypatch: pytest.MonkeyPatch):
    """CF JWT 腿：stub 签名校验 + claims 命中白名单 → 放行转发（远程 web 真实路径）。"""
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)

    class _Key:
        key = "irrelevant"

    monkeypatch.setattr(
        auth_mod._jwk_client, "get_signing_key_from_jwt", lambda _t: _Key()
    )
    monkeypatch.setattr(auth_mod.jwt, "decode", lambda *a, **k: {"email": "owner@example.com"})
    monkeypatch.setattr(auth_mod, "_resolve_allowed_emails", lambda: {"owner@example.com"})
    r = proxy_client.get(
        "/api/ai/config", headers={"Cf-Access-Jwt-Assertion": "header.payload.sig"}
    )
    assert r.status_code == 200
    assert r.json()["service"] == "fake-gateway"


# ---------------------------------------------------------------------------
# Gateway unreachable → 502
# ---------------------------------------------------------------------------


def test_proxy_unreachable_gateway_502(monkeypatch: pytest.MonkeyPatch):
    """gateway 端口无人监听 → 代理返 502（前端 health 探针据此降级 legacy）。"""
    # 指向一个几乎不可能有人监听的高位端口。
    monkeypatch.setenv("MAILAGENT_AI_GATEWAY_PORT", "1")
    with TestClient(app, raise_server_exceptions=False) as c:
        r = c.get("/api/ai/config")
        assert r.status_code == 502
        # 流式端点同样 502（连接阶段就失败）。
        r2 = c.post("/api/ai/chat", json={"messages": []})
        assert r2.status_code == 502


# ---------------------------------------------------------------------------
# Abort propagation — the streaming generator runs aclose() on consumer stop
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_streaming_abort_closes_upstream(fake_gateway: int, monkeypatch: pytest.MonkeyPatch):
    """命门：消费方提前停止迭代流式响应 → 生成器 finally 跑 aclose() → 关到 gateway 的连接。

    这是 abort 传播链 (client 断开 → aclose upstream → gateway req.on('close') → LLM abort) 的
    Python 端命门。直接调 _proxy_streaming 拿到 StreamingResponse，迭代它的 body_iterator 一帧后
    abort（aclose 生成器），断言上游 httpx response 被关闭 (is_closed)。
    """
    monkeypatch.setenv("MAILAGENT_AI_GATEWAY_PORT", str(fake_gateway))

    # 构造一个最小 Request（_proxy_streaming 只用 method / headers / body）。
    captured: dict = {}
    real_send = httpx.AsyncClient.send

    async def _spy_send(self, request, **kwargs):  # noqa: ANN001
        resp = await real_send(self, request, **kwargs)
        captured["resp"] = resp
        return resp

    monkeypatch.setattr(httpx.AsyncClient, "send", _spy_send)

    class _Req:
        method = "POST"
        headers = httpx.Headers({"content-type": "application/json"})

        async def body(self) -> bytes:
            return b'{"messages": []}'

    response = await proxy_mod._proxy_streaming(_Req(), "/api/ai/chat")  # type: ignore[arg-type]
    assert response.status_code == 200

    it = response.body_iterator
    # 拿第一帧（流已建立，上游 resp 已捕获且未关）。
    first = await it.__anext__()
    assert b"delta" in first
    upstream_resp = captured["resp"]
    assert upstream_resp.is_closed is False

    # 模拟客户端断开：Starlette 会 aclose StreamingResponse 的 body_iterator → 触发 finally。
    await it.aclose()

    # finally 已跑 → 上游连接被关 (= 关到 gateway 的 socket → gateway req.on('close') → LLM abort)。
    assert upstream_resp.is_closed is True
