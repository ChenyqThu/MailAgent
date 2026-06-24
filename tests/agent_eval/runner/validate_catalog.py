#!/usr/bin/env python3
"""tool_catalog.json freshness check (M4) — zero LLM, zero deps.

Greps the real builtin tool sources and compares tool name + confirmationTier to
tool_catalog.json, so Phase 1 adding/removing/renaming a tool or changing a tier
fails this check instead of silently making R3/R5 wrong.

    python eval/runner/validate_catalog.py --eval-root eval
    python eval/runner/validate_catalog.py --source frontend/src/shared/chat/tools/builtin
    python eval/runner/validate_catalog.py --eval-root eval --source-ref main   # branch-independent (M2)

The catalog represents the tools on `main` (Phase -1/0A merged). Because `.trellis/`
is gitignored and survives branch switches, scanning the working tree on a branch
that lacks Phase -1 files (agent_profile.ts / skill_management.ts) yields a false
DRIFT. Use `--source-ref main` to validate against a git ref regardless of checkout.

Exit 0 = in sync (or source dir absent → skipped); exit 1 = drift.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import subprocess
import tempfile
from typing import Dict, List, Optional, Tuple

_EVAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# top-level tool name paired with its confirmationTier (anchored to line starts so
# nested schema identifiers are not matched).
PAIR_RE = re.compile(r"^\s*name:\s*'([a-z_]+)'[\s\S]*?^\s*confirmationTier:\s*'(silent|preview|edit)'", re.M)
DEFAULT_SOURCE = os.path.join("frontend", "src", "shared", "chat", "tools", "builtin")


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


def scan_source(src_dir: str) -> Dict[str, str]:
    expected: Dict[str, str] = {}
    for path in sorted(glob.glob(os.path.join(src_dir, "*.ts"))):
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
        for m in PAIR_RE.finditer(text):
            expected[m.group(1)] = m.group(2)
        # toggle(enabled) factory generates skill_enable / skill_disable (names dynamic)
        if os.path.basename(path) == "skill_management.ts":
            expected.setdefault("skill_enable", "preview")
            expected.setdefault("skill_disable", "preview")
    return expected


def diff_catalog(expected: Dict[str, str], catalog_tools: Dict[str, dict]) -> List[str]:
    errs: List[str] = []
    cat = {k: v.get("tier") for k, v in catalog_tools.items()}
    # Gateway-only tools (e.g. email_prepare_send) live ONLY in the AI SDK Gateway, with no
    # legacy builtin source, so they are exempt from the "extra in catalog" check. Legacy tools
    # stay strictly checked (missing / tier drift still caught for everything else).
    gateway_only = {k for k, v in catalog_tools.items() if v.get("gateway_only")}
    for name, tier in sorted(expected.items()):
        if name not in cat:
            errs.append("missing in catalog: %s (source tier=%s)" % (name, tier))
        elif cat[name] != tier:
            errs.append("tier drift %s: source=%s catalog=%s" % (name, tier, cat[name]))
    for name in sorted(cat):
        if name not in expected and name not in gateway_only:
            errs.append("extra in catalog (not found in source): %s" % name)
    return errs


def check(eval_root: str, source_dir: str) -> Tuple[bool, List[str], Dict[str, int]]:
    """Returns (ok, errors, counts). ok=True and skipped count=-1 if source absent."""
    catalog_path = os.path.join(eval_root, "tool_catalog.json")
    with open(catalog_path, "r", encoding="utf-8") as fh:
        catalog_tools = json.load(fh)["tools"]
    if not os.path.isdir(source_dir):
        return True, ["source dir absent (skipped): %s" % source_dir], {"source": -1, "catalog": len(catalog_tools)}
    expected = scan_source(source_dir)
    errs = diff_catalog(expected, catalog_tools)
    # Count parity excludes gateway-only tools (no legacy source) so source==catalog means
    # "every legacy builtin tool is mirrored 1:1", with gateway-only extras allowed on top.
    gateway_only = sum(1 for v in catalog_tools.values() if v.get("gateway_only"))
    return (len(errs) == 0), errs, {"source": len(expected), "catalog": len(catalog_tools) - gateway_only}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="tool_catalog.json freshness check")
    ap.add_argument("--eval-root", default=_EVAL_ROOT)
    ap.add_argument("--source", help="builtin tools dir (default: <repo>/%s)" % DEFAULT_SOURCE)
    ap.add_argument("--source-ref", help="validate against a git ref (e.g. main) via git archive, ignoring the working tree")
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
    if not ok and any(("agent_profile" in e or "skill_" in e) for e in errs):
        print("HINT: working tree appears to lack Phase -1/0A tools (agent_profile/skill_management).")
        print("      The catalog represents `main`. Re-run with: --source-ref main  (or check out a branch with Phase -1 commits).")
    print("RESULT: %s" % ("OK" if ok else "DRIFT"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
