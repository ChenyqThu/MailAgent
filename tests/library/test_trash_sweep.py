"""``.trash``：软删 / 恢复 / 立即永久删除（F11）/ 30 天 sweep / 挂载区拒进库内废纸篓。"""

from __future__ import annotations

import os
import time

import pytest

from src.library.constants import TRASH_SLUG, TRASH_TTL_DAYS
from src.library.service import LibraryError, LibraryService


@pytest.fixture()
def svc(tmp_path) -> LibraryService:
    return LibraryService(str(tmp_path / "library.db"), str(tmp_path / "library"))


def test_trash_restore_and_purge(svc: LibraryService) -> None:
    f = svc.create_file("my-docs/t.md", b"x")
    t = svc.trash_file(f["id"])
    assert t["status"] == "trashed" and t["path"] == f"{TRASH_SLUG}/{f['id']}/t.md"
    assert t["parent_path"] == "my-docs"  # 原文件夹保留 = restore 目标
    trashed_abs = os.path.join(svc.root_path, TRASH_SLUG, str(f["id"]), "t.md")
    assert os.path.isfile(trashed_abs) and not os.path.exists(os.path.join(svc.root_path, "my-docs", "t.md"))
    assert svc.folder("my-docs")["total"] == 0
    trash_view = svc.folder(TRASH_SLUG)
    assert trash_view["total"] == 1 and trash_view["files"][0]["id"] == f["id"]
    assert svc.tree()["folders"][-1] == {"path": TRASH_SLUG, "parent_path": "", "name": TRASH_SLUG, "mount_id": 0, "file_count": 1}

    # 同路径可以再建一个新文件（新 id），此时恢复被占 → 409
    n = svc.create_file("my-docs/t.md", b"new")
    assert n["id"] != f["id"]
    with pytest.raises(LibraryError) as exc_info:
        svc.restore_file(f["id"])
    assert exc_info.value.code == "E_INVALID_STATE"
    svc.trash_file(n["id"])
    r = svc.restore_file(f["id"])
    assert r["status"] == "present" and r["path"] == "my-docs/t.md"
    with open(os.path.join(svc.root_path, "my-docs", "t.md"), "rb") as fh:
        assert fh.read() == b"x"
    assert not os.path.exists(os.path.dirname(trashed_abs))

    # purge：真删文件 + 删行；present 行拒 purge
    with pytest.raises(LibraryError) as exc_info:
        svc.purge_file(f["id"])
    assert exc_info.value.code == "E_INVALID_STATE"
    p = svc.purge_file(n["id"])
    assert p == {"id": n["id"], "purged": True}
    assert not os.path.exists(os.path.join(svc.root_path, TRASH_SLUG, str(n["id"])))
    with pytest.raises(LibraryError) as exc_info:
        svc.file(n["id"])
    assert exc_info.value.code == "E_NOT_FOUND"
    assert svc.history(f["id"])  # 恢复的那份历史还在


def test_sweep_removes_only_expired_entries(svc: LibraryService) -> None:
    old = svc.create_file("my-docs/old.md", b"o")
    fresh = svc.create_file("my-docs/fresh.md", b"f")
    svc.trash_file(old["id"])
    svc.trash_file(fresh["id"])
    old_dir = os.path.join(svc.root_path, TRASH_SLUG, str(old["id"]))
    expired = time.time() - (TRASH_TTL_DAYS + 1) * 86400
    os.utime(old_dir, (expired, expired))
    assert svc.sweep_trash() == 1
    assert not os.path.exists(old_dir)
    with pytest.raises(LibraryError):
        svc.file(old["id"])
    assert svc.file(fresh["id"])["status"] == "trashed"
    assert svc.sweep_trash() == 0


def test_trash_rejected_for_mounted_folders(svc: LibraryService, tmp_path) -> None:
    ext = tmp_path / "ext"
    ext.mkdir()
    (ext / "keep.md").write_text("k")
    svc.add_mount(str(ext), label="ext", mode="rw")
    fid = svc.folder("@ext")["files"][0]["id"]
    with pytest.raises(LibraryError) as exc_info:
        svc.trash_file(fid)
    assert exc_info.value.code == "E_AUTH_FAILED"
    assert (ext / "keep.md").exists()
