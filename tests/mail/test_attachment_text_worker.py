"""附件文本抽取 worker 单测 (PR0).

覆盖:
- ``process_pending_extractions`` 状态转移 (extracted / unsupported / failed / skipped)
  —— CLI ``attachment extract --pending`` 与长驻 worker 共享的单一真源。
- 尊重 ``next_retry_at`` 指数退避 (未到期不取, 到期取)。
- ``tick_loop`` 跑一轮后 shutdown 干净退出。
- 配置 flag 默认值 (service.py 据此 gate 是否 spawn worker)。

async def 测试由 tests/mail/conftest.py 的 pytest_pyfunc_call hook 自动 asyncio.run 包裹。
"""

from __future__ import annotations

import asyncio
import sqlite3
import time
from pathlib import Path

import pytest

from src.config import Config
from src.mail.attachment_text_worker import (
    DEFAULT_LIMIT_PER_CYCLE,
    ExtractionBatchStats,
    process_pending_extractions,
    tick_loop,
)
from src.mail.sync_store import SyncStore
from src.repository import (
    AttachmentPayload,
    AttachmentStore,
    BodyPayload,
    EmailRepository,
)


@pytest.fixture
def fresh_db(tmp_path: Path) -> Path:
    db = tmp_path / "t.db"
    SyncStore(str(db))  # 建 v4 schema
    return db


@pytest.fixture
def store(tmp_path: Path) -> AttachmentStore:
    # 自定义 base_dir → local_path 落绝对路径, 抽取路径解析稳定 (与 CLI 一致)。
    return AttachmentStore(tmp_path / "attach")


@pytest.fixture
def repo(fresh_db: Path, store: AttachmentStore) -> EmailRepository:
    return EmailRepository(db_path=str(fresh_db), attachment_store=store)


def _insert_metadata(db: Path, internal_id: int) -> None:
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute(
        "INSERT INTO email_metadata (internal_id, sync_status, mailbox, created_at, updated_at) "
        "VALUES (?, 'pending', '收件箱', ?, ?)",
        (internal_id, time.time(), time.time()),
    )
    conn.commit()
    conn.close()


def _commit_with_attachment(
    repo: EmailRepository,
    db: Path,
    internal_id: int,
    filename: str,
    content: bytes,
    content_type: str = "text/plain",
) -> int:
    """commit 一封带单个非 inline 附件的邮件, 返回 attachment_id.

    ``commit_email_with_body`` 自动把非 inline 附件 enqueue 成 pending。
    """
    _insert_metadata(db, internal_id)
    id_map = repo.commit_email_with_body(
        internal_id,
        BodyPayload(html="", markdown="body text", body_format="html"),
        [AttachmentPayload(filename=filename, content=content, content_type=content_type)],
    )
    return id_map[filename]


class TestProcessPendingExtractions:
    def test_extracted_txt(self, repo: EmailRepository, fresh_db: Path):
        att_id = _commit_with_attachment(
            repo, fresh_db, 100, "notes.txt", b"hello redis timeout world"
        )
        # 登记侧确实 enqueue 了 pending
        assert repo.list_pending_attachment_extractions(limit=10) == [att_id]

        stats = process_pending_extractions(repo, limit=10)

        assert (
            stats.processed, stats.extracted, stats.unsupported,
            stats.failed, stats.skipped,
        ) == (1, 1, 0, 0, 0)
        rec = repo.get_attachment_text(att_id)
        assert rec is not None
        assert rec.status == "extracted"
        assert "redis timeout" in (rec.text_content or "")
        # 抽完不再 pending
        assert repo.list_pending_attachment_extractions(limit=10) == []

    def test_unsupported_ext(self, repo: EmailRepository, fresh_db: Path):
        att_id = _commit_with_attachment(
            repo, fresh_db, 101, "archive.bin", b"\x00\x01\x02binary",
            content_type="application/octet-stream",
        )

        stats = process_pending_extractions(repo, limit=10)

        assert (stats.processed, stats.unsupported, stats.extracted) == (1, 1, 0)
        rec = repo.get_attachment_text(att_id)
        assert rec is not None
        assert rec.status == "unsupported"

    def test_file_missing_marks_failure(self, repo: EmailRepository, fresh_db: Path):
        att_id = _commit_with_attachment(repo, fresh_db, 102, "gone.txt", b"temp")
        # 删盘上的真实文件 → 命中 "file missing" 分支 (skipped + mark_failure)
        conn = sqlite3.connect(str(fresh_db))
        conn.row_factory = sqlite3.Row
        local_path = conn.execute(
            "SELECT local_path FROM email_attachment WHERE id = ?", (att_id,)
        ).fetchone()["local_path"]
        conn.close()
        Path(local_path).unlink()

        stats = process_pending_extractions(repo, limit=10)

        assert (stats.processed, stats.skipped) == (0, 1)
        rec = repo.get_attachment_text(att_id)
        assert rec is not None
        assert rec.status == "failed"
        assert rec.retry_count == 1
        assert rec.next_retry_at is not None  # 退避已排期

    def test_dry_run_no_writes(self, repo: EmailRepository, fresh_db: Path):
        att_id = _commit_with_attachment(repo, fresh_db, 103, "notes.txt", b"content")

        stats = process_pending_extractions(repo, limit=10, dry_run=True)

        assert stats.processed == 1
        assert stats.extracted == 0
        # 仍 pending, 未落任何抽取结果
        rec = repo.get_attachment_text(att_id)
        assert rec is not None
        assert rec.status == "pending"
        assert repo.list_pending_attachment_extractions(limit=10) == [att_id]

    def test_empty_queue_noop(self, repo: EmailRepository):
        stats = process_pending_extractions(repo, limit=10)
        assert (stats.processed, stats.extracted, stats.skipped) == (0, 0, 0)


