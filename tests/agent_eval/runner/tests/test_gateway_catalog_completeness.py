"""Gateway → tool_catalog.json completeness gate (S1.0/R4). Zero LLM, stdlib only.

Closes the hole research/04 confirmed: validate_catalog.py only greps the LEGACY
builtin sources (frontend/src/shared/chat/tools/builtin) and exempts gateway_only
tools from the "extra in catalog" direction — so a NEW tool registered in the AI SDK
Gateway (frontend/src/ai-gateway/tools/*) but missing from tool_catalog.json would
never turn anything red, silently escaping R3/R5 scoring. This gate statically
extracts the gateway tool-name universe from the WORKING TREE (so S1's R1-R3 waves —
chat_session_* / agent_profile_* / web_* — and every future gateway tool trip it the
moment they are added without a catalog entry):

  * every `export const GATEWAY_*TOOL_NAMES = [...]` array in tools/*.ts (any file,
    present or future — no hardcoded file list), plus
  * the three skill_gating.ts classification sets (GATEWAY_SKILL_TOOLS record values,
    COLLISION_EXEMPT / CORE_UNGATED `new Set([...])` members).

Canary assertions guard the regexes themselves (a silent extraction failure would
otherwise make the gate vacuously green). Skipped when the frontend checkout is
absent (same pattern as test_catalog.py). rules.py is untouched.
"""
import glob
import os
import re

import pytest

# `export const GATEWAY_<X>_TOOL_NAMES [: type] = [ 'a', 'b' ]` — DOTALL, first `]` ends
# the literal (tool-name arrays never nest). Anchored to the export so nested schema
# identifiers never match (style: validate_catalog.PAIR_RE).
NAME_ARRAY_RE = re.compile(r"export\s+const\s+GATEWAY_[A-Z0-9_]*TOOL_NAMES[^=]*=\s*\[(.*?)\]", re.S)
# skill_gating.ts: record literal ends at the first column-0 `}`; sets are single literals.
SKILL_TOOLS_RECORD_RE = re.compile(r"GATEWAY_SKILL_TOOLS[^=]*=\s*\{(.*?)\n\}", re.S)
SET_LITERAL_RE = re.compile(r"new\s+Set\(\[(.*?)\]\)", re.S)
# tool names are single-quoted snake_case string literals (keys/comments never match).
TOOL_NAME_RE = re.compile(r"'([a-z][a-z0-9_]*)'")

GATEWAY_TOOLS_SUBPATH = os.path.join("frontend", "src", "ai-gateway", "tools")


def _gateway_tools_dir(eval_root: str):
    """Walk up from eval_root to the checkout root containing frontend/src/ai-gateway/tools.
    Works from the main repo and from git worktrees (no .git-dir assumptions)."""
    d = os.path.abspath(eval_root)
    for _ in range(10):
        cand = os.path.join(d, GATEWAY_TOOLS_SUBPATH)
        if os.path.isdir(cand):
            return cand
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return None


def extract_gateway_tool_names(tools_dir: str):
    """The gateway tool-name universe: GATEWAY_*_TOOL_NAMES arrays across ALL tools/*.ts
    (future files included) ∪ the skill_gating.ts classification sets."""
    names = set()
    for path in sorted(glob.glob(os.path.join(tools_dir, "*.ts"))):
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


def test_every_gateway_tool_is_in_catalog(eval_root, catalog):
    tools_dir = _gateway_tools_dir(eval_root)
    if tools_dir is None:
        pytest.skip("frontend gateway tools dir absent (no frontend checkout)")
    names = extract_gateway_tool_names(tools_dir)

    # Canaries: a regex gone stale must fail loudly, not shrink the universe to {}.
    assert names, "extraction found no gateway tool names — extraction regexes are broken"
    assert "email_search" in names, "canary miss: email_search not extracted (GATEWAY_READ_TOOL_NAMES)"
    assert "update_system_md" in names, "canary miss: update_system_md not extracted (self-mount/skill_gating)"

    missing = sorted(names - set(catalog.tools.keys()))
    assert not missing, (
        "gateway tools missing from tool_catalog.json (add them with the correct tier so "
        "R3/R5 can score them — schema.md §5): %s" % missing
    )
