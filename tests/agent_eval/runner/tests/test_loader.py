"""Validation tests: loader must catch malformed tasks/traces (zero LLM).
Also an integration check that the shipped corpus scores as designed.
"""
import os

from runner import loader, rules


# --------------------------------------------------------------------------- #
# validate_task
# --------------------------------------------------------------------------- #
def _good_task():
    return {
        "id": "AGT-SEARCH-999",
        "category": "search_read",
        "title": "t",
        "surface": "general",
        "user_prompt": "u",
        "fixtures": {"emails": ["fx-email-001"], "memory": [], "skill_overrides": {}},
        "allowed_tools": ["email_search", "email_body"],
        "must_use_tools": ["email_body"],
        "forbidden_tools": ["email_send"],
        "expected_evidence": [{"type": "email", "id": 51201}],
        "no_hit_expected": False,
        "safety_critical": False,
        "rubric": {"answer_correctness": 0.5, "evidence_grounding": 0.5},
        "rubric_ref": "search_read.md",
        "notes": "n",
    }


def test_good_task_validates(catalog, eval_root):
    assert loader.validate_task(_good_task(), catalog, eval_root) == []


def test_unknown_tool_rejected(catalog, eval_root):
    d = _good_task()
    d["allowed_tools"] = ["email_search", "totally_fake_tool"]
    errs = loader.validate_task(d, catalog, eval_root)
    assert any("unknown tool" in e for e in errs)


def test_bad_category_rejected(catalog, eval_root):
    d = _good_task()
    d["category"] = "nonsense"
    assert any("invalid category" in e for e in loader.validate_task(d, catalog, eval_root))


def test_rubric_sum_rejected(catalog, eval_root):
    d = _good_task()
    d["rubric"] = {"answer_correctness": 0.4, "evidence_grounding": 0.4}  # 0.8
    assert any("sum to 1.0" in e for e in loader.validate_task(d, catalog, eval_root))


def test_no_hit_with_evidence_rejected(catalog, eval_root):
    d = _good_task()
    d["no_hit_expected"] = True  # but expected_evidence still non-empty
    assert any("contradicts" in e for e in loader.validate_task(d, catalog, eval_root))


def test_must_use_outside_allowed_rejected(catalog, eval_root):
    d = _good_task()
    d["must_use_tools"] = ["email_list_thread"]  # not in allowed_tools
    assert any("not in allowed_tools" in e for e in loader.validate_task(d, catalog, eval_root))


def test_email_surface_requires_context(catalog, eval_root):
    d = _good_task()
    d["surface"] = "email"
    d["email_context"] = None
    assert any("email_context" in e for e in loader.validate_task(d, catalog, eval_root))


def test_missing_fixture_rejected(catalog, eval_root):
    d = _good_task()
    d["fixtures"]["emails"] = ["fx-does-not-exist"]
    assert any("fixture email missing" in e for e in loader.validate_task(d, catalog, eval_root))


# --------------------------------------------------------------------------- #
# validate_trace
# --------------------------------------------------------------------------- #
def _good_trace():
    return {
        "trace_version": "1.0",
        "run_id": "t",
        "task_id": "AGT-SEARCH-999",
        "surface": "general",
        "source": "synthetic_baseline",
        "config": {
            "model": "m",
            "max_iter": 8,
            "max_cost_usd": 0.5,
            "agent_profile_hash": "x",
            "installed_skills_hash": "y",
            "active_skills_hash": "z",
            "standing_context_active": True,
        },
        "events": [
            {"type": "tool_use", "tool_use_id": "a", "name": "email_search", "input": {}},
            {"type": "tool_result", "tool_use_id": "a", "status": "ok", "output": {}},
            {"type": "done", "final_content": "x", "model": "m", "stop_reason": "end_turn"},
        ],
        "metrics": {"iterations": 1, "cost_usd": 0.01},
        "final": {"status": "answered", "answer": "x", "evidence": [], "error": None},
    }


def test_good_trace_validates(catalog):
    assert loader.validate_trace(_good_trace(), catalog) == []


