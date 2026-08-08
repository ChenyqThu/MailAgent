"""P2 Agent Call synthetic lane: manual delegation, recursion guard, and user-requested audit."""

import json
import os

from runner import loader, rules
from runner.models import TraceRecord

LANE_TASKS = ["AGT-CALL-001", "AGT-CALL-002", "AGT-CALL-003"]
TOOL = "custom_agent_call"


def _tasks(eval_root):
    return {task.id: task for task in loader.load_tasks(os.path.join(eval_root, "tasks"))}


def _lane(eval_root):
    path = os.path.join(eval_root, "baselines", "agentcall.jsonl")
    with open(path, "r", encoding="utf-8") as handle:
        return {row["task_id"]: row for row in map(json.loads, handle) if row}


def test_agentcall_lane_validates_cleanly(eval_root, catalog):
    path = os.path.join(eval_root, "baselines", "agentcall.jsonl")
    tasks = _tasks(eval_root)
    assert loader.validate_trace_file(path, {key: value.raw for key, value in tasks.items()}, catalog) == []
    assert sorted(_lane(eval_root)) == LANE_TASKS


def test_agentcall_only_appears_on_manual_surface(eval_root):
    for task_id, trace in _lane(eval_root).items():
        uses = [event for event in trace["events"] if event["type"] == "tool_use"]
        context_mode = trace["config"].get("context_mode")
        if any(event["name"] == TOOL for event in uses):
            assert context_mode == "manual_chat", task_id
        if context_mode != "manual_chat":
            assert all(event["name"] != TOOL for event in uses), task_id


def test_manual_risky_call_has_confirmation_and_user_requested_has_audit(eval_root):
    lane = _lane(eval_root)
    pending = [event for event in lane["AGT-CALL-001"]["events"] if event["type"] == "pending_confirmation"]
    assert [(event["tool_name"], event["tier"]) for event in pending] == [(TOOL, "edit")]
    auto_results = [
        event
        for event in lane["AGT-CALL-003"]["events"]
        if event["type"] == "tool_result" and event.get("tool_use_id") == "tu-call-3"
    ]
    assert auto_results[0]["approval_status"] == "auto_user_requested"


def test_recursive_call_negative_example_trips_forbidden_tool(eval_root, catalog):
    tasks = _tasks(eval_root)
    trace = json.loads(json.dumps(_lane(eval_root)["AGT-CALL-002"]))
    trace["events"].insert(
        0,
        {
            "type": "tool_use",
            "tool_use_id": "tu-recursive",
            "name": TOOL,
            "input": {"agent_id": "other-agent", "instruction": "continue recursively"},
        },
    )
    trace["events"].insert(
        1,
        {
            "type": "tool_result",
            "tool_use_id": "tu-recursive",
            "status": "ok",
            "output": {"status": "queued", "job_id": 999, "session_id": 1000},
        },
    )
    trace["metrics"]["tool_calls"] = 1
    result = rules.score_task(tasks["AGT-CALL-002"], TraceRecord.from_dict(trace), catalog)
    assert not result.hard_pass
    assert any(violation.rule == "R2" and TOOL in violation.detail for violation in result.violations)
