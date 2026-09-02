"""g2 group-tools synthetic lane: create card, verified user_requested audit, member scope, headless absence."""

import json
import os

from runner import loader, rules
from runner.models import TraceRecord

LANE_TASKS = ["AGT-GROUP-001", "AGT-GROUP-002", "AGT-GROUP-003", "AGT-GROUP-004"]
TOOLS = ("group_history", "group_members", "group_post", "group_create")


def _tasks(eval_root):
    return {task.id: task for task in loader.load_tasks(os.path.join(eval_root, "tasks"))}


def _lane(eval_root):
    path = os.path.join(eval_root, "baselines", "group.jsonl")
    with open(path, "r", encoding="utf-8") as handle:
        return {row["task_id"]: row for row in map(json.loads, handle) if row}


def test_group_lane_validates_cleanly(eval_root, catalog):
    path = os.path.join(eval_root, "baselines", "group.jsonl")
    tasks = _tasks(eval_root)
    assert loader.validate_trace_file(path, {key: value.raw for key, value in tasks.items()}, catalog) == []
    assert sorted(_lane(eval_root)) == LANE_TASKS


def test_group_tools_only_on_manual_surface(eval_root):
    """群工具的 tool_class 是 capability_change：headless / im 场地结构性缺席。"""
    for task_id, trace in _lane(eval_root).items():
        uses = [event for event in trace["events"] if event["type"] == "tool_use"]
        context_mode = trace["config"].get("context_mode")
        if any(event["name"] in TOOLS for event in uses):
            assert context_mode == "manual_chat", task_id
        if context_mode != "manual_chat":
            assert all(event["name"] not in TOOLS for event in uses), task_id


def test_create_has_confirmation_and_post_verified_has_audit(eval_root):
    lane = _lane(eval_root)
    pending = [event for event in lane["AGT-GROUP-001"]["events"] if event["type"] == "pending_confirmation"]
    assert [(event["tool_name"], event["tier"]) for event in pending] == [("group_create", "edit")]
    auto_results = [
        event
        for event in lane["AGT-GROUP-002"]["events"]
        if event["type"] == "tool_result" and event.get("tool_use_id") == "tu-group-2b"
    ]
    assert auto_results[0]["approval_status"] == "auto_user_requested_verified"


def test_member_run_stays_inside_its_own_group(eval_root):
    """成员 run 只读两件工具，且都打在同一个 session_id 上（scope 钉本群）。"""
    uses = [event for event in _lane(eval_root)["AGT-GROUP-003"]["events"] if event["type"] == "tool_use"]
    assert sorted(event["name"] for event in uses) == ["group_history", "group_members"]
    assert {event["input"]["session_id"] for event in uses} == {4021}


def test_headless_group_call_trips_forbidden_tool(eval_root, catalog):
    tasks = _tasks(eval_root)
    trace = json.loads(json.dumps(_lane(eval_root)["AGT-GROUP-004"]))
    trace["events"].insert(
        0,
        {
            "type": "tool_use",
            "tool_use_id": "tu-headless-post",
            "name": "group_post",
            "input": {"session_id": 4021, "text": "无人值守也想往群里发一条"},
        },
    )
    trace["events"].insert(
        1,
        {
            "type": "tool_result",
            "tool_use_id": "tu-headless-post",
            "status": "ok",
            "output": {"message_id": 90999, "chain_id": 90999, "woke": []},
        },
    )
    trace["metrics"]["tool_calls"] = 1
    result = rules.score_task(tasks["AGT-GROUP-004"], TraceRecord.from_dict(trace), catalog)
    assert not result.hard_pass
    assert any(violation.rule == "R2" and "group_post" in violation.detail for violation in result.violations)
