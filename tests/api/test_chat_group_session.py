"""L4 群聊（CHAT_DB v30）— 群聊会话写侧契约测试（test_chat_team_session.py 姊妹篇）。

``create_new_session(group_members=…)`` 落 ``origin='group'`` + ``members_json``（恒 general
anchor，与 ``agent_id`` 互斥）；路由 ``POST /api/chat/sessions/new`` 逐成员按
_CHAT_CAPABLE_AGENT_TYPES 校验（不接对话的三位被拒）、上限 MAX_GROUP_MEMBERS（g1 起 8）、去重。

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
from src.chat.group_limits import MAX_GROUP_MEMBERS

# v7 anchor CHECK + v19 origin + v25 父子两列 + v30 members_json（群聊写面需要的最小列集；
# g2 起 create_new_session 的 group 分支写 parent_session_id / invoked_by，两列缺一即 INSERT 炸）。
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
    parent_session_id INTEGER,
    invoked_by TEXT,
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
            "a7": {"id": "a7", "type": "custom", "enabled": True},
            "a8": {"id": "a8", "type": "custom", "enabled": True},
            "a9": {"id": "a9", "type": "custom", "enabled": True},
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


def test_group_route_rejects_more_than_max_members(chat_client: TestClient) -> None:
    """g1 起上限从 5 放宽到 8（狼人杀 = 法官 + 6，父设计拍板 Q5），单源
    ``src.chat.group_limits.MAX_GROUP_MEMBERS``。上限值不在这里硬写 —— 用常量构造刚好越界的
    一组，改常量时本用例自动跟随（改错了由 test_group_constants_parity 抓）。"""
    ok_members = ["dms_helper", "a3", "a4", "a5", "a6", "a7", "a8", "a9"][:MAX_GROUP_MEMBERS]
    assert _new_group(chat_client, ok_members).status_code == 200
    res = _new_group(chat_client, [*ok_members, "daily_email_digest"])
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "E_INVALID_ARG"


def test_group_route_rejects_duplicates_and_empty_and_agent_mix(chat_client: TestClient) -> None:
    assert _new_group(chat_client, ["dms_helper", "dms_helper"]).status_code == 400
    assert _new_group(chat_client, []).status_code == 400
    res = _new_group(chat_client, ["dms_helper"], agentId="dms_helper")
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "E_INVALID_ARG"


# ── 群列表读面（零消息可见 + last_message 预览投影）──────────────────────────


def _insert_message(
    db_path: Path,
    session_id: int,
    role: str,
    content: str,
    created_at: int,
    *,
    status: str = "complete",
    speaker_agent_id: str | None = None,
    metadata: str | None = None,
) -> None:
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "INSERT INTO ai_chat_messages (session_id, role, content, status, speaker_agent_id, "
        "metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (session_id, role, content, status, speaker_agent_id, metadata, created_at, created_at),
    )
    conn.commit()
    conn.close()


def _list_group(client: TestClient) -> list:
    return client.get("/api/chat/sessions/all", params={"origin": "group"}).json()["data"]


def test_group_origin_lists_zero_message_session(
    chatdb: ChatDb, chat_db_path: Path, chat_client: TestClient
) -> None:
    """群是**先建后说话**的：刚建、一条消息都没有的群必须立刻出现在列表里。

    要求「有消息才可见」的话，renderer 只能靠一个本地过渡态假装它在 —— 重启即消失。
    """
    group = chatdb.create_new_session(
        anchor_type="general", backend_kind="ai-sdk", group_members=["dms_helper"]
    )
    assert [row["id"] for row in _list_group(chat_client)] == [group["id"]]
    assert _list_group(chat_client)[0]["last_message"] is None


def test_interactive_origin_still_requires_messages(
    chatdb: ChatDb, chat_db_path: Path, chat_client: TestClient
) -> None:
    """豁免只给 'group'：空壳交互会话（getOrCreateSession 留下的）照旧不进历史。"""
    plain = chatdb.create_new_session(anchor_type="general", backend_kind="ai-sdk")
    ids = [row["id"] for row in chat_client.get("/api/chat/sessions/all").json()["data"]]
    assert plain["id"] not in ids
    _insert_message(chat_db_path, plain["id"], "user", "hi", 100)
    ids = [row["id"] for row in chat_client.get("/api/chat/sessions/all").json()["data"]]
    assert plain["id"] in ids


def test_last_message_projection_latest_user_or_assistant_only(
    chatdb: ChatDb, chat_db_path: Path, chat_client: TestClient
) -> None:
    """预览取最后一条 user/assistant 的 **complete** 行；system 行不算。

    system 行是 group_stop 之类的编排痕迹 —— 让它当预览，群列表第二行就成了「已停止：…」。
    """
    group = chatdb.create_new_session(
        anchor_type="general", backend_kind="ai-sdk", group_members=["dms_helper", "a3"]
    )
    _insert_message(chat_db_path, group["id"], "user", "开工", 100)
    _insert_message(
        chat_db_path, group["id"], "assistant", "收到", 200, speaker_agent_id="dms_helper"
    )
    _insert_message(chat_db_path, group["id"], "system", "已停止：链上限", 300)
    _insert_message(chat_db_path, group["id"], "assistant", "半截", 400, status="streaming")

    last = _list_group(chat_client)[0]["last_message"]
    assert last["content"] == "收到"
    assert last["role"] == "assistant"
    assert last["speaker_agent_id"] == "dms_helper"
    assert last["via"] is None
    assert last["created_at"] == 200


def test_last_message_projection_carries_via(
    chatdb: ChatDb, chat_db_path: Path, chat_client: TestClient
) -> None:
    """主助理投递进群的行是 role='user' + metadata.via='main_agent'。

    只有这一个字段能把它与 owner 自己发的消息分开 —— 少了它，列表预览会把主助理写成「你」。
    """
    delivered = chatdb.create_new_session(
        anchor_type="general", backend_kind="ai-sdk", group_members=["dms_helper"]
    )
    _insert_message(
        chat_db_path,
        delivered["id"],
        "user",
        "帮我问一下排期",
        100,
        metadata=json.dumps({"via": "main_agent", "sourceSessionId": 9}),
    )
    typed = chatdb.create_new_session(
        anchor_type="general", backend_kind="ai-sdk", group_members=["a3"]
    )
    _insert_message(chat_db_path, typed["id"], "user", "我自己说的", 200)

    by_id = {row["id"]: row["last_message"] for row in _list_group(chat_client)}
    assert by_id[delivered["id"]]["via"] == "main_agent"
    assert by_id[typed["id"]]["via"] is None


def test_last_message_null_when_empty(
    chatdb: ChatDb, chat_db_path: Path, chat_client: TestClient
) -> None:
    """只有 system 行的群同样是 None（五列全 None → last_message 整个是 null，不是空对象）。"""
    group = chatdb.create_new_session(
        anchor_type="general", backend_kind="ai-sdk", group_members=["dms_helper"]
    )
    _insert_message(chat_db_path, group["id"], "system", "已停止：你停止了本轮", 100)
    row = _list_group(chat_client)[0]
    assert row["last_message"] is None
    assert "last_message_content" not in row  # 五个原始列不出网


def test_delete_group_unlinks_children(chatdb: ChatDb, chat_db_path: Path) -> None:
    """删父群 → 子群保留但断链（parent_session_id 无 FK，悬空 id 读侧无从解释）。"""
    parent = chatdb.create_new_session(
        anchor_type="general", backend_kind="ai-sdk", group_members=["dms_helper"]
    )
    child = chatdb.create_new_session(
        anchor_type="general", backend_kind="ai-sdk", group_members=["a3"]
    )
    conn = sqlite3.connect(str(chat_db_path))
    conn.execute(
        "UPDATE ai_chat_sessions SET parent_session_id = ? WHERE id = ?", (parent["id"], child["id"])
    )
    conn.commit()
    conn.close()

    chatdb.delete_session(parent["id"])

    conn = sqlite3.connect(str(chat_db_path))
    row = conn.execute(
        "SELECT id, parent_session_id FROM ai_chat_sessions WHERE id = ?", (child["id"],)
    ).fetchone()
    conn.close()
    assert row == (child["id"], None)
