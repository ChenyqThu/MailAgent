"""事项级模型覆盖（0813 dogfood 轮 3 反馈 #10）：model / effort / fallback。

owner 原话：「跟进规则页面，matter agent 配置，仍然没有模型配置、effort 配置、fallback 配置」。

本文件盯三件事：
1. **存得下**（`triggers.normalize_agent_overrides` 写侧值域 + envelope 的空折叠规则）——
   🔴 重点是「把触发方式全删光」不许把刚配好的三项一起抹掉；
2. **读得回**（`parse_agent_overrides` 宽容读侧，v1 老行不炸）；
3. **真生效**（`assemble_matter_spec` 把三项投进 spec 的 model / effort / fallbackModels）——
   gateway 侧的消费在 `frontend/tests/ai-gateway/agent_run.test.ts`，两头都有断言才算闭环，
   只测"存进去了"就是在给一个可能永远不生效的配置发合格证。
"""

from __future__ import annotations

import json
import sqlite3
from types import SimpleNamespace

import pytest

from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.run_service import MatterRunService
from src.matters.run_spec import assemble_matter_spec
from src.matters.service import MatterError
from src.matters.triggers import (
    MATTER_AGENT_MAX_FALLBACK_MODELS,
    MATTER_AGENT_MODEL_MAX_CHARS,
    TriggerError,
    normalize_agent_overrides,
    normalize_trigger_json,
    parse_agent_overrides,
)
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


# ── 写侧值域 ────────────────────────────────────────────────────────────────────


def test_valid_overrides_survive_normalization():
    assert normalize_agent_overrides(
        {"model": " default:m1 ", "effort": "high", "fallback_models": ["default:m2"]}
    ) == {"model": "default:m1", "effort": "high", "fallback_models": ["default:m2"]}


def test_nothing_configured_collapses_to_none():
    """一项都没覆盖 = 不写这个键（让"没配过"和"配成默认"在库里长得一样）。"""
    assert normalize_agent_overrides(None) is None
    assert normalize_agent_overrides({}) is None
    assert normalize_agent_overrides({"model": None, "effort": None}) is None


def test_explicit_empty_fallback_list_is_preserved():
    """🔴 `[]` = **显式不设兜底**，与"没配过"不是一回事 —— 折掉它就会让绑定 profile 的
    兜底链偷偷跑回来。"""
    assert normalize_agent_overrides({"fallback_models": []}) == {"fallback_models": []}


@pytest.mark.parametrize(
    "payload",
    [
        {"effort": "turbo"},           # 值域外档位
        {"effort": 3},                 # 类型不对
        {"model": 42},
        {"model": "   "},
        {"model": "m" * (MATTER_AGENT_MODEL_MAX_CHARS + 1)},
        {"fallback_models": "default:m2"},   # 不是列表
        {"fallback_models": [f"m{i}" for i in range(MATTER_AGENT_MAX_FALLBACK_MODELS + 1)]},
        "not-an-object",
    ],
)
def test_out_of_range_values_are_rejected_on_write(payload):
    """🔴 入库即拒，不静默丢：存下一个跑不起来的档位 = UI 显示的和真跑的劈叉。"""
    with pytest.raises(TriggerError):
        normalize_agent_overrides(payload)


def test_fallback_list_dedupes_in_order():
    assert normalize_agent_overrides(
        {"fallback_models": ["default:m2", "default:m2", "default:m3"]}
    ) == {"fallback_models": ["default:m2", "default:m3"]}


# ── envelope 的空折叠规则 ───────────────────────────────────────────────────────


def test_envelope_survives_when_all_triggers_are_removed_but_overrides_remain():
    """🔴 本批最容易踩的坑：触发方式清空 → 老规则整列写 NULL → 模型覆盖一起没了，
    而界面上看不出任何异常。"""
    envelope = normalize_trigger_json({"v": 2, "triggers": [], "agent": {"model": "default:m1"}})
    assert envelope is not None
    assert envelope["triggers"] == []
    assert envelope["agent"] == {"model": "default:m1"}


def test_envelope_still_collapses_when_nothing_is_configured_at_all():
    assert normalize_trigger_json({"v": 2, "triggers": []}) is None
    assert normalize_trigger_json(None) is None


def test_overrides_ride_along_with_triggers_and_actions():
    envelope = normalize_trigger_json(
        {
            "v": 2,
            "triggers": [SCHEDULE_ENTRY],
            "actions": ["summary", "items", "draft"],
            "agent": {"effort": "low"},
        }
    )
    assert envelope is not None
    assert len(envelope["triggers"]) == 1
    assert envelope["actions"] == ["summary", "items", "draft"]
    assert envelope["agent"] == {"effort": "low"}


# ── 读侧宽容 ────────────────────────────────────────────────────────────────────