def test_trace_bad_status_rejected(catalog):
    d = _good_trace()
    d["final"]["status"] = "weird"
    assert any("final.status" in e for e in loader.validate_trace(d, catalog))


def test_trace_bad_event_type_rejected(catalog):
    d = _good_trace()
    d["events"].append({"type": "made_up_event"})
    assert any("invalid type" in e for e in loader.validate_trace(d, catalog))


def test_trace_missing_hashes_rejected(catalog):
    d = _good_trace()
    del d["config"]["active_skills_hash"]
    assert any("active_skills_hash" in e for e in loader.validate_trace(d, catalog))


# --------------------------------------------------------------------------- #
# validate_trace_consistency (M1)
# --------------------------------------------------------------------------- #
def test_consistency_good(catalog):
    assert loader.validate_trace_consistency(_good_trace(), _good_task(), catalog) == []


def test_consistency_surface_mismatch(catalog):
    t = _good_task()
    t["surface"] = "email"
    t["email_context"] = {"internal_id": 1}
    assert any("surface" in e for e in loader.validate_trace_consistency(_good_trace(), t, catalog))


def test_consistency_tool_calls_mismatch(catalog):
    d = _good_trace()
    d["metrics"]["tool_calls"] = 5
    assert any("tool_calls" in e for e in loader.validate_trace_consistency(d, _good_task(), catalog))


def test_consistency_recorded_requires_hex(catalog):
    d = _good_trace()
    d["source"] = "recorded"  # hashes are x/y/z, not 64-hex
    assert any("64-hex" in e for e in loader.validate_trace_consistency(d, _good_task(), catalog))


def test_consistency_pending_name_mismatch(catalog):
    d = _good_trace()
    d["events"] = [
        {"type": "tool_use", "tool_use_id": "a", "name": "email_archive", "input": {}},
        {"type": "pending_confirmation", "tool_use_id": "a", "tool_name": "email_flag", "tier": "preview", "input": {}},
        {"type": "tool_result", "tool_use_id": "a", "status": "ok", "output": {}},
    ]
    assert any("tool_name" in e for e in loader.validate_trace_consistency(d, _good_task(), catalog))


def test_consistency_orphan_result(catalog):
    d = _good_trace()
    d["events"] = [{"type": "tool_result", "tool_use_id": "zzz", "status": "ok", "output": {}}]
    assert any("without matching tool_use" in e for e in loader.validate_trace_consistency(d, _good_task(), catalog))


def test_consistency_unknown_tool(catalog):
    d = _good_trace()
    d["events"] = [
        {"type": "tool_use", "tool_use_id": "a", "name": "bogus_tool", "input": {}},
        {"type": "tool_result", "tool_use_id": "a", "status": "ok", "output": {}},
    ]
    assert any("unknown tool" in e for e in loader.validate_trace_consistency(d, _good_task(), catalog))


def test_consistency_trace_version(catalog):
    d = _good_trace()
    d["trace_version"] = "9.9"
    assert any("trace_version" in e for e in loader.validate_trace_consistency(d, _good_task(), catalog))


# --------------------------------------------------------------------------- #
# Integration: shipped corpus scores as designed
# --------------------------------------------------------------------------- #
def test_corpus_examples_score_as_designed(catalog, eval_root):
    tasks = {t.id: t for t in loader.load_tasks(os.path.join(eval_root, "tasks"))}
    traces = loader.load_traces(os.path.join(eval_root, "baselines", "v0.13.0.jsonl"))

    # canonical pass cases
    for tid in ("AGT-SEARCH-001", "AGT-SAFETY-001"):
        r = rules.score_task(tasks[tid], traces[tid], catalog)
        assert r.hard_pass is True, (tid, [v.as_dict() for v in r.violations])

    # canonical designed-failure case (v0.13.0 fabrication)
    r = rules.score_task(tasks["AGT-NOHIT-001"], traces["AGT-NOHIT-001"], catalog)
    assert r.hard_pass is False
    assert {"R6", "R8"}.issubset(r.rule_codes())
