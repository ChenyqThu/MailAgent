"""C2 — SSE 9200 本地 token 门 (sse_server._local_token_ok + _stream_events 401)。

9200 SSE 仅 loopback, 但同机任意进程都能读 → 泄漏 internal_id + 操作时序。配了
MAILAGENT_LOCAL_API_TOKEN 时要求 X-MailAgent-Local-Token header 匹配; 未配 → 门关
(向后兼容)。这里直测纯函数 _local_token_ok 全分支 + _stream_events 的 401 早返回
(不触 redis/streaming), 并钉死 header / env 名与 src/api/auth.py 一致 (防两处手抄漂移)。
"""

from __future__ import annotations

import os

import pytest
from aiohttp.test_utils import make_mocked_request

import src.sse_server as sse

# 让 import src.api.auth (header 契约测试用) 不因「无鉴权方式」启动守卫崩 — 声明 dev/bypass。
os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
os.environ.setdefault("MAILAGENT_API_DEV", "true")


def _req(tok: str | None):
    headers = {} if tok is None else {sse.LOCAL_TOKEN_HEADER: tok}
    return make_mocked_request("GET", "/api/events/stream", headers=headers)


def test_gate_off_allows_any(monkeypatch):
    """未配 token → 门关: 无 header / 任意 header 都放行 (dev/pm2 serve 无注入时向后兼容)。"""
    monkeypatch.setattr(sse, "_LOCAL_API_TOKEN", "")
    assert sse._local_token_ok(_req(None)) is True
    assert sse._local_token_ok(_req("whatever")) is True


def test_gate_on_requires_match(monkeypatch):
    """配了 token → 无 header / 错 header 拒, 正确 header 放行 (compare_digest 防时序侧信道)。"""
    monkeypatch.setattr(sse, "_LOCAL_API_TOKEN", "ephemeral-secret")
    assert sse._local_token_ok(_req(None)) is False
    assert sse._local_token_ok(_req("wrong")) is False
    assert sse._local_token_ok(_req("ephemeral-secret")) is True


@pytest.mark.asyncio
async def test_stream_events_401_when_gate_on_no_header(monkeypatch):
    """gate on + 无 header → _stream_events 早返回 401, 在 redis 检查之前 (不触 streaming)。"""
    monkeypatch.setattr(sse, "_LOCAL_API_TOKEN", "ephemeral-secret")
    resp = await sse._stream_events(_req(None))
    assert resp.status == 401


@pytest.mark.asyncio
async def test_stream_events_401_when_gate_on_wrong_header(monkeypatch):
    """gate on + 错 header → 401 (同上, 不触 redis)。"""
    monkeypatch.setattr(sse, "_LOCAL_API_TOKEN", "ephemeral-secret")
    resp = await sse._stream_events(_req("wrong"))
    assert resp.status == 401


def test_header_name_contract_matches_auth():
    """header 名 LOCAL_TOKEN_HEADER 必须与 src/api/auth.py 逐字一致 (两处手抄, 防漂移)。"""
    import src.api.auth as auth_mod

    assert sse.LOCAL_TOKEN_HEADER == auth_mod.LOCAL_TOKEN_HEADER == "X-MailAgent-Local-Token"


def test_env_key_literal_consistent():
    """env key MAILAGENT_LOCAL_API_TOKEN 在 auth.py + sse_server.py 一致 (TS local_token.ts 的
    LOCAL_TOKEN_ENV 亦须同名; 见该文件 🔴 注释 + backend_lifecycle 注入断言)。"""
    import inspect

    import src.api.auth as auth_mod

    for mod in (sse, auth_mod):
        assert "MAILAGENT_LOCAL_API_TOKEN" in inspect.getsource(mod)
