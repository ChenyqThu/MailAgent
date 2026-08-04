"""serve-api IM 投影面 ``/api/im/*``（08-01 阶段 2 PR-4「信任可见」）。

覆盖的是**这一层特有的诚实性纪律**，不是 ``src/im`` 的既有语义（那些在 tests/im）：

- ``GET /status`` **不挂 flag 门**：flag off 时也要 200 并如实说「未启用」——
  整区 409 会让设置页只能显示「加载失败」，正是本 PR 要消灭的那种不可见。
- ``GET /status`` **绝不回显绑定码**（PR-2 ``mailagent im status`` 的同一条纪律，
  回显 = 任何能打开设置页的人都能顶号）。
- ``POST /pair`` **挂** flag 门（409）：flag off 时没有 bot 在收消息，出一个永远兑
  不掉的码是骗人。
- ``POST /pair`` 的 rebind 语义与 CLI 逐字一致（已绑定且未显式 rebind → 拒）。
- ``GET /approvals`` 的 ``available=false`` ≠ 「零条」（账本不可达渲染成 0 = 谎报）。
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterator, Optional, Tuple

import pytest
from fastapi.testclient import TestClient

from src.api.app import app
from src.api.deps import get_chat_db, get_settings
from src.api.routers.im import get_im_state
from src.im.pairing import issue_pair_code
from src.im.state import (
    ImFeishuState,
    STATE_BOUND_OPEN_ID,
    STATE_CONNECTION_STATUS,
    STATUS_CONNECTED,
)


class _FakeStore:
    """``get_state`` / ``set_state`` 的内存替身（``SyncStore`` 的 KV 子集）。"""

    def __init__(self, initial: Optional[dict] = None) -> None:
        self.data = dict(initial or {})

    def get_state(self, key: str) -> Optional[str]:
        return self.data.get(key)

    def set_state(self, key: str, value: str) -> bool:
        self.data[key] = value
        return True


class _FakeChatDb:
    """``ChatDb.list_im_approvals`` 的替身。``rows=None`` = 账本不可达。"""

    def __init__(self, rows) -> None:
        self.rows = rows
        self.calls: list = []

    def list_im_approvals(self, limit: int = 20):
        self.calls.append(limit)
        return self.rows


def _client(
    tmp_path: Path,
    *,
    enabled: bool = True,
    state_initial: Optional[dict] = None,
    approvals=None,
) -> Tuple[TestClient, ImFeishuState, _FakeChatDb]:
    class _Cfg:
        sync_store_db_path = str(tmp_path / "sync_store.db")
        im_feishu_enabled = enabled

    state = ImFeishuState(_FakeStore(state_initial))
    chat_db = _FakeChatDb(approvals)
    app.dependency_overrides[get_settings] = lambda: _Cfg()
    app.dependency_overrides[get_im_state] = lambda: state
    app.dependency_overrides[get_chat_db] = lambda: chat_db
    return TestClient(app, raise_server_exceptions=False), state, chat_db


@pytest.fixture()
def teardown_overrides() -> Iterator[None]:
    yield
    for dep in (get_settings, get_im_state, get_chat_db):
        app.dependency_overrides.pop(dep, None)


# ── GET /status ─────────────────────────────────────────────────────────────


def test_status_reports_disabled_without_409(tmp_path, teardown_overrides):
    """🔴 flag off → 仍 200 + ``enabled=false``。整区 409 = 设置页只能显示「加载失败」。"""
    client, _state, _db = _client(tmp_path, enabled=False)
    with client:
        resp = client.get("/api/im/status")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["enabled"] is False
    assert data["bound_open_id"] == ""


def test_status_projects_state_and_credential_absence(tmp_path, teardown_overrides):
    client, _state, _db = _client(
        tmp_path,
        state_initial={
            STATE_CONNECTION_STATUS: STATUS_CONNECTED,
            STATE_BOUND_OPEN_ID: "ou_owner",
        },
    )
    with client:
        data = client.get("/api/im/status").json()["data"]
    assert data["enabled"] is True
    assert data["connection_status"] == STATUS_CONNECTED
    assert data["bound_open_id"] == "ou_owner"
    # 凭证行不存在（测试库空）→ 如实 false，不是抛错也不是装作有
    assert data["credential_present"] is False


def test_status_never_echoes_the_pair_code(tmp_path, teardown_overrides):
    """🔴 只报「有没有码在等」，绝不回显码本身（CLI status 的同一条纪律）。"""
    client, state, _db = _client(tmp_path)
    code, _expires = issue_pair_code(state)
    with client:
        resp = client.get("/api/im/status")
    body = resp.text
    assert code not in body
    data = resp.json()["data"]
    assert data["pair_code_pending"] is True
    assert data["pair_code_expires_at"] > 0


# ── POST /pair ──────────────────────────────────────────────────────────────


def test_pair_issues_six_digit_code(tmp_path, teardown_overrides):
    client, state, _db = _client(tmp_path)
    with client:
        resp = client.post("/api/im/pair", json={})
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert len(data["code"]) == 6 and data["code"].isdigit()
    assert data["unbound_from"] == ""
    # 真的落库了（下一步 bot 校验读的就是这一行）
    assert state.get("im.feishu.pair_code") == data["code"]


def test_pair_refuses_when_flag_off(tmp_path, teardown_overrides):
    """flag off → 409。没有 bot 在收消息时出码 = 出一个永远兑不掉的码。"""
    client, state, _db = _client(tmp_path, enabled=False)
    with client:
        resp = client.post("/api/im/pair", json={})
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "E_IM_DISABLED"
    assert state.get("im.feishu.pair_code") in (None, "")


def test_pair_refuses_when_already_bound_without_rebind(tmp_path, teardown_overrides):
    """与 CLI 逐字一致：已绑定时不显式 rebind 就拒 —— 否则误操作能顶掉 owner。"""
    client, state, _db = _client(
        tmp_path, state_initial={STATE_BOUND_OPEN_ID: "ou_owner"}
    )
    with client:
        resp = client.post("/api/im/pair", json={})
    assert resp.status_code == 400
    assert state.get_bound_open_id() == "ou_owner"  # 没被悄悄解绑


def test_pair_rebind_unbinds_then_issues(tmp_path, teardown_overrides):
    client, state, _db = _client(
        tmp_path, state_initial={STATE_BOUND_OPEN_ID: "ou_owner"}
    )
    with client:
        resp = client.post("/api/im/pair", json={"rebind": True})
    assert resp.status_code == 200
    assert resp.json()["data"]["unbound_from"] == "ou_owner"
    assert state.get_bound_open_id() == ""


# ── GET /approvals ──────────────────────────────────────────────────────────


def test_approvals_projects_rows(tmp_path, teardown_overrides):
    rows = [
        {
            "tool_name": "email_send",
            "approval_status": "approved",
            "decided_at": 1_750_000_000,
            "session_id": 7,
            "session_title": "飞书会话",
        }
    ]
    client, _state, db = _client(tmp_path, approvals=rows)
    with client:
        data = client.get("/api/im/approvals?limit=5").json()["data"]
    assert data["available"] is True
    assert data["items"] == rows
    assert db.calls == [5]


def test_approvals_unavailable_is_not_zero(tmp_path, teardown_overrides):
    """🔴 ``None``（账本不可达）→ ``available=false``，**不是**空列表。

    把「读不到」渲染成「零条审批」就是谎报 —— 与 ``count_auto_whitelist_writes``
    的 None-vs-空 纪律同源。
    """
    client, _state, _db = _client(tmp_path, approvals=None)
    with client:
        data = client.get("/api/im/approvals").json()["data"]
    assert data["available"] is False
    assert data["items"] == []


def test_approvals_limit_is_clamped(tmp_path, teardown_overrides):
    client, _state, db = _client(tmp_path, approvals=[])
    with client:
        client.get("/api/im/approvals?limit=9999")
    assert db.calls == [100]


# ── ChatDb.list_im_approvals 的真 SQL ────────────────────────────────────────
# 上面的端点用例走的是 ChatDb 替身 —— 它测不出 join 写错 / 列名写错 / 值域筛错。
# 这一节对真 sqlite 跑真 SQL（DDL 只取本查询读到的列，同 tests/api 既有纪律）。

_IM_CHAT_DDL = """
CREATE TABLE ai_chat_sessions (
  id INTEGER PRIMARY KEY, title TEXT, origin TEXT
);
CREATE TABLE ai_chat_messages (
  id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL
);
CREATE TABLE chat_tool_call (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  approval_status TEXT,
  confirmed_at INTEGER,
  updated_at INTEGER NOT NULL
);
"""


def _seed_chat_db(tmp_path: Path, rows) -> str:
    """rows = [(origin, tool_name, approval_status, confirmed_at, updated_at)]。"""
    import sqlite3

    p = tmp_path / "ai_chat.db"
    conn = sqlite3.connect(str(p))
    conn.executescript(_IM_CHAT_DDL)
    for i, (origin, tool, status, confirmed, updated) in enumerate(rows, start=1):
        conn.execute(
            "INSERT INTO ai_chat_sessions (id, title, origin) VALUES (?, ?, ?)",
            (i, f"会话{i}", origin),
        )
        conn.execute(
            "INSERT INTO ai_chat_messages (id, session_id) VALUES (?, ?)", (i, i)
        )
        conn.execute(
            "INSERT INTO chat_tool_call (message_id, tool_name, approval_status, "
            "confirmed_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (i, tool, status, confirmed, updated),
        )
    conn.commit()
    conn.close()
    return str(p)


def test_list_im_approvals_filters_origin_and_human_decisions(tmp_path):
    """🔴 两条筛选缺一不可：``origin='im'`` + 只认真人决定的三个值。

    四个 ``auto_*`` 是**免卡执行**的审计位；把它们混进「批过哪些操作」= 谎报有人批过。
    桌面会话（origin=NULL）更不该出现在飞书面板里。
    """
    from src.chat.db import ChatDb

    path = _seed_chat_db(
        tmp_path,
        [
            ("im", "email_send", "approved", 300, 300),
            ("im", "email_archive", "rejected", 200, 200),
            ("im", "web_fetch", "auto_whitelist", 250, 250),  # 免卡 → 不算
            ("im", "email_list", None, None, 240),  # read 类 → 不算
            ("interactive", "email_send", "approved", 400, 400),  # 桌面会话 → 不算
            ("agent", "email_send", "approved", 500, 500),  # headless → 不算
        ],
    )
    rows = ChatDb(db_path=path).list_im_approvals(10)
    assert rows is not None
    assert [(r["tool_name"], r["approval_status"]) for r in rows] == [
        ("email_send", "approved"),
        ("email_archive", "rejected"),
    ]
    assert rows[0]["decided_at"] == 300  # 倒序：新的在前


def test_list_im_approvals_falls_back_to_updated_at(tmp_path):
    """``confirmed_at`` 为空的行不能整行消失 —— COALESCE 到 ``updated_at``。"""
    from src.chat.db import ChatDb

    path = _seed_chat_db(tmp_path, [("im", "email_send", "approved", None, 777)])
    rows = ChatDb(db_path=path).list_im_approvals(10)
    assert rows is not None and len(rows) == 1
    assert rows[0]["decided_at"] == 777


def test_list_im_approvals_missing_db_is_none_not_empty(tmp_path):
    """🔴 库不存在 → None（「读不到」），**不是** []（「零条」）。"""
    from src.chat.db import ChatDb

    assert ChatDb(db_path=str(tmp_path / "nope.db")).list_im_approvals() is None


def test_list_im_approvals_uninitialized_tables_is_none(tmp_path):
    """库在但表没建（前端首启前）→ 同样 None，不是空列表。"""
    import sqlite3

    from src.chat.db import ChatDb

    p = tmp_path / "ai_chat.db"
    sqlite3.connect(str(p)).close()
    assert ChatDb(db_path=str(p)).list_im_approvals() is None