def test_read_side_is_lenient_and_never_raises():
    """跟进 run 不该因为一段可选覆盖认不出来就跑不起来（同 parse_run_actions 的取舍）。"""
    assert parse_agent_overrides(None) == {}
    assert parse_agent_overrides("{ not json") == {}
    assert parse_agent_overrides(json.dumps({"v": 2, "triggers": []})) == {}
    # v1 老行（单个 schedule 对象）：没有 agent 键 → 全跟随
    assert parse_agent_overrides(json.dumps(SCHEDULE_ENTRY)) == {}
    # 半坏的块：认不出的字段丢掉，剩下的照用
    assert parse_agent_overrides(
        json.dumps({"v": 2, "triggers": [], "agent": {"model": "default:m1", "effort": "turbo"}})
    ) == {"model": "default:m1"}


# ── 真生效：spec 三通道 ─────────────────────────────────────────────────────────


@pytest.fixture
def env(tmp_path):
    """绑定了一个 profile（model + fallback 都有值）的事项 —— 覆盖必须能压过它。"""
    path = tmp_path / "overrides.db"
    SyncStore(str(path))
    store = ReportStore(str(path))
    store.create_agent(
        "profile-1", type="custom", enabled=True, title="盯梢者",
        prompt="你说话简洁。", model="profile:model",
    )
    # fallback 是 v29 的行级列，create_agent 不写它（见其 docstring：report 专属列留 NULL）。
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
    created = service.create_matter(
        {"title": "Override Matter"}, idempotency_key="create", source="desktop_ui"
    )
    pid = created["matter"]["public_id"]
    version = service.patch_matter(
        pid, {"agent_profile_id": "profile-1"},
        expected_version=created["version"], idempotency_key="bind", source="desktop_ui",
    )["version"]

    def spec_for(agent_block, *, base_version=version):
        """把覆盖块存进去，再组一次 spec。"""
        current = base_version
        if agent_block is not None:
            current = service.patch_matter(
                pid,
                {"schedule_json": {"v": 2, "triggers": [SCHEDULE_ENTRY], "agent": agent_block}},
                expected_version=current, idempotency_key=f"cfg-{id(agent_block)}",
                source="desktop_ui",
            )["version"]
        run = service.enqueue_run(
            pid, expected_version=current, idempotency_key=f"run-{id(agent_block)}",
            source="desktop_ui",
        )["run"]
        job = AsyncJobRepository(str(path)).get(run["async_job_id"])
        return assemble_matter_spec(job, settings=settings)

    return spec_for


def test_without_overrides_the_spec_follows_the_bound_profile(env):
    spec = env(None)
    assert spec["model"] == "profile:model"
    assert spec["fallbackModels"] == ["profile:fallback"]
    assert "effort" not in spec


def test_overrides_reach_all_three_spec_channels(env):
    spec = env({"model": "default:m1", "effort": "high", "fallback_models": ["default:m2"]})
    assert spec["model"] == "default:m1"
    assert spec["effort"] == "high"
    assert spec["fallbackModels"] == ["default:m2"]


def test_partial_override_leaves_the_other_channels_following(env):
    spec = env({"effort": "low"})
    assert spec["model"] == "profile:model"          # 没覆盖 → 跟随 profile
    assert spec["fallbackModels"] == ["profile:fallback"]
    assert spec["effort"] == "low"


def test_explicit_empty_fallback_override_beats_the_profile_chain(env):
    """「不设兜底」必须能压过 profile 的兜底链，否则这个选项就是装饰。"""
    spec = env({"fallback_models": []})
    assert spec["fallbackModels"] == []


def test_overrides_do_not_touch_the_tool_face_or_grants(env):
    """🔴 结构红线：覆盖只碰模型三键。"""
    spec = env({"model": "default:m1", "effort": "max"})
    assert spec["toolPolicy"]["allowedTools"] == []
    assert "grantExec" not in spec["toolPolicy"]
    assert spec["budget"]["maxRunSeconds"] == 1800


# ── REST 写面 ───────────────────────────────────────────────────────────────────


def test_patch_route_rejects_an_out_of_range_effort(tmp_path):
    path = tmp_path / "rest.db"
    SyncStore(str(path))
    service = MatterRunService(MatterRepository(path))
    created = service.create_matter(
        {"title": "Reject"}, idempotency_key="create", source="desktop_ui"
    )
    with pytest.raises(MatterError) as exc:
        service.patch_matter(
            created["matter"]["public_id"],
            {"schedule_json": {"v": 2, "triggers": [SCHEDULE_ENTRY], "agent": {"effort": "turbo"}}},
            expected_version=created["version"], idempotency_key="bad", source="desktop_ui",
        )
    assert exc.value.code == "E_INVALID_ARG"
