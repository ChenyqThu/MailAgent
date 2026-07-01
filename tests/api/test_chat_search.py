"""task 07-01 — /chat/memory/search 已退役（mem0 按-query 召回 M2 → memory.md 恒注入取代）。

端点保留为退役 stub：恒返回空 ``{memories:[], count:0}``，不碰 mem0/FAISS（过渡期若 Node 步2 前
仍调用 → 空召回 → context-light，安全）。auth bypass 默认 ON（conftest 设
MAILAGENT_API_AUTH_DISABLED=true）。
"""

from __future__ import annotations

from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from src.api.app import app


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def test_search_retired_returns_empty(client: TestClient) -> None:
    r = client.post("/api/chat/memory/search", json={"query": "我的语气偏好"})
    assert r.status_code == 200
    body = r.json()
    assert body["data"] == {"memories": [], "count": 0}
    assert body["meta"]["source"] == "memory"


def test_search_retired_ignores_body_variants(client: TestClient) -> None:
    # 退役 stub 不校验 body（不碰 mem0）—— 任意 body 都返回空、200，绝不 500。
    for body in ({}, {"query": 5}, {"limit": 10}, {"query": "q", "limit": 3}):
        r = client.post("/api/chat/memory/search", json=body)
        assert r.status_code == 200
        assert r.json()["data"] == {"memories": [], "count": 0}
