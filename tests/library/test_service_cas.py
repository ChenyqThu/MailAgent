"""``LibraryService`` 写面：CAS 409 形状 / no-op 同 hash / rollback 走校验 / 历史裁剪 / 外部改动补记 / 写侧强制。"""

from __future__ import annotations

import hashlib
import os

import pytest

from src.library.constants import HISTORY_MAX_PER_FILE, TEXT_WRITE_MAX_BYTES
from src.library.service import Actor, LibraryError, LibraryService


def _h(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@pytest.fixture()
def svc(tmp_path) -> LibraryService:
    return LibraryService(str(tmp_path / "library.db"), str(tmp_path / "library"))


def _disk(svc: LibraryService, rel: str) -> bytes:
    with open(os.path.join(svc.root_path, *rel.split("/")), "rb") as f:
        return f.read()


def test_create_write_cas_conflict_shape_and_noop(svc: LibraryService) -> None:
    f = svc.create_file("my-docs/a.md", b"v1", change_note="init")
    assert f["path"] == "my-docs/a.md" and f["kind"] == "markdown" and f["text_status"] == "pending"
    assert f["content_hash"] == _h(b"v1") and f["source"] == "user" and f["created_by"] == "user"
    assert f["mime"] == "text/markdown" and "rel_key" not in f
    assert _disk(svc, "my-docs/a.md") == b"v1"

    # 新建语义：已存在 → 409
    with pytest.raises(LibraryError) as exc_info:
        svc.create_file("my-docs/a.md", b"x")
    assert exc_info.value.code == "E_VERSION_CONFLICT"

    # expected_hash 不符 → 409，带当前 hash + content
    with pytest.raises(LibraryError) as exc_info:
        svc.write_file(f["id"], "v2", expected_hash="deadbeef")
    assert exc_info.value.code == "E_VERSION_CONFLICT"
    assert exc_info.value.data == {"content_hash": f["content_hash"], "content": "v1"}

    # expected_hash=None = 新建语义，文件已存在 → 409
    with pytest.raises(LibraryError) as exc_info:
        svc.write_file(f["id"], "v2", expected_hash=None)
    assert exc_info.value.code == "E_VERSION_CONFLICT"

    f2 = svc.write_file(f["id"], "v2", expected_hash=f["content_hash"], change_note="edit")
    assert f2["content_hash"] == _h(b"v2") and _disk(svc, "my-docs/a.md") == b"v2"
    hist = svc.history(f["id"])
    assert [h["change_note"] for h in hist] == ["edit", "init"]
    assert hist[0]["old_hash"] == f["content_hash"] and hist[0]["new_hash"] == f2["content_hash"]
    assert hist[0]["changed_by"] == "user" and hist[0]["snapshot_bytes"] == 2

    # 同 hash = no-op：不记历史
    f3 = svc.write_file(f["id"], "v2", expected_hash=f2["content_hash"])
    assert f3["content_hash"] == f2["content_hash"] and len(svc.history(f["id"])) == 2

    g = svc.file(f["id"])
    assert g["content"] == "v2" and g["content_hash"] == f2["content_hash"]


def test_append_records_full_snapshot(svc: LibraryService) -> None:
    f = svc.create_file("agent-docs/log.md", b"one\n", actor=Actor(kind="main_agent"), source="agent")
    a = svc.append_file(f["id"], "two\n", actor=Actor(kind="custom_agent", agent_id="bot-1"), change_note="append")
    assert _disk(svc, "agent-docs/log.md") == b"one\ntwo\n" and a["content_hash"] == _h(b"one\ntwo\n")
    hist = svc.history(f["id"])
    assert hist[0]["changed_by"] == "bot-1" and hist[0]["snapshot_bytes"] == 8 and hist[0]["old_hash"] == f["content_hash"]


def test_rollback_goes_through_write_and_cas(svc: LibraryService) -> None:
    f = svc.create_file("my-docs/r.md", b"v1")
    svc.write_file(f["id"], "v2", expected_hash=f["content_hash"])
    first = svc.history(f["id"])[-1]
    r = svc.rollback(f["id"], first["id"])
    assert r["content_hash"] == _h(b"v1") and _disk(svc, "my-docs/r.md") == b"v1"
    hist = svc.history(f["id"])
    assert len(hist) == 3 and hist[0]["change_note"] == f"rollback to #{first['id']}"
    # 快照不属于该文件 → 404
    other = svc.create_file("my-docs/o.md", b"o")
    with pytest.raises(LibraryError) as exc_info:
        svc.rollback(other["id"], first["id"])
    assert exc_info.value.code == "E_NOT_FOUND"


def test_external_edit_detected_on_open_and_before_write(svc: LibraryService) -> None:
    f = svc.create_file("my-docs/e.md", b"v1")
    path = os.path.join(svc.root_path, "my-docs", "e.md")
    with open(path, "wb") as fh:
        fh.write(b"edited outside")
    os.utime(path, (f["mtime"] + 100, f["mtime"] + 100))
    g = svc.file(f["id"])
    assert g["content"] == "edited outside" and g["content_hash"] == _h(b"edited outside")
    hist = svc.history(f["id"])
    assert hist[0]["changed_by"] == "external" and hist[0]["old_hash"] == f["content_hash"]
    assert hist[0]["change_note"] is None
    # 客户端仍拿着旧 hash 写 → 409，body 带外部版本
    with pytest.raises(LibraryError) as exc_info:
        svc.write_file(f["id"], "mine", expected_hash=f["content_hash"])
    assert exc_info.value.data["content"] == "edited outside"
    # 文件消失 → missing，不删行（id 不悬空）
    os.unlink(path)
    m = svc.file(f["id"])
    assert m["status"] == "missing" and m["id"] == f["id"] and m["content"] is None


def test_write_authorization_is_server_side(svc: LibraryService, tmp_path) -> None:
    custom = Actor(kind="custom_agent", agent_id="bot")
    main = Actor(kind="main_agent")
    with pytest.raises(LibraryError) as exc_info:
        svc.create_file("mail-attachments/2026-07/x.md", b"x")
    assert exc_info.value.code == "E_AUTH_FAILED"
    with pytest.raises(LibraryError) as exc_info:
        svc.create_file(".trash/1/x.md", b"x")
    assert exc_info.value.code == "E_AUTH_FAILED"
    with pytest.raises(LibraryError) as exc_info:
        svc.create_file("nowhere/x.md", b"x")
    assert exc_info.value.code == "E_INVALID_ARG"
    # custom agent：只许 agent-docs/，且只许白名单扩展名
    with pytest.raises(LibraryError) as exc_info:
        svc.create_file("my-docs/x.md", b"x", actor=custom)
    assert exc_info.value.code == "E_AUTH_FAILED"
    with pytest.raises(LibraryError) as exc_info:
        svc.create_file("agent-docs/x.bin", b"x", actor=custom)
    assert exc_info.value.code == "E_AUTH_FAILED"
    ok = svc.create_file("agent-docs/x.md", b"x", actor=custom, source="agent")
    assert ok["created_by"] == "bot" and ok["source"] == "agent"
    # agent 文本上限 1 MB；人上传不受它限
    with pytest.raises(LibraryError) as exc_info:
        svc.create_file("agent-docs/big.md", b"x" * (TEXT_WRITE_MAX_BYTES + 1), actor=custom)
    assert exc_info.value.code == "E_INVALID_ARG"
    svc.create_file("my-docs/big.bin", b"x" * (TEXT_WRITE_MAX_BYTES + 1))
    # 主 agent：agent-docs / my-docs 可写，chat-attachments 不可
    svc.create_file("my-docs/m.md", b"x", actor=main)
    with pytest.raises(LibraryError):
        svc.create_file("chat-attachments/m.md", b"x", actor=main)
    # 人：chat-attachments 可写；二进制只进索引不进历史
    b = svc.create_file("chat-attachments/2026-09/u.bin", b"\x00\x01")
    assert b["kind"] == "other" and b["text_status"] == "unsupported" and svc.history(b["id"]) == []
    # ro 挂载根拒写；切 rw 后可写；custom agent 对 rw 挂载根可写
    ext = tmp_path / "ext"
    ext.mkdir()
    (ext / "r.md").write_text("r")
    m = svc.add_mount(str(ext), label="ext", mode="ro")
    fid = svc.folder("@ext")["files"][0]["id"]
    cur = svc.file(fid)["content_hash"]
    with pytest.raises(LibraryError) as exc_info:
        svc.write_file(fid, "z", expected_hash=cur)
    assert exc_info.value.code == "E_AUTH_FAILED"
    svc.patch_mount(m["id"], mode="rw")
    w = svc.write_file(fid, "z", expected_hash=cur, actor=custom)
    assert w["path"] == "@ext/r.md" and (ext / "r.md").read_text() == "z"


def test_history_pruned_per_file(svc: LibraryService) -> None:
    f = svc.create_file("my-docs/p.md", b"0")
    cur = f["content_hash"]
    for i in range(1, HISTORY_MAX_PER_FILE + 5):
        cur = svc.write_file(f["id"], str(i), expected_hash=cur)["content_hash"]
    hist = svc.history(f["id"])
    assert len(hist) == HISTORY_MAX_PER_FILE and hist[0]["new_hash"] == cur
