"""tool_catalog freshness tests (M4, gateway source since S3). Zero LLM. The in-sync
test scans the WORKING-TREE gateway tool sources (frontend/src/ai-gateway/tools) and is
skipped when they are absent (e.g. CI without the frontend checkout). This is the
REVERSE direction of test_gateway_catalog_completeness.py (extra-in-catalog + tier
drift), so a stale catalog row or a tier change can never linger silently."""
import os

import pytest

from runner import validate_catalog


def test_diff_detects_missing():
    errs = validate_catalog.diff_catalog(
        {"a", "b"}, {"a": "silent", "b": "preview"}, {"a": {"tier": "silent"}}
    )
    assert any("missing in catalog: b" in e for e in errs)


def test_diff_detects_tier_drift():
    errs = validate_catalog.diff_catalog({"a"}, {"a": "edit"}, {"a": {"tier": "silent"}})
    assert any("tier drift a" in e for e in errs)


def test_diff_detects_extra():
    errs = validate_catalog.diff_catalog(
        {"a"}, {"a": "silent"}, {"a": {"tier": "silent"}, "z": {"tier": "silent"}}
    )
    assert any("extra in catalog" in e and "z" in e for e in errs)


def test_diff_retired_row_is_exempt_from_extra_but_must_stay_retired():
    # a legacy_retired row absent from the gateway is FINE (kept for frozen traces)…
    ok = validate_catalog.diff_catalog(
        {"a"},
        {"a": "silent"},
        {"a": {"tier": "silent"}, "plan_update": {"tier": "silent", "legacy_retired": True}},
    )
    assert ok == []
    # …but a gateway tool REUSING the retired name must force a promotion.
    errs = validate_catalog.diff_catalog(
        {"a", "plan_update"},
        {"a": "silent", "plan_update": "silent"},
        {"a": {"tier": "silent"}, "plan_update": {"tier": "silent", "legacy_retired": True}},
    )
    assert any("legacy_retired row plan_update" in e for e in errs)


def test_diff_clean():
    assert validate_catalog.diff_catalog({"a"}, {"a": "silent"}, {"a": {"tier": "silent"}}) == []


def test_catalog_in_sync_with_gateway_source(eval_root):
    # S3 — the catalog mirrors the AI SDK Gateway tool universe (the only engine).
    # Scan the working tree (walk-up, worktree-safe) like the completeness gate; skip
    # without a frontend checkout.
    repo = validate_catalog._find_repo_root(eval_root)
    src = os.path.join(repo, validate_catalog.DEFAULT_SOURCE)
    if not os.path.isdir(src):
        pytest.skip("gateway tools dir absent (no frontend checkout)")
    ok, errs, counts = validate_catalog.check(eval_root, src)
    assert ok, "catalog drift vs gateway source:\n" + "\n".join(errs)
    # counts: catalog excludes legacy_retired rows → must equal the gateway universe 1:1.
    assert counts["source"] == counts["catalog"]
