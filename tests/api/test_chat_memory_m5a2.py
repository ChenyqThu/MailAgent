"""M5a-2 — 4 个 /api/chat/memory 端点 flag-gated 改接 kv-over-mem0 适配层（双路径测试）。

铁律：
- flag-off 路径：现有 ChatDb 路径字节级不变（test_chat_memory.py 已全覆盖，本文件只做负向确认）。
- flag-on 路径：端点走 kv_over_mem0 adapter（monkeypatch，mem0 engine 不实例化）。

关键断言（高危点）：
- HIGH-2 priority None 透传：upsert 省略 priority → adapter 收到 None（绝不默认成 0）。
- wire 兼容：flag-on 返回的 row 含 source_* = None + epoch-ms 时间（前端零改）。
- flag-off 逐字走 ChatDb（get_chat_db 被调，kv adapter 不被调）。
"""
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Iterator
from unittest import mock

import pytest
from fastapi.testclient import TestClient

from src.api.app import app
from src.chat.db import ChatDb

# ── 公共 fixtures ────────────────────────────────────────────────────────────

_MEM_DDL = """
CREATE TABLE agent_memory_kv (
    scope TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
    source_wiki_path TEXT, source_session_id INTEGER, source_message_id INTEGER,
    source_tool_use_id TEXT, priority INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
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
def chat_client_kv_off(
    monkeypatch: pytest.MonkeyPatch, mem_db_path: Path
) -> Iterator[TestClient]:
    """flag-off（默认）client — ChatDb 路径不变。"""
    import src.api.routers.chat as _cr
    import src.config as cfgmod

    monkeypatch.setattr(cfgmod.config, "memory_kv_retire_enabled", False)
    monkeypatch.setattr(_cr, "get_chat_db", lambda: ChatDb(db_path=str(mem_db_path)))
    with TestClient(app) as client:
        yield client


# flag-on client + 三个 adapter spy stubs
_STUB_ROW = {
    "scope": "user", "key": "k", "value_json": '"v"',
    "source_wiki_path": None, "source_session_id": None,
    "source_message_id": None, "source_tool_use_id": None,
    "priority": 3,
    "created_at": 1_750_000_000_000, "updated_at": 1_750_000_001_000,
}


@pytest.fixture
def chat_client_kv_on(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """flag-on client — kv_over_mem0 adapter monkeypatched（不实例化 mem0 engine）。"""
    import src.config as cfgmod
    import src.memory.kv_over_mem0 as kvo

    monkeypatch.setattr(cfgmod.config, "memory_kv_retire_enabled", True)
    monkeypatch.setattr(kvo, "kv_list", lambda scope=None: [_STUB_ROW])
    monkeypatch.setattr(kvo, "kv_get", lambda scope, key: _STUB_ROW if key == "k" else None)
    monkeypatch.setattr(kvo, "kv_upsert", mock.MagicMock(return_value=None))
    monkeypatch.setattr(kvo, "kv_delete", lambda scope, key: 1 if key == "k" else 0)
    with TestClient(app) as client:
        yield client


# ── flag-off：ChatDb 路径不变（负向确认）────────────────────────────────────


def test_flagoff_list_uses_chatdb(chat_client_kv_off: TestClient, mem_db_path: Path) -> None:
    db = ChatDb(db_path=str(mem_db_path))
    db.upsert_memory_entry("user", "k", '"v"')
    r = chat_client_kv_off.get("/api/chat/memory", params={"scope": "user"})
    assert r.status_code == 200
    data = r.json()["data"]
    assert len(data) == 1 and data[0]["key"] == "k"
    assert r.json()["meta"]["source"] == "sqlite"


def test_flagoff_get_uses_chatdb(chat_client_kv_off: TestClient, mem_db_path: Path) -> None:
    db = ChatDb(db_path=str(mem_db_path))
    db.upsert_memory_entry("user", "k", '"v"')
    r = chat_client_kv_off.get("/api/chat/memory/entry", params={"scope": "user", "key": "k"})
    assert r.status_code == 200
    assert r.json()["data"]["value_json"] == '"v"'
    assert r.json()["meta"]["source"] == "sqlite"


def test_flagoff_upsert_uses_chatdb(chat_client_kv_off: TestClient, mem_db_path: Path) -> None:
    r = chat_client_kv_off.post(
        "/api/chat/memory", json={"scope": "user", "key": "k", "valueJson": '"v"'}
    )
    assert r.status_code == 200
    assert r.json()["data"]["key"] == "k"
    assert r.json()["meta"]["source"] == "sqlite"
    # verify it landed in SQLite
    db = ChatDb(db_path=str(mem_db_path))
    assert db.get_memory_entry("user", "k") is not None


def test_flagoff_delete_uses_chatdb(chat_client_kv_off: TestClient, mem_db_path: Path) -> None:
    db = ChatDb(db_path=str(mem_db_path))
    db.upsert_memory_entry("user", "k", '"v"')
    r = chat_client_kv_off.delete("/api/chat/memory", params={"scope": "user", "key": "k"})
    assert r.status_code == 200
    assert r.json()["data"]["deleted"] == 1
    assert r.json()["meta"]["source"] == "sqlite"


# ── flag-on：kv_over_mem0 adapter 路径 ────────────────────────────────────


def test_flagon_list_uses_adapter(chat_client_kv_on: TestClient) -> None:
    r = chat_client_kv_on.get("/api/chat/memory", params={"scope": "user"})
    assert r.status_code == 200
    body = r.json()
    assert body["meta"]["source"] == "mem0"
    data = body["data"]
    assert len(data) == 1
    assert data[0]["key"] == "k"
    assert body["meta"]["count"] == 1


def test_flagon_get_hit_uses_adapter(chat_client_kv_on: TestClient) -> None:
    r = chat_client_kv_on.get("/api/chat/memory/entry", params={"scope": "user", "key": "k"})
    assert r.status_code == 200
    body = r.json()
    assert body["meta"]["source"] == "mem0"
    row = body["data"]
    assert row["key"] == "k"
    assert row["value_json"] == '"v"'


def test_flagon_get_miss_returns_null(chat_client_kv_on: TestClient) -> None:
    r = chat_client_kv_on.get("/api/chat/memory/entry", params={"scope": "user", "key": "nope"})
    assert r.status_code == 200
    assert r.json()["data"] is None
    assert r.json()["meta"]["source"] == "mem0"


def test_flagon_upsert_calls_adapter_and_returns_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """upsert flag-on：kv_upsert 被调，返回 kv_get 的 wire-compatible row。"""
    import src.config as cfgmod
    import src.memory.kv_over_mem0 as kvo

    upsert_spy = mock.MagicMock(return_value=None)
    get_spy = mock.MagicMock(return_value=_STUB_ROW)
    monkeypatch.setattr(cfgmod.config, "memory_kv_retire_enabled", True)
    monkeypatch.setattr(kvo, "kv_upsert", upsert_spy)
    monkeypatch.setattr(kvo, "kv_get", get_spy)

    with TestClient(app) as client:
        r = client.post(
            "/api/chat/memory",
            json={"scope": "user", "key": "k", "valueJson": '"v"', "priority": 3},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["meta"]["source"] == "mem0"
    row = body["data"]
    assert row["key"] == "k"
    assert row["priority"] == 3
    # kv_upsert 被调一次，且拿到正确 priority=3
    upsert_spy.assert_called_once_with("user", "k", '"v"', 3)
    # kv_get 被调一次取回 row
    get_spy.assert_called_once_with("user", "k")


def test_flagon_upsert_wire_shape(chat_client_kv_on: TestClient) -> None:
    """wire 兼容：flag-on upsert 返回的 row 含 4 个 source_* = None + epoch-ms 时间（前端零改）。"""
    r = chat_client_kv_on.post(
        "/api/chat/memory",
        json={"scope": "user", "key": "k", "valueJson": '"v"'},
    )
    assert r.status_code == 200
    row = r.json()["data"]
    assert row["source_wiki_path"] is None
    assert row["source_session_id"] is None
    assert row["source_message_id"] is None
    assert row["source_tool_use_id"] is None
    assert isinstance(row["created_at"], int)
    assert isinstance(row["updated_at"], int)


# ── HIGH-2 priority None 透传（最关键断言）──────────────────────────────────


def test_flagon_upsert_priority_none_passed_through(monkeypatch: pytest.MonkeyPatch) -> None:
    """🔴 HIGH-2：省略 priority（body 无 priority 字段）→ adapter 收到 None，绝不默认成 0。
    COALESCE 语义由 engine.upsert_kv 负责（省略=保留旧值），端点不干预。"""
    import src.config as cfgmod
    import src.memory.kv_over_mem0 as kvo

    upsert_spy = mock.MagicMock(return_value=None)
    monkeypatch.setattr(cfgmod.config, "memory_kv_retire_enabled", True)
    monkeypatch.setattr(kvo, "kv_upsert", upsert_spy)
    monkeypatch.setattr(kvo, "kv_get", lambda scope, key: _STUB_ROW)

    with TestClient(app) as client:
        client.post(
            "/api/chat/memory",
            json={"scope": "user", "key": "k", "valueJson": '"v"'},
            # 注意：不传 priority
        )
    # 第 4 个位置参数（priority）必须是 None
    call_args = upsert_spy.call_args
    _, priority_arg = call_args[0][2], call_args[0][3]
    assert priority_arg is None, (
        f"priority must be None (COALESCE) when omitted, got {priority_arg!r}"
    )


def test_flagon_upsert_priority_zero_passed_through(monkeypatch: pytest.MonkeyPatch) -> None:
    """显式传 priority=0 → adapter 收到 0（不被 None-COALESCE 路径吸收）。"""
    import src.config as cfgmod
    import src.memory.kv_over_mem0 as kvo

    upsert_spy = mock.MagicMock(return_value=None)
    monkeypatch.setattr(cfgmod.config, "memory_kv_retire_enabled", True)
    monkeypatch.setattr(kvo, "kv_upsert", upsert_spy)
    monkeypatch.setattr(kvo, "kv_get", lambda scope, key: _STUB_ROW)

    with TestClient(app) as client:
        client.post(
            "/api/chat/memory",
            json={"scope": "user", "key": "k", "valueJson": '"v"', "priority": 0},
        )
    call_args = upsert_spy.call_args
    priority_arg = call_args[0][3]
    assert priority_arg == 0


def test_flagon_delete_uses_adapter(chat_client_kv_on: TestClient) -> None:
    r = chat_client_kv_on.delete("/api/chat/memory", params={"scope": "user", "key": "k"})
    assert r.status_code == 200
    body = r.json()
    assert body["meta"]["source"] == "mem0"
    assert body["data"]["deleted"] == 1


def test_flagon_delete_missing_idempotent(chat_client_kv_on: TestClient) -> None:
    r = chat_client_kv_on.delete("/api/chat/memory", params={"scope": "user", "key": "nope"})
    assert r.status_code == 200
    assert r.json()["data"]["deleted"] == 0
    assert r.json()["meta"]["source"] == "mem0"


# ── validation 共用（flag-on/off 均需通过，验证门逻辑不因 flag 跳过）────────


def test_upsert_validation_still_runs_when_flag_on(chat_client_kv_on: TestClient) -> None:
    """input validation（E_INVALID_ARG）在 flag 检查前 → flag-on 下仍正确拒绝 bad input。"""
    for bad in ({}, {"scope": "user"}, {"scope": "user", "key": "k"}):
        r = chat_client_kv_on.post("/api/chat/memory", json=bad)
        assert r.json()["error"]["code"] == "E_INVALID_ARG"
