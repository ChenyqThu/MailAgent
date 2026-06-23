"""Aggregate TaskResults -> baseline report (json + markdown). schema.md §6."""
from __future__ import annotations

import json
from typing import Any, Dict, List

from runner.models import TaskResult


def build_report(results: List[TaskResult], run_id: str, traces_path: str) -> Dict[str, Any]:
    total = len(results)
    passed = sum(1 for r in results if r.hard_pass)

    cats: Dict[str, Dict[str, int]] = {}
    for r in results:
        c = cats.setdefault(r.category, {"total": 0, "pass": 0})
        c["total"] += 1
        c["pass"] += 1 if r.hard_pass else 0
    for c in cats.values():
        c["rate"] = round(c["pass"] / c["total"], 3) if c["total"] else 0.0

    safety = [r for r in results if r.safety_critical]
    safety_pass = sum(1 for r in safety if r.hard_pass)

    return {
        "run_id": run_id,
        "traces_path": traces_path,
        "lane": "hard",
        "totals": {
            "tasks": total,
            "hard_pass": passed,
            "hard_fail": total - passed,
            "pass_rate": round(passed / total, 3) if total else 0.0,
        },
        "safety": {
            "total": len(safety),
            "pass": safety_pass,
            "rate": round(safety_pass / len(safety), 3) if safety else 0.0,
        },
        "by_category": dict(sorted(cats.items())),
        "tasks": [r.as_dict() for r in sorted(results, key=lambda x: x.task_id)],
    }


def write_json(report: Dict[str, Any], path: str) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def _fmt_violations(viols: List[Dict[str, str]]) -> str:
    if not viols:
        return "—"
    return "; ".join("%s:%s" % (v["rule"], v["detail"]) for v in viols)


def write_md(report: Dict[str, Any], path: str) -> None:
    t = report["totals"]
    s = report["safety"]
    lines: List[str] = []
    lines.append("# Agent Eval Baseline Report — %s" % report["run_id"])
    lines.append("")
    lines.append("> lane: **hard** (rule gate R1-R8, zero LLM) · traces: `%s`" % report["traces_path"])
    lines.append("")
    lines.append("## Totals")
    lines.append("")
    lines.append("| metric | value |")
    lines.append("|---|---|")
    lines.append("| tasks | %d |" % t["tasks"])
    lines.append("| hard_pass | %d |" % t["hard_pass"])
    lines.append("| hard_fail | %d |" % t["hard_fail"])
    lines.append("| pass_rate | %s |" % t["pass_rate"])
    lines.append("| safety_critical pass | %d/%d (%s) |" % (s["pass"], s["total"], s["rate"]))
    lines.append("")
    lines.append("## By category")
    lines.append("")
    lines.append("| category | pass/total | rate |")
    lines.append("|---|---|---|")
    for cat, c in report["by_category"].items():
        lines.append("| %s | %d/%d | %s |" % (cat, c["pass"], c["total"], c["rate"]))
    lines.append("")
    lines.append("## Per-task")
    lines.append("")
    lines.append("| task_id | category | hard_pass | source | violations |")
    lines.append("|---|---|:---:|---|---|")
    for r in report["tasks"]:
        lines.append(
            "| %s | %s | %s | %s | %s |"
            % (
                r["task_id"],
                r["category"],
                "✅" if r["hard_pass"] else "❌",
                r["trace_source"],
                _fmt_violations(r["violations"]),
            )
        )
    lines.append("")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))


def print_summary(report: Dict[str, Any]) -> None:
    t = report["totals"]
    s = report["safety"]
    print("=== baseline report: %s ===" % report["run_id"])
    print("tasks=%d hard_pass=%d hard_fail=%d pass_rate=%s" % (t["tasks"], t["hard_pass"], t["hard_fail"], t["pass_rate"]))
    print("safety_critical: %d/%d pass (rate=%s)" % (s["pass"], s["total"], s["rate"]))
    print("by_category:")
    for cat, c in report["by_category"].items():
        print("  %-18s %d/%d  rate=%s" % (cat, c["pass"], c["total"], c["rate"]))
    fails = [r for r in report["tasks"] if not r["hard_pass"]]
    if fails:
        print("failures (%d):" % len(fails))
        for r in fails:
            print("  %-18s %s" % (r["task_id"], _fmt_violations(r["violations"])))
