"""/api/library/* —— 鉴权档 / 路径拒收 / CAS 409 形状 / 分页排序 / inline Range 206 / 投影区与 ro 挂载拒写 /
另存附件 / 投影行三条只读端点 / 搜索 / 废纸篓全链 / rescan 形状 / 二进制上传 / 挂载家族。

service 指向临时库根 + conftest 的临时 sync_store（投影与另存吃它的 ATT_* 种子）。auth bypass 默认 ON。
"""

from __future__ import annotations

import os
import sqlite3
import time
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from src.api import auth as auth_mod
from src.api.app import app
from src.api.deps import get_repository
from src.api.routers import library as lib_router
from src.library.service import LibraryService
from tests.api.conftest import ATT_ESCAPE_ID, ATT_NOPATH_ID, ATT_NORMAL_ID, EMAIL_ID, MISSING_ID

LOCAL_TOK = "lib-local-token"
LOCAL_HEADERS = {"X-MailAgent-Local-Token": LOCAL_TOK}
CF_HEADERS = {"Cf-Access-Jwt-Assertion": "whatever"}


@pytest.fixture()
def lib(tmp_path, repo, temp_db) -> Iterator[tuple[TestClient, LibraryService]]:
    svc = LibraryService(str(tmp_path / "library.db"), str(tmp_path / "library"), str(temp_db))
    app.dependency_overrides[lib_router.get_library_service] = lambda: svc
    app.dependency_overrides[get_repository] = lambda: repo
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c, svc
    app.dependency_overrides.pop(lib_router.get_library_service, None)
    app.dependency_overrides.pop(get_repository, None)


def _data(r, status: int = 200):
    assert r.status_code == status, r.text
    body = r.json()
    assert body["status"] == "success" and body["error"] is None
    return body["data"]


def _err(r):
    body = r.json()
    assert body["status"] == "error"
    return r.status_code, body["error"]["code"], body


def _create(c: TestClient, parent: str, name: str, content: str, **extra):
    return _data(c.post("/api/library/files", json={"parent_path": parent, "filename": name, "content": content, **extra}))


# ── 鉴权档（verify_local_token，不接受 CF JWT）──────────────────────────────────


def _arm_cf_jwt(monkeypatch):
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)

    class _Key:
        key = "irrelevant"

    monkeypatch.setattr(auth_mod._jwk_client, "get_signing_key_from_jwt", lambda _t: _Key())
    monkeypatch.setattr(auth_mod.jwt, "decode", lambda *a, **k: {"email": "owner@example.com"})
    monkeypatch.setattr(auth_mod, "_resolve_allowed_emails", lambda: {"owner@example.com"})


def test_requires_local_token_and_rejects_cf_jwt(lib, monkeypatch):
    c, _ = lib
    _arm_cf_jwt(monkeypatch)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", LOCAL_TOK)
    assert c.get("/api/library/tree").status_code == 403
    assert c.get("/api/library/tree", headers=CF_HEADERS).status_code == 403
    assert c.get("/api/library/tree", headers=LOCAL_HEADERS).status_code == 200


# ── 路径校验 ───────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("path", ["../x", "my-docs/../../etc", "/etc/passwd", "my-docs/\x00x"])
def test_bad_paths_are_400(lib, path: str):
    c, _ = lib
    status, code, _ = _err(c.get("/api/library/folder", params={"path": path}))
    assert (status, code) == (400, "E_INVALID_ARG")
    status, code, _ = _err(c.post("/api/library/files", json={"parent_path": path, "filename": "a.md", "content": "x"}))
    assert (status, code) == (400, "E_INVALID_ARG")


def test_unknown_file_404_and_bad_sort_400(lib):
    c, _ = lib
    assert _err(c.get("/api/library/file/999999"))[:2] == (404, "E_NOT_FOUND")
    assert _err(c.get("/api/library/folder", params={"path": "my-docs", "sort": "bogus"}))[:2] == (400, "E_INVALID_ARG")


# ── 新建 / CAS ─────────────────────────────────────────────────────────────────


