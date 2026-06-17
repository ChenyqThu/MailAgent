from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any

import pytest

from src.repository import EmailRepository


FIXTURE_PATH = Path(__file__).resolve().parents[1] / "fixtures" / "search_query_behavior.json"
FIXTURE = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


DDL = """
CREATE TABLE email_metadata (
    internal_id INTEGER PRIMARY KEY,
    subject TEXT,
    sender TEXT,
    sender_name TEXT,
    to_addr TEXT,
    cc_addr TEXT,
    date_received TEXT,
    mailbox TEXT,
    is_read INTEGER DEFAULT 0,
    is_flagged INTEGER DEFAULT 0,
    is_pinned INTEGER DEFAULT 0,
    is_important INTEGER DEFAULT 0,
    ai_priority TEXT,
    notion_page_id TEXT,
    created_at REAL,
    updated_at REAL
);

CREATE VIRTUAL TABLE email_body_fts USING fts5(
    body_markdown,
    subject,
    sender,
    tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TABLE email_attachment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    internal_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    is_inline INTEGER DEFAULT 0,
    created_at REAL NOT NULL
);

CREATE TABLE email_attachment_text (
    attachment_id INTEGER PRIMARY KEY,
    text_content TEXT,
    text_size_bytes INTEGER NOT NULL DEFAULT 0,
    extractor TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

CREATE VIRTUAL TABLE email_attachment_fts USING fts5(
    text_content,
    tokenize='porter unicode61 remove_diacritics 2'
);
"""


@pytest.fixture
def behavior_db(tmp_path: Path) -> Path:
    db = tmp_path / "search_query_behavior.db"
    conn = sqlite3.connect(str(db))
    now = time.time()
    try:
        conn.executescript(DDL)
        for email in FIXTURE["emails"]:
            conn.execute(
                """INSERT INTO email_metadata
                   (internal_id, subject, sender, sender_name, to_addr, cc_addr,
                    date_received, mailbox, is_read, is_flagged, is_pinned,
                    is_important, ai_priority, notion_page_id, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    email["internal_id"],
                    email["subject"],
                    email["sender"],
                    email["sender_name"],
                    email["to_addr"],
                    email["cc_addr"],
                    email["date_received"],
                    email["mailbox"],
                    email["is_read"],
                    email["is_flagged"],
                    email["is_pinned"],
                    email["is_important"],
                    email["ai_priority"],
                    None,
                    now,
                    now,
                ),
            )
            conn.execute(
                """INSERT INTO email_body_fts (rowid, body_markdown, subject, sender)
                   VALUES (?, ?, ?, ?)""",
                (
                    email["internal_id"],
                    email["body_markdown"],
                    email["subject"],
                    email["sender"],
                ),
            )
            for attachment in email.get("attachments", []):
                cur = conn.execute(
                    """INSERT INTO email_attachment
                       (internal_id, filename, is_inline, created_at)
                       VALUES (?, ?, ?, ?)""",
                    (
                        email["internal_id"],
                        attachment["filename"],
                        attachment["is_inline"],
                        now,
                    ),
                )
                text_content = attachment.get("text_content")
                if text_content:
                    attachment_id = cur.lastrowid
                    conn.execute(
                        """INSERT INTO email_attachment_text
                           (attachment_id, text_content, text_size_bytes, extractor,
                            status, created_at, updated_at)
                           VALUES (?, ?, ?, 'fixture', 'extracted', ?, ?)""",
                        (
                            attachment_id,
                            text_content,
                            len(text_content.encode("utf-8")),
                            now,
                            now,
                        ),
                    )
                    conn.execute(
                        """INSERT INTO email_attachment_fts (rowid, text_content)
                           VALUES (?, ?)""",
                        (attachment_id, text_content),
                    )
        conn.commit()
    finally:
        conn.close()
    return db


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda case: case["name"])
def test_search_query_behavior_fixture(case: dict[str, Any], behavior_db: Path):
    repo = EmailRepository(db_path=str(behavior_db))
    params = case.get("params", {})

    result = repo.search_email_bodies_with_meta(
        case["query"],
        mode=case.get("mode", "smart"),
        limit=case.get("limit", 50),
        mailbox=params.get("mailbox"),
        since_date=params.get("since_date"),
        until_date=params.get("until_date"),
        now=FIXTURE["now"],
        tz_offset_minutes=FIXTURE["tz_offset_minutes"],
    )

    ids = [hit.internal_id for hit in result.hits]
    if case.get("order", "set") == "exact":
        assert ids == case["expect_ids"]
    else:
        assert set(ids) == set(case["expect_ids"])

    assert len(result.parse_warnings) == case["expect_warnings"]
    if "expect_transformed_query" in case:
        assert result.transformed_query == case["expect_transformed_query"]
    if "expect_hits" in case:
        actual_hits = [
            {
                "internal_id": hit.internal_id,
                "source": hit.source,
                "filename": hit.filename,
            }
            for hit in result.hits
        ]
        assert actual_hits[: len(case["expect_hits"])] == case["expect_hits"]
