"""v55 字段级锁 × 扫描器 (task 08-13 WP2): display_name 自动刷新的判据改为
display_name **字段锁**; seed 前老库形态 (identity_locked_at 非空 + locks NULL)
走防御 fallback, 行为与 WP1 等价。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.contacts.repository import ContactRepository
from src.contacts.scanner import run_scan
from src.contacts.service import (
    parse_identity_locks,
    set_field_lock,
    update_identity_fields,
)
from src.mail.sync_store import SyncStore

SELF = frozenset({"me@corp.com"})


@pytest.fixture
def db(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    return str(path)


def _seed_email(db, internal_id, sender_name, when):
    # sender_email = v58 派生列 (生产由三条写入边界算)，扫描器读的就是它。
    with sqlite3.connect(db) as conn:
        conn.execute(
            "INSERT INTO email_metadata (internal_id, sender, sender_email, "
            "sender_name, to_addr, cc_addr, date_received, mailbox) "
            "VALUES (?, 'alice@x.com', 'alice@x.com', ?, 'me@corp.com', NULL, "
            "?, '收件箱')",
            (internal_id, sender_name, when),
        )
        conn.commit()


def _contact_row(db):
    with sqlite3.connect(db) as conn:
        conn.row_factory = sqlite3.Row
        return dict(conn.execute("SELECT * FROM contact").fetchone())


def test_display_name_field_lock_blocks_auto_refresh(db):
    _seed_email(db, 1, "Alice", "2026-08-01T08:00:00+00:00")
    run_scan(db, self_addresses=SELF)
    assert _contact_row(db)["display_name"] == "Alice"

    repo = ContactRepository(db)
    with repo.transaction() as conn:
        set_field_lock(conn, _contact_row(db)["id"], "display_name",
                       locked=True, now=999)

    _seed_email(db, 2, "Alice NEW", "2026-08-05T08:00:00+00:00")
    run_scan(db, self_addresses=SELF)
    row = _contact_row(db)
    assert row["display_name"] == "Alice"  # 锁着: 自动刷新绕开
    assert "Alice NEW" in (row["name_variants_json"] or "")  # 变体照常收集


def test_other_field_lock_does_not_block_name_refresh(db):
    _seed_email(db, 1, "Alice", "2026-08-01T08:00:00+00:00")
    run_scan(db, self_addresses=SELF)
    repo = ContactRepository(db)
    cid = _contact_row(db)["id"]
    with repo.transaction() as conn:
        update_identity_fields(conn, cid, {"organization": "ACME"}, now=999)

    _seed_email(db, 2, "Alice NEW", "2026-08-05T08:00:00+00:00")
    run_scan(db, self_addresses=SELF)
    row = _contact_row(db)
    # organization 锁 ≠ display_name 锁 (WP1 的整条锁会把这里挡死 —— 本测试钉住粒度)
    assert row["display_name"] == "Alice NEW"
    assert row["organization"] == "ACME"


def test_legacy_aggregate_lock_falls_back_when_locks_json_null(db):
    _seed_email(db, 1, "Alice", "2026-08-01T08:00:00+00:00")
    run_scan(db, self_addresses=SELF)
    with sqlite3.connect(db) as conn:
        conn.execute(
            "UPDATE contact SET identity_locked_at=5, identity_locks_json=NULL"
        )
        conn.commit()

    _seed_email(db, 2, "Alice NEW", "2026-08-05T08:00:00+00:00")
    run_scan(db, self_addresses=SELF)
    assert _contact_row(db)["display_name"] == "Alice"  # 未知旁路写 → 保守按锁


def test_parse_identity_locks_is_tolerant():
    assert parse_identity_locks(None) == {}
    assert parse_identity_locks("not json") == {}
    assert parse_identity_locks("[1,2]") == {}
    assert parse_identity_locks('{"display_name": 12, "bogus": 3}') == {
        "display_name": 12
    }
    assert parse_identity_locks('{"organization": "x"}') == {}
