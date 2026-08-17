"""compose 收件人补全的通讯录 lane（`EmailRepository.suggest_contacts`）。

远程 web 的 `GET /api/email/contacts` 与桌面 Electron main 的 `email:contactSuggest`
是同一产品行为的两份实现 —— 本文件与 `frontend/tests/main/contact_suggest.test.ts`
覆盖同一批判据（改过名的人显示通讯录名字 / 中文名·formal_name·organization·曾用邮箱
可搜 / 零往来的人也能搜到 / 三类排除 / 主邮箱先于曾用 / 通讯录空或表不存在时
逐字节回到今天的行为）。
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

import pytest

from src.mail.sync_store import SyncStore
from src.repository.email_repository import (
    _CONTACT_MERGED_CACHE,
    _CONTACT_SUGGEST_CACHE,
    EmailRepository,
)


# ============================================================
# Fixtures
# ============================================================

_MAILS = [
    # (internal_id, sender, sender_name, to_addr, cc_addr, mailbox, date_received)
    (
        1,
        "Alice <alice@example.com>",
        "Alice A",
        "Me <me@example.com>",
        "",
        "收件箱",
        "2026-06-01T09:00:00+08:00",
    ),
    (
        2,
        "me@example.com",
        "Me",
        "Doe, Jane <jane@example.com>, Bob <bob@example.com>",
        "Project Team <team@example.com>",
        "发件箱",
        "2026-06-10T10:00:00+08:00",
    ),
    (
        3,
        "jane@example.com",
        "Jane Latest",
        "Me <me@example.com>",
        "",
        "收件箱",
        "2026-06-12T12:00:00+08:00",
    ),
    (
        4,
        "me@example.com",
        "Me",
        "Alice Old <alice@example.com>, Bob <bob@example.com>",
        "",
        "发件箱",
        "2026-06-11T08:00:00+08:00",
    ),
    (
        5,
        "me@example.com",
        "Me",
        "Adam <adam@example.com>",
        "",
        "发件箱",
        "2026-06-09T08:00:00+08:00",
    ),
]


def _seed_mail(db: Path) -> None:
    now = time.time()
    conn = sqlite3.connect(str(db))
    try:
        for row in _MAILS:
            internal_id, sender, sender_name, to_addr, cc_addr, mailbox, received = row
            conn.execute(
                """INSERT INTO email_metadata
                   (internal_id, message_id, subject, sender, sender_name, to_addr,
                    cc_addr, date_received, mailbox, is_read, is_flagged, sync_status,
                    retry_count, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    internal_id,
                    f"<mail-{internal_id}@example.com>",
                    f"subject {internal_id}",
                    sender,
                    sender_name,
                    to_addr,
                    cc_addr,
                    received,
                    mailbox,
                    1,
                    0,
                    "synced",
                    0,
                    now,
                    now,
                ),
            )
        conn.commit()
    finally:
        conn.close()


def _seed_contact(
    conn: sqlite3.Connection,
    *,
    display_name=None,
    formal_name=None,
    organization=None,
    name_variants=None,
    is_self=0,
    hidden_at=None,
    merged_into=None,
    emails=(),
) -> int:
    now = int(time.time() * 1000)
    cur = conn.execute(
        """INSERT INTO contact
           (display_name, formal_name, organization, name_variants_json, kind, is_self,
            hidden_at, merged_into, created_at, updated_at)
           VALUES (?,?,?,?,'person',?,?,?,?,?)""",
        (
            display_name,
            formal_name,
            organization,
            json.dumps(name_variants) if name_variants else None,
            is_self,
            hidden_at,
            merged_into,
            now,
            now,
        ),
    )
    contact_id = int(cur.lastrowid)
    for email, is_primary, former_at in emails:
        conn.execute(
            """INSERT INTO contact_email
               (contact_id, email_normalized, is_primary, former_at, created_at)
               VALUES (?,?,?,?,?)""",
            (contact_id, email, is_primary, former_at, now),
        )
    return contact_id


