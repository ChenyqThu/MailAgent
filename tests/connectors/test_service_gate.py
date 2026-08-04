"""connector invoke 的**单源闸序**单测（08-01 PR3 T3）—— 纯函数 + 闸的排序/短路。

HTTP 面的端到端在 ``tests/api/test_connector_api.py``；这里钉的是 service 层本身：
天花板序、caller 解析、以及「闸拒时绝不建 client / 绝不到远端」。
"""

from __future__ import annotations

import asyncio

import pytest

from src.agent_config.store import AgentConfigStore
from src.connectors import service as svc

CID = "notion"


def _manifest(*names_cruds):
    return [
        {"name": n, "description": "", "input_schema": None, "output_schema": None,
         "crud_type": c}
        for n, c in names_cruds
    ]


@pytest.fixture()
def store(tmp_path, monkeypatch):
    st = AgentConfigStore(str(tmp_path / "agent_config.db"))
    st.upsert_connector(CID, server_url="https://mcp.notion.com/mcp")
    st.update_connector_state(CID, status="connected")
    st.sync_connector_tools(
        CID,
        _manifest(("search", "read"), ("create_page", "write"), ("delete_page", "delete")),
    )
    monkeypatch.setattr("src.agent_config.store.get_agent_config_store", lambda: st)
    return st


class _NeverCalledClient:
    def __init__(self, *_a, **_k):
        raise AssertionError("gate must reject before a client is built")


class _OkClient:
    calls: list = []

    def __init__(self, connector_id, **_k):
        self.connector_id = connector_id

    async def call_tool(self, tool_name, arguments=None, **_k):
        type(self).calls.append((self.connector_id, tool_name, arguments))
        return {"content": "c", "is_error": False, "truncated": False}


# ── 天花板序（纯函数，穷举）────────────────────────────────────────────────────


def test_ceiling_rank_is_monotonic():
    assert svc.CONNECTOR_CRUD_RANK == {"read": 1, "write": 2, "update": 3}
    for crud, ceiling, expected in [
        ("read", "read", True), ("write", "read", False), ("update", "read", False),
        ("read", "write", True), ("write", "write", True), ("update", "write", False),
        ("read", "update", True), ("write", "update", True), ("update", "update", True),
    ]:
        assert svc.ceiling_allows(crud, ceiling) is expected, (crud, ceiling)


def test_ceiling_none_means_no_gate_and_bad_values_fail_closed():
    assert svc.ceiling_allows("update", None) is True  # owner 面：无天花板
    # 🔴 delete 既不是合法 crud 天花板、也不是可放行的 crud —— 双向 fail-closed。
    assert svc.ceiling_allows("delete", "update") is False
    assert svc.ceiling_allows("read", "delete") is False
    assert svc.ceiling_allows("read", "admin") is False


# ── caller 解析 ────────────────────────────────────────────────────────────────


def test_resolve_caller_absent_or_manual_has_no_ceiling():
    assert svc.resolve_caller_ceiling(None, CID) is None
    assert svc.resolve_caller_ceiling({"context_mode": "manual_chat"}, CID) is None


def test_resolve_caller_im_chat_always_denied():
    with pytest.raises(svc.ConnectorInvokeDenied) as e:
        svc.resolve_caller_ceiling({"context_mode": "im_chat", "agent_id": "a"}, CID)
    assert e.value.code == "E_CONNECTOR_GRANT_DENIED" and e.value.http_status == 403


def test_resolve_caller_bad_shape_is_400():
    for bad in ({"context_mode": "nope"}, {}, "manual_chat", 7):
        with pytest.raises(svc.ConnectorInvokeDenied) as e:
            svc.resolve_caller_ceiling(bad, CID)
        assert e.value.http_status == 400, bad


def test_load_agent_row_reads_the_real_report_store_db(tmp_path, monkeypatch):
    """🔴 接缝本体（其余用例都 monkeypatch 掉它）：``_load_agent_row`` 真的从
    ``config.sync_store_db_path`` 的 ``report_agent`` 表读行 —— 与 headless run / serve-api
    的 ``get_report_store`` 同库同口径。这里坏掉的表现是「headless connector 调用全 403」，
    功能整条死掉但安全方向不变，所以没有别的测试会替它红。"""
    import json

    from src.config import config as settings
    from src.mail.sync_store import SyncStore
    from src.reports.store import ReportStore

    db = tmp_path / "sync_store.db"
    SyncStore(str(db))  # 建表 + migration（report_agent 在这里落地）
    store = ReportStore(str(db))
    store.create_agent("cust_real", type="custom", title="R", enabled=True)
    store.update_agent(
        "cust_real",
        {"tool_policy_json": json.dumps({"v": 1, "grant_connectors": {"notion": "update"}})},
    )
    monkeypatch.setattr(settings, "sync_store_db_path", str(db))

    assert svc.connector_grants_for_agent("cust_real") == {"notion": "update"}
    assert svc.connector_grants_for_agent("nope") == {}  # 无行 → 无授权（fail-closed）
    assert (
        svc.resolve_caller_ceiling(
            {"context_mode": "cron_headless", "agent_id": "cust_real"}, CID
        )
        == "update"
    )


