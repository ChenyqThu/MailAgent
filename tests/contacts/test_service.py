"""通讯录治理写面 (task 08-13 WP1): 合并语义 / 曾用邮箱守卫双向 / self 解析 /
隐藏与 is_self。全部走 src/contacts/service.py 单源函数。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.contacts.repository import ContactRepository
from src.contacts.scanner import run_scan
from src.contacts.service import (
    ContactError,
    hide_contact,
    mark_email_former,
    merge_contacts,
    parse_self_emails,
    resolve_self_addresses,
    set_is_self,
    set_kind,
    set_primary_email,
    unmark_email_former,
    upsert_contact_for_email,
)
from src.mail.sync_store import SyncStore

SELF = frozenset({"me@corp.com"})
NOW_MS = 1_800_000_000_000


@pytest.fixture
def db(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    return str(path)


def _seed_emails(db, rows):
    with sqlite3.connect(db) as conn:
        for row in rows:
            conn.execute(
                "INSERT INTO email_metadata (internal_id, sender, sender_name, "
                "to_addr, cc_addr, date_received, mailbox) VALUES (?,?,?,?,?,?,?)",
                row,
            )
        conn.commit()


def _rows(db, sql, params=()):
    with sqlite3.connect(db) as conn:
        conn.row_factory = sqlite3.Row
        return [dict(r) for r in conn.execute(sql, params)]


def _contact_id(db, email):
    rows = _rows(
        db, "SELECT contact_id FROM contact_email WHERE email_normalized=?", (email,)
    )
    return rows[0]["contact_id"] if rows else None


# 换邮箱主场景: alice@old 历史多, alice@new 是新地址 (另一条记录)
MERGE_ROWS = (
    (1, "alice@old.com", "Alice", "me@corp.com", None,
     "2026-06-01T08:00:00+00:00", "收件箱"),
    (2, "alice@old.com", "Alice", "me@corp.com", None,
     "2026-06-02T08:00:00+00:00", "收件箱"),
    (3, "me@corp.com", "Me", "alice@old.com", None,
     "2026-06-03T08:00:00+00:00", "发件箱"),
    (4, "alice@new.com", "Alice Chen", "me@corp.com", None,
     "2026-08-10T08:00:00+00:00", "收件箱"),
)


@pytest.fixture
def merged_setup(db):
    """扫描建库 + 事项/上级引用指向被并方, 供合并断言。"""
    _seed_emails(db, MERGE_ROWS)
    run_scan(db, self_addresses=SELF, now_ms=NOW_MS)
    winner = _contact_id(db, "alice@old.com")
    loser = _contact_id(db, "alice@new.com")
    with sqlite3.connect(db) as conn:
        # stakeholder 引用被并方
        conn.execute(
            "INSERT INTO matter(id, public_id, title, created_at, updated_at) "
            "VALUES (1, 'MAT-0001', 'M', 1, 1)"
        )
        conn.execute(
            "INSERT INTO matter_stakeholder (matter_id, person_key, display_name, "
            "email_normalized, contact_id, created_at, updated_at) "
            "VALUES (1, 'pk-a', 'Alice Chen', 'alice@new.com', ?, 1, 1)",
            (loser,),
        )
        # 第三人上级指向被并方; winner 的上级也指向被并方 (合并后会自指 → 清 NULL)
        conn.execute(
            "INSERT INTO contact (id, display_name, manager_contact_id, "
            "created_at, updated_at) VALUES (900, 'Report', ?, 1, 1)",
            (loser,),
        )
        conn.execute(
            "UPDATE contact SET manager_contact_id=? WHERE id=?", (loser, winner)
        )
        conn.commit()
    return winner, loser


def test_merge_semantics(db, merged_setup):
    winner, loser = merged_setup
    links_before = _rows(
        db,
        "SELECT email_id, internal_id, role FROM contact_email_link "
        "ORDER BY email_id, internal_id, role",
    )

    repo = ContactRepository(db)
    with repo.transaction() as conn:
        merge_contacts(
            conn, winner, loser, now=NOW_MS,
            primary_email="alice@new.com", former_emails=("alice@old.com",),
            self_addresses=SELF,
        )

    # 账本零搬动: 行集 (email_id/internal_id/role) 逐行不变
    links_after = _rows(
        db,
        "SELECT email_id, internal_id, role FROM contact_email_link "
        "ORDER BY email_id, internal_id, role",
    )
    assert links_after == links_before

    # 锚点全部归 winner
    anchors = {
        r["email_normalized"]: r
        for r in _rows(db, "SELECT * FROM contact_email ORDER BY id")
    }
    assert anchors["alice@old.com"]["contact_id"] == winner
    assert anchors["alice@new.com"]["contact_id"] == winner
    # 主邮箱/曾用按入参 (预览页勾选) 落库: 新地址主 + 在用, 旧地址曾用
    assert anchors["alice@new.com"]["is_primary"] == 1
    assert anchors["alice@new.com"]["former_at"] is None
    assert anchors["alice@old.com"]["is_primary"] == 0
    assert anchors["alice@old.com"]["former_at"] == NOW_MS

    # loser 墓碑 (行保留)
    loser_row = _rows(db, "SELECT * FROM contact WHERE id=?", (loser,))[0]
    assert loser_row["merged_into"] == winner

    # stakeholder 与 manager 引用改指 winner; winner 自指清 NULL
    assert _rows(db, "SELECT contact_id FROM matter_stakeholder")[0]["contact_id"] == winner
    assert _rows(db, "SELECT manager_contact_id FROM contact WHERE id=900")[0][
        "manager_contact_id"] == winner
    winner_row = _rows(db, "SELECT * FROM contact WHERE id=?", (winner,))[0]
    assert winner_row["manager_contact_id"] is None

    # winner 聚合从账本重算: 两个锚点合计 4 封往来 (1/2/3 经旧址 + 4 经新址),
    # 出向 1 封 (email 3)
    assert winner_row["mail_count"] == 4
    assert winner_row["sent_to_count"] == 1


def test_merge_rejects_self_and_tombstone(db, merged_setup):
    winner, loser = merged_setup
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        with pytest.raises(ContactError) as e:
            merge_contacts(conn, winner, winner, now=NOW_MS, self_addresses=SELF)
        assert e.value.code == "E_MERGE_SELF"
        merge_contacts(conn, winner, loser, now=NOW_MS, self_addresses=SELF)
        # 已成墓碑的不能再当合并方
        with pytest.raises(ContactError) as e:
            merge_contacts(conn, winner, loser, now=NOW_MS, self_addresses=SELF)
        assert e.value.code == "E_CONTACT_MERGED"


def test_former_email_guard_both_directions(db):
    _seed_emails(db, MERGE_ROWS[:1])
    run_scan(db, self_addresses=SELF, now_ms=NOW_MS)
    contact_id = _contact_id(db, "alice@old.com")
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        # 加第二个锚点 (直接落库模拟多邮箱)
        conn.execute(
            "INSERT INTO contact_email (contact_id, email_normalized, is_primary, "
            "created_at) VALUES (?, 'alice@new.com', 0, ?)",
            (contact_id, NOW_MS),
        )
        # ① mark_former 对主邮箱直接拒绝
        with pytest.raises(ContactError) as e:
            mark_email_former(conn, contact_id, "alice@old.com", now=NOW_MS)
        assert e.value.code == "E_PRIMARY_EMAIL_CANNOT_BE_FORMER"
        # ② 非主邮箱可标曾用, 可逆
        mark_email_former(conn, contact_id, "alice@new.com", now=NOW_MS)
        unmark_email_former(conn, contact_id, "alice@new.com", now=NOW_MS)
        mark_email_former(conn, contact_id, "alice@new.com", now=NOW_MS)
        # ③ set_primary 顺带清空曾用 (恢复在用)
        set_primary_email(conn, contact_id, "alice@new.com", now=NOW_MS)
    anchors = {
        r["email_normalized"]: r
        for r in _rows(db, "SELECT * FROM contact_email")
    }
    assert anchors["alice@new.com"]["is_primary"] == 1
    assert anchors["alice@new.com"]["former_at"] is None
    assert anchors["alice@old.com"]["is_primary"] == 0
    # ④ 换主之后旧主可标曾用
    with repo.transaction() as conn:
        mark_email_former(conn, contact_id, "alice@old.com", now=NOW_MS)
    assert _rows(
        db, "SELECT former_at FROM contact_email WHERE email_normalized=?",
        ("alice@old.com",),
    )[0]["former_at"] == NOW_MS


def test_guard_rejects_unknown_anchor_and_bad_email(db):
    _seed_emails(db, MERGE_ROWS[:1])
    run_scan(db, self_addresses=SELF, now_ms=NOW_MS)
    contact_id = _contact_id(db, "alice@old.com")
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        with pytest.raises(ContactError) as e:
            mark_email_former(conn, contact_id, "stranger@q.com", now=NOW_MS)
        assert e.value.code == "E_CONTACT_EMAIL_NOT_FOUND"
        with pytest.raises(ContactError) as e:
            set_primary_email(conn, contact_id, "not-an-email", now=NOW_MS)
        assert e.value.code == "E_INVALID_EMAIL"


def test_parse_self_emails():
    assert parse_self_emails(None) == frozenset()
    assert parse_self_emails("") == frozenset()
    assert parse_self_emails(" A@X.com , b@y.com,, not-an-email , ") == frozenset(
        {"a@x.com", "b@y.com"}
    )


def test_resolve_self_addresses_includes_marked_contacts(db):
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        contact_id = upsert_contact_for_email(
            conn, email="old-me@x.com", now=NOW_MS, display_name="Old Me",
        )
        set_is_self(conn, contact_id, is_self=True, now=NOW_MS)
        resolved = resolve_self_addresses(
            conn, user_email="Me@Corp.com", extra_raw="alias@corp.com",
        )
    assert resolved == frozenset({"me@corp.com", "alias@corp.com", "old-me@x.com"})


def test_hide_and_kind_validation(db):
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        contact_id = upsert_contact_for_email(conn, email="p@x.com", now=NOW_MS)
        hide_contact(conn, contact_id, hidden=True, now=NOW_MS)
        row = conn.execute(
            "SELECT hidden_at FROM contact WHERE id=?", (contact_id,)
        ).fetchone()
        assert row["hidden_at"] == NOW_MS
        hide_contact(conn, contact_id, hidden=False, now=NOW_MS)
        row = conn.execute(
            "SELECT hidden_at FROM contact WHERE id=?", (contact_id,)
        ).fetchone()
        assert row["hidden_at"] is None
        with pytest.raises(ContactError) as e:
            set_kind(conn, contact_id, "alien", now=NOW_MS)
        assert e.value.code == "E_INVALID_KIND"


def test_upsert_semantics_match_v52(db):
    """非空最后写者赢 / None 不动 / fallback 只填新建行 (v52 红字继承)。"""
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        first = upsert_contact_for_email(
            conn, email="a@x.com", now=NOW_MS,
            display_name="Alice", organization="ACME",
        )
        # None 不动既有值; fallback 不进已存在分支 (不许悄悄改名)
        again = upsert_contact_for_email(
            conn, email="a@x.com", now=NOW_MS + 1,
            fallback_display_name="Hijack", fallback_organization="Evil",
        )
        assert again == first
        row = conn.execute("SELECT * FROM contact WHERE id=?", (first,)).fetchone()
        assert row["display_name"] == "Alice"
        assert row["organization"] == "ACME"
        # 显式非空 = 最后写者赢
        upsert_contact_for_email(
            conn, email="a@x.com", now=NOW_MS + 2, display_name="Alice Chen",
        )
        row = conn.execute("SELECT * FROM contact WHERE id=?", (first,)).fetchone()
        assert row["display_name"] == "Alice Chen"
        assert row["organization"] == "ACME"
        # fallback 在新建行生效 + 主邮箱锚点生成
        fresh = upsert_contact_for_email(
            conn, email="b@y.com", now=NOW_MS,
            fallback_display_name="Bob", fallback_organization=None,
        )
        row = conn.execute("SELECT * FROM contact WHERE id=?", (fresh,)).fetchone()
        assert row["display_name"] == "Bob"
        anchor = conn.execute(
            "SELECT * FROM contact_email WHERE email_normalized='b@y.com'"
        ).fetchone()
        assert anchor["contact_id"] == fresh
        assert anchor["is_primary"] == 1
