"""S3 —— 核心目标 / 完成标志进提案面（08-18）。

owner 裁决：main agent（本人在场）直写 + 恒 ask 审批卡；**跟进 Agent 只能提案**。

本文件钉三件事：
1. 提案白名单与 stale 判据的目标集**永远一致**（漏一个 = 静默覆盖 owner 的手写值）
2. accept 能把两个字段落库，且非法形状照样炸（护栏不因「是提案来的」而绕过）
3. stale 语义：owner 手改 → 带同一字段的旧提案作废；改不相干字段 → 不作废
"""

from __future__ import annotations

import pytest

from src.mail.sync_store import SyncStore
from src.matters.models import MAX_GOAL_CHECKS, MAX_GOAL_CHECK_LENGTH
from src.matters.proposal_scope import (
    PROPOSAL_TOUCHABLE_FIELDS,
    _COLUMN_TO_FIELD,
    scope_from_matter_columns,
)
from src.matters.repository import MatterRepository
from src.matters.run_service import PROPOSAL_FIELD_WHITELIST, MatterRunService
from src.matters.service import Actor, MatterError, MatterService

NOW = 1_760_000_000_000


def _services(tmp_path):
    path = tmp_path / "goal.db"
    SyncStore(str(path))
    repo = MatterRepository(str(path))
    return MatterService(repo, clock_ms=lambda: NOW), MatterRunService(repo, clock_ms=lambda: NOW)


def _matter(service):
    return service.create_matter(
        {"title": "t", "description": "老的目标"}, idempotency_key="c", source="test"
    )["matter"]


def _propose(service, run_service, matter, changes, *, key="run-1"):
    """建一个 run 并在其中落提案（propose 是 run 语境专属，签名不带 mutation 信封）。"""
    run = run_service.enqueue_run(
        matter["public_id"],
        expected_version=service.get_matter(matter["public_id"])["matter"]["version"],
        idempotency_key=key,
        source="test",
    )["run"]
    run_service.mark_started(run["id"])
    return run_service.propose_update(
        matter["public_id"], run["id"], {"summary": "s", "changes": changes}
    )


def _field_change(change_id, field, after):
    return {
        "id": change_id,
        "kind": "field",
        "target": {"entity": "matter", "field": field},
        "operation": "replace",
        "after": after,
        "sources": [],
        "text": f"{field} 变更",
    }


# ============================================================
# 1 — 两张清单必须一致
# ============================================================

def test_whitelist_is_a_subset_of_the_stale_scope():
    """🔴 提案能改的字段，必须都在 stale 判据的目标集里。

    漏一个的后果不是「少作废一次」，而是：owner 手改了那个字段，Agent 那份带旧文案的
    提案**不算 stale**，accept 时静默覆盖 owner 刚写的新值。`proposal_scope.py` 的
    文件头把这条列为 fail-closed 硬要求。
    """
    missing = set(PROPOSAL_FIELD_WHITELIST) - PROPOSAL_TOUCHABLE_FIELDS
    assert missing == set(), (
        f"这些字段能提案却不在 stale 目标集里，accept 会静默覆盖 owner 的手写值：{sorted(missing)}"
    )


def test_goal_checks_column_is_mapped_to_its_canonical_name():
    """🔴 列名 ≠ 字段名的必须有映射，否则写入侧推不出目标 ⇒ 同样静默覆盖。"""
    assert _COLUMN_TO_FIELD.get("goal_checks_json") == "goal_checks"
    scope = scope_from_matter_columns({"goal_checks_json": "[]"})
    assert "goal_checks" in scope.fields


def test_description_needs_no_mapping_but_is_still_derived():
    scope = scope_from_matter_columns({"description": "x"})
    assert "description" in scope.fields


# ============================================================
# 2 — accept 落库 + 护栏
# ============================================================

def test_accept_applies_description(tmp_path):
    service, run_service = _services(tmp_path)
    matter = _matter(service)
    proposal = _propose(service, run_service, matter, [_field_change("c1", "description", "新的目标")])
    service.accept_update(
        matter["public_id"], proposal["update_id"],
        idempotency_key="a1", source="test",
        expected_version=service.get_matter(matter["public_id"])["matter"]["version"],
        actor=Actor(kind="user", actor_id="me"),
    )
    assert service.get_matter(matter["public_id"])["matter"]["description"] == "新的目标"


def test_accept_applies_goal_checks(tmp_path):
    service, run_service = _services(tmp_path)
    matter = _matter(service)
    checks = [{"t": "合同已签", "done": False}, {"t": "款已到账", "done": True}]
    proposal = _propose(service, run_service, matter, [_field_change("c1", "goal_checks", checks)])
    service.accept_update(
        matter["public_id"], proposal["update_id"],
        idempotency_key="a1", source="test",
        expected_version=service.get_matter(matter["public_id"])["matter"]["version"],
        actor=Actor(kind="user", actor_id="me"),
    )
    assert service.get_matter(matter["public_id"])["matter"]["goal_checks"] == checks


