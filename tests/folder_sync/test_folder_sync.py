"""folder_sync 回归测试 — parse / repository / sync_ops.

固化 Phase A/B 的临时验证为正式 pytest. 不依赖真 IMAP (parse 喂 raw MIME bytes,
sync_ops 用 stub reader). reader 的 IMAP 操作 (list_folder/delete/move/send) 靠
e2e 验证 (需 davmail JVM), 不在单测范围.
"""
from __future__ import annotations

import json
import tempfile
from email.message import EmailMessage
from pathlib import Path
from types import SimpleNamespace

import pytest

from src.mail.sync_store import SyncStore
from src.folder_sync.repository import FolderEmailRepository
from src.folder_sync.imap_folder_reader import parse_message_to_folder_dict
from src.folder_sync.sync_ops import sync_folder_once


@pytest.fixture
def db_path() -> str:
    """临时 db, SyncStore 建表 (含 DB v17 folder_email 三表)."""
    p = Path(tempfile.mkdtemp()) / "sync.db"
    SyncStore(str(p))
    return str(p)


@pytest.fixture
def repo(db_path: str) -> FolderEmailRepository:
    return FolderEmailRepository(db_path)


# =============================================================================
# parse_message_to_folder_dict
# =============================================================================

class TestParseMessage:
    def _build(self, *, html: str = "<p>hello</p>", with_attach: bool = False) -> bytes:
        m = EmailMessage()
        m["From"] = "Alice Wang <alice@acme.com>"
        m["To"] = "bob@x.com, carol@y.com"
        m["Cc"] = "dave@z.com"
        m["Subject"] = "Q2 Budget Review"
        m["Message-ID"] = "<abc123@acme.com>"
        m["Date"] = "Mon, 26 May 2026 10:00:00 +0800"
        m["References"] = "<root@acme.com> <abc123@acme.com>"
        m.set_content("plain fallback")
        m.add_alternative(html, subtype="html")
        if with_attach:
            m.add_attachment(b"%PDF-x", maintype="application", subtype="pdf",
                             filename="report.pdf")
        return m.as_bytes()

    def test_basic_fields(self):
        d = parse_message_to_folder_dict(
            self._build(), folder="drafts", imap_uid=42,
            imap_uidvalidity=100, is_flagged=True,
        )
        assert d["folder"] == "drafts"
        assert d["imap_uid"] == 42
        assert d["imap_uidvalidity"] == 100
        assert d["subject"] == "Q2 Budget Review"
        assert d["sender"] == "alice@acme.com"
        assert d["sender_name"] == "Alice Wang"
        assert "bob@x.com" in d["to_addr"] and "carol@y.com" in d["to_addr"]
        assert d["cc_addr"] == "dave@z.com"
        assert d["message_id"] == "abc123@acme.com"
        assert d["thread_id"] == "root@acme.com"  # References 首个
        assert d["is_flagged"] == 1
        assert len(d["raw_mime_sha256"]) == 64

    def test_html_to_markdown_body(self):
        d = parse_message_to_folder_dict(
            self._build(html="<p>Hello <b>world</b> budget</p>"),
            folder="archive", imap_uid=1, imap_uidvalidity=1,
        )
        assert "budget" in d["body_markdown"]
        assert "**world**" in d["body_markdown"]  # markdownify 加粗
        assert d["snippet"]

    def test_attachments(self):
        d = parse_message_to_folder_dict(
            self._build(with_attach=True),
            folder="drafts", imap_uid=1, imap_uidvalidity=1,
        )
        assert d["has_attachments"] == 1
        atts = json.loads(d["attachments_json"])
        assert atts[0]["filename"] == "report.pdf"
        assert atts[0]["content_type"] == "application/pdf"

    def test_no_attachments(self):
        d = parse_message_to_folder_dict(
            self._build(with_attach=False),
            folder="drafts", imap_uid=1, imap_uidvalidity=1,
        )
        assert d["has_attachments"] == 0
        assert d["attachments_json"] is None


# =============================================================================
# FolderEmailRepository
# =============================================================================

def _row(folder: str, uid: int, *, subject="S", body="body text", flagged=0) -> dict:
    return {
        "folder": folder, "imap_uidvalidity": 100, "imap_uid": uid,
        "subject": subject, "sender": "a@b.com", "to_addr": "x@y.com",
        "date_received": f"2026-05-{uid:02d}T10:00:00+08:00",
        "body_markdown": body, "snippet": body[:50],
        "is_flagged": flagged, "has_attachments": 0,
    }


