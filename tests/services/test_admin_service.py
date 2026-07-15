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


# ---------------------------------------------------------------------------
# delete_dead_letter (需求 3) — full v4 schema so CASCADE (body/attachment/
# outbox) is real. 铁律断言: 只删 dead_letter 行, 真身 synced 零误伤。
# ---------------------------------------------------------------------------


@pytest.fixture()
def full_schema_svc(tmp_path: Path):
    """SyncStore-initialised v4 DB (含 email_body / email_attachment / email_outbox
    的 ON DELETE CASCADE 外键) + AdminService。返回 (svc, db_path)。"""
    from src.mail.sync_store import SyncStore

    db = tmp_path / "sync_store.db"
    SyncStore(str(db))  # 建全套 v4 schema

    now = time.time()
    conn = sqlite3.connect(str(db))
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        # id=1: 幽灵行 dead_letter — 带 body + attachment + outbox 子行
        # id=2: 真身 synced (有 Notion 页) — 任何情况都不该被触碰
        conn.execute(
            "INSERT INTO email_metadata "
            "(internal_id, message_id, subject, sender, mailbox, sync_status, "
            " retry_count, created_at, updated_at) "
            "VALUES (1, '<ghost@localhost>', 'ghost', '', '收件箱', 'dead_letter', 9, ?, ?)",
            (now, now),
        )
        conn.execute(
            "INSERT INTO email_metadata "
            "(internal_id, message_id, subject, sender, mailbox, sync_status, "
            " retry_count, notion_page_id, created_at, updated_at) "
            "VALUES (2, '<real@x.com>', 'real', 'real@x.com', '收件箱', 'synced', "
            " 0, 'page-real', ?, ?)",
            (now, now),
        )
        conn.execute(
            "INSERT INTO email_body "
            "(internal_id, body_markdown, fetched_at, fetched_source) "
            "VALUES (1, 'ghost body', ?, 'test')",
            (now,),
        )
        conn.execute(
            "INSERT INTO email_attachment "
            "(internal_id, filename, created_at) VALUES (1, 'img.png', ?)",
            (now,),
        )
        conn.execute(
            "INSERT INTO email_outbox "
            "(internal_id, op_type, target, payload_json, status, created_at, updated_at) "
            "VALUES (1, 'flag', 'notion', '{}', 'pending', ?, ?)",
            (now, now),
        )
        conn.commit()
    finally:
        conn.close()

    cfg = load_cli_config(flag_overrides={"sync_store_db_path": str(db)})
    return AdminService(ServiceContext(cfg)), db


def _count(db_path: Path, table: str, internal_id: int) -> int:
    conn = sqlite3.connect(str(db_path))
    try:
        return conn.execute(
            f"SELECT COUNT(*) FROM {table} WHERE internal_id=?", (internal_id,)
        ).fetchone()[0]
    finally:
        conn.close()


def test_delete_dead_letter_cascades_body_attachment_outbox(full_schema_svc):
    svc, db_path = full_schema_svc
    # 前置: 子行都在
    assert _count(db_path, "email_body", 1) == 1
    assert _count(db_path, "email_attachment", 1) == 1
    assert _count(db_path, "email_outbox", 1) == 1

    result = svc.delete_dead_letter(1, actor=AUTHED)
    assert result == {"internal_id": 1, "old_status": "dead_letter", "deleted": True}

    # CASCADE 清空 metadata + body + attachment + outbox
    assert _count(db_path, "email_metadata", 1) == 0
    assert _count(db_path, "email_body", 1) == 0
    assert _count(db_path, "email_attachment", 1) == 0
    assert _count(db_path, "email_outbox", 1) == 0


def test_delete_dead_letter_leaves_synced_real_email_untouched(full_schema_svc):
    """铁律: 真身 (synced, 有 Notion 页) 零误伤。"""
    svc, db_path = full_schema_svc
    svc.delete_dead_letter(1, actor=AUTHED)
    assert _count(db_path, "email_metadata", 2) == 1

    conn = sqlite3.connect(str(db_path))
    try:
        row = conn.execute(
            "SELECT sync_status, notion_page_id FROM email_metadata WHERE internal_id=2"
        ).fetchone()
    finally:
        conn.close()
    assert row == ("synced", "page-real")


def test_delete_dead_letter_refuses_non_dead_letter_row(full_schema_svc):
    """铁律: 非 dead_letter 行 (真身 synced) 拒删, 不误伤。"""
    svc, db_path = full_schema_svc
    with pytest.raises(ServiceInvalidArgError):
        svc.delete_dead_letter(2, actor=AUTHED)
    # 拒删后行仍在
    assert _count(db_path, "email_metadata", 2) == 1


def test_delete_dead_letter_unknown_id_raises_invalid_arg(full_schema_svc):
    svc, _ = full_schema_svc
    with pytest.raises(ServiceInvalidArgError):
        svc.delete_dead_letter(999, actor=AUTHED)


def test_delete_dead_letter_requires_authenticated_actor(full_schema_svc):
    svc, db_path = full_schema_svc
    with pytest.raises(ServiceAuthError):
        svc.delete_dead_letter(1, actor=UNAUTHED)
    # 鉴权失败时不得删除
    assert _count(db_path, "email_metadata", 1) == 1


def test_delete_dead_letter_refuses_after_concurrent_status_change(full_schema_svc):
    """TOCTOU: 预检 SELECT 通过后, 窗口内行被并发 retry 成 pending → 带谓词的删除
    rowcount==0 → 拒删, 刚复活的真邮件 + 其下游子行零误伤。"""
    svc, db_path = full_schema_svc

    # 触发 email_repo 懒创建并缓存, 再打桩其删除方法模拟「预检与删除之间」的并发改态。
    real_delete = svc._ctx.email_repo.delete_email_full_if_status

    def _flip_then_delete(internal_id: int, expected_status: str) -> bool:
        # 模拟并发窗口: 预检已通过, 此刻另一 admin 面把行 retry 成 pending。
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute(
                "UPDATE email_metadata SET sync_status='pending' WHERE internal_id=?",
                (internal_id,),
            )
            conn.commit()
        finally:
            conn.close()
        return real_delete(internal_id, expected_status)

    svc._ctx.email_repo.delete_email_full_if_status = _flip_then_delete

    with pytest.raises(ServiceInvalidArgError):
        svc.delete_dead_letter(1, actor=AUTHED)

    # 复活的行 + 其下游子行全部保留 (谓词删除挡住 = 未误删)
    assert _count(db_path, "email_metadata", 1) == 1
    assert _count(db_path, "email_body", 1) == 1
    assert _count(db_path, "email_attachment", 1) == 1
    assert _count(db_path, "email_outbox", 1) == 1
