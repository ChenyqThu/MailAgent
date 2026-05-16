"""CLI 测试 fixtures - tmp SQLite + CliRunner + seeded email."""

from __future__ import annotations

import os
import sqlite3
import time
from pathlib import Path

import pytest


@pytest.fixture
def cli_runner():
    """typer.testing.CliRunner.

    NOTE: typer 0.13.1 + click 8.1.x 下 mix_stderr=False 时 result.stderr
    不会被正确分流 (click 跟踪问题); 用默认 mix_stderr=True 把所有输出聚合到
    result.output / result.stdout, 测试用 ``_capture_output`` 解析 JSON。
    """
    from typer.testing import CliRunner
    return CliRunner()


@pytest.fixture
def empty_db(tmp_path: Path) -> Path:
    """创建空 SQLite 含 v4 schema (触发 SyncStore _init_database)."""
    from src.mail.sync_store import SyncStore

    db = tmp_path / "sync_store.db"
    # 初始化 schema (含 email_metadata / email_body / email_attachment /
    # email_body_fts + db_version=5)
    SyncStore(str(db))
    return db


@pytest.fixture
def seeded_db(empty_db: Path) -> Path:
    """空 DB + 插一封邮件 metadata + body + attachment.

    internal_id=12345 / subject='Hello Test' / sender='alice@example.com' /
    body_markdown='# Hi\nbody text' / 1 attachment 'report.pdf'。
    """
    db = empty_db
    now = time.time()

    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        conn.execute(
            """INSERT INTO email_metadata
                 (internal_id, message_id, thread_id, subject, sender, sender_name,
                  to_addr, cc_addr, date_received, mailbox, is_read, is_flagged,
                  sync_status, notion_page_id, retry_count, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                12345,
                "<msg-12345@example.com>",
                "<thread-1@example.com>",
                "Hello Test",
                "alice@example.com",
                "Alice",
                "bob@example.com",
                "",
                "2026-05-15 10:00:00",
                "收件箱",
                1,                          # is_read
                0,                          # is_flagged
                "synced",
                "abc12345-0000-0000-0000-000000000001",
                0,
                now,
                now,
            ),
        )
        conn.execute(
            """INSERT INTO email_body
                 (internal_id, message_id, body_html, body_markdown,
                  body_format, body_size_bytes, has_inline_images,
                  raw_mime_sha256, fetched_at, fetched_source, schema_version)
               VALUES (?, ?, ?, ?, 'html', ?, 0, ?, ?, 'applescript', 1)""",
            (
                12345,
                "<msg-12345@example.com>",
                "<p>body html</p>",
                "# Hi\nbody markdown for fts search redis timeout",
                30,
                "deadbeef" * 8,
                now,
            ),
        )
        # FTS5 trigger email_body_fts_insert 在 INSERT ON email_body 后已自动写
        # rowid=12345 行 (从 email_metadata join 取 subject/sender);
        # 这里不再手动 INSERT 避免 PK 冲突。
        conn.execute(
            """INSERT INTO email_attachment
                 (internal_id, content_id, filename, content_type, size_bytes,
                  is_inline, local_path, sha256, derived_from, derived_format,
                  created_at, schema_version)
               VALUES (?, NULL, ?, ?, ?, 0, ?, ?, NULL, NULL, ?, 1)""",
            (
                12345,
                "report.pdf",
                "application/pdf",
                1024,
                "data/attachments/12345/report.pdf",
                "abcd" * 16,
                now,
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return db


@pytest.fixture
def cli_env(seeded_db: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict:
    """监护 env: SQLite 指向 seeded_db, 提供必填 NOTION/EMAIL/USER 变量, 拒鉴权 unsafe-flag.

    返回 dict 供测试自定义覆盖。
    """
    env = {
        "SYNC_STORE_DB_PATH": str(seeded_db),
        "ATTACHMENT_STORAGE_DIR": str(tmp_path / "attachments"),
        "NOTION_TOKEN": "test-token",
        "EMAIL_DATABASE_ID": "test-db",
        "USER_EMAIL": "test@example.com",
        "MAIL_ACCOUNT_NAME": "test",
        "MAILAGENT_CLI_API_KEY": "",
        "MAILAGENT_CLI_ALLOW_UNAUTH_WRITES": "",
    }
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    return env


@pytest.fixture
def empty_cli_env(empty_db: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """空 DB env (用于 not-found 测试)."""
    env = {
        "SYNC_STORE_DB_PATH": str(empty_db),
        "ATTACHMENT_STORAGE_DIR": str(tmp_path / "attachments"),
        "NOTION_TOKEN": "test-token",
        "EMAIL_DATABASE_ID": "test-db",
        "USER_EMAIL": "test@example.com",
        "MAIL_ACCOUNT_NAME": "test",
        "MAILAGENT_CLI_API_KEY": "",
        "MAILAGENT_CLI_ALLOW_UNAUTH_WRITES": "",
    }
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    return empty_db
