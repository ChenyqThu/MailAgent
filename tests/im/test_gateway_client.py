"""gateway loopback 客户端：SSE 解析 / 错误映射 / 端口解析一致闸（src/im/gateway_client.py）。

全离线：``httpx.MockTransport``，零真实连接。SSE 帧形状照
``frontend/tests/ai-gateway/im_chat_endpoint.test.ts`` 的 wire fixture。
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

import httpx
import pytest

from src.im.gateway_client import (
    GatewayClient,
    resolve_gateway_port,
)

BASE = "http://127.0.0.1:8300"


def _sse(frames: List[Dict[str, Any]], *, done: bool = True) -> bytes:
    lines = [f"data: {json.dumps(f, ensure_ascii=False)}\n\n" for f in frames]
    if done:
        lines.append("data: [DONE]\n\n")
    return "".join(lines).encode("utf-8")


def _client_for(handler) -> GatewayClient:
    return GatewayClient(base_url=BASE, transport=httpx.MockTransport(handler))


TEXT_FRAMES = [
    {"type": "start"},
    {"type": "text-start", "id": "1"},
    {"type": "text-delta", "id": "1", "delta": "你好"},
    {"type": "text-delta", "id": "1", "delta": "，飞书"},
    {"type": "text-end", "id": "1"},
    {"type": "finish"},
]


class TestStreamImChat:
    def test_happy_path_text_and_session_header(self):
        seen_bodies: List[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/api/ai/im-chat"
            seen_bodies.append(json.loads(request.content))
            return httpx.Response(
                200,
                headers={"x-mailagent-session-id": "77"},
                content=_sse(TEXT_FRAMES),
            )

        out = _client_for(handler).stream_im_chat(
            [{"id": "u1", "role": "user", "parts": [{"type": "text", "text": "hi"}]}],
            None,
        )
        assert out.ok is True
        assert out.text == "你好，飞书"
        assert out.session_id == 77
        assert out.saw_approval_request is False
        # sessionId=None 时 body 里**不带** sessionId 键（gateway 据此走 createImSession）
        assert "sessionId" not in seen_bodies[0]

    def test_session_id_is_forwarded(self):
        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            assert body["sessionId"] == 41
            return httpx.Response(
                200,
                headers={"x-mailagent-session-id": "41"},
                content=_sse(TEXT_FRAMES),
            )

        out = _client_for(handler).stream_im_chat([{"id": "u", "role": "user", "parts": []}], 41)
        assert out.ok and out.session_id == 41

    def test_model_only_enters_body_when_set(self):
        """``/model`` 偏好 → body.model；无偏好时 body **不带** model 键（gateway 用 cfg.model）。"""
        seen: List[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(json.loads(request.content))
            return httpx.Response(200, content=_sse(TEXT_FRAMES))

        client = _client_for(handler)
        msgs = [{"id": "u", "role": "user", "parts": []}]
        client.stream_im_chat(msgs, 1)
        client.stream_im_chat(msgs, 1, model="")
        client.stream_im_chat(msgs, 1, model="dash:qwen-max")
        assert "model" not in seen[0]
        assert "model" not in seen[1]
        assert seen[2]["model"] == "dash:qwen-max"

    def test_multiple_text_blocks_join_with_blank_line(self):
        frames = [
            {"type": "text-start", "id": "1"},
            {"type": "text-delta", "id": "1", "delta": "我先查一下"},
            {"type": "text-end", "id": "1"},
            {"type": "tool-input-available", "toolCallId": "t1"},
            {"type": "tool-output-available", "toolCallId": "t1"},
            {"type": "text-start", "id": "2"},
            {"type": "text-delta", "id": "2", "delta": "查到了：3 封"},
            {"type": "text-end", "id": "2"},
            {"type": "finish"},
        ]
        out = _client_for(
            lambda _r: httpx.Response(200, content=_sse(frames))
        ).stream_im_chat([{"id": "u", "role": "user", "parts": []}], 1)
        assert out.text == "我先查一下\n\n查到了：3 封"

    def test_approval_request_frame_is_detected(self):
        frames = [
            {"type": "text-start", "id": "1"},
            {"type": "text-delta", "id": "1", "delta": "我准备发邮件"},
            {"type": "tool-approval-request", "approvalId": "ap_1", "toolCallId": "t1"},
            {"type": "finish"},
        ]
        out = _client_for(
            lambda _r: httpx.Response(200, content=_sse(frames))
        ).stream_im_chat([{"id": "u", "role": "user", "parts": []}], 1)
        assert out.ok
        assert out.saw_approval_request is True
        assert out.approval_id == "ap_1"
        assert out.text == "我准备发邮件"

    def test_error_frame_is_captured(self):
        frames = [
            {"type": "text-start", "id": "1"},
            {"type": "text-delta", "id": "1", "delta": "写到一半"},
            {"type": "error", "errorText": "upstream exploded"},
        ]
        out = _client_for(
            lambda _r: httpx.Response(200, content=_sse(frames))
        ).stream_im_chat([{"id": "u", "role": "user", "parts": []}], 1)
        assert out.ok
        assert out.stream_error == "upstream exploded"

    @pytest.mark.parametrize(
        "status,body,expect_code",
        [
            (404, {"error": "not_found"}, "not_found"),
            (409, {"error": "E_RUN_ACTIVE", "hint": "busy"}, "E_RUN_ACTIVE"),
            (413, {"error": "E_PAYLOAD_TOO_LARGE"}, "E_PAYLOAD_TOO_LARGE"),
            (503, {"error": "E_NO_LLM_KEY"}, "E_NO_LLM_KEY"),
            (400, {"error": "E_INVALID_ARG"}, "E_INVALID_ARG"),
        ],
    )
    def test_http_errors_are_typed(self, status, body, expect_code):
        out = _client_for(
            lambda _r: httpx.Response(status, json=body)
        ).stream_im_chat([{"id": "u", "role": "user", "parts": []}], None)
        assert out.ok is False
        assert out.http_status == status
        assert out.error_code == expect_code

    def test_connect_refused_is_transport_error(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        out = _client_for(handler).stream_im_chat(
            [{"id": "u", "role": "user", "parts": []}], None
        )
        assert out.ok is False
        assert out.transport_error == "E_CONNECT"

    def test_read_timeout_is_typed(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("read timed out")

        out = _client_for(handler).stream_im_chat(
            [{"id": "u", "role": "user", "parts": []}], None
        )
        assert out.transport_error == "E_TIMEOUT"


class TestApprovalAndRun:
    def test_pending_hit(self):
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/api/ai/approval/pending"
            assert request.url.params["sessionId"] == "7"
            return httpx.Response(
                200,
                json={
                    "pending": True,
                    "approvalId": "ap_9",
                    "toolName": "email_send",
                    "inputPreview": "email_send: → a@b.c 「hi」",
                    "ageMs": 1200,
                },
            )

        p = _client_for(handler).approval_pending(7)
        assert p is not None
        assert (p.approval_id, p.tool_name) == ("ap_9", "email_send")

    def test_pending_miss_and_transport_error_are_none(self):
        assert (
            _client_for(
                lambda _r: httpx.Response(404, json={"pending": False})
            ).approval_pending(7)
            is None
        )

        def boom(_r: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused")

        assert _client_for(boom).approval_pending(7) is None

    def test_decide_completed(self):
        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            # in-record 形状：只有 approvalId + decision，永不带 resumeToken
            assert set(body) == {"approvalId", "decision"}
            assert body["decision"] == "approve"
            return httpx.Response(
                200,
                json={"ok": True, "status": "completed", "sessionId": 7, "summary": "done"},
            )

        out = _client_for(handler).decide("ap_9", "approve")
        assert out.ok and out.status == "completed" and out.summary == "done"

    def test_decide_not_found_is_404(self):
        out = _client_for(
            lambda _r: httpx.Response(
                404, json={"ok": False, "status": "not_found", "error": "no live pending"}
            )
        ).decide("ap_gone", "approve")
        assert out.http_status == 404
        assert out.status == "not_found"

    def test_decide_connect_error(self):
        def boom(_r: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused")

        out = _client_for(boom).decide("ap_9", "reject")
        assert out.transport_error == "E_CONNECT"

    def test_stop_run(self):
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/api/ai/run/stop"
            assert json.loads(request.content) == {"sessionId": 5}
            return httpx.Response(200, json={"stopped": True})

        out = _client_for(handler).stop_run(5)
        assert out.ok and out.stopped is True

    def test_stop_run_404_when_registry_unwired(self):
        out = _client_for(
            lambda _r: httpx.Response(404, json={"error": "E_NOT_IMPLEMENTED"})
        ).stop_run(5)
        assert out.ok is False and out.http_status == 404


class TestPortParity:
    """🔴 端口解析是第三处同形抄写（run_worker / ai_gateway_proxy / 本模块）——
    在下沉成零依赖叶子之前，用行为一致闸钉住三处不漂移。"""

    CASES = [
        (None, 8300),
        ("8300", 8300),
        ("9100", 9100),
        ("abc", 8300),
        ("0", 8300),
        ("-5", 8300),
    ]

    @pytest.mark.parametrize("raw,expected", CASES)
    def test_resolve_gateway_port(self, monkeypatch, raw, expected):
        if raw is None:
            monkeypatch.delenv("MAILAGENT_AI_GATEWAY_PORT", raising=False)
        else:
            monkeypatch.setenv("MAILAGENT_AI_GATEWAY_PORT", raw)
        assert resolve_gateway_port() == expected

    @pytest.mark.parametrize("raw,expected", CASES)
    def test_parity_with_agent_run_worker(self, monkeypatch, raw, expected):
        run_worker = pytest.importorskip(
            "src.agents.run_worker", reason="agents worker deps unavailable"
        )
        if raw is None:
            monkeypatch.delenv("MAILAGENT_AI_GATEWAY_PORT", raising=False)
        else:
            monkeypatch.setenv("MAILAGENT_AI_GATEWAY_PORT", raw)
        assert resolve_gateway_port() == run_worker.AgentRunWorker._gateway_port()

    @pytest.mark.parametrize("raw,expected", CASES)
    def test_parity_with_ai_gateway_proxy(self, monkeypatch, raw, expected):
        # 该模块 import 连带 src.api.auth 的启动期环境校验（一种鉴权都没配 →
        # RuntimeError，不是 ImportError）。先补一个进程内 local token 满足它
        # （首次 import 后模块缓存，之后无所谓）；仍失败（缺 fastapi 等）才 skip
        # —— parity 的主闸是 run_worker 那条腿，这条是锦上添花。
        monkeypatch.setenv("MAILAGENT_LOCAL_API_TOKEN", "test-parity-token")
        try:
            from src.api.routers import ai_gateway_proxy as proxy
        except Exception as exc:  # noqa: BLE001 — 环境不满足即跳过
            pytest.skip(f"ai_gateway_proxy unimportable here: {type(exc).__name__}")
        if raw is None:
            monkeypatch.delenv("MAILAGENT_AI_GATEWAY_PORT", raising=False)
        else:
            monkeypatch.setenv("MAILAGENT_AI_GATEWAY_PORT", raw)
        assert resolve_gateway_port() == proxy._resolve_gateway_port()
