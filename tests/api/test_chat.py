"""serve-api chat router 测试 — /api/chat/* 读端点（V2.1 阶段 2）。

镜像本地 IPC chat:listSessions/listAllSessions/listMessages/listToolCalls/kosAvailable 的
形状 + 鉴权 + graceful（库不存在 → []）。seed tmp ai_chat.db（前端 chat_db.ts v4 schema）+
tmp sync_store.db email_metadata（listAllSessions join）。store 经 monkeypatch 注入端点
（对齐 jobs/reports 直接调模式）。auth bypass 默认 ON（conftest）。
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from src.api.app import app
from src.chat.db import ChatDb

# ai_chat.db schema（端点 SELECT 字段，对齐 chat_db.ts v4）。
_AI_CHAT_DDL = """
CREATE TABLE ai_chat_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id INTEGER NOT NULL,
    backend_kind TEXT NOT NULL,
    backend_model TEXT,
    backend_agent_page_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE ai_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tokens_input INTEGER, tokens_output INTEGER, cost_usd REAL, model TEXT,
    status TEXT NOT NULL, error_message TEXT, metadata TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE chat_tool_call (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    tool_use_id TEXT NOT NULL, tool_name TEXT NOT NULL, input_json TEXT NOT NULL,
    user_edited_input_json TEXT, output_json TEXT, status TEXT NOT NULL,
    duration_ms INTEGER, confirmation_tier TEXT NOT NULL, confirmed_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
"""

EMAIL_ID = 1001
SESSION_ID = 1
MSG_USER_ID = 1
MSG_ASSISTANT_ID = 2


@pytest.fixture
def ai_chat_db(tmp_path: Path) -> Path:
    db = tmp_path / "ai_chat.db"
    now = int(time.time() * 1000)
    conn = sqlite3.connect(str(db))
    conn.executescript(_AI_CHAT_DDL)
    conn.execute(
        "INSERT INTO ai_chat_sessions (id, email_id, backend_kind, backend_model, "
        "backend_agent_page_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
        (SESSION_ID, EMAIL_ID, "custom-api", "claude-sonnet-4-6", None, now, now),
    )
    conn.execute(
        "INSERT INTO ai_chat_messages (id, session_id, role, content, status, created_at, "
        "updated_at) VALUES (?,?,?,?,?,?,?)",
        (MSG_USER_ID, SESSION_ID, "user", "这封邮件讲什么?", "complete", now, now),
    )
    conn.execute(
        "INSERT INTO ai_chat_messages (id, session_id, role, content, status, model, "
        "tokens_input, tokens_output, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (
            MSG_ASSISTANT_ID, SESSION_ID, "assistant", "讲的是 redis timeout.", "complete",
            "claude-sonnet-4-6", 100, 50, now + 1, now + 1,
        ),
    )
    conn.execute(
        "INSERT INTO chat_tool_call (id, message_id, tool_use_id, tool_name, input_json, status, "
        "confirmation_tier, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (1, MSG_ASSISTANT_ID, "toolu_abc", "email_search", '{"query":"redis"}', "ok", "silent", now, now),
    )
    conn.commit()
    conn.close()
    return db


@pytest.fixture
def sync_store_db(tmp_path: Path) -> Path:
    db = tmp_path / "sync_store.db"
    conn = sqlite3.connect(str(db))
    conn.execute(
        "CREATE TABLE email_metadata (internal_id INTEGER PRIMARY KEY, subject TEXT, "
        "sender TEXT, sender_name TEXT)"
    )
    conn.execute(
        "INSERT INTO email_metadata (internal_id, subject, sender, sender_name) VALUES (?,?,?,?)",
        (EMAIL_ID, "Quarterly redis review", "alice@example.com", "Alice"),
    )
    conn.commit()
    conn.close()
    return db


@pytest.fixture
def chat_client(
    ai_chat_db: Path, sync_store_db: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[TestClient]:
    chat_db = ChatDb(str(ai_chat_db))
    monkeypatch.setattr("src.api.routers.chat.get_chat_db", lambda: chat_db)

    class _StubConfig:
        sync_store_db_path = str(sync_store_db)

    monkeypatch.setattr("src.api.routers.chat.get_settings", lambda: _StubConfig())
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


# ── sessions ──────────────────────────────────────────────────────────────


def test_list_sessions(chat_client: TestClient) -> None:
    r = chat_client.get(f"/api/chat/sessions?emailId={EMAIL_ID}")
    assert r.status_code == 200
    data = r.json()["data"]
    assert len(data) == 1
    assert data[0]["id"] == SESSION_ID
    assert data[0]["backend_kind"] == "custom-api"
    assert data[0]["backend_model"] == "claude-sonnet-4-6"


def test_list_sessions_empty(chat_client: TestClient) -> None:
    assert chat_client.get("/api/chat/sessions?emailId=99999").json()["data"] == []


def test_list_sessions_missing_emailid_422(chat_client: TestClient) -> None:
    # 缺必填 emailId → RequestValidationError → E_INVALID_ARG envelope（阶段 1 全局 handler）。
    r = chat_client.get("/api/chat/sessions")
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_list_all_sessions_with_email_join(chat_client: TestClient) -> None:
    """listAllSessions：预览 + message_count + join sync_store.db email subject/sender。"""
    r = chat_client.get("/api/chat/sessions/all")
    assert r.status_code == 200
    data = r.json()["data"]
    assert len(data) == 1
    s = data[0]
    assert s["first_user_message"] == "这封邮件讲什么?"
    assert s["message_count"] == 2
    assert s["email_subject"] == "Quarterly redis review"
    assert s["email_sender"] == "Alice"  # sender_name 优先于 sender


# ── messages ──────────────────────────────────────────────────────────────


def test_list_messages(chat_client: TestClient) -> None:
    r = chat_client.get(f"/api/chat/sessions/{SESSION_ID}/messages")
    assert r.status_code == 200
    data = r.json()["data"]
    assert len(data) == 2
    assert data[0]["role"] == "user"
    assert data[0]["content"] == "这封邮件讲什么?"
    assert data[1]["role"] == "assistant"
    assert data[1]["tokens_input"] == 100
    assert data[1]["tokens_output"] == 50


def test_list_messages_empty(chat_client: TestClient) -> None:
    assert chat_client.get("/api/chat/sessions/99999/messages").json()["data"] == []


# ── tool calls ────────────────────────────────────────────────────────────


def test_list_tool_calls(chat_client: TestClient) -> None:
    r = chat_client.get(f"/api/chat/messages/{MSG_ASSISTANT_ID}/tool-calls")
    assert r.status_code == 200
    data = r.json()["data"]
    assert len(data) == 1
    assert data[0]["tool_name"] == "email_search"
    assert data[0]["status"] == "ok"
    assert data[0]["confirmation_tier"] == "silent"


def test_list_tool_calls_empty(chat_client: TestClient) -> None:
    # user 消息无 tool_use → []
    assert chat_client.get(f"/api/chat/messages/{MSG_USER_ID}/tool-calls").json()["data"] == []


# ── kos-available ─────────────────────────────────────────────────────────


def test_kos_available_false(chat_client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("KOS_MCP_BASE", raising=False)
    monkeypatch.delenv("KOS_OAUTH_CLIENT_ID", raising=False)
    monkeypatch.delenv("KOS_OAUTH_CLIENT_SECRET", raising=False)
    r = chat_client.get("/api/chat/kos-available")
    assert r.status_code == 200
    assert r.json()["data"] is False


def test_kos_available_true(chat_client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KOS_MCP_BASE", "https://kos.example")
    monkeypatch.setenv("KOS_OAUTH_CLIENT_ID", "cid")
    monkeypatch.setenv("KOS_OAUTH_CLIENT_SECRET", "secret")
    assert chat_client.get("/api/chat/kos-available").json()["data"] is True


# ── graceful（库不存在）─────────────────────────────────────────────────────


def test_chat_db_graceful_missing() -> None:
    """ai_chat.db 不存在（全新用户无 chat 历史）→ 读函数返 []（不建空库，对齐前端 handler）。"""
    db = ChatDb("/nonexistent/path/to/ai_chat.db")
    assert db.list_sessions_for_email(1) == []
    assert db.list_all_sessions() == []
    assert db.list_messages(1) == []
    assert db.list_tool_calls_for_message(1) == []
    import os

    assert not os.path.exists("/nonexistent/path/to/ai_chat.db")  # 未被 connect 建空库


# ── codex review finding 1/2：_email_meta_for_sessions ─────────────────────


def test_email_meta_sender_name_empty_preserved(tmp_path: Path) -> None:
    """sender_name='' → 保留 ''（对齐 chat.ts sender_name ?? sender，仅 NULL 回退 sender）。"""
    from src.api.routers.chat import _email_meta_for_sessions

    sync = tmp_path / "sync.db"
    conn = sqlite3.connect(str(sync))
    conn.execute(
        "CREATE TABLE email_metadata (internal_id INTEGER PRIMARY KEY, subject TEXT, "
        "sender TEXT, sender_name TEXT)"
    )
    conn.execute("INSERT INTO email_metadata VALUES (1, 'S', 'bob@x.com', '')")  # 空字符串
    conn.execute("INSERT INTO email_metadata VALUES (2, 'S2', 'carol@x.com', NULL)")  # NULL
    conn.commit()
    conn.close()
    meta = _email_meta_for_sessions([1, 2], str(sync))
    assert meta[1]["sender"] == ""  # 空字符串保留（不回退 sender）
    assert meta[2]["sender"] == "carol@x.com"  # NULL 回退 sender


def test_email_meta_missing_sync_store_no_create(tmp_path: Path) -> None:
    """sync_store.db 不存在 → 返 {} 且不建空库（serve-api 只读，codex finding 1）。"""
    import os

    from src.api.routers.chat import _email_meta_for_sessions

    missing = str(tmp_path / "nonexistent_sync.db")
    assert _email_meta_for_sessions([1, 2], missing) == {}
    assert not os.path.exists(missing)  # 未被 connect 建空库