def _seed_directory(db: Path) -> None:
    """改过名 + 组织 + 曾用邮箱 + 零往来 + 三类排除各一条。"""
    conn = sqlite3.connect(str(db))
    try:
        _seed_contact(
            conn,
            display_name="张三",
            formal_name="Alice Zhang",
            organization="Acme Networks",
            name_variants=["Alice Old"],
            emails=[
                ("alice@example.com", 1, None),
                ("alice.legacy@example.com", 0, 1_700_000_000_000),
            ],
        )
        _seed_contact(
            conn,
            display_name="李四",
            formal_name="Lisi Li",
            organization="Acme Networks",
            emails=[("lisi@example.com", 1, None)],
        )
        _seed_contact(
            conn, display_name="Me", is_self=1, emails=[("me@example.com", 1, None)]
        )
        _seed_contact(
            conn,
            display_name="Project Team",
            hidden_at=1_700_000_000_000,
            emails=[("team@example.com", 1, None)],
        )
        _seed_contact(
            conn,
            display_name="Jane Ghost",
            merged_into=1,
            emails=[("jane.ghost@example.com", 0, None)],
        )
        conn.commit()
    finally:
        conn.close()


@pytest.fixture(autouse=True)
def _clear_contact_cache():
    _CONTACT_SUGGEST_CACHE.clear()
    _CONTACT_MERGED_CACHE.clear()
    yield
    _CONTACT_SUGGEST_CACHE.clear()
    _CONTACT_MERGED_CACHE.clear()


@pytest.fixture
def repo(tmp_path: Path) -> EmailRepository:
    """完整 schema（含通讯录三表），只灌邮件不灌通讯录。"""
    db = tmp_path / "sync_store.db"
    SyncStore(str(db))
    _seed_mail(db)
    return EmailRepository(db_path=str(db))


def _emails(repo: EmailRepository, q: str, **kw) -> list[str]:
    return [item.email for item in repo.suggest_contacts(q, **kw)]


# ============================================================
# 邮件头 lane（无通讯录行 = 今天的行为）
# ============================================================

class TestHistoryLaneUnchanged:
    def test_empty_directory_keeps_history_ranking(self, repo: EmailRepository):
        items = repo.suggest_contacts("", limit=3, exclude="me@example.com")
        assert items[0].email == "bob@example.com"
        assert items[0].score == 6

    def test_missing_directory_tables_do_not_raise(self, tmp_path: Path):
        """老库 / 精简 schema：contact 两表根本不存在 → 与有表但空表逐字节一致。"""
        bare = tmp_path / "bare.db"
        conn = sqlite3.connect(str(bare))
        conn.execute(
            """CREATE TABLE email_metadata (
                   internal_id INTEGER PRIMARY KEY, message_id TEXT, subject TEXT,
                   sender TEXT, sender_name TEXT, to_addr TEXT, cc_addr TEXT,
                   date_received TEXT, mailbox TEXT, is_read INTEGER, is_flagged INTEGER,
                   sync_status TEXT, retry_count INTEGER, created_at REAL, updated_at REAL)"""
        )
        conn.commit()
        conn.close()
        _seed_mail(bare)
        bare_repo = EmailRepository(db_path=str(bare))

        assert [
            (i.email, i.name, i.score)
            for i in bare_repo.suggest_contacts("", limit=10, exclude="me@example.com")
        ] == [
            (i.email, i.name, i.score)
            for i in EmailRepository(
                db_path=str(_full_schema_twin(tmp_path))
            ).suggest_contacts("", limit=10, exclude="me@example.com")
        ]


def _full_schema_twin(tmp_path: Path) -> Path:
    """同样的邮件，但库是完整 schema（通讯录三表存在且为空）。"""
    db = tmp_path / "twin.db"
    SyncStore(str(db))
    _seed_mail(db)
    return db


# ============================================================
# 通讯录 lane
# ============================================================

