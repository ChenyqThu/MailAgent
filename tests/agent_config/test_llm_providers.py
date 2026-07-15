"""LLM provider 配置面 store 测试（task 07-12 P0）—— CRUD / Fernet roundtrip / seed 幂等 /
snapshot §4.3b 形状 + version 递增 / providerRef 解析。

master key 通道全 mock（keyfile fallback 落 tmp，**绝不**弹真钥匙串）—— 镜像 test_secrets.py。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.agent_config import secrets
from src.agent_config.llm_providers import (
    DEFAULT_PROVIDER_ID,
    LlmProviderStore,
    parse_provider_ref,
)

KEY_SENTINEL = "sk-p0-sentinel-key-123456"


def _force_keyfile(monkeypatch):
    """把 Keychain 通道 mock 成不可用 → 走 keyfile fallback（默认隔离，不碰真钥匙串）。"""

    def _unavailable(*_a, **_k):
        raise secrets._KeychainUnavailable("forced-unavailable (test)")

    monkeypatch.setattr(secrets, "_run_security", _unavailable)


@pytest.fixture(autouse=True)
def _isolate_master_key(monkeypatch, tmp_path):
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(tmp_path))
    _force_keyfile(monkeypatch)
    secrets.reset_master_key_cache()
    yield
    secrets.reset_master_key_cache()


def _store(tmp_path) -> LlmProviderStore:
    return LlmProviderStore(str(tmp_path / "agent_config.db"))


# ── providerRef 解析（prd §4.3b 双端契约）─────────────────────────────────────────────


def test_parse_provider_ref_legacy_no_colon():
    assert parse_provider_ref("claude-sonnet-4-6") == (DEFAULT_PROVIDER_ID, "claude-sonnet-4-6")


def test_parse_provider_ref_splits_on_first_colon_only():
    assert parse_provider_ref("dashscope:qwen-max") == ("dashscope", "qwen-max")
    # modelId 内含 ':' 合法（切分只认第一个）
    assert parse_provider_ref("dash:qwen:max-2026") == ("dash", "qwen:max-2026")


# ── provider CRUD ─────────────────────────────────────────────────────────────────────


def test_create_list_get_provider(tmp_path):
    st = _store(tmp_path)
    st.create_provider(
        "dashscope",
        protocol="openai-compatible",
        display_name="Qwen",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        headers={"X-Corp": "1"},
        sort_order=5,
    )
    rows = st.list_providers()
    assert [r.id for r in rows] == ["dashscope"]
    row = st.get_provider("dashscope")
    assert row is not None
    assert row.protocol == "openai-compatible"
    assert row.display_name == "Qwen"
    assert row.headers == {"X-Corp": "1"}
    assert row.sort_order == 5
    assert row.enabled is True
    assert row.has_key is False


def test_create_rejects_bad_protocol_and_bad_id(tmp_path):
    st = _store(tmp_path)
    with pytest.raises(ValueError):
        st.create_provider("x", protocol="grpc")
    with pytest.raises(ValueError):
        st.create_provider("Bad:Id", protocol="openai")  # 含 ':' / 大写 → 拒
    with pytest.raises(ValueError):
        st.create_provider("", protocol="openai")


def test_duplicate_provider_id_rejected(tmp_path):
    st = _store(tmp_path)
    st.create_provider("kimi", protocol="openai-compatible")
    with pytest.raises(ValueError, match="already exists"):
        st.create_provider("kimi", protocol="anthropic")


def test_update_provider_partial_and_key_lifecycle(tmp_path):
    st = _store(tmp_path)
    st.create_provider("glm", protocol="openai-compatible", api_key=KEY_SENTINEL)
    assert st.get_provider_api_key("glm") == KEY_SENTINEL

    # 部分更新：只动 display_name，key 不受影响
    row = st.update_provider("glm", display_name="Zhipu")
    assert row is not None and row.display_name == "Zhipu"
    assert st.get_provider_api_key("glm") == KEY_SENTINEL

    # 轮换 key
    st.update_provider("glm", api_key="sk-rotated-9999")
    assert st.get_provider_api_key("glm") == "sk-rotated-9999"

    # 空串 = 清除
    st.update_provider("glm", api_key="")
    assert st.get_provider_api_key("glm") is None
    updated = st.get_provider("glm")
    assert updated is not None and updated.has_key is False

    # 行不存在 → None
    assert st.update_provider("nope", display_name="x") is None


def test_delete_provider_cascades_models_and_default_is_protected(tmp_path):
    st = _store(tmp_path)
    st.seed_default_from_env(
        api_base="https://crs.example.com/api",
        api_key="",
        model="claude-sonnet-4-6",
        enabled_models=[],
    )
    st.create_provider("kimi", protocol="openai-compatible")
    st.upsert_model("kimi", "kimi-k2", enabled=True)

    assert st.delete_provider("kimi") is True
    assert st.get_provider("kimi") is None
    assert st.list_models("kimi") == []
    assert st.delete_provider("kimi") is False  # 幂等

    with pytest.raises(ValueError, match="default"):
        st.delete_provider(DEFAULT_PROVIDER_ID)
    assert st.get_provider(DEFAULT_PROVIDER_ID) is not None


# ── Fernet roundtrip（复用 S2 master key 机制）───────────────────────────────────────


def test_api_key_ciphertext_is_opaque_and_roundtrips(tmp_path):
    st = _store(tmp_path)
    st.create_provider("crs", protocol="anthropic", api_key=KEY_SENTINEL)
    # DB 里的 api_key_cipher 不含明文哨兵（Fernet 加密）
    conn = sqlite3.connect(st.db_path)
    try:
        (cipher,) = conn.execute(
            "SELECT api_key_cipher FROM llm_provider WHERE id='crs'"
        ).fetchone()
    finally:
        conn.close()
    assert isinstance(cipher, bytes) and KEY_SENTINEL.encode() not in cipher
    # 解密 roundtrip
    assert st.get_provider_api_key("crs") == KEY_SENTINEL


# ── seed 迁移（prd §4.1）──────────────────────────────────────────────────────────────


def test_seed_creates_default_and_is_idempotent(tmp_path):
    st = _store(tmp_path)
    seeded = st.seed_default_from_env(
        api_base="https://crs.example.com/api",
        api_key=KEY_SENTINEL,
        model="claude-sonnet-4-6",
        enabled_models=["claude-opus-4-8", "claude-sonnet-4-6", "gpt-5.5"],
    )
    assert seeded is True
    prov = st.get_provider(DEFAULT_PROVIDER_ID)
    assert prov is not None
    assert prov.protocol == "anthropic"
    assert prov.base_url == "https://crs.example.com/api"
    assert st.get_provider_api_key(DEFAULT_PROVIDER_ID) == KEY_SENTINEL
    models = st.list_models(DEFAULT_PROVIDER_ID)
    assert {m.model_id for m in models} == {"claude-opus-4-8", "claude-sonnet-4-6", "gpt-5.5"}
    assert all(m.enabled and m.source == "manual" and m.max_output is None for m in models)

    # 幂等：重复执行零副作用（不重复行、不覆盖）
    version_before = st.get_snapshot_version()
    assert (
        st.seed_default_from_env(
            api_base="https://other.example.com",
            api_key="sk-other",
            model="different-model",
            enabled_models=["x"],
        )
        is False
    )
    assert st.get_snapshot_version() == version_before
    assert len(st.list_models(DEFAULT_PROVIDER_ID)) == 3
    prov2 = st.get_provider(DEFAULT_PROVIDER_ID)
    assert prov2 is not None and prov2.base_url == "https://crs.example.com/api"


def test_seed_includes_llm_model_when_absent_from_enabled_list(tmp_path):
    st = _store(tmp_path)
    st.seed_default_from_env(
        api_base="https://crs.example.com/api",
        api_key="",
        model="claude-sonnet-4-6",
        enabled_models=["gpt-5.5"],
    )
    models = {m.model_id for m in st.list_models(DEFAULT_PROVIDER_ID)}
    assert models == {"gpt-5.5", "claude-sonnet-4-6"}
    # key 为空 → 密文列 NULL（hasKey False，UI 后补）
    prov = st.get_provider(DEFAULT_PROVIDER_ID)
    assert prov is not None and prov.has_key is False
    assert st.get_provider_api_key(DEFAULT_PROVIDER_ID) is None


def test_seed_skipped_when_any_provider_exists(tmp_path):
    st = _store(tmp_path)
    st.create_provider("custom", protocol="openai")
    assert (
        st.seed_default_from_env(
            api_base="b", api_key="", model="m", enabled_models=[]
        )
        is False
    )
    assert st.get_provider(DEFAULT_PROVIDER_ID) is None  # 有行即跳过，不补 default


# ── model CRUD + merge_fetched ───────────────────────────────────────────────────────


def test_model_crud(tmp_path):
    st = _store(tmp_path)
    st.create_provider("dash", protocol="openai-compatible")
    st.upsert_model(
        "dash",
        "qwen-max",
        display_name="Qwen Max",
        enabled=True,
        capabilities={"tools": True, "vision": False, "reasoning": True},
        max_output=8192,
    )
    (m,) = st.list_models("dash")
    assert m.capabilities == {"tools": True, "vision": False, "reasoning": True}
    assert m.max_output == 8192 and m.enabled is True and m.source == "manual"

    assert st.set_model_enabled("dash", "qwen-max", False) is True
    assert st.list_models("dash")[0].enabled is False
    assert st.set_model_enabled("dash", "nope", True) is False

    assert st.delete_model("dash", "qwen-max") is True
    assert st.list_models("dash") == []
    assert st.delete_model("dash", "qwen-max") is False


def test_merge_fetched_preserves_manual_rows_and_enabled_state(tmp_path):
    st = _store(tmp_path)
    st.create_provider("dash", protocol="openai-compatible")
    st.upsert_model("dash", "qwen-max", enabled=True, source="manual")

    inserted = st.merge_fetched_models("dash", ["qwen-max", "qwen-plus", "  ", "qwen-turbo"])
    assert inserted == 2
    by_id = {m.model_id: m for m in st.list_models("dash")}
    # manual 行不被覆盖：source/enabled 原样，仅刷 fetched_at
    assert by_id["qwen-max"].source == "manual" and by_id["qwen-max"].enabled is True
    assert by_id["qwen-max"].fetched_at is not None
    # 新行 = fetched + 默认不启用（owner opt-in）
    assert by_id["qwen-plus"].source == "fetched" and by_id["qwen-plus"].enabled is False

    # 再 merge 同一批 → 零新增
    assert st.merge_fetched_models("dash", ["qwen-max", "qwen-plus"]) == 0


# ── snapshot（prd §4.3b 契约形状）+ version ──────────────────────────────────────────


def test_version_bumps_on_every_write(tmp_path):
    st = _store(tmp_path)
    assert st.get_snapshot_version() == 0
    st.create_provider("a", protocol="openai")
    v1 = st.get_snapshot_version()
    assert v1 == 1
    st.upsert_model("a", "m1")
    st.set_model_enabled("a", "m1", True)
    st.update_provider("a", display_name="A")
    st.delete_model("a", "m1")
    assert st.get_snapshot_version() == 5
    # 纯读不 bump
    st.list_providers()
    st.snapshot()
    assert st.get_snapshot_version() == 5


def test_snapshot_shape_matches_contract(tmp_path):
    st = _store(tmp_path)
    st.seed_default_from_env(
        api_base="https://crs.example.com/api",
        api_key=KEY_SENTINEL,
        model="claude-sonnet-4-6",
        enabled_models=[],
    )
    st.create_provider("dash", protocol="openai-compatible", base_url="https://d.example/v1")
    st.upsert_model("dash", "qwen-max", enabled=True)
    st.upsert_model("dash", "qwen-turbo", enabled=False)
    # disabled provider 整体不出现在 snapshot
    st.create_provider("off", protocol="openai", enabled=False)

    snap = st.snapshot()
    assert set(snap.keys()) == {"version", "providers"}
    assert isinstance(snap["version"], int)
    by_id = {p["id"]: p for p in snap["providers"]}
    assert set(by_id.keys()) == {DEFAULT_PROVIDER_ID, "dash"}

    default = by_id[DEFAULT_PROVIDER_ID]
    assert set(default.keys()) == {
        "id", "protocol", "displayName", "baseUrl", "apiKey", "headers", "enabled", "models",
    }
    # snapshot 是唯一解密面：apiKey 明文、baseUrl 原样存储值
    assert default["apiKey"] == KEY_SENTINEL
    assert default["baseUrl"] == "https://crs.example.com/api"
    assert default["protocol"] == "anthropic"

    dash_models = {m["id"]: m for m in by_id["dash"]["models"]}
    # 模型含全部行（带 enabled 字段，消费端自筛）
    assert dash_models["qwen-max"]["enabled"] is True
    assert dash_models["qwen-turbo"]["enabled"] is False
    assert set(dash_models["qwen-max"].keys()) == {
        "id", "displayName", "enabled", "capabilities", "maxOutput", "source",
    }
    # 无 key 的 provider → apiKey ""
    assert by_id["dash"]["apiKey"] == ""
