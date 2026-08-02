"""W6 conversational Custom Agent builder eval lane. Zero LLM."""

from __future__ import annotations

import json
import os

from runner import loader, rules
from runner.models import TraceRecord


TASK_IDS = {"AGT-SKILL-009", "AGT-SKILL-010", "AGT-SKILL-011"}
WRITE_TOOLS = {
    "custom_agent_create",
    "custom_agent_update",
    "custom_agent_delete",
    "custom_agent_run_now",
}
CAPABILITY_KEYS = {"email", "calendar", "knowledge", "reports", "web", "files"}


def _traces(eval_root):
    path = os.path.join(eval_root, "baselines", "custom_agent_builder.jsonl")
    with open(path, "r", encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def test_builder_baseline_validates_and_hard_passes(eval_root, catalog):
    path = os.path.join(eval_root, "baselines", "custom_agent_builder.jsonl")
    tasks = {task.id: task for task in loader.load_tasks(os.path.join(eval_root, "tasks"))}
    assert loader.validate_trace_file(path, {k: v.raw for k, v in tasks.items()}, catalog) == []
    traces = _traces(eval_root)
    assert {trace["task_id"] for trace in traces} == TASK_IDS
    for raw in traces:
        scored = rules.score_task(tasks[raw["task_id"]], TraceRecord.from_dict(raw), catalog)
        assert scored.hard_pass, (raw["task_id"], [v.as_dict() for v in scored.violations])


def test_incomplete_request_clarifies_before_any_write(eval_root):
    trace = next(t for t in _traces(eval_root) if t["task_id"] == "AGT-SKILL-009")
    used = {event["name"] for event in trace["events"] if event["type"] == "tool_use"}
    assert used.isdisjoint(WRITE_TOOLS)
    answer = trace["final"]["answer"] + " " + next(
        event["final_content"] for event in trace["events"] if event["type"] == "done"
    )
    assert "触发" in answer
    assert "能力" in answer
    assert "产出" in answer


def test_create_uses_complete_capability_profile_after_summary(eval_root, catalog):
    trace = next(t for t in _traces(eval_root) if t["task_id"] == "AGT-SKILL-011")
    events = trace["events"]
    create_index = next(
        i
        for i, event in enumerate(events)
        if event["type"] == "tool_use" and event["name"] == "custom_agent_create"
    )
    assert any(event["type"] == "chunk" and "配置摘要" in event["delta"] for event in events[:create_index])
    create = events[create_index]["input"]
    assert set(create["capabilities"]) == CAPABILITY_KEYS
    assert "allowed_tools" not in create
    assert "grant_web" not in create
    assert "grant_exec" not in create
    pending = next(event for event in events if event["type"] == "pending_confirmation")
    assert pending["tool_name"] == "custom_agent_create"
    assert pending["tier"] == catalog.tier("custom_agent_create") == "edit"


def test_update_reads_current_spec_then_submits_narrow_capability_patch(eval_root, catalog):
    trace = next(t for t in _traces(eval_root) if t["task_id"] == "AGT-SKILL-010")
    events = trace["events"]
    uses = [event for event in events if event["type"] == "tool_use"]
    assert [event["name"] for event in uses] == ["custom_agent_get", "custom_agent_update"]
    assert uses[1]["input"] == {
        "agent_id": "daily-brief",
        "capabilities": {"reports": "produce", "web": "gated"},
    }
    pending = next(event for event in events if event["type"] == "pending_confirmation")
    assert pending["tool_name"] == "custom_agent_update"
    assert pending["tier"] == catalog.tier("custom_agent_update") == "edit"