class TestDirectoryLane:
    def test_directory_display_name_wins(self, repo: EmailRepository, tmp_path: Path):
        _seed_directory(tmp_path / "sync_store.db")
        _CONTACT_SUGGEST_CACHE.clear()

        hit = repo.suggest_contacts("alice@", limit=5, exclude="me@example.com")[0]

        # 邮件头里最后一次见到的名字是 "Alice Old"，通讯录改成了「张三」。
        assert (hit.email, hit.name, hit.score) == ("alice@example.com", "张三", 4)

    def test_searchable_by_directory_fields(
        self, repo: EmailRepository, tmp_path: Path
    ):
        _seed_directory(tmp_path / "sync_store.db")
        _CONTACT_SUGGEST_CACHE.clear()

        assert "alice@example.com" in _emails(repo, "张", limit=10)
        assert "alice@example.com" in _emails(repo, "alice zhang", limit=10)
        acme = _emails(repo, "acme", limit=10)
        assert {"alice@example.com", "lisi@example.com"} <= set(acme)
        # 曾用邮箱按地址也能搜到，且带的是这个人的 display_name。
        former = repo.suggest_contacts("alice.legacy", limit=5)[0]
        assert (former.email, former.name) == ("alice.legacy@example.com", "张三")

    def test_directory_only_person_is_suggestible(
        self, repo: EmailRepository, tmp_path: Path
    ):
        _seed_directory(tmp_path / "sync_store.db")
        _CONTACT_SUGGEST_CACHE.clear()

        hit = repo.suggest_contacts("李四", limit=5)[0]

        assert (hit.email, hit.name, hit.score, hit.last_seen) == (
            "lisi@example.com",
            "李四",
            0,
            None,
        )

    def test_merged_hidden_self_never_enter_candidates(
        self, repo: EmailRepository, tmp_path: Path
    ):
        _seed_directory(tmp_path / "sync_store.db")
        _CONTACT_SUGGEST_CACHE.clear()

        # 合并墓碑（通讯录侧条目）不出现。
        assert _emails(repo, "jane.ghost", limit=20) == []
        # 隐藏 / 自己：连**邮件头聚合出来的同一地址**也一并压掉（不传 exclude 也不出现）。
        assert _emails(repo, "team", limit=20) == []
        assert _emails(repo, "me@", limit=20) == []

    def test_primary_sorts_before_former(self, repo: EmailRepository, tmp_path: Path):
        _seed_directory(tmp_path / "sync_store.db")
        _CONTACT_SUGGEST_CACHE.clear()

        hits = repo.suggest_contacts("张三", limit=10)

        assert [(h.email, h.name) for h in hits] == [
            ("alice@example.com", "张三"),
            ("alice.legacy@example.com", "张三"),
        ]

    def test_frequent_contact_still_outranks_zero_traffic_directory_hit(
        self, repo: EmailRepository, tmp_path: Path
    ):
        _seed_directory(tmp_path / "sync_store.db")
        _CONTACT_SUGGEST_CACHE.clear()

        emails = _emails(repo, "a", limit=10, exclude="me@example.com")

        assert emails.index("alice@example.com") < emails.index("lisi@example.com")
        assert emails.index("adam@example.com") < emails.index("lisi@example.com")
        assert "lisi@example.com" in emails

    def test_history_cache_clear_also_invalidates_the_merged_lane(
        self, repo: EmailRepository, tmp_path: Path
    ):
        """两份缓存不会各自过期到互相矛盾（合流缓存挂历史列表身份）。"""
        assert repo.suggest_contacts("alice@", limit=5)[0].name == "Alice Old"

        _seed_directory(tmp_path / "sync_store.db")
        _CONTACT_SUGGEST_CACHE.clear()  # 老测试只清这一份

        assert repo.suggest_contacts("alice@", limit=5)[0].name == "张三"

    def test_exclude_still_applies_to_directory_entries(
        self, repo: EmailRepository, tmp_path: Path
    ):
        _seed_directory(tmp_path / "sync_store.db")
        _CONTACT_SUGGEST_CACHE.clear()

        assert _emails(repo, "李四", limit=5, exclude="lisi@example.com") == []