class TestRepository:
    def test_upsert_insert_then_update(self, repo: FolderEmailRepository):
        assert repo.upsert_emails([_row("drafts", 1), _row("drafts", 2)]) == {
            "inserted": 2, "updated": 0
        }
        assert repo.upsert_emails([{**_row("drafts", 1), "subject": "S2"}]) == {
            "inserted": 0, "updated": 1
        }
        rows = repo.list("drafts")
        assert [r.imap_uid for r in rows] == [2, 1]  # date DESC
        assert next(r for r in rows if r.imap_uid == 1).subject == "S2"

    def test_list_projection_excludes_body(self, repo: FolderEmailRepository):
        repo.upsert_emails([_row("drafts", 1)])
        assert repo.list("drafts")[0].body_markdown is None  # list 投影不含 body
        # get 含 body
        rows = repo.list("drafts")
        assert repo.get(rows[0].id).body_markdown == "body text"

    def test_fts_search(self, repo: FolderEmailRepository):
        repo.upsert_emails([
            _row("drafts", 1, body="quarterly budget plan"),
            _row("drafts", 2, body="team sync agenda"),
        ])
        assert [h.imap_uid for h in repo.search_fts("budget", folder="drafts")] == [1]
        assert [h.imap_uid for h in repo.search_fts("agenda", folder="drafts")] == [2]

    def test_soft_delete_and_revive(self, repo: FolderEmailRepository):
        repo.upsert_emails([_row("drafts", 1), _row("drafts", 2)])
        assert repo.get_active_uids("drafts") == {1, 2}
        repo.soft_delete_by_uids("drafts", [2])
        assert repo.get_active_uids("drafts") == {1}
        assert repo.search_fts("body", folder="drafts")  # uid1 still indexed
        # 软删除后不在 list
        assert [r.imap_uid for r in repo.list("drafts")] == [1]
        # upsert 复活
        repo.upsert_emails([_row("drafts", 2)])
        assert repo.get_active_uids("drafts") == {1, 2}

    def test_hard_delete_by_uid(self, repo: FolderEmailRepository):
        repo.upsert_emails([_row("drafts", 1)])
        assert repo.hard_delete_by_uid("drafts", 1) is True
        assert repo.count("drafts") == 0

    def test_folder_isolation(self, repo: FolderEmailRepository):
        repo.upsert_emails([_row("drafts", 1), _row("archive", 1)])
        # 同 uid 不同 folder 互不干扰 (UNIQUE 含 folder)
        assert repo.count("drafts") == 1 and repo.count("archive") == 1

    def test_invalid_folder_rejected(self, repo: FolderEmailRepository):
        with pytest.raises(ValueError):
            repo.upsert_emails([{**_row("drafts", 1), "folder": "inbox"}])

    def test_sync_state_partial_update(self, repo: FolderEmailRepository):
        repo.upsert_sync_state("drafts", imap_uidvalidity=100, last_uidnext=50)
        repo.upsert_sync_state("drafts", last_error="boom")
        st = repo.get_sync_state("drafts")
        assert st.last_uidnext == 50 and st.last_error == "boom"  # 部分更新不丢字段


# =============================================================================
# sync_folder_once (stub reader)
# =============================================================================

class _StubReader:
    def __init__(self, rows: list[dict]):
        self._rows = rows

    def list_folder(self, folder, *, since=None, limit=500) -> list[dict]:
        return [r for r in self._rows if r["folder"] == folder]


def _cfg() -> SimpleNamespace:
    return SimpleNamespace(archive_sync_past_days=365, archive_sync_max_messages=5000)


class TestSyncFolderOnce:
    def test_initial_sync(self, repo: FolderEmailRepository):
        reader = _StubReader([_row("drafts", 1), _row("drafts", 2)])
        stats = sync_folder_once("drafts", reader=reader, repo=repo, cfg=_cfg(), full=True)
        assert stats["inserted"] == 2
        assert stats["fetched"] == 2
        assert repo.count("drafts") == 2

    def test_reconcile_soft_deletes_missing(self, repo: FolderEmailRepository):
        # 先有 1,2,3
        repo.upsert_emails([_row("drafts", 1), _row("drafts", 2), _row("drafts", 3)])
        # IMAP 端只剩 1,2 (3 被外部删除) → full sync reconcile 软删 3
        reader = _StubReader([_row("drafts", 1), _row("drafts", 2)])
        stats = sync_folder_once("drafts", reader=reader, repo=repo, cfg=_cfg(), full=True)
        assert stats["soft_deleted"] == 1
        assert repo.get_active_uids("drafts") == {1, 2}

    def test_incremental_skips_reconcile(self, repo: FolderEmailRepository):
        repo.upsert_emails([_row("drafts", 1), _row("drafts", 2)])
        reader = _StubReader([_row("drafts", 1)])  # 只返回 1
        stats = sync_folder_once("drafts", reader=reader, repo=repo, cfg=_cfg(), full=False)
        # full=False → 不 reconcile, 2 不被软删
        assert stats["soft_deleted"] == 0
        assert repo.get_active_uids("drafts") == {1, 2}
