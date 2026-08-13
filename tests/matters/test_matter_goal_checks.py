"""P6-B D5/D7：完成标志 checklist 的护栏与权限。"""

from __future__ import annotations

import pytest

from src.mail.sync_store import SyncStore
from src.matters.models import MAX_GOAL_CHECKS, normalize_goal_checks
from src.matters.repository import MatterRepository
from src.matters.service import Actor, MatterError, MatterService

NOW = 1_760_000_000_000


def _service(tmp_path):
    path = tmp_path / "goal.db"
    SyncStore(str(path))
    return MatterService(MatterRepository(str(path)), clock_ms=lambda: NOW)


def test_new_matter_starts_with_empty_goal_checks(tmp_path):
    service = _service(tmp_path)
    result = service.create_matter({"title": "g"}, idempotency_key="c", source="test")
    assert result["matter"]["goal_checks"] == []


def test_user_can_set_and_toggle_goal_checks(tmp_path):
    service = _service(tmp_path)
    matter = service.create_matter({"title": "g"}, idempotency_key="c", source="test")["matter"]
    updated = service.patch_matter(
        matter["public_id"],
        {"goal_checks": [{"t": "合同已签署", "done": False}, {"t": "款项已到账", "done": True}]},
        idempotency_key="p1", source="test", expected_version=matter["version"],
        actor=Actor(kind="user", actor_id="me"),
    )["matter"]
    assert updated["goal_checks"] == [
        {"t": "合同已签署", "done": False},
        {"t": "款项已到账", "done": True},
    ]


def test_agent_cannot_write_goal_checks(tmp_path):
    """🔴 D7：目标与完成标志是用户写的，自动 run 恒不可改写。"""
    service = _service(tmp_path)
    matter = service.create_matter({"title": "g"}, idempotency_key="c", source="test")["matter"]
    with pytest.raises(MatterError) as excinfo:
        service.patch_matter(
            matter["public_id"], {"goal_checks": [{"t": "x", "done": True}]},
            idempotency_key="p1", source="test", expected_version=matter["version"],
            actor=Actor(kind="agent", actor_id="a"),
        )
    assert excinfo.value.code == "E_INVALID_ARG"


def test_create_accepts_goal_checks_and_snapshot_projects_them(tmp_path):
    """0813 轮 3 O2：创建面开放（create 时 agent 可写「怎样算做完」）+ 可见面
    （context_snapshot 投出 goal_checks —— 跟进 run 与事项对话的完成判据）。"""
    service = _service(tmp_path)
    matter = service.create_matter(
        {
            "title": "g",
            "goal_checks": [{"t": "合同已签署"}, {"t": "款项已到账", "done": True}],
        },
        idempotency_key="c",
        source="test",
    )["matter"]
    assert matter["goal_checks"] == [
        {"t": "合同已签署", "done": False},
        {"t": "款项已到账", "done": True},
    ]
    snapshot = service.context_snapshot(matter["public_id"])
    assert snapshot["matter"]["goal_checks"] == matter["goal_checks"]


def test_create_rejects_malformed_goal_checks(tmp_path):
    """create 面与 patch 面同一道值域闸（normalize_goal_checks 单源，400 E_INVALID_ARG）。"""
    service = _service(tmp_path)
    with pytest.raises(MatterError) as excinfo:
        service.create_matter(
            {"title": "g", "goal_checks": [{"t": "x" * 500}]},
            idempotency_key="c",
            source="test",
        )
    assert excinfo.value.code == "E_INVALID_ARG"


def test_blank_entries_are_dropped_not_stored():
    assert normalize_goal_checks([{"t": "  ", "done": False}, {"t": "real"}]) == (
        {"t": "real", "done": False},
    )


def test_guardrails_reject_oversized_input():
    with pytest.raises(ValueError):
        normalize_goal_checks([{"t": "x" * 500}])
    with pytest.raises(ValueError):
        normalize_goal_checks([{"t": f"c{i}"} for i in range(MAX_GOAL_CHECKS + 5)])
    with pytest.raises(ValueError):
        normalize_goal_checks(["not an object"])
