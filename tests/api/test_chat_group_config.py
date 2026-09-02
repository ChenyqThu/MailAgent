"""群设置端点（g1，CHAT_DB v31）—— ``GET/PUT /api/chat/sessions/{id}/group-config``。

覆盖 design §2.2 的权威校验（校验在服务端，不是 UI 的礼貌提示）：
非群会话 400 / modes 键必须 ∈ members / 响应模式值域 / chainCap 区间 / judge ∈ members 或 null /
judge 变更写 judgeScopeHash，以及 🔴 **两写者列级纪律**：``upsert_group_member_modes`` 的 SQL
语句里不许出现 ``seen_through_id``（整行 UPSERT 会把 gateway 的 seen 游标冲成 NULL —— 模型下一轮
把整段历史当新消息重看一遍，烧 token 且不可见）。

schema 归前端 chat_db.ts owns；本文件的 mirror DDL 含 v31 的三载体。
"""

from __future__ import annotations

import ast
import hashlib
import inspect
import json
import sqlite3
import textwrap
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from src.api.app import app
from src.chat.db import ChatDb

# v7 anchor CHECK + v19 origin + v30 members_json + v31 群三载体（群设置面需要的最小列集）。
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
    members_json TEXT,
    group_config_json TEXT
);
CREATE TABLE ai_chat_group_member (
    session_id INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    response_mode TEXT NOT NULL DEFAULT 'mention'
      CHECK (response_mode IN ('realtime','mention')),
    seen_through_id INTEGER NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, agent_id)
);
"""

_MEMBERS = ["a1", "a2", "a3"]


@pytest.fixture
def chat_db_path(tmp_path: Path) -> Path:
    db = tmp_path / "ai_chat.db"
    conn = sqlite3.connect(str(db))
    conn.executescript(_DDL)
    conn.execute(
        "INSERT INTO ai_chat_sessions (id, email_id, anchor_type, anchor_id, backend_kind, "
        "archived, created_at, updated_at, origin, members_json) "
        "VALUES (1, NULL, 'general', NULL, 'ai-sdk', 0, 1, 1, 'group', ?)",
        (json.dumps(_MEMBERS),),
    )
    # 2 = 普通交互会话（群端点必须拒绝它）。
    conn.execute(
        "INSERT INTO ai_chat_sessions (id, email_id, anchor_type, anchor_id, backend_kind, "
        "archived, created_at, updated_at) VALUES (2, NULL, 'general', NULL, 'ai-sdk', 0, 1, 1)"
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


def _put(client: TestClient, body: dict, session_id: int = 1):
    return client.put(f"/api/chat/sessions/{session_id}/group-config", json=body)


# ── 读面 ────────────────────────────────────────────────────────────────


def test_get_defaults_on_fresh_group(chat_client: TestClient) -> None:
    data = chat_client.get("/api/chat/sessions/1/group-config").json()["data"]
    # 缺行的成员不出现（读侧兜底 'mention'）；config 为「全取出厂默认」。
    assert data["modes"] == {}
    assert data["config"] == {"v": 1}


def test_non_group_session_rejected(chat_client: TestClient) -> None:
    for res in (
        chat_client.get("/api/chat/sessions/2/group-config"),
        _put(chat_client, {"chainCap": 5}, session_id=2),
        chat_client.get("/api/chat/sessions/2/group-metrics"),
    ):
        assert res.status_code == 400
        assert res.json()["error"]["code"] == "E_INVALID_ARG"


def test_unknown_session_404(chat_client: TestClient) -> None:
    res = chat_client.get("/api/chat/sessions/999/group-config")
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "E_NOT_FOUND"


# ── 写面校验 ─────────────────────────────────────────────────────────────


def test_modes_key_must_be_a_member(chat_client: TestClient) -> None:
    res = _put(chat_client, {"modes": {"stranger": "realtime"}})
    assert res.status_code == 400
    assert "not a member" in res.json()["error"]["message"]


def test_response_mode_value_domain(chat_client: TestClient) -> None:
    for bad in ("always", "REALTIME", "", None):
        res = _put(chat_client, {"modes": {"a1": bad}})
        assert res.status_code == 400, f"mode={bad!r} should be rejected"


def test_chain_cap_range(chat_client: TestClient) -> None:
    from src.chat.group_limits import CHAIN_CAP_MAX, CHAIN_CAP_MIN

    assert _put(chat_client, {"chainCap": CHAIN_CAP_MIN}).status_code == 200
    assert _put(chat_client, {"chainCap": CHAIN_CAP_MAX}).status_code == 200
    for bad in (0, -1, CHAIN_CAP_MAX + 1, "12", 1.5, True):
        assert _put(chat_client, {"chainCap": bad}).status_code == 400, f"chainCap={bad!r}"


def test_hourly_budget_validation(chat_client: TestClient) -> None:
    assert _put(chat_client, {"hourlyTurns": 90, "hourlyTokens": 500_000}).status_code == 200
    assert _put(chat_client, {"hourlyUsd": 2.5}).status_code == 200
    assert _put(chat_client, {"hourlyUsd": 0}).status_code == 400
    assert _put(chat_client, {"hourlyTurns": 0}).status_code == 400
    # sessionTurnCap 可显式清空（null = 不设上限），但不接受 0 / 负数。
    assert _put(chat_client, {"sessionTurnCap": None}).status_code == 200
    assert _put(chat_client, {"sessionTurnCap": 120}).status_code == 200
    assert _put(chat_client, {"sessionTurnCap": 0}).status_code == 400


def test_judge_must_be_member_or_null(chat_client: TestClient) -> None:
    assert _put(chat_client, {"judgeAgentId": "stranger"}).status_code == 400
    assert _put(chat_client, {"judgeAgentId": "a2"}).status_code == 200
    assert _put(chat_client, {"judgeAgentId": None}).status_code == 200


def test_judge_change_writes_scope_hash(chat_client: TestClient, chat_db_path: Path) -> None:
    """judge 变更时同步写 judgeScopeHash = sha256(members_json 原文)。

    🔴 hash 钉的是**原文**（owner 确认那一刻看到的名单），不是解析后再序列化的等价形式 ——
    g2 的免卡判据靠它「名单一变就失配」，等价重排也算变。
    """
    data = _put(chat_client, {"judgeAgentId": "a2"}).json()["data"]
    expected = hashlib.sha256(json.dumps(_MEMBERS).encode("utf-8")).hexdigest()
    assert data["config"]["judgeAgentId"] == "a2"
    assert data["config"]["judgeScopeHash"] == expected
    # 清空法官位 → hash 一并清空（没有法官就没有免卡锚）。
    cleared = _put(chat_client, {"judgeAgentId": None}).json()["data"]
    assert cleared["config"]["judgeAgentId"] is None
    assert cleared["config"]["judgeScopeHash"] is None


def test_modes_persist_and_merge_with_config(chat_client: TestClient) -> None:
    _put(chat_client, {"modes": {"a1": "realtime"}, "chainCap": 20})
    data = chat_client.get("/api/chat/sessions/1/group-config").json()["data"]
    assert data["modes"] == {"a1": "realtime"}
    assert data["config"]["chainCap"] == 20
    # 只传 modes 的一次 PUT 不该抹掉之前写的 config（服务端 merge，不整块替换）。
    _put(chat_client, {"modes": {"a2": "mention"}})
    data = chat_client.get("/api/chat/sessions/1/group-config").json()["data"]
    assert data["config"]["chainCap"] == 20
    assert data["modes"] == {"a1": "realtime", "a2": "mention"}


# ── 🔴 两写者列级纪律 ─────────────────────────────────────────────────────


def _statement_source(func) -> str:
    """函数体源码，**剥掉文档串**（纪律写在注释里，断言只看真正会执行的语句）。"""
    tree = ast.parse(textwrap.dedent(inspect.getsource(func)))
    body = tree.body[0].body  # type: ignore[attr-defined]
    stmts = body[1:] if isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) else body
    return "\n".join(ast.unparse(node) for node in stmts)


def test_upsert_statement_never_touches_seen_through_id() -> None:
    """``upsert_group_member_modes`` 的 SQL 文本里不许出现 ``seen_through_id``。

    这一条是**语句文本**断言而不是行为断言，因为违反它的形态（整行 UPSERT）在单写者的测试库上
    行为完全正常 —— 只有生产里 gateway 正在推进游标时才会现形：owner 一改响应模式，全群成员的
    seen 游标被冲成 NULL，下一轮每个成员把整段历史当新消息重看一遍。
    """
    src = _statement_source(ChatDb.upsert_group_member_modes)
    assert "seen_through_id" in inspect.getsource(ChatDb.upsert_group_member_modes), (
        "断言的取材面变了：文档串里本该有这条纪律的说明 —— 若连注释都没了，本用例已经在测空气"
    )
    assert "seen_through_id" not in src, (
        "upsert_group_member_modes 的语句里出现了 seen_through_id —— 那一列归 gateway 写，"
        "serve-api 整行覆写会把成员的 seen 游标冲掉（见 src/chat/db.py 头注的两写者纪律）"
    )


def test_mode_write_preserves_gateway_cursor(chat_client: TestClient, chat_db_path: Path) -> None:
    """行为面的同一条：gateway 已写过游标的成员，被 owner 改响应模式后游标不变。"""
    conn = sqlite3.connect(str(chat_db_path))
    conn.execute(
        "INSERT INTO ai_chat_group_member (session_id, agent_id, response_mode, seen_through_id, "
        "updated_at) VALUES (1, 'a1', 'mention', 42, 1)"
    )
    conn.commit()
    conn.close()

    assert _put(chat_client, {"modes": {"a1": "realtime"}}).status_code == 200

    conn = sqlite3.connect(str(chat_db_path))
    row = conn.execute(
        "SELECT response_mode, seen_through_id FROM ai_chat_group_member "
        "WHERE session_id = 1 AND agent_id = 'a1'"
    ).fetchone()
    conn.close()
    assert row == ("realtime", 42)


def test_old_db_without_v31_carriers_degrades(tmp_path: Path, monkeypatch) -> None:
    """未迁移的旧库（v31 三载体缺席）→ 读面返默认、写面 no-op，不 500。"""
    db = tmp_path / "old.db"
    conn = sqlite3.connect(str(db))
    conn.executescript(
        """
        CREATE TABLE ai_chat_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT, email_id INTEGER, anchor_type TEXT,
            anchor_id INTEGER, backend_kind TEXT NOT NULL, title TEXT,
            archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL, origin TEXT, members_json TEXT);
        """
    )
    conn.execute(
        "INSERT INTO ai_chat_sessions (id, anchor_type, backend_kind, created_at, updated_at, "
        "origin, members_json) VALUES (1, 'general', 'ai-sdk', 1, 1, 'group', '[\"a1\"]')"
    )
    conn.commit()
    conn.close()
    old = ChatDb(db_path=str(db))
    assert old.get_group_config(1) == {"modes": {}, "config": {"v": 1}}
    old.update_group_config(1, {"chainCap": 12})  # no-op, 不抛
    old.upsert_group_member_modes(1, {"a1": "realtime"})  # no-op, 不抛
    assert old.group_metrics(1)["silentRunRate"] is None
