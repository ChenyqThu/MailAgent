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
        _manifest(("search", "read"), ("create_page", "write"), ("update_page", "update")),
    )
    # 08-05 三档：默认档 = auto（write 也免卡可调）。闸 5 测试需要一个显式 off 的行。
    st.set_connector_tool_mode(CID, "create_page", "off")
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
    # 🔴 值域外的字面量（含已退役的 'delete'）双向 fail-closed —— 手改 DB / 老配置里残留的
    # 档位名既不会被当成可放行的 crud，也不会被当成"什么都放行"的天花板。
    assert svc.ceiling_allows("delete", "update") is False
    assert svc.ceiling_allows("read", "delete") is False
    assert svc.ceiling_allows("read", "admin") is False


# ── caller 解析 ────────────────────────────────────────────────────────────────


def test_resolve_caller_absent_or_manual_has_no_ceiling():
    assert svc.resolve_caller_ceiling(None, CID) is None
    assert svc.resolve_caller_ceiling({"context_mode": "manual_chat"}, CID) is None


def test_resolve_caller_im_chat_is_owner_present_no_ceiling():
    """阶段 2 PR-1（08-04 拍板「connector 对 im_chat 全开放」）：im_chat 与 manual 同档 ——
    无天花板（None）。写类的恒 HITL 在 gateway 侧（mayAutoApprove manual-only + PR-3 飞书
    审批卡），服务端不叠加。带 agent_id 也不查 grants（owner-present 分支根本不读 agent 行）。"""
    assert svc.resolve_caller_ceiling({"context_mode": "im_chat"}, CID) is None
    # grants 永不参与：即使 caller 顺手带了 agent_id，也不落 headless 分支（不读 report_agent）。
    assert svc.resolve_caller_ceiling({"context_mode": "im_chat", "agent_id": "a"}, CID) is None
    assert svc.OWNER_PRESENT_CONTEXT_MODES == ("manual_chat", "im_chat")


def test_resolve_caller_matter_followup_is_venue_pinned_read():
    """0812 owner 拍板：matter_followup 进 HEADLESS 白名单，但天花板由 venue **钉死 'read'** ——
    不读 report_agent 行（跟进 run 的 agentId 是 ``matter:<public_id>`` 哨兵，无行可读；D2 也
    禁止绑定 profile 的 grants 外溢），带不带 agent_id 都一样。write/update 类工具随后被
    ``ceiling_allows`` 挡（服务端第二道，独立于 gateway 注册期的 rank 过滤）——
    「全部只读、一个写工具都不给」在执行侧的形态。"""
    assert svc.resolve_caller_ceiling({"context_mode": "matter_followup"}, CID) == "read"
    assert (
        svc.resolve_caller_ceiling(
            {"context_mode": "matter_followup", "agent_id": "matter:MAT-000001"}, CID
        )
        == "read"
    )
    assert "matter_followup" in svc.HEADLESS_CONTEXT_MODES
    # venue 上限的实效（与 test_ceiling_rank_is_monotonic 的通用矩阵独立点名一次）：
    assert svc.ceiling_allows("read", "read") is True
    assert svc.ceiling_allows("write", "read") is False
    assert svc.ceiling_allows("update", "read") is False


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


def test_destructive_write_tool_passes_all_gates(store, monkeypatch):
    """🔴 08-03 delete 闸退役的正例：``destructive=1`` 的 write 工具**照常过闸到远端**。

    以前 destructive_hint 会被推成 delete 并在原闸 3 撞 403 —— Notion 的 update-page 就是
    这样结构性不可用的。现在 destructive 只是审批卡上的红警告位，不再是一道执行禁令。
    08-05 起连显式开都不用 —— 默认档就是 auto（跟随 owner 拍板；本例仍显式设一遍钉住
    「显式 auto 也过闸」）。
    """
    import src.connectors.client as client_mod

    manifest = _manifest(("update_page", "write"))
    manifest[0]["destructive"] = True
    store.sync_connector_tools(CID, _manifest(("search", "read")) + manifest)
    store.set_connector_tool_mode(CID, "update_page", "auto")
    rows = {r.tool_name: r for r in store.list_connector_tools(CID)}
    assert rows["update_page"].destructive is True  # 红警告位仍在

    _OkClient.calls = []
    monkeypatch.setattr(client_mod, "ConnectorClient", _OkClient)
    out = _invoke(connector_id=CID, tool_name="update_page", ceiling="write")
    assert _OkClient.calls == [(CID, "update_page", None)]
    assert out["is_error"] is False


