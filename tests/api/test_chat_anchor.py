"""P2c — chat session anchor (email / general) 契约测试。

task 06-18-custom-ai-harness-agent Phase 2。验证 serve-api ``src/chat/db.py`` 的 anchor-aware
读写 + ``/api/chat/sessions(/new|/general)`` 路由 + v7 CHECK 不变式：
  - email session（默认 anchor）逐字节兼容 pre-v7：email_id / anchor_id = internal_id。
  - general session：email_id IS NULL、anchor_type='general'、anchor_id IS NULL（**绝不**用
    emailId=0 sentinel）。
  - general session 绝不漏进某封邮件的 sidebar（list_sessions_for_email）。
  - v7 CHECK 强制 email↔anchor 耦合：违反耦合的直插被 DB 拒。

schema 归前端 chat_db.ts owns（CHAT_DB_VERSION 7），本测试用 mirror 的 v7 DDL（与 test_chat.py
``_AI_CHAT_DDL`` 同源）。auth bypass 默认 ON（conftest）。
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

# v7 ai_chat_sessions schema（mirror chat_db.ts migrate v6→v7：email_id nullable +
# anchor_type/anchor_id + 耦合 CHECK）。
_V7_DDL = """
CREATE TABLE ai_chat_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id INTEGER,
    anchor_type TEXT NOT NULL DEFAULT 'email' CHECK (anchor_type IN ('email','general')),
    anchor_id INTEGER,
    backend_kind TEXT NOT NULL,
    backend_model TEXT,
    backend_agent_page_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
        (anchor_type = 'email' AND anchor_id IS NOT NULL AND email_id IS NOT NULL)
        OR
        (anchor_type = 'general' AND anchor_id IS NULL AND email_id IS NULL)
    )
);
CREATE TABLE ai_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL, content TEXT NOT NULL,
    tokens_input INTEGER, tokens_output INTEGER, cost_usd REAL, model TEXT,
    status TEXT NOT NULL, error_message TEXT, metadata TEXT, thinking TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
