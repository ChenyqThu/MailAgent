"""分类侧 connector 授权源（08-01 PR3 T3，坑 3）：独立开关 + read 天花板硬编码。"""

from __future__ import annotations

import pytest

from src.agent_config.store import AgentConfigStore
from src.llm_agent.preprocess_config import (
    PREPROCESS_CONNECTOR_CEILING,
    get_preprocess_connector_grants,
)

CID = "notion"


@pytest.fixture()
def store(tmp_path, monkeypatch):
    st = AgentConfigStore(str(tmp_path / "agent_config.db"))
    st.upsert_connector(CID, server_url="https://mcp.notion.com/mcp")
    st.update_connector_state(CID, status="connected")
    monkeypatch.setattr("src.agent_config.store.get_agent_config_store", lambda: st)
    return st


def test_ceiling_is_hardcoded_read():
    """🔴 结构性保证：分类侧天花板不是配置项，就是常量 ``read``。"""
    assert PREPROCESS_CONNECTOR_CEILING == "read"


def test_default_off_yields_no_grants(store):
    assert get_preprocess_connector_grants() == []


def test_opt_in_yields_read_grant(store):
    store.set_connector_preprocess_enabled(CID, True)
    assert get_preprocess_connector_grants() == [(CID, "read")]


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
    assert {ceiling for _, ceiling in get_preprocess_connector_grants()} == {"read"}
