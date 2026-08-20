"""L0+L1 扫描器 (task 08-13 WP1): 幂等 / 排除集 / display_name 刷新与锁 /
kind 启发式 / watermark / 增量聚合与账本重算一致。

🔴 fixture 列名/值形状对齐 `email_metadata` 真实产出 (仓内教训): `sender` **不保证
裸地址** (活库 68% 是整个 From 头 ``Name <addr>``, 见 task 08-14 WP-5)、扫描器读的
是 v58 派生列 `sender_email` (由 `_seed_emails` 用生产同一个 derive_sender_email 算)、
`sender_name` 显示名、`to_addr`/`cc_addr` 逗号分隔 ``Name <email>``、
`date_received` ISO TEXT、`mailbox` 中文 canonical。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.contacts.repository import ContactRepository
from src.contacts.scanner import (
    WATERMARK_KEY,
    kind_for_address,
    run_scan,
)
from src.contacts.service import (
    recalc_all_aggregates,
    set_kind,
)
from src.mail.email_address import derive_sender_email
from src.mail.sync_store import SyncStore

SELF = frozenset({"me@corp.com"})
NOW_MS = 1_800_000_000_000


@pytest.fixture
def db(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    return str(path)


def _seed_emails(db, rows):
    """裸 SQL 插行 —— 顺带把 v58 派生列 `sender_email` 算出来, 因为生产的三条写入
    边界都会算 (src/mail/sync_store.py, 派生器 derive_sender_email)。扫描器读的是
    这个列, 不写 = fixture 与生产形状不符。"""
    with sqlite3.connect(db) as conn:
        for row in rows:
            conn.execute(
                "INSERT INTO email_metadata (internal_id, sender, sender_email, "
                "sender_name, to_addr, cc_addr, date_received, mailbox) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (row[0], row[1], derive_sender_email(row[1]), *row[2:]),
            )
        conn.commit()


def _rows(db, sql):
    with sqlite3.connect(db) as conn:
        conn.row_factory = sqlite3.Row
        return [dict(r) for r in conn.execute(sql)]


def _contact_by_email(db, email):
    rows = _rows(
        db,
        "SELECT c.*, ce.id AS anchor_id, ce.mail_count AS anchor_mail_count, "
        "ce.first_seen_at AS anchor_first, ce.last_seen_at AS anchor_last "
        "FROM contact c JOIN contact_email ce ON ce.contact_id = c.id "
        f"WHERE ce.email_normalized = '{email}'",
    )
    return rows[0] if rows else None


BASIC_ROWS = (
    # 入向: alice → me (cc carol); bob 后来也来一封
    (1, "alice@x.com", "Alice Old", "Me <me@corp.com>", "Carol <carol@z.com>",
     "2026-08-01T08:00:00+00:00", "收件箱"),
    (2, "alice@x.com", "Alice New", "me@corp.com", None,
     "2026-08-10T08:00:00+00:00", "收件箱"),
    # 出向: me → bob (cc alice)
    (3, "me@corp.com", "Me", "Bob <bob@y.com>", "alice@x.com",
     "2026-08-11T08:00:00+00:00", "发件箱"),
    # 草稿: 未发出, 收件人不算往来
    (4, "me@corp.com", "Me", "Dave <dave@w.com>", None,
     "2026-08-12T08:00:00+00:00", "草稿箱"),
    # 非法地址不产出
    (5, "not-an-email", "Broken", None, None,
     "2026-08-12T09:00:00+00:00", "收件箱"),
)


def test_scan_extracts_contacts_ledger_and_aggregates(db):
    _seed_emails(db, BASIC_ROWS)
    stats = run_scan(db, self_addresses=SELF, now_ms=NOW_MS)
    assert stats["drained"] is True
    assert stats["processed"] == 5
    assert stats["skipped_draft"] == 1

    alice = _contact_by_email(db, "alice@x.com")
    bob = _contact_by_email(db, "bob@y.com")
    carol = _contact_by_email(db, "carol@z.com")
    # 草稿收件人不建行
    assert _contact_by_email(db, "dave@w.com") is None
    # 🔴 task 08-14 WP-3: 自有地址**照常**建档记账 (此前 scanner 直接 continue,
    # owner 换邮箱后新地址一封关联都没有)。
    me = _contact_by_email(db, "me@corp.com")
    assert me is not None
    assert me["mail_count"] == 3  # 1/2 收到 (to) + 3 自己发的 (sender); 草稿不算

    # 往来封数 (distinct 邮件): alice 1/2/3 三封; bob 1 封; carol 1 封
    assert alice["mail_count"] == 3
    assert bob["mail_count"] == 1
    assert carol["mail_count"] == 1
    # 双向性: 出向那封 (3) 里 bob=to / alice=cc → sent_to_count
    assert bob["sent_to_count"] == 1
    assert alice["sent_to_count"] == 1
    assert carol["sent_to_count"] == 0
    # display_name = 最近一封非空 sender_name (alice 第 2 封)
    assert alice["display_name"] == "Alice New"
    # to/cc 的 header 显示名做种子
    assert carol["display_name"] == "Carol"
    # 名字变体只追加
    import json
    assert json.loads(alice["name_variants_json"]) == ["Alice Old", "Alice New"]
    # 首末时间
    assert alice["first_seen_at"] == alice["anchor_first"]
    assert alice["last_seen_at"] > alice["first_seen_at"]

    # 账本: alice = sender(1)+sender(2)+cc(3) 三行; me 也照常入账 (WP-3)
    links = _rows(
        db,
        "SELECT ce.email_normalized AS email, l.internal_id, l.role "
        "FROM contact_email_link l JOIN contact_email ce ON ce.id = l.email_id "
        "ORDER BY email, l.internal_id, l.role",
    )
    assert [(r["email"], r["internal_id"], r["role"]) for r in links] == [
        ("alice@x.com", 1, "sender"),
        ("alice@x.com", 2, "sender"),
        ("alice@x.com", 3, "cc"),
        ("bob@y.com", 3, "to"),
        ("carol@z.com", 1, "cc"),
        ("me@corp.com", 1, "to"),
        ("me@corp.com", 2, "to"),
        ("me@corp.com", 3, "sender"),
    ]
    # watermark 推进到最大 internal_id
    with sqlite3.connect(db) as conn:
        assert conn.execute(
            "SELECT value FROM sync_state WHERE key=?", (WATERMARK_KEY,)
        ).fetchone()[0] == "5"


def _snapshot(db):
    return (
        _rows(db, "SELECT * FROM contact ORDER BY id"),
        _rows(db, "SELECT * FROM contact_email ORDER BY id"),
        _rows(db, "SELECT * FROM contact_email_link ORDER BY email_id, internal_id, role"),
    )


def test_rescan_any_interval_is_idempotent(db):
    """重跑任意区间结果一致: 全量重扫 + 只重扫旧区间, 表内容 byte-stable。"""
    _seed_emails(db, BASIC_ROWS)
    run_scan(db, self_addresses=SELF, now_ms=NOW_MS)
    before = _snapshot(db)

    # 全量重扫 (watermark 归零)
    run_scan(db, self_addresses=SELF, now_ms=NOW_MS, reset_watermark=True)
    assert _snapshot(db) == before

    # 只重扫旧区间 (watermark 拨回中间): 老邮件的旧名字不得盖掉新名字
    with sqlite3.connect(db) as conn:
        conn.execute(
            "UPDATE sync_state SET value='1' WHERE key=?", (WATERMARK_KEY,)
        )
        conn.commit()
    run_scan(db, self_addresses=SELF, now_ms=NOW_MS)
    assert _snapshot(db) == before


def test_small_batches_drain_incrementally(db):
    _seed_emails(db, BASIC_ROWS)
    stats = run_scan(db, self_addresses=SELF, now_ms=NOW_MS, batch_size=2)
    assert stats["batches"] >= 3
    assert stats["drained"] is True
    assert stats["watermark"] == 5
    assert _contact_by_email(db, "alice@x.com")["mail_count"] == 3


def test_display_name_lock_stops_auto_refresh(db):
    _seed_emails(db, BASIC_ROWS[:1])
    run_scan(db, self_addresses=SELF, now_ms=NOW_MS)
    alice = _contact_by_email(db, "alice@x.com")
    assert alice["display_name"] == "Alice Old"
    # owner 手改 + 锁定 (identity_locked_at 置位)
    with sqlite3.connect(db) as conn:
        conn.execute(
            "UPDATE contact SET display_name='Alice 手改', identity_locked_at=? "
            "WHERE id=?",
            (NOW_MS, alice["id"]),
        )
        conn.commit()
    _seed_emails(db, BASIC_ROWS[1:2])  # Alice New 那封
    run_scan(db, self_addresses=SELF, now_ms=NOW_MS)
    alice = _contact_by_email(db, "alice@x.com")
    # 锁定后自动提取绕开名字, 但账本/计数照常
    assert alice["display_name"] == "Alice 手改"
    assert alice["mail_count"] == 2


def test_kind_heuristics_and_owner_override(db):
    assert kind_for_address("noreply@github.com") == "robot"
    assert kind_for_address("build-notification@ci.dev") == "robot"
    assert kind_for_address("team-dev@corp.com") == "list"
    assert kind_for_address("all-hands@corp.com") == "list"
    assert kind_for_address("alice@x.com") == "person"

    _seed_emails(db, (
        (1, "noreply@svc.com", "Bot", "me@corp.com", None,
         "2026-08-01T08:00:00+00:00", "收件箱"),
    ))
    run_scan(db, self_addresses=SELF, now_ms=NOW_MS)
    bot = _contact_by_email(db, "noreply@svc.com")
    assert bot["kind"] == "robot"

    # owner 改判 → kind_locked_at 置位 → 后续扫描不再翻转
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        set_kind(conn, bot["id"], "person", now=NOW_MS)
    _seed_emails(db, (
        (2, "noreply@svc.com", "Bot", "me@corp.com", None,
         "2026-08-02T08:00:00+00:00", "收件箱"),
    ))
    run_scan(db, self_addresses=SELF, now_ms=NOW_MS)
    bot = _contact_by_email(db, "noreply@svc.com")
    assert bot["kind"] == "person"
    assert bot["kind_locked_at"] == NOW_MS
    assert bot["mail_count"] == 2


def test_incremental_aggregates_match_ledger_recalc(db):
    """增量维护的聚合 == 从账本重算的值 (缓存不是第二真源的自洽闸)。"""
    _seed_emails(db, BASIC_ROWS)
    run_scan(db, self_addresses=SELF, now_ms=NOW_MS)
    before = _rows(
        db,
        "SELECT id, mail_count, sent_to_count, first_seen_at, last_seen_at "
        "FROM contact ORDER BY id",
    )
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        recalc_all_aggregates(conn, self_addresses=SELF, now=NOW_MS)
    after = _rows(
        db,
        "SELECT id, mail_count, sent_to_count, first_seen_at, last_seen_at "
        "FROM contact ORDER BY id",
    )
    assert after == before


def test_flag_on_run_tick_scans(db, monkeypatch):
    from src.config import config as settings
    from src.contacts.scanner import run_tick

    # run_tick 内部经 resolve_self_addresses 读 settings → 注入测试口径
    monkeypatch.setattr(settings, "user_email", "me@corp.com", raising=False)
    monkeypatch.setattr(settings, "self_emails", "", raising=False)
    _seed_emails(db, BASIC_ROWS[:2])
    stats = run_tick(db)
    assert stats is not None and stats["processed"] == 2
    assert _contact_by_email(db, "alice@x.com") is not None


# ---- task 08-14 WP-5: sender 形态 --------------------------------------------

FULL_HEADER_ROWS = (
    # 🔴 活库 68% 的形状 (backend_origin='applescript' 写整个 From 头)。
    (1, "Gary W <GARY.W@tp-link.com>", "Gary W", "Me <me@corp.com>", None,
     "2026-08-01T08:00:00+00:00", "收件箱"),
    # 出向: 自己的地址也带显示名 —— 出向判据同样吃派生列。
    (2, "Lucien Chen <me@corp.com>", "Lucien Chen", "Gary W <gary.w@tp-link.com>",
     None, "2026-08-02T08:00:00+00:00", "发件箱"),
)


def test_full_from_header_sender_is_extracted(db):
    """🔴 WP-5 根因回归: 扫描器读 v58 派生列, 完整 From 头的发件人必须入账。

    改前判据是 `normalize_email(row['sender'])` —— 对 `Gary W <…>` 一律返 None,
    于是活库 8850 封 (68%) 的发件人在 contact_email_link 里**一条都没有**
    (实测 13014 封只记了 4020 条 role='sender')。
    """
    _seed_emails(db, FULL_HEADER_ROWS)
    run_scan(db, self_addresses=SELF, now_ms=NOW_MS)

    gary = _contact_by_email(db, "gary.w@tp-link.com")
    assert gary is not None, "完整 From 头的发件人必须建档"
    # 显示名大小写归一后仍是同一个人 (锚点 = 归一 email)。
    assert gary["display_name"] == "Gary W"
    # 两封: ① 他发的 (sender) ② 我发给他的 (to)
    assert gary["mail_count"] == 2
    # 出向判据同样吃派生列: 第 2 封 sender='Lucien Chen <me@corp.com>' ∈ 自有集
    assert gary["sent_to_count"] == 1
    # 自有地址照常建行 (WP-3), 且完整 From 头里的自己也认得出来
    assert _contact_by_email(db, "me@corp.com") is not None

    links = _rows(
        db,
        "SELECT ce.email_normalized AS email, l.internal_id, l.role "
        "FROM contact_email_link l JOIN contact_email ce ON ce.id = l.email_id "
        "ORDER BY l.internal_id, l.role",
    )
    assert [(r["email"], r["internal_id"], r["role"]) for r in links] == [
        ("gary.w@tp-link.com", 1, "sender"),
        ("me@corp.com", 1, "to"),
        ("me@corp.com", 2, "sender"),
        ("gary.w@tp-link.com", 2, "to"),
    ]


def test_null_sender_email_produces_no_sender_participation(db):
    """派生失败 (sender_email IS NULL) → 不建发件人档, 与本 WP 之前一致。

    收件人 (`Me <me@corp.com>`) 照常入账 —— WP-3 起自有地址也建档, 所以这里只断言
    「没有 role='sender' 的账本行」, 不再断言整张 contact 表为空。
    """
    _seed_emails(db, (
        (1, "not-an-email", "Broken", "Me <me@corp.com>", None,
         "2026-08-01T08:00:00+00:00", "收件箱"),
    ))
    run_scan(db, self_addresses=SELF, now_ms=NOW_MS)
    assert _rows(db, "SELECT * FROM contact_email_link WHERE role='sender'") == []
    assert [r["email_normalized"] for r in _rows(db, "SELECT * FROM contact_email")] == [
        "me@corp.com"
    ]
