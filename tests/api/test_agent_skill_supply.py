"""/api/agent/skills/{fetch,confirm,uninstall} 供应链端点（S2 W2）。

两段式安装：fetch(本地 zip)→preview → confirm(re-hash)→落盘+落行；hash 不符 409；tamper 409；
uninstall 全清；URL 下载复用 SSRF（内网 → E_SSRF_BLOCKED）。fixtures 全合成（.test / 假内容，零 PII）。
"""

from __future__ import annotations

import json
import os
import zipfile


_MANIFEST = {
    "manifest_version": 2,
    "type": "script",
    "name": "dms-approve",
    "version": "1.0",
    "title": "DMS Approver",
    "description": "auto-approve DMS approval mail",
    "entry_hint": "python3 main.py",
    "secrets": [{"name": "DMS_TOKEN", "description": "api token"}],
}


def _make_zip(path, entries):
    with zipfile.ZipFile(path, "w") as z:
        for name, data in entries.items():
            z.writestr(name, data)


def _good_zip(tmp_path):
    p = tmp_path / "dms.zip"
    _make_zip(
        p,
        {
            "manifest.json": json.dumps(_MANIFEST),
            "SKILL.md": "# DMS\nConstruct run_command to execute main.py.",
            "main.py": "print('approve')",
        },
    )
    return p


# ── fetch ──────────────────────────────────────────────────────────────────────────────


def test_fetch_local_zip_preview(client, fresh_agent_cfg, fresh_skills_dir, tmp_path):
    z = _good_zip(tmp_path)
    r = client.post("/api/agent/skills/fetch", json={"localPath": str(z)})
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["quarantineId"].startswith("dms-approve-")
    assert data["packageHash"] and len(data["packageHash"]) == 64
    assert set(data["files"]) == {"manifest.json", "SKILL.md", "main.py"}
    assert data["manifest"]["type"] == "script"
    assert data["manifest"]["name"] == "dms-approve"
    assert data["secretNames"] == ["DMS_TOKEN"]
    assert "run_command" in data["skillMdExcerpt"]


def test_fetch_requires_exactly_one_source(client, fresh_agent_cfg, fresh_skills_dir):
    r0 = client.post("/api/agent/skills/fetch", json={})
    assert r0.status_code == 400
    r2 = client.post("/api/agent/skills/fetch", json={"sourceUrl": "http://a.test/x", "localPath": "/x"})
    assert r2.status_code == 400


def test_fetch_bad_manifest_rejected(client, fresh_agent_cfg, fresh_skills_dir, tmp_path):
    """script + 非空 tools → manifest v2 校验拒（E_PACK_BAD_MANIFEST）。"""
    z = tmp_path / "bad.zip"
    bad = dict(_MANIFEST, tools=[{"name": "t"}])
    _make_zip(z, {"manifest.json": json.dumps(bad)})
    r = client.post("/api/agent/skills/fetch", json={"localPath": str(z)})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_PACK_BAD_MANIFEST"


