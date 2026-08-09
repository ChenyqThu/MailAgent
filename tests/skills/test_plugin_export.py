"""P9 Skill and Agent Plugin export contract."""
from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import pytest

from src.agent_config.store import AgentConfigStore
from src.skills.pack_verify import PackError, compute_files_and_hash
from src.skills.plugin_export import export_skill


@pytest.fixture
def installed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = tmp_path / "skills"; monkeypatch.setenv("MAILAGENT_SKILLS_DIR", str(root))
    content = root / "demo"; content.mkdir(parents=True)
    files = {"manifest.json": b'{"name":"demo"}', "SKILL.md": b"# Demo", "LICENSE": b"MIT", "config.json": b'{"token":"no"}'}
    for rel, data in files.items(): (content / rel).write_bytes(data)
    file_hashes, package_hash = compute_files_and_hash(str(content))
    store = AgentConfigStore(str(tmp_path / "agent.db"))
    store.install_skill("demo", source_type="skill_pack", manifest={"manifest_version": 2, "type": "document", "name": "demo", "version": "1.2.3", "description": "Demo", "license": "MIT", "docs_path": "SKILL.md", "tools": []}, manifest_version="2", version="1.2.3", package_hash=package_hash, files_json=json.dumps(file_hashes))
    store.upsert_skill_secret("demo", "TOKEN", b"super-secret")
    return content, store, file_hashes


def _zip(payload: bytes):
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        return set(archive.namelist()), {name: archive.read(name) for name in archive.namelist()}


def test_skill_export_relative_license_and_no_config_or_secret(installed):
    _, store, expected = installed
    names, files = _zip(export_skill("demo", store=store))
    assert "LICENSE" in names and "config.json" not in names
    assert all(not name.startswith(("/", "../")) for name in names)
    assert names == set(expected) - {"config.json"}
    assert b"super-secret" not in b"".join(files.values())


def test_plugin_export_manifest_and_prefix(installed):
    _, store, _ = installed
    names, files = _zip(export_skill("demo", format="plugin", store=store))
    plugin = json.loads(files["plugin.json"])
    assert plugin == {"name": "demo", "version": "1.2.3", "description": "Demo", "license": "MIT"}
    assert "skills/demo/LICENSE" in names and "skills/demo/config.json" not in names


def test_tamper_format_and_non_exportable(installed):
    content, store, _ = installed
    (content / "SKILL.md").write_text("tampered", encoding="utf-8")
    with pytest.raises(PackError) as caught: export_skill("demo", store=store)
    assert caught.value.code == "E_PACK_HASH_MISMATCH" and caught.value.http_status == 409
    with pytest.raises(PackError) as caught: export_skill("demo", format="bad", store=store)
    assert caught.value.http_status == 400
    store.install_skill("decl", source_type="document", manifest={"name": "decl"})
    with pytest.raises(PackError) as caught: export_skill("decl", store=store)
    assert caught.value.http_status == 404
    with pytest.raises(PackError) as caught: export_skill("builtin", store=store)
    assert caught.value.http_status == 404
