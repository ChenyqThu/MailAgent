from __future__ import annotations

import json
import os

import pytest

from src.skills.draft import (
    MAX_DRAFT_FILE_BYTES,
    create_draft,
    draft_content_dir,
    draft_dir,
    discard_draft,
    list_draft_tree,
    publish_draft,
    read_draft_file,
    validate_draft,
    write_draft_file,
)
from src.skills.pack_verify import PackError


@pytest.fixture()
def fresh_agent_cfg(tmp_path, monkeypatch):
    from src.agent_config import store as acstore

    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", str(tmp_path / "agent_config.db"))
    acstore.reset_agent_config_store_cache()
    yield acstore.get_agent_config_store()
    acstore.reset_agent_config_store_cache()


@pytest.fixture()
def fresh_skills_dir(tmp_path, monkeypatch):
    root = tmp_path / "skills"
    monkeypatch.setenv("MAILAGENT_SKILLS_DIR", str(root))
    return root


def _valid_document_draft(store):
    row = create_draft("weekly-helper", store=store)
    write_draft_file(row.id, "SKILL.md", "# Weekly helper\n", store=store)
    write_draft_file(
        row.id,
        "tests/prompts.md",
        "## Positive\nweekly report\n## Negative\nweather\n## Expected Output\nsummary\n",
        store=store,
    )
    return row


def test_draft_roundtrip_validate_publish_and_terminal_write(fresh_agent_cfg, fresh_skills_dir):
    row = _valid_document_draft(fresh_agent_cfg)
    assert read_draft_file(row.id, "SKILL.md").startswith("# Weekly")
    validation = validate_draft(row.id, store=fresh_agent_cfg)
    assert validation["valid"] is True
    result = publish_draft(row.id, enabled=True, store=fresh_agent_cfg)
    assert result["name"] == "weekly-helper"
    installed = fresh_agent_cfg.get_skill("weekly-helper")
    assert installed is not None
    assert installed.source_type == "user_created"
    assert installed.package_hash == result["package_hash"]
    assert installed.trusted is False
    with pytest.raises(PackError, match="already published"):
        write_draft_file(row.id, "SKILL.md", "changed", store=fresh_agent_cfg)


@pytest.mark.parametrize("path", ["../escape", "/tmp/escape", "a/../../escape"])
def test_draft_rejects_unsafe_paths(fresh_agent_cfg, fresh_skills_dir, path):
    row = create_draft("safe-draft", store=fresh_agent_cfg)
    with pytest.raises(PackError) as error:
        write_draft_file(row.id, path, "x", store=fresh_agent_cfg)
    assert error.value.code == "E_PACK_UNSAFE_PATH"


def test_draft_rejects_invalid_id_and_symlink_member(
    fresh_agent_cfg, fresh_skills_dir, tmp_path
):
    with pytest.raises(PackError, match="invalid skill draft id"):
        draft_dir("Bad/id")
    row = create_draft("linked-draft", store=fresh_agent_cfg)
    outside = tmp_path / "outside.txt"
    outside.write_text("do not touch")
    os.symlink(outside, os.path.join(draft_content_dir(row.id), "linked.txt"))
    with pytest.raises(PackError) as error:
        list_draft_tree(row.id)
    assert error.value.code == "E_PACK_SYMLINK"
    with pytest.raises(PackError) as write_error:
        write_draft_file(row.id, "safe.txt", "x", store=fresh_agent_cfg)
    assert write_error.value.code == "E_PACK_SYMLINK"
    assert outside.read_text() == "do not touch"


def test_draft_file_count_total_and_single_file_limits(
    fresh_agent_cfg, fresh_skills_dir, monkeypatch
):
    from src.skills import draft as draft_module

    row = create_draft("bounded-draft", store=fresh_agent_cfg)
    with pytest.raises(PackError) as oversized:
        write_draft_file(
            row.id,
            "too-large.txt",
            "x" * (MAX_DRAFT_FILE_BYTES + 1),
            store=fresh_agent_cfg,
        )
    assert oversized.value.code == "E_DRAFT_LIMIT"

    monkeypatch.setattr(draft_module, "MAX_DRAFT_FILES", 2)
    write_draft_file(row.id, "SKILL.md", "# bounded\n", store=fresh_agent_cfg)
    with pytest.raises(PackError, match="200 files"):
        write_draft_file(row.id, "third.txt", "x", store=fresh_agent_cfg)

    row2 = create_draft("total-bounded", store=fresh_agent_cfg)
    current_total = sum(item["bytes"] for item in list_draft_tree(row2.id))
    monkeypatch.setattr(draft_module, "MAX_DRAFT_FILES", 200)
    monkeypatch.setattr(draft_module, "MAX_DRAFT_TOTAL_BYTES", current_total + 1)
    with pytest.raises(PackError, match="10 MiB"):
        write_draft_file(row2.id, "extra.txt", "xx", store=fresh_agent_cfg)


