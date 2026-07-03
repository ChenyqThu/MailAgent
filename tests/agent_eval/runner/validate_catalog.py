#!/usr/bin/env python3
"""tool_catalog.json freshness check (M4, redirected to the gateway in S3) — zero LLM, zero deps.

S3 deleted the legacy TS chat engine (frontend/src/shared/chat), so this validator now
scans the AI SDK Gateway tool sources (frontend/src/ai-gateway/tools/*.ts) and compares
BOTH directions against tool_catalog.json:

  * name universe  — every gateway tool must have a catalog row (mirrors the
    test_gateway_catalog_completeness.py forward gate, double-belt), and every
    non-`legacy_retired` catalog row must exist in the gateway (the REVERSE guard the
    legacy-source deletion would otherwise have silently vacated — a stale catalog row
    can no longer linger unnoticed).
  * tier            — each tool's catalog `tier` must match the source: auditedReadTool
    tools are implicitly `silent`; auditedWriteTool tools carry a literal `risk:
    'preview'|'edit'`; the auditedSendTool (email_prepare_send) is blocking, which the
    persistence/eval layer maps to `edit`.
  * legacy_retired  — the two rows kept ONLY because the frozen v0.13.0 baseline traces
    call them (skill_list_installed / plan_update) must stay ABSENT from the gateway; if
    a future gateway tool reuses the name, the row must be promoted to a normal row.

    python runner/validate_catalog.py            # from tests/agent_eval
    python runner/validate_catalog.py --source <gateway tools dir>
    python runner/validate_catalog.py --source-ref <git ref>

Exit 0 = in sync (or source dir absent → skipped, e.g. CI without the frontend
checkout); exit 1 = drift.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import subprocess
import tempfile
from typing import Dict, List, Optional, Set, Tuple

_EVAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DEFAULT_SOURCE = os.path.join("frontend", "src", "ai-gateway", "tools")

# ---- name universe (same extraction as test_gateway_catalog_completeness.py) ----
# `export const GATEWAY_<X>_TOOL_NAMES [: type] = [ 'a', 'b' ]` — DOTALL, first `]` ends
# the literal (tool-name arrays never nest).
NAME_ARRAY_RE = re.compile(r"export\s+const\s+GATEWAY_[A-Z0-9_]*TOOL_NAMES[^=]*=\s*\[(.*?)\]", re.S)
# skill_gating.ts: record literal ends at the first column-0 `}`; sets are single literals.
SKILL_TOOLS_RECORD_RE = re.compile(r"GATEWAY_SKILL_TOOLS[^=]*=\s*\{(.*?)\n\}", re.S)
SET_LITERAL_RE = re.compile(r"new\s+Set\(\[(.*?)\]\)", re.S)
TOOL_NAME_RE = re.compile(r"'([a-z][a-z0-9_]*)'")

# ---- tier extraction (per-tool option objects) ----
# Every gateway tool is declared as an option object holding a line-anchored
# `name: '<snake_case>'` literal. Two declaration shapes exist:
#   * direct / per-tool risk (write.ts, profile.ts, web.ts, self_mount.ts): a line-anchored
#     `risk: 'preview'|'edit'` literal inside the SAME object → paired within the name's span.
#   * file-level helper factory (exec.ts, skill_supply.ts): ONE `risk: 'edit'` literal inside
#     the helper's auditedWriteTool() call, BEFORE every tool's name → the nearest
#     `audited*Tool(` call preceding the name disambiguates (Read → silent, Write → the
#     nearest preceding risk literal, Send → edit).
# Helper-factory parameter TYPES (`name: string` / `risk: Exclude<...>`) carry no quoted
# literal so they never match.
NAME_LINE_RE = re.compile(r"^\s*name:\s*'([a-z][a-z0-9_]*)'", re.M)
RISK_LINE_RE = re.compile(r"^\s*risk:\s*'(preview|edit)'", re.M)
FACTORY_RE = re.compile(r"audited(Read|Write|Send)Tool\(")

# auditedSendTool hardcodes blocking (no risk: literal); persistence/eval maps it to edit.
BLOCKING_TOOL_TIERS = {"email_prepare_send": "edit"}


def _find_repo_root(start: str) -> str:
    d = os.path.abspath(start)  # relative starts must not collapse to '' and match cwd/.env
    for _ in range(10):
        if os.path.isfile(os.path.join(d, ".env")) or os.path.isdir(os.path.join(d, ".git")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return start


def _git(repo_root: str, args: List[str]) -> str:
    try:
        r = subprocess.run(["git", "-C", repo_root] + args, capture_output=True, text=True)
        return r.stdout.strip()
    except Exception:
        return ""


def materialize_ref(repo_root: str, ref: str, subpath: str) -> Optional[str]:
    """`git archive <ref> <subpath> | tar -x` into a temp dir; return the extracted
    subpath (or None if git/ref/tar unavailable). Lets the check run against any ref
    without touching the working tree (M2)."""
    try:
        arch = subprocess.run(["git", "-C", repo_root, "archive", ref, subpath], capture_output=True)
        if arch.returncode != 0 or not arch.stdout:
            return None
        tmp = tempfile.mkdtemp(prefix="catalog-src-")
        tar = subprocess.run(["tar", "-x", "-C", tmp], input=arch.stdout)
        if tar.returncode != 0:
            return None
        return os.path.join(tmp, subpath)
    except Exception:
        return None


def scan_name_universe(src_dir: str) -> Set[str]:
    """The gateway tool-name universe: GATEWAY_*_TOOL_NAMES arrays across ALL tools/*.ts
    ∪ the skill_gating.ts classification sets (identical extraction to the pytest
    completeness gate, so the two can never see different universes)."""
    names: Set[str] = set()
    for path in sorted(glob.glob(os.path.join(src_dir, "*.ts"))):
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
        for m in NAME_ARRAY_RE.finditer(text):
            names.update(TOOL_NAME_RE.findall(m.group(1)))
        if os.path.basename(path) == "skill_gating.ts":
            rec = SKILL_TOOLS_RECORD_RE.search(text)
            if rec:
                names.update(TOOL_NAME_RE.findall(rec.group(1)))
            for sm in SET_LITERAL_RE.finditer(text):
                names.update(TOOL_NAME_RE.findall(sm.group(1)))
    return names


def scan_tiers(src_dir: str, universe: Set[str]) -> Dict[str, str]:
    """Per-tool tier from the option objects: pair each line-anchored `name: 'x'` with
    the first `risk: 'y'` literal inside its span (up to the next tool name); a name
    with no in-span risk is disambiguated by the nearest PRECEDING `audited*Tool(` call
    — Read → silent, Write → the nearest preceding risk literal (the helper-factory
    shape), Send → edit. Only names in the universe are paired (schema literals /
    unrelated `name:` keys are ignored)."""
    tiers: Dict[str, str] = dict(BLOCKING_TOOL_TIERS)
    for path in sorted(glob.glob(os.path.join(src_dir, "*.ts"))):
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
        names = [(m.start(), m.group(1)) for m in NAME_LINE_RE.finditer(text) if m.group(1) in universe]
        risks = [(m.start(), m.group(1)) for m in RISK_LINE_RE.finditer(text)]
        factories = [(m.start(), m.group(1)) for m in FACTORY_RE.finditer(text)]
        for i, (pos, name) in enumerate(names):
            if name in BLOCKING_TOOL_TIERS:
                continue
            end = names[i + 1][0] if i + 1 < len(names) else len(text)
            span_risks = [r for rp, r in risks if pos < rp < end]
            if span_risks:
                tiers[name] = span_risks[0]
                continue
            kinds_before = [k for fp, k in factories if fp < pos]
            kind = kinds_before[-1] if kinds_before else None
            if kind == "Read":
                tiers[name] = "silent"
            elif kind == "Send":
                tiers[name] = "edit"
            elif kind == "Write":
                risks_before = [r for rp, r in risks if rp < pos]
                if risks_before:
                    tiers[name] = risks_before[-1]
                # else: leave unpaired → surfaced by the caller's unpaired check.
    return tiers


def diff_catalog(universe: Set[str], tiers: Dict[str, str], catalog_tools: Dict[str, dict]) -> List[str]:
    errs: List[str] = []
    retired = {k for k, v in catalog_tools.items() if v.get("legacy_retired")}
    live_rows = {k: v for k, v in catalog_tools.items() if k not in retired}
    # forward: every gateway tool needs a catalog row (double-belt with the pytest gate).
    for name in sorted(universe - set(catalog_tools)):
        errs.append("missing in catalog: %s (source tier=%s)" % (name, tiers.get(name, "?")))
    # REVERSE guard: a live catalog row must exist in the gateway source.
    for name in sorted(set(live_rows) - universe):
        errs.append("extra in catalog (not found in gateway source): %s" % name)
    # tier drift for rows present on both sides.
    for name in sorted(universe & set(live_rows)):
        want = tiers.get(name)
        got = live_rows[name].get("tier")
        if want is not None and want != got:
            errs.append("tier drift %s: source=%s catalog=%s" % (name, want, got))
    # retired rows must stay retired: a gateway tool reusing the name must be promoted.
    for name in sorted(retired & universe):
        errs.append("legacy_retired row %s exists in the gateway source — promote it to a normal row" % name)
    return errs


def check(eval_root: str, source_dir: str) -> Tuple[bool, List[str], Dict[str, int]]:
    """Returns (ok, errors, counts). ok=True and source count=-1 if source absent."""
    catalog_path = os.path.join(eval_root, "tool_catalog.json")
    with open(catalog_path, "r", encoding="utf-8") as fh:
        catalog_tools = json.load(fh)["tools"]
    if not os.path.isdir(source_dir):
        return True, ["source dir absent (skipped): %s" % source_dir], {"source": -1, "catalog": len(catalog_tools)}
    universe = scan_name_universe(source_dir)
    # Extraction canaries (mirror the pytest gate): a stale regex must fail loudly, not
    # shrink the universe and green-light everything.
    if not universe or "email_search" not in universe:
        return False, ["extraction canary failed: gateway name universe empty or missing email_search"], {
            "source": len(universe), "catalog": len(catalog_tools)}
    tiers = scan_tiers(source_dir, universe)
    unpaired = sorted(universe - set(tiers))
    errs = diff_catalog(universe, tiers, catalog_tools)
    if unpaired:
        errs.append("tier extraction saw no `name:` literal for: %s (tool declaration shape changed?)" % ", ".join(unpaired))
    retired = sum(1 for v in catalog_tools.values() if v.get("legacy_retired"))
    return (len(errs) == 0), errs, {"source": len(universe), "catalog": len(catalog_tools) - retired}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="tool_catalog.json freshness check (gateway source)")
    ap.add_argument("--eval-root", default=_EVAL_ROOT)
    ap.add_argument("--source", help="gateway tools dir (default: <repo>/%s)" % DEFAULT_SOURCE)
    ap.add_argument("--source-ref", help="validate against a git ref via git archive, ignoring the working tree")
    args = ap.parse_args(argv)

    eval_root = os.path.abspath(args.eval_root)
    repo_root = _find_repo_root(eval_root)
    branch = _git(repo_root, ["rev-parse", "--abbrev-ref", "HEAD"]) or "?"
    commit = _git(repo_root, ["rev-parse", "--short", "HEAD"]) or "?"

    if args.source:
        source_dir = args.source
    elif args.source_ref:
        materialized = materialize_ref(repo_root, args.source_ref, DEFAULT_SOURCE)
        if not materialized:
            print("=== catalog freshness ===")
            print("repo branch=%s commit=%s" % (branch, commit))
            print("could not materialize git ref %r (no git / unknown ref / tar missing)" % args.source_ref)
            return 1
        source_dir = materialized
    else:
        source_dir = os.path.join(repo_root, DEFAULT_SOURCE)

    ok, errs, counts = check(eval_root, source_dir)
    print("=== catalog freshness: source=%s ===" % source_dir)
    print("repo branch=%s commit=%s%s" % (branch, commit, (" source-ref=%s" % args.source_ref) if args.source_ref else ""))
    print("source_tools=%s catalog_tools=%s" % (counts.get("source"), counts.get("catalog")))
    if errs:
        for e in errs:
            print("  - %s" % e)
    if counts.get("source") == -1:
        print("RESULT: SKIPPED (no source)")
        return 0
    print("RESULT: %s" % ("OK" if ok else "DRIFT"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
