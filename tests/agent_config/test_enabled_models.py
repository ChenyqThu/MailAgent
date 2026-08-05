"""「在册模型全集」聚合单源（src/agent_config/enabled_models.py，08-04 ``/model`` 抽取）。

这份聚合有**两个**消费者：``/chat/config.enabledModels``（对外契约，形状/顺序不能变）
与飞书 ``/model`` 指令（拿它当「这个 ref 能不能传给 gateway」的判据）。所以这里盯两件事：

  1. **flag off / 聚合失败 → env 清单原样**（含顺序）—— 分组实现最容易在这里悄悄重排；
  2. **flag on 的顺序与形状** —— default provider 裸 id 且恒排最前，其余 ``provider:model``。

master key 通道全 mock（keyfile fallback 落 tmp，**绝不**弹真钥匙串）—— 镜像 test_secrets.py。
"""

from __future__ import annotations

import pytest

from src.agent_config import secrets
from src.agent_config.enabled_models import (
    SOURCE_ENV,
    SOURCE_REGISTRY,
    build_enabled_model_catalog,
)
from src.agent_config.llm_providers import (
    LlmProviderStore,
    reset_llm_provider_store_cache,
)


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    """独立 agent_config.db + keyfile master key（不碰真钥匙串 / 真 .env）。"""

    def _unavailable(*_a, **_k):
        raise secrets._KeychainUnavailable("forced-unavailable (test)")

    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", str(tmp_path / "agent_config.db"))
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(tmp_path))
    monkeypatch.setattr(secrets, "_run_security", _unavailable)
    secrets.reset_master_key_cache()
    reset_llm_provider_store_cache()
    yield
    secrets.reset_master_key_cache()
    reset_llm_provider_store_cache()


def _seed_rows(tmp_path) -> LlmProviderStore:
    store = LlmProviderStore(str(tmp_path / "agent_config.db"))
    # 第二 provider 先建（sort_order 0，排在 default 前）—— 用来证明 default 恒被提前
    store.create_provider("dash", protocol="openai-compatible", display_name="阿里百炼")
    store.upsert_model("dash", "qwen-max", display_name="Qwen Max", enabled=True)
    store.upsert_model("dash", "qwen-turbo", enabled=False)
    store.create_provider("default", protocol="anthropic", display_name="CRS 中转")
    store.upsert_model("default", "claude-sonnet-4-6", enabled=True)
    store.upsert_model("default", "claude-opus-4-8", enabled=True)
    store.create_provider("off", protocol="openai", enabled=False)
    store.upsert_model("off", "gpt-hidden", enabled=True)
    return store


# ── flag off：env 清单原样（顺序是对外契约的一部分）──────────────────────────────


def test_flag_off_keeps_env_list_verbatim_including_order():
    env = ["a:x", "plain", "a:z"]
    catalog = build_enabled_model_catalog(registry_enabled=False, env_models=env)
    # 🔴 若按 provider 分组，这里会变成 ['a:x', 'a:z', 'plain'] —— /chat/config 的形状就变了
    assert catalog.refs == env
    assert catalog.source == SOURCE_ENV


def test_flag_off_drops_blank_entries_only():
    catalog = build_enabled_model_catalog(
        registry_enabled=False, env_models=["", "  ", " m1 "]
    )
    assert catalog.refs == ["m1"]


def test_flag_off_drops_unparsable_entries():
    """畸形条目（解析不出 model_id）丢掉 —— 抽取前后**唯一**的行为差别，故意钉住。

    ``"foo:"`` 这种在前端会渲染成一个必然调用失败的可选项，且 ``find`` 本来就永远判它
    不在册（``/model foo:`` 照样被拒），透出去只有害处。
    """
    catalog = build_enabled_model_catalog(
        registry_enabled=False, env_models=["foo:", ":", "ok", "a:b"]
    )
    assert catalog.refs == ["ok", "a:b"]
    assert catalog.find("foo:") is None


def test_flag_off_env_refs_are_still_parsed_for_lookup():
    catalog = build_enabled_model_catalog(registry_enabled=False, env_models=["dash:qwen-max"])
    hit = catalog.find("dash:qwen-max")
    assert hit is not None and (hit.provider_id, hit.model_id) == ("dash", "qwen-max")


# ── flag on：聚合形状与顺序 ────────────────────────────────────────────────────


def test_flag_on_default_first_bare_ids_others_prefixed(tmp_path):
    _seed_rows(tmp_path)
    catalog = build_enabled_model_catalog(registry_enabled=True, env_models=["env-only"])
    assert catalog.source == SOURCE_REGISTRY
    # default 恒最前 + 裸 id；disabled provider / disabled model 不出现
    assert catalog.refs == ["claude-opus-4-8", "claude-sonnet-4-6", "dash:qwen-max"]
    assert [g.provider_id for g in catalog.groups] == ["default", "dash"]
    assert [g.provider_name for g in catalog.groups] == ["CRS 中转", "阿里百炼"]


def test_flag_on_carries_display_name_for_labels(tmp_path):
    _seed_rows(tmp_path)
    catalog = build_enabled_model_catalog(registry_enabled=True, env_models=[])
    qwen = catalog.find("dash:qwen-max")
    assert qwen is not None and qwen.label == "Qwen Max（dash:qwen-max）"
    sonnet = catalog.find("claude-sonnet-4-6")
    # 无别名 → label 就是 ref（不产出「x（x）」）
    assert sonnet is not None and sonnet.label == "claude-sonnet-4-6"


def test_flag_on_store_failure_falls_back_to_env(monkeypatch):
    import src.agent_config.enabled_models as mod

    def _boom():
        raise RuntimeError("store down")

    monkeypatch.setattr(mod, "ensure_seeded_store", _boom)
    catalog = build_enabled_model_catalog(
        registry_enabled=True, env_models=["env-a", "env-b"]
    )
    assert catalog.refs == ["env-a", "env-b"]
    assert catalog.source == SOURCE_ENV


# ── find：归一成员测试（``default:x`` ≡ 裸 ``x``）───────────────────────────────


def test_find_treats_explicit_default_prefix_as_bare_id(tmp_path):
    _seed_rows(tmp_path)
    catalog = build_enabled_model_catalog(registry_enabled=True, env_models=[])
    hit = catalog.find("default:claude-opus-4-8")
    # 命中的是 canonical 形态（裸 id）—— 落库/传 gateway 都用它
    assert hit is not None and hit.ref == "claude-opus-4-8"


def test_find_rejects_unknown_and_empty(tmp_path):
    _seed_rows(tmp_path)
    catalog = build_enabled_model_catalog(registry_enabled=True, env_models=[])
    assert catalog.find("nope:whatever") is None
    assert catalog.find("qwen-max") is None  # 不带 provider → 落到 default，没有这行
    assert catalog.find("") is None
    assert catalog.find("   ") is None


def test_default_model_is_carried_through(tmp_path):
    _seed_rows(tmp_path)
    catalog = build_enabled_model_catalog(
        registry_enabled=True, env_models=[], default_model="claude-sonnet-4-6"
    )
    assert catalog.default_model == "claude-sonnet-4-6"
