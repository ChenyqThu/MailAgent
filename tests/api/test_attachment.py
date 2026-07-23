"""Attachment list + binary download/inline + the path-traversal 403 guard.

Security-critical: the download/inline endpoints resolve `local_path` and MUST
reject any path that escapes the AttachmentStore base dir (REMOTE-ACCESS §9 /
implementation-spec gotcha #1). The fixture seeds an attachment whose local_path
points outside the temp store; we assert 403 E_AUTH_FAILED.
"""

from __future__ import annotations

import sqlite3

from tests.api.conftest import (
    ATT_ESCAPE_ID,
    ATT_NOPATH_ID,
    ATT_NORMAL_ID,
    EMAIL_ID,
    MISSING_ID,
)


# ---------------------------------------------------------------------------
# GET /api/attachment/list/{internal_id}
# ---------------------------------------------------------------------------


def test_attachment_list_strips_local_path(client):
    r = client.get(f"/api/attachment/list/{EMAIL_ID}")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "success"
    assert body["error"] is None
    assert body["meta"]["source"] == "sqlite"

    items = body["data"]
    assert len(items) == 3
    for a in items:
        # gotcha #1: host path NEVER on the wire.
        assert "local_path" not in a
        assert "created_at" not in a
    assert body["meta"]["count"] == 3
    assert body["meta"]["internal_id"] == EMAIL_ID


def test_attachment_list_unknown_email_404(client):
    r = client.get(f"/api/attachment/list/{MISSING_ID}")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


# ---------------------------------------------------------------------------
# GET /api/attachment/{att_id}/download
# ---------------------------------------------------------------------------


def test_attachment_download_ok(client):
    r = client.get(f"/api/attachment/{ATT_NORMAL_ID}/download")
    assert r.status_code == 200
    assert r.content == b"%PDF-1.4 fake pdf bytes"
    assert r.headers["content-type"].startswith("application/pdf")
    cd = r.headers["content-disposition"]
    assert cd.startswith("attachment;")
    assert "report.pdf" in cd
    assert r.headers["accept-ranges"] == "bytes"


def test_attachment_download_range_206(client):
    r = client.get(
        f"/api/attachment/{ATT_NORMAL_ID}/download",
        headers={"Range": "bytes=0-3"},
    )
    assert r.status_code == 206
    assert r.content == b"%PDF"
    assert r.headers["content-range"] == "bytes 0-3/23"
    assert r.headers["content-length"] == "4"


def test_attachment_download_range_unsatisfiable_416(client):
    r = client.get(
        f"/api/attachment/{ATT_NORMAL_ID}/download",
        headers={"Range": "bytes=9999-10000"},
    )
    assert r.status_code == 416
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_attachment_inline_disposition(client):
    r = client.get(f"/api/attachment/{ATT_NORMAL_ID}/inline")
    assert r.status_code == 200
    assert r.headers["content-disposition"].startswith("inline;")


# ---------------------------------------------------------------------------
# Path-traversal guard — THE security assertion
# ---------------------------------------------------------------------------


def test_attachment_download_path_traversal_403(client):
    """local_path escaping the store base dir → 403 E_AUTH_FAILED, no bytes."""
    r = client.get(f"/api/attachment/{ATT_ESCAPE_ID}/download")
    assert r.status_code == 403
    body = r.json()
    assert body["status"] == "error"
    assert body["error"]["code"] == "E_AUTH_FAILED"
    assert body["data"] is None
    # The escaping host path must not leak into the error message/hint.
    assert "secret.env" not in (body["error"].get("hint") or "")


def test_attachment_inline_path_traversal_403(client):
    r = client.get(f"/api/attachment/{ATT_ESCAPE_ID}/inline")
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "E_AUTH_FAILED"


def test_attachment_download_no_local_path_404(client):
    r = client.get(f"/api/attachment/{ATT_NOPATH_ID}/download")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


def test_attachment_download_unknown_id_404(client):
    r = client.get("/api/attachment/424242/download")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


# ---------------------------------------------------------------------------
# GET /api/attachment/search — FTS5 附件文本搜索（V2.1 3b-4）
# ---------------------------------------------------------------------------


