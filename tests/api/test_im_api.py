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
- ``POST /credential`` **绝不回显 secret**、flag 门与 ``/pair`` 同档、换应用即解绑
  （open_id 按应用签发，旧绑定在新应用下永远匹配不上）。
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterator, Optional, Tuple

import pytest
from fastapi.testclient import TestClient

from src.api.app import app
from src.api.auth import verify_cf_access, verify_local_token
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


# ── POST /credential ────────────────────────────────────────────────────────
# 🔴 凭证的**落库**语义在 tests/im/test_credentials.py（真 store + tmp 库）；这里只测
# 端点这一层：门、归一、不回显、以及「换应用连坐解绑」的接线。故把 save_credentials
# 换成探针 —— 让本文件永远不去碰真的 agent_config.db / 钥匙串。

#: 🔴 刻意用一串**不含任何英文词**的随机形 token：下面要断言「secret 的片段也不许出现在
#: 响应里」，而 ``...-secret`` 这种人话尾巴会跟 JSON 里正常的键名撞出假红。
SECRET_SENTINEL = "SENTINEL-Zq7Fk2Wv9Xr4Tn8Lb6Yd"

#: ``POST /credential`` 响应的**全部**字段（键集锁死）。
#: 🔴 只断言「完整 secret 不在响应文本里」**挡不住脱敏回显** —— 变异实测：给响应加一个
#: ``app_secret_tail = app_secret[-4:]``，那条断言一个用例都不红。而 docstring 承诺的是
#: 「不回显 secret 的**任何片段**」，所以判据必须是「响应里只能有这几个字段」，新增任何
#: 一个字段都得有人重新想一遍它是不是敏感的。
CREDENTIAL_RESPONSE_KEYS = {
    "credential_present",
    "credential_updated_at",
    "bot_app_id",
    "metadata_app_name",
    "metadata_bot_open_id",
    "app_changed",
    "unbound_from",
    "restart_required",
}


@pytest.fixture()
def save_spy(monkeypatch):
    """``src.im.credentials.save_credentials`` 的探针（handler 内 lazy import，故打模块属性）。

    ``app_changed`` 可写，用来驱动「换了另一个应用」那条分支。
    """
    from src.im import credentials as im_credentials

    calls: list = []

    class _Spy:
        app_changed = False

        def __call__(self, app_id, app_secret, **_kw):
            calls.append((app_id, app_secret))
            return self.app_changed

    spy = _Spy()
    spy.calls = calls  # type: ignore[attr-defined]
    monkeypatch.setattr(im_credentials, "save_credentials", spy)
    return spy


def _route_dependency_calls(path: str, method: str) -> set:
    for route in app.routes:
        if getattr(route, "path", None) == path and method in getattr(route, "methods", ()):
            return {d.call for d in route.dependant.dependencies}
    raise AssertionError(f"route not found: {method} {path}")


def test_credential_route_requires_local_token_not_cf_jwt():
    """🔴 远程 web 不许写凭证 —— 鉴权腿与 ``/pair`` 同款（本地 token，不接受 CF JWT）。

    断言的是**接线本身**：本文件的功能用例在没配本地 token 的测试环境里两种依赖都会放行，
    所以把它换成 ``verify_cf_access`` 一个用例都不会红 —— 而那意味着远程浏览器能换掉本机
    执行通道的身份。
    """
    creds = _route_dependency_calls("/api/im/credential", "POST")
    assert verify_local_token in creds
    assert verify_cf_access not in creds
    # 与 /pair 同档（本仓「写类只认本地」的既有先例）
    assert creds == _route_dependency_calls("/api/im/pair", "POST")


def test_credential_write_never_echoes_the_secret(tmp_path, teardown_overrides, save_spy):
    """🔴 响应里只能有元数据。回显（哪怕片段）= 任何能打开设置页的人都能读回 secret。"""
    client, _state, _db = _client(tmp_path)
    with client:
        resp = client.post(
            "/api/im/credential",
            json={"app_id": "cli_new", "app_secret": SECRET_SENTINEL},
        )
    assert resp.status_code == 200
    assert SECRET_SENTINEL not in resp.text
    data = resp.json()["data"]
    # 🔴 键集锁死 —— 见 CREDENTIAL_RESPONSE_KEYS 的红字（只查完整串挡不住脱敏尾巴）。
    assert set(data) == CREDENTIAL_RESPONSE_KEYS
    # 掩码回显的两种常见形状（尾 N 位 / 头 N 位）也一并钉住，失败信息更直白。
    for frag in (SECRET_SENTINEL[-4:], SECRET_SENTINEL[-8:], SECRET_SENTINEL[:8]):
        assert frag not in resp.text
    # 🔴 恒真：没配凭证时 worker 在 spawn 前就被 gate 拦下，serve-api 起不了它。
    assert data["restart_required"] is True
    assert save_spy.calls == [("cli_new", SECRET_SENTINEL)]


def test_credential_write_strips_surrounding_whitespace(tmp_path, teardown_overrides, save_spy):
    """首尾空白是复制噪音，剔掉（内部空白反而要拒，见下条）。"""
    client, _state, _db = _client(tmp_path)
    with client:
        resp = client.post(
            "/api/im/credential",
            json={"app_id": "  cli_new\n", "app_secret": f" {SECRET_SENTINEL} "},
        )
    assert resp.status_code == 200
    assert save_spy.calls == [("cli_new", SECRET_SENTINEL)]


