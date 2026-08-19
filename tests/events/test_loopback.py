"""S1 — loopback 事件投递 (src/events/loopback.py) + serve 侧 publish 端点。

覆盖:
- publish_loopback 是 fire-and-forget: 同步返回, 目标不通也绝不抛
- 队列上限: 满则丢, 不阻塞
- POST 的形状: 端点 URL / token header / body
- serve 侧 _publish_event: 鉴权 401 / 缺 event_type 400 / 坏 JSON 400 / happy path

🔴 「目标不通也绝不抛」是本模块存在的全部意义所在的那条约束 —— serve 没起时,
   serve-api 里的写操作必须照常成功。
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest
from aiohttp.test_utils import make_mocked_request

import src.events.loopback as lb
import src.sse_server as sse


@pytest.fixture(autouse=True)
def _clean_executor():
    lb._shutdown_for_tests()
    yield
    lb._shutdown_for_tests()


# ============================================================
# publish_loopback — 投递端
# ============================================================

class TestPublishLoopback:
    def test_posts_expected_shape(self, monkeypatch):
        """端点 URL + token header + JSON body 三样都对。"""
        monkeypatch.setenv("SSE_LOCAL_PORT", "9299")
        monkeypatch.setenv("MAILAGENT_LOCAL_API_TOKEN", "tok-abc")
        captured = {}

        def fake_urlopen(request, timeout=None):
            captured["url"] = request.full_url
            captured["body"] = json.loads(request.data.decode("utf-8"))
            captured["token"] = request.get_header(lb.LOCAL_TOKEN_HEADER.capitalize())
            captured["timeout"] = timeout
            return MagicMock(
                status=200,
                __enter__=lambda self: self,
                __exit__=lambda self, *a: False,
            )

        with patch.object(lb.urllib.request, "urlopen", side_effect=fake_urlopen):
            lb.publish_loopback({"event_type": "matter.changed", "data": {"public_id": "MAT-1"}})
            lb._shutdown_for_tests()  # 等 worker 线程跑完

        assert captured["url"] == "http://127.0.0.1:9299/api/events/publish"
        assert captured["body"]["event_type"] == "matter.changed"
        assert captured["body"]["data"] == {"public_id": "MAT-1"}
        assert captured["token"] == "tok-abc"
        assert captured["timeout"] == lb.TIMEOUT_SEC

    def test_default_port_when_env_absent(self, monkeypatch):
        monkeypatch.delenv("SSE_LOCAL_PORT", raising=False)
        assert lb._endpoint() == f"http://127.0.0.1:{lb.DEFAULT_SSE_PORT}{lb.PUBLISH_PATH}"

    def test_no_token_header_when_unset(self, monkeypatch):
        """未配 token → 不带 header (与 sse_server 的门关语义配套)。"""
        monkeypatch.setenv("MAILAGENT_LOCAL_API_TOKEN", "")
        captured = {}

        def fake_urlopen(request, timeout=None):
            captured["token"] = request.get_header(lb.LOCAL_TOKEN_HEADER.capitalize())
            return MagicMock(status=200, __enter__=lambda self: self, __exit__=lambda self, *a: False)

        with patch.object(lb.urllib.request, "urlopen", side_effect=fake_urlopen):
            lb.publish_loopback({"event_type": "x"})
            lb._shutdown_for_tests()
        assert captured["token"] is None

    def test_target_unreachable_never_raises(self, monkeypatch):
        """🔴 serve 没起 → 调用方拿到 None, 写操作照常成功。

        ⚠️ 本用例守的是 **fire-and-forget 本身** (投递在 worker 线程, 调用方不等结果),
        **不是** `_post` 内部的 except —— 那个 except 拆了这里照样绿 (异常留在 future 里)。
        `_post` 的异常处理由 `test_post_swallows_transport_errors` 直接守。
        """
        monkeypatch.setenv("SSE_LOCAL_PORT", "9298")
        with patch.object(
            lb.urllib.request, "urlopen", side_effect=OSError("connection refused")
        ):
            assert lb.publish_loopback({"event_type": "matter.changed"}) is None
            lb._shutdown_for_tests()

    @pytest.mark.parametrize(
        "error",
        [
            OSError("connection refused"),
            lb.urllib.error.URLError("unreachable"),
            ValueError("bad url"),
        ],
    )
    def test_post_swallows_transport_errors(self, error):
        """`_post` 同步直调: 三类传输失败都不抛 (worker 线程里抛 = unraisable 噪音)。"""
        with patch.object(lb.urllib.request, "urlopen", side_effect=error):
            assert lb._post({"event_type": "matter.changed"}) is None

    def test_post_tolerates_error_status(self):
        """4xx/5xx 响应不抛 (例: token 不匹配被 serve 拒)。"""
        response = MagicMock(status=401)
        response.__enter__ = lambda self: self
        response.__exit__ = lambda self, *a: False
        with patch.object(lb.urllib.request, "urlopen", return_value=response):
            assert lb._post({"event_type": "matter.changed"}) is None

    def test_submit_failure_never_raises(self):
        """executor.submit 抛 (interpreter shutdown 等) → swallow。"""
        with patch.object(lb, "_get_executor") as mock_get:
            mock_get.return_value = MagicMock(
                _work_queue=MagicMock(qsize=lambda: 0),
                submit=MagicMock(side_effect=RuntimeError("shutdown")),
            )
            assert lb.publish_loopback({"event_type": "x"}) is None

    def test_full_queue_drops(self):
        """队列满 → 丢弃, 不 submit (lossy bus 纪律: 宁可少刷一次也不吃内存)。"""
        submit = MagicMock()
        with patch.object(lb, "_get_executor") as mock_get:
            mock_get.return_value = MagicMock(
                _work_queue=MagicMock(qsize=lambda: lb.MAX_PENDING),
                submit=submit,
            )
            lb.publish_loopback({"event_type": "x"})
        submit.assert_not_called()


# ============================================================
# serve 侧 _publish_event — 接收端
# ============================================================

def _post_req(body: bytes | None, token: str | None = None):
    headers = {"Content-Type": "application/json"}
    if token is not None:
        headers[sse.LOCAL_TOKEN_HEADER] = token
    return make_mocked_request(
        "POST", lb.PUBLISH_PATH, headers=headers, payload=body
    )


class TestPublishEndpoint:
    @pytest.mark.asyncio
    async def test_rejects_bad_token(self, monkeypatch):
        monkeypatch.setattr(sse, "_LOCAL_API_TOKEN", "right")
        request = _post_req(b"{}", token="wrong")
        response = await sse._publish_event(request)
        assert response.status == 401

    @pytest.mark.asyncio
    async def test_rejects_missing_event_type(self, monkeypatch):
        monkeypatch.setattr(sse, "_LOCAL_API_TOKEN", "")
        request = _post_req(b'{"data": {}}')
        request.json = _async_value({"data": {}})
        response = await sse._publish_event(request)
        assert response.status == 400

    @pytest.mark.asyncio
    async def test_rejects_bad_json(self, monkeypatch):
        monkeypatch.setattr(sse, "_LOCAL_API_TOKEN", "")
        request = _post_req(b"not json")
        request.json = _async_raise(ValueError("bad"))
        response = await sse._publish_event(request)
        assert response.status == 400

    @pytest.mark.asyncio
    async def test_republishes_in_serve_process(self, monkeypatch):
        """happy path: 收到的事件经 safe_publish 重新发出 (serve 进程里 bus 已绑 loop)。"""
        monkeypatch.setattr(sse, "_LOCAL_API_TOKEN", "")
        request = _post_req(b"{}")
        request.json = _async_value(
            {
                "event_type": "matter.changed",
                "data": {"public_id": "MAT-7"},
                "internal_id": None,
                "source": "api",
            }
        )
        with patch("src.events.publisher.safe_publish") as mock_publish:
            response = await sse._publish_event(request)
        assert response.status == 200
        mock_publish.assert_called_once()
        assert mock_publish.call_args.args[0] == "matter.changed"
        assert mock_publish.call_args.kwargs["data"] == {"public_id": "MAT-7"}
        assert mock_publish.call_args.kwargs["internal_id"] is None

    @pytest.mark.asyncio
    async def test_non_int_internal_id_becomes_none(self, monkeypatch):
        """坏 internal_id 归一成 None, 而不是把脏值转发下去。"""
        monkeypatch.setattr(sse, "_LOCAL_API_TOKEN", "")
        request = _post_req(b"{}")
        request.json = _async_value({"event_type": "x", "internal_id": "abc"})
        with patch("src.events.publisher.safe_publish") as mock_publish:
            await sse._publish_event(request)
        assert mock_publish.call_args.kwargs["internal_id"] is None


def test_endpoint_is_registered():
    """端点必须真的挂进 app —— 忘了注册, 上面的单测全绿而线上 404。"""
    routes = {(r.method, r.resource.canonical) for r in sse.make_app().router.routes()}
    assert ("POST", lb.PUBLISH_PATH) in routes


def _async_value(value):
    async def _call():
        return value
    return _call


def _async_raise(error):
    async def _call():
        raise error
    return _call