def test_resolve_caller_headless_reads_agent_grants(monkeypatch):
    import json

    monkeypatch.setattr(
        svc, "_load_agent_row",
        lambda aid: {"tool_policy_json": json.dumps(
            {"v": 1, "grant_connectors": {"notion": "write"}}
        )} if aid == "a1" else None,
    )
    caller = {"context_mode": "cron_headless", "agent_id": "a1"}
    assert svc.resolve_caller_ceiling(caller, CID) == "write"
    # 别的 connector 没 grant → 拒（per-connector 授权，不是"给了一个就全给"）。
    with pytest.raises(svc.ConnectorInvokeDenied):
        svc.resolve_caller_ceiling(caller, "atlassian")
    # 无此 agent 行 → 拒。
    with pytest.raises(svc.ConnectorInvokeDenied):
        svc.resolve_caller_ceiling({"context_mode": "untrusted_trigger", "agent_id": "x"}, CID)


# ── 闸序：拒时不建 client ───────────────────────────────────────────────────────


def _invoke(**kw):
    return asyncio.run(svc.invoke_connector_tool(**kw))


@pytest.mark.parametrize(
    "kwargs,code",
    [
        ({"connector_id": "ghost", "tool_name": "search"}, "E_NOT_FOUND"),
        ({"connector_id": CID, "tool_name": "forged"}, "E_NOT_FOUND"),
        ({"connector_id": CID, "tool_name": "delete_page"}, "E_CONNECTOR_TOOL_FORBIDDEN"),
        ({"connector_id": CID, "tool_name": "create_page"}, "E_CONNECTOR_TOOL_DISABLED"),
        (
            {"connector_id": CID, "tool_name": "search", "ceiling": "bogus"},
            "E_CONNECTOR_GRANT_DENIED",
        ),
    ],
)
def test_gates_reject_before_building_client(store, monkeypatch, kwargs, code):
    import src.connectors.client as client_mod

    monkeypatch.setattr(client_mod, "ConnectorClient", _NeverCalledClient)
    with pytest.raises(svc.ConnectorInvokeDenied) as e:
        _invoke(**kwargs)
    assert e.value.code == code


def test_orphan_rejected(store, monkeypatch):
    import src.connectors.client as client_mod

    store.sync_connector_tools(CID, _manifest(("create_page", "write")))  # search 消失
    monkeypatch.setattr(client_mod, "ConnectorClient", _NeverCalledClient)
    with pytest.raises(svc.ConnectorInvokeDenied) as e:
        _invoke(connector_id=CID, tool_name="search")
    assert e.value.code == "E_CONNECTOR_TOOL_ORPHAN"


def test_ceiling_gate_precedes_disabled_gate(store, monkeypatch):
    """越天花板的调用报「grant denied」而不是「disabled」—— 对 headless 更有诊断价值，
    且证明两道闸独立（工具开着照样被天花板挡）。"""
    import src.connectors.client as client_mod

    monkeypatch.setattr(client_mod, "ConnectorClient", _NeverCalledClient)
    with pytest.raises(svc.ConnectorInvokeDenied) as e:  # 工具是关着的，但天花板先判
        _invoke(connector_id=CID, tool_name="create_page", ceiling="read")
    assert e.value.code == "E_CONNECTOR_GRANT_DENIED"


def test_allowed_call_reaches_remote_and_reports_elapsed(store, monkeypatch):
    import src.connectors.client as client_mod

    _OkClient.calls = []
    monkeypatch.setattr(client_mod, "ConnectorClient", _OkClient)
    out = _invoke(connector_id=CID, tool_name="search", arguments={"q": "x"}, ceiling="read")
    assert _OkClient.calls == [(CID, "search", {"q": "x"})]
    assert out["content"] == "c" and out["is_error"] is False and out["truncated"] is False
    assert isinstance(out["elapsed_ms"], int)


def test_oauth_failure_marks_connector_needs_reauth(store, monkeypatch):
    """PR5：授权失效落 ``needs_reauth``（可行动），并把技术原文换成可行动文案。"""
    import src.connectors.client as client_mod
    from src.connectors.service import CONNECTOR_REAUTH_MESSAGE

    class _Unauthorized(_OkClient):
        async def call_tool(self, tool_name, arguments=None, **_k):
            raise client_mod.ConnectorError(
                "nope — run POST /api/connector/{id}/oauth/start", code="E_CONNECTOR_OAUTH"
            )

    monkeypatch.setattr(client_mod, "ConnectorClient", _Unauthorized)
    with pytest.raises(client_mod.ConnectorError) as ei:
        _invoke(connector_id=CID, tool_name="search")
    # code 不变（HTTP 映射 / 调用方判别照旧），message 换成可行动文案。
    assert ei.value.code == "E_CONNECTOR_OAUTH"
    assert str(ei.value) == CONNECTOR_REAUTH_MESSAGE
    assert "oauth/start" not in str(ei.value)
    row = store.get_connector(CID)
    assert row.status == "needs_reauth"  # 如实落态，不静默重试到死
    assert "reconnect" in (row.last_error or "")


def test_transient_failure_does_not_touch_connector_status(store, monkeypatch):
    """超时/网络类失败**不落态** —— 远端抖一下不该被说成「授权没了」。"""
    import src.connectors.client as client_mod

    store.update_connector_state(CID, status="connected")

    class _Flaky(_OkClient):
        async def call_tool(self, tool_name, arguments=None, **_k):
            raise client_mod.ConnectorError("slow", code="E_CONNECTOR_TIMEOUT")

    monkeypatch.setattr(client_mod, "ConnectorClient", _Flaky)
    with pytest.raises(client_mod.ConnectorError) as ei:
        _invoke(connector_id=CID, tool_name="search")
    assert str(ei.value) == "slow"  # 原文不动（只有授权失效那两码才包装）
    assert store.get_connector(CID).status == "connected"
