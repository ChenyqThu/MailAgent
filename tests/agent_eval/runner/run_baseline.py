#!/usr/bin/env python3
"""Hard-lane rule gate runner: baseline report + baseline-vs-candidate compare.

Usage (schema.md §7):
    # validate schema + coverage (zero LLM)
    python eval/runner/run_baseline.py --eval-root eval --validate
    # generate baseline report
    python eval/runner/run_baseline.py --eval-root eval --run-id v0.13.0
    # regression gate: score a candidate trace set against the baseline (C1)
    python eval/runner/run_baseline.py --eval-root eval \
        --traces eval/baselines/v0.13.0.jsonl --candidate-traces runs/<branch>.jsonl --compare

`--compare` exits 1 on ANY regression: a task the baseline covers is missing from the
candidate, a task that passed in baseline fails in candidate (safety-critical called out),
or total hard_pass drops. Zero LLM throughout.
"""
from __future__ import annotations

import argparse
import os
import sys
from typing import Dict, List, Tuple

# make `runner` importable whether invoked as script or module
_EVAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _EVAL_ROOT not in sys.path:
    sys.path.insert(0, _EVAL_ROOT)

from runner import loader, report as report_mod, rules  # noqa: E402
from runner.models import RuleViolation, Task, TaskResult, ToolCatalog, TraceRecord  # noqa: E402


def _default(eval_root: str, *parts: str) -> str:
    return os.path.join(eval_root, *parts)


def _score_set(
    tasks: List[Task], traces: Dict[str, TraceRecord], catalog: ToolCatalog
) -> Tuple[Dict[str, TaskResult], List[str]]:
    """Score every task that has a trace; return (results_by_id, missing_task_ids)."""
    results: Dict[str, TaskResult] = {}
    missing: List[str] = []
    for task in tasks:
        tr = traces.get(task.id)
        if tr is None:
            missing.append(task.id)
            continue
        results[task.id] = rules.score_task(task, tr, catalog)
    return results, missing


# newly-introduced any of these rule codes is always a regression (safety/grounding)
SAFETY_RULES = {"R2", "R5", "R6", "R8"}


def compare_runs(
    tasks: List[Task],
    base_traces: Dict[str, TraceRecord],
    cand_traces: Dict[str, TraceRecord],
    catalog: ToolCatalog,
) -> dict:
    """Pure: compare candidate vs baseline with per-task rule deltas.

    A task is a regression if it: is missing in candidate; flips pass->fail; or —
    EVEN WHILE STILL FAILING — gains ANY new violation rule code vs baseline (H1).
    `regressed` drives the exit code.
    """
    base, _ = _score_set(tasks, base_traces, catalog)
    cand, _ = _score_set(tasks, cand_traces, catalog)

    regressions: List[dict] = []
    improvements: List[str] = []
    safety_regressions: List[str] = []
    changed: List[dict] = []

    for tid, br in sorted(base.items()):
        base_rules = sorted({v.rule for v in br.violations})
        cr = cand.get(tid)
        if cr is None:
            regressions.append({"task_id": tid, "reason": "candidate trace missing", "baseline_rules": base_rules, "candidate_rules": None, "new_rules": []})
            if br.safety_critical:
                safety_regressions.append(tid)
            changed.append({"task_id": tid, "baseline_hard_pass": br.hard_pass, "candidate_hard_pass": None, "baseline_rules": base_rules, "candidate_rules": None, "new_rules": [], "resolved_rules": []})
            continue
        cand_rules = sorted({v.rule for v in cr.violations})
        new_rules = sorted(set(cand_rules) - set(base_rules))
        resolved_rules = sorted(set(base_rules) - set(cand_rules))
        flipped = br.hard_pass and not cr.hard_pass
        is_regression = flipped or bool(new_rules)
        if is_regression:
            reason = "pass->fail" if flipped else "new violations in already-failing task"
            regressions.append({
                "task_id": tid,
                "reason": "%s: +[%s]" % (reason, ",".join(new_rules) or ",".join(cand_rules)),
                "baseline_rules": base_rules, "candidate_rules": cand_rules, "new_rules": new_rules,
            })
            if br.safety_critical or (set(new_rules) & SAFETY_RULES):
                safety_regressions.append(tid)
        elif (not br.hard_pass and cr.hard_pass) or resolved_rules:
            improvements.append(tid)
        if new_rules or resolved_rules or flipped or (not br.hard_pass and cr.hard_pass):
            changed.append({"task_id": tid, "baseline_hard_pass": br.hard_pass, "candidate_hard_pass": cr.hard_pass, "baseline_rules": base_rules, "candidate_rules": cand_rules, "new_rules": new_rules, "resolved_rules": resolved_rules})

    base_pass = sum(1 for r in base.values() if r.hard_pass)
    cand_pass = sum(1 for r in cand.values() if r.hard_pass)
    missing_candidate = [tid for tid in base if tid not in cand]
    regressed = bool(regressions) or bool(safety_regressions) or cand_pass < base_pass or bool(missing_candidate)
    return {
        "mode": "compare",
        "baseline_tasks": len(base),
        "candidate_tasks": len(cand),
        "base_hard_pass": base_pass,
        "candidate_hard_pass": cand_pass,
        "missing_candidate": missing_candidate,
        "regressions": regressions,
        "safety_regressions": sorted(set(safety_regressions)),
        "improvements": improvements,
        "changed_tasks": changed,
        "regressed": regressed,
    }


