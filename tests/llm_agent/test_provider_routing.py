"""provider_routing 单测（task 07-12 P2）—— baseURL 归一 / providerRef 决议 / TTL 快照 /
fail-open / per-model clamp。

master key 通道全 mock（keyfile fallback 落 tmp，绝不弹真钥匙串）—— 镜像 test_llm_providers.py。
flag 经 monkeypatch 替换模块级 cfg（不动真实 pydantic 单例）。
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from src.agent_config import llm_providers, secrets
from src.agent_config.llm_providers import get_llm_provider_store
from src.llm_agent import provider_routing as pr

KEY = "sk-route-test-123456"


@pytest.fixture(autouse=True)
def _isolated(monkeypatch, tmp_path):
    """隔离 master key（keyfile→tmp）+ agent_config.db（tmp）+ 双缓存重置。"""
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(tmp_path))

    def _unavailable(*_a, **_k):
        raise secrets._KeychainUnavailable("forced-unavailable (test)")

    monkeypatch.setattr(secrets, "_run_security", _unavailable)
    secrets.reset_master_key_cache()
    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", str(tmp_path / "agent_config.db"))
    llm_providers.reset_llm_provider_store_cache()
    pr.reset_provider_route_cache()
    yield
    llm_providers.reset_llm_provider_store_cache()
    pr.reset_provider_route_cache()
    secrets.reset_master_key_cache()


def _flag(monkeypatch, enabled: bool) -> None:
    monkeypatch.setattr(pr, "cfg", SimpleNamespace(llm_provider_registry_enabled=enabled))


# ── baseURL 归一（research/01 §7「三种拼接规则」的统一点）──────────────────────────────


def test_normalize_openai_base_all_shapes():
    # 已含 /vN → 原样（dashscope compatible-mode）
    assert (
        pr.normalize_openai_base("https://dashscope.aliyuncs.com/compatible-mode/v1")
        == "https://dashscope.aliyuncs.com/compatible-mode/v1"
    )
    # 裸域名 → 补 /v1（deepseek）
    assert pr.normalize_openai_base("https://api.deepseek.com") == "https://api.deepseek.com/v1"
    # CRS 形态（path 不以 /vN 结尾）→ 补 /v1
    assert pr.normalize_openai_base("https://crs.chenge.ink/api") == "https://crs.chenge.ink/api/v1"
    # 尾 / 先剥再判
    assert pr.normalize_openai_base("https://x.example/v1/") == "https://x.example/v1"
    assert pr.normalize_openai_base("https://x.example/") == "https://x.example/v1"
    # /v2 等其它版本号同样算已含
    assert pr.normalize_openai_base("https://x.example/v2") == "https://x.example/v2"
    # 形似但非版本段（/verify）→ 补 /v1
    assert pr.normalize_openai_base("https://x.example/verify") == "https://x.example/verify/v1"
    assert pr.normalize_openai_base("") == ""


def test_normalize_anthropic_base():
    assert pr.normalize_anthropic_base("https://crs.chenge.ink/api/") == "https://crs.chenge.ink/api"
    # anthropic-compat 端点（DeepSeek/Kimi/GLM）行值原样（SDK 自动加 /v1/messages）
    assert (
        pr.normalize_anthropic_base("https://api.deepseek.com/anthropic")
        == "https://api.deepseek.com/anthropic"
    )
    # 空 = 官方默认 → None（AsyncAnthropic 自带 api.anthropic.com）
    assert pr.normalize_anthropic_base("") is None
    assert pr.normalize_anthropic_base("   ") is None


def test_openai_base_for_protocol_defaults():
    def route(protocol, base=""):
        return pr.ProviderRoute(provider_id="p", protocol=protocol, base_url=base, api_key="k")

    assert pr.openai_base_for(route("openai")) == "https://api.openai.com/v1"
    assert pr.openai_base_for(route("deepseek")) == "https://api.deepseek.com/v1"
    assert pr.openai_base_for(route("openrouter")) == "https://openrouter.ai/api/v1"
    # openai-compatible 无官方默认 → ''（调用方报配置错误走 fallback 链）
    assert pr.openai_base_for(route("openai-compatible")) == ""
    # 行 base 优先于官方默认
    assert pr.openai_base_for(route("openai", "https://one.example/v1")) == "https://one.example/v1"


def test_clamp_max_tokens():
    route = pr.ProviderRoute(
        provider_id="p", protocol="openai", base_url="", api_key="k", max_output=8000
    )
    assert pr.clamp_max_tokens(64000, None) == 64000
    assert pr.clamp_max_tokens(64000, route) == 8000
    assert pr.clamp_max_tokens(4000, route) == 4000  # 请求值更小 → 不放大
    no_clamp = pr.ProviderRoute(provider_id="p", protocol="openai", base_url="", api_key="k")
    assert pr.clamp_max_tokens(64000, no_clamp) == 64000  # max_output NULL 不 clamp


# ── resolve_route ─────────────────────────────────────────────────────────────────────


def test_flag_off_returns_none(monkeypatch):
    _flag(monkeypatch, False)
    assert pr.resolve_route("claude-sonnet-4-6") is None
    assert pr.resolve_route("dashscope:qwen-max") is None


def test_resolve_seeded_default_provider(monkeypatch):
    _flag(monkeypatch, True)
    st = get_llm_provider_store()
    assert st.seed_default_from_env(
        api_base="https://crs.chenge.ink/api",
        api_key=KEY,
        model="claude-sonnet-4-6",
        enabled_models=["gpt-5.4"],
    )
    route = pr.resolve_route("claude-sonnet-4-6")  # legacy 无冒号 → default
    assert route is not None
    assert route.is_default and route.protocol == "anthropic"
    assert route.base_url == "https://crs.chenge.ink/api"
    assert route.api_key == KEY  # Fernet 解密
    assert route.model_id == "claude-sonnet-4-6"
    assert route.max_output is None  # seed 行 max_output NULL → 不 clamp


def test_resolve_non_default_provider_with_model_row(monkeypatch):
    _flag(monkeypatch, True)
    st = get_llm_provider_store()
    st.create_provider(
        "dashscope",
        protocol="openai-compatible",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        api_key="sk-qwen",
        headers={"X-Corp": "1"},
    )
    st.upsert_model("dashscope", "qwen-max", enabled=True, max_output=8000)
    pr.reset_provider_route_cache()

    route = pr.resolve_route("dashscope:qwen-max")
    assert route is not None
    assert route.protocol == "openai-compatible"
    assert route.base_url == "https://dashscope.aliyuncs.com/compatible-mode/v1"
    assert route.api_key == "sk-qwen"
    assert route.headers == {"X-Corp": "1"}
    assert route.model_id == "qwen-max"
    assert route.max_output == 8000
    assert not route.is_default

    # modelId 内含 ':' 合法（切分只认第一个）；无模型行 → max_output None 仍可路由（手填 ref）
    r2 = pr.resolve_route("dashscope:qwen:max-2026")
    assert r2 is not None and r2.model_id == "qwen:max-2026" and r2.max_output is None


def test_resolve_fail_open_missing_or_disabled(monkeypatch):
    _flag(monkeypatch, True)
    st = get_llm_provider_store()
    st.create_provider("kimi", protocol="openai-compatible", base_url="https://api.moonshot.cn/v1")
    st.update_provider("kimi", enabled=False)
    pr.reset_provider_route_cache()
    # 行缺失 / 禁用（snapshot 只含 enabled 行）→ None（回退全局配置 + 前缀路由）
    assert pr.resolve_route("missing:m") is None
    assert pr.resolve_route("kimi:kimi-k2") is None


def test_snapshot_ttl_caches_and_reset(monkeypatch):
    _flag(monkeypatch, True)
    st = get_llm_provider_store()
    assert pr.resolve_route("glm:glm-4.6") is None  # 冷读 → 空表快照进缓存
    st.create_provider("glm", protocol="openai-compatible", base_url="https://open.bigmodel.cn/api/paas/v4")
    # TTL 内仍用旧快照（30s 热读语义）
    assert pr.resolve_route("glm:glm-4.6") is None
    pr.reset_provider_route_cache()
    assert pr.resolve_route("glm:glm-4.6") is not None


def test_snapshot_failure_without_previous_is_fail_open(monkeypatch):
    _flag(monkeypatch, True)

    def _boom():
        raise RuntimeError("db unavailable")

    monkeypatch.setattr(pr, "get_llm_provider_store", _boom)
    # 无旧快照 + 读失败 → None（fail-open，不抛，legacy 路径兜底）
    assert pr.resolve_route("dashscope:qwen-max") is None


def test_snapshot_failure_keeps_stale_snapshot(monkeypatch):
    _flag(monkeypatch, True)
    st = get_llm_provider_store()
    st.create_provider("dashscope", protocol="openai-compatible", base_url="https://d.example/v1")
    pr.reset_provider_route_cache()
    assert pr.resolve_route("dashscope:m") is not None  # 灌入快照

    def _boom():
        raise RuntimeError("db unavailable")

    monkeypatch.setattr(pr, "get_llm_provider_store", _boom)
    monkeypatch.setattr(pr, "_SNAPSHOT_TTL_SEC", 0.0)  # 强制过期 → 每次都尝试重读（失败）
    assert pr.resolve_route("dashscope:m") is not None  # 旧快照 fail-open 续用
