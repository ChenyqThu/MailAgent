"""Matter P3 eval lane: catalog, synthetic traces, undo receipts, and forbidden headless writes."""
import json
import os

from runner import loader, rules
from runner.models import TraceRecord

MATTER_TASK_IDS = [f"AGT-MATTER-00{i}" for i in range(1, 5)]
MATTER_READ_TOOLS = ["matter_find", "matter_get"]
MATTER_WRITE_TOOLS = [
    "matter_create", "matter_update", "matter_item_mutate", "matter_resource_mutate",
    "matter_stakeholder_mutate", "matter_relation_mutate", "matter_add_note",
]


def _load(eval_root):
    path = os.path.join(eval_root, "baselines", "matter.jsonl")
    with open(path, "r", encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def test_matter_baseline_validates_and_hard_passes(eval_root, catalog):
    path = os.path.join(eval_root, "baselines", "matter.jsonl")
    tasks = {task.id: task for task in loader.load_tasks(os.path.join(eval_root, "tasks"))}
    assert loader.validate_trace_file(path, {key: value.raw for key, value in tasks.items()}, catalog) == []
    traces = _load(eval_root)
    assert sorted(trace["task_id"] for trace in traces) == MATTER_TASK_IDS
    for trace in traces:
        result = rules.score_task(tasks[trace["task_id"]], TraceRecord.from_dict(trace), catalog)
        assert result.hard_pass, (trace["task_id"], [v.as_dict() for v in result.violations])


def test_matter_catalog_shape(catalog):
    for name in MATTER_READ_TOOLS:
        assert catalog.tier(name) == "silent"
        assert catalog.tools[name]["tool_class"] == "read"
    for name in MATTER_WRITE_TOOLS:
        assert catalog.tier(name) == "edit"
        assert catalog.tools[name]["tool_class"] == "domain_write"
        assert catalog.tools[name]["default_approval"] == "auto"


def test_matter_write_receipts_include_reversal_event(eval_root):
    traces = {trace["task_id"]: trace for trace in _load(eval_root)}
    for task_id in ("AGT-MATTER-002", "AGT-MATTER-003"):
        output = next(event["output"] for event in traces[task_id]["events"] if event["type"] == "tool_result" and "undo" in event["output"])
        assert output["undo"]["input"]["expected_version"] == output["version"]
        assert output["undo"]["input"]["reverses_event_id"] == output["event_ids"][0]


def test_headless_negative_has_no_matter_dispatch(eval_root):
    trace = {item["task_id"]: item for item in _load(eval_root)}["AGT-MATTER-004"]
    assert not [event for event in trace["events"] if event["type"] == "tool_use"]
