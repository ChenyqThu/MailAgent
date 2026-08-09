"""P9 Agent Plugin importer safety and draft-lifecycle contract."""
from __future__ import annotations

import json
import stat
import zipfile
from pathlib import Path

import pytest

from src.agent_config.store import AgentConfigStore
from src.skills import draft as draft_mod
from src.skills.draft import create_draft, draft_content_dir, import_file_into_draft
from src.skills.models import SkillPackageManifest
from src.skills.pack_verify import PackError
from src.skills.plugin_import import MAX_PLUGIN_ZIP_BYTES, import_plugin


@pytest.fixture
def plugin_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = tmp_path / "skills-data"
    monkeypatch.setenv("MAILAGENT_SKILLS_DIR", str(root))
    store = AgentConfigStore(str(tmp_path / "agent.db"))
    return tmp_path, root, store


def _skill(root: Path, name: str, *, skill_md: str = "# Skill", tests: bool = True) -> Path:
    path = root / "skills" / name
    path.mkdir(parents=True)
    (path / "SKILL.md").write_text(skill_md, encoding="utf-8")
    if tests:
        test_dir = path / "tests"
        test_dir.mkdir()
        (test_dir / "prompts.md").write_text("## Positive\nok\n## Negative\nno\n## Expected Output\nok", encoding="utf-8")
    return path


def _plugin(root: Path, **extra) -> None:
    (root / "plugin.json").write_text(json.dumps({"name": "plugin", **extra}), encoding="utf-8")


@pytest.mark.parametrize("content", [None, "[]", '{"name":""}'])
def test_bad_plugin_manifest_rejects_whole_pack_and_cleans_tmp(plugin_env, content):
    tmp, skills_root, store = plugin_env
    source = tmp / "source"
    source.mkdir()
    if content is not None:
        (source / "plugin.json").write_text(content, encoding="utf-8")
    with pytest.raises(PackError) as caught:
        import_plugin(local_path=str(source), store=store)
    assert caught.value.code == "E_PLUGIN_BAD_MANIFEST"
    assert store.list_skill_drafts() == []
    assert not list(skills_root.glob(".tmp-*"))


def test_components_are_independent_and_sanitize_names(plugin_env):
    tmp, _, store = plugin_env
    source = tmp / "source"; source.mkdir(); _plugin(source)
    _skill(source, "Good-Skill")
    _skill(source, "bad", skill_md="", tests=False)
    _skill(source, "中文", tests=False)
    _skill(source, "email")
    result = import_plugin(local_path=str(source), store=store)
    by_path = {item["path"]: item for item in result["skills"]}
    assert by_path["skills/Good-Skill"]["status"] == "ready"
    assert by_path["skills/Good-Skill"]["draftId"]
    assert by_path["skills/bad"]["status"] == "invalid" and by_path["skills/bad"]["errors"]
    assert by_path["skills/中文"]["status"] == "unsupported"
    assert by_path["skills/email"]["status"] == "invalid"
    assert store.get_skill_draft(by_path["skills/Good-Skill"]["draftId"]) is not None
    assert store.get_skill_draft(by_path["skills/email"]["draftId"]) is not None


def test_frontmatter_binary_license_notice_and_a9_shape(plugin_env):
    tmp, _, store = plugin_env
    source = tmp / "external-plugin"; source.mkdir(); _plugin(source, version="1.2.3", license="MIT")
    (source / "LICENSE").write_text("root license", encoding="utf-8")
    (source / "NOTICE.txt").write_text("root notice", encoding="utf-8")
    skill = _skill(source, "Media", skill_md="---\nname: Media Title\ndescription: Binary assets\n---\n# Body")
    (skill / "LICENSE").write_text("skill license", encoding="utf-8")
    assets = skill / "assets"; assets.mkdir(); binary = b"\x89PNG" + bytes(range(256)) * 4
    (assets / "image.png").write_bytes(binary[:1024])
    result = import_plugin(local_path=str(source), store=store)
    assert set(result) == {"plugin", "skills", "mcpServers"}
    assert result["plugin"] == {"name": "plugin", "version": "1.2.3", "source": "external-plugin"}
    item = result["skills"][0]; assert set(item) == {"path", "status", "draftId"}
    row = store.get_skill_draft(item["draftId"]); assert row is not None
    assert row.manifest["title"] == "Media Title" and row.manifest["description"] == "Binary assets"
    assert SkillPackageManifest(**{k: v for k, v in row.manifest.items() if k != "script_notes"}).license == "MIT"
    content = Path(draft_content_dir(row.id))
    assert (content / "assets/image.png").read_bytes() == binary[:1024]
    assert (content / "LICENSE").read_text() == "skill license"
    assert (content / "NOTICE.txt").read_text() == "root notice"