def test_fetch_url_internal_ip_ssrf_blocked(client, fresh_agent_cfg, fresh_skills_dir):
    """URL 下载复用 SSRF 硬化：内网目标 → E_SSRF_BLOCKED（证明 download 走 ssrf 校验）。"""
    r = client.post("/api/agent/skills/fetch", json={"sourceUrl": "http://10.0.0.1/pack.zip"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_SSRF_BLOCKED"


# ── confirm ────────────────────────────────────────────────────────────────────────────


def test_confirm_installs_row_and_dir(client, fresh_agent_cfg, fresh_skills_dir, tmp_path):
    z = _good_zip(tmp_path)
    preview = client.post("/api/agent/skills/fetch", json={"localPath": str(z)}).json()["data"]
    r = client.post(
        "/api/agent/skills/confirm",
        json={
            "quarantineId": preview["quarantineId"],
            "expectedPackageHash": preview["packageHash"],
            "expectedFiles": preview["files"],
        },
    )
    assert r.status_code == 201
    assert r.json()["data"]["name"] == "dms-approve"
    # 行落库 + files_json + package_hash
    row = fresh_agent_cfg.get_skill("dms-approve")
    assert row is not None and row.source_type == "skill_pack"
    assert row.package_hash == preview["packageHash"]
    assert json.loads(row.files_json).keys() == set(preview["files"].keys())
    # 落盘到 <skills>/dms-approve/
    assert os.path.isfile(os.path.join(str(fresh_skills_dir), "dms-approve", "main.py"))
    # registry：script skill 投影为零工具（GET /skills 可见 toolCount=0）
    skills = client.get("/api/agent/skills").json()["data"]["skills"]
    ds = next((s for s in skills if s["name"] == "dms-approve"), None)
    assert ds is not None and ds["toolCount"] == 0


def test_confirm_wrong_hash_409(client, fresh_agent_cfg, fresh_skills_dir, tmp_path):
    z = _good_zip(tmp_path)
    preview = client.post("/api/agent/skills/fetch", json={"localPath": str(z)}).json()["data"]
    r = client.post(
        "/api/agent/skills/confirm",
        json={
            "quarantineId": preview["quarantineId"],
            "expectedPackageHash": "deadbeef" * 8,
            "expectedFiles": preview["files"],
        },
    )
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "E_PACK_HASH_MISMATCH"
    # 未落行（confirm 失败）
    assert fresh_agent_cfg.get_skill("dms-approve") is None


def test_confirm_tampered_quarantine_409(client, fresh_agent_cfg, fresh_skills_dir, tmp_path):
    """preview 后本机替换 quarantine content → confirm re-hash 比对失败。"""
    from src.skills import pack_fetch as pf

    z = _good_zip(tmp_path)
    preview = client.post("/api/agent/skills/fetch", json={"localPath": str(z)}).json()["data"]
    qdir = pf._quarantine_dir(preview["quarantineId"])
    with open(os.path.join(qdir, "content", "main.py"), "a") as f:
        f.write("# injected")
    r = client.post(
        "/api/agent/skills/confirm",
        json={
            "quarantineId": preview["quarantineId"],
            "expectedPackageHash": preview["packageHash"],
            "expectedFiles": preview["files"],
        },
    )
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "E_PACK_HASH_MISMATCH"


def test_confirm_unknown_quarantine_404(client, fresh_agent_cfg, fresh_skills_dir):
    r = client.post(
        "/api/agent/skills/confirm",
        json={"quarantineId": "ghost-000000000000", "expectedPackageHash": "x" * 64},
    )
    assert r.status_code == 404


# ── uninstall（全清理）──────────────────────────────────────────────────────────────────


def test_uninstall_full_cleanup(client, fresh_agent_cfg, fresh_skills_dir, tmp_path):
    z = _good_zip(tmp_path)
    preview = client.post("/api/agent/skills/fetch", json={"localPath": str(z)}).json()["data"]
    client.post(
        "/api/agent/skills/confirm",
        json={
            "quarantineId": preview["quarantineId"],
            "expectedPackageHash": preview["packageHash"],
            "expectedFiles": preview["files"],
        },
    )
    # seed a skill_secrets row to prove cleanup
    import sqlite3

    conn = sqlite3.connect(fresh_agent_cfg.db_path)
    conn.execute(
        "INSERT INTO skill_secrets(skill_name,secret_name,value_ciphertext,updated_at) VALUES (?,?,?,?)",
        ("dms-approve", "DMS_TOKEN", b"ct", "now"),
    )
    conn.commit()
    conn.close()

    skill_dir = os.path.join(str(fresh_skills_dir), "dms-approve")
    assert os.path.isdir(skill_dir)
    r = client.post("/api/agent/skills/uninstall", json={"name": "dms-approve"})
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["removed"] is True and data["removedDir"] is True and data["removedSecrets"] == 1
    assert fresh_agent_cfg.get_skill("dms-approve") is None
    assert not os.path.exists(skill_dir)
    assert fresh_agent_cfg.list_skill_secret_names("dms-approve") == []
    # 幂等：再卸 removed=False
    r2 = client.post("/api/agent/skills/uninstall", json={"name": "dms-approve"})
    assert r2.json()["data"]["removed"] is False


def test_uninstall_requires_name(client, fresh_agent_cfg, fresh_skills_dir):
    r = client.post("/api/agent/skills/uninstall", json={})
    assert r.status_code == 400


# ── auth：关闭 bypass → 401（与 owner API 一致）──────────────────────────────────────────


def test_supply_endpoints_require_auth(fresh_skills_dir):
    import src.api.auth as auth_mod
    from fastapi.testclient import TestClient

    from src.api.app import app

    import pytest as _pytest

    mp = _pytest.MonkeyPatch()
    mp.setattr(auth_mod, "AUTH_DISABLED", False)
    mp.setattr(auth_mod, "_LOCAL_API_TOKEN", "")
    mp.setattr(auth_mod, "CF_AUDIENCE", "aud")
    try:
        with TestClient(app, raise_server_exceptions=False) as c:
            assert c.post("/api/agent/skills/fetch", json={"localPath": "/x"}).status_code == 401
            assert c.post("/api/agent/skills/confirm", json={}).status_code == 401
            assert c.post("/api/agent/skills/uninstall", json={}).status_code == 401
    finally:
        mp.undo()