def test_attachment_search_empty_no_fts_graceful(client):
    """conftest 无 email_attachment_fts 表 → repo + count helper graceful → empty（不 500）。"""
    r = client.get("/api/attachment/search?q=redis")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "success"
    data = body["data"]
    assert data["items"] == []
    assert data["total_indexed"] == 0
    assert data["mode"] == "smart"
    assert body["meta"]["query"] == "redis"


def test_attachment_search_missing_q_422(client):
    r = client.get("/api/attachment/search")
    assert r.status_code == 422


def test_attachment_search_raw_mode_field(client):
    r = client.get("/api/attachment/search?q=redis&raw=true")
    assert r.status_code == 200
    assert r.json()["data"]["mode"] == "raw"


def test_attachment_search_hits(client, temp_db):
    """自建 email_attachment_fts seed（conftest 无此表）→ 验证 hit 映射 + JOIN 邮件上下文。"""

    conn = sqlite3.connect(str(temp_db))
    conn.execute("CREATE VIRTUAL TABLE email_attachment_fts USING fts5(text)")
    conn.execute(
        "INSERT INTO email_attachment_fts (rowid, text) VALUES (?, ?)",
        (ATT_NORMAL_ID, "redis configuration and timeout guide"),
    )
    conn.commit()
    conn.close()

    # raw=true 直 match（避开 smart transform 的不确定性）；hit 映射与 mode 无关。
    r = client.get("/api/attachment/search?q=redis&raw=true")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["total_indexed"] == 1
    assert len(data["items"]) == 1
    hit = data["items"][0]
    assert hit["attachment_id"] == ATT_NORMAL_ID
    assert hit["internal_id"] == EMAIL_ID
    assert hit["filename"] == "report.pdf"
    assert "redis" in hit["snippet"]
    assert "rank" in hit
    assert "notion_url" in hit


def test_attachment_search_has_more_probe(client, temp_db):
    """limit+1 探针 has_more（PR-B D4）：2 条附件命中，limit=1 → has_more=true 且裁到
    1 条；limit=2 → has_more=false 且 2 条全返回。``CREATE ... IF NOT EXISTS`` +
    ``INSERT OR REPLACE`` 使本测试不依赖 test_attachment_search_hits 的执行顺序。
    复用 conftest 已建的两个附件行（ATT_NORMAL_ID/ATT_ESCAPE_ID，同挂 EMAIL_ID 下）
    做两个 FTS 命中，不新建附件行。
    """
    conn = sqlite3.connect(str(temp_db))
    try:
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS email_attachment_fts USING fts5(text)"
        )
        conn.execute(
            "INSERT OR REPLACE INTO email_attachment_fts (rowid, text) VALUES (?, ?)",
            (ATT_NORMAL_ID, "redis configuration and timeout guide"),
        )
        conn.execute(
            "INSERT OR REPLACE INTO email_attachment_fts (rowid, text) VALUES (?, ?)",
            (ATT_ESCAPE_ID, "redis cluster failover notes"),
        )
        conn.commit()
    finally:
        conn.close()

    r1 = client.get("/api/attachment/search?q=redis&raw=true&limit=1")
    assert r1.status_code == 200
    body1 = r1.json()
    data1 = body1["data"]
    assert len(data1["items"]) == 1
    assert data1["has_more"] is True
    assert body1["meta"]["has_more"] is True

    r2 = client.get("/api/attachment/search?q=redis&raw=true&limit=2")
    assert r2.status_code == 200
    body2 = r2.json()
    data2 = body2["data"]
    assert len(data2["items"]) == 2
    assert data2["has_more"] is False
    assert body2["meta"]["has_more"] is False


# ---------------------------------------------------------------------------
# GET /api/attachment/thread/{thread_id}
# ---------------------------------------------------------------------------

# EMAIL_ID (1001) 的 thread_id + 归属（见 conftest _seed）。
_THREAD_ID = "thread-A"
_EMAIL_SENDER = "alice@example.com"
_EMAIL_SENDER_NAME = "Alice"
_EMAIL_SUBJECT = "Quarterly redis timeout review"
_EMAIL_DATE = "2026-05-01 09:00:00"

