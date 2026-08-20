"""全局跟进 Agent 默认（model / effort / fallback）—— 0813 dogfood 轮 3 · B10。

owner 原话：「跟进规则的**全局** matter agent 配置，仍然没有模型配置啊，看设计，override
倒是有了」。上一批只落了事项级覆盖，全局这一层对模型没有任何意见。

本文件盯的是**生效链路**而不是"存进去了"—— 只测存储就是在给一个可能永远不生效的配置发
合格证（同 test_matter_agent_overrides.py 的立场）。四层链自具体到宽泛：

    事项级覆盖 → 绑定 profile → 全局跟进 Agent 默认 → gateway 全局默认

🔴 第 2 层在第 3 层之前是**有依据的取舍**（run_spec 模块 docstring 记了三条）：D2「profile
只贡献 model/persona」+ 绑定是 per-matter 的显式选择 + 纯加层不改既有事项的行为。所以这里
专门有一条测钉死「profile 压过全局默认」—— 顺序被改掉时必须红。
"""

from __future__ import annotations

import json
import sqlite3
from types import SimpleNamespace

import pytest

from src.mail.sync_store import SyncStore
from src.matters.agent_defaults import (
    MATTER_AGENT_DEFAULTS_KEY,
    dump_agent_defaults,
    load_agent_defaults,
)
from src.matters.repository import MatterRepository
from src.matters.run_service import MatterRunService
from src.matters.run_spec import assemble_matter_spec
from src.reports.store import ReportStore
from src.sync.async_jobs import AsyncJobRepository

SCHEDULE_ENTRY = {
    "kind": "schedule",
    "enabled": True,
    "rule": {
        "freq": "daily", "interval": 3, "weekdays": [1], "monthMode": "date",
        "monthDay": 1, "ordinal": 1, "weekday": 1, "hour": 9, "minute": 0, "clamp": False,
    },
    "anchor": "2026-08-13",
    "timezone": "America/Los_Angeles",
    "id": "mtr_a",
}


@pytest.fixture
def agent_cfg(tmp_path, monkeypatch):
    """干净的 agent_config.db（形状抄 tests/api/conftest.py::fresh_agent_cfg）。

    刻意走**真实** store 而不是 mock：全局默认是 JSON 落在 owner_settings 的一个字符串，
    序列化/反序列化那一跳正是最容易漂的地方，mock 掉就测不到了。
    """
    from src.agent_config import store as acstore

    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", str(tmp_path / "agent_config.db"))
    acstore.reset_agent_config_store_cache()
    yield acstore.get_agent_config_store()
    acstore.reset_agent_config_store_cache()


def _set_defaults(store, payload: dict | None) -> None:
    store.set_owner_setting(MATTER_AGENT_DEFAULTS_KEY, dump_agent_defaults(payload))


@pytest.fixture
def env(tmp_path, agent_cfg):
    """一个事项 + 一个可选绑定的 profile；`spec_for` 把覆盖存进去再组一次 spec。"""
    path = tmp_path / "defaults.db"
    SyncStore(str(path))
    store = ReportStore(str(path))
    store.create_agent(
        "profile-1", type="custom", enabled=True, title="盯梢者",
        prompt="你说话简洁。", model="profile:model",
    )
    # profile-2 = 绑了 Agent 但**没写模型**的那种（只要人设）—— 它是「全局默认这一层可达」
    # 的证人：profile 留白就该落到全局默认，而不是直接掉到 gateway。
    store.create_agent(
        "profile-2", type="custom", enabled=True, title="只要人设", prompt="你说话简洁。",
    )
    conn = sqlite3.connect(str(path), timeout=30.0)
    try:
        conn.execute(
            "UPDATE report_agent SET fallback_models_json=? WHERE id=?",
            (json.dumps(["profile:fallback"]), "profile-1"),
        )
        conn.commit()
    finally:
        conn.close()
    settings = SimpleNamespace(
        sync_store_db_path=str(path)
    )
    service = MatterRunService(MatterRepository(path))
    counter = {"n": 0}

    def spec_for(*, agent_block=None, bind_profile=None):
        counter["n"] += 1
        tag = f"m{counter['n']}"
        created = service.create_matter(
            {"title": f"Defaults Matter {tag}"},
            idempotency_key=f"create-{tag}", source="desktop_ui",
        )
        pid = created["matter"]["public_id"]
        version = created["version"]
        if bind_profile:
            version = service.patch_matter(
                pid, {"agent_profile_id": bind_profile},
                expected_version=version, idempotency_key=f"bind-{tag}", source="desktop_ui",
            )["version"]
        if agent_block is not None:
            version = service.patch_matter(
                pid,
                {"schedule_json": {"v": 2, "triggers": [SCHEDULE_ENTRY], "agent": agent_block}},
                expected_version=version, idempotency_key=f"cfg-{tag}", source="desktop_ui",
            )["version"]
        run = service.enqueue_run(
            pid, expected_version=version, idempotency_key=f"run-{tag}", source="desktop_ui",
        )["run"]
        job = AsyncJobRepository(str(path)).get(run["async_job_id"])
        return assemble_matter_spec(job, settings=settings)

    return spec_for


