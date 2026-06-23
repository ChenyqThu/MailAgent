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

# v8 (P2a) shape — mirror chat_db.ts agent_memory_kv after the v7→v8 migration
# (provenance + priority columns). The frontend owns the real schema; this DDL
# must track it so serve-api writes don't hit "no such column".
_MEM_DDL = """
CREATE TABLE agent_memory_kv (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    source_wiki_path TEXT,
    source_session_id INTEGER,
    source_message_id INTEGER,
    source_tool_use_id TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
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


# ── v8 (P2a) provenance + relevance ──────────────────────────────────────────


def test_upsert_records_provenance_and_priority(chatdb: ChatDb) -> None:
    row = chatdb.upsert_memory_entry(
        "user", "reply_language", '"中文"', "session:42",
        source_session_id=42, source_message_id=100, source_tool_use_id="tu1", priority=3,
    )
    assert row["source_session_id"] == 42
    assert row["source_message_id"] == 100
    assert row["source_tool_use_id"] == "tu1"
    assert row["priority"] == 3


def test_priority_coalesce_preserved_on_value_only_update(chatdb: ChatDb) -> None:
    chatdb.upsert_memory_entry("user", "k", '"v1"', priority=5, source_session_id=1)
    # re-write value WITHOUT priority → keep 5 (COALESCE), refresh provenance to latest
    row = chatdb.upsert_memory_entry("user", "k", '"v2"', source_session_id=9)
    assert row["value_json"] == '"v2"'
    assert row["priority"] == 5
    assert row["source_session_id"] == 9
    # a brand-new entry with no priority defaults to 0
    fresh = chatdb.upsert_memory_entry("user", "fresh", '"x"')
    assert fresh["priority"] == 0


def test_memory_summary_relevance_priority_then_recency(chatdb: ChatDb) -> None:
    # lower priority but newer
    chatdb.upsert_memory_entry("user", "recent_low", '"a"', priority=0)
    # higher priority → must sort FIRST despite being written earlier in real time
    chatdb.upsert_memory_entry("user", "pinned_high", '"b"', priority=9)
    summary = chatdb.memory_summary("user")
    lines = summary.splitlines()
    assert lines[0].startswith("- pinned_high"), summary


def test_memory_summary_meta_observability_and_caps(chatdb: ChatDb) -> None:
    for i in range(5):
        chatdb.upsert_memory_entry("user", f"k{i}", '"v"')
    # entry cap observable: injected <= max_entries, total counts all
    meta = chatdb.memory_summary_meta("user", limit=3)
    assert meta["injected"] == 3
    assert meta["total"] == 5
    assert meta["max_entries"] == 3
    # char cap observable
    chatdb.upsert_memory_entry("user", "big", '"' + "x" * 5000 + '"')
    meta2 = chatdb.memory_summary_meta("user", max_chars=200)
    assert meta2["truncated"] is True
    assert meta2["max_chars"] == 200


def test_router_upsert_provenance_passthrough(chat_client: TestClient) -> None:
    r = chat_client.post(
        "/api/chat/memory",
        json={
            "scope": "user", "key": "sig", "valueJson": '"Best, L"',
            "sourceSessionId": 7, "sourceMessageId": 70, "sourceToolUseId": "tu9", "priority": 2,
        },
    )
    data = r.json()["data"]
    assert data["source_session_id"] == 7
    assert data["source_message_id"] == 70
    assert data["source_tool_use_id"] == "tu9"
    assert data["priority"] == 2


def test_router_upsert_rejects_bad_provenance_types(chat_client: TestClient) -> None:
    base = {"scope": "user", "key": "k", "valueJson": '"v"'}
    for bad in (
        {**base, "priority": "high"},          # str, not int
        {**base, "priority": True},            # bool rejected (int subclass)
        {**base, "sourceSessionId": "x"},      # str, not int
        {**base, "sourceToolUseId": 5},        # int, not str
    ):
        err = chat_client.post("/api/chat/memory", json=bad).json()["error"]
        assert err["code"] == "E_INVALID_ARG"


def test_router_clamps_negative_priority(chat_client: TestClient) -> None:
    # ORDER BY priority DESC → a negative priority would sort below default 0;
    # the router clamps it to 0 (no boost) rather than storing a de-prioritizer.
    r = chat_client.post(
        "/api/chat/memory",
        json={"scope": "user", "key": "k", "valueJson": '"v"', "priority": -5},
    )
    assert r.json()["data"]["priority"] == 0


def test_config_includes_memory_summary_meta(chat_client: TestClient) -> None:
    chat_client.post(
        "/api/chat/memory", json={"scope": "user", "key": "tone", "valueJson": '"terse"'}
    )
    cfg = chat_client.get("/api/chat/config").json()["data"]
    meta = cfg["memorySummaryMeta"]
    assert meta is not None
    assert meta["total"] == 1 and meta["injected"] == 1
    assert meta["max_entries"] >= 1 and meta["max_chars"] >= 1