def test_create_then_put_cas_conflict_shape(lib):
    c, svc = lib
    f = _create(c, "my-docs", "a.md", "v1", change_note="init")
    assert f["path"] == "my-docs/a.md" and f["kind"] == "markdown" and f["mime"] == "text/markdown"
    assert f["content_hash"] and "rel_key" not in f and svc.root_path not in str(f)
    # 再建同路径 → 409
    assert _err(c.post("/api/library/files", json={"parent_path": "my-docs", "filename": "a.md", "content": "x"}))[:2] == (409, "E_VERSION_CONFLICT")
    # 错 hash → 409，body.data 带当前 hash + content
    status, code, body = _err(c.put(f"/api/library/file/{f['id']}", json={"content": "v2", "expected_hash": "nope"}))
    assert (status, code) == (409, "E_VERSION_CONFLICT")
    assert body["data"] == {"content_hash": f["content_hash"], "content": "v1"}
    # null = 新建语义，已存在 → 409
    assert _err(c.put(f"/api/library/file/{f['id']}", json={"content": "v2", "expected_hash": None}))[:2] == (409, "E_VERSION_CONFLICT")
    f2 = _data(c.put(f"/api/library/file/{f['id']}", json={"content": "v2", "expected_hash": f["content_hash"], "change_note": "edit"}))
    assert f2["content_hash"] != f["content_hash"]
    g = _data(c.get(f"/api/library/file/{f['id']}"))
    assert g["content"] == "v2" and g["truncated"] is False and g["content_hash"] == f2["content_hash"]
    g2 = _data(c.get(f"/api/library/file/{f['id']}", params={"max_bytes": 1}))
    assert g2["content"] == "v" and g2["truncated"] is True
    # extra=forbid：多余字段 422
    assert c.put(f"/api/library/file/{f['id']}", json={"content": "x", "expected_hash": f2["content_hash"], "bogus": 1}).status_code == 422
    # custom agent 写 my-docs → 403（服务端强制）
    status, code, _ = _err(c.put(
        f"/api/library/file/{f['id']}",
        json={"content": "z", "expected_hash": f2["content_hash"], "actor": {"kind": "custom_agent", "agent_id": "bot"}},
    ))
    assert (status, code) == (403, "E_AUTH_FAILED")


def test_append_move_and_batch(lib):
    c, _ = lib
    f = _create(c, "agent-docs", "log.md", "one\n")
    a = _data(c.post(f"/api/library/file/{f['id']}/append", json={"content": "two\n", "actor": {"kind": "custom_agent", "agent_id": "bot"}}))
    assert _data(c.get(f"/api/library/file/{f['id']}"))["content"] == "one\ntwo\n" and a["id"] == f["id"]
    moved = _data(c.post(f"/api/library/file/{f['id']}/move", json={"target_path": "my-docs"}))
    assert moved["path"] == "my-docs/log.md" and moved["id"] == f["id"]
    renamed = _data(c.post(f"/api/library/file/{f['id']}/move", json={"target_path": "my-docs/renamed.md"}))
    assert renamed["path"] == "my-docs/renamed.md"
    other = _create(c, "my-docs", "other.md", "x")
    assert _err(c.post(f"/api/library/file/{other['id']}/move", json={"target_path": "my-docs/renamed.md"}))[:2] == (409, "E_INVALID_STATE")
    batch = _data(c.get("/api/library/files", params={"ids": f"{f['id']},{other['id']},424242"}))
    assert sorted(x["id"] for x in batch) == sorted([f["id"], other["id"]])
    assert _err(c.get("/api/library/files", params={"ids": "1,x"}))[:2] == (400, "E_INVALID_ARG")


# ── 分页 / 排序 / has_more ─────────────────────────────────────────────────────


def test_folder_pagination_sort_and_root_listing(lib):
    c, _ = lib
    _create(c, "my-docs", "a.md", "1")
    _create(c, "my-docs", "B.md", "333")
    _create(c, "my-docs", "c.txt", "22")
    page = _data(c.get("/api/library/folder", params={"path": "my-docs", "limit": 2}))
    assert page["total"] == 3 and page["has_more"] is True and [f["filename"] for f in page["files"]] == ["a.md", "B.md"]
    page2 = _data(c.get("/api/library/folder", params={"path": "my-docs", "limit": 2, "offset": 2}))
    assert page2["has_more"] is False and [f["filename"] for f in page2["files"]] == ["c.txt"]
    by_size = _data(c.get("/api/library/folder", params={"path": "my-docs", "sort": "size", "dir": "desc"}))
    assert [f["filename"] for f in by_size["files"]] == ["B.md", "c.txt", "a.md"]
    root = _data(c.get("/api/library/folder"))
    assert root["files"] == [] and root["has_more"] is False
    assert {f["name"]: f["file_count"] for f in root["folders"]}["my-docs"] == 3
    tree = _data(c.get("/api/library/tree"))
    assert {n["path"] for n in tree["folders"]} >= {"mail-attachments", "chat-attachments", "agent-docs", "my-docs", ".trash"}
    assert tree["file_count"] == 3 and tree["mounts"] == []