# ── 生效链路（本文件的重点）─────────────────────────────────────────────────────


def test_global_defaults_reach_the_spec_when_the_matter_configures_nothing(env, agent_cfg):
    """🔴 本批的核心断言：全局设了、事项没覆盖、没绑 profile ⇒ 三项全部落进 spec。

    只测「PUT 之后 GET 得回来」是不够的 —— 那正是"保存了但不生效"这类 bug 的藏身处。
    """
    _set_defaults(
        agent_cfg,
        {"model": "global:m", "effort": "high", "fallback_models": ["global:fb"]},
    )
    spec = env()
    assert spec["model"] == "global:m"
    assert spec["effort"] == "high"
    assert spec["fallbackModels"] == ["global:fb"]


def test_nothing_configured_anywhere_leaves_the_spec_untouched(env, agent_cfg):
    """没配过 = 一个键都不多投（= gateway 全局默认），与加这层之前逐字一样。"""
    spec = env()
    assert spec["model"] is None
    assert "effort" not in spec
    assert "fallbackModels" not in spec


def test_matter_override_beats_the_global_default(env, agent_cfg):
    _set_defaults(
        agent_cfg,
        {"model": "global:m", "effort": "high", "fallback_models": ["global:fb"]},
    )
    spec = env(
        agent_block={
            "model": "matter:m", "effort": "low", "fallback_models": ["matter:fb"],
        }
    )
    assert spec["model"] == "matter:m"
    assert spec["effort"] == "low"
    assert spec["fallbackModels"] == ["matter:fb"]


def test_bound_profile_beats_the_global_default(env, agent_cfg):
    """🔴 顺序闸：profile 排在全局默认**之前**。

    反过来的话，owner 第一次设全局默认的瞬间，所有已绑 profile 的事项就会静默换掉实际
    跑的模型，且 `report_agent.model` 对事项成为永不生效的死配置 —— 而「改用 Custom Agent
    以更换模型」正是那个下拉写在 UI 上的承诺（i18n `matters.agentBinding.empty`）。
    """
    _set_defaults(agent_cfg, {"model": "global:m", "fallback_models": ["global:fb"]})
    spec = env(bind_profile="profile-1")
    assert spec["model"] == "profile:model"
    assert spec["fallbackModels"] == ["profile:fallback"]


def test_global_default_fills_in_what_the_profile_leaves_blank(env, agent_cfg):
    """profile 只写了人设、没写模型 ⇒ 落到全局默认。

    每一层都必须可达，否则那一层就是死配置 —— 这也是把全局排在 profile 之后仍然有意义的
    原因（绑 Agent 大多是为了人设，模型列常常留空）。
    """
    _set_defaults(agent_cfg, {"model": "global:m", "fallback_models": ["global:fb"]})
    spec = env(bind_profile="profile-2")
    assert spec["model"] == "global:m"
    assert spec["fallbackModels"] == ["global:fb"]


def test_matter_override_beats_the_profile_too(env, agent_cfg):
    """既有语义不许回退：事项级仍是最具体的一层。"""
    _set_defaults(agent_cfg, {"model": "global:m"})
    spec = env(agent_block={"model": "matter:m"}, bind_profile="profile-1")
    assert spec["model"] == "matter:m"


# ── `[]` 的两种「空」不许合成一种 ──────────────────────────────────────────────


def test_explicit_empty_fallback_at_the_global_layer_is_preserved(env, agent_cfg):
    """全局的 `[]` = **显式不设兜底**，要能压过 gateway 的默认兜底链。"""
    _set_defaults(agent_cfg, {"model": "global:m", "fallback_models": []})
    spec = env()
    assert spec["fallbackModels"] == []


def test_global_fallback_does_not_leak_past_a_profile_chain(env, agent_cfg):
    _set_defaults(agent_cfg, {"fallback_models": ["global:fb"]})
    spec = env(bind_profile="profile-1")
    assert spec["fallbackModels"] == ["profile:fallback"]


