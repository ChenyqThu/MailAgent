"""Load + strictly validate tasks / traces / fixtures / catalog (schema.md).

Validation is structural and reference-level only (zero LLM). Returns plain
string error lists so callers can print and gate.
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional, Tuple

from runner.models import (
    CATEGORIES,
    EVENT_TYPES,
    EVIDENCE_TYPES,
    RUBRIC_DIMS,
    SURFACES,
    Task,
    ToolCatalog,
    TraceRecord,
)

FINAL_STATUSES = {"answered", "no_results", "needs_confirmation", "error"}
TRACE_SOURCES = {"synthetic_baseline", "recorded"}
CONFIRM_TIERS = {"preview", "edit"}
MIN_PER_CATEGORY = 3
MIN_TOTAL = 24


# --------------------------------------------------------------------------- #
# IO helpers
# --------------------------------------------------------------------------- #
def _read_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def load_catalog(path: str) -> ToolCatalog:
    data = _read_json(path)
    return ToolCatalog(tools=data["tools"])


def load_tasks(tasks_dir: str) -> List[Task]:
    out: List[Task] = []
    for name in sorted(os.listdir(tasks_dir)):
        if not name.endswith(".json"):
            continue
        out.append(Task.from_dict(_read_json(os.path.join(tasks_dir, name))))
    return out


def load_traces(jsonl_path: str) -> Dict[str, TraceRecord]:
    out: Dict[str, TraceRecord] = {}
    with open(jsonl_path, "r", encoding="utf-8") as fh:
        for ln, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            out[d["task_id"]] = TraceRecord.from_dict(d)
    return out


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #
def validate_task(d: Dict[str, Any], catalog: ToolCatalog, eval_root: str) -> List[str]:
    errs: List[str] = []
    tid = d.get("id", "<no-id>")

    def err(msg: str) -> None:
        errs.append("[task %s] %s" % (tid, msg))

    required = [
        "id", "category", "title", "surface", "user_prompt", "fixtures",
        "allowed_tools", "must_use_tools", "forbidden_tools", "expected_evidence",
        "no_hit_expected", "safety_critical", "rubric", "rubric_ref", "notes",
    ]
    for k in required:
        if k not in d:
            err("missing required field: %s" % k)
    if errs:
        return errs

    if not str(d["id"]).startswith("AGT-"):
        err("id must start with 'AGT-'")
    if d["category"] not in CATEGORIES:
        err("invalid category: %s" % d["category"])
    if d["surface"] not in SURFACES:
        err("invalid surface: %s" % d["surface"])
    if d["surface"] == "email":
        ec = d.get("email_context")
        if not isinstance(ec, dict) or "internal_id" not in ec:
            err("surface=email requires email_context.internal_id")

    allowed = set(d.get("allowed_tools") or [])
    for t in allowed:
        if not catalog.known(t):
            err("allowed_tools has unknown tool: %s" % t)
    for t in d.get("must_use_tools") or []:
        if not catalog.known(t):
            err("must_use_tools has unknown tool: %s" % t)
        if allowed and t not in allowed:
            err("must_use tool not in allowed_tools: %s" % t)
    for t in d.get("allowed_support_tools") or []:
        if not catalog.known(t):
            err("allowed_support_tools has unknown tool: %s" % t)
    # forbidden_tools MAY contain non-catalog names (intent guards e.g. email_send)

    for ev in d.get("expected_evidence") or []:
        if not isinstance(ev, dict) or "type" not in ev or "id" not in ev:
            err("expected_evidence item needs type+id: %s" % ev)
        elif ev["type"] not in EVIDENCE_TYPES:
            err("expected_evidence has invalid type: %s" % ev["type"])

    if not isinstance(d.get("no_hit_expected"), bool):
        err("no_hit_expected must be bool")
    elif d["no_hit_expected"] and (d.get("expected_evidence") or []):
        err("no_hit_expected=true contradicts non-empty expected_evidence")
    if not isinstance(d.get("safety_critical"), bool):
        err("safety_critical must be bool")

    rubric = d.get("rubric") or {}
    for k in rubric:
        if k not in RUBRIC_DIMS:
            err("rubric has unknown dimension: %s" % k)
    if rubric:
        total = sum(float(v) for v in rubric.values())
        if abs(total - 1.0) > 0.001:
            err("rubric weights must sum to 1.0 (got %s)" % round(total, 4))

    rref = d.get("rubric_ref")
    if rref and not os.path.isfile(os.path.join(eval_root, "rubrics", rref)):
        err("rubric_ref file missing: rubrics/%s" % rref)

    fx = d.get("fixtures") or {}
    for fid in fx.get("emails") or []:
        if not os.path.isfile(os.path.join(eval_root, "fixtures", "emails", "%s.json" % fid)):
            err("fixture email missing: fixtures/emails/%s.json" % fid)
    for fid in fx.get("memory") or []:
        if not os.path.isfile(os.path.join(eval_root, "fixtures", "memory", "%s.json" % fid)):
            err("fixture memory missing: fixtures/memory/%s.json" % fid)
    for sk, val in (fx.get("skill_overrides") or {}).items():
        if not isinstance(val, bool):
            err("skill_overrides[%s] must be bool" % sk)

    budget = d.get("budget")
    if budget is not None:
        if not isinstance(budget, dict):
            err("budget must be an object")

    return errs


def validate_trace(d: Dict[str, Any], catalog: ToolCatalog) -> List[str]:
    errs: List[str] = []
    tid = d.get("task_id", "<no-task_id>")

    def err(msg: str) -> None:
        errs.append("[trace %s] %s" % (tid, msg))

    if "task_id" not in d:
        err("missing task_id")
    if d.get("source") not in TRACE_SOURCES:
        err("source must be one of %s" % sorted(TRACE_SOURCES))

    config = d.get("config") or {}
    for k in ("model", "max_iter", "max_cost_usd"):
        if k not in config:
            err("config missing %s" % k)
    for k in ("agent_profile_hash", "installed_skills_hash", "active_skills_hash", "standing_context_active"):
        if k not in config:
            err("config missing hash/flag field: %s" % k)

    events = d.get("events")
    if not isinstance(events, list):
        err("events must be a list")
        events = []
    for i, e in enumerate(events):
        et = e.get("type")
        if et not in EVENT_TYPES:
            err("event[%d] invalid type: %s" % (i, et))
            continue
        if et == "tool_use":
            if not e.get("tool_use_id") or not e.get("name"):
                err("tool_use[%d] needs tool_use_id+name" % i)
        elif et == "tool_result":
            if not e.get("tool_use_id") or e.get("status") not in ("ok", "error", "canceled"):
                err("tool_result[%d] needs tool_use_id + status in ok/error/canceled" % i)
        elif et == "pending_confirmation":
            if not e.get("tool_use_id") or not e.get("tool_name"):
                err("pending_confirmation[%d] needs tool_use_id+tool_name" % i)
            if e.get("tier") not in CONFIRM_TIERS:
                err("pending_confirmation[%d] tier must be preview/edit" % i)

    metrics = d.get("metrics") or {}
    for k in ("iterations", "cost_usd"):
        if k not in metrics:
            err("metrics missing %s" % k)

    final = d.get("final") or {}
    if final.get("status") not in FINAL_STATUSES:
        err("final.status must be one of %s" % sorted(FINAL_STATUSES))
    for ev in final.get("evidence") or []:
        if not isinstance(ev, dict) or "type" not in ev or "id" not in ev:
            err("final.evidence item needs type+id: %s" % ev)
    if "no_results" in final and not isinstance(final.get("no_results"), bool):
        err("final.no_results must be bool")

    return errs


def _is_hex64(s: Any) -> bool:
    return isinstance(s, str) and len(s) == 64 and all(c in "0123456789abcdef" for c in s.lower())


def validate_trace_consistency(d: Dict[str, Any], task: Optional[Dict[str, Any]], catalog: ToolCatalog) -> List[str]:
    """Cross-check a trace against its task + internal consistency (M1).

    `task` is the task dict (or None if the trace has no matching task).
    """
    errs: List[str] = []
    tid = d.get("task_id", "<no-task_id>")

    def err(msg: str) -> None:
        errs.append("[trace %s] %s" % (tid, msg))

    if d.get("trace_version") != "1.0":
        err("trace_version must be '1.0' (got %r)" % d.get("trace_version"))

    if task is not None and d.get("surface") != task.get("surface"):
        err("surface %r != task.surface %r" % (d.get("surface"), task.get("surface")))

    config = d.get("config") or {}
    if d.get("source") == "recorded":
        for hk in ("agent_profile_hash", "installed_skills_hash", "active_skills_hash"):
            if not _is_hex64(config.get(hk)):
                err("recorded trace requires 64-hex %s" % hk)

    events = d.get("events") or []
    use_ids: Dict[str, Any] = {}
    n_use = 0
    for e in events:
        if e.get("type") == "tool_use":
            n_use += 1
            name = e.get("name")
            use_ids[e.get("tool_use_id")] = name
            if name and not catalog.known(name):
                err("tool_use references unknown tool: %s" % name)

    metrics = d.get("metrics") or {}
    if "tool_calls" in metrics and metrics["tool_calls"] != n_use:
        err("metrics.tool_calls %s != count(tool_use) %s" % (metrics["tool_calls"], n_use))

    for e in events:
        et = e.get("type")
        if et == "tool_result" and e.get("tool_use_id") not in use_ids:
            err("tool_result without matching tool_use: %s" % e.get("tool_use_id"))
        if et == "pending_confirmation":
            pid = e.get("tool_use_id")
            if pid in use_ids and e.get("tool_name") != use_ids[pid]:
                err("pending_confirmation.tool_name %r != tool_use.name %r" % (e.get("tool_name"), use_ids[pid]))

    return errs


def load_trace_lines(path: str) -> List[Tuple[int, str]]:
    """Return [(lineno, raw_line)] for non-blank lines of a JSONL file."""
    out: List[Tuple[int, str]] = []
    with open(path, "r", encoding="utf-8") as fh:
        for ln, line in enumerate(fh, 1):
            line = line.strip()
            if line:
                out.append((ln, line))
    return out


def validate_trace_file(path: str, task_by_id: Dict[str, Dict[str, Any]], catalog: ToolCatalog, require_known_task: bool = True) -> List[str]:
    """Reusable structural + consistency validation for ANY trace JSONL file
    (baseline / candidate / runs). Catches bad json, within-file duplicate task_id,
    unknown task_id, and every validate_trace / validate_trace_consistency error
    (incl. recorded 64-hex hashes, surface mismatch, tool_calls mismatch, orphan
    tool_result, unknown tools, pending tool_name mismatch)."""
    if not os.path.isfile(path):
        return ["trace file not found: %s" % path]
    errs: List[str] = []
    base = os.path.basename(path)
    seen: set = set()
    for ln, line in load_trace_lines(path):
        try:
            d = json.loads(line)
        except json.JSONDecodeError as exc:
            errs.append("[%s:%d] bad json: %s" % (base, ln, exc))
            continue
        tid = d.get("task_id")
        if tid in seen:
            errs.append("[trace %s] duplicate trace within %s" % (tid, base))
        if tid:
            seen.add(tid)
        if require_known_task and tid not in task_by_id:
            errs.append("[trace %s] unknown task_id (no matching task) in %s" % (tid, base))
        errs.extend(validate_trace(d, catalog))
        errs.extend(validate_trace_consistency(d, task_by_id.get(tid), catalog))
    return errs


def validate_all(eval_root: str) -> Tuple[bool, List[str], Dict[str, Any]]:
    """Validate catalog + every task + every baseline trace + coverage.

    Returns (ok, errors, stats). stats includes category_counts, totals,
    and coverage_ok (>=24 total and >=3 per category).
    """
    errors: List[str] = []
    catalog_path = os.path.join(eval_root, "tool_catalog.json")
    if not os.path.isfile(catalog_path):
        return False, ["tool_catalog.json missing"], {}
    catalog = load_catalog(catalog_path)

    tasks_dir = os.path.join(eval_root, "tasks")
    task_files = sorted(f for f in os.listdir(tasks_dir) if f.endswith(".json")) if os.path.isdir(tasks_dir) else []
    task_ids: List[str] = []
    task_by_id: Dict[str, Dict[str, Any]] = {}
    cat_counts: Dict[str, int] = {c: 0 for c in CATEGORIES}
    for f in task_files:
        d = _read_json(os.path.join(tasks_dir, f))
        errs = validate_task(d, catalog, eval_root)
        errors.extend(errs)
        if not errs:
            tid = d["id"]
            if tid in task_ids:
                errors.append("[task %s] duplicate id" % tid)
            task_ids.append(tid)
            task_by_id[tid] = d
            cat_counts[d["category"]] = cat_counts.get(d["category"], 0) + 1

    # traces (all jsonl under baselines/) — reuse validate_trace_file per file,
    # then track task_ids for coverage + cross-file duplicate detection.
    baselines_dir = os.path.join(eval_root, "baselines")
    trace_ids: Dict[str, str] = {}  # task_id -> file
    if os.path.isdir(baselines_dir):
        for f in sorted(os.listdir(baselines_dir)):
            if not f.endswith(".jsonl"):
                continue
            fpath = os.path.join(baselines_dir, f)
            errors.extend(validate_trace_file(fpath, task_by_id, catalog))
            for _ln, line in load_trace_lines(fpath):
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue  # already reported by validate_trace_file
                tid = d.get("task_id")
                if tid in trace_ids and trace_ids[tid] != f:
                    errors.append("[trace %s] duplicate trace across files (%s, %s)" % (tid, trace_ids[tid], f))
                if tid:
                    trace_ids[tid] = f

    # every task should have a trace (only enforced if any traces exist)
    if trace_ids:
        for tid in task_ids:
            if tid not in trace_ids:
                errors.append("[task %s] no baseline trace found" % tid)

    total = len(task_ids)
    under = {c: n for c, n in cat_counts.items() if n < MIN_PER_CATEGORY}
    coverage_ok = total >= MIN_TOTAL and not under
    stats = {
        "total_tasks": total,
        "category_counts": cat_counts,
        "under_min_categories": under,
        "min_total": MIN_TOTAL,
        "min_per_category": MIN_PER_CATEGORY,
        "coverage_ok": coverage_ok,
        "traces_found": len(trace_ids),
    }
    return (len(errors) == 0), errors, stats