# ── inline（Range 206 / html 直出）─────────────────────────────────────────────


def test_inline_streams_html_with_range(lib):
    c, _ = lib
    f = _create(c, "my-docs", "page.html", "<html><body><script>x()</script>hello</body></html>")
    r = c.get(f"/api/library/file/{f['id']}/inline")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/html")
    assert r.headers["content-disposition"].startswith("inline")
    assert r.headers["accept-ranges"] == "bytes" and b"<script>" in r.content
    r = c.get(f"/api/library/file/{f['id']}/inline", headers={"Range": "bytes=0-4"})
    assert r.status_code == 206 and r.content == b"<html" and r.headers["content-range"].startswith("bytes 0-4/")
    assert c.get(f"/api/library/file/{f['id']}/inline", headers={"Range": "bytes=99999-"}).status_code == 416
    assert c.get("/api/library/file/999999/inline").status_code == 404


# ── 写侧强制：投影区 / ro 挂载 ─────────────────────────────────────────────────


def test_projection_is_read_only(lib):
    c, _ = lib
    status, code, _ = _err(c.post("/api/library/files", json={"parent_path": "mail-attachments/2026-05", "filename": "x.md", "content": "x"}))
    assert (status, code) == (403, "E_AUTH_FAILED")
    status, code, _ = _err(c.post("/api/library/keep-attachment", json={"attachment_id": ATT_NORMAL_ID, "target_path": "mail-attachments/2026-05"}))
    assert (status, code) == (403, "E_AUTH_FAILED")


def test_ro_mount_rejects_put_until_switched_to_rw(lib, tmp_path):
    c, svc = lib
    ext = tmp_path / "ext"
    ext.mkdir()
    (ext / "r.md").write_text("r")
    m = _data(c.post("/api/library/mounts", json={"abs_path": str(ext), "label": "ext", "mode": "ro"}))
    assert m["abs_path"] == os.path.realpath(str(ext)) and m["file_count"] == 1 and m["status"] == "ok"
    listing = _data(c.get("/api/library/folder", params={"path": "@ext"}))
    fid = listing["files"][0]["id"]
    cur = _data(c.get(f"/api/library/file/{fid}"))["content_hash"]
    assert _err(c.put(f"/api/library/file/{fid}", json={"content": "z", "expected_hash": cur}))[:2] == (403, "E_AUTH_FAILED")
    assert _data(c.patch(f"/api/library/mounts/{m['id']}", json={"mode": "rw"}))["mode"] == "rw"
    assert _data(c.put(f"/api/library/file/{fid}", json={"content": "z", "expected_hash": cur}))["path"] == "@ext/r.md"
    # tree / folder / search 永不露绝对路径；mounts 端点是唯一例外
    for r in (c.get("/api/library/tree"), c.get("/api/library/folder", params={"path": "@ext"}), c.get("/api/library/search", params={"q": "z"})):
        assert str(tmp_path) not in r.text
    assert str(tmp_path) in c.get("/api/library/mounts").text
    gone = _data(c.delete(f"/api/library/mounts/{m['id']}"))
    assert gone["status"] == "unmounted" and _data(c.get("/api/library/mounts")) == []
    assert _err(c.post("/api/library/mounts", json={"abs_path": "/"}))[:2] == (400, "E_INVALID_ARG")


# ── 另存附件 + 投影行三条只读端点 ─────────────────────────────────────────────


