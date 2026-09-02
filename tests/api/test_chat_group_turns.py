"""turn 台账只读面 —— ``GET /api/chat/sessions/{id}/group-turns``。

这张表是「刷新后还原在场态」的唯一服务端事实：沉默 / 重复折叠 / 跳过 / 失败 / 停止的 turn
**没有**落库消息，只有 ``ai_chat_group_turn`` 证明它们发生过（红线 1：前端不许推断）。
覆盖投影形状与序、``before`` 分页 + hasMore、limit 上限、``since`` 过滤（清空历史后旧 meta 行
不再回到对话里）、未迁移旧库降级。

schema 归前端 chat_db.ts owns；本文件的 mirror DDL 含 v31 的 ai_chat_group_turn。
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from src.api.app import app
from src.chat.db import ChatDb

_DDL = """
CREATE TABLE ai_chat_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id INTEGER,
    anchor_type TEXT NOT NULL DEFAULT 'email' CHECK (anchor_type IN ('email','general')),
    anchor_id INTEGER,
    backend_kind TEXT NOT NULL,
    title TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    origin TEXT,
    members_json TEXT,
    group_config_json TEXT
);
CREATE TABLE ai_chat_group_turn (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    chain_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    trigger_kind TEXT NOT NULL
      CHECK (trigger_kind IN ('human','main_agent','agent','judge_post')),
    outcome TEXT NOT NULL
      CHECK (outcome IN ('spoke','silent','held_dup','skipped','failed','stopped')),
    message_id INTEGER NULL,
    model TEXT NULL,
    tokens_input INTEGER NULL,
    tokens_output INTEGER NULL,
    cost_usd REAL NULL,
    window_from_id INTEGER NULL,
    window_to_id INTEGER NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER NULL,
    error TEXT NULL
);
"""


def _insert_turn(conn: sqlite3.Connection, **row) -> None:
    base = {
        "session_id": 1,
        "run_id": "run-1",
        "chain_id": 10,
        "seq": 1,
        "agent_id": "a1",
        "trigger_kind": "human",
        "outcome": "spoke",
        "message_id": None,
        "model": None,
        "tokens_input": None,
        "tokens_output": None,
        "cost_usd": None,
        "window_from_id": None,
        "window_to_id": None,
        "started_at": 1000,
        "finished_at": None,
        "error": None,
    }
    base.update(row)
    cols = ",".join(base)
    marks = ",".join("?" * len(base))
    conn.execute(f"INSERT INTO ai_chat_group_turn ({cols}) VALUES ({marks})", tuple(base.values()))


@pytest.fixture
def chat_db_path(tmp_path: Path) -> Path:
    db = tmp_path / "ai_chat.db"
    conn = sqlite3.connect(str(db))
    conn.executescript(_DDL)
    conn.execute(
        "INSERT INTO ai_chat_sessions (id, anchor_type, backend_kind, archived, created_at, "
        "updated_at, origin, members_json) VALUES (1, 'general', 'ai-sdk', 0, 1, 1, 'group', ?)",
        (json.dumps(["a1", "a2"]),),
    )
    conn.execute(
        "INSERT INTO ai_chat_sessions (id, anchor_type, backend_kind, archived, created_at, "
        "updated_at) VALUES (2, 'general', 'ai-sdk', 0, 1, 1)"
    )
    conn.commit()
    conn.close()
    return db


@pytest.fixture
def chat_client(monkeypatch: pytest.MonkeyPatch, chat_db_path: Path) -> Iterator[TestClient]:
    from src.api import deps as _deps
    import src.api.routers.chat as _chat_router

    monkeypatch.setattr(_deps, "get_chat_db", lambda: ChatDb(db_path=str(chat_db_path)))
    monkeypatch.setattr(_chat_router, "get_chat_db", lambda: ChatDb(db_path=str(chat_db_path)))
    with TestClient(app) as client:
        yield client


def _get(client: TestClient, **params):
    return client.get("/api/chat/sessions/1/group-turns", params=params)


def test_group_turns_projection_and_order(
    chat_client: TestClient, chat_db_path: Path
) -> None:
    """投影是 camelCase 且新→旧；不含 window_from_id / window_to_id（UI 没有消费点）。"""
    conn = sqlite3.connect(str(chat_db_path))
    _insert_turn(conn, seq=1, started_at=1000, outcome="spoke", message_id=7, model="m",
                 tokens_input=11, tokens_output=22, cost_usd=0.5)
    _insert_turn(conn, seq=2, started_at=2000, agent_id="a2", outcome="skipped",
                 error="monologue", trigger_kind="agent", finished_at=2100)
    _insert_turn(conn, session_id=2, seq=3, started_at=3000)  # 别的会话，不该出现
    conn.commit()
    conn.close()

    data = _get(chat_client).json()["data"]
    assert data["hasMore"] is False
    assert [t["seq"] for t in data["turns"]] == [2, 1]
    newest, oldest = data["turns"]
    assert newest == {
        "id": 2, "runId": "run-1", "chainId": 10, "seq": 2, "agentId": "a2",
        "triggerKind": "agent", "outcome": "skipped", "messageId": None, "model": None,
        "tokensInput": None, "tokensOutput": None, "costUsd": None, "error": "monologue",
        "startedAt": 2000, "finishedAt": 2100,
    }
    assert oldest["messageId"] == 7 and oldest["costUsd"] == 0.5
    assert "window_from_id" not in newest and "windowFromId" not in newest


def test_group_turns_before_pagination_has_more(
    chat_client: TestClient, chat_db_path: Path
) -> None:
    conn = sqlite3.connect(str(chat_db_path))
    for i in range(1, 6):
        _insert_turn(conn, seq=i, started_at=1000 + i)
    conn.commit()
    conn.close()

    first = _get(chat_client, limit=2).json()["data"]
    assert [t["seq"] for t in first["turns"]] == [5, 4]
    assert first["hasMore"] is True

    second = _get(chat_client, limit=2, before=first["turns"][-1]["id"]).json()["data"]
    assert [t["seq"] for t in second["turns"]] == [3, 2]
    assert second["hasMore"] is True

    last = _get(chat_client, limit=2, before=second["turns"][-1]["id"]).json()["data"]
    assert [t["seq"] for t in last["turns"]] == [1]
    assert last["hasMore"] is False


def test_group_turns_limit_clamped_500(chat_db_path: Path) -> None:
    """db 层自己夹 limit（路由的 le=500 是第一道；直接调用 ChatDb 的路径也不该无界扫表）。"""
    conn = sqlite3.connect(str(chat_db_path))
    for i in range(1, 8):
        _insert_turn(conn, seq=i, started_at=1000 + i)
    conn.commit()
    conn.close()
    db = ChatDb(db_path=str(chat_db_path))
    assert len(db.list_group_turns(1, limit=10_000)["turns"]) == 7
    assert len(db.list_group_turns(1, limit=0)["turns"]) == 1  # 下界同样夹住


def test_group_turns_since_filter(chat_client: TestClient, chat_db_path: Path) -> None:
    """``since`` = 最早一条落库消息的时间：清空历史后旧 meta 行不再回到对话里。"""
    conn = sqlite3.connect(str(chat_db_path))
    _insert_turn(conn, seq=1, started_at=1000)
    _insert_turn(conn, seq=2, started_at=2000)
    _insert_turn(conn, seq=3, started_at=3000)
    conn.commit()
    conn.close()

    assert [t["seq"] for t in _get(chat_client, since=2000).json()["data"]["turns"]] == [3, 2]
    assert _get(chat_client, since=9999).json()["data"] == {"turns": [], "hasMore": False}


def test_group_turns_legacy_db_empty(tmp_path: Path) -> None:
    """未迁移的旧库（v31 台账表缺席）→ 空结果，不报错。"""
    db = tmp_path / "old.db"
    conn = sqlite3.connect(str(db))
    conn.executescript(
        "CREATE TABLE ai_chat_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "backend_kind TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);"
    )
    conn.commit()
    conn.close()
    assert ChatDb(db_path=str(db)).list_group_turns(1) == {"turns": [], "hasMore": False}


def test_group_turns_rejects_non_group_session(chat_client: TestClient) -> None:
    assert chat_client.get("/api/chat/sessions/2/group-turns").status_code == 400
    assert chat_client.get("/api/chat/sessions/999/group-turns").status_code == 404
