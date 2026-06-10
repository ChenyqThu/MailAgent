"""serve-api llm models 端点测试 — GET /api/llm/models + /api/chat/config enabledModels。

7 用例：
  1. 上游失败 → models:[] 恒 200（graceful）
  2. 上游正常 → models 列表解析正确、cached:false
  3. TTL 命中 → cached:true（不再调 _fetch_upstream_models）
  4. ?refresh=true → 绕过缓存（不管 TTL 剩余）
  5. api_base 未配置 → error:'api_base_not_configured'、models:[]
  6. /config enabledModels — 有配置 → 正确列表
  7. /config enabledModels — 未配置 → []

fixtures:
  - autouse fixture 每个测试前重置模块级 _models_cache（隔离 TTL 状态）
  - _fetch_upstream_models 用 monkeypatch 替换（不真正 httpx）
  - chat_config 两例 monkeypatch dotenv_values + get_env_file_path
"""

from __future__ import annotations

from typing import Iterator, List

import pytest
from fastapi.testclient import TestClient

import src.api.routers.llm as llm_router
from src.api.app import app


# ---------------------------------------------------------------------------
# autouse fixture — 每用例前重置模块级缓存，隔离 TTL 副作用
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def reset_models_cache():
    """每个测试前后都清空 _models_cache，防止 TTL 状态跨测试污染。"""
    llm_router._models_cache = None
    yield
    llm_router._models_cache = None


# ---------------------------------------------------------------------------
# 共用 client fixture（auth bypass 由 conftest 的 MAILAGENT_API_AUTH_DISABLED=true 提供）
# ---------------------------------------------------------------------------
@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


# ---------------------------------------------------------------------------
# 辅助：stub cfg（只需 llm_api_base + llm_api_key）
# ---------------------------------------------------------------------------
class _StubCfg:
    llm_api_base = "https://crs.example.com/api"
    llm_api_key = "test-key"


class _StubCfgNoBase:
    llm_api_base = ""
    llm_api_key = "test-key"


