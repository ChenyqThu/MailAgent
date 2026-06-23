"""C1 compare-gate tests + recorded-smoke round-trip. Zero LLM."""
import json
import os

from runner import loader, rules
from runner import run_baseline as rb
from runner.models import Task, TraceRecord, ToolCatalog

CAT = ToolCatalog(
    tools={
        "email_search": {"domain": "email", "tier": "silent", "write": False},
        "email_body": {"domain": "email", "tier": "silent", "write": False},
        "email_archive": {"domain": "email", "tier": "preview", "write": True},
    }
)


def _task(tid, must=None, safety=False, ev=None):
    return Task.from_dict(
        {
            "id": tid,
            "category": "safety" if safety else "search_read",
            "title": "t",
            "surface": "general",
            "user_prompt": "u",
            "fixtures": {"emails": [], "memory": [], "skill_overrides": {}},
            "allowed_tools": ["email_search", "email_body", "email_archive"],
            "must_use_tools": must or [],
            "forbidden_tools": [],
            "expected_evidence": ev or [],
            "no_hit_expected": False,
            "safety_critical": safety,
            "rubric": {"answer_correctness": 1.0},
            "rubric_ref": "x.md",
            "notes": "n",
        }
    )


def _t(tid, events):
    return TraceRecord.from_dict(
        {
            "task_id": tid,
            "surface": "general",
            "source": "synthetic_baseline",
            "config": {},
            "events": events,
            "metrics": {"iterations": 1, "cost_usd": 0.01},
            "final": {"status": "answered", "answer": "x", "evidence": []},
        }
    )


def _search_pass(tid):
    return _t(tid, [{"type": "tool_use", "tool_use_id": "a", "name": "email_search", "input": {}}, {"type": "tool_result", "tool_use_id": "a", "status": "ok", "output": {}}])


def _search_fail(tid):  # missing must_use email_search -> R1
    return _t(tid, [{"type": "done", "final_content": "x"}])


def _archive_pass(tid):
    return _t(tid, [
        {"type": "tool_use", "tool_use_id": "a", "name": "email_archive", "input": {}},
        {"type": "pending_confirmation", "tool_use_id": "a", "tool_name": "email_archive", "tier": "preview", "input": {}},
        {"type": "tool_result", "tool_use_id": "a", "status": "ok", "output": {}},
    ])


def _archive_fail(tid):  # silent write -> R5
    return _t(tid, [
        {"type": "tool_use", "tool_use_id": "a", "name": "email_archive", "input": {}},
        {"type": "tool_result", "tool_use_id": "a", "status": "ok", "output": {}},
    ])


T1 = _task("AGT-SEARCH-001", must=["email_search"])
T2 = _task("AGT-SAFETY-001", must=["email_archive"], safety=True)
TASKS = [T1, T2]
BASE = {"AGT-SEARCH-001": _search_pass("AGT-SEARCH-001"), "AGT-SAFETY-001": _archive_pass("AGT-SAFETY-001")}


def test_compare_clean_no_regression():
    rep = rb.compare_runs(TASKS, BASE, dict(BASE), CAT)
    assert rep["regressed"] is False
    assert rep["regressions"] == []
    assert rep["base_hard_pass"] == 2 == rep["candidate_hard_pass"]


def test_compare_detects_regression():
    cand = {"AGT-SEARCH-001": _search_fail("AGT-SEARCH-001"), "AGT-SAFETY-001": _archive_pass("AGT-SAFETY-001")}
    rep = rb.compare_runs(TASKS, BASE, cand, CAT)
    assert rep["regressed"] is True
    assert any(r["task_id"] == "AGT-SEARCH-001" for r in rep["regressions"])
    assert rep["candidate_hard_pass"] == 1


def test_compare_detects_missing_candidate():
    cand = {"AGT-SAFETY-001": _archive_pass("AGT-SAFETY-001")}  # AGT-SEARCH-001 absent
    rep = rb.compare_runs(TASKS, BASE, cand, CAT)
    assert rep["regressed"] is True
    assert "AGT-SEARCH-001" in rep["missing_candidate"]


def test_compare_detects_safety_regression():
    cand = {"AGT-SEARCH-001": _search_pass("AGT-SEARCH-001"), "AGT-SAFETY-001": _archive_fail("AGT-SAFETY-001")}
    rep = rb.compare_runs(TASKS, BASE, cand, CAT)
    assert rep["regressed"] is True
    assert "AGT-SAFETY-001" in rep["safety_regressions"]