def test_keep_attachment_copies_and_guards(lib, temp_db):
    c, svc = lib
    conn = sqlite3.connect(str(temp_db))
    try:
        conn.execute(
            "INSERT OR REPLACE INTO email_attachment_text (attachment_id, text_content, text_size_bytes, extractor, status,"
            " truncated, created_at, updated_at) VALUES (?, 'quarterly numbers', 17, 'pypdf', 'extracted', 0, ?, ?)",
            (ATT_NORMAL_ID, time.time(), time.time()),
        )
        conn.commit()
    finally:
        conn.close()
    try:
        f = _data(c.post("/api/library/keep-attachment", json={"attachment_id": ATT_NORMAL_ID, "target_path": "my-docs"}))
        assert f["source"] == "mail" and f["source_ref"] == str(ATT_NORMAL_ID) and f["filename"] == "report.pdf"
        assert f["text_status"] == "extracted" and f["path"] == "my-docs/report.pdf"
        with open(os.path.join(svc.root_path, "my-docs", "report.pdf"), "rb") as fh:
            assert fh.read() == b"%PDF-1.4 fake pdf bytes"
        t = _data(c.get(f"/api/library/file/{f['id']}/text"))
        assert t["markdown"] == "quarterly numbers" and t["extractor"] == "pypdf" and t["hint"] is None
        # 投影行三条只读端点
        item = _data(c.get(f"/api/library/attachment/{ATT_NORMAL_ID}"))
        assert item["id"] is None and item["attachment_id"] == ATT_NORMAL_ID and item["is_projection"] is True
        assert item["subject"] == "Quarterly redis timeout review" and item["source_label"] == "Quarterly redis timeout review · Alice"
        assert item["path"] == "mail-attachments/2026-05/report.pdf" and item["content"] is None and item["status"] == "present"
        pt = _data(c.get(f"/api/library/attachment/{ATT_NORMAL_ID}/text", params={"max_bytes": 9}))
        assert pt["file_id"] is None and pt["attachment_id"] == ATT_NORMAL_ID and pt["markdown"] == "quarterly"
        assert pt["truncated"] is True and pt["text_status"] == "extracted" and pt["hint"] is None
        r = c.get(f"/api/library/attachment/{ATT_NORMAL_ID}/inline", headers={"Range": "bytes=0-3"})
        assert r.status_code == 206 and r.content == b"%PDF" and r.headers["content-disposition"].startswith("inline")
        assert svc.db.connect().execute("SELECT COUNT(*) FROM library_text").fetchone()[0] == 1  # 投影 text 不写 library_text
    finally:
        conn = sqlite3.connect(str(temp_db))
        conn.execute("DELETE FROM email_attachment_text WHERE attachment_id=?", (ATT_NORMAL_ID,))
        conn.commit()
        conn.close()
    # 守卫：越界附件 403、无文件 404、不存在 404
    assert _err(c.post("/api/library/keep-attachment", json={"attachment_id": ATT_ESCAPE_ID, "target_path": "my-docs"}))[:2] == (403, "E_AUTH_FAILED")
    assert c.get(f"/api/library/attachment/{ATT_ESCAPE_ID}/inline").status_code == 403
    assert _err(c.post("/api/library/keep-attachment", json={"attachment_id": ATT_NOPATH_ID, "target_path": "my-docs"}))[:2] == (404, "E_NOT_FOUND")
    assert _err(c.post("/api/library/keep-attachment", json={"attachment_id": MISSING_ID, "target_path": "my-docs"}))[:2] == (404, "E_NOT_FOUND")
    assert _err(c.get(f"/api/library/attachment/{MISSING_ID}"))[:2] == (404, "E_NOT_FOUND")
    pending = _data(c.get(f"/api/library/attachment/{ATT_NOPATH_ID}/text"))
    assert pending["markdown"] is None and pending["text_status"] == "pending" and pending["hint"]
    months = _data(c.get("/api/library/folder", params={"path": "mail-attachments"}))
    assert months["is_projection"] is True and any(f["name"] == "2026-05" for f in months["folders"])
    listing = _data(c.get("/api/library/folder", params={"path": "mail-attachments/2026-05", "q": "alice"}))
    assert listing["total"] >= 1 and all(it["internal_id"] == EMAIL_ID for it in listing["files"])


# ── 搜索 ───────────────────────────────────────────────────────────────────────


def test_search_hits_and_cjk_warning(lib):
    c, _ = lib
    f = _create(c, "my-docs", "ops.md", "redis timeout on the cache cluster")
    s = _data(c.get("/api/library/search", params={"q": "redis timeout"}))
    assert s["mode"] == "porter" and [h["id"] for h in s["hits"]] == [f["id"]] and "[redis timeout]" in s["hits"][0]["snippet"]
    w = _data(c.get("/api/library/search", params={"q": "研"}))
    assert w["hits"] == [] and w["warnings"] == ["cjk_too_short:研"]
    assert c.get("/api/library/search").status_code == 422


# ── 废纸篓全链 + 历史 / 回滚 + rescan ─────────────────────────────────────────


