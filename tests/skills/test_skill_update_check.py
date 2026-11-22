"""Skill 上游更新检测与一键升级端到端单测（GitHub / npm / HTTP / local / 缓存与路由）。"""

from __future__ import annotations

import json
import os
import zipfile

import pytest

from src.agent_config.store import AgentConfigStore
from src.skills import pack_fetch as pf
from src.skills import update_check as uc


@pytest.fixture()
def skills_dir(tmp_path, monkeypatch):
    sdir = tmp_path / "skills"
    sdir.mkdir()
    monkeypatch.setenv("MAILAGENT_SKILLS_DIR", str(sdir))
    uc.invalidate_skill_update_cache()
    yield sdir
    uc.invalidate_skill_update_cache()


def _store(tmp_path) -> AgentConfigStore:
    return AgentConfigStore(str(tmp_path / "agent_cfg.db"))


def test_github_npm_http_and_local_update_checks(tmp_path, skills_dir, monkeypatch):
    store = _store(tmp_path)

    # 1) Local skill folder (initially matching hash, then edited on disk)
    local_src = tmp_path / "local-skill"
    local_src.mkdir()
    (local_src / "SKILL.md").write_text("---\nname: local-one\nversion: 0.1.0\n---\n# v1\n", encoding="utf-8")
    r_loc = pf.fetch_pack(local_path=str(local_src))
    c_loc = pf.confirm_pack(r_loc.quarantine_id, r_loc.package_hash, r_loc.files)
    store.install_skill(
        c_loc.name,
        source_type=c_loc.source_type,
        manifest=c_loc.manifest_dict,
        manifest_version=c_loc.manifest_version,
        version="0.1.0",
        source_uri=c_loc.source_uri,
        package_hash=c_loc.package_hash,
        files_json=json.dumps(c_loc.files),
        upstream_meta=c_loc.upstream_meta,
    )
    pf.promote_content(r_loc.quarantine_id, c_loc.name)

    # 2) GitHub installed skill row
    store.install_skill(
        "gh-skill",
        source_type="skill_pack",
        manifest={"manifest_version": 2, "type": "document", "name": "gh-skill", "version": "0.1.0", "tools": []},
        manifest_version="2",
        version="0.1.0",
        source_uri="github:acme/repo@main#skills/gh-skill",
        package_hash="a" * 64,
        files_json='{"SKILL.md": "a"}',
        upstream_meta={
            "provider": "github",
            "owner": "acme",
            "repo": "repo",
            "ref": "main",
            "subpath": "skills/gh-skill",
            "commit_sha": "1111111abcdef",
        },
    )

    # 3) npm installed skill row
    store.install_skill(
        "npm-skill",
        source_type="skill_pack",
        manifest={"manifest_version": 2, "type": "document", "name": "npm-skill", "version": "0.1.0", "tools": []},
        manifest_version="2",
        version="0.1.0",
        source_uri="npm:@acme/skills#skills/npm-skill",
        package_hash="b" * 64,
        files_json='{"SKILL.md": "b"}',
        upstream_meta={"provider": "npm", "package": "@acme/skills", "spec": "latest", "version": "0.1.0"},
    )

    # 4) HTTP zip installed skill row
    store.install_skill(
        "http-skill",
        source_type="skill_pack",
        manifest={"manifest_version": 2, "type": "document", "name": "http-skill", "version": "1.0.0", "tools": []},
        manifest_version="2",
        version="1.0.0",
        source_uri="https://packs.test/http-skill.zip",
        package_hash="c" * 64,
        files_json='{"SKILL.md": "c"}',
        upstream_meta={"provider": "http", "url": "https://packs.test/http-skill.zip", "etag": '"v1"'},
    )

    calls = {"json": 0, "head": 0}

    def fake_get_json(url: str, **_kw):
        calls["json"] += 1
        if "api.github.com/repos/acme/repo/commits" in url:
            return [{"sha": "2222222fedcba"}], {}
        if "registry.npmjs.org/" in url:
            return {"version": "0.2.0"}, {}
        raise AssertionError(f"unexpected url: {url}")

    def fake_head(url: str):
        calls["head"] += 1
        return {"etag": '"v2"'}

    monkeypatch.setattr(uc, "_http_get_json", fake_get_json)
    monkeypatch.setattr(uc, "_http_head_headers", fake_head)

    # First check: GitHub + npm + HTTP have updates; local unchanged
    res1 = uc.check_skill_updates(store)
    by_name = {s["name"]: s for s in res1["skills"]}
    assert res1["updatesAvailableCount"] == 3
    assert by_name["gh-skill"]["updateAvailable"] is True
    assert by_name["gh-skill"]["latestRef"] == "2222222"
    assert by_name["npm-skill"]["updateAvailable"] is True
    assert by_name["npm-skill"]["latestVersion"] == "0.2.0"
    assert by_name["http-skill"]["updateAvailable"] is True
    assert by_name["local-one"]["updateAvailable"] is False

    # Cache hit: no extra upstream calls when force=False
    prev_json = calls["json"]
    _ = uc.check_skill_updates(store, force=False)
    assert calls["json"] == prev_json

    # Modify local source file & force refresh -> local update detected
    (local_src / "SKILL.md").write_text("---\nname: local-one\nversion: 0.2.0\n---\n# v2\n", encoding="utf-8")
    res2 = uc.check_skill_updates(store, force=True)
    by_name2 = {s["name"]: s for s in res2["skills"]}
    assert res2["updatesAvailableCount"] == 4
    assert by_name2["local-one"]["updateAvailable"] is True
    assert calls["json"] > prev_json