_EXPECTED_THREAD_KEYS = {
    "id", "internal_id", "filename", "size_bytes", "content_type",
    "is_inline", "sender", "sender_name", "date_received", "email_subject",
}
# 最小元数据面：这些字段绝不上 wire（local_path 是硬安全不变式，其余是内部/镜像细节）。
_FORBIDDEN_THREAD_KEYS = {
    "local_path", "sha256", "notion_file_id", "notion_block_id",
    "derived_from", "derived_format", "content_id", "created_at",
}


def test_attachment_thread_lists_with_attribution(client):
    r = client.get(f"/api/attachment/thread/{_THREAD_ID}")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "success"
    assert body["meta"]["source"] == "sqlite"

    data = body["data"]
    assert data["thread_id"] == _THREAD_ID
    items = data["items"]
    # EMAIL_ID 的 3 个附件（report.pdf / secret.env / ghost.bin），同封同日 → a.id ASC。
    assert [it["filename"] for it in items] == ["report.pdf", "secret.env", "ghost.bin"]
    assert body["meta"]["count"] == 3
    assert body["meta"]["thread_id"] == _THREAD_ID

    for it in items:
        # 归属跟随 EMAIL_ID。
        assert it["internal_id"] == EMAIL_ID
        assert it["sender"] == _EMAIL_SENDER
        assert it["sender_name"] == _EMAIL_SENDER_NAME
        assert it["email_subject"] == _EMAIL_SUBJECT
        assert it["date_received"] == _EMAIL_DATE
        # 稳定的最小字段集，且安全字段一个都不上 wire。
        assert set(it.keys()) == _EXPECTED_THREAD_KEYS
        assert not (_FORBIDDEN_THREAD_KEYS & set(it.keys()))


def test_attachment_thread_unknown_returns_empty(client):
    r = client.get("/api/attachment/thread/no-such-thread")
    assert r.status_code == 200
    body = r.json()
    assert body["data"]["thread_id"] == "no-such-thread"
    assert body["data"]["items"] == []
    assert body["meta"]["count"] == 0


# ---------------------------------------------------------------------------
# GET /api/attachment/{attachment_id}/text
# ---------------------------------------------------------------------------

_NOW = 1_700_000_000.0

# 专供 /text 测试的独立邮件 + 归属 —— 绝不挂到 EMAIL_ID（session-scoped temp_db 共享，
# 挂 EMAIL_ID 会污染 email get / list-enriched 的附件计数断言）。
_TEXT_EMAIL_ID = 5000
_TEXT_EMAIL_SUBJECT = "Attachment text fixture email"
_TEXT_EMAIL_SENDER = "fixture@example.com"


