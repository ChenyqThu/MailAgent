"""M2a — mem0 召回 search 端点契约测试（mock 引擎，无网络/无 FAISS/无模型加载）。

``POST /api/chat/memory/search``：按 query 向 mem0 store 召回相关记忆（M2 读侧召回注入）。
与 test_chat_capture.py（写）正交；引擎全程 mock（patch ``get_mem0_engine`` —— 端点函数内
import 它），故零网络 + 绝不加载 mem0/fastembed/faiss 重依赖。auth bypass 默认 ON（conftest
设 MAILAGENT_API_AUTH_DISABLED=true）。
"""

from __future__ import annotations

from typing import Iterator, Tuple
from unittest import mock

import pytest
from fastapi.testclient import TestClient

from src.api.app import app


@pytest.fixture
def search_client(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[Tuple[TestClient, mock.MagicMock]]:
    """TestClient + mock Mem0Engine（search 端点函数内懒 import get_mem0_engine）。"""
    import src.memory.mem0_engine as me

    fake = mock.MagicMock()
    fake.search.return_value = {
        "results": [
            {"id": "m1", "memory": "User prefers terse Chinese", "score": 0.83},
            {"id": "m2", "memory": "Works with the Omada team", "score": 0.71},
        ]
    }
    monkeypatch.setattr(me, "get_mem0_engine", lambda: fake)
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client, fake


def test_search_returns_projected_memories(search_client) -> None:
    client, fake = search_client
    r = client.post("/api/chat/memory/search", json={"query": "我的语气偏好"})
    body = r.json()
    assert body["data"]["count"] == 2
    assert body["data"]["memories"][0] == {
        "id": "m1",
        "memory": "User prefers terse Chinese",
        "score": 0.83,
    }
    assert body["meta"]["source"] == "memory"
    # engine.search(query, DEFAULT_USER_ID) —— 位置参（run_in_threadpool 转发）；无 limit → 不
    # 透传（引擎用自身默认 top_k）。
    args, kwargs = fake.search.call_args
    assert args[0] == "我的语气偏好"
    assert args[1] == "owner"  # DEFAULT_USER_ID（单用户固定逻辑分区）
    assert "limit" not in kwargs


def test_search_forwards_valid_limit(search_client) -> None:
    client, fake = search_client
    client.post("/api/chat/memory/search", json={"query": "q", "limit": 10})
    _, kwargs = fake.search.call_args
    assert kwargs["limit"] == 10


def test_search_ignores_bad_limit(search_client) -> None:
    client, fake = search_client
    # 负数/0/bool/非 int → 忽略（不透传，引擎用默认）。bool 是 int 子类须显式排除。
    for bad in (0, -3, True, "5", 1.5):
        fake.search.reset_mock()
        client.post("/api/chat/memory/search", json={"query": "q", "limit": bad})
        _, kwargs = fake.search.call_args
        assert "limit" not in kwargs


def test_search_empty_query_short_circuits(search_client) -> None:
    client, fake = search_client
    r = client.post("/api/chat/memory/search", json={"query": "   "})
    assert r.json()["data"] == {"memories": [], "count": 0}
    fake.search.assert_not_called()  # 空 query 不触发向量检索


def test_search_validation_requires_query_string(search_client) -> None:
    client, fake = search_client
    for bad in ({}, {"query": 5}, {"limit": 10}):
        err = client.post("/api/chat/memory/search", json=bad).json()["error"]
        assert err["code"] == "E_INVALID_ARG"
    fake.search.assert_not_called()


def test_search_best_effort_on_engine_error(search_client) -> None:
    client, fake = search_client
    fake.search.side_effect = RuntimeError("faiss unavailable")
    r = client.post("/api/chat/memory/search", json={"query": "q"})
    # 召回失败不 500 —— 调用方在 TTFT 关键路径，须降级 context-light；返回 memories=[]。
    assert r.status_code == 200
    assert r.json()["data"] == {"memories": [], "count": 0}


def test_search_handles_non_dict_result(search_client) -> None:
    client, fake = search_client
    # mem0 API drift 防御：result 非 dict（如 list）→ 安全降级 []（不 AttributeError）。
    fake.search.return_value = ["weird-non-dict-shape"]
    r = client.post("/api/chat/memory/search", json={"query": "q"})
    assert r.status_code == 200
    assert r.json()["data"] == {"memories": [], "count": 0}


def test_search_drops_empty_memory_rows(search_client) -> None:
    client, fake = search_client
    fake.search.return_value = {
        "results": [
            {"id": "a", "memory": "kept", "score": 0.9},
            {"id": "b", "memory": "", "score": 0.5},  # 空 memory 文本 → 丢
            {"id": "c", "score": 0.4},  # 无 memory 字段 → 丢
            "not-a-dict",  # 非 dict → 丢
        ]
    }
    r = client.post("/api/chat/memory/search", json={"query": "q"})
    data = r.json()["data"]
    assert data["count"] == 1
    assert data["memories"][0]["id"] == "a"