def test_script_notes_and_test_contract_fail_names_fields(fresh_agent_cfg, fresh_skills_dir):
    row = create_draft("scripted", store=fresh_agent_cfg)
    manifest = dict(row.manifest or {})
    manifest["type"] = "script"
    manifest["script_notes"] = {"scripts/main.py": {"why_script": "deterministic"}}
    write_draft_file(row.id, "manifest.json", json.dumps(manifest), store=fresh_agent_cfg)
    write_draft_file(row.id, "SKILL.md", "# Scripted\n", store=fresh_agent_cfg)
    write_draft_file(row.id, "scripts/main.py", "print('ok')\n", store=fresh_agent_cfg)
    result = validate_draft(row.id, store=fresh_agent_cfg)
    assert result["valid"] is False
    joined = "\n".join(result["errors"])
    for field in ("reads", "writes", "network", "secrets", "entrypoint", "smoke"):
        assert f"script_notes.{field}" in joined
    assert "positive case" in joined and "negative case" in joined and "expected output" in joined


def test_validate_rejects_builtin_name(fresh_agent_cfg, fresh_skills_dir):
    row = create_draft("skill_creator", store=fresh_agent_cfg)
    write_draft_file(row.id, "SKILL.md", "# collision\n", store=fresh_agent_cfg)
    write_draft_file(
        row.id,
        "tests/prompts.md",
        "## Positive\nyes\n## Negative\nno\n## Expected Output\nresult\n",
        store=fresh_agent_cfg,
    )
    result = validate_draft(row.id, store=fresh_agent_cfg)
    assert result["valid"] is False
    assert any("conflicts with builtin" in error for error in result["errors"])


def test_discard_removes_files_and_marks_terminal(fresh_agent_cfg, fresh_skills_dir):
    row = _valid_document_draft(fresh_agent_cfg)
    root = row.root_path
    discarded = discard_draft(row.id, store=fresh_agent_cfg)
    assert discarded.status == "discarded"
    assert not os.path.exists(root)


def test_trust_active_stale_and_revoked(fresh_agent_cfg, fresh_skills_dir):
    row = _valid_document_draft(fresh_agent_cfg)
    validate_draft(row.id, store=fresh_agent_cfg)
    published = publish_draft(row.id, store=fresh_agent_cfg)
    entrypoint = os.path.realpath(os.path.join(published["install_dir"], "SKILL.md"))
    trust = fresh_agent_cfg.grant_skill_trust(
        "trust-1", "weekly-helper", published["package_hash"], entrypoint, {"networkMode": "off"}
    )
    assert fresh_agent_cfg.find_active_skill_trust(
        "weekly-helper", published["package_hash"], entrypoint
    ) == trust
    fresh_agent_cfg.install_skill(
        "weekly-helper",
        source_type="user_created",
        manifest={"name": "weekly-helper"},
        package_hash="f" * 64,
        files_json=json.dumps({"SKILL.md": "0" * 64}),
    )
    current = fresh_agent_cfg.get_skill("weekly-helper")
    assert current is not None and current.package_hash != trust.package_hash
    assert fresh_agent_cfg.find_active_skill_trust(
        "weekly-helper", current.package_hash, entrypoint
    ) is None
    assert fresh_agent_cfg.revoke_skill_trust(trust.id) is True
    assert fresh_agent_cfg.list_skill_trust("weekly-helper")[0].revoked_at is not None


def test_publish_rolls_files_back_when_db_upsert_fails(
    fresh_agent_cfg, fresh_skills_dir, monkeypatch
):
    row = _valid_document_draft(fresh_agent_cfg)
    validate_draft(row.id, store=fresh_agent_cfg)
    installed = fresh_skills_dir / "weekly-helper"
    installed.mkdir(parents=True)
    (installed / "old.txt").write_text("old")

    def fail_install(*args, **kwargs):
        raise RuntimeError("db unavailable")

    monkeypatch.setattr(fresh_agent_cfg, "install_skill", fail_install)
    with pytest.raises(RuntimeError, match="db unavailable"):
        publish_draft(row.id, store=fresh_agent_cfg)
    assert (installed / "old.txt").read_text() == "old"
    assert os.path.isfile(os.path.join(draft_content_dir(row.id), "SKILL.md"))
    assert fresh_agent_cfg.get_skill_draft(row.id).status == "valid"


def test_publish_event_contains_only_names_hashes_and_counts(fresh_agent_cfg, fresh_skills_dir):
    row = create_draft("event-safe", store=fresh_agent_cfg)
    write_draft_file(row.id, "SKILL.md", "# SECRET_SENTINEL\n", store=fresh_agent_cfg)
    write_draft_file(
        row.id,
        "tests/prompts.md",
        "## Positive\nyes\n## Negative\nno\n## Expected Output\nSECRET_SENTINEL\n",
        store=fresh_agent_cfg,
    )
    validate_draft(row.id, store=fresh_agent_cfg)
    publish_draft(row.id, store=fresh_agent_cfg)
    events = fresh_agent_cfg.list_events("event-safe")
    publish_event = next(event for event in events if event["event"] == "draft_publish")
    assert "SECRET_SENTINEL" not in publish_event["detail_json"]