def _ensure_text_email(temp_db):
    conn = sqlite3.connect(str(temp_db))
    conn.execute(
        """INSERT OR IGNORE INTO email_metadata
           (internal_id, message_id, subject, sender, sender_name,
            date_received, mailbox, sync_status, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        # 独立合成 mailbox（不落 收件箱）—— 避免污染 list-mailboxes / list 计数断言。
        (_TEXT_EMAIL_ID, "<fixture-5000@x>", _TEXT_EMAIL_SUBJECT,
         _TEXT_EMAIL_SENDER, "Fixture", "2026-05-20 08:00:00",
         "__attach_text_fixture__", "synced", _NOW, _NOW),
    )
    conn.commit()
    conn.close()


def _insert_attachment(
    temp_db, att_id, filename, *, local_path, content_type="text/plain",
    size=0, is_inline=0,
):
    _ensure_text_email(temp_db)
    conn = sqlite3.connect(str(temp_db))
    conn.execute(
        """INSERT INTO email_attachment
           (id, internal_id, content_id, filename, content_type, size_bytes,
            is_inline, local_path, sha256, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (att_id, _TEXT_EMAIL_ID, None, filename, content_type, size, is_inline,
         local_path, "a" * 64, _NOW),
    )
    conn.commit()
    conn.close()


def _insert_text_row(temp_db, att_id, *, status, text, extractor, truncated=0):
    conn = sqlite3.connect(str(temp_db))
    tb = len(text.encode("utf-8")) if text else 0
    conn.execute(
        """INSERT INTO email_attachment_text
           (attachment_id, text_content, text_size_bytes, extractor, status,
            error_message, retry_count, truncated, created_at, updated_at)
           VALUES (?,?,?,?,?,?,0,?,?,?)""",
        (att_id, text, tb, extractor, status, None, truncated, _NOW, _NOW),
    )
    conn.commit()
    conn.close()


def test_attachment_text_unknown_id_404(client):
    r = client.get("/api/attachment/787878/text")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


def test_attachment_text_extracted(client, temp_db):
    """已抽取行 → 直接返回 text + 归属，status=extracted, hint=null, 无 local_path。"""
    att_id = 5001
    _insert_attachment(temp_db, att_id, "notes.txt",
                       local_path="data/attachments/1001/notes.txt")
    _insert_text_row(temp_db, att_id, status="extracted",
                     text="LINE ONE\nLINE TWO", extractor="plaintext")

    r = client.get(f"/api/attachment/{att_id}/text")
    assert r.status_code == 200
    d = r.json()["data"]
    assert d["attachment_id"] == att_id
    assert d["internal_id"] == _TEXT_EMAIL_ID
    assert d["filename"] == "notes.txt"
    assert d["status"] == "extracted"
    assert d["text_content"] == "LINE ONE\nLINE TWO"
    assert d["truncated"] is False
    assert d["extractor"] == "plaintext"
    assert d["email_subject"] == _TEXT_EMAIL_SUBJECT
    assert d["sender"] == _TEXT_EMAIL_SENDER
    assert d["hint"] is None
    assert "local_path" not in d


def test_attachment_text_max_chars_truncates(client, temp_db):
    att_id = 5002
    _insert_attachment(temp_db, att_id, "long.txt",
                       local_path="data/attachments/1001/long.txt")
    _insert_text_row(temp_db, att_id, status="extracted",
                     text="ABCDEFGHIJ", extractor="plaintext")

    r = client.get(f"/api/attachment/{att_id}/text?max_chars=4")
    assert r.status_code == 200
    d = r.json()["data"]
    assert d["text_content"] == "ABCD"
    assert d["truncated"] is True


def test_attachment_text_pending_when_no_file(client):
    """local_path NULL（ATT_NOPATH_ID）→ 同步兜底跑不了 → status=pending + hint。"""
    r = client.get(f"/api/attachment/{ATT_NOPATH_ID}/text")
    assert r.status_code == 200
    d = r.json()["data"]
    assert d["status"] == "pending"
    assert d["text_content"] is None
    assert d["hint"]  # 一句可执行提示
    assert d["filename"] == "ghost.bin"
    assert d["internal_id"] == EMAIL_ID


def test_attachment_text_pending_sync_extracts(client, temp_db, attach_dir):
    """task 0 兜底核心：pending（无 text 行）+ 文件 ≤5MB → 端点现场抽取并落库。"""
    att_id = 5003
    f = attach_dir / str(_TEXT_EMAIL_ID) / "readme.md"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text("Hello from readme\nSecond line", encoding="utf-8")
    _insert_attachment(temp_db, att_id, "readme.md", local_path=str(f),
                       content_type="text/markdown", size=f.stat().st_size)

    r = client.get(f"/api/attachment/{att_id}/text")
    assert r.status_code == 200
    d = r.json()["data"]
    assert d["status"] == "extracted"
    assert d["text_content"] == "Hello from readme\nSecond line"
    assert d["extractor"] == "plaintext"
    assert d["hint"] is None

    # 落库持久化：现在存在一条 extracted 行（下次读走缓存，不再抽）。
    conn = sqlite3.connect(str(temp_db))
    row = conn.execute(
        "SELECT status FROM email_attachment_text WHERE attachment_id=?",
        (att_id,),
    ).fetchone()
    conn.close()
    assert row[0] == "extracted"


# ---------------------------------------------------------------------------
# 批次3 PR-E: 端点内核 trigram 路由（raw=false smart）+ transformed_query 收窄
# conftest 的 trimmed _DDL 无 v39 email_attachment_fts_trigram 表，故这些用例用真
# SyncStore 建全表 + 显式 trigram_enabled 的 repo，独立 client override（不碰 session repo）。
# ---------------------------------------------------------------------------


def _seed_trigram_db(tmp_path):
    """真 SyncStore 建全表（含 v39 trigram）+ 播一个 CJK 文件名/正文附件。

    返回 (db_path, store, attachment_id_of_劳动合同书)。
    """
    import time

    from src.mail.sync_store import SyncStore
    from src.repository import (
        AttachmentPayload,
        AttachmentStore,
        BodyPayload,
        EmailRepository,
    )

    db = tmp_path / "trigram_store.db"
    SyncStore(str(db))
    store = AttachmentStore(base_dir=str(tmp_path / "attach"))
    seed_repo = EmailRepository(db_path=str(db), attachment_store=store)

    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute(
        "INSERT INTO email_metadata (internal_id, message_id, subject, sender, "
        "mailbox, date_received, sync_status, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?, 'synced', ?, ?)",
        (7100, "<m7100@x>", "合同邮件", "alice@x", "收件箱",
         "2026-05-10T10:00:00+08:00", time.time(), time.time()),
    )
    conn.commit()
    conn.close()

    idm = seed_repo.commit_email_with_body(
        7100,
        BodyPayload(html="", markdown="body", body_format="html"),
        [AttachmentPayload(filename="劳动合同书.pdf", content=b"%PDF",
                           content_type="application/pdf")],
    )
    seed_repo.commit_attachment_text(
        idm["劳动合同书.pdf"], text="本劳动合同条款如下所述甲乙双方", extractor="pypdf",
    )
    return db, store, idm["劳动合同书.pdf"]


def test_attachment_search_trigram_cjk_and_filename(tmp_path):
    """端点级（raw=false smart）：内核 trigram 路由 —— 2 字 CJK '合同' 子串命中文件名 +
    正文（批次3 PR-E）。纯 LIKE → rank null + snippet fallback；trigram 开 → 不发
    transformed_query（D1 修订收窄）。"""
    from fastapi.testclient import TestClient

    from src.api.app import app
    from src.api.deps import get_repository
    from src.repository import EmailRepository

    db, store, att_id = _seed_trigram_db(tmp_path)
    repo = EmailRepository(
        db_path=str(db), attachment_store=store, trigram_enabled=True
    )
    app.dependency_overrides[get_repository] = lambda: repo
    try:
        with TestClient(app, raise_server_exceptions=False) as c:
            r = c.get("/api/attachment/search?q=合同")
            assert r.status_code == 200
            data = r.json()["data"]
            assert data["mode"] == "smart"
            att_ids = {it["attachment_id"] for it in data["items"]}
            assert att_id in att_ids                 # 文件名 + 正文子串命中
            hit = next(it for it in data["items"] if it["attachment_id"] == att_id)
            assert hit["rank"] is None               # 纯 LIKE → rank null
            assert hit["snippet"]                    # fallback 非空
            assert "transformed_query" not in data   # trigram 开 → 收窄不发
    finally:
        app.dependency_overrides.pop(get_repository, None)


def test_attachment_search_transformed_query_only_when_trigram_off(tmp_path):
    """transformed_query meta 收窄（D1 修订）：仅 trigram 关（flag off）且 smart 变换 != q
    时才发。router 用 repo.trigram_enabled 复刻判定。"""
    from fastapi.testclient import TestClient

    from src.api.app import app
    from src.api.deps import get_repository
    from src.repository import EmailRepository
    from src.repository.email_repository import smart_query_transform

    db, store, _ = _seed_trigram_db(tmp_path)
    repo_off = EmailRepository(
        db_path=str(db), attachment_store=store, trigram_enabled=False
    )
    app.dependency_overrides[get_repository] = lambda: repo_off
    try:
        with TestClient(app, raise_server_exceptions=False) as c:
            r = c.get("/api/attachment/search?q=合同")
            assert r.status_code == 200
            data = r.json()["data"]
            assert data["mode"] == "smart"
            # flag off → 内核 unicode61 smart 路径；transformed = smart_query_transform('合同') != '合同' → 发。
            assert data["transformed_query"] == smart_query_transform("合同")
    finally:
        app.dependency_overrides.pop(get_repository, None)