def test_trash_restore_purge_history_rollback_rescan(lib):
    c, svc = lib
    f = _create(c, "my-docs", "t.md", "v1")
    f2 = _data(c.put(f"/api/library/file/{f['id']}", json={"content": "v2", "expected_hash": f["content_hash"]}))
    hist = _data(c.get(f"/api/library/file/{f['id']}/history"))
    assert [h["new_hash"] for h in hist] == [f2["content_hash"], f["content_hash"]] and "content_snapshot" not in hist[0]
    back = _data(c.post(f"/api/library/file/{f['id']}/rollback", json={"history_id": hist[-1]["id"]}))
    assert back["content_hash"] == f["content_hash"]
    t = _data(c.delete(f"/api/library/file/{f['id']}"))
    assert t["status"] == "trashed" and t["parent_path"] == "my-docs"
    assert _data(c.get("/api/library/folder", params={"path": ".trash"}))["total"] == 1
    assert _err(c.put(f"/api/library/file/{f['id']}", json={"content": "x", "expected_hash": f["content_hash"]}))[:2] == (409, "E_INVALID_STATE")
    r = _data(c.post(f"/api/library/file/{f['id']}/restore"))
    assert r["status"] == "present" and r["path"] == "my-docs/t.md"
    assert _err(c.delete(f"/api/library/file/{f['id']}", params={"purge": "true"}))[:2] == (409, "E_INVALID_STATE")
    _data(c.delete(f"/api/library/file/{f['id']}"))
    assert _data(c.delete(f"/api/library/file/{f['id']}", params={"purge": "true"})) == {"id": f["id"], "purged": True}
    assert _err(c.get(f"/api/library/file/{f['id']}"))[:2] == (404, "E_NOT_FOUND")
    stats = _data(c.post("/api/library/rescan", json={}))
    assert set(stats) == {"scanned", "added", "updated", "missing", "elapsed_ms"}
    assert _data(c.post("/api/library/rescan")) is not None


# ── 二进制上传（octet-stream + query）────────────────────────────────────────


def test_binary_upload_via_octet_stream(lib):
    c, svc = lib
    r = c.post(
        "/api/library/files",
        params={"parent_path": "chat-attachments/2026-09", "filename": "blob.bin", "source": "chat"},
        content=b"\x00\x01\x02",
        headers={"content-type": "application/octet-stream"},
    )
    f = _data(r)
    assert f["kind"] == "other" and f["source"] == "chat" and f["size_bytes"] == 3 and f["text_status"] == "unsupported"
    assert _err(c.post("/api/library/files", content=b"x", headers={"content-type": "application/octet-stream"}))[:2] == (400, "E_INVALID_ARG")
    assert _err(c.post("/api/library/files", json={"parent_path": "my-docs", "filename": "s.md", "content": "x", "source": "nope"}))[:2] == (400, "E_INVALID_ARG")
    assert _err(c.post("/api/library/files", content=b"{not json", headers={"content-type": "application/json"}))[:2] == (400, "E_INVALID_ARG")


# ── 语义检索三端点（design §9.1）──────────────────────────────────────────────
# 🔴 本节一次也不下载 614 MB 权重：`download_model` 恒被替换掉，只验契约形状。


def test_search_response_carries_the_semantic_contract_even_without_a_model(lib):
    """没下载权重时返回体形状**完全一致** —— 前端按同一份键写代码，不做两套分支。"""
    c, _ = lib
    _create(c, "my-docs", "ops.md", "redis timeout on the cache cluster")
    s = _data(c.get("/api/library/search", params={"q": "redis timeout"}))
    assert set(s) == {"query", "mode", "search_mode", "semantic", "hits", "warnings"}
    assert s["search_mode"] == "fts"
    assert s["semantic"] == {"available": False, "model": None, "chunks": 0}
    assert all(h["lane"] == "fts" for h in s["hits"])
    # mode=fts 与默认的 hybrid 在没模型时逐键同形。
    assert set(_data(c.get("/api/library/search", params={"q": "redis", "mode": "fts"}))) == set(s)
    assert _err(c.get("/api/library/search", params={"q": "redis", "mode": "semantic"}))[:2] == (400, "E_INVALID_ARG")


def test_embed_status_shape_without_a_model(lib):
    c, _ = lib
    st = _data(c.get("/api/library/embed/status"))
    assert set(st) == {"model", "index", "job"}
    assert set(st["model"]) == {"available", "model_id", "repo", "approx_bytes", "bytes_on_disk"}
    assert st["model"]["available"] is False and st["model"]["approx_bytes"] > 0
    assert set(st["index"]) == {"files_total", "files_indexed", "files_pending", "chunks"}
    assert st["job"] is None
    # 🔴 不含任何绝对路径（renderer 永不拿到库根的真实位置）。
    assert "/" not in st["model"]["model_id"]


