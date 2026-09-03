"""另存附件（连文本一起复制）/ 重扫对账 / 文件夹排序分页 / 扁平树（零绝对路径）/ 挂载增删（id 复用）/ 投影文件夹。"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3

import pytest

from src.library.constants import MOUNT_MAX_FILES, PROJECTION_SLUG, TOP_LEVEL_SLUGS
from src.library.service import LibraryError, LibraryService
from tests.library.test_repository import _SYNC_DDL


@pytest.fixture()
def svc(tmp_path) -> LibraryService:
    return LibraryService(str(tmp_path / "library.db"), str(tmp_path / "library"), str(tmp_path / "sync_store.db"))


def test_keep_attachment_copies_file_and_extracted_text(svc: LibraryService, tmp_path) -> None:
    src = tmp_path / "attachments" / "1001" / "report.pdf"
    src.parent.mkdir(parents=True)
    src.write_bytes(b"%PDF-1.4 fake")
    text = {"text_content": "quarterly numbers inside", "extractor": "pypdf", "truncated": False}
    f = svc.keep_attachment("my-docs", filename="report.pdf", src_path=str(src), attachment_id=42, text=text)
    assert f["source"] == "mail" and f["source_ref"] == "42" and f["kind"] == "pdf"
    assert f["text_status"] == "extracted" and f["path"] == "my-docs/report.pdf"
    assert f["content_hash"] == hashlib.sha256(b"%PDF-1.4 fake").hexdigest()
    with open(os.path.join(svc.root_path, "my-docs", "report.pdf"), "rb") as fh:
        assert fh.read() == b"%PDF-1.4 fake"
    t = svc.file_text(f["id"])
    assert t["markdown"] == "quarterly numbers inside" and t["extractor"] == "pypdf" and t["stale"] is False
    # 复制进来的文本直接可搜（零重抽）
    s = svc.search("quarterly")
    assert [h["id"] for h in s["hits"]] == [f["id"]] and s["mode"] == "porter"
    # 同名 → _1 后缀；无文本 → pending
    f2 = svc.keep_attachment("my-docs", filename="report.pdf", src_path=str(src), attachment_id=43, text=None)
    assert f2["filename"] == "report_1.pdf" and f2["text_status"] == "pending"
    # 目标是投影区 → 拒
    with pytest.raises(LibraryError) as exc_info:
        svc.keep_attachment(f"{PROJECTION_SLUG}/2026-07", filename="x.pdf", src_path=str(src), attachment_id=44)
    assert exc_info.value.code == "E_AUTH_FAILED"


def test_rescan_registers_marks_missing_and_notes_external_changes(svc: LibraryService) -> None:
    my_docs = os.path.join(svc.root_path, "my-docs")
    os.makedirs(os.path.join(my_docs, "sub"))
    with open(os.path.join(my_docs, "sub", "new.md"), "w") as fh:
        fh.write("hello")
    stats = svc.rescan()
    assert stats["added"] == 1 and stats["missing"] == 0
    listing = svc.folder("my-docs/sub")
    row = listing["files"][0]
    assert row["filename"] == "new.md" and row["text_status"] == "pending" and row["source"] == "user"
    assert row["content_hash"] is None  # 登记只 stat，hash 打开时再算
    opened = svc.file(row["id"])
    assert opened["content_hash"] == hashlib.sha256(b"hello").hexdigest()
    # 外部改内容（目录 mtime 不变）：打开文件时发现，补记 external
    path = os.path.join(my_docs, "sub", "new.md")
    with open(path, "w") as fh:
        fh.write("hello world")
    os.utime(path, (opened["mtime"] + 50, opened["mtime"] + 50))
    stats = svc.rescan()
    assert stats["updated"] == 1 and set(stats) == {"scanned", "added", "updated", "missing", "elapsed_ms"}
    assert svc.history(row["id"])[0]["changed_by"] == "external"
    # 删除 → missing，行与 id 保留
    os.unlink(path)
    stats = svc.rescan()
    assert stats["missing"] == 1
    assert svc.file(row["id"])["status"] == "missing"
    # 同路径重新出现 → 复用同一 id
    with open(path, "w") as fh:
        fh.write("back")
    svc.rescan()
    assert svc.file(row["id"])["status"] == "present"
    assert svc.folder("my-docs/sub")["files"][0]["id"] == row["id"]


def test_folder_sort_pagination_and_subfolders(svc: LibraryService) -> None:
    svc.create_file("my-docs/a.md", b"1")
    svc.create_file("my-docs/B.md", b"333")
    svc.create_file("my-docs/c.txt", b"22")
    os.makedirs(os.path.join(svc.root_path, "my-docs", "zeta"))
    names = lambda **kw: [f["filename"] for f in svc.folder("my-docs", **kw)["files"]]  # noqa: E731
    assert names() == ["a.md", "B.md", "c.txt"]
    assert names(sort="name", direction="desc") == ["c.txt", "B.md", "a.md"]
    assert names(sort="size", direction="desc") == ["B.md", "c.txt", "a.md"]
    assert names(sort="type") == ["a.md", "B.md", "c.txt"]  # markdown < text
    assert names(sort="date", direction="desc")[0] == "c.txt"
    page = svc.folder("my-docs", offset=1, limit=1)
    assert [f["filename"] for f in page["files"]] == ["B.md"] and page["total"] == 3
    assert page["folders"] == [{"name": "zeta", "path": "my-docs/zeta", "file_count": 0}]
    assert page["has_more"] is True
    assert svc.folder("my-docs", q="c.")["total"] == 1
    with pytest.raises(LibraryError) as exc_info:
        svc.folder("my-docs", sort="bogus")
    assert exc_info.value.code == "E_INVALID_ARG"
    with pytest.raises(LibraryError) as exc_info:
        svc.folder("my-docs/nope")
    assert exc_info.value.code == "E_NOT_FOUND"


def test_tree_is_flat_and_never_leaks_absolute_paths(svc: LibraryService, tmp_path) -> None:
    svc.create_file("my-docs/sub/x.md", b"x")
    ext = tmp_path / "ext"
    (ext / "inner").mkdir(parents=True)
    (ext / "inner" / "y.md").write_text("y")
    svc.add_mount(str(ext), label="ext", mode="rw")
    tree = svc.tree()
    by_path = {f["path"]: f for f in tree["folders"]}
    for slug in TOP_LEVEL_SLUGS:
        assert by_path[slug]["parent_path"] == "" and by_path[slug]["mount_id"] == 0
    assert by_path["my-docs/sub"] == {"path": "my-docs/sub", "parent_path": "my-docs", "name": "sub", "mount_id": 0, "file_count": 1}
    mount_id = tree["mounts"][0]["id"]
    assert tree["mounts"][0] == {"id": mount_id, "label": "ext", "path": "@ext", "mode": "rw", "status": "ok", "file_count": 1}
    assert by_path["@ext/inner"] == {"path": "@ext/inner", "parent_path": "@ext", "name": "inner", "mount_id": mount_id, "file_count": 1}
    assert tree["file_count"] == 2
    assert str(tmp_path) not in json.dumps(tree)
    assert str(tmp_path) not in json.dumps(svc.folder("@ext/inner"))
    assert str(tmp_path) not in json.dumps(svc.search("y"))
    # 设置页那条例外：mounts 端点带 abs_path
    assert svc.mounts()[0]["abs_path"] == os.path.realpath(str(ext)) and svc.mounts()[0]["file_count"] == 1


def test_mount_add_remove_reuses_file_ids(svc: LibraryService, tmp_path, monkeypatch) -> None:
    ext = tmp_path / "ws"
    ext.mkdir()
    (ext / "a.md").write_text("a")
    (ext / ".git").mkdir()
    (ext / ".git" / "config").write_text("ignored")
    (ext / "secret.pem").write_text("ignored")
    m = svc.add_mount(str(ext), mode="rw")
    assert m["label"] == "ws" and m["mode"] == "rw" and m["file_count"] == 1
    files = svc.folder("@ws")["files"]
    assert [f["filename"] for f in files] == ["a.md"]
    file_id = files[0]["id"]
    svc.search("a")  # 触发抽取，产生 library_text
    # 卸载：行标 missing、文本清掉、挂载行 unmounted（不删）
    gone = svc.remove_mount(m["id"])
    assert gone["status"] == "unmounted" and svc.mounts() == []
    assert svc.mounts(include_unmounted=True)[0]["id"] == m["id"]
    assert svc.file(file_id)["status"] == "missing"
    with pytest.raises(LibraryError):
        svc.folder("@ws")
    conn = svc.db.connect()
    try:
        assert conn.execute("SELECT COUNT(*) FROM library_text").fetchone()[0] == 0
    finally:
        conn.close()
    # 重新挂同一路径：同一挂载行、同一文件 id
    again = svc.add_mount(str(ext), label="ws2", mode="ro")
    assert again["id"] == m["id"] and again["label"] == "ws2"
    assert svc.folder("@ws2")["files"][0]["id"] == file_id
    assert svc.file(file_id)["status"] == "present"
    # 拒挂：重叠 / 根 / home / DATA_ROOT
    child = ext / "child"
    child.mkdir()
    with pytest.raises(LibraryError) as exc_info:
        svc.add_mount(str(child))
    assert exc_info.value.code == "E_INVALID_STATE"
    for bad in ("/", os.path.expanduser("~"), svc.root_path):
        with pytest.raises(LibraryError) as exc_info:
            svc.add_mount(bad)
        assert exc_info.value.code == "E_INVALID_ARG", bad
    # 超过文件数上限
    monkeypatch.setattr("src.library.service.MOUNT_MAX_FILES", 0)
    big = tmp_path / "big"
    big.mkdir()
    (big / "f.txt").write_text("f")
    with pytest.raises(LibraryError) as exc_info:
        svc.add_mount(str(big))
    assert "limit" in exc_info.value.message and MOUNT_MAX_FILES > 0


def test_projection_folder_via_service(svc: LibraryService) -> None:
    conn = sqlite3.connect(svc.repo.sync_store_db_path)
    try:
        conn.executescript(_SYNC_DDL)
        conn.execute("INSERT INTO email_metadata VALUES (1, 'Budget', 'alice@x.test', 'Alice', '2026-07-03 09:00:00')")
        conn.execute(
            "INSERT INTO email_attachment (internal_id, filename, content_type, size_bytes, is_inline, local_path, created_at)"
            " VALUES (1, 'budget.xlsx', 'application/vnd.ms-excel', 10, 0, '/a/budget.xlsx', 1.0)"
        )
        conn.commit()
    finally:
        conn.close()
    root = svc.folder(PROJECTION_SLUG)
    assert root["is_projection"] and root["folders"] == [{"name": "2026-07", "path": f"{PROJECTION_SLUG}/2026-07", "count": 1}]
    month = svc.folder(f"{PROJECTION_SLUG}/2026-07")
    item = month["files"][0]
    assert item["id"] is None and item["attachment_id"] == 1 and item["is_projection"] is True
    assert item["source_label"] == "Budget · Alice" and item["kind"] == "office" and item["status"] == "present"
    assert item["path"] == f"{PROJECTION_SLUG}/2026-07/budget.xlsx" and item["source_ref"] == "1"
    assert svc.folder(f"{PROJECTION_SLUG}/2026-07", q="alice")["total"] == 1
    tree_paths = {f["path"]: f for f in svc.tree()["folders"]}
    assert tree_paths[f"{PROJECTION_SLUG}/2026-07"]["file_count"] == 1 and tree_paths[PROJECTION_SLUG]["file_count"] == 1
