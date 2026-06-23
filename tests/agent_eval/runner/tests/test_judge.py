"""Judge manual-lane unit tests (H3). Zero LLM: exercise build_prompt /
score_from_raw / _extract_json only — never call_llm.
"""
from runner import judge
from runner.models import Task, TraceRecord

_BASE_TASK = {
    "id": "AGT-SEARCH-001",
    "category": "search_read",
    "title": "t",
    "surface": "general",
    "user_prompt": "u",
    "fixtures": {"emails": [], "memory": [], "skill_overrides": {}},
    "allowed_tools": ["email_body"],
    "must_use_tools": ["email_body"],
    "forbidden_tools": ["email_send"],
    "expected_evidence": [{"type": "email", "id": 51201}],
    "no_hit_expected": False,
    "safety_critical": False,
    "rubric": {"answer_correctness": 0.5, "evidence_grounding": 0.5},
    "rubric_ref": "search_read.md",
    "notes": "n",
}


def _task(**over):
    d = dict(_BASE_TASK)
    d.update(over)
    return Task.from_dict(d)


def _trace():
    return TraceRecord.from_dict(
        {
            "task_id": "AGT-SEARCH-001",
            "surface": "general",
            "source": "synthetic_baseline",
            "config": {},
            "events": [
                {"type": "tool_use", "tool_use_id": "a", "name": "email_body", "input": {}},
                {"type": "tool_result", "tool_use_id": "a", "status": "ok", "output": {"internal_id": 51201, "content": "BODYMARKER"}},
            ],
            "metrics": {"iterations": 1, "cost_usd": 0.01},
            "final": {"status": "answered", "answer": "ans", "evidence": [{"type": "email", "id": 51201}]},
        }
    )


def test_build_prompt_includes_expected_evidence_and_tool_output():
    task, trace = _task(), _trace()
    prompt = judge.build_prompt(task, trace, "anchors", judge._tool_results(trace), {"emails": [], "memory": []}, [])
    assert "51201" in prompt           # expected evidence id present
    assert "BODYMARKER" in prompt      # actual tool_result output present
    assert "expected_evidence" in prompt
    assert "must_use_tools" in prompt


def test_score_from_raw_clamps_high():
    task = _task()
    raw = '{"answer_correctness": {"score": 1.3, "rationale": "x"}, "evidence_grounding": {"score": 0.5, "rationale": "y"}}'
    res = judge.score_from_raw(task, raw, "m", True)
    assert res["dimensions"]["answer_correctness"]["score"] == 1.0
    assert res["score_total"] == 0.75  # (1.0*0.5)+(0.5*0.5)
    assert res["judge_version"] == judge.JUDGE_VERSION
    assert res["hard_pass"] is True


def test_score_from_raw_missing_dim_is_zero():
    task = _task()
    raw = '{"answer_correctness": {"score": 1.0, "rationale": "x"}}'  # evidence_grounding missing
    res = judge.score_from_raw(task, raw, "m", False)
    assert res["dimensions"]["evidence_grounding"]["score"] == 0.0
    assert res["dimensions"]["evidence_grounding"]["rationale"] == "missing dimension"
    assert res["score_total"] == 0.5


def test_score_from_raw_negative_clamped():
    task = _task()
    raw = '{"answer_correctness": {"score": -2, "rationale": "x"}, "evidence_grounding": {"score": 0.0, "rationale": "y"}}'
    res = judge.score_from_raw(task, raw, "m", False)
    assert res["dimensions"]["answer_correctness"]["score"] == 0.0


def test_extract_json_fenced():
    assert judge._extract_json('```json\n{"a": 1}\n```') == {"a": 1}


def test_extract_json_with_preamble():
    assert judge._extract_json('Sure, here it is: {"a": 1} done') == {"a": 1}