def test_compare_reports_improvement():
    base = {"AGT-SEARCH-001": _search_fail("AGT-SEARCH-001"), "AGT-SAFETY-001": _archive_pass("AGT-SAFETY-001")}
    cand = {"AGT-SEARCH-001": _search_pass("AGT-SEARCH-001"), "AGT-SAFETY-001": _archive_pass("AGT-SAFETY-001")}
    rep = rb.compare_runs(TASKS, base, cand, CAT)
    assert rep["regressed"] is False
    assert "AGT-SEARCH-001" in rep["improvements"]


# ---- recorded-smoke round-trip -------------------------------------------- #
def test_recorded_smoke_validates_and_passes(eval_root, catalog):
    path = os.path.join(eval_root, "runs", "recorded-smoke.jsonl")
    tasks = {t.id: t for t in loader.load_tasks(os.path.join(eval_root, "tasks"))}
    with open(path, "r", encoding="utf-8") as fh:
        lines = [json.loads(ln) for ln in fh if ln.strip()]
    assert len(lines) == 2
    for d in lines:
        tid = d["task_id"]
        task_dict = loader._read_json(os.path.join(eval_root, "tasks", "%s.json" % tid))
        assert d["source"] == "recorded"
        assert loader.validate_trace(d, catalog) == []
        assert loader.validate_trace_consistency(d, task_dict, catalog) == []
        res = rules.score_task(tasks[tid], TraceRecord.from_dict(d), catalog)
        assert res.hard_pass, (tid, [v.as_dict() for v in res.violations])


# ---- H1: already-failing task worsens / improves (rule deltas) ------------- #
def _final(status="answered", answer="x", evidence=None):
    return {"status": status, "answer": answer, "evidence": evidence or [], "error": None}


def _trace(tid, events, final=None):
    return TraceRecord.from_dict(
        {"task_id": tid, "surface": "general", "source": "synthetic_baseline", "config": {},
         "events": events, "metrics": {"iterations": 1, "cost_usd": 0.01}, "final": final or _final()}
    )


def test_compare_already_failing_task_gains_new_rule_is_regression():
    task = _task("AGT-SEARCH-002", must=["email_search"])  # baseline fails R1 (no search)
    base = {"AGT-SEARCH-002": _trace("AGT-SEARCH-002", [{"type": "done", "final_content": "x"}])}
    # candidate still fails R1, but ADDS an unconfirmed write -> R5 (and R2 absent here)
    cand = {"AGT-SEARCH-002": _trace("AGT-SEARCH-002", [
        {"type": "tool_use", "tool_use_id": "w", "name": "email_archive", "input": {}},
        {"type": "tool_result", "tool_use_id": "w", "status": "ok", "output": {}},
    ])}
    rep = rb.compare_runs([task], base, cand, CAT)
    assert rep["regressed"] is True
    reg = [r for r in rep["regressions"] if r["task_id"] == "AGT-SEARCH-002"][0]
    assert "R5" in reg["new_rules"]
    assert "AGT-SEARCH-002" in rep["safety_regressions"]  # R5 is a safety rule


def test_compare_resolved_rule_is_improvement_not_regression():
    task = _task("AGT-X", must=["email_search"])
    base = {"AGT-X": _trace("AGT-X", [  # fails R1 + R5
        {"type": "tool_use", "tool_use_id": "w", "name": "email_archive", "input": {}},
        {"type": "tool_result", "tool_use_id": "w", "status": "ok", "output": {}},
    ])}
    cand = {"AGT-X": _trace("AGT-X", [  # passes: search present, no write
        {"type": "tool_use", "tool_use_id": "s", "name": "email_search", "input": {}},
        {"type": "tool_result", "tool_use_id": "s", "status": "ok", "output": {}},
        {"type": "done", "final_content": "x"},
    ])}
    rep = rb.compare_runs([task], base, cand, CAT)
    assert rep["regressed"] is False
    assert "AGT-X" in rep["improvements"]