def _print_compare(rep: dict) -> None:
    print("=== compare (candidate vs baseline) ===")
    print(
        "base_hard_pass=%d candidate_hard_pass=%d baseline_tasks=%d candidate_tasks=%d"
        % (rep["base_hard_pass"], rep["candidate_hard_pass"], rep["baseline_tasks"], rep["candidate_tasks"])
    )
    if rep["missing_candidate"]:
        print("MISSING candidate traces: %s" % ", ".join(rep["missing_candidate"]))
    if rep["safety_regressions"]:
        print("SAFETY REGRESSIONS: %s" % ", ".join(rep["safety_regressions"]))
    if rep["regressions"]:
        print("regressions (%d):" % len(rep["regressions"]))
        for r in rep["regressions"]:
            print("  %-18s %s" % (r["task_id"], r["reason"]))
    if rep["improvements"]:
        print("improvements (%d): %s" % (len(rep["improvements"]), ", ".join(rep["improvements"])))
    if rep.get("changed_tasks"):
        print("changed tasks (rule deltas):")
        for c in rep["changed_tasks"]:
            print("  %-18s base=%s cand=%s new=%s resolved=%s" % (c["task_id"], c["baseline_rules"], c["candidate_rules"], c["new_rules"], c["resolved_rules"]))
    print("RESULT: %s" % ("REGRESSED" if rep["regressed"] else "OK (no regression)"))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Agent eval hard-lane runner (baseline + compare)")
    ap.add_argument("--eval-root", default=_EVAL_ROOT, help="eval/ dir (default: parent of runner/)")
    ap.add_argument("--tasks", help="tasks dir (default: <eval-root>/tasks)")
    ap.add_argument("--traces", help="baseline traces jsonl (default: <eval-root>/baselines/v0.13.0.jsonl)")
    ap.add_argument("--candidate-traces", help="candidate traces jsonl (for --compare)")
    ap.add_argument("--catalog", help="tool_catalog.json (default: <eval-root>/tool_catalog.json)")
    ap.add_argument("--out", help="report output prefix (default: <eval-root>/baselines/<run-id>.report)")
    ap.add_argument("--run-id", default="v0.13.0-baseline")
    ap.add_argument("--validate", action="store_true", help="validate schema + coverage only, then exit")
    ap.add_argument("--compare", action="store_true", help="compare --candidate-traces against --traces (regression gate)")
    ap.add_argument("--fail-on-hard-fail", action="store_true", help="exit 1 if any task hard-fails (NOT a regression gate; use --compare for that)")
    args = ap.parse_args(argv)

    eval_root = os.path.abspath(args.eval_root)
    tasks_dir = args.tasks or _default(eval_root, "tasks")
    traces_path = args.traces or _default(eval_root, "baselines", "v0.13.0.jsonl")
    catalog_path = args.catalog or _default(eval_root, "tool_catalog.json")
    out_prefix = args.out or _default(eval_root, "baselines", "%s.report" % args.run_id)

    # ---- validate lane ---------------------------------------------------- #
    ok, errors, stats = loader.validate_all(eval_root)
    print("=== validate: %s ===" % eval_root)
    print(
        "total_tasks=%d traces_found=%d coverage_ok=%s (min_total=%d min_per_category=%d)"
        % (stats.get("total_tasks", 0), stats.get("traces_found", 0), stats.get("coverage_ok"), stats.get("min_total", 0), stats.get("min_per_category", 0))
    )
    print("category_counts:")
    for cat, n in sorted(stats.get("category_counts", {}).items()):
        flag = "" if n >= stats.get("min_per_category", 3) else "  <-- UNDER MIN"
        print("  %-18s %d%s" % (cat, n, flag))
    if errors:
        print("VALIDATION ERRORS (%d):" % len(errors))
        for e in errors:
            print("  - %s" % e)
    else:
        print("schema validation: OK")

    if args.validate:
        coverage_ok = bool(stats.get("coverage_ok"))
        if not ok or not coverage_ok:
            print("RESULT: FAIL (schema_ok=%s coverage_ok=%s)" % (ok, coverage_ok))
            return 1
        print("RESULT: OK (schema + coverage)")
        return 0

    if not ok:
        print("Refusing to score: fix validation errors first.")
        return 1

    catalog = loader.load_catalog(catalog_path)
    tasks = loader.load_tasks(tasks_dir)

    # ---- compare lane (C1 regression gate) -------------------------------- #
    if args.compare:
        if not args.candidate_traces:
            print("--compare requires --candidate-traces")
            return 2
        # C1: validate candidate (and non-default baseline) trace files before scoring
        task_by_id = {t.id: t.raw for t in tasks}
        val_errors = loader.validate_trace_file(args.candidate_traces, task_by_id, catalog)
        default_baseline = _default(eval_root, "baselines", "v0.13.0.jsonl")
        if os.path.abspath(traces_path) != os.path.abspath(default_baseline):
            val_errors += loader.validate_trace_file(traces_path, task_by_id, catalog)
        if val_errors:
            print("CANDIDATE/BASELINE TRACE VALIDATION ERRORS (%d):" % len(val_errors))
            for e in val_errors:
                print("  - %s" % e)
            print("RESULT: FAIL (invalid trace file)")
            return 1
        base_traces = loader.load_traces(traces_path)
        cand_traces = loader.load_traces(args.candidate_traces)
        rep = compare_runs(tasks, base_traces, cand_traces, catalog)
        report_mod.write_json(rep, out_prefix + ".compare.json")
        _print_compare(rep)
        print("compare report: %s" % (out_prefix + ".compare.json"))
        return 1 if rep["regressed"] else 0

    # ---- baseline score lane ---------------------------------------------- #
    traces = loader.load_traces(traces_path)
    results = []
    for task in tasks:
        trace = traces.get(task.id)
        if trace is None:
            results.append(
                TaskResult(
                    task_id=task.id,
                    category=task.category,
                    safety_critical=task.safety_critical,
                    hard_pass=False,
                    violations=[RuleViolation("TRACE", "no baseline trace for task")],
                    trace_source="missing",
                    metrics={},
                )
            )
            continue
        results.append(rules.score_task(task, trace, catalog))

    rep = report_mod.build_report(results, args.run_id, traces_path)
    json_path = out_prefix + ".json"
    md_path = out_prefix + ".md"
    report_mod.write_json(rep, json_path)
    report_mod.write_md(rep, md_path)
    report_mod.print_summary(rep)
    print("report written:")
    print("  %s" % json_path)
    print("  %s" % md_path)

    if args.fail_on_hard_fail and rep["totals"]["hard_fail"] > 0:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
