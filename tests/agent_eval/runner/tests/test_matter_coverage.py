"""Matter P3 eval lane: catalog, synthetic traces, undo receipts, and forbidden headless writes."""
import json
import os

from runner import loader, rules
from runner.models import TraceRecord

MATTER_TASK_IDS = [f"AGT-MATTER-00{i}" for i in range(1, 8)]
MATTER_READ_TOOLS = ["matter_find", "matter_get"]
MATTER_WRITE_TOOLS = [
    "matter_create", "matter_update", "matter_item_mutate", "matter_resource_mutate",
    "matter_stakeholder_mutate", "matter_relation_mutate", "matter_add_note",
    # P4 D8 — the two review-side writes.
    "matter_run_control", "matter_review_update",
]
#: P4 D8 —— 出厂档不是 auto 的 Matter 写工具（catalog 无 default_approval ⇒ R5 恒要求审批卡）。
#: matter_review_update 的免卡是 gateway 侧的**动态** policyEvaluate（非 manual 恒卡 / manual 拒绝
#: 免卡 / manual 接受且含 field change 弹卡），不是一个静态出厂档 —— 静态标 auto 会让 R5 对
#: 「接受 field change 却没有卡」的 trace 放行，正好放掉本相位最该守的那条。
MATTER_ASK_TIER_WRITE_TOOLS = ["matter_review_update"]
#: P4 D6 —— 跟进 run 的唯一产出通道：artifact 类、silent、write=false（写的是**待审**提案，
#: 不是 Matter 状态），且只在 run 语境注册。
MATTER_RUN_ARTIFACT_TOOL = "matter_update_propose"


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
        expected_auto = name not in MATTER_ASK_TIER_WRITE_TOOLS
        assert catalog.default_auto(name) is expected_auto, name
    row = catalog.tools[MATTER_RUN_ARTIFACT_TOOL]
    assert catalog.tier(MATTER_RUN_ARTIFACT_TOOL) == "silent"
    assert row["tool_class"] == "artifact"
    assert row["write"] is False
    # 整个家族都不进 custom-agent 的能力勾选面（headless run 拿不到，跟进 run 的工具面由 spec
    # allowlist 供给，不经 HEADLESS_TOOL_OPTIONS）。
    for name in MATTER_READ_TOOLS + MATTER_WRITE_TOOLS + [MATTER_RUN_ARTIFACT_TOOL]:
        assert catalog.tools[name].get("headless_excluded") is True, name


def test_matter_followup_trace_has_no_state_write(eval_root):
    """P4 D5：跟进 run 的 trace 里只许出现读工具 + 唯一的 artifact 产出通道。"""
    trace = {item["task_id"]: item for item in _load(eval_root)}["AGT-MATTER-007"]
    names = [event["name"] for event in trace["events"] if event["type"] == "tool_use"]
    assert MATTER_RUN_ARTIFACT_TOOL in names
    assert not set(names) & set(MATTER_WRITE_TOOLS)
    # 提案是 silent 产出（写的是待审行），不该出现审批卡。
    assert not [event for event in trace["events"] if event["type"] == "pending_confirmation"]


def test_field_accept_trace_carries_the_approval_card(eval_root):
    """P4 D8：接受含 field change ⇒ trace 里必须有 edit 档审批卡（R5 也会独立判一遍）。"""
    trace = {item["task_id"]: item for item in _load(eval_root)}["AGT-MATTER-006"]
    cards = [event for event in trace["events"] if event["type"] == "pending_confirmation"]
    assert [card["tool_name"] for card in cards] == ["matter_review_update"]
    assert cards[0]["tier"] == "edit"


def test_matter_write_receipts_include_reversal_event(eval_root):
    traces = {trace["task_id"]: trace for trace in _load(eval_root)}
    for task_id in ("AGT-MATTER-002", "AGT-MATTER-003"):
        output = next(event["output"] for event in traces[task_id]["events"] if event["type"] == "tool_result" and "undo" in event["output"])
        assert output["undo"]["input"]["expected_version"] == output["version"]
        assert output["undo"]["input"]["reverses_event_id"] == output["event_ids"][0]


def test_headless_negative_has_no_matter_dispatch(eval_root):
    trace = {item["task_id"]: item for item in _load(eval_root)}["AGT-MATTER-004"]
    assert not [event for event in trace["events"] if event["type"] == "tool_use"]