@pytest.mark.parametrize(
    "bad",
    [
        [{"t": "x" * (MAX_GOAL_CHECK_LENGTH + 1), "done": False}],
        [{"t": f"c{i}", "done": False} for i in range(MAX_GOAL_CHECKS + 1)],
        ["not-an-object"],
    ],
)
def test_accept_still_enforces_goal_check_guardrails(tmp_path, bad):
    """🔴 护栏不因「是提案来的」就绕过。propose 侧先 drop 一轮，这里是 backstop。"""
    service, run_service = _services(tmp_path)
    matter = _matter(service)
    proposal = _propose(service, run_service, matter, [_field_change("c1", "goal_checks", bad)])
    if proposal["dropped"]:
        return  # propose 侧已经 drop 掉了 —— 那是更早的一道闸，同样合格
    with pytest.raises(MatterError):
        service.accept_update(
            matter["public_id"], proposal["update_id"],
            idempotency_key="a1", source="test",
            expected_version=service.get_matter(matter["public_id"])["matter"]["version"],
            actor=Actor(kind="user", actor_id="me"),
        )


# ============================================================
# 3 — stale 语义
# ============================================================

def test_owner_editing_the_same_field_makes_the_proposal_stale(tmp_path):
    """🔴 本子任务最要紧的一条：owner 手改核心目标 → Agent 那份旧提案作废。

    没有它，accept 会把 Agent 基于**旧文案**写的版本盖回去。
    """
    service, run_service = _services(tmp_path)
    matter = _matter(service)
    proposal = _propose(service, run_service, matter, [_field_change("c1", "description", "Agent 写的目标")])
    service.patch_matter(
        matter["public_id"], {"description": "owner 亲手写的目标"},
        idempotency_key="p-owner", source="test",
        expected_version=service.get_matter(matter["public_id"])["matter"]["version"],
        actor=Actor(kind="user", actor_id="me"),
    )
    with pytest.raises(MatterError) as exc:
        service.accept_update(
            matter["public_id"], proposal["update_id"],
            idempotency_key="a1", source="test",
            expected_version=service.get_matter(matter["public_id"])["matter"]["version"],
            actor=Actor(kind="user", actor_id="me"),
        )
    assert exc.value.code == "E_UPDATE_STALE"
    assert service.get_matter(matter["public_id"])["matter"]["description"] == "owner 亲手写的目标"


def test_goal_checks_edit_also_makes_the_proposal_stale(tmp_path):
    service, run_service = _services(tmp_path)
    matter = _matter(service)
    proposal = _propose(
        service, run_service, matter,
        [_field_change("c1", "goal_checks", [{"t": "agent", "done": False}])],
    )
    service.patch_matter(
        matter["public_id"], {"goal_checks": [{"t": "owner", "done": False}]},
        idempotency_key="p-owner", source="test",
        expected_version=service.get_matter(matter["public_id"])["matter"]["version"],
        actor=Actor(kind="user", actor_id="me"),
    )
    with pytest.raises(MatterError) as exc:
        service.accept_update(
            matter["public_id"], proposal["update_id"],
            idempotency_key="a1", source="test",
            expected_version=service.get_matter(matter["public_id"])["matter"]["version"],
            actor=Actor(kind="user", actor_id="me"),
        )
    assert exc.value.code == "E_UPDATE_STALE"


def test_unrelated_edit_does_not_invalidate_the_proposal(tmp_path):
    """反向：改标签这类提案碰不到的字段，不该把正等着审的提案作废。

    （`proposal_scope` 存在的全部理由 —— 钝化成「版本号前进即作废」时，owner 在评审期间
    点几下标签就把自己正要审的提案废了。）
    """
    service, run_service = _services(tmp_path)
    matter = _matter(service)
    proposal = _propose(service, run_service, matter, [_field_change("c1", "description", "新目标")])
    service.patch_matter(
        matter["public_id"], {"tags": ["销售"]},
        idempotency_key="p-tag", source="test",
        expected_version=service.get_matter(matter["public_id"])["matter"]["version"],
        actor=Actor(kind="user", actor_id="me"),
    )
    service.accept_update(
        matter["public_id"], proposal["update_id"],
        idempotency_key="a1", source="test",
        expected_version=service.get_matter(matter["public_id"])["matter"]["version"],
        actor=Actor(kind="user", actor_id="me"),
    )
    assert service.get_matter(matter["public_id"])["matter"]["description"] == "新目标"


# ============================================================
# 4 — headless run 仍然不能直写
# ============================================================

def test_agent_actor_still_cannot_patch_directly(tmp_path):
    """🔴 放开的是**提案**面，不是直写面。跟进 run 无人值守 + 有网络出口，
    这条守卫是它与「改掉 owner 的目标陈述」之间唯一的东西。"""
    service, _ = _services(tmp_path)
    matter = _matter(service)
    for field, value in (("description", "agent 直写"), ("goal_checks", [{"t": "x", "done": False}])):
        with pytest.raises(MatterError) as exc:
            service.patch_matter(
                matter["public_id"], {field: value},
                idempotency_key=f"p-{field}", source="test",
                expected_version=service.get_matter(matter["public_id"])["matter"]["version"],
                actor=Actor(kind="agent", actor_id="followup"),
            )
        assert exc.value.code == "E_INVALID_ARG"
