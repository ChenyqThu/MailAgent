"""P2f — agent_memory_kv memory WAL 契约测试（ChatDb CRUD + summary + /chat/memory 路由）。

task 06-18-custom-ai-harness-agent Phase 2。agent_memory_kv 由前端 chat_db.ts v3 建（idle 至此），
serve-api ``src/chat/db.py`` 只 mirror 读写既有表。验证 list/get/upsert/delete + memory_summary
（注入 system prompt）+ /chat/memory 端点。auth bypass 默认 ON（conftest）。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from src.api.app import app
from src.chat.db import ChatDb

_MEM_DDL = """
CREATE TABLE agent_memory_kv (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    source_wiki_path TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope, key)
);
"""


@pytest.fixture
def mem_db_path(tmp_path: Path) -> Path:
    db = tmp_path / "ai_chat.db"
    conn = sqlite3.connect(str(db))
    conn.executescript(_MEM_DDL)
    conn.commit()
    conn.close()
    return db


@pytest.fixture
def chatdb(mem_db_path: Path) -> ChatDb:
    return ChatDb(db_path=str(mem_db_path))


@pytest.fixture
def chat_client(monkeypatch: pytest.MonkeyPatch, mem_db_path: Path) -> Iterator[TestClient]:
    import src.api.routers.chat as _chat_router

    monkeypatch.setattr(_chat_router, "get_chat_db", lambda: ChatDb(db_path=str(mem_db_path)))
    with TestClient(app) as client:
        yield client


# ── ChatDb CRUD（直接层）─────────────────────────────────────────────────────


def test_upsert_then_get(chatdb: ChatDb) -> None:
    row = chatdb.upsert_memory_entry("user", "reply_language", '"English"', "session:5")
    assert row["scope"] == "user"
    assert row["key"] == "reply_language"
    assert row["value_json"] == '"English"'
    assert row["source_wiki_path"] == "session:5"
    got = chatdb.get_memory_entry("user", "reply_language")
    assert got is not None
    assert got["value_json"] == '"English"'


def test_get_missing_returns_none(chatdb: ChatDb) -> None:
    assert chatdb.get_memory_entry("user", "nope") is None


def test_upsert_overwrites_preserving_created_at(chatdb: ChatDb) -> None:
    first = chatdb.upsert_memory_entry("user", "k", '"v1"')
    created = first["created_at"]
    second = chatdb.upsert_memory_entry("user", "k", '"v2"')
    assert second["value_json"] == '"v2"'
    assert second["created_at"] == created  # created_at 保留
    assert second["updated_at"] >= created
    # 仍只有一行（UPSERT 不新增）。
    assert len(chatdb.list_memory_entries("user")) == 1


def test_list_scope_filter(chatdb: ChatDb) -> None:
    chatdb.upsert_memory_entry("user", "a", '"1"')
    chatdb.upsert_memory_entry("skill:search", "b", '"2"')
    assert {r["key"] for r in chatdb.list_memory_entries("user")} == {"a"}
    assert {r["key"] for r in chatdb.list_memory_entries()} == {"a", "b"}


def test_delete(chatdb: ChatDb) -> None:
    chatdb.upsert_memory_entry("user", "k", '"v"')
    assert chatdb.delete_memory_entry("user", "k") == 1
    assert chatdb.delete_memory_entry("user", "k") == 0  # 幂等
    assert chatdb.get_memory_entry("user", "k") is None


def test_memory_summary_scalar_and_truncation(chatdb: ChatDb) -> None:
    chatdb.upsert_memory_entry("user", "lang", '"English"')
    chatdb.upsert_memory_entry("user", "obj", '{"a": 1}')
    summary = chatdb.memory_summary("user")
    assert "- lang: English" in summary  # 标量解出
    assert "obj" in summary
    # 空 scope → ""
    assert chatdb.memory_summary("skill:none") == ""
    # 截断
    chatdb.upsert_memory_entry("user", "big", '"' + "x" * 5000 + '"')
    assert "truncated" in chatdb.memory_summary("user", max_chars=200)


def test_memory_summary_graceful_on_missing_db(tmp_path: Path) -> None:
    # 库不存在 → list_memory_entries graceful [] → summary ""（不阻断 /chat/config）。
    db = ChatDb(db_path=str(tmp_path / "nope.db"))
    assert db.memory_summary() == ""


# ── serve-api 路由 ───────────────────────────────────────────────────────────


def test_router_upsert_list_get_delete(chat_client: TestClient) -> None:
    # upsert
    r = chat_client.post(
        "/api/chat/memory",
        json={"scope": "user", "key": "sig", "valueJson": '"Best, L"', "sourceWikiPath": "session:1"},
    )
    assert r.json()["data"]["key"] == "sig"
    # list
    items = chat_client.get("/api/chat/memory", params={"scope": "user"}).json()["data"]
    assert len(items) == 1 and items[0]["key"] == "sig"
    # get
    got = chat_client.get(
        "/api/chat/memory/entry", params={"scope": "user", "key": "sig"}
    ).json()["data"]
    assert got["value_json"] == '"Best, L"'
    # get missing → data=null（不 404）
    miss = chat_client.get(
        "/api/chat/memory/entry", params={"scope": "user", "key": "x"}
    ).json()["data"]
    assert miss is None
    # delete
    d = chat_client.delete(
        "/api/chat/memory", params={"scope": "user", "key": "sig"}
    ).json()["data"]
    assert d["deleted"] == 1


def test_router_upsert_validation(chat_client: TestClient) -> None:
    for bad in ({}, {"scope": "user"}, {"scope": "user", "key": "k"}):
        err = chat_client.post("/api/chat/memory", json=bad).json()["error"]
        assert err["code"] == "E_INVALID_ARG"


def test_config_includes_memory_summary(chat_client: TestClient) -> None:
    chat_client.post(
        "/api/chat/memory", json={"scope": "user", "key": "tone", "valueJson": '"terse"'}
    )
    cfg = chat_client.get("/api/chat/config").json()["data"]
    assert "memorySummary" in cfg
    assert "tone" in cfg["memorySummary"]
