"""MCP 测试 fixtures —— 在临时 DB 上构造 SkillContext（in-process，无需起服务）。

email 用 trimmed DDL（与 tests/api/conftest 同款，够 search/get）；report 用真 SyncStore
（建 report_agent / report 表）。
"""

from __future__ import annotations

import os
import sqlite3
import time
from pathlib import Path
from typing import Any

import pytest

# src.api.* 在别处 import 时读 env（保持与 tests/api 一致，避免 RuntimeError）。
os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
os.environ.setdefault("MAILAGENT_API_DEV", "true")
os.environ.setdefault("MAILAGENT_API_HOST", "127.0.0.1")

_EMAIL_DDL = """
CREATE TABLE email_metadata (
    internal_id INTEGER PRIMARY KEY, message_id TEXT UNIQUE, thread_id TEXT,
    subject TEXT, sender TEXT, sender_name TEXT, to_addr TEXT, cc_addr TEXT,
    date_received TEXT, mailbox TEXT, is_read INTEGER DEFAULT 0,
    is_flagged INTEGER DEFAULT 0, sync_status TEXT DEFAULT 'pending',
    notion_page_id TEXT, notion_thread_id TEXT, sync_error TEXT,
    retry_count INTEGER DEFAULT 0, next_retry_at REAL, created_at REAL,
    updated_at REAL, is_pinned INTEGER DEFAULT 0, pinned_at REAL,
    is_important INTEGER DEFAULT 0
);
CREATE TABLE email_body (
    internal_id INTEGER PRIMARY KEY, message_id TEXT, body_html TEXT,
    body_markdown TEXT, body_format TEXT, body_size_bytes INTEGER,
    has_inline_images INTEGER DEFAULT 0, raw_mime_sha256 TEXT,
    fetched_at REAL NOT NULL, fetched_source TEXT NOT NULL
);
CREATE VIRTUAL TABLE email_body_fts USING fts5(
    body_markdown, subject, sender,
    tokenize='porter unicode61 remove_diacritics 2'
);
"""


@pytest.fixture()
def mcp_ctx(tmp_path: Path) -> Any:
    """SkillContext(email trimmed DB + report SyncStore DB)。"""
    now = time.time()
    edb = tmp_path / "email.db"
    conn = sqlite3.connect(str(edb))
    try:
        conn.executescript(_EMAIL_DDL)
        conn.execute(
            "INSERT INTO email_metadata (internal_id, message_id, subject, sender, "
            "sender_name, to_addr, cc_addr, date_received, mailbox, is_read, is_flagged, "
            "sync_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (1001, "<m@x>", "Quarterly redis timeout review", "alice@x.com", "Alice",
             "bob@x.com", "", "2026-05-01 09:00:00", "收件箱", 0, 1, "synced", now, now),
        )
        conn.execute(
            "INSERT INTO email_body (internal_id, message_id, body_html, body_markdown, "
            "body_format, body_size_bytes, has_inline_images, raw_mime_sha256, fetched_at, "
            "fetched_source) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (1001, "<m@x>", "<p>redis</p>", "redis timeout body", "html", 18, 0, "a" * 64,
             now, "davmail"),
        )
        conn.execute(
            "INSERT INTO email_body_fts (rowid, body_markdown, subject, sender) VALUES (?,?,?,?)",
            (1001, "redis timeout body", "Quarterly redis timeout review", "alice@x.com"),
        )
        conn.commit()
    finally:
        conn.close()

    rdb = tmp_path / "rep.db"
    from src.mail.sync_store import SyncStore
    from src.reports.store import ReportStore

    SyncStore(str(rdb))
    rs = ReportStore(db_path=str(rdb))
    rs.create_agent("daily", type="report", enabled=True, title="Daily")
    rs.create_report(
        report_id="rep-1", agent_id="daily", cadence="daily", report_date="2026-06-01",
        window_start="2026-06-01T00:00:00Z", window_end="2026-06-02T00:00:00Z",
    )
    rs.finish_report(
        "rep-1", status="ready", headline="3 today", blocks_json='{"blocks": []}',
        counts_json='{"total": 3}',
    )

    from src.repository import EmailRepository
    from src.skills.context import SkillContext

    class _Cfg:
        sync_store_db_path = str(rdb)
        calendar_caldav_sync_enabled = False

    return SkillContext(
        repository=EmailRepository(db_path=str(edb)), report_store=rs, config=_Cfg()
    )