@pytest.mark.parametrize(
    "body",
    [
        {"app_id": "", "app_secret": SECRET_SENTINEL},
        {"app_id": "cli_new", "app_secret": "   "},
        {"app_id": "cli new", "app_secret": SECRET_SENTINEL},  # 内部空格
        {"app_id": "cli_new", "app_secret": "abc def"},
        {"app_id": "cli_new", "app_secret": "x" * 300},
        {"app_id": "cli　new", "app_secret": SECRET_SENTINEL},  # 全角空格
        {"app_id": "cli new", "app_secret": SECRET_SENTINEL},  # NBSP
        {"app_id": "cli_new", "app_secret": "abc\tdef"},
    ],
)
def test_credential_write_rejects_malformed_values(tmp_path, teardown_overrides, save_spy, body):
    """🔴 内部空白不静默剔除：存进去只会变成几周后一条查不出的 401，当场拒才是能修的。"""
    client, _state, _db = _client(tmp_path)
    with client:
        resp = client.post("/api/im/credential", json=body)
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_INVALID_ARG"
    assert save_spy.calls == []  # 一个字节都没写


@pytest.mark.parametrize(
    "invisible",
    [
        "​",  # 零宽空格（网页控制台复制的头号搭车客）
        "﻿",  # BOM
        "‍",  # ZWJ
        "⁠",  # word joiner
        "­",  # soft hyphen
        "\x1b",  # ESC（控制字符）
    ],
    ids=["zwsp", "bom", "zwj", "word-joiner", "soft-hyphen", "esc"],
)
def test_credential_write_rejects_invisible_characters(
    tmp_path, teardown_overrides, save_spy, invisible
):
    """🔴 这一档**兜不住在 isspace 里** —— 上面那些字符 ``isspace()`` 全是 False，
    ``str.strip()`` 也不动它们。只做「拒内部空白」就会把看不见的原样存进去，做出的恰好
    是那条红字要防的「几周后查不出的 401」。首尾/中间两种位置都得拒（用户都看不见）。
    """
    client, _state, _db = _client(tmp_path)
    with client:
        for app_id in (f"cli{invisible}new", f"{invisible}cli_new", f"cli_new{invisible}"):
            resp = client.post(
                "/api/im/credential",
                json={"app_id": app_id, "app_secret": SECRET_SENTINEL},
            )
            assert resp.status_code == 400, app_id.encode("unicode_escape")
            assert resp.json()["error"]["code"] == "E_INVALID_ARG"
    assert save_spy.calls == []  # 一个字节都没写


def test_credential_write_does_not_forward_downstream_error_text(
    tmp_path, teardown_overrides, save_spy, monkeypatch
):
    """🔴 下游异常消息**不原样转发**给客户端。

    今天 ``set_credential`` 的每条 ValueError 都是固定串，所以直接 ``str(exc)`` 恰好安全
    —— 但那是把「消息里永远不带值」押在别人代码上的隐含前提，没有任何机制保证。这个端点
    的整条纪律是「secret 的任何片段都不出去」，所以这条边界得钉住而不是靠运气。
    """
    from src.im import credentials as im_credentials

    def _boom(*_a, **_k):
        raise ValueError(f"cannot store payload {{'app_secret': {SECRET_SENTINEL!r}}}")

    monkeypatch.setattr(im_credentials, "save_credentials", _boom)
    client, _state, _db = _client(tmp_path)
    with client:
        resp = client.post(
            "/api/im/credential",
            json={"app_id": "cli_new", "app_secret": SECRET_SENTINEL},
        )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_INVALID_ARG"
    assert SECRET_SENTINEL not in resp.text
    for frag in (SECRET_SENTINEL[-4:], SECRET_SENTINEL[-8:], SECRET_SENTINEL[:8]):
        assert frag not in resp.text


def test_credential_write_refuses_when_flag_off(tmp_path, teardown_overrides, save_spy):
    """flag 门与 ``/pair`` 同档：写进去也没有任何进程会去用它。"""
    client, _state, _db = _client(tmp_path, enabled=False)
    with client:
        resp = client.post(
            "/api/im/credential",
            json={"app_id": "cli_new", "app_secret": SECRET_SENTINEL},
        )
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "E_IM_DISABLED"
    assert save_spy.calls == []


def test_credential_write_unbinds_when_app_changed(tmp_path, teardown_overrides, save_spy):
    """🔴 open_id 按**应用**签发：换了自建应用，旧 bound_open_id 在新应用下永远匹配
    不上。留着 = 设置页显示「已绑定」但 bot 永远不理人。顺带清掉 live bot 展示位
    （它同样只在旧应用下成立，且在 status 里优先于凭证行 metadata）。"""
    save_spy.app_changed = True
    client, state, _db = _client(
        tmp_path,
        state_initial={
            STATE_BOUND_OPEN_ID: "ou_owner",
            "im.feishu.bot_app_name": "旧 bot",
        },
    )
    with client:
        data = client.post(
            "/api/im/credential",
            json={"app_id": "cli_other_app", "app_secret": SECRET_SENTINEL},
        ).json()["data"]
    assert data["app_changed"] is True
    assert data["unbound_from"] == "ou_owner"
    assert state.get_bound_open_id() == ""
    assert state.snapshot()["bot_app_name"] == ""


def test_credential_write_keeps_binding_on_secret_rotation(tmp_path, teardown_overrides, save_spy):
    """同一个 app 只换 secret（``app_changed=False``）→ 绑定与 bot 身份原样不动。"""
    save_spy.app_changed = False
    client, state, _db = _client(
        tmp_path,
        state_initial={
            STATE_BOUND_OPEN_ID: "ou_owner",
            "im.feishu.bot_app_name": "MailAgent",
        },
    )
    with client:
        data = client.post(
            "/api/im/credential",
            json={"app_id": "cli_same", "app_secret": SECRET_SENTINEL},
        ).json()["data"]
    assert data["unbound_from"] == ""
    assert state.get_bound_open_id() == "ou_owner"
    assert state.snapshot()["bot_app_name"] == "MailAgent"


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
