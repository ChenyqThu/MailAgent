"""L4 群聊（CHAT_DB v30）— 群聊会话写侧契约测试（test_chat_team_session.py 姊妹篇）。

``create_new_session(group_members=…)`` 落 ``origin='group'`` + ``members_json``（恒 general
anchor，与 ``agent_id`` 互斥）；路由 ``POST /api/chat/sessions/new`` 逐成员按
_CHAT_CAPABLE_AGENT_TYPES 校验（不接对话的三位被拒）、上限 5、去重。

过滤面：'group' 行**不进**默认 interactive 列表 / general 列表（宿主是对话域「群聊」tab），
``origin='group'`` 筛选值单独取（词表 + 排除集手抄闸在 tests/config/test_chat_type_mirror_parity.py）。

schema 归前端 chat_db.ts owns；本测试 mirror DDL 含 v30 的 members_json 列。
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

# v7 anchor CHECK + v19 origin + v30 members_json（群聊写面需要的最小列集）。
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
    members_json TEXT,
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
    speaker_agent_id TEXT,
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
            "dms_helper": {"id": "dms_helper", "type": "custom", "enabled": True},
            "daily_email_digest": {"id": "daily_email_digest", "type": "report", "enabled": True},
            "email_preprocess_agent": {
                "id": "email_preprocess_agent",
                "type": "preprocess",
                "enabled": True,
            },
            "a3": {"id": "a3", "type": "custom", "enabled": True},
            "a4": {"id": "a4", "type": "custom", "enabled": True},
            "a5": {"id": "a5", "type": "custom", "enabled": True},
            "a6": {"id": "a6", "type": "custom", "enabled": True},
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


def test_create_new_session_with_group_members_stamps_group_origin(chatdb: ChatDb) -> None:
    s = chatdb.create_new_session(
        anchor_type="general",
        backend_kind="ai-sdk",
        group_members=["dms_helper", "a3"],
        title="新群聊",
    )
    assert s["origin"] == "group"
    assert json.loads(s["members_json"]) == ["dms_helper", "a3"]
    assert s["title"] == "新群聊"
    got = chatdb.get_session(s["id"])
    assert got is not None
    assert got["origin"] == "group"
    assert json.loads(got["members_json"]) == ["dms_helper", "a3"]
    assert got["title"] == "新群聊"


def test_group_rows_excluded_from_general_and_interactive_lists(
    chatdb: ChatDb, chat_db_path: Path
) -> None:
    group = chatdb.create_new_session(
        anchor_type="general", backend_kind="ai-sdk", group_members=["dms_helper"]
    )
    plain = chatdb.create_new_session(anchor_type="general", backend_kind="ai-sdk")
    _seed_message(chat_db_path, group["id"])
    _seed_message(chat_db_path, plain["id"])

    general_ids = {row["id"] for row in chatdb.list_general_sessions()}
    assert plain["id"] in general_ids
    assert group["id"] not in general_ids

    interactive_ids = {row["id"] for row in chatdb.list_all_sessions(origin="interactive")}
    assert plain["id"] in interactive_ids
    assert group["id"] not in interactive_ids

    group_ids = {row["id"] for row in chatdb.list_all_sessions(origin="group")}
    assert group_ids == {group["id"]}


# ── 路由层（服务端逐成员校验，别信前端）──────────────────────────────────────


def _new_group(client: TestClient, members: list, **extra) -> object:
    return client.post(
        "/api/chat/sessions/new",
        json={
            "anchorType": "general",
            "emailId": None,
            "backendKind": "ai-sdk",
            "groupMembers": members,
            **extra,
        },
    )


def test_group_route_creates_with_chat_capable_members(chat_client: TestClient) -> None:
    res = _new_group(chat_client, ["dms_helper", "daily_email_digest"], title="项目群")
    assert res.status_code == 200
    data = res.json()["data"]
    assert data["origin"] == "group"
    assert json.loads(data["members_json"]) == ["dms_helper", "daily_email_digest"]
    assert data["title"] == "项目群"


def test_group_route_rejects_non_chat_capable_member(chat_client: TestClient) -> None:
    """canChat 判据（teamMembers.ts 镜像）：preprocess 不接对话，也不入群。"""
    res = _new_group(chat_client, ["dms_helper", "email_preprocess_agent"])
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "E_INVALID_ARG"


def test_group_route_rejects_unknown_member(chat_client: TestClient) -> None:
    res = _new_group(chat_client, ["no_such_agent"])
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "E_INVALID_ARG"


def test_group_route_rejects_more_than_five_members(chat_client: TestClient) -> None:
    res = _new_group(chat_client, ["dms_helper", "daily_email_digest", "a3", "a4", "a5", "a6"])
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "E_INVALID_ARG"


def test_group_route_rejects_duplicates_and_empty_and_agent_mix(chat_client: TestClient) -> None:
    assert _new_group(chat_client, ["dms_helper", "dms_helper"]).status_code == 400
    assert _new_group(chat_client, []).status_code == 400
    res = _new_group(chat_client, ["dms_helper"], agentId="dms_helper")
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "E_INVALID_ARG"
