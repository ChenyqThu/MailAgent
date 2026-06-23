"""tool_catalog freshness tests (M4). Zero LLM. The in-sync test reads the real
frontend builtin sources and is skipped when they are absent (e.g. CI without
the frontend checkout)."""
import os

import pytest

from runner import validate_catalog


def test_diff_detects_missing():
    errs = validate_catalog.diff_catalog({"a": "silent", "b": "preview"}, {"a": {"tier": "silent"}})
    assert any("missing in catalog: b" in e for e in errs)


def test_diff_detects_tier_drift():
    errs = validate_catalog.diff_catalog({"a": "edit"}, {"a": {"tier": "silent"}})
    assert any("tier drift a" in e for e in errs)


def test_diff_detects_extra():
    errs = validate_catalog.diff_catalog({"a": "silent"}, {"a": {"tier": "silent"}, "z": {"tier": "silent"}})
    assert any("extra in catalog" in e and "z" in e for e in errs)


def test_diff_clean():
    assert validate_catalog.diff_catalog({"a": "silent"}, {"a": {"tier": "silent"}}) == []


def test_catalog_in_sync_with_main_source(eval_root):
    # The catalog represents `main` (Phase -1/0A merged). Validate against the main
    # ref via git archive so the test is branch-independent (M2): scanning the working
    # tree on a branch lacking Phase -1 files (agent_profile/skill_management) would be
    # a false drift, not a catalog bug.
    repo = validate_catalog._find_repo_root(eval_root)
    src = validate_catalog.materialize_ref(repo, "main", validate_catalog.DEFAULT_SOURCE)
    if not src or not os.path.isdir(src):
        pytest.skip("cannot materialize main source (no git / main ref)")
    ok, errs, counts = validate_catalog.check(eval_root, src)
    assert ok, "catalog drift vs main:\n" + "\n".join(errs)
    assert counts["source"] == counts["catalog"]
