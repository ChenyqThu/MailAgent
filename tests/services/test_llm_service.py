"""LlmService.selftest() — 纯配置读取健康检查单测 (无 I/O, 不烧 token)。

只覆盖 selftest()。run() 走真实 LLMRunner 编排 (backend/repo/notion), 已有
tests/cli/test_service_parity.py 的 golden 覆盖, 不在本文件范围。selftest() 只读
``ctx.config`` 的 5 个标量字段 (见 src/services/llm_service.py), 用最小 fake ctx
即可, 不必构造完整 ServiceContext。
"""

from __future__ import annotations

from types import SimpleNamespace

from src.services.llm_service import LlmService


def _svc(**cfg_overrides) -> LlmService:
    defaults = dict(
        llm_api_key="key",
        llm_api_base="https://llm.example",
        llm_model="model-x",
        llm_fallback_models="",
        llm_agent_enabled=False,
    )
    defaults.update(cfg_overrides)
    return LlmService(SimpleNamespace(config=SimpleNamespace(**defaults)))


def test_selftest_healthy_when_all_configured():
    data = _svc(llm_fallback_models="a,b", llm_agent_enabled=True).selftest()
    assert data == {
        "healthy": True,
        "api_base": "https://llm.example",
        "primary_model": "model-x",
        "fallback_chain": ["a", "b"],
        "llm_agent_enabled": True,
        "reasons": [],
    }


def test_selftest_unhealthy_when_api_key_missing():
    data = _svc(llm_api_key="").selftest()
    assert data["healthy"] is False
    assert data["reasons"] == ["LLM_API_KEY is empty"]


def test_selftest_unhealthy_when_api_base_missing():
    data = _svc(llm_api_base="").selftest()
    assert data["healthy"] is False
    assert data["reasons"] == ["LLM_API_BASE is empty"]


def test_selftest_unhealthy_when_model_missing():
    data = _svc(llm_model="").selftest()
    assert data["healthy"] is False
    assert data["reasons"] == ["LLM_MODEL is empty"]


def test_selftest_reasons_accumulate_for_multiple_missing_fields():
    data = _svc(llm_api_key="", llm_api_base="").selftest()
    assert data["healthy"] is False
    assert data["reasons"] == ["LLM_API_KEY is empty", "LLM_API_BASE is empty"]


def test_selftest_fallback_chain_parses_and_trims_whitespace():
    data = _svc(llm_fallback_models=" a , b ,, c").selftest()
    assert data["fallback_chain"] == ["a", "b", "c"]


def test_selftest_fallback_chain_empty_when_unset():
    data = _svc(llm_fallback_models="").selftest()
    assert data["fallback_chain"] == []


def test_selftest_never_raises_never_touches_ctx_beyond_config():
    """selftest() 不该访问 config 以外的 ctx 属性 (email_repo/sync_store/backend 等惰性
    属性在 ServiceContext 里首次访问才建连接) —— fake ctx 故意不提供这些属性,
    若 selftest() 误碰会立刻 AttributeError 而非静默通过。"""
    data = _svc().selftest()
    assert isinstance(data, dict)
