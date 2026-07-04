"""MailWriteService.resync 建新页后回写 notion_page_id 回归 (task 07-04)。

`resync --replace-existing` 建新页 + archive 老页后，若 DB 不更新 notion_page_id
会指向死页，后续 flag fanout 打死页。这里用真实 SyncStore + 假 notion_sync：
  - action=replaced 且有 new page_id → sync_store.notion_page_id 被更新，
    但 notion_thread_id / sync_status 不被动 (窄回写，非 mark_synced_v3)
  - action=skipped → 不回写
"""
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


from src.mail.sync_store import SyncStore
from src.notion._common import CreateEmailFromSqliteResult
from src.services.guards import Actor
from src.services.mail_write import MailWriteService


@dataclass
class _FakeMeta:
    notion_page_id: Optional[str]


class _FakeRepo:
    def __init__(self, meta):
        self._meta = meta

    def get_metadata(self, internal_id):
        return self._meta


class _FakeNotionSync:
    """create_email_page_from_sqlite 返回预设 result (async)。"""

    def __init__(self, result: CreateEmailFromSqliteResult):
        self._result = result
        self.calls = 0

    async def create_email_page_from_sqlite(self, internal_id, **kwargs):
        self.calls += 1
        return self._result


class _FakeCtx:
    """满足 ServiceDeps 结构 (resync 只读 email_repo / notion_sync / sync_store)。"""

    def __init__(self, email_repo, notion_sync, sync_store):
        self.email_repo = email_repo
        self.notion_sync = notion_sync
        self.sync_store = sync_store


def _seed_row(db_path: str, internal_id: int, page_id: str, thread_id: str, status: str):
    """直接 INSERT 一行带 notion_page_id / notion_thread_id / sync_status 的 metadata。"""
    conn = sqlite3.connect(db_path)
    now = time.time()
    conn.execute(
        """INSERT INTO email_metadata
           (internal_id, sync_status, mailbox, notion_page_id, notion_thread_id,
            created_at, updated_at)
           VALUES (?, ?, '收件箱', ?, ?, ?, ?)""",
        (internal_id, status, page_id, thread_id, now, now),
    )
    conn.commit()
    conn.close()


def _read_row(db_path: str, internal_id: int):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT notion_page_id, notion_thread_id, sync_status FROM email_metadata "
        "WHERE internal_id = ?",
        (internal_id,),
    ).fetchone()
    conn.close()
    return row


def _service(tmp_path: Path, result: CreateEmailFromSqliteResult, old_page_id="old-page"):
    db_path = str(tmp_path / "sync.db")
    store = SyncStore(db_path)
    _seed_row(db_path, 42, old_page_id, "thread-xyz", "synced")
    ctx = _FakeCtx(
        email_repo=_FakeRepo(_FakeMeta(notion_page_id=old_page_id)),
        notion_sync=_FakeNotionSync(result),
        sync_store=store,
    )
    return MailWriteService(ctx), db_path


def test_resync_replaced_writes_back_page_id_only(tmp_path):
    result = CreateEmailFromSqliteResult(
        page_id="new-page-999",
        action="replaced",
        existing_page_id="old-page",
        archived_page_id="old-page",
    )
    service, db_path = _service(tmp_path, result)

    out = service.resync(
        42,
        replace_existing=True,
        actor=Actor(kind="system", authenticated=True, label="test"),
        allow_concurrent=True,
    )

    assert out.new_page_id == "new-page-999"
    row = _read_row(db_path, 42)
    # notion_page_id 被回写
    assert row["notion_page_id"] == "new-page-999"
    # thread_id / sync_status 不被动 (窄回写，非 mark_synced_v3)
    assert row["notion_thread_id"] == "thread-xyz"
    assert row["sync_status"] == "synced"


def test_resync_skipped_does_not_write_back(tmp_path):
    result = CreateEmailFromSqliteResult(
        page_id="existing-page",
        action="skipped",
        existing_page_id="existing-page",
    )
    service, db_path = _service(tmp_path, result, old_page_id="old-page")

    service.resync(
        42,
        replace_existing=True,
        actor=Actor(kind="system", authenticated=True, label="test"),
        allow_concurrent=True,
    )

    row = _read_row(db_path, 42)
    # skipped 不回写，保持种子里的老 page_id
    assert row["notion_page_id"] == "old-page"
