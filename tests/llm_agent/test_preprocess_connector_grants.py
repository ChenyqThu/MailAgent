"""分类侧 connector 授权源（08-01 PR3 T3 坑 3；08-05 WP-10 场地放开改判）：独立开关 +
「read 硬天花板退役、ask ≙ 不注册」的新语义。

🔴 08-05 owner 知情拍板（master-plan WP-10 §5 风险 4 留痕）：原
``PREPROCESS_CONNECTOR_CEILING = "read"`` 常量与「工厂只造 read 工具」的结构保证退役。
本文件钉住替代语义：grants 的 ceiling=None（无 crud 天花板）+ 工厂按
``only_auto_tools=True`` 过滤 —— 该无人值守场地 **仅 ``mode='auto'`` 的工具注册**，
``ask`` 档 = 不注册（有专测钉住），``preprocess_enabled`` 仍独立、默认关。
"""

from __future__ import annotations

import pytest

from src.agent_config.store import AgentConfigStore
from src.llm_agent.preprocess_config import get_preprocess_connector_grants

CID = "notion"


@pytest.fixture()
def store(tmp_path, monkeypatch):
    st = AgentConfigStore(str(tmp_path / "agent_config.db"))
    st.upsert_connector(CID, server_url="https://mcp.notion.com/mcp")
    st.update_connector_state(CID, status="connected")
    monkeypatch.setattr("src.agent_config.store.get_agent_config_store", lambda: st)
    return st


def test_read_ceiling_constant_is_retired():
    """🔴 08-05 拆除物不许回魂：``PREPROCESS_CONNECTOR_CEILING`` 不复存在 —— 谁要重新
    引入 read 硬天花板，得先推翻 08-05 owner 拍板（不是恢复一个常量那么简单）。"""
    import src.llm_agent.preprocess_config as mod

    assert not hasattr(mod, "PREPROCESS_CONNECTOR_CEILING")


def test_default_off_yields_no_grants(store):
    assert get_preprocess_connector_grants() == []


def test_opt_in_yields_uncapped_grant(store):
    """opt-in 后 grants 的 ceiling=None（无 crud 天花板）—— per-tool 档位才是该场地的
    工具面控制点（工厂 only_auto_tools）。"""
    store.set_connector_preprocess_enabled(CID, True)
    assert get_preprocess_connector_grants() == [(CID, None)]


def test_disconnected_or_disabled_connector_excluded(store):
    store.set_connector_preprocess_enabled(CID, True)
    store.update_connector_state(CID, status="error")
    assert get_preprocess_connector_grants() == []
    store.update_connector_state(CID, status="connected", enabled=False)
    assert get_preprocess_connector_grants() == []


def test_store_failure_is_graceful(monkeypatch):
    """库不可用 → []（分类绝不因 connector 面出问题而失败）。"""

    def _boom():
        raise RuntimeError("db gone")

    monkeypatch.setattr("src.agent_config.store.get_agent_config_store", _boom)
    assert get_preprocess_connector_grants() == []


def test_custom_agent_grant_does_not_leak_into_classification(store):
    """🔴 授权面独立：给某个 custom agent 配了 write **不会**被分类侧继承 —— 分类只看
    ``connector.preprocess_enabled``，那条路径连读 tool_policy 的代码都没有。"""
    assert get_preprocess_connector_grants() == []  # 无论别处怎么配
    store.set_connector_preprocess_enabled(CID, True)
    assert {c for c, _ in get_preprocess_connector_grants()} == {CID}


def test_ask_tier_is_not_registered_for_preprocess(store, monkeypatch):
    """🔴 08-05 语义钉死（验收项）：预处理场地 ``ask`` 档 = **不注册**（模型不可见）。

    不是「注册但拒执行」（模型会反复调一个恒失败的工具烧迭代），也不是「降级成 auto」
    （把 owner 的「要问我」静默升成「不问」）。auto 注册、off 不注册一并钉住。
    """
    from src.connectors import llm_tools as lt

    store.set_connector_preprocess_enabled(CID, True)
    store.sync_connector_tools(
        CID,
        [
            {"name": "auto_tool", "description": "", "input_schema": None,
             "output_schema": None, "crud_type": "write"},
            {"name": "ask_tool", "description": "", "input_schema": None,
             "output_schema": None, "crud_type": "read"},
            {"name": "off_tool", "description": "", "input_schema": None,
             "output_schema": None, "crud_type": "read"},
        ],
    )
    store.set_connector_tool_mode(CID, "ask_tool", "ask")
    store.set_connector_tool_mode(CID, "off_tool", "off")
    monkeypatch.setattr(lt, "_connectors_enabled", lambda: True)

    schemas, handlers = lt.build_connector_llm_tools(
        get_preprocess_connector_grants(), caller="email_preprocess", only_auto_tools=True
    )
    # auto_tool 是 write 类且 mode=NULL→auto：08-05 放开后照常注册（无 read 天花板）。
    assert sorted(handlers) == ["mcp__notion__auto_tool"]
    assert [s["name"] for s in schemas] == ["mcp__notion__auto_tool"]
