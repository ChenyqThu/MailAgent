"""L4 群聊 g2 — 子群写面（``POST /api/chat/sessions/new`` 的 ``parentSessionId`` / ``invokedBy``）。

法官在群里建子群（狼人杀的「狼人夜聊」）走的是**同一条**建群路由：权威校验全在服务端
（红线 5 —— gateway 的建群工厂只是把参数递过来，不复制成员 / 子集 / 嵌套判定）。四类失败
一律 ``E_INVALID_ARG`` + ``hint``：没在 ERROR_CODE_TO_HTTP 登记的码会被 app.py 兜底成 500，
模型收到的就成了「服务器错误」而不是「这几位不在父群里」。

🔴 父会话不存在也是 **400 不是 404**（与 patch_group_members 的口径一致）：
``_require_group_session`` 对缺失 id 抛 404，而「parentSessionId 写错了」是参数错误，
不是「这条路由不存在」。所以本路由**有意不复用**它。

子群数上限（``SUBGROUPS_PER_FAMILY_CAP``）不在这里判 —— 那是法官一轮之内的配额，
只有 gateway 的工厂实例数得清。

fixture（DDL / TestClient / 假 report store）从姊妹文件 import，不重抄一份 schema：
两份 DDL 漂移时，被测的是哪一份就说不清了。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from src.chat.db import ChatDb
from src.chat.group_limits import SESSION_INVOKED_BY

from tests.api.test_chat_group_session import (  # noqa: F401 — pytest fixture 复用
    chat_client,
    chat_db_path,
    chatdb,
)


def _new_session(client: TestClient, **extra) -> object:
    return client.post(
        "/api/chat/sessions/new",
        json={
            "anchorType": "general",
            "emailId": None,
            "backendKind": "ai-sdk",
            **extra,
        },
    )


def _new_group(client: TestClient, members: list, **extra) -> object:
    return _new_session(client, groupMembers=members, **extra)


def _created(res) -> dict:
    assert res.status_code == 200, res.text
    return res.json()["data"]


def _error(res) -> dict:
    assert res.status_code == 400, res.text
    return res.json()["error"]


def _row(db_path: Path, session_id: int) -> tuple:
    conn = sqlite3.connect(str(db_path))
    row = conn.execute(
        "SELECT parent_session_id, invoked_by FROM ai_chat_sessions WHERE id = ?",
        (session_id,),
    ).fetchone()
    conn.close()
    return row


# ── 正例：落库两列 ───────────────────────────────────────────────────────────


def test_subgroup_ok_persists_parent_and_invoked_by(
    chat_client: TestClient, chatdb: ChatDb, chat_db_path: Path
) -> None:
    parent = _created(_new_group(chat_client, ["a3", "a4", "a5"], title="主群"))
    child = _created(
        _new_group(
            chat_client,
            ["a3", "a4"],
            title="狼人夜聊",
            parentSessionId=parent["id"],
            invokedBy="judge",
        )
    )
    assert child["parent_session_id"] == parent["id"]
    assert child["invoked_by"] == "judge"
    # 应答是手工构造的 dict（create_new_session 不回读），所以必须回库核对真落了列。
    assert _row(chat_db_path, child["id"]) == (parent["id"], "judge")
    assert chatdb.get_session(child["id"])["parent_session_id"] == parent["id"]


def test_top_level_group_has_null_parent(chat_client: TestClient, chat_db_path: Path) -> None:
    """不传两键 = 顶级群：两列都是 NULL（`group_create` 建顶级群走的就是这条）。"""
    group = _created(_new_group(chat_client, ["a3"]))
    assert group["parent_session_id"] is None
    assert group["invoked_by"] is None
    assert _row(chat_db_path, group["id"]) == (None, None)


def test_invoked_by_all_vocab_accepted(chat_client: TestClient, chat_db_path: Path) -> None:
    """值域四值各建一个顶级群（invokedBy 不依赖 parentSessionId）。"""
    for value in SESSION_INVOKED_BY:
        group = _created(_new_group(chat_client, ["a3"], invokedBy=value))
        assert _row(chat_db_path, group["id"]) == (None, value)


# ── 反例：四类 400 + hint ────────────────────────────────────────────────────


def test_subgroup_members_not_subset_400_with_hint(chat_client: TestClient) -> None:
    parent = _created(_new_group(chat_client, ["a3", "a4"]))
    err = _error(_new_group(chat_client, ["a3", "a9"], parentSessionId=parent["id"]))
    assert err["code"] == "E_INVALID_ARG"
    assert "子群成员必须都在父群里" in (err.get("hint") or "")
    assert "a9" in err["message"]


def test_parent_not_group_400(chat_client: TestClient) -> None:
    """父是普通会话（origin NULL）→ 400，而不是「按空群处理」。"""
    plain = _created(_new_session(chat_client))
    err = _error(_new_group(chat_client, ["a3"], parentSessionId=plain["id"]))
    assert err["code"] == "E_INVALID_ARG"
    assert "父会话必须是一个群" in (err.get("hint") or "")


def test_parent_missing_400_not_404(chat_client: TestClient) -> None:
    res = _new_group(chat_client, ["a3"], parentSessionId=999)
    assert res.status_code == 400, "父不存在必须是 400（_require_group_session 的 404 口径不适用）"
    assert res.json()["error"]["code"] == "E_INVALID_ARG"


def test_nested_subgroup_400(chat_client: TestClient) -> None:
    """只允许一层嵌套：子群不能再有子群（否则 family 的定义与停止通道全要重写）。"""
    parent = _created(_new_group(chat_client, ["a3", "a4"]))
    child = _created(_new_group(chat_client, ["a3", "a4"], parentSessionId=parent["id"]))
    err = _error(_new_group(chat_client, ["a3"], parentSessionId=child["id"]))
    assert err["code"] == "E_INVALID_ARG"
    assert "只允许一层嵌套" in (err.get("hint") or "")


def test_parent_requires_group_members_400(chat_client: TestClient) -> None:
    parent = _created(_new_group(chat_client, ["a3"]))
    err = _error(_new_session(chat_client, parentSessionId=parent["id"]))
    assert err["code"] == "E_INVALID_ARG"
    assert "只有群会话能有父群" in (err.get("hint") or "")


@pytest.mark.parametrize("value", [True, 0, -1, "3"])
def test_parent_session_id_type_400(chat_client: TestClient, value: object) -> None:
    """``True`` 是 int 的子类 —— 不显式挡 bool，``parentSessionId: true`` 会被当成会话 1。"""
    err = _error(_new_group(chat_client, ["a3"], parentSessionId=value))
    assert err["code"] == "E_INVALID_ARG"


def test_invoked_by_out_of_vocab_400(chat_client: TestClient) -> None:
    err = _error(_new_group(chat_client, ["a3"], invokedBy="hacker"))
    assert err["code"] == "E_INVALID_ARG"
    for value in SESSION_INVOKED_BY:
        assert value in err["message"]


# ── 不许误伤既有两条分支 ─────────────────────────────────────────────────────


def test_team_and_default_insert_unchanged(chat_client: TestClient) -> None:
    """team / 默认分支的 INSERT 与应答字节不变（两个新列**只在 group 分支写**）。"""
    team = _created(_new_session(chat_client, agentId="dms_helper"))
    assert team["origin"] == "team"
    assert "parent_session_id" not in team and "invoked_by" not in team

    plain = _created(_new_session(chat_client))
    assert "origin" not in plain
    assert "parent_session_id" not in plain and "invoked_by" not in plain


def test_delete_parent_orphans_subgroup(
    chat_client: TestClient, chat_db_path: Path
) -> None:
    """既有语义回归（db.delete_session）：删父群 → 子群保留但断链，不是连带删。"""
    parent = _created(_new_group(chat_client, ["a3", "a4"]))
    child = _created(_new_group(chat_client, ["a3"], parentSessionId=parent["id"]))

    assert chat_client.delete(f"/api/chat/sessions/{parent['id']}").status_code == 200

    assert _row(chat_db_path, child["id"]) == (None, None)


# ── 免卡执行口径（db.py count_auto_whitelist_writes）──────────────────────────


_TOOL_CALL_DDL = """
CREATE TABLE chat_tool_call (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES ai_chat_messages(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    approval_status TEXT,
    whitelist_rule_id TEXT,
    confirmed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
"""


def test_card_free_execution_query_counts_new_audit_values(
    chatdb: ChatDb, chat_db_path: Path
) -> None:
    """g2 的两个新审计值同样是「没弹卡就跑了」，必须进免卡计数；人工决定的 'approved' 不进。"""
    session = chatdb.create_new_session(
        anchor_type="general", backend_kind="ai-sdk", group_members=["a3"]
    )
    conn = sqlite3.connect(str(chat_db_path))
    conn.executescript(_TOOL_CALL_DDL)
    cur = conn.execute(
        "INSERT INTO ai_chat_messages (session_id, role, content, status, created_at, updated_at) "
        "VALUES (?, 'assistant', 'x', 'complete', 1, 1)",
        (session["id"],),
    )
    message_id = int(cur.lastrowid)
    for tool, status in (
        ("run_command", "auto_whitelist"),
        ("group_post", "auto_judge_scope"),
        ("group_create", "auto_user_requested_verified"),
        ("email_prepare_send", "approved"),
    ):
        conn.execute(
            "INSERT INTO chat_tool_call (message_id, tool_name, approval_status, "
            "created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
            (message_id, tool, status),
        )
    conn.commit()
    conn.close()

    counts = chatdb.count_auto_whitelist_writes([session["id"]])
    assert counts is not None
    assert counts[session["id"]]["total"] == 3
    assert set(counts[session["id"]]["grant"]) == {
        "run_command",
        "group_post",
        "group_create",
    }