def test_default_tier_write_tool_passes_gate_5(store, monkeypatch):
    """08-05 默认档翻 auto 的服务端正例：从未配置过（mode=NULL）的 write 工具过闸 5。

    这正是发版说明里「工具面变宽」的服务端形态 —— 升级前它会撞 E_CONNECTOR_TOOL_DISABLED
    （write 默认关）。
    """
    import src.connectors.client as client_mod

    _OkClient.calls = []
    monkeypatch.setattr(client_mod, "ConnectorClient", _OkClient)
    out = _invoke(connector_id=CID, tool_name="update_page")  # update 类、无覆盖、无天花板
    assert _OkClient.calls == [(CID, "update_page", None)]
    assert out["is_error"] is False


def test_deny_ask_mode_blocks_ask_tier_for_unattended_callers(store, monkeypatch):
    """08-05 场地一（预处理）第二道：``deny_ask_mode=True`` 时 ask 档 ≙ 不可用；
    owner-present / headless 调用面（默认 False）不受影响。"""
    import src.connectors.client as client_mod

    store.set_connector_tool_mode(CID, "search", "ask")
    monkeypatch.setattr(client_mod, "ConnectorClient", _NeverCalledClient)
    with pytest.raises(svc.ConnectorInvokeDenied) as e:
        _invoke(connector_id=CID, tool_name="search", deny_ask_mode=True)
    assert e.value.code == "E_CONNECTOR_TOOL_DISABLED"

    _OkClient.calls = []
    monkeypatch.setattr(client_mod, "ConnectorClient", _OkClient)
    out = _invoke(connector_id=CID, tool_name="search")  # 默认 False：ask 照常执行
    assert out["is_error"] is False and _OkClient.calls == [(CID, "search", None)]


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


def test_rejected_token_still_marks_needs_reauth(store, monkeypatch):
    """对照组（08-06）：**同一个 code** 的另一形状 —— 远端拒了我们的 token（非交互会话下
    SDK 回落完整授权流 → ``_no_interactive_redirect`` 抛 ``E_CONNECTOR_NOT_CONNECTED``）
    照常落 ``needs_reauth``。

    没有这一条，下面那条「端点未知不落态」可以被「``NOT_CONNECTED`` 一律不落态」这种过度
    收紧解法满足，而那会把授权真失效时**唯一**的可行动状态一起废掉。
    """
    import src.connectors.client as client_mod
    from src.connectors.service import CONNECTOR_REAUTH_MESSAGE

    class _Rejected(_OkClient):
        async def call_tool(self, tool_name, arguments=None, **_k):
            raise client_mod.ConnectorError(
                "connector is not authorized (or the access token can no longer be "
                "refreshed) — run POST /api/connector/{id}/oauth/start",
                code="E_CONNECTOR_NOT_CONNECTED",
            )

    monkeypatch.setattr(client_mod, "ConnectorClient", _Rejected)
    with pytest.raises(client_mod.ConnectorError) as ei:
        _invoke(connector_id=CID, tool_name="search")
    assert ei.value.code == "E_CONNECTOR_NOT_CONNECTED"
    assert str(ei.value) == CONNECTOR_REAUTH_MESSAGE
    assert store.get_connector(CID).status == "needs_reauth"


def _flaky_row_lookup(monkeypatch):
    """`connector` 行查询抖一下（锁竞争 / 库损坏的合成版）→ 返回的开关能把它恢复。

    只打 ``AgentConfigStore.get_connector``（`registry.get_connector_def` 读的就是它），
    `list_connector_tools` 等照常 —— 这正是**瞬时**锁竞争的形状：一条语句超时、下一条成功。
    恢复开关是为了让用例事后还能把行读回来做断言。
    """
    from src.agent_config.store import AgentConfigStore

    real = AgentConfigStore.get_connector
    state = {"broken": True}

    def _maybe_boom(self, connector_id):
        if state["broken"]:
            raise RuntimeError("agent_config.db is locked (synthetic)")
        return real(self, connector_id)

    monkeypatch.setattr(AgentConfigStore, "get_connector", _maybe_boom)
    return state


