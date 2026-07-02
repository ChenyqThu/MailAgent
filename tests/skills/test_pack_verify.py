"""Skill 包安全解包 + hash + 本地导入/confirm 流程（S2 W2）。

纯 src/skills 单测（不碰 app / 网络）——URL 下载路径的 SSRF 复用由 tests/api/test_web.py + 端点测试守。
fixtures 全合成（无真实 PII / 无外网）。
"""

from __future__ import annotations

import json
import os
import stat
import zipfile

import pytest

from src.skills import pack_fetch as pf
from src.skills.pack_verify import (
    MAX_ENTRIES,
    PackError,
    compute_files_and_hash,
    safe_copy_tree,
    safe_extract_zip,
    verify_content_dir,
)

_MANIFEST = {
    "manifest_version": 2,
    "type": "script",
    "name": "dms-approve",
    "version": "1.0",
    "description": "auto-approve DMS mail",
    "secrets": [{"name": "DMS_TOKEN"}],
}


def _write_zip(path, entries):
    """entries: list of (name, data) or (name, data, external_attr)."""
    with zipfile.ZipFile(path, "w") as z:
        for e in entries:
            zi = zipfile.ZipInfo(e[0])
            if len(e) > 2 and e[2] is not None:
                zi.external_attr = e[2]
            z.writestr(zi, e[1])


def _good_zip(path):
    _write_zip(
        path,
        [
            ("manifest.json", json.dumps(_MANIFEST)),
            ("SKILL.md", "# DMS\nRun main.py"),
            ("main.py", "print('ok')"),
        ],
    )


# ── 安全解包拒斥矩阵 ────────────────────────────────────────────────────────────────────


def test_zip_slip_traversal_rejected(tmp_path):
    z = tmp_path / "evil.zip"
    _write_zip(z, [("../escape.txt", "x")])
    with pytest.raises(PackError) as exc:
        safe_extract_zip(str(z), str(tmp_path / "out"))
    assert exc.value.code == "E_PACK_UNSAFE_PATH"


def test_absolute_path_member_rejected(tmp_path):
    z = tmp_path / "abs.zip"
    _write_zip(z, [("/etc/passwd", "x")])
    with pytest.raises(PackError) as exc:
        safe_extract_zip(str(z), str(tmp_path / "out"))
    assert exc.value.code == "E_PACK_UNSAFE_PATH"


def test_symlink_member_rejected(tmp_path):
    z = tmp_path / "link.zip"
    symlink_attr = (stat.S_IFLNK | 0o777) << 16
    _write_zip(z, [("sneaky", "/etc/passwd", symlink_attr)])
    with pytest.raises(PackError) as exc:
        safe_extract_zip(str(z), str(tmp_path / "out"))
    assert exc.value.code == "E_PACK_SYMLINK"


def test_too_many_entries_rejected(tmp_path):
    z = tmp_path / "many.zip"
    _write_zip(z, [(f"f{i}.txt", "x") for i in range(MAX_ENTRIES + 1)])
    with pytest.raises(PackError) as exc:
        safe_extract_zip(str(z), str(tmp_path / "out"))
    assert exc.value.code == "E_PACK_TOO_MANY_ENTRIES"