# ---------------------------------------------------------------------------
# 1. 上游失败 → models:[] 恒 200
# ---------------------------------------------------------------------------
def test_list_models_upstream_failure_returns_empty(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """_fetch_upstream_models 抛异常（网络断） → 响应 200 + models:[] + error:None。"""
    async def _fail(api_base: str, api_key: str) -> List[str]:
        raise RuntimeError("network error")

    monkeypatch.setattr(llm_router, "_fetch_upstream_models", _fail)
    monkeypatch.setattr("src.api.routers.llm.get_settings", lambda: _StubCfg())

    r = client.get("/api/llm/models")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["models"] == []
    assert data["cached"] is False
    assert data["error"] is None


# ---------------------------------------------------------------------------
# 2. 上游正常 → 列表解析正确、cached:false
# ---------------------------------------------------------------------------
def test_list_models_upstream_success(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """_fetch_upstream_models 正常返回列表 → 响应包含该列表，cached:false。"""
    _MODELS = ["claude-sonnet-4-6", "claude-opus-4-8", "gpt-5.5"]

    async def _ok(api_base: str, api_key: str) -> List[str]:
        return list(_MODELS)

    monkeypatch.setattr(llm_router, "_fetch_upstream_models", _ok)
    monkeypatch.setattr("src.api.routers.llm.get_settings", lambda: _StubCfg())

    r = client.get("/api/llm/models")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["models"] == _MODELS
    assert data["cached"] is False
    assert data["cached_at"] is not None


# ---------------------------------------------------------------------------
# 3. TTL 命中 → cached:true（不再调 _fetch_upstream_models）
# ---------------------------------------------------------------------------
def test_list_models_cache_hit(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """缓存新鲜时第二次请求 cached:true，_fetch_upstream_models 只调一次。"""
    call_count = {"n": 0}

    async def _once(api_base: str, api_key: str) -> List[str]:
        call_count["n"] += 1
        return ["model-a", "model-b"]

    monkeypatch.setattr(llm_router, "_fetch_upstream_models", _once)
    monkeypatch.setattr("src.api.routers.llm.get_settings", lambda: _StubCfg())

    r1 = client.get("/api/llm/models")
    assert r1.status_code == 200
    assert r1.json()["data"]["cached"] is False

    r2 = client.get("/api/llm/models")
    assert r2.status_code == 200
    data2 = r2.json()["data"]
    assert data2["cached"] is True
    assert data2["models"] == ["model-a", "model-b"]
    assert call_count["n"] == 1  # 上游只调了一次


# ---------------------------------------------------------------------------
# 4. ?refresh=true → 绕过缓存
# ---------------------------------------------------------------------------
def test_list_models_refresh_bypasses_cache(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """?refresh=true 绕过有效缓存，强制重新拉取，响应 cached:false。"""
    call_count = {"n": 0}

    async def _counter(api_base: str, api_key: str) -> List[str]:
        call_count["n"] += 1
        return ["model-x"]

    monkeypatch.setattr(llm_router, "_fetch_upstream_models", _counter)
    monkeypatch.setattr("src.api.routers.llm.get_settings", lambda: _StubCfg())

    # 建立缓存
    client.get("/api/llm/models")
    assert call_count["n"] == 1

    # refresh=true → 再次拉取
    r = client.get("/api/llm/models?refresh=true")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["cached"] is False
    assert call_count["n"] == 2


# ---------------------------------------------------------------------------
# 5. api_base 未配置 → error:'api_base_not_configured'
# ---------------------------------------------------------------------------
def test_list_models_no_api_base(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """LLM_API_BASE 为空 → 恒 200，error:'api_base_not_configured'，models:[]。"""
    monkeypatch.setattr("src.api.routers.llm.get_settings", lambda: _StubCfgNoBase())

    r = client.get("/api/llm/models")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["error"] == "api_base_not_configured"
    assert data["models"] == []
    assert data["cached"] is False


# ---------------------------------------------------------------------------
# 6. /config enabledModels — 有配置 → 解析正确
# ---------------------------------------------------------------------------
def test_chat_config_enabled_models_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    """LLM_ENABLED_MODELS 有值 → /chat/config data['enabledModels'] 为解析后列表。"""

    class _ChatCfg:
        agent_max_iter = 8
        agent_max_cost_usd = 0.5
        agent_harness_enabled = True
        kos_consumer_enabled = False
        kos_l1_hot_block_enabled = False
        kos_time_decay_enabled = True
        llm_model = "claude-sonnet-4-6"

    monkeypatch.setattr("src.api.routers.chat.get_settings", lambda: _ChatCfg())

    # Stub ContextLoader so /config doesn't call Notion.
    async def _ctx() -> str:
        return ""

    class _StubLoader:
        get_markdown = staticmethod(_ctx)

    monkeypatch.setattr("src.api.routers.chat._get_context_loader", lambda: _StubLoader())

    # Stub dotenv_values to return a controlled LLM_ENABLED_MODELS value.
    _ENABLED = "claude-sonnet-4-6, claude-opus-4-8 , gpt-5.5"

    def _fake_dotenv(path: str) -> dict:
        return {"LLM_ENABLED_MODELS": _ENABLED}

    monkeypatch.setattr("src.api.routers.chat.dotenv_values", _fake_dotenv)
    # Stub get_env_file_path so it returns a non-empty path (actual file need not exist).
    monkeypatch.setattr(
        "src.api.routers.chat.get_env_file_path", lambda: "/fake/.env"
    )

    with TestClient(app, raise_server_exceptions=False) as c:
        r = c.get("/api/chat/config")

    assert r.status_code == 200
    data = r.json()["data"]
    assert data["enabledModels"] == ["claude-sonnet-4-6", "claude-opus-4-8", "gpt-5.5"]


# ---------------------------------------------------------------------------
# 7. /config enabledModels — 未配置 → []
# ---------------------------------------------------------------------------
def test_chat_config_enabled_models_not_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    """LLM_ENABLED_MODELS 未配置（key 缺失）→ enabledModels:[]（前端 fallback 硬编码列表）。"""

    class _ChatCfg:
        agent_max_iter = 8
        agent_max_cost_usd = 0.5
        agent_harness_enabled = True
        kos_consumer_enabled = False
        kos_l1_hot_block_enabled = False
        kos_time_decay_enabled = True
        llm_model = "claude-sonnet-4-6"

    monkeypatch.setattr("src.api.routers.chat.get_settings", lambda: _ChatCfg())

    async def _ctx() -> str:
        return ""

    class _StubLoader:
        get_markdown = staticmethod(_ctx)

    monkeypatch.setattr("src.api.routers.chat._get_context_loader", lambda: _StubLoader())

    # dotenv_values returns dict without LLM_ENABLED_MODELS key.
    def _fake_dotenv(path: str) -> dict:
        return {}

    monkeypatch.setattr("src.api.routers.chat.dotenv_values", _fake_dotenv)
    monkeypatch.setattr(
        "src.api.routers.chat.get_env_file_path", lambda: "/fake/.env"
    )

    with TestClient(app, raise_server_exceptions=False) as c:
        r = c.get("/api/chat/config")

    assert r.status_code == 200
    data = r.json()["data"]
    assert data["enabledModels"] == []
