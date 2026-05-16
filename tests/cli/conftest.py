"""CLI 测试 fixtures - tmp SQLite + CliRunner + seeded email."""

from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path
from typing import Any

import pytest


def extract_last_json_object(text: str) -> dict[str, Any]:
    """从混合 stdout/stderr 中抓最后一个 JSON object (含 success / error wrapper).

    CliRunner mix_stderr=True 下 emit_error 的 stderr JSON 会和 stdout 合并,
    可能前后夹杂 loguru log 或 typer renderer 输出。所有 CLI 测试 (test_email /
    test_admin / test_schema_contract) 共用这一份提取逻辑。
    """
    if not text:
        raise ValueError("empty output")
    for line in reversed(text.strip().splitlines()):
        line = line.strip()
        if not line.startswith("{") or not line.endswith("}"):
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    raise AssertionError(f"no JSON object in output: {text[:300]!r}")


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
        # 另插一封 failed 状态邮件 (PR-2 critic fix #1 测试 --status filter)
        conn.execute(
            """INSERT INTO email_metadata
                 (internal_id, message_id, thread_id, subject, sender, sender_name,
                  to_addr, cc_addr, date_received, mailbox, is_read, is_flagged,
                  sync_status, notion_page_id, retry_count, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                12346,
                "<msg-12346@example.com>",
                None,
                "Failed sync email",
                "bob@example.com",
                "Bob",
                "alice@example.com",
                "",
                "2026-05-14 09:00:00",
                "收件箱",
                0,
                0,
                "failed",
                None,
                3,
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
def seeded_db_with_real_attachment(
    seeded_db: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> tuple[Path, Path, int]:
    """seeded_db + 把 internal_id=12345 的 attachment local_path 改成 tmp 真实文件.

    Returns ``(db_path, attachment_dir, attachment_id)``.

    需要这条 fixture 是因为 attachment download / cleanup-orphans 真要读写盘,
    seeded_db 默认的 local_path='data/attachments/12345/report.pdf' 不存在。
    """
    attachment_dir = tmp_path / "attachments"
    (attachment_dir / "12345").mkdir(parents=True, exist_ok=True)
    payload = b"PDF-FAKE-CONTENT-FOR-TESTS"
    target = attachment_dir / "12345" / "report.pdf"
    target.write_bytes(payload)

    # 改 local_path 指向 tmp 真实文件 (用绝对路径; AttachmentStore.read 看到
    # 绝对路径会直接 p.read_bytes(), 与相对路径走 base_dir.parent.parent 的
    # 解析逻辑解耦, 测试更稳定)
    new_local_path = str(target)
    conn = sqlite3.connect(str(seeded_db))
    try:
        cur = conn.execute(
            "SELECT id FROM email_attachment WHERE internal_id = ? LIMIT 1",
            (12345,),
        ).fetchone()
        att_id = int(cur[0])
        conn.execute(
            "UPDATE email_attachment SET local_path = ?, size_bytes = ? WHERE id = ?",
            (new_local_path, len(payload), att_id),
        )
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setenv("ATTACHMENT_STORAGE_DIR", str(attachment_dir))
    return seeded_db, attachment_dir, att_id


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
