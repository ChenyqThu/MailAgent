"""P4b（task 08-27 标签工作区）— 团队会话写侧契约测试。

「以指定 agent 身份开交互式会话」：``create_new_session(agent_id=…)`` 落
``origin='team'`` + ``agent_id``（CHAT_DB v29 值域登记；恒 general anchor），路由
``POST /api/chat/sessions/new`` 按 teamMembers.ts 的 canChat 同判据校验 agent
（report / contact_profile / contact_governance / custom 四类；服务端不信前端）。

过滤面：'team' 行**不进**默认 interactive 列表 / general 列表（它们属团队页），
``origin='team'`` 筛选值单独取（词表四处手抄 + 排除集 SQL 两侧手抄的闸在
tests/config/test_chat_type_mirror_parity.py）。

schema 归前端 chat_db.ts owns；本测试用含 v19 三列（origin/agent_id/agent_job_id）的
mirror DDL（v7 anchor CHECK + additive 列）。auth bypass 默认 ON（conftest）。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from src.api.app import app
from src.chat.db import ChatDb

# v7 anchor CHECK + v19 origin/agent_id（team 写面需要的最小列集）。
_DDL = """
CREATE TABLE ai_chat_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id INTEGER,
    anchor_type TEXT NOT NULL DEFAULT 'email' CHECK (anchor_type IN ('email','general')),
    anchor_id INTEGER,
    backend_kind TEXT NOT NULL,
    backend_model TEXT,
    backend_agent_page_id TEXT,
    title TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    origin TEXT,
    agent_id TEXT,
    agent_job_id TEXT,
    CHECK (
        (anchor_type = 'email' AND email_id IS NOT NULL AND anchor_id = email_id)
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
    conn.executescript(_DDL)
    conn.commit()
    conn.close()
    return db


@pytest.fixture
def chatdb(chat_db_path: Path) -> ChatDb:
    return ChatDb(db_path=str(chat_db_path))


class _FakeReportStore:
    """get_agent 的最小桩：id → 行 dict（None = 不存在）。"""

    def __init__(self, agents: dict[str, dict]) -> None:
        self._agents = agents

    def get_agent(self, agent_id: str):
        return self._agents.get(agent_id)


@pytest.fixture
def chat_client(monkeypatch: pytest.MonkeyPatch, chat_db_path: Path) -> Iterator[TestClient]:
    from src.api import deps as _deps
    import src.api.routers.chat as _chat_router

    monkeypatch.setattr(_deps, "get_chat_db", lambda: ChatDb(db_path=str(chat_db_path)))
    monkeypatch.setattr(_chat_router, "get_chat_db", lambda: ChatDb(db_path=str(chat_db_path)))
    store = _FakeReportStore(
        {
            "daily_email_digest": {"id": "daily_email_digest", "type": "report", "enabled": True},
            "email_preprocess_agent": {
                "id": "email_preprocess_agent",
                "type": "preprocess",
                "enabled": True,
            },
            "dms_helper": {"id": "dms_helper", "type": "custom", "enabled": True},
        }
    )
    monkeypatch.setattr(_chat_router, "get_report_store", lambda: store)
    with TestClient(app) as client:
        yield client


def _seed_message(chat_db_path: Path, session_id: int) -> None:
    conn = sqlite3.connect(str(chat_db_path))
    conn.execute(
        "INSERT INTO ai_chat_messages (session_id, role, content, status, created_at, updated_at) "
        "VALUES (?, 'user', 'hi', 'complete', 1, 1)",
        (session_id,),
    )
    conn.commit()
    conn.close()


# ── ChatDb 直接层 ────────────────────────────────────────────────────────────


def test_create_new_session_with_agent_stamps_team_origin(chatdb: ChatDb) -> None:
    s = chatdb.create_new_session(
        anchor_type="general", backend_kind="ai-sdk", agent_id="daily_email_digest"
    )
    assert s["origin"] == "team"
    assert s["agent_id"] == "daily_email_digest"
    got = chatdb.get_session(s["id"])
    assert got is not None
    assert got["origin"] == "team"
    assert got["agent_id"] == "daily_email_digest"
    # 无 agent_id 的路径字节级不变（不带 origin）。
    plain = chatdb.create_new_session(anchor_type="general", backend_kind="ai-sdk")
    got_plain = chatdb.get_session(plain["id"])
    assert got_plain is not None
    assert got_plain["origin"] is None


def test_team_rows_excluded_from_general_and_interactive_lists(
    chatdb: ChatDb, chat_db_path: Path
) -> None:
    """🔴 拍板 #5：'team' 行不进主对话历史 / ⌘O 通用列表；origin='team' 筛选值单独取。"""
    team = chatdb.create_new_session(
        anchor_type="general", backend_kind="ai-sdk", agent_id="dms_helper"
    )
    plain = chatdb.create_new_session(anchor_type="general", backend_kind="ai-sdk")
    _seed_message(chat_db_path, team["id"])
    _seed_message(chat_db_path, plain["id"])

    general_ids = {row["id"] for row in chatdb.list_general_sessions()}
    assert plain["id"] in general_ids
    assert team["id"] not in general_ids

    interactive_ids = {row["id"] for row in chatdb.list_all_sessions(origin="interactive")}
    assert plain["id"] in interactive_ids
    assert team["id"] not in interactive_ids

    team_ids = {row["id"] for row in chatdb.list_all_sessions(origin="team")}
    assert team_ids == {team["id"]}


# ── 路由层（服务端校验，别信前端）────────────────────────────────────────────


def test_new_session_route_with_chat_capable_agent(chat_client: TestClient) -> None:
    res = chat_client.post(
        "/api/chat/sessions/new",
        json={"anchorType": "general", "emailId": None, "backendKind": "ai-sdk",
              "agentId": "daily_email_digest"},
    )
    assert res.status_code == 200
    data = res.json()["data"]
    assert data["origin"] == "team"
    assert data["agent_id"] == "daily_email_digest"


def test_new_session_route_rejects_non_chat_capable_agent(chat_client: TestClient) -> None:
    """canChat 判据（teamMembers.ts 镜像）：preprocess 是流水线环节，不接对话。"""
    res = chat_client.post(
        "/api/chat/sessions/new",
        json={"anchorType": "general", "emailId": None, "backendKind": "ai-sdk",
              "agentId": "email_preprocess_agent"},
    )
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "E_INVALID_ARG"


def test_new_session_route_rejects_unknown_agent(chat_client: TestClient) -> None:
    res = chat_client.post(
        "/api/chat/sessions/new",
        json={"anchorType": "general", "emailId": None, "backendKind": "ai-sdk",
              "agentId": "no_such_agent"},
    )
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "E_INVALID_ARG"


def test_new_session_route_rejects_agent_on_non_general_anchor(chat_client: TestClient) -> None:
    """agent 会话恒 general anchor（email/matter 会话没有 agent 身份）。"""
    res = chat_client.post(
        "/api/chat/sessions/new",
        json={"emailId": 42, "backendKind": "ai-sdk", "agentId": "daily_email_digest"},
    )
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "E_INVALID_ARG"
