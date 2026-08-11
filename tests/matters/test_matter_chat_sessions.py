"""P7 收口：事项会话列表走 list_all_sessions，而不是旁路的手写 SQL。

旁路分支让 include_archived / archived / starred / origin / agent_id …… 十个查询参数对
matterId 查询**静默失效**，而且拿不到 first_user_message 预览与 message_count。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.chat.db import ChatDb

SCHEMA = """
CREATE TABLE ai_chat_sessions (
    id TEXT PRIMARY KEY,
    title TEXT,
    email_id INTEGER,
    anchor_type TEXT,
    anchor_id INTEGER,
    origin TEXT DEFAULT 'interactive',
    archived INTEGER NOT NULL DEFAULT 0,
    starred INTEGER NOT NULL DEFAULT 0,
    agent_id TEXT,
    agent_job_id TEXT,
    trigger_id TEXT,
    trigger_kind TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE ai_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    created_at INTEGER NOT NULL
);
"""


@pytest.fixture
def db(tmp_path):
    path = tmp_path / "ai_chat.db"
    with sqlite3.connect(path) as conn:
        conn.executescript(SCHEMA)
        conn.commit()
    return ChatDb(str(path))


def _seed(db: ChatDb, *, session_id: str, matter_id: int, message: str | None = "hello") -> None:
    with sqlite3.connect(db.db_path) as conn:
        conn.execute(
            "INSERT INTO ai_chat_sessions(id,title,anchor_type,anchor_id,created_at,updated_at) "
            "VALUES (?,?,'matter',?,1,1)",
            (session_id, "t", matter_id),
        )
        if message is not None:
            conn.execute(
                "INSERT INTO ai_chat_messages(session_id,role,content,created_at) "
                "VALUES (?,'user',?,1)",
                (session_id, message),
            )
        conn.commit()


def test_matter_filter_returns_only_that_matter(db):
    _seed(db, session_id="s1", matter_id=7, message="about seven")
    _seed(db, session_id="s2", matter_id=9, message="about nine")
    assert [row["id"] for row in db.list_all_sessions(matter_id=7)] == ["s1"]


def test_matter_filter_still_carries_preview_and_counts(db):
    """旁路的 `SELECT *` 拿不到这两样 —— 事项面板的会话行因此没有预览文本。"""
    _seed(db, session_id="s1", matter_id=7, message="about seven")
    row = db.list_all_sessions(matter_id=7)[0]
    assert row["first_user_message"] == "about seven"
    assert row["message_count"] == 1


def test_matter_filter_composes_with_other_filters(db):
    _seed(db, session_id="s1", matter_id=7, message="kept")
    _seed(db, session_id="s2", matter_id=7, message="archived")
    with sqlite3.connect(db.db_path) as conn:
        conn.execute("UPDATE ai_chat_sessions SET archived=1 WHERE id='s2'")
        conn.commit()

    assert [r["id"] for r in db.list_all_sessions(matter_id=7)] == ["s1"]
    assert {r["id"] for r in db.list_all_sessions(matter_id=7, include_archived=True)} == {
        "s1",
        "s2",
    }
    assert [r["id"] for r in db.list_all_sessions(matter_id=7, archived=True)] == ["s2"]


def test_agent_origin_sessions_stay_out_of_the_matter_panel(db):
    """事项面板是交互式对话的历史，headless run 的会话不该混进来。"""
    _seed(db, session_id="s1", matter_id=7, message="interactive")
    _seed(db, session_id="s2", matter_id=7, message="headless")
    with sqlite3.connect(db.db_path) as conn:
        conn.execute("UPDATE ai_chat_sessions SET origin='agent' WHERE id='s2'")
        conn.commit()
    assert [r["id"] for r in db.list_all_sessions(matter_id=7)] == ["s1"]


def test_sessions_without_messages_are_excluded(db):
    _seed(db, session_id="empty", matter_id=7, message=None)
    assert db.list_all_sessions(matter_id=7) == []