class TestRespectsNextRetryAt:
    def test_future_retry_not_picked(self, repo: EmailRepository, fresh_db: Path):
        att_id = _commit_with_attachment(repo, fresh_db, 200, "notes.txt", b"content")
        # 标失败 → next_retry_at = now + 60s (未来)
        repo.mark_attachment_text_failure(att_id, "boom")
        rec = repo.get_attachment_text(att_id)
        assert rec is not None and rec.next_retry_at > time.time()

        stats = process_pending_extractions(repo, limit=10)

        assert stats.processed == 0  # 未到期不取
        assert repo.get_attachment_text(att_id).status == "failed"

    def test_due_retry_picked(self, repo: EmailRepository, fresh_db: Path):
        att_id = _commit_with_attachment(repo, fresh_db, 201, "notes.txt", b"content")
        repo.mark_attachment_text_failure(att_id, "boom")
        # 把 next_retry_at 拨到过去 → 到期可取
        conn = sqlite3.connect(str(fresh_db))
        conn.execute(
            "UPDATE email_attachment_text SET next_retry_at = ? WHERE attachment_id = ?",
            (time.time() - 1, att_id),
        )
        conn.commit()
        conn.close()

        stats = process_pending_extractions(repo, limit=10)

        assert stats.processed == 1
        assert stats.extracted == 1
        assert repo.get_attachment_text(att_id).status == "extracted"


class TestTickLoop:
    async def test_processes_then_stops_on_shutdown(
        self, repo: EmailRepository, fresh_db: Path
    ):
        att_id = _commit_with_attachment(repo, fresh_db, 300, "notes.txt", b"tick content")
        shutdown = asyncio.Event()

        task = asyncio.create_task(
            tick_loop(
                repo=repo,
                shutdown_event=shutdown,
                limit_per_cycle=10,
                poll_interval_sec=0.05,
            )
        )
        # 等 worker 跑完至少一轮 (处理成 extracted)
        for _ in range(100):
            await asyncio.sleep(0.01)
            rec = repo.get_attachment_text(att_id)
            if rec is not None and rec.status == "extracted":
                break

        shutdown.set()
        await asyncio.wait_for(task, timeout=2.0)

        rec = repo.get_attachment_text(att_id)
        assert rec is not None
        assert rec.status == "extracted"

    async def test_stops_immediately_when_shutdown_preset(
        self, repo: EmailRepository, fresh_db: Path
    ):
        att_id = _commit_with_attachment(repo, fresh_db, 301, "notes.txt", b"content")
        shutdown = asyncio.Event()
        shutdown.set()  # 预置 → 首轮判据即退, 不处理

        await asyncio.wait_for(
            tick_loop(repo=repo, shutdown_event=shutdown, poll_interval_sec=0.05),
            timeout=2.0,
        )

        # 未处理: 仍 pending
        assert repo.get_attachment_text(att_id).status == "pending"


class TestConfigGate:
    """service.py 据 flag gate 是否 spawn worker; 这里 pin flag 默认值 + 类型。"""

    def test_worker_flag_defaults(self):
        f = Config.model_fields
        assert f["mailagent_attachment_text_worker_enabled"].default is True
        assert f["mailagent_attachment_text_worker_limit_per_cycle"].default == 25
        assert f["mailagent_attachment_text_worker_poll_interval_sec"].default == 60
        # 模块默认与 config 默认一致 (service.py 传 config 值, 默认应对齐)
        assert DEFAULT_LIMIT_PER_CYCLE == 25

    def test_batch_stats_shape(self):
        s = ExtractionBatchStats()
        assert (s.processed, s.extracted, s.unsupported, s.failed, s.skipped) == (0, 0, 0, 0, 0)
        assert s.any_work() is False
        s.processed = 1
        assert s.any_work() is True