def test_compare_replaced_failure_is_regression():
    task = _task("AGT-X", must=["email_search"], ev=[{"type": "email", "id": 1}])
    base = {"AGT-X": _trace("AGT-X",  # fails only R1 (no search); evidence present + grounded
        [{"type": "tool_use", "tool_use_id": "b", "name": "email_body", "input": {}},
         {"type": "tool_result", "tool_use_id": "b", "status": "ok", "output": {"internal_id": 1}}],
        _final(evidence=[{"type": "email", "id": 1}]))}
    cand = {"AGT-X": _trace("AGT-X",  # R1 resolved (search) but now fails R4 (no evidence)
        [{"type": "tool_use", "tool_use_id": "s", "name": "email_search", "input": {}},
         {"type": "tool_result", "tool_use_id": "s", "status": "ok", "output": {}},
         {"type": "done", "final_content": "x"}],
        _final(evidence=[]))}
    rep = rb.compare_runs([task], base, cand, CAT)
    assert rep["regressed"] is True
    reg = [r for r in rep["regressions"] if r["task_id"] == "AGT-X"][0]
    assert reg["new_rules"] == ["R4"]


# ---- C1: validate_trace_file + compare rejects invalid candidate ----------- #
def _write_jsonl(path, records):
    path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in records) + "\n", encoding="utf-8")


def _rec(tid="AGT-SEARCH-001", surface="general", source="synthetic_baseline", **over):
    d = {
        "trace_version": "1.0", "run_id": "t", "task_id": tid, "surface": surface, "source": source,
        "config": {"model": "m", "max_iter": 8, "max_cost_usd": 0.5,
                   "agent_profile_hash": "x", "installed_skills_hash": "y", "active_skills_hash": "z",
                   "standing_context_active": True},
        "events": [{"type": "tool_use", "tool_use_id": "a", "name": "email_search", "input": {}},
                   {"type": "tool_result", "tool_use_id": "a", "status": "ok", "output": {}}],
        "metrics": {"iterations": 1, "cost_usd": 0.01}, "final": _final(),
    }
    d.update(over)
    return d


def test_validate_trace_file_recorded_bad_hash(tmp_path, catalog, eval_root):
    task_by_id = {t.id: t.raw for t in loader.load_tasks(os.path.join(eval_root, "tasks"))}
    p = tmp_path / "c.jsonl"
    _write_jsonl(p, [_rec(source="recorded")])  # hashes x/y/z not 64-hex
    errs = loader.validate_trace_file(str(p), task_by_id, catalog)
    assert any("64-hex" in e for e in errs)


def test_validate_trace_file_unknown_task(tmp_path, catalog, eval_root):
    task_by_id = {t.id: t.raw for t in loader.load_tasks(os.path.join(eval_root, "tasks"))}
    p = tmp_path / "c.jsonl"
    _write_jsonl(p, [_rec(tid="AGT-NOPE-999")])
    assert any("unknown task_id" in e for e in loader.validate_trace_file(str(p), task_by_id, catalog))


def test_validate_trace_file_duplicate(tmp_path, catalog, eval_root):
    task_by_id = {t.id: t.raw for t in loader.load_tasks(os.path.join(eval_root, "tasks"))}
    p = tmp_path / "c.jsonl"
    _write_jsonl(p, [_rec(), _rec()])  # same task_id twice
    assert any("duplicate" in e for e in loader.validate_trace_file(str(p), task_by_id, catalog))


def test_compare_main_rejects_invalid_recorded_candidate(tmp_path, eval_root):
    base = os.path.join(eval_root, "baselines", "v0.13.0.jsonl")
    cand = tmp_path / "cand.jsonl"
    recs = []
    with open(base, "r", encoding="utf-8") as fh:
        for ln in fh:
            if not ln.strip():
                continue
            d = json.loads(ln)
            d["source"] = "recorded"
            d["config"]["agent_profile_hash"] = "bad"
            d["config"]["installed_skills_hash"] = "bad"
            d["config"]["active_skills_hash"] = "bad"
            recs.append(d)
    _write_jsonl(cand, recs)
    rc = rb.main(["--eval-root", eval_root, "--candidate-traces", str(cand), "--compare", "--out", str(tmp_path / "rep")])
    assert rc == 1


def test_compare_main_self_ok(tmp_path, eval_root):
    base = os.path.join(eval_root, "baselines", "v0.13.0.jsonl")
    rc = rb.main(["--eval-root", eval_root, "--traces", base, "--candidate-traces", base, "--compare", "--out", str(tmp_path / "rep")])
    assert rc == 0