def test_zip_bomb_rejected(tmp_path):
    z = tmp_path / "bomb.zip"
    with zipfile.ZipFile(z, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("big.bin", b"\0" * (101 * 1024 * 1024))
    with pytest.raises(PackError) as exc:
        safe_extract_zip(str(z), str(tmp_path / "out"))
    assert exc.value.code == "E_PACK_BOMB"


def test_bad_zip_rejected(tmp_path):
    bad = tmp_path / "notzip.zip"
    bad.write_bytes(b"this is not a zip")
    with pytest.raises(PackError) as exc:
        safe_extract_zip(str(bad), str(tmp_path / "out"))
    assert exc.value.code == "E_PACK_BAD_ZIP"


def test_local_dir_symlink_rejected(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    (src / "manifest.json").write_text("{}")
    os.symlink("/etc/passwd", str(src / "sneaky"))
    with pytest.raises(PackError) as exc:
        safe_copy_tree(str(src), str(tmp_path / "out"))
    assert exc.value.code == "E_PACK_SYMLINK"


# ── hash 实算 + 确定性 ─────────────────────────────────────────────────────────────────


def test_files_and_hash_computed(tmp_path):
    content = tmp_path / "content"
    content.mkdir()
    (content / "a.txt").write_text("alpha")
    (content / "sub").mkdir()
    (content / "sub" / "b.txt").write_text("beta")
    files, pkg_hash = compute_files_and_hash(str(content))
    assert set(files) == {"a.txt", "sub/b.txt"}  # posix relpaths
    assert all(len(h) == 64 for h in files.values())  # sha256 hex
    assert len(pkg_hash) == 64


def test_dir_import_hash_deterministic(tmp_path):
    """同内容两次导入 → 同 package_hash（与打包顺序/系统/mtime 无关）。"""
    for sub in ("a", "b"):
        d = tmp_path / sub / "content"
        d.mkdir(parents=True)
        (d / "manifest.json").write_text(json.dumps(_MANIFEST))
        (d / "main.py").write_text("print('ok')")
    _, h1 = compute_files_and_hash(str(tmp_path / "a" / "content"))
    _, h2 = compute_files_and_hash(str(tmp_path / "b" / "content"))
    assert h1 == h2


def test_verify_content_dir_no_manifest_rejected(tmp_path):
    content = tmp_path / "content"
    content.mkdir()
    (content / "foo.txt").write_text("x")
    with pytest.raises(PackError) as exc:
        verify_content_dir(str(content))
    assert exc.value.code == "E_PACK_NO_MANIFEST"


def test_verify_content_dir_bad_manifest_rejected(tmp_path):
    """manifest v2 校验失败（script + tools）→ E_PACK_BAD_MANIFEST。"""
    content = tmp_path / "content"
    content.mkdir()
    bad = dict(_MANIFEST, tools=[{"name": "t"}])
    (content / "manifest.json").write_text(json.dumps(bad))
    with pytest.raises(PackError) as exc:
        verify_content_dir(str(content))
    assert exc.value.code == "E_PACK_BAD_MANIFEST"


# ── 本地导入 → confirm → promote 全流程（无网络）───────────────────────────────────────────


@pytest.fixture()
def skills_dir(tmp_path, monkeypatch):
    d = tmp_path / "skills"
    monkeypatch.setenv("MAILAGENT_SKILLS_DIR", str(d))
    return d


def test_fetch_local_zip_confirm_promote(tmp_path, skills_dir):
    z = tmp_path / "dms.zip"
    _good_zip(z)
    res = pf.fetch_pack(local_path=str(z))
    assert res.quarantine_id == f"dms-approve-{res.package_hash[:12]}"
    assert set(res.files) == {"manifest.json", "SKILL.md", "main.py"}
    assert res.source_type == "skill_pack"

    cr = pf.confirm_pack(res.quarantine_id, res.package_hash, res.files)
    assert cr.name == "dms-approve"
    final = pf.promote_content(res.quarantine_id, cr.name)
    assert os.path.isfile(os.path.join(final, "main.py"))
    assert os.path.basename(final) == "dms-approve"
    # quarantine 装成功即清
    assert not os.path.exists(pf._quarantine_dir(res.quarantine_id))


def test_fetch_local_dir_import(tmp_path, skills_dir):
    src = tmp_path / "pkg"
    src.mkdir()
    (src / "manifest.json").write_text(json.dumps(_MANIFEST))
    (src / "main.py").write_text("print(1)")
    res = pf.fetch_pack(local_path=str(src))
    assert res.source_type == "local_folder"
    assert set(res.files) == {"manifest.json", "main.py"}


def test_confirm_wrong_hash_rejected(tmp_path, skills_dir):
    z = tmp_path / "dms.zip"
    _good_zip(z)
    res = pf.fetch_pack(local_path=str(z))
    with pytest.raises(PackError) as exc:
        pf.confirm_pack(res.quarantine_id, "deadbeef" * 8, res.files)
    assert exc.value.code == "E_PACK_HASH_MISMATCH"
    assert exc.value.http_status == 409


def test_confirm_tampered_quarantine_rejected(tmp_path, skills_dir):
    """quarantine 内容在 preview 后被替换 → confirm re-hash 比对失败（TOCTOU）。"""
    z = tmp_path / "dms.zip"
    _good_zip(z)
    res = pf.fetch_pack(local_path=str(z))
    qdir = pf._quarantine_dir(res.quarantine_id)
    with open(os.path.join(qdir, "content", "main.py"), "a") as f:
        f.write("# tampered payload")
    with pytest.raises(PackError) as exc:
        pf.confirm_pack(res.quarantine_id, res.package_hash, res.files)
    assert exc.value.code == "E_PACK_HASH_MISMATCH"


def test_promote_upgrade_replaces_existing(tmp_path, skills_dir):
    """同名 skill 升级：新内容替换旧目录，无半成品。"""
    z1 = tmp_path / "v1.zip"
    _good_zip(z1)
    r1 = pf.fetch_pack(local_path=str(z1))
    pf.promote_content(r1.quarantine_id, pf.confirm_pack(r1.quarantine_id, r1.package_hash, r1.files).name)
    # v2 with different main.py
    z2 = tmp_path / "v2.zip"
    _write_zip(z2, [("manifest.json", json.dumps(_MANIFEST)), ("main.py", "print('v2')")])
    r2 = pf.fetch_pack(local_path=str(z2))
    final = pf.promote_content(r2.quarantine_id, pf.confirm_pack(r2.quarantine_id, r2.package_hash, r2.files).name)
    assert "v2" in open(os.path.join(final, "main.py")).read()
    assert not os.path.exists(os.path.join(pf.skills_data_root(), "SKILL.md"))  # no stray files


def test_gc_removes_stale_quarantine(tmp_path, skills_dir):
    z = tmp_path / "dms.zip"
    _good_zip(z)
    res = pf.fetch_pack(local_path=str(z))
    qdir = pf._quarantine_dir(res.quarantine_id)
    assert os.path.isdir(qdir)
    # ttl=0 → 立刻当作过期清掉
    removed = pf.gc_quarantine(ttl_sec=-1)
    assert removed >= 1
    assert not os.path.exists(qdir)


def test_invalid_quarantine_id_rejected(skills_dir):
    for bad in ["../etc", "no-hash", "UPPER-abc123def456", "x/../y-abc123def456"]:
        with pytest.raises(PackError):
            pf._quarantine_dir(bad)
