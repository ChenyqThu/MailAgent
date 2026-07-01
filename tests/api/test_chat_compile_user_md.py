"""M3b — user.md 偏好编译端点契约测试（mock load_memory_md + compile，真 agent_config store）。

``POST /api/chat/memory/compile-user-md``：load_memory_md → compile → 仅 changed 时
``set_profile_doc('user', agent_proposed)``（task 07-01 步4：源从 mem0 改 memory.md）。与
capture/search（Node 触发不自检 flag）不同，本端点 **自检 `MAILAGENT_USER_MD_COMPILE`**（手动触发，
HTTP 直达）。compile_user_md 引擎多数 mock（M3a 已测内部）；agent_config store 用真 `fresh_agent_cfg`
（temp db）验证落库 + agent_proposed。auth bypass 默认 ON（conftest 设 MAILAGENT_API_AUTH_DISABLED=true）。
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

    async def fake(*, current_user_md, memory_md, client=None):
        if raises is not None:
            raise raises
        return umc.CompileResult(
            content=content, changed=changed,
            item_count=sum(1 for ln in (memory_md or "").split("\n") if ln.strip()),
            model="claude-sonnet-4-6", output_tokens=42,
        )

    monkeypatch.setattr(umc, "compile_user_md", fake)


@pytest.fixture
def compile_client(
    monkeypatch: pytest.MonkeyPatch, fresh_agent_cfg
) -> Iterator[Tuple[TestClient, mock.MagicMock, object]]:
    """TestClient + flag ON + mock load_memory_md + 真 agent_config store（fresh temp db）。"""
    import src.config as cfgmod
    import src.memory.memory_md as mm

    monkeypatch.setattr(cfgmod.config, "user_md_compile_enabled", True)
    fake_load = mock.MagicMock(return_value="- User prefers terse Chinese replies\n")
    monkeypatch.setattr(mm, "load_memory_md", fake_load)
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client, fake_load, fresh_agent_cfg


def test_compile_disabled_returns_403(monkeypatch: pytest.MonkeyPatch):
    """flag-off → E_DISABLED 403（在碰 store/memory.md 前拦截）。"""
    import src.config as cfgmod

    monkeypatch.setattr(cfgmod.config, "user_md_compile_enabled", False)
    with TestClient(app, raise_server_exceptions=False) as client:
        r = client.post("/api/chat/memory/compile-user-md")
        assert r.status_code == 403
        assert r.json()["error"]["code"] == "E_DISABLED"


def test_compile_changed_writes_user_doc(compile_client, monkeypatch: pytest.MonkeyPatch):
    client, fake_load, store = compile_client
    _patch_compile(monkeypatch, content="# USER\n\n- terse Chinese\n", changed=True)
    r = client.post("/api/chat/memory/compile-user-md")
    body = r.json()
    assert r.status_code == 200
    assert body["data"]["changed"] is True
    assert body["data"]["after"] == "# USER\n\n- terse Chinese\n"
    assert body["data"]["itemCount"] == 1  # memory.md 1 条非空行
    assert body["meta"]["source"] == "memory"
    assert body["data"]["before"].startswith("# USER")  # 写前 seed（含 # USER 锚）
    assert body["data"]["before"] != body["data"]["after"]  # changed → before/after 不同
    assert body["meta"]["model"] == "claude-sonnet-4-6"
    assert body["meta"]["outputTokens"] == 42
    # M3c — beforeHash：前端 rollback 需要，应为写前 doc 的 content_hash（非空 str）。
    before_hash = body["data"]["beforeHash"]
    assert isinstance(before_hash, str) and len(before_hash) > 0
    after_doc = store.get_profile_doc("user")
    assert before_hash != after_doc.content_hash  # changed=True → 前后 hash 不同
    # 落库验证：user doc 真被写 + updated_by=agent_proposed（agent_config history/rollback 兜底）
    doc = store.get_profile_doc("user")
    assert doc.content == "# USER\n\n- terse Chinese\n"
    assert doc.updated_by == "agent_proposed"
    # memory.md 源经 load_memory_md() 读（无参）
    assert fake_load.call_count == 1


def test_compile_unchanged_does_not_write(compile_client, monkeypatch: pytest.MonkeyPatch):
    client, _fake_load, store = compile_client
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


def test_compile_load_memory_failure_returns_500(compile_client):
    client, fake_load, _store = compile_client
    fake_load.side_effect = RuntimeError("agent_config down")
    r = client.post("/api/chat/memory/compile-user-md")
    # 用户主动操作 → memory.md 读不可用 = 编译失败 raise（区别 search best-effort 降级）
    assert r.status_code == 500
    assert r.json()["error"]["code"] == "E_INTERNAL"


def test_compile_engine_error_returns_500(compile_client, monkeypatch: pytest.MonkeyPatch):
    import src.memory.user_md_compiler as umc

    client, _fake_load, _store = compile_client
    _patch_compile(monkeypatch, raises=umc.UserMdCompileError("missing # USER"))
    r = client.post("/api/chat/memory/compile-user-md")
    assert r.status_code == 500
    assert r.json()["error"]["code"] == "E_INTERNAL"


def test_compile_empty_memory_md_no_write(compile_client):
    """空 memory.md → 真 compile_user_md 短路 unchanged → 不落库、不崩（不 patch compile）。"""
    client, fake_load, store = compile_client
    fake_load.return_value = ""  # 空 memory.md（seed 首次即空）
    before = store.get_profile_doc("user")
    r = client.post("/api/chat/memory/compile-user-md")
    body = r.json()
    assert r.status_code == 200
    assert body["data"]["changed"] is False
    assert body["data"]["itemCount"] == 0
    after = store.get_profile_doc("user")
    assert after.content_hash == before.content_hash  # 未落库
