"""matter_lookup skill（对外事项只读）—— 字段白名单（跟进配置与指令不出现）/ include 不开放
followup / 子列表封顶 / limit 越界拒 / 不存在的 id → E_NOT_FOUND / 告警列表截断标记。
"""

from __future__ import annotations

import json
import sqlite3
from types import SimpleNamespace

import pytest

from src.mail.sync_store import SyncStore
from src.skills.builtin import matter_lookup as matter_skill
from src.skills.context import SkillContext
from src.skills.errors import SkillError

FIND_FIELDS = {"public_id", "title", "type", "tags", "status", "health", "priority", "due_at",
               "current_summary", "version", "matched_fields", "snippet"}
FORBIDDEN_MATTER = {"matter_instructions", "schedule_json", "agent_profile_id", "agent_enabled",
                    "owner_id", "id"}
ATTENTION_FIELDS = set(matter_skill._ATTENTION_FIELDS)


@pytest.fixture
def ctx(tmp_path):
    path = str(tmp_path / "sync.db")
    SyncStore(path)
    conn = sqlite3.connect(path)
    try:
        conn.execute(
            "INSERT INTO matter (id, public_id, title, goal, status, matter_instructions, schedule_json, "
            "agent_profile_id, created_at, updated_at) VALUES (1, 'MAT-0001', 'Atlas rollout', "
            "'ship atlas', 'active', 'SECRET FOLLOWUP INSTRUCTIONS', ?, 'profile-x', 1, 2)",
            (json.dumps({"v": 1, "triggers": []}),),
        )
        conn.execute(
            "INSERT INTO matter (id, public_id, title, created_at, updated_at) "
            "VALUES (2, 'MAT-0002', 'Budget review', 1, 1)"
        )
        for title in ("draft plan", "book venue"):
            conn.execute(
                "INSERT INTO matter_item (matter_id, kind, title, created_by_kind, created_at, updated_at) "
                "VALUES (1, 'action', ?, 'user', 1, 1)",
                (title,),
            )
        for matter_id, key, opened in ((1, "a", 10), (2, "b", 20)):
            conn.execute(
                "INSERT INTO matter_attention (matter_id, kind, subject_key, severity, why, "
                "first_opened_at, last_observed_at) VALUES (?, 'action_overdue', ?, 'warn', 'late', ?, ?)",
                (matter_id, key, opened, opened),
            )
        conn.commit()
    finally:
        conn.close()
    return SkillContext(config=SimpleNamespace(sync_store_db_path=path))


def test_find_returns_gateway_summary(ctx):
    # 直写的种子行没有全文检索文档（那由 MatterService 写面维护），这里用结构化过滤命中。
    data = matter_skill._matter_find(ctx, {"status": "active"})
    assert data["count"] == 1
    row = data["items"][0]
    assert set(row) == FIND_FIELDS
    assert row["public_id"] == "MAT-0001"


@pytest.mark.parametrize("limit", [0, 51])
def test_find_limit_out_of_range_rejected(ctx, limit):
    with pytest.raises(SkillError) as ei:
        matter_skill._matter_find(ctx, {"limit": limit})
    assert ei.value.code == "E_INVALID_ARG"


def test_find_rejects_bad_status(ctx):
    with pytest.raises(SkillError) as ei:
        matter_skill._matter_find(ctx, {"status": "someday"})
    assert ei.value.code == "E_INVALID_ARG"


def test_get_hides_followup_config_and_instructions(ctx):
    data = matter_skill._matter_get(ctx, {"public_id": "MAT-0001"})
    assert set(data) == {"matter", "items", "stakeholders", "truncated"}
    matter = data["matter"]
    assert set(matter) == set(matter_skill._MATTER_FIELDS)
    assert not (FORBIDDEN_MATTER & set(matter))
    assert "SECRET FOLLOWUP INSTRUCTIONS" not in json.dumps(data)
    assert [i["title"] for i in data["items"]] == ["draft plan", "book venue"]
    assert data["truncated"] == {"items": False, "stakeholders": False}


def test_get_timeline_hides_followup_binding_changes(ctx):
    # 改跟进指令会落一条 agent_binding_changed 事件，payload.changes 带指令前后值 —— 时间线
    # 子列表是服务端原样行，不过滤就把 matter 白名单刚去掉的指令从这里漏出去。
    from src.matters.repository import MatterRepository
    from src.matters.service import MatterService

    service = MatterService(MatterRepository(ctx.config().sync_store_db_path))
    service.patch_matter(
        "MAT-0002",
        {"matter_instructions": "LEAKED VIA TIMELINE", "title": "Budget review v2"},
        expected_version=1,
        idempotency_key="k-binding",
        source="test",
    )
    data = matter_skill._matter_get(ctx, {"public_id": "MAT-0002", "include": ["timeline"]})
    assert "LEAKED VIA TIMELINE" not in json.dumps(data, ensure_ascii=False)
    assert "matter_instructions" not in json.dumps(data)
    kinds = [e["kind"] for e in data["timeline"]]
    assert "agent_binding_changed" not in kinds
    assert "matter_updated" in kinds  # 其余事件照常给


def test_get_rejects_followup_include(ctx):
    with pytest.raises(SkillError) as ei:
        matter_skill._matter_get(ctx, {"public_id": "MAT-0001", "include": ["followup"]})
    assert ei.value.code == "E_INVALID_ARG"


def test_get_caps_sublists(ctx, monkeypatch):
    monkeypatch.setattr(matter_skill, "_SUBLIST_CAP", 1)
    data = matter_skill._matter_get(ctx, {"public_id": "MAT-0001", "include": ["items", "timeline"]})
    assert len(data["items"]) == 1
    assert data["truncated"]["items"] is True


def test_get_unknown_matter_is_not_found(ctx):
    with pytest.raises(SkillError) as ei:
        matter_skill._matter_get(ctx, {"public_id": "MAT-9999"})
    assert ei.value.code == "E_NOT_FOUND" and ei.value.http_status == 404


def test_attention_list_sweeps_all_and_marks_truncation(ctx):
    data = matter_skill._matter_attention_list(ctx, {})
    assert data["count"] == 2 and data["truncated"] is False
    assert set(data["items"][0]) == ATTENTION_FIELDS
    assert data["items"][0]["matter"]["public_id"] == "MAT-0002"  # newest first
    cut = matter_skill._matter_attention_list(ctx, {"limit": 1})
    assert cut["count"] == 1 and cut["truncated"] is True


@pytest.mark.parametrize("limit", [0, 101])
def test_attention_limit_out_of_range_rejected(ctx, limit):
    with pytest.raises(SkillError) as ei:
        matter_skill._matter_attention_list(ctx, {"limit": limit})
    assert ei.value.code == "E_INVALID_ARG"


def test_attention_unknown_matter_is_not_found(ctx):
    with pytest.raises(SkillError) as ei:
        matter_skill._matter_attention_list(ctx, {"public_id": "MAT-9999"})
    assert ei.value.code == "E_NOT_FOUND"