def test_matter_explicit_empty_fallback_beats_both_lower_layers(env, agent_cfg):
    _set_defaults(agent_cfg, {"fallback_models": ["global:fb"]})
    spec = env(agent_block={"fallback_models": []}, bind_profile="profile-1")
    assert spec["fallbackModels"] == []


# ── effort 的同模型闸 ─────────────────────────────────────────────────────────


def test_global_effort_is_dropped_when_the_matter_runs_another_model(env, agent_cfg):
    """🔴 全局那一档是**为全局默认模型**选的。事项换了模型又没单独设档位时不许带过去 ——
    档位阶梯按模型家族给，对无 reasoning 能力的模型下发 effort 会往 wire 上塞多余参数
    （16b 契约）；事项级 UI 为此禁止「没选模型就配档位」，跨层守的是同一条。"""
    _set_defaults(agent_cfg, {"model": "global:m", "effort": "high"})
    spec = env(agent_block={"model": "matter:m"})
    assert spec["model"] == "matter:m"
    assert "effort" not in spec


def test_global_effort_is_dropped_when_a_profile_supplies_the_model(env, agent_cfg):
    _set_defaults(agent_cfg, {"model": "global:m", "effort": "high"})
    spec = env(bind_profile="profile-1")
    assert spec["model"] == "profile:model"
    assert "effort" not in spec


def test_global_effort_applies_when_the_matter_pins_the_very_same_model(env, agent_cfg):
    """同一个模型 ⇒ 那一档本来就是为它选的，照常下发。"""
    _set_defaults(agent_cfg, {"model": "global:m", "effort": "high"})
    spec = env(agent_block={"model": "global:m"})
    assert spec["effort"] == "high"


def test_global_effort_without_a_global_model_is_never_sent(env, agent_cfg):
    """UI 不产生这种组合（选档位前必须先选模型），但库里可能被手改出来 ——
    此时下发就等于对一个**未知**模型猜档位，宁可不发。"""
    _set_defaults(agent_cfg, {"effort": "high"})
    spec = env()
    assert "effort" not in spec


def test_matter_effort_override_still_wins_regardless_of_model(env, agent_cfg):
    """同模型闸只罩全局那一层：事项级是 owner 对这件事的显式选择，不受它约束。"""
    _set_defaults(agent_cfg, {"model": "global:m", "effort": "high"})
    spec = env(agent_block={"model": "matter:m", "effort": "low"})
    assert spec["effort"] == "low"


# ── 结构红线 ────────────────────────────────────────────────────────────────────


def test_global_defaults_do_not_touch_the_tool_face_or_budget(env, agent_cfg):
    _set_defaults(agent_cfg, {"model": "global:m", "effort": "max"})
    spec = env()
    assert spec["toolPolicy"]["allowedTools"] == []
    assert "grantExec" not in spec["toolPolicy"]
    assert spec["budget"]["maxRunSeconds"] == 1800


# ── 存取层的宽容读侧 ────────────────────────────────────────────────────────────


def test_load_is_lenient_about_missing_and_broken_rows(agent_cfg):
    """读不出来 ⇒ 退回「没配过」（= 加这层之前的行为），绝不让跟进 run 跑不起来。"""
    assert load_agent_defaults() == {}
    agent_cfg.set_owner_setting(MATTER_AGENT_DEFAULTS_KEY, "{ not json")
    assert load_agent_defaults() == {}
    agent_cfg.set_owner_setting(MATTER_AGENT_DEFAULTS_KEY, json.dumps(["nope"]))
    assert load_agent_defaults() == {}
    # 半坏的块：认不出的字段丢掉、剩下的照用（同 parse_agent_overrides 的取舍）
    agent_cfg.set_owner_setting(
        MATTER_AGENT_DEFAULTS_KEY, json.dumps({"model": "global:m", "effort": "turbo"})
    )
    assert load_agent_defaults() == {"model": "global:m"}


def test_clearing_writes_an_empty_object_rather_than_leaving_the_old_row(agent_cfg):
    """🔴 「清空」必须能表达 —— 留着旧行会让界面上刚清掉的值在下一轮 run 里复活。"""
    _set_defaults(agent_cfg, {"model": "global:m"})
    assert load_agent_defaults() == {"model": "global:m"}
    _set_defaults(agent_cfg, None)
    assert load_agent_defaults() == {}


def test_store_survives_a_restart(agent_cfg):
    from src.agent_config.store import AgentConfigStore

    _set_defaults(agent_cfg, {"model": "global:m", "fallback_models": []})
    restarted = AgentConfigStore(agent_cfg.db_path)
    assert json.loads(restarted.get_owner_setting(MATTER_AGENT_DEFAULTS_KEY)) == {
        "fallback_models": [],
        "model": "global:m",
    }
