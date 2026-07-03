"""AdminService — E2-C 下沉的 dead-letter retry / cleanup 业务逻辑单测 (真实 SQLite)。

router 层入参解析 / ServiceError→APIError 映射见 tests/api/test_admin_write_cli.py 的
spy 测试; 这里直接构造真实 email_metadata 表断言 SQL 语义本身 (retry 重置字段 /
cleanup 按 cutoff 计数删除) —— 该逻辑是从 src/cli/commands/admin.py 复制下沉的新模块,
此前没有针对 AdminService 本体的覆盖。
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

import pytest

from src.cli.config import load_cli_config
from src.services.admin_service import AdminService
from src.services.context import ServiceContext
from src.services.errors import ServiceAuthError, ServiceInvalidArgError
from src.services.guards import Actor

AUTHED = Actor(kind="http", authenticated=True, label="test")
UNAUTHED = Actor(kind="http", authenticated=False, label="test")


def _make_db(db_path: Path) -> None:
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute(
            """CREATE TABLE email_metadata (
                internal_id INTEGER PRIMARY KEY,
                sync_status TEXT,
                retry_count INTEGER,
                next_retry_at REAL,
                sync_error TEXT,
                updated_at REAL
            )"""
        )
        now = time.time()
        rows = [
            # 40 天前的 dead_letter — 超过默认 30 天阈值, 应被计入/清理。
            (1, "dead_letter", 3, now - 60, "boom", now - 40 * 86400),
            # 5 天前的 dead_letter — 未过阈值, 不应被计入/清理。
            (2, "dead_letter", 1, now - 60, "boom", now - 5 * 86400),
            # 非 dead_letter 行 — 任何情况都不该被触碰。
            (3, "synced", 0, None, None, now),
        ]
        conn.executemany(
            "INSERT INTO email_metadata "
            "(internal_id, sync_status, retry_count, next_retry_at, sync_error, updated_at) "
            "VALUES (?,?,?,?,?,?)",
            rows,
        )
        conn.commit()
    finally:
        conn.close()


@pytest.fixture()
def db_path(tmp_path: Path) -> Path:
    p = tmp_path / "sync_store.db"
    _make_db(p)
    return p


@pytest.fixture()
def svc(db_path: Path) -> AdminService:
    cfg = load_cli_config(flag_overrides={"sync_store_db_path": str(db_path)})
    return AdminService(ServiceContext(cfg))


def _row_count(db_path: Path) -> int:
    conn = sqlite3.connect(str(db_path))
    try:
        return conn.execute("SELECT COUNT(*) FROM email_metadata").fetchone()[0]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# retry_dead_letter
# ---------------------------------------------------------------------------


def test_retry_dead_letter_resets_row(svc, db_path):
    result = svc.retry_dead_letter(1, actor=AUTHED)
    assert result == {"internal_id": 1, "old_status": "dead_letter", "new_status": "pending"}

    conn = sqlite3.connect(str(db_path))
    try:
        row = conn.execute(
            "SELECT sync_status, retry_count, next_retry_at, sync_error "
            "FROM email_metadata WHERE internal_id=1"
        ).fetchone()
    finally:
        conn.close()
    assert row == ("pending", 0, None, None)


def test_retry_dead_letter_unknown_id_raises_invalid_arg(svc):
    with pytest.raises(ServiceInvalidArgError):
        svc.retry_dead_letter(999, actor=AUTHED)


def test_retry_dead_letter_requires_authenticated_actor(svc):
    with pytest.raises(ServiceAuthError):
        svc.retry_dead_letter(1, actor=UNAUTHED)


# ---------------------------------------------------------------------------
# cleanup_dead_letter
# ---------------------------------------------------------------------------


def test_cleanup_dry_run_counts_without_deleting(svc, db_path):
    result = svc.cleanup_dead_letter(older_than=30, dry_run=True, actor=AUTHED)
    assert result["candidates"] == 1  # 仅 internal_id=1 (40 天前) 达标
    assert result["deleted"] == 0
    assert result["dry_run"] is True
    assert _row_count(db_path) == 3  # 无删除


def test_cleanup_real_delete_removes_only_stale_dead_letters(svc, db_path):
    result = svc.cleanup_dead_letter(older_than=30, dry_run=False, actor=AUTHED)
    assert result["candidates"] == 1
    assert result["deleted"] == 1

    conn = sqlite3.connect(str(db_path))
    try:
        remaining_ids = {
            r[0] for r in conn.execute("SELECT internal_id FROM email_metadata").fetchall()
        }
    finally:
        conn.close()
    assert remaining_ids == {2, 3}  # id=1 (过期 dead_letter) 已删; 近期 dead_letter + 非 dead_letter 保留


def test_cleanup_requires_authenticated_actor(svc):
    with pytest.raises(ServiceAuthError):
        svc.cleanup_dead_letter(actor=UNAUTHED)
