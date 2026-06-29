"""M3b — user.md 偏好编译端点契约测试（mock mem0 + compile，真 agent_config store）。

``POST /api/chat/memory/compile-user-md``：mem0.get_all → compile → 仅 changed 时
``set_profile_doc('user', agent_proposed)``。与 capture/search（Node 触发不自检 flag）不同，
本端点 **自检 `MAILAGENT_USER_MD_COMPILE`**（手动触发，HTTP 直达）。compile_user_md 引擎全 mock
（M3a 已测内部）；agent_config store 用真 `fresh_agent_cfg`（temp db）验证落库 + agent_proposed。
auth bypass 默认 ON（conftest 设 MAILAGENT_API_AUTH_DISABLED=true）。
"""

from __future__ import annotations

from typing import Iterator, Tuple
from unittest import mock

import pytest
from fastapi.testclient import TestClient

from src.api.app import app


def _patch_compile(monkeypatch, *, content="# USER\n\n- merged\n", changed=True, raises=None):
    """patch 端点函数内 import 的 compile_user_md（async）。端点测试隔离引擎内部（M3a 已测）。"""
    import src.memory.user_md_compiler as umc

    async def fake(*, current_user_md, memory_items, client=None):
        if raises is not None:
            raise raises
        return umc.CompileResult(
            content=content, changed=changed, item_count=len(memory_items),
            model="claude-sonnet-4-6", output_tokens=42,
        )

    monkeypatch.setattr(umc, "compile_user_md", fake)


@pytest.fixture
def compile_client(
    monkeypatch: pytest.MonkeyPatch, fresh_agent_cfg
) -> Iterator[Tuple[TestClient, mock.MagicMock, object]]:
    """TestClient + flag ON + mock mem0 get_all + 真 agent_config store（fresh temp db）。"""
    import src.config as cfgmod
    import src.memory.mem0_engine as me

    monkeypatch.setattr(cfgmod.config, "user_md_compile_enabled", True)
    fake_engine = mock.MagicMock()
    fake_engine.get_all.return_value = {
        "results": [{"id": "m1", "memory": "User prefers terse Chinese replies"}]
    }
    monkeypatch.setattr(me, "get_mem0_engine", lambda: fake_engine)
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client, fake_engine, fresh_agent_cfg


def test_compile_disabled_returns_403(monkeypatch: pytest.MonkeyPatch):
    """flag-off → E_DISABLED 403（在碰 store/engine 前拦截）。"""
    import src.config as cfgmod

    monkeypatch.setattr(cfgmod.config, "user_md_compile_enabled", False)
    with TestClient(app, raise_server_exceptions=False) as client:
        r = client.post("/api/chat/memory/compile-user-md")
        assert r.status_code == 403
        assert r.json()["error"]["code"] == "E_DISABLED"


def test_compile_changed_writes_user_doc(compile_client, monkeypatch: pytest.MonkeyPatch):
    client, fake_engine, store = compile_client
    _patch_compile(monkeypatch, content="# USER\n\n- terse Chinese\n", changed=True)
    r = client.post("/api/chat/memory/compile-user-md")
    body = r.json()
    assert r.status_code == 200
    assert body["data"]["changed"] is True
    assert body["data"]["after"] == "# USER\n\n- terse Chinese\n"
    assert body["data"]["itemCount"] == 1
    assert body["meta"]["source"] == "memory"
    assert body["data"]["before"].startswith("# USER")  # 写前 seed（含 # USER 锚）
    assert body["data"]["before"] != body["data"]["after"]  # changed → before/after 不同
    assert body["meta"]["model"] == "claude-sonnet-4-6"
    assert body["meta"]["outputTokens"] == 42
    # 落库验证：user doc 真被写 + updated_by=agent_proposed（agent_config history/rollback 兜底）
    doc = store.get_profile_doc("user")
    assert doc.content == "# USER\n\n- terse Chinese\n"
    assert doc.updated_by == "agent_proposed"
    # get_all(DEFAULT_USER_ID) —— 位置参（run_in_threadpool 转发）
    assert fake_engine.get_all.call_args[0][0] == "owner"


def test_compile_unchanged_does_not_write(compile_client, monkeypatch: pytest.MonkeyPatch):
    client, fake_engine, store = compile_client
    before = store.get_profile_doc("user")  # seed-on-read
    _patch_compile(monkeypatch, changed=False, content=before.content)
    r = client.post("/api/chat/memory/compile-user-md")
    body = r.json()
    assert r.status_code == 200
    assert body["data"]["changed"] is False
    # 未落库：updated_by 仍是 seed（changed=False 显式跳过 set_profile_doc）
    after = store.get_profile_doc("user")
    assert after.updated_by == before.updated_by
    assert after.content_hash == before.content_hash


def test_compile_get_all_failure_returns_500(compile_client):
    client, fake_engine, _store = compile_client
    fake_engine.get_all.side_effect = RuntimeError("faiss down")
    r = client.post("/api/chat/memory/compile-user-md")
    # 用户主动操作 → mem0 不可用 = 编译失败 raise（区别 search best-effort 降级）
    assert r.status_code == 500
    assert r.json()["error"]["code"] == "E_INTERNAL"


def test_compile_engine_error_returns_500(compile_client, monkeypatch: pytest.MonkeyPatch):
    import src.memory.user_md_compiler as umc

    client, _fake_engine, _store = compile_client
    _patch_compile(monkeypatch, raises=umc.UserMdCompileError("missing # USER"))
    r = client.post("/api/chat/memory/compile-user-md")
    assert r.status_code == 500
    assert r.json()["error"]["code"] == "E_INTERNAL"


def test_compile_handles_non_dict_get_all(compile_client, monkeypatch: pytest.MonkeyPatch):
    """mem0 API drift 防御：get_all 非 dict → items=[] 传给 compile（不 AttributeError）。"""
    import src.memory.user_md_compiler as umc

    client, fake_engine, _store = compile_client
    fake_engine.get_all.return_value = ["weird-non-dict-shape"]
    captured = {}

    async def fake(*, current_user_md, memory_items, client=None):
        captured["items"] = memory_items
        return umc.CompileResult(content=current_user_md, changed=False, item_count=0)

    monkeypatch.setattr(umc, "compile_user_md", fake)
    r = client.post("/api/chat/memory/compile-user-md")
    assert r.status_code == 200
    assert captured["items"] == []  # 非 dict get_all → 安全降级 []
