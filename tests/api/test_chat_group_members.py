"""群成员写面 —— ``PATCH /api/chat/sessions/{id}/group-members``（加人 / 踢人）。

覆盖 design §2.2 的六条校验（权威在服务端，不是 UI 的礼貌提示）：非群会话 / 非 chat-capable /
重复 / 不在群里 / 空群 / 超上限，**全部 E_INVALID_ARG + hint**（没在 ERROR_CODE_TO_HTTP 登记的
码会被 app.py 兜底成 500 —— UI 拿到的就成了「服务器错误」而不是「这个人已经在群里了」）。

外加两条与 gateway 的交界：
  • 踢人删 ``ai_chat_group_member`` 整行（模式 + 游标一起消失）；
  • 🔴 **add 时也删行** —— gateway 的 ``advanceSeenCursor`` 是 INSERT OR IGNORE，在「取出队列项
    → 复核 → speak → 推游标」这段秒级窗口里被踢的成员会把行重建回来并带上推进后的游标；
    只删 remove 的话「踢掉 → 加回」之间的残留游标会让重新入群的成员错过中间历史。

schema 归前端 chat_db.ts owns；本文件的 mirror DDL 含 v31 的两载体。
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
from src.chat.group_limits import MAX_GROUP_MEMBERS

# v7 anchor CHECK + v19 origin + v30 members_json + v31 群两载体（成员写面需要的最小列集）。
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
_SEEDED_AT = 4242


class _FakeReportStore:
    """a1..a12 = 可对话的 custom agent；``preprocess`` 不接对话（canChat 判据的反例）。"""

    def get_agent(self, agent_id: str):
        if agent_id == "preprocess":
            return {"id": agent_id, "type": "preprocess", "enabled": True}
        if agent_id.startswith("a") and agent_id[1:].isdigit():
            return {"id": agent_id, "type": "custom", "enabled": True}
        return None


@pytest.fixture
def chat_db_path(tmp_path: Path) -> Path:
    db = tmp_path / "ai_chat.db"
    conn = sqlite3.connect(str(db))
    conn.executescript(_DDL)
    conn.execute(
        "INSERT INTO ai_chat_sessions (id, email_id, anchor_type, anchor_id, backend_kind, "
        "archived, created_at, updated_at, origin, members_json) "
        "VALUES (1, NULL, 'general', NULL, 'ai-sdk', 0, 1, ?, 'group', ?)",
        (_SEEDED_AT, json.dumps(_MEMBERS)),
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
    monkeypatch.setattr(_chat_router, "get_report_store", lambda: _FakeReportStore())
    with TestClient(app) as client:
        yield client


def _patch(client: TestClient, body: dict, session_id: int = 1):
    return client.patch(f"/api/chat/sessions/{session_id}/group-members", json=body)


def _members(client: TestClient, session_id: int = 1) -> list:
    return client.get(f"/api/chat/sessions/{session_id}/group-config").json()["data"]["members"]


def _member_row(db_path: Path, agent_id: str):
    conn = sqlite3.connect(str(db_path))
    row = conn.execute(
        "SELECT response_mode, seen_through_id FROM ai_chat_group_member "
        "WHERE session_id = 1 AND agent_id = ?",
        (agent_id,),
    ).fetchone()
    conn.close()
    return row


def _seed_member_row(db_path: Path, agent_id: str, seen_through_id: int) -> None:
    """模拟 gateway 侧已有的成员行（含它独占的 seen 游标列）。"""
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "INSERT OR REPLACE INTO ai_chat_group_member (session_id, agent_id, response_mode, "
        "seen_through_id, updated_at) VALUES (1, ?, 'realtime', ?, 1)",
        (agent_id, seen_through_id),
    )
    conn.commit()
    conn.close()


# ── 加人 ─────────────────────────────────────────────────────────────────


def test_add_member_appends_in_order(chat_client: TestClient) -> None:
    """新成员 append 到名单尾部 —— 成员序 = 无 @ 时的回复序，加人不该打乱既有顺序。"""
    data = _patch(chat_client, {"add": ["a9", "a7"]}).json()["data"]
    assert data["members"] == ["a1", "a2", "a3", "a9", "a7"]
    assert _members(chat_client) == ["a1", "a2", "a3", "a9", "a7"]


def test_add_non_chat_capable_400(chat_client: TestClient) -> None:
    """canChat 判据（teamMembers.ts 镜像）：preprocess 不接对话，也不入群。"""
    res = _patch(chat_client, {"add": ["preprocess"]})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "E_INVALID_ARG"
    assert _members(chat_client) == _MEMBERS  # 拒绝 = 名单一个字节没动

    unknown = _patch(chat_client, {"add": ["no_such_agent"]})
    assert unknown.status_code == 400
    assert unknown.json()["error"]["code"] == "E_INVALID_ARG"


def test_add_duplicate_400_invalid_arg_with_hint(chat_client: TestClient) -> None:
    res = _patch(chat_client, {"add": ["a2"]})
    assert res.status_code == 400
    err = res.json()["error"]
    assert err["code"] == "E_INVALID_ARG"
    assert err["hint"]  # UI 显示的是 hint，没有 hint 就只能说「参数错误」
    # 同一次请求里重复也拒（否则 members_json 里会出现两个同 id）。
    dup = _patch(chat_client, {"add": ["a9", "a9"]})
    assert dup.status_code == 400
    assert dup.json()["error"]["hint"]
    assert _members(chat_client) == _MEMBERS


def test_add_over_max_400_invalid_arg_with_hint(chat_client: TestClient) -> None:
    """上限值不在这里硬写：用 MAX_GROUP_MEMBERS 构造刚好越界的一组。"""
    room = MAX_GROUP_MEMBERS - len(_MEMBERS)
    fill = [f"a{i}" for i in range(4, 4 + room)]
    assert _patch(chat_client, {"add": fill}).status_code == 200
    res = _patch(chat_client, {"add": ["a99"]})
    assert res.status_code == 400
    err = res.json()["error"]
    assert err["code"] == "E_INVALID_ARG"
    assert str(MAX_GROUP_MEMBERS) in err["hint"]


# ── 踢人 ─────────────────────────────────────────────────────────────────


def test_remove_last_member_400(chat_client: TestClient) -> None:
    """空群拒：没有成员的群谁都唤不醒，只会静默不回 —— 不要这个群就整个删掉。"""
    res = _patch(chat_client, {"remove": _MEMBERS})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "E_INVALID_ARG"
    assert _members(chat_client) == _MEMBERS


def test_remove_not_member_400(chat_client: TestClient) -> None:
    res = _patch(chat_client, {"remove": ["a9"]})
    assert res.status_code == 400
    assert res.json()["error"]["hint"]
    assert _members(chat_client) == _MEMBERS


def test_remove_deletes_group_member_row(
    chat_client: TestClient, chat_db_path: Path
) -> None:
    """踢人删整行：response_mode 与 seen_through_id 一起消失（不是列级覆写）。"""
    _seed_member_row(chat_db_path, "a2", 42)
    assert _member_row(chat_db_path, "a2") == ("realtime", 42)

    assert _patch(chat_client, {"remove": ["a2"]}).status_code == 200
    assert _members(chat_client) == ["a1", "a3"]
    assert _member_row(chat_db_path, "a2") is None
    # 只删被踢的那一行 —— 留在群里的成员的游标一个字节没动。
    _seed_member_row(chat_db_path, "a1", 7)
    assert _patch(chat_client, {"remove": ["a3"]}).status_code == 200
    assert _member_row(chat_db_path, "a1") == ("realtime", 7)


def test_add_back_member_clears_stale_cursor_row(
    chat_client: TestClient, chat_db_path: Path
) -> None:
    """🔴 「踢掉 → gateway 重建行 → 加回」之后不许有残留游标。

    重建那一步就是生产里真实发生的事：``advanceSeenCursor`` 的 INSERT OR IGNORE 在 serve-api
    删完行之后跑（取出队列项与推游标之间隔着一次 LLM 调用）。add 时不再删一次的话，重新入群的
    成员会带着旧游标开工 —— 它错过的中间历史被判成「不新鲜」，永远不会进它的窗口。
    """
    _seed_member_row(chat_db_path, "a2", 42)
    assert _patch(chat_client, {"remove": ["a2"]}).status_code == 200
    assert _member_row(chat_db_path, "a2") is None
    _seed_member_row(chat_db_path, "a2", 99)  # gateway 在窗口里把行重建回来

    assert _patch(chat_client, {"add": ["a2"]}).status_code == 200
    assert _members(chat_client) == ["a1", "a3", "a2"]
    assert _member_row(chat_db_path, "a2") is None


# ── 法官位 ───────────────────────────────────────────────────────────────


def _put_config(client: TestClient, body: dict):
    return client.put("/api/chat/sessions/1/group-config", json=body)


def test_remove_judge_clears_judge_and_hash(chat_client: TestClient) -> None:
    """踢掉法官 → judgeAgentId 与 judgeScopeHash 一并清空（没有法官就没有免卡锚）。"""
    assert _put_config(chat_client, {"judgeAgentId": "a2"}).status_code == 200
    data = _patch(chat_client, {"remove": ["a2"]}).json()["data"]
    assert data["config"]["judgeAgentId"] is None
    assert data["config"]["judgeScopeHash"] is None
    assert data["judgeScopeStale"] is False  # 没有法官位 = 无所谓失配


def test_remove_keeps_hash_when_not_judge_and_stale_true(chat_client: TestClient) -> None:
    """踢的不是法官 → hash **不动**，于是自然失配 = judgeScopeStale（提示重新确认）。"""
    before = _put_config(chat_client, {"judgeAgentId": "a1"}).json()["data"]
    assert before["judgeScopeStale"] is False
    hashed = before["config"]["judgeScopeHash"]

    data = _patch(chat_client, {"remove": ["a3"]}).json()["data"]
    assert data["config"]["judgeAgentId"] == "a1"
    assert data["config"]["judgeScopeHash"] == hashed
    assert data["judgeScopeStale"] is True
    assert hashed != hashlib.sha256(json.dumps(["a1", "a2"]).encode("utf-8")).hexdigest()


# ── 其它契约 ─────────────────────────────────────────────────────────────


def test_non_group_session_400(chat_client: TestClient) -> None:
    res = _patch(chat_client, {"add": ["a9"]}, session_id=2)
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "E_INVALID_ARG"
    assert _patch(chat_client, {"add": ["a9"]}, session_id=999).status_code == 404


def test_empty_and_overlapping_patch_rejected(chat_client: TestClient) -> None:
    for body in ({}, {"add": [], "remove": []}, {"add": ["a9"], "remove": ["a9"]}):
        res = _patch(chat_client, body)
        assert res.status_code == 400, f"body={body!r} should be rejected"
        assert res.json()["error"]["code"] == "E_INVALID_ARG"
    for bad in ("a9", [1], [""], [None]):
        assert _patch(chat_client, {"add": bad}).status_code == 400, f"add={bad!r}"


def test_does_not_bump_updated_at(chat_client: TestClient, chat_db_path: Path) -> None:
    """改名单不该把群顶到列表最前（同 title / 设置纪律）。"""
    assert _patch(chat_client, {"add": ["a9"]}).status_code == 200
    conn = sqlite3.connect(str(chat_db_path))
    row = conn.execute("SELECT updated_at FROM ai_chat_sessions WHERE id = 1").fetchone()
    conn.close()
    assert row[0] == _SEEDED_AT


def _statement_source(func) -> str:
    """函数体源码，**剥掉文档串**（纪律写在注释里，断言只看真正会执行的语句）。
    与 test_chat_group_config.py 的同名助手同形 —— 那边钉 upsert，这边钉 delete。"""
    tree = ast.parse(textwrap.dedent(inspect.getsource(func)))
    body = tree.body[0].body  # type: ignore[attr-defined]
    stmts = (
        body[1:]
        if isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant)
        else body
    )
    return "\n".join(ast.unparse(node) for node in stmts)


def test_update_group_members_sql_has_no_column_literals() -> None:
    """``update_group_members`` 的语句里不许出现 ``seen_through_id`` / ``response_mode``。

    行级 DELETE 是合规的（不再是成员 ⇒ 两列一起消失）；一旦有人把它写成「UPDATE ... SET
    seen_through_id = NULL」之类的列级写法，就是 serve-api 伸手动了 gateway 独占的列 ——
    那种形态在单写者的测试库上行为完全正常，只有生产里调度器正在推游标时才现形。
    """
    full = inspect.getsource(ChatDb.update_group_members)
    assert "seen_through_id" in full and "response_mode" in full, (
        "断言的取材面变了：文档串里本该说明这条纪律 —— 连注释都没了的话本用例已经在测空气"
    )
    src = _statement_source(ChatDb.update_group_members)
    for column in ("seen_through_id", "response_mode"):
        assert column not in src, (
            f"update_group_members 的语句里出现了 {column} —— 成员写面只该整行 DELETE，"
            "碰列就会冲掉另一个写者的值（见 src/chat/db.py 头注的两写者纪律）"
        )