"""


@pytest.fixture
def chat_db_path(tmp_path: Path) -> Path:
    db = tmp_path / "ai_chat.db"
    conn = sqlite3.connect(str(db))
    conn.executescript(_V7_DDL)
    conn.commit()
    conn.close()
    return db


@pytest.fixture
def chatdb(chat_db_path: Path) -> ChatDb:
    return ChatDb(db_path=str(chat_db_path))


@pytest.fixture
def chat_client(monkeypatch: pytest.MonkeyPatch, chat_db_path: Path) -> Iterator[TestClient]:
    from src.api import deps as _deps

    monkeypatch.setattr(_deps, "get_chat_db", lambda: ChatDb(db_path=str(chat_db_path)))
    # chat 路由 import 的 get_chat_db 名字绑定也要替（同 test_chat.py 注入手法）。
    import src.api.routers.chat as _chat_router

    monkeypatch.setattr(_chat_router, "get_chat_db", lambda: ChatDb(db_path=str(chat_db_path)))
    with TestClient(app) as client:
        yield client


# ── ChatDb anchor 读写（直接层）──────────────────────────────────────────────


def test_email_anchor_backfills_anchor_columns(chatdb: ChatDb) -> None:
    """email session（默认 anchor）→ anchor_type='email'、anchor_id = email_id。"""
    s = chatdb.get_or_create_session(email_id=4242, backend_kind="custom-api")
    assert s["email_id"] == 4242
    assert s["anchor_type"] == "email"
    assert s["anchor_id"] == 4242


def test_email_anchor_reuse_is_byte_identical(chatdb: ChatDb) -> None:
    """同 (email,kind,page) 复用既有行（pre-v7 语义零回归）。"""
    a = chatdb.get_or_create_session(email_id=10, backend_kind="custom-api")
    b = chatdb.get_or_create_session(email_id=10, backend_kind="custom-api")
    assert a["id"] == b["id"]


def test_general_anchor_has_null_email_no_sentinel(chatdb: ChatDb) -> None:
    """general session → email_id IS NULL、anchor_type='general'、anchor_id IS NULL（无 sentinel）。"""
    s = chatdb.create_new_session(anchor_type="general", backend_kind="custom-api")
    assert s["email_id"] is None
    assert s["anchor_type"] == "general"
    assert s["anchor_id"] is None
    # 读回确认落库（不是仅返回值）。
    got = chatdb.get_session(s["id"])
    assert got is not None
    assert got["email_id"] is None
    assert got["anchor_type"] == "general"


def test_general_get_or_create_reuses_latest(chatdb: ChatDb) -> None:
    """general get_or_create → 复用最近一条 general session（无 anchor_id 去重 → latest 契约）。"""
    first = chatdb.create_new_session(anchor_type="general", backend_kind="custom-api")
    time.sleep(0.005)
    reused = chatdb.get_or_create_session(anchor_type="general", backend_kind="custom-api")
    assert reused["id"] == first["id"]


def test_general_does_not_pollute_email_sidebar(chatdb: ChatDb) -> None:
    """general session 绝不出现在 list_sessions_for_email（按 email_id 查，general 的 email_id 为 NULL）。"""
    email_s = chatdb.get_or_create_session(email_id=77, backend_kind="custom-api")
    gen_s = chatdb.create_new_session(anchor_type="general", backend_kind="custom-api")
    sidebar = chatdb.list_sessions_for_email(77)
    ids = {row["id"] for row in sidebar}
    assert email_s["id"] in ids
    assert gen_s["id"] not in ids
    # 反向：general 列表只含 general。
    general = chatdb.list_general_sessions()
    gids = {row["id"] for row in general}
    assert gen_s["id"] in gids
    assert email_s["id"] not in gids


def test_general_invalid_email_anchor_rejected(chatdb: ChatDb) -> None:
    """email anchor 缺 emailId → _resolve_anchor 抛（defense-in-depth，免插违反 CHECK 的行）。"""
    with pytest.raises(ValueError):
        chatdb.get_or_create_session(backend_kind="custom-api")  # anchor_type='email' 但无 email_id


def test_v7_check_rejects_email_anchor_with_null_email(chat_db_path: Path) -> None:
    """v7 CHECK：email anchor 行 email_id/anchor_id 不能为 NULL（sentinel by-construction 不可达）。"""
    conn = sqlite3.connect(str(chat_db_path))
    now = int(time.time() * 1000)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO ai_chat_sessions "
            "(email_id, anchor_type, anchor_id, backend_kind, created_at, updated_at) "
            "VALUES (NULL, 'email', NULL, 'custom-api', ?, ?)",
            (now, now),
        )
    conn.close()


def test_v7_check_rejects_general_anchor_with_email_sentinel(chat_db_path: Path) -> None:
    """v7 CHECK：general anchor 行不能带 email_id（=0 sentinel 被 DB 直接拒）。"""
    conn = sqlite3.connect(str(chat_db_path))
    now = int(time.time() * 1000)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO ai_chat_sessions "
            "(email_id, anchor_type, anchor_id, backend_kind, created_at, updated_at) "
            "VALUES (0, 'general', 0, 'custom-api', ?, ?)",
            (now, now),
        )
    conn.close()


# ── serve-api 路由（general start/list/reload）─────────────────────────────────


def test_router_open_general_session(chat_client: TestClient) -> None:
    """POST /chat/sessions anchorType='general'（无 emailId）→ 落库 general。"""
    r = chat_client.post(
        "/api/chat/sessions", json={"anchorType": "general", "backendKind": "custom-api"}
    )
    data = r.json()["data"]
    assert data["email_id"] is None
    assert data["anchor_type"] == "general"
    assert data["anchor_id"] is None
    # reload：单读端点取回同一行。
    got = chat_client.get(f"/api/chat/sessions/{data['id']}").json()["data"]
    assert got["anchor_type"] == "general"
    assert got["email_id"] is None


def test_router_general_list_endpoint(chat_client: TestClient) -> None:
    """GET /chat/sessions/general 列出 general，且不与 emailId sidebar 混。"""
    chat_client.post(
        "/api/chat/sessions/new", json={"anchorType": "general", "backendKind": "custom-api"}
    )
    chat_client.post("/api/chat/sessions", json={"emailId": 555, "backendKind": "custom-api"})
    general = chat_client.get("/api/chat/sessions/general").json()["data"]
    assert len(general) == 1
    assert general[0]["anchor_type"] == "general"
    # emailId sidebar 只含 email 行。
    sidebar = chat_client.get("/api/chat/sessions", params={"emailId": 555}).json()["data"]
    assert len(sidebar) == 1
    assert sidebar[0]["email_id"] == 555


def test_router_email_session_still_required_emailid(chat_client: TestClient) -> None:
    """email anchor（默认）仍强制 emailId（缺失 → E_INVALID_ARG），零回归。"""
    err = chat_client.post(
        "/api/chat/sessions", json={"backendKind": "custom-api"}
    ).json()["error"]
    assert err["code"] == "E_INVALID_ARG"


def test_router_rejects_bad_anchor_type(chat_client: TestClient) -> None:
    err = chat_client.post(
        "/api/chat/sessions",
        json={"anchorType": "thread", "backendKind": "custom-api"},
    ).json()["error"]
    assert err["code"] == "E_INVALID_ARG"
