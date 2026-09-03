"""L4 群聊话题 T3（CHAT_DB v32）— 两个话题端点 + 分家 / 级联的行为闸。

话题 = 从群里某一条消息开出来的独立上下文子会话（``origin='group'`` + ``parent_session_id``
指父群 + ``invoked_by='thread'``）。它与**子群**在前三列上一模一样，只差 ``invoked_by`` 一个
值 —— 所以本文件的一半用例都在钉「分家判据恒是 invoked_by」：群清单不列话题、删父群时话题
随之消失而子群只断链、``ai_chat_group_member`` 一行都不复制。

🔴 幂等的落库根据是 v32 的**唯一部分索引**，不是端点里那句「先查一下有没有」：两个并发 POST
会同时查空。索引在 ``_DDL``（姊妹文件 test_chat_group_session.py）里原样带着，
``test_root_already_taken_by_a_race_returns_the_winner`` 直接把那个窗口摆出来跑。

fixture（DDL / TestClient / 假 report store）从 test_chat_group_session.py import，不重抄一份
schema：两份 DDL 漂移时，被测的是哪一份就说不清了。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

from src.chat.db import ChatDb
from src.chat.group_limits import THREAD_TITLE_MAX_CHARS

from tests.api.test_chat_group_session import (  # noqa: F401 — pytest fixture 复用
    chat_client,
    chat_db_path,
    chatdb,
)


def _new_group(client: TestClient, members: list, **extra) -> dict:
    res = client.post(
        "/api/chat/sessions/new",
        json={
            "anchorType": "general",
            "emailId": None,
            "backendKind": "ai-sdk",
            "groupMembers": members,
            **extra,
        },
    )
    assert res.status_code == 200, res.text
    return res.json()["data"]


def _seed_message(
    db_path: Path,
    session_id: int,
    *,
    role: str = "user",
    content: str = "hi",
    speaker: str | None = None,
    created_at: int = 1000,
) -> int:
    conn = sqlite3.connect(str(db_path))
    cur = conn.execute(
        "INSERT INTO ai_chat_messages "
        "(session_id, role, content, status, speaker_agent_id, created_at, updated_at) "
        "VALUES (?, ?, ?, 'complete', ?, ?, ?)",
        (session_id, role, content, speaker, created_at, created_at),
    )
    conn.commit()
    message_id = int(cur.lastrowid)
    conn.close()
    return message_id


def _touch(db_path: Path, session_id: int, *, updated_at: int, last_read_at: int | None) -> None:
    """直接摆出「未读」这一对水位（端点不 bump updated_at，测试自己造现场）。"""
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "UPDATE ai_chat_sessions SET updated_at = ?, last_read_at = ? WHERE id = ?",
        (updated_at, last_read_at, session_id),
    )
    conn.commit()
    conn.close()


def _create_thread(client: TestClient, group_id: int, root_message_id: int):
    return client.post(
        f"/api/chat/sessions/{group_id}/threads", json={"rootMessageId": root_message_id}
    )


def _created(res) -> dict:
    assert res.status_code == 200, res.text
    return res.json()["data"]


def _error(res, status: int = 400) -> dict:
    assert res.status_code == status, res.text
    return res.json()["error"]


def _threads(client: TestClient, group_id: int) -> list:
    res = client.get(f"/api/chat/sessions/{group_id}/threads")
    assert res.status_code == 200, res.text
    return res.json()["data"]


# ── 建话题：正例 ─────────────────────────────────────────────────────────────


def test_create_thread_persists_the_thread_shape(
    chat_client: TestClient, chatdb: ChatDb, chat_db_path: Path
) -> None:
    """一次建话题要落齐六件事，缺一件都会在别处静默坏掉。"""
    group = _new_group(chat_client, ["a3", "a4"], title="主群")
    chat_client.put(
        f"/api/chat/sessions/{group['id']}/group-config", json={"chainCap": 7, "topic": "选型"}
    )
    root = _seed_message(chat_db_path, group["id"], role="assistant", content="我来查一下")

    data = _created(_create_thread(chat_client, group["id"], root))
    assert data["rootMessageId"] == root
    assert data["title"] == "我来查一下"

    row = chatdb.get_session(data["sessionId"])
    assert row is not None
    assert row["origin"] == "group"
    assert row["parent_session_id"] == group["id"]
    # 🔴 分家判据：子群与话题只差这一个值。
    assert row["invoked_by"] == "thread"
    assert row["thread_root_message_id"] == root
    # 父群名单快照 + 父群设置副本（话题继承地板与预设，不另开一套设置面）。
    assert row["members_json"] == chatdb.get_session(group["id"])["members_json"]
    assert row["group_config_json"] == chatdb.get_session(group["id"])["group_config_json"]
    assert '"chainCap": 7' in row["group_config_json"]
    # 创建者视角开出来就是已读的（否则「last_read_at IS NOT NULL 才算未读」会让第一条永不亮）。
    assert row["last_read_at"] is not None


def test_create_thread_does_not_copy_group_member_rows(
    chat_client: TestClient, chat_db_path: Path
) -> None:
    """🔴 不复制 ``ai_chat_group_member``：话题内的唤醒是参与者制（gateway 按事实推导），
    复制一份响应模式行 = 父群设的 realtime 在话题里也生效，正是 D2 否掉的那个语义。"""
    group = _new_group(chat_client, ["a3", "a4"])
    chat_client.put(
        f"/api/chat/sessions/{group['id']}/group-config", json={"modes": {"a3": "realtime"}}
    )
    root = _seed_message(chat_db_path, group["id"])
    thread_id = _created(_create_thread(chat_client, group["id"], root))["sessionId"]

    conn = sqlite3.connect(str(chat_db_path))
    rows = conn.execute(
        "SELECT session_id, agent_id FROM ai_chat_group_member ORDER BY session_id"
    ).fetchall()
    conn.close()
    assert rows == [(group["id"], "a3")], f"话题不该有自己的成员模式行: {rows}"
    assert all(r[0] != thread_id for r in rows)


def test_create_thread_is_idempotent_on_the_same_root(
    chat_client: TestClient, chat_db_path: Path
) -> None:
    """同一条根消息重复 POST = 返回已有话题（200，不是 409，也不建第二个）。"""
    group = _new_group(chat_client, ["a3"])
    root = _seed_message(chat_db_path, group["id"])
    first = _created(_create_thread(chat_client, group["id"], root))
    second = _created(_create_thread(chat_client, group["id"], root))
    assert second == first
    assert len(_threads(chat_client, group["id"])) == 1


def test_root_already_taken_by_a_race_returns_the_winner(
    chat_client: TestClient, chatdb: ChatDb, chat_db_path: Path
) -> None:
    """并发窗口：两个 POST 同时查空 → 后到的那个撞唯一部分索引。

    端点必须**回收**自己刚 INSERT 的空壳行并返回先到的那个话题（幂等对并发同样成立）。
    这里用 monkeypatch 把「查已有」压成恒 None，模拟「查的时候还没有、写的时候已经有了」。
    """
    group = _new_group(chat_client, ["a3"])
    root = _seed_message(chat_db_path, group["id"])
    winner = _created(_create_thread(chat_client, group["id"], root))

    real_find = ChatDb.find_thread_by_root
    calls = {"n": 0}

    def _blind_first_call(self, group_id: int, root_message_id: int):
        calls["n"] += 1
        # 第一次（端点的预查）装作没查到；之后（IntegrityError 后的复查）照常。
        return None if calls["n"] == 1 else real_find(self, group_id, root_message_id)

    try:
        ChatDb.find_thread_by_root = _blind_first_call  # type: ignore[method-assign]
        loser = _created(_create_thread(chat_client, group["id"], root))
    finally:
        ChatDb.find_thread_by_root = real_find  # type: ignore[method-assign]
    assert loser["sessionId"] == winner["sessionId"]
    # 空壳行被回收：这个群底下仍然只有一个子会话。
    conn = sqlite3.connect(str(chat_db_path))
    count = conn.execute(
        "SELECT COUNT(*) FROM ai_chat_sessions WHERE parent_session_id = ?", (group["id"],)
    ).fetchone()[0]
    conn.close()
    assert count == 1


def test_title_is_clipped_to_the_limit(chat_client: TestClient, chat_db_path: Path) -> None:
    group = _new_group(chat_client, ["a3"])
    root = _seed_message(chat_db_path, group["id"], content="很长的一段话" * 40)
    data = _created(_create_thread(chat_client, group["id"], root))
    assert len(data["title"]) == THREAD_TITLE_MAX_CHARS


def test_title_folds_whitespace(chat_client: TestClient, chat_db_path: Path) -> None:
    """换行 / 连续空白折成一个空格 —— 卡片是一行，原样带换行会把它撑开。"""
    group = _new_group(chat_client, ["a3"])
    root = _seed_message(chat_db_path, group["id"], content="第一行\n\n  第二行")
    assert _created(_create_thread(chat_client, group["id"], root))["title"] == "第一行 第二行"


# ── 建话题：反例 ─────────────────────────────────────────────────────────────


def test_thread_on_a_subgroup_400(chat_client: TestClient, chat_db_path: Path) -> None:
    """🔴 顶层群限定（单层嵌套不放宽）：子群上开话题 400 + hint。"""
    parent = _new_group(chat_client, ["a3", "a4"])
    child = _new_group(
        chat_client, ["a3"], parentSessionId=parent["id"], invokedBy="judge"
    )
    root = _seed_message(chat_db_path, child["id"])
    err = _error(_create_thread(chat_client, child["id"], root))
    assert err["code"] == "E_INVALID_ARG"
    assert "顶层群" in (err.get("hint") or "")


def test_thread_on_a_thread_400(chat_client: TestClient, chat_db_path: Path) -> None:
    """话题里再开话题也走同一条判据（话题自己就有 parent_session_id）。"""
    group = _new_group(chat_client, ["a3"])
    root = _seed_message(chat_db_path, group["id"])
    thread_id = _created(_create_thread(chat_client, group["id"], root))["sessionId"]
    inner = _seed_message(chat_db_path, thread_id, role="assistant", content="回复")
    err = _error(_create_thread(chat_client, thread_id, inner))
    assert "顶层群" in (err.get("hint") or "")


def test_root_message_from_another_group_400(
    chat_client: TestClient, chat_db_path: Path
) -> None:
    """根消息必须属于该群 —— 否则话题卡会挂到一条这个群里根本没有的消息下面。"""
    group = _new_group(chat_client, ["a3"])
    other = _new_group(chat_client, ["a3"])
    foreign = _seed_message(chat_db_path, other["id"])
    err = _error(_create_thread(chat_client, group["id"], foreign))
    assert err["code"] == "E_INVALID_ARG"
    assert "根消息必须是这个群里的一条消息" in (err.get("hint") or "")
    assert _threads(chat_client, group["id"]) == []


def test_missing_root_message_400(chat_client: TestClient) -> None:
    group = _new_group(chat_client, ["a3"])
    assert _error(_create_thread(chat_client, group["id"], 424242))["code"] == "E_INVALID_ARG"


def test_system_root_message_400(chat_client: TestClient, chat_db_path: Path) -> None:
    """system 行是 group_stop 之类的编排痕迹，不是「谁说了什么」，不能当话题的根。"""
    group = _new_group(chat_client, ["a3"])
    root = _seed_message(chat_db_path, group["id"], role="system", content="已停止")
    assert _error(_create_thread(chat_client, group["id"], root))["code"] == "E_INVALID_ARG"


def test_bad_root_message_id_400(chat_client: TestClient) -> None:
    group = _new_group(chat_client, ["a3"])
    for bad in (None, 0, -1, "12", True, 1.5):
        res = chat_client.post(
            f"/api/chat/sessions/{group['id']}/threads", json={"rootMessageId": bad}
        )
        assert res.status_code == 400, f"rootMessageId={bad!r} 应当 400: {res.text}"


def test_threads_on_a_non_group_session_400_and_missing_404(chat_client: TestClient) -> None:
    """``_require_group_session`` 的两档口径（普通会话 400 / 不存在 404）对两个端点都成立。"""
    plain = chat_client.post(
        "/api/chat/sessions/new",
        json={"anchorType": "general", "emailId": None, "backendKind": "ai-sdk"},
    ).json()["data"]
    assert _error(_create_thread(chat_client, plain["id"], 1))["code"] == "E_INVALID_ARG"
    assert _error(chat_client.get(f"/api/chat/sessions/{plain['id']}/threads"))
    assert chat_client.get("/api/chat/sessions/999999/threads").status_code == 404


# ── 列话题 ───────────────────────────────────────────────────────────────────


def test_list_threads_projects_every_field(
    chat_client: TestClient, chat_db_path: Path
) -> None:
    group = _new_group(chat_client, ["a3", "a4"])
    root = _seed_message(chat_db_path, group["id"], content="选型讨论")
    thread_id = _created(_create_thread(chat_client, group["id"], root))["sessionId"]
    _seed_message(chat_db_path, thread_id, content="我觉得用 A", created_at=2000)
    _seed_message(
        chat_db_path,
        thread_id,
        role="assistant",
        content="B 更稳",
        speaker="a4",
        created_at=3000,
    )
    # system 行不是回复（编排痕迹），不进 replyCount 也不当 lastMessage。
    _seed_message(chat_db_path, thread_id, role="system", content="已停止", created_at=4000)

    items = _threads(chat_client, group["id"])
    assert len(items) == 1
    item = items[0]
    assert item["sessionId"] == thread_id
    assert item["rootMessageId"] == root
    assert item["title"] == "选型讨论"
    assert item["replyCount"] == 2
    assert item["lastMessage"] == {
        "role": "assistant",
        "content": "B 更稳",
        "speakerAgentId": "a4",
        "createdAt": 3000,
    }
    assert item["unread"] is False


def test_list_threads_empty_thread_has_null_last_message(
    chat_client: TestClient, chat_db_path: Path
) -> None:
    """刚开出来的话题：replyCount=0 + lastMessage=null（根消息在父群里，不在话题会话里）。"""
    group = _new_group(chat_client, ["a3"])
    root = _seed_message(chat_db_path, group["id"])
    _create_thread(chat_client, group["id"], root)
    item = _threads(chat_client, group["id"])[0]
    assert item["replyCount"] == 0
    assert item["lastMessage"] is None


def test_list_threads_newest_first(chat_client: TestClient, chat_db_path: Path) -> None:
    group = _new_group(chat_client, ["a3"])
    first = _created(
        _create_thread(chat_client, group["id"], _seed_message(chat_db_path, group["id"]))
    )["sessionId"]
    second = _created(
        _create_thread(chat_client, group["id"], _seed_message(chat_db_path, group["id"]))
    )["sessionId"]
    _touch(chat_db_path, first, updated_at=9_000, last_read_at=9_000)
    _touch(chat_db_path, second, updated_at=8_000, last_read_at=8_000)
    assert [t["sessionId"] for t in _threads(chat_client, group["id"])] == [first, second]


def test_thread_unread_requires_a_read_watermark(
    chat_client: TestClient, chat_db_path: Path
) -> None:
    """unread = ``last_read_at IS NOT NULL`` 且 ``updated_at > last_read_at``。

    「从没打开过」（水位 NULL）不算未读 —— 这条口径和群行完全一致。"""
    group = _new_group(chat_client, ["a3"])
    thread_id = _created(
        _create_thread(chat_client, group["id"], _seed_message(chat_db_path, group["id"]))
    )["sessionId"]

    _touch(chat_db_path, thread_id, updated_at=5_000, last_read_at=4_000)
    assert _threads(chat_client, group["id"])[0]["unread"] is True
    # PATCH /read 把水位推到 now（远大于 updated_at）→ 不再未读。
    assert chat_client.patch(f"/api/chat/sessions/{thread_id}/read").status_code == 200
    assert _threads(chat_client, group["id"])[0]["unread"] is False
    # 从没打开过（水位 NULL）→ 不亮。
    _touch(chat_db_path, thread_id, updated_at=6_000, last_read_at=None)
    assert _threads(chat_client, group["id"])[0]["unread"] is False
    # 边界：水位 == updated_at（读完那一刻的常态，PATCH /read 就是把水位写成 now）→ 不亮。
    # 判据是**严格大于**：写成 >= 会让每个刚读过的话题当场又亮起来。
    _touch(chat_db_path, thread_id, updated_at=7_000, last_read_at=7_000)
    assert _threads(chat_client, group["id"])[0]["unread"] is False


def test_list_threads_only_returns_this_group_and_never_subgroups(
    chat_client: TestClient, chat_db_path: Path
) -> None:
    group = _new_group(chat_client, ["a3", "a4"])
    other = _new_group(chat_client, ["a3"])
    _new_group(chat_client, ["a3"], parentSessionId=group["id"], invokedBy="judge")
    mine = _created(
        _create_thread(chat_client, group["id"], _seed_message(chat_db_path, group["id"]))
    )["sessionId"]
    _create_thread(chat_client, other["id"], _seed_message(chat_db_path, other["id"]))
    assert [t["sessionId"] for t in _threads(chat_client, group["id"])] == [mine]


# ── 分家：群清单 / 删父群 ────────────────────────────────────────────────────


def test_threads_never_enter_the_group_list(
    chat_client: TestClient, chatdb: ChatDb, chat_db_path: Path
) -> None:
    """🔴 变异闸：把 ``list_all_sessions`` 群支的 ``<> 'thread'`` 去掉，本例必红。

    子群仍在群清单里（它是一等会话，进得去、有自己的设置面）—— 被排除的**只有**话题。"""
    group = _new_group(chat_client, ["a3", "a4"])
    child = _new_group(chat_client, ["a3"], parentSessionId=group["id"], invokedBy="judge")
    thread_id = _created(
        _create_thread(chat_client, group["id"], _seed_message(chat_db_path, group["id"]))
    )["sessionId"]

    _seed_message(chat_db_path, thread_id, role="assistant", content="回复", speaker="a3")

    listed = {row["id"] for row in chatdb.list_all_sessions(origin="group")}
    assert group["id"] in listed
    assert child["id"] in listed, "子群不该被这条排除误伤"
    assert thread_id not in listed

    # origin='all'（⌘K 搜索 / 全量列表）**看得见**话题：AI 该搜得到话题里的内容。
    assert thread_id in {row["id"] for row in chatdb.list_all_sessions(origin="all")}


def test_group_row_has_unread_threads_flag(
    chat_client: TestClient, chatdb: ChatDb, chat_db_path: Path
) -> None:
    """群行的派生列：话题里有未读 → True（且是**真 bool**，不是 SQLite 的 1）。

    群行自己的 updated_at 一动不动 —— 不派生这一列，群列表就永远不会因为话题里的回复而亮。"""
    group = _new_group(chat_client, ["a3"])
    thread_id = _created(
        _create_thread(chat_client, group["id"], _seed_message(chat_db_path, group["id"]))
    )["sessionId"]

    def _row() -> dict:
        return next(
            r for r in chatdb.list_all_sessions(origin="group") if r["id"] == group["id"]
        )

    assert _row()["has_unread_threads"] is False
    _touch(chat_db_path, thread_id, updated_at=5_000, last_read_at=4_000)
    assert _row()["has_unread_threads"] is True
    # 从没打开过的话题不亮（与 unread 口径同源）。
    _touch(chat_db_path, thread_id, updated_at=6_000, last_read_at=None)
    assert _row()["has_unread_threads"] is False


def test_deleting_the_group_cascades_threads_but_only_unlinks_subgroups(
    chat_client: TestClient, chatdb: ChatDb, chat_db_path: Path
) -> None:
    """删父群：话题**随之消失**（连同它的消息），子群只断链保留（g2 语义不变）。"""
    group = _new_group(chat_client, ["a3", "a4"])
    child = _new_group(chat_client, ["a3"], parentSessionId=group["id"], invokedBy="judge")
    thread_id = _created(
        _create_thread(chat_client, group["id"], _seed_message(chat_db_path, group["id"]))
    )["sessionId"]
    _seed_message(chat_db_path, thread_id, role="assistant", content="回复", speaker="a3")

    assert chat_client.delete(f"/api/chat/sessions/{group['id']}").status_code == 200
    assert chatdb.get_session(thread_id) is None
    surviving = chatdb.get_session(child["id"])
    assert surviving is not None and surviving["parent_session_id"] is None

    conn = sqlite3.connect(str(chat_db_path))
    left = conn.execute(
        "SELECT COUNT(*) FROM ai_chat_messages WHERE session_id = ?", (thread_id,)
    ).fetchone()[0]
    conn.close()
    assert left == 0, "话题的消息该随 FK CASCADE 一起走"


def test_deleting_a_thread_leaves_the_group_alone(
    chat_client: TestClient, chatdb: ChatDb, chat_db_path: Path
) -> None:
    """反方向：话题删掉不影响父群（也把根消息「有没有话题」重新变成没有 → 可以再开）。"""
    group = _new_group(chat_client, ["a3"])
    root = _seed_message(chat_db_path, group["id"])
    thread_id = _created(_create_thread(chat_client, group["id"], root))["sessionId"]
    assert chat_client.delete(f"/api/chat/sessions/{thread_id}").status_code == 200
    assert chatdb.get_session(group["id"]) is not None
    assert _threads(chat_client, group["id"]) == []
    reopened = _created(_create_thread(chat_client, group["id"], root))
    assert reopened["sessionId"] != thread_id
