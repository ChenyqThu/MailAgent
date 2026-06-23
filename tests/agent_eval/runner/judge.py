#!/usr/bin/env python3
"""LLM-as-judge — MANUAL LANE (schema.md §3). Soft rubric scoring.

This is the ONLY module that calls an LLM. It is never imported by the rule-gate
path (rules.py / run_baseline.py / loader / tests), so CI stays zero-token. Run by hand:

    venv/bin/python3 eval/runner/judge.py --task AGT-SEARCH-001 --task AGT-NOHIT-001
    venv/bin/python3 eval/runner/judge.py --limit 2

The judge is EVIDENCE-DRIVEN (H3 fix): the prompt carries the task's expected
evidence, allowed/must-use/forbidden tools, the actual tool_result outputs, the
referenced fixture email/memory contents, and the hard-rule (R1-R8) violations —
so it can judge correctness/grounding against reference facts, not just plausibility.

Reads LLM creds from .env (LLM_API_KEY / LLM_API_BASE / LLM_MODEL). No key => exits 2.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

_EVAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _EVAL_ROOT not in sys.path:
    sys.path.insert(0, _EVAL_ROOT)

from runner import loader, rules  # noqa: E402

JUDGE_VERSION = "1.1"
_BODY_CAP = 800
_OUTPUT_CAP = 1500


def _find_repo_root(start: str) -> str:
    """Walk up to the repo root (.env/.git marker). Location-independent so the
    judge works whether eval/ lives under .trellis or tests/."""
    d = start
    for _ in range(10):
        if os.path.isfile(os.path.join(d, ".env")) or os.path.isdir(os.path.join(d, ".git")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return start


_REPO_ROOT = _find_repo_root(_EVAL_ROOT)


def load_env() -> dict:
    env: dict = {}
    for candidate in (os.path.join(_REPO_ROOT, ".env"), os.path.join(os.getcwd(), ".env")):
        if os.path.isfile(candidate):
            try:
                from dotenv import dotenv_values

                env.update({k: v for k, v in dotenv_values(candidate).items() if v})
            except Exception:
                with open(candidate, "r", encoding="utf-8") as fh:
                    for line in fh:
                        line = line.strip()
                        if not line or line.startswith("#") or "=" not in line:
                            continue
                        k, v = line.split("=", 1)
                        env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
            break
    for k in ("LLM_API_KEY", "LLM_API_BASE", "LLM_MODEL"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


JUDGE_SYSTEM = (
    "You are a strict eval judge for an email-assistant agent. You score a single "
    "agent transcript against a rubric, using the provided reference facts (expected "
    "evidence, tool outputs, fixtures) as ground truth. Reply with ONLY a JSON object."
)


def _tool_results(trace) -> list:
    use_name = {e.get("tool_use_id"): e.get("name") for e in trace.tool_uses()}
    out = []
    for ev in trace.tool_results():
        blob = json.dumps(ev.get("output"), ensure_ascii=False, default=str) if ev.get("output") is not None else ""
        if len(blob) > _OUTPUT_CAP:
            blob = blob[:_OUTPUT_CAP] + "…(truncated)"
        out.append({"tool": use_name.get(ev.get("tool_use_id")), "status": ev.get("status"), "output": blob})
    return out


def _load_fixtures(eval_root: str, task) -> dict:
    fx = task.fixtures or {}
    emails = []
    for fid in fx.get("emails") or []:
        p = os.path.join(eval_root, "fixtures", "emails", "%s.json" % fid)
        if os.path.isfile(p):
            with open(p, "r", encoding="utf-8") as fh:
                d = json.load(fh)
            body = (d.get("body_markdown") or "")[:_BODY_CAP]
            emails.append({"internal_id": d.get("internal_id"), "subject": d.get("subject"), "body": body})
    memory = []
    for fid in fx.get("memory") or []:
        p = os.path.join(eval_root, "fixtures", "memory", "%s.json" % fid)
        if os.path.isfile(p):
            with open(p, "r", encoding="utf-8") as fh:
                memory.append(json.load(fh))
    return {"emails": emails, "memory": memory}


def build_prompt(task, trace, rubric_text: str, tool_results: list, fixtures: dict, hard_violations: list) -> str:
    dims = list(task.rubric.keys())
    final = trace.final or {}
    payload = {
        "task": {
            "id": task.id,
            "category": task.category,
            "user_prompt": task.user_prompt,
            "no_hit_expected": task.no_hit_expected,
            "expected_evidence": task.expected_evidence,
            "allowed_tools": task.allowed_tools,
            "must_use_tools": task.must_use_tools,
            "forbidden_tools": task.forbidden_tools,
        },
        "reference_fixtures": fixtures,
        "rubric_dimensions": task.rubric,
        "rubric_anchors": rubric_text,
        "agent": {
            "tool_calls": [e.get("name") for e in trace.tool_uses()],
            "tool_results": tool_results,
            "final_status": final.get("status"),
            "final_answer": final.get("answer"),
            "final_evidence": final.get("evidence"),
        },
        "hard_rule_violations": hard_violations,
    }
    schema_hint = {d: {"score": "0..1 float", "rationale": "short string"} for d in dims}
    return (
        "Score this agent transcript against the rubric, using reference_fixtures and "
        "expected_evidence as ground truth. For EACH rubric dimension give a 0..1 float and a one-line rationale.\n"
        "Return ONLY JSON of the form: " + json.dumps(schema_hint, ensure_ascii=False) + "\n\n"
        "DATA:\n" + json.dumps(payload, ensure_ascii=False, indent=2)
    )


def _extract_json(text: str) -> dict:
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z0-9]*\s*", "", t)
        t = re.sub(r"\s*```$", "", t)
    m = re.search(r"\{.*\}", t, re.DOTALL)
    if not m:
        raise ValueError("no JSON object in judge output: %r" % text[:200])
    return json.loads(m.group(0))


def _clamp(x) -> float:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, v))


def call_llm(env: dict, prompt: str) -> str:
    from anthropic import Anthropic

    client = Anthropic(api_key=env["LLM_API_KEY"], base_url=env.get("LLM_API_BASE") or None)
    model = env.get("LLM_MODEL", "claude-sonnet-4-6")
    try:
        msg = client.messages.create(
            model=model, max_tokens=900, system=JUDGE_SYSTEM, messages=[{"role": "user", "content": prompt}]
        )
        return "".join(getattr(b, "text", "") for b in msg.content)
    except Exception:
        chunks = []
        with client.messages.stream(
            model=model, max_tokens=900, system=JUDGE_SYSTEM, messages=[{"role": "user", "content": prompt}]
        ) as stream:
            for t in stream.text_stream:
                chunks.append(t)
        return "".join(chunks)


def score_from_raw(task, raw: str, model: str, hard_pass: bool) -> dict:
    """Pure: parse + clamp + weight. Separated from the LLM call for unit testing."""
    scores = _extract_json(raw)
    total = 0.0
    per_dim = {}
    for dim, weight in task.rubric.items():
        s = scores.get(dim)
        if isinstance(s, dict):
            val = _clamp(s.get("score", 0.0))
            rationale = s.get("rationale", "")
        elif s is None:
            val, rationale = 0.0, "missing dimension"
        else:
            val, rationale = _clamp(s), ""
        per_dim[dim] = {"score": round(val, 3), "weight": weight, "rationale": rationale}
        total += val * float(weight)
    return {
        "task_id": task.id,
        "category": task.category,
        "score_total": round(total, 3),
        "dimensions": per_dim,
        "hard_pass": hard_pass,
        "judge_model": model,
        "judge_version": JUDGE_VERSION,
    }


def judge_task(env, task, trace, rubric_text, tool_results, fixtures, hard_violations, hard_pass) -> dict:
    prompt = build_prompt(task, trace, rubric_text, tool_results, fixtures, hard_violations)
    raw = call_llm(env, prompt)
    return score_from_raw(task, raw, env.get("LLM_MODEL", "claude-sonnet-4-6"), hard_pass)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="LLM-as-judge manual lane (soft rubric)")
    ap.add_argument("--eval-root", default=_EVAL_ROOT)
    ap.add_argument("--traces", help="traces jsonl (default: <eval-root>/baselines/v0.13.0.jsonl)")
    ap.add_argument("--task", action="append", default=[], help="task id (repeatable)")
    ap.add_argument("--limit", type=int, default=0, help="judge first N tasks if no --task given")
    args = ap.parse_args(argv)

    eval_root = os.path.abspath(args.eval_root)
    env = load_env()
    if not env.get("LLM_API_KEY"):
        print("manual lane SKIPPED: no LLM_API_KEY in .env/env (judge never runs in CI).")
        return 2

    catalog = loader.load_catalog(os.path.join(eval_root, "tool_catalog.json"))
    tasks = {t.id: t for t in loader.load_tasks(os.path.join(eval_root, "tasks"))}
    traces = loader.load_traces(args.traces or os.path.join(eval_root, "baselines", "v0.13.0.jsonl"))

    ids = args.task if args.task else sorted(tasks)[: args.limit or 1]

    print("=== LLM judge (manual lane) model=%s version=%s tasks=%s ===" % (env.get("LLM_MODEL"), JUDGE_VERSION, ids))
    out = []
    for tid in ids:
        task = tasks.get(tid)
        trace = traces.get(tid)
        if not task or not trace:
            print("  %s: SKIP (missing task or trace)" % tid)
            continue
        rubric_text = ""
        rpath = os.path.join(eval_root, "rubrics", task.rubric_ref)
        if os.path.isfile(rpath):
            with open(rpath, "r", encoding="utf-8") as fh:
                rubric_text = fh.read()
        result = rules.score_task(task, trace, catalog)
        hard_violations = [v.as_dict() for v in result.violations]
        try:
            res = judge_task(
                env, task, trace, rubric_text,
                _tool_results(trace), _load_fixtures(eval_root, task), hard_violations, result.hard_pass,
            )
        except Exception as exc:  # noqa: BLE001
            print("  %s: ERROR %s" % (tid, exc))
            continue
        out.append(res)
        print(json.dumps(res, ensure_ascii=False))
    print("=== judged %d task(s) ===" % len(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