@pytest.mark.parametrize(
    "cid,source",
    [("notion", "custom_mcp"), ("gmail", "composio")],  # 双轨：直连 + Composio 托管
)
def test_unresolved_endpoint_never_marks_a_healthy_connector_needs_reauth(
    store, monkeypatch, cid, source
):
    """🔴 预存缺陷（08-06 修）：「我们这边解析不出端点」≠「token 被对方拒了」。

    真实触发形状：`connector` 行查询抖一下 → `registry` 兜底走目录（direct 条目的端点被
    **抹空**、composio 条目本来就没端点）→ client 在打开传输**之前**显式拒。一个字节都没
    发出去、远端从没拒过我们 ⇒ 这条**健康的**连接不得被落成 ``needs_reauth``（那会把 owner
    支去重新授权一个根本没坏的东西）。两条轨同受此判 —— 故双轨各跑一遍。

    用**真** ConnectorClient（不 stub）：要守的正是「raise 的类型 → service 的归类」这条链。
    """
    import src.connectors.client as client_mod

    if cid != CID:
        store.upsert_connector(
            cid, server_url="https://mcp.composio.test/trs_1", source=source
        )
        store.update_connector_state(cid, status="connected")
        store.sync_connector_tools(cid, _manifest(("search", "read")))
    broken = _flaky_row_lookup(monkeypatch)

    with pytest.raises(client_mod.ConnectorError) as ei:
        _invoke(connector_id=cid, tool_name="search")
    # wire code 不变（对调用方仍是「这个 connector 现在用不了」）；变的只是**类型**，
    # 落态点靠它区分（service.should_mark_needs_reauth）。
    assert ei.value.code == "E_CONNECTOR_NOT_CONNECTED"
    assert isinstance(ei.value, client_mod.ConnectorUnconfigured)
    # 没被包装成「授权过期/被撤销」的可行动文案 —— 那句话在这里是假的。
    assert str(ei.value) != svc.CONNECTOR_REAUTH_MESSAGE
    assert "has no endpoint" in str(ei.value)

    broken["broken"] = False
    row = store.get_connector(cid)
    assert row.status == "connected"  # 🔴 健康连接不许被说成「需要重新授权」
    assert row.last_error is None


def test_missing_composio_key_never_marks_a_healthy_connector_needs_reauth(
    store, monkeypatch
):
    """🔴 同类预存缺陷的托管轨入口（08-06 修）：BYOK key 缺失 ≠ token 被拒。

    owner 轮换 / 清掉 Composio key 的那一刻，托管轨每一条连接的下一次工具调用都会在
    `_composio_headers` 本地失败（零出网）。旧行为把它们**全部**翻成「授权过期或被撤销，
    去重连」—— 而重新授权根本修不好：要填的是 key。

    用**真** ConnectorClient（不 stub）：守的是「`require_api_key` 失败 → 抛的类型 →
    service 的归类」整条链。
    """
    import src.connectors.client as client_mod
    from src.connectors import composio

    store.upsert_connector(
        "gmail", server_url="https://mcp.composio.test/trs_1", source="composio"
    )
    store.update_connector_state("gmail", status="connected")
    store.sync_connector_tools("gmail", _manifest(("search", "read")))
    monkeypatch.setattr(composio, "get_api_key", lambda: None)

    with pytest.raises(client_mod.ConnectorError) as ei:
        _invoke(connector_id="gmail", tool_name="search")
    assert ei.value.code == "E_CONNECTOR_NOT_CONNECTED"
    assert isinstance(ei.value, client_mod.ConnectorUnconfigured)
    # 原文（「去填 key」）不许被换成「去重连」——后者在这里是错误指路。
    assert str(ei.value) != svc.CONNECTOR_REAUTH_MESSAGE
    assert "API key is not configured" in str(ei.value)

    row = store.get_connector("gmail")
    assert row.status == "connected"
    assert row.last_error is None


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