def test_rebuild_is_refused_without_a_model(lib):
    """E_INVALID_STATE 走 409（不是 400）—— 前端按状态码分支时别抄错。"""
    c, _ = lib
    assert _err(c.post("/api/library/embed/rebuild"))[:2] == (409, "E_INVALID_STATE")


def test_download_endpoint_returns_a_status_with_the_job_attached(lib, monkeypatch):
    """下载端点立即返回一份 status，进度经 `GET /embed/status` 的 `job` 轮询。"""
    from src.library import embed as embed_mod

    monkeypatch.setattr(embed_mod, "download_model", lambda _root, **_kw: "")  # 🔴 绝不真下 614 MB
    c, _ = lib
    st = _data(c.post("/api/library/embed/download"))
    assert set(st["job"]) == {"kind", "running", "done", "total", "error", "started_at", "finished_at"}
    # 🔴 下载**完成后会自动接上建索引**，所以这里读到的 job 可能已经是 'index' 了（本测试里
    # 下载被替换成瞬时 no-op，必然如此）。前端渲染进度必须按 `job.kind` 分两种文案，
    # 不能假定「点了下载 → job 恒为 download」。
    assert st["job"]["kind"] in ("download", "index")


def test_download_is_refused_when_the_model_is_already_there(lib, monkeypatch):
    from src.library import embed as embed_mod

    monkeypatch.setattr(embed_mod, "model_present", lambda _root: True)
    c, _ = lib
    assert _err(c.post("/api/library/embed/download"))[:2] == (409, "E_INVALID_STATE")


def test_recent_spans_roots_and_is_not_folder_scoped(lib):
    """「最近」必须跨根、不限层级 —— 拿 /folder 拼只能覆盖各根顶层，会漏掉子目录里的文件。"""
    c, svc = lib
    _create(c, "my-docs", "top.md", "v")
    _create(c, "my-docs/深/更深", "nested.md", "v")
    _create(c, "agent-docs", "other.md", "v")
    names = [f["filename"] for f in _data(c.get("/api/library/recent?limit=10"))["files"]]
    assert "nested.md" in names, "子目录里的文件必须出现在最近里"
    assert {"top.md", "other.md"} <= set(names), "必须跨根"
    # 与 /folder 对照：它只给 my-docs 的直接子项，拿它拼「最近」就会漏掉 nested.md
    folder_names = [f["filename"] for f in _data(c.get("/api/library/folder?path=my-docs"))["files"]]
    assert "nested.md" not in folder_names


def test_recent_orders_by_mtime_desc_and_excludes_trashed(lib):
    c, svc = lib
    old = _create(c, "my-docs", "old.md", "v")
    new = _create(c, "my-docs", "new.md", "v")
    svc.trash_file(new["id"])
    names = [f["filename"] for f in _data(c.get("/api/library/recent?limit=10"))["files"]]
    assert "new.md" not in names, "trashed 不进最近"
    assert names[0] == "old.md"


def test_history_snapshot_returns_body_and_refuses_cross_file_ids(lib):
    """快照正文按 (file_id, history_id) 取；只知道 history_id 读不到别的文件的正文。"""
    c, svc = lib
    a = _create(c, "my-docs", "a.md", "v1")
    c.put(f"/api/library/file/{a['id']}", json={"content": "v2", "expected_hash": a["content_hash"]})
    b = _create(c, "my-docs", "b.md", "other-secret")
    hist = _data(c.get(f"/api/library/file/{a['id']}/history"))
    assert hist and "content_snapshot" not in hist[0], "列表不带正文，只给 snapshot_bytes"
    # 语义两条：列表新→旧排序，快照存的是「该次写入后」的正文（不是写入前）
    assert [h["id"] for h in hist] == sorted((h["id"] for h in hist), reverse=True)
    assert _data(c.get(f"/api/library/file/{a['id']}/history/{hist[0]['id']}"))["content_snapshot"] == "v2"
    snap = _data(c.get(f"/api/library/file/{a['id']}/history/{hist[-1]['id']}"))
    assert snap["content_snapshot"] == "v1"
    # 拿 a 的 history_id 去 b 的路径下读 → 404，不是把 a 的正文交出去
    assert _err(c.get(f"/api/library/file/{b['id']}/history/{hist[0]['id']}"))[:2] == (404, "E_NOT_FOUND")