def test_bad_frontmatter_falls_back_without_failure(plugin_env):
    tmp, _, store = plugin_env
    source = tmp / "source"; source.mkdir(); _plugin(source)
    _skill(source, "fallback", skill_md="---\nname without colon\n# broken")
    result = import_plugin(local_path=str(source), store=store)
    row = store.get_skill_draft(result["skills"][0]["draftId"])
    assert row and row.manifest["title"] == "fallback"


@pytest.mark.parametrize("mcp", [{"mcpServers": {"one": {}}}, {"servers": [{"name": "two"}]}])
def test_mcp_shapes_are_detected_without_connector_writes(plugin_env, mcp):
    tmp, _, store = plugin_env
    source = tmp / "source"; source.mkdir(); _plugin(source)
    (source / "mcp.json").write_text(json.dumps(mcp), encoding="utf-8")
    result = import_plugin(local_path=str(source), store=store)
    assert result["mcpServers"][0]["status"] == "detected_not_imported"
    assert store.list_connectors() == []


def test_bad_mcp_is_component_error_not_pack_error(plugin_env):
    tmp, _, store = plugin_env
    source = tmp / "source"; source.mkdir(); _plugin(source)
    (source / "mcp.json").write_text("{", encoding="utf-8")
    result = import_plugin(local_path=str(source), store=store)
    assert result["mcpServers"][0]["status"] == "invalid"


def test_zip_traversal_symlink_and_upload_cap(plugin_env):
    tmp, _, store = plugin_env
    traversal = tmp / "traversal.zip"
    with zipfile.ZipFile(traversal, "w") as archive: archive.writestr("../evil", "x")
    with pytest.raises(PackError, match="traversal"):
        import_plugin(local_path=str(traversal), store=store)
    symlink = tmp / "symlink.zip"
    with zipfile.ZipFile(symlink, "w") as archive:
        info = zipfile.ZipInfo("link"); info.external_attr = (stat.S_IFLNK | 0o777) << 16; archive.writestr(info, "target")
    with pytest.raises(PackError) as caught: import_plugin(local_path=str(symlink), store=store)
    assert caught.value.code == "E_PACK_SYMLINK"
    with pytest.raises(PackError) as caught: import_plugin(zip_bytes=b"x" * (MAX_PLUGIN_ZIP_BYTES + 1), store=store)
    assert caught.value.code == "E_PACK_BOMB" and caught.value.http_status == 413


def test_zip_bomb_streaming_guard(plugin_env, monkeypatch):
    tmp, _, store = plugin_env
    from src.skills import pack_verify
    monkeypatch.setattr(pack_verify, "MAX_TOTAL_UNCOMPRESSED", 1024)
    bomb = tmp / "bomb.zip"
    with zipfile.ZipFile(bomb, "w", compression=zipfile.ZIP_DEFLATED) as archive: archive.writestr("huge", b"0" * 2048)
    with pytest.raises(PackError) as caught: import_plugin(local_path=str(bomb), store=store)
    assert caught.value.code == "E_PACK_BOMB"


def test_bytes_helper_limits_manifest_and_terminal(plugin_env, monkeypatch):
    _, _, store = plugin_env
    row = create_draft("bytes", store=store)
    import_file_into_draft(row.id, "assets/a.bin", b"abc", store=store)
    with pytest.raises(PackError): import_file_into_draft(row.id, "manifest.json", b"{}", store=store)
    monkeypatch.setattr(draft_mod, "MAX_DRAFT_FILE_BYTES", 2)
    with pytest.raises(PackError) as caught: import_file_into_draft(row.id, "assets/b.bin", b"abc", store=store)
    assert caught.value.http_status == 413
    monkeypatch.setattr(draft_mod, "MAX_DRAFT_FILE_BYTES", 1024)
    monkeypatch.setattr(draft_mod, "MAX_DRAFT_FILES", 2)
    with pytest.raises(PackError): import_file_into_draft(row.id, "assets/c.bin", b"x", store=store)
    monkeypatch.setattr(draft_mod, "MAX_DRAFT_FILES", 200)
    monkeypatch.setattr(draft_mod, "MAX_DRAFT_TOTAL_BYTES", 4)
    with pytest.raises(PackError): import_file_into_draft(row.id, "assets/d.bin", b"xx", store=store)
    store.update_skill_draft(row.id, status="published")
    with pytest.raises(PackError) as caught: import_file_into_draft(row.id, "assets/e.bin", b"x", store=store)
    assert caught.value.code == "E_DRAFT_TERMINAL"
