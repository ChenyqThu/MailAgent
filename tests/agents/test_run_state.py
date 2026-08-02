"""derive_agent_run_state 单测（S4 W4, ADR D4/Q6）—— paused_handoff 读侧语义全枚举 + 边界。

铁律锚点：``status=succeeded && outcome='paused_handoff'`` 的任何 approval_state 组合都
**不映射到 'completed'**（「等审批 ≠ 成功完成」）；expired 不写库、纯读侧按龄推导。
"""
from __future__ import annotations

import json

import pytest

from src.agents.run_state import (
    AGENT_RUN_STATES,
    APPROVAL_PENDING_TTL_SEC,
    derive_agent_run_state,
)

_NOW = 1_800_000_000.0


def _row(status="succeeded", *, result=None, result_json=None, finished_at=_NOW,
         updated_at=_NOW):
    row = {"status": status, "finished_at": finished_at, "updated_at": updated_at}
    if result is not None:
        row["result"] = result
    if result_json is not None:
        row["result_json"] = result_json
    return row


def _paused(approval_state=None, **kw):
    result = {"sessionId": 3, "steps": 2, "outcome": "paused_handoff"}
    if approval_state is not None:
        result["approval_state"] = approval_state
    return _row(result=result, **kw)


# ---------------------------------------------------------------------------
# 活跃态 + 非成功终态
# ---------------------------------------------------------------------------


def test_queued_and_running_pass_through():
    assert derive_agent_run_state(_row("queued"), now_fn=lambda: _NOW) == "queued"
    assert derive_agent_run_state(_row("running"), now_fn=lambda: _NOW) == "running"


@pytest.mark.parametrize("status", ["failed", "aborted", "partial_failure", "weird_status", None])
def test_non_succeeded_terminal_is_failed(status):
    # E_ORPHANED / worker failed / 未知 status 全收敛 failed（绝不落成成功/等审批形态）。
    assert derive_agent_run_state(_row(status), now_fn=lambda: _NOW) == "failed"


# ---------------------------------------------------------------------------
# succeeded：completed vs paused_handoff（🔴 纪律核心）
# ---------------------------------------------------------------------------


def test_succeeded_completed_outcome_is_completed():
    row = _row(result={"sessionId": 9, "steps": 3, "outcome": "completed"})
    assert derive_agent_run_state(row, now_fn=lambda: _NOW) == "completed"


def test_succeeded_missing_result_json_is_completed():
    # 边界：缺 result_json → 无法证明 paused（worker 对 paused 恒写 outcome）→ completed。
    assert derive_agent_run_state(_row(), now_fn=lambda: _NOW) == "completed"


def test_paused_handoff_never_maps_to_completed():
    """铁律的机械化：paused_handoff × 全部 approval_state 组合，无一映射 'completed'。"""
    for approval in (None, "pending", "approved", "rejected", "garbage"):
        state = derive_agent_run_state(_paused(approval), now_fn=lambda: _NOW)
        assert state != "completed", f"approval_state={approval!r} rendered as success"
        assert state in AGENT_RUN_STATES


def test_paused_pending_within_ttl():
    row = _paused("pending", finished_at=_NOW - 60)
    assert derive_agent_run_state(row, now_fn=lambda: _NOW) == "paused_pending"


def test_paused_expired_after_ttl():
    row = _paused("pending", finished_at=_NOW - APPROVAL_PENDING_TTL_SEC - 1)
    assert derive_agent_run_state(row, now_fn=lambda: _NOW) == "paused_expired"


def test_paused_exactly_at_ttl_still_pending():
    # 边界：恰 30min（age == TTL）→ 仍 pending（ADR 措辞 age>TTL 才过期）。
    row = _paused("pending", finished_at=_NOW - APPROVAL_PENDING_TTL_SEC)
    assert derive_agent_run_state(row, now_fn=lambda: _NOW) == "paused_pending"


def test_paused_missing_approval_state_treated_as_pending_then_aged():
    # 边界：缺 approval_state（worker 恒写 pending, 缺失=保守按 pending）→ 仍走龄推导。
    fresh = _paused(None, finished_at=_NOW - 10)
    stale = _paused(None, finished_at=_NOW - APPROVAL_PENDING_TTL_SEC - 10)
    assert derive_agent_run_state(fresh, now_fn=lambda: _NOW) == "paused_pending"
    assert derive_agent_run_state(stale, now_fn=lambda: _NOW) == "paused_expired"


def test_paused_no_timestamp_fail_closed_expired():
    # 无 finished_at/updated_at 可依 → 无法证明 stash 仍活 → 视为过期（不可批）。
    row = _paused("pending", finished_at=None, updated_at=None)
    assert derive_agent_run_state(row, now_fn=lambda: _NOW) == "paused_expired"


def test_paused_falls_back_to_updated_at():
    row = _paused("pending", finished_at=None, updated_at=_NOW - 60)
    assert derive_agent_run_state(row, now_fn=lambda: _NOW) == "paused_pending"


def test_settled_states_ignore_age():
    # 已结算（approved/rejected）不再看龄——终局回写后永远可读。
    old = _NOW - APPROVAL_PENDING_TTL_SEC * 10
    assert derive_agent_run_state(
        _paused("approved", finished_at=old), now_fn=lambda: _NOW) == "paused_approved"
    assert derive_agent_run_state(
        _paused("rejected", finished_at=old), now_fn=lambda: _NOW) == "paused_rejected"


# ---------------------------------------------------------------------------
# result_json 原始串形态（S5 直读行投影时的输入形状）
# ---------------------------------------------------------------------------


def test_accepts_raw_result_json_string():
    row = _row(result_json=json.dumps(
        {"outcome": "paused_handoff", "approval_state": "pending"}))
    assert derive_agent_run_state(row, now_fn=lambda: _NOW) == "paused_pending"


def test_bad_result_json_is_completed_not_crash():
    # 坏 JSON → {} → 无法证明 paused → completed（且绝不抛）。
    row = _row(result_json="{not json")
    assert derive_agent_run_state(row, now_fn=lambda: _NOW) == "completed"


def test_all_outputs_in_enum():
    rows = [
        _row("queued"), _row("running"), _row("failed"), _row(),
        _row(result={"outcome": "skipped"}),
        _paused("pending"), _paused("approved"), _paused("rejected"),
        _paused("pending", finished_at=None, updated_at=None),
    ]
    for row in rows:
        assert derive_agent_run_state(row, now_fn=lambda: _NOW) in AGENT_RUN_STATES


def test_budget_skip_is_not_completed():
    row = _row(result={"outcome": "skipped", "reason": "daily_run_limit"})
    assert derive_agent_run_state(row, now_fn=lambda: _NOW) == "skipped"
