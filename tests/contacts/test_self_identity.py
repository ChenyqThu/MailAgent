"""「我」的身份语义 (task 08-14 WP-3): 引导只跑一次 / 单选 / 四处排除的去留。

owner 的两段式拍板 (prd §WP-3「『我』的认定规则」):
① 引导按 ``USER_EMAIL`` **精确匹配**标一次 —— 绝不用名字、也绝不用
   ``MAILAGENT_SELF_EMAILS`` 去标别的联系人 (同名会被误标)。
② 之后一切以「我」那条资料为准: 自有地址集 = 它名下的**全部锚点**。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.contacts.repository import ContactRepository
from src.contacts.scanner import run_scan
from src.contacts.service import (
    SELF_BOOTSTRAP_KEY,
    ensure_self_bootstrap,
    merge_contacts,
    recalc_all_aggregates,
    resolve_self_addresses,
    set_is_self,
    upsert_contact_for_email,
)
from src.mail.email_address import derive_sender_email
from src.mail.sync_store import SyncStore

NOW_MS = 1_800_000_000_000
OWN = "me@corp.com"


@pytest.fixture
def db(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    return str(path)


def _seed_emails(db, rows):
    with sqlite3.connect(db) as conn:
        for row in rows:
            conn.execute(
                "INSERT INTO email_metadata (internal_id, sender, sender_email, "
                "sender_name, to_addr, cc_addr, date_received, mailbox) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (row[0], row[1], derive_sender_email(row[1]), *row[2:]),
            )
        conn.commit()


def _rows(db, sql, params=()):
    with sqlite3.connect(db) as conn:
        conn.row_factory = sqlite3.Row
        return [dict(r) for r in conn.execute(sql, params)]


def _self_ids(db):
    return [r["id"] for r in _rows(db, "SELECT id FROM contact WHERE is_self=1")]


def _marker(db):
    rows = _rows(db, "SELECT value FROM sync_state WHERE key=?", (SELF_BOOTSTRAP_KEY,))
    return rows[0]["value"] if rows else None


INBOX_ROWS = (
    (1, "Alice <alice@x.com>", "Alice", f"Me <{OWN}>", None,
     "2026-08-01T08:00:00+00:00", "收件箱"),
)


# ---- ① 引导 ----------------------------------------------------------------


def test_bootstrap_marks_the_user_email_contact_once(db):
    """全新库: 第一次扫描时「我」那条还不存在 → **不写记号**, 下一轮才标上。

    🔴 这是记号式「只跑一次」最容易写错的地方: 判定时就落记号 = 永远标不上我。
    """
    _seed_emails(db, INBOX_ROWS)
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        assert ensure_self_bootstrap(conn, user_email=OWN, now=NOW_MS) is None
    assert _marker(db) is None

    run_scan(db, self_addresses=frozenset({OWN}), now_ms=NOW_MS)  # 建出「我」那条
    with repo.transaction() as conn:
        contact_id = ensure_self_bootstrap(conn, user_email=OWN, now=NOW_MS)
    assert contact_id is not None
    assert _self_ids(db) == [contact_id]
    assert _marker(db) == str(NOW_MS)


def test_bootstrap_is_idempotent_and_never_reverts_a_manual_unmark(db):
    """owner 手动取消「我」之后, 引导**不得**把它标回来 (记号已在, 恢复靠手动 UI)。"""
    _seed_emails(db, INBOX_ROWS)
    run_scan(db, self_addresses=frozenset({OWN}), now_ms=NOW_MS)
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        contact_id = ensure_self_bootstrap(conn, user_email=OWN, now=NOW_MS)
    assert contact_id is not None

    with repo.transaction() as conn:
        set_is_self(conn, contact_id, is_self=False, now=NOW_MS)
    assert _self_ids(db) == []
    for _ in range(3):
        with repo.transaction() as conn:
            assert ensure_self_bootstrap(conn, user_email=OWN, now=NOW_MS + 1) is None
    assert _self_ids(db) == []


def test_bootstrap_respects_an_existing_manual_choice(db):
    """库里已有 is_self=1 (owner 先手动标了别人) → 引导只写记号, 不动那行。"""
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        mine = upsert_contact_for_email(conn, email=OWN, now=NOW_MS)
        other = upsert_contact_for_email(conn, email="alias@corp.com", now=NOW_MS)
        set_is_self(conn, other, is_self=True, now=NOW_MS)
    with repo.transaction() as conn:
        assert ensure_self_bootstrap(conn, user_email=OWN, now=NOW_MS) is None
    assert _self_ids(db) == [other]
    assert mine not in _self_ids(db)
    assert _marker(db) == str(NOW_MS)


def test_bootstrap_only_matches_the_account_email_never_names_or_self_emails(db):
    """🔴 判据只有账号邮箱: 同名的人、以及 MAILAGENT_SELF_EMAILS 里的地址都**不**被
    自动标 —— owner 明确点出「不然同名就会被误标」。"""
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        namesake = upsert_contact_for_email(
            conn, email="lucien.chen@other-corp.com", now=NOW_MS,
            display_name="Lucien Chen",
        )
        old = upsert_contact_for_email(
            conn, email="old-me@tp-link.com", now=NOW_MS, display_name="Lucien Chen",
        )
    # USER_EMAIL 那条还不在库里 → 一个都不标 (同名/配置里的旧地址都不算数)
    with repo.transaction() as conn:
        assert ensure_self_bootstrap(conn, user_email=OWN, now=NOW_MS) is None
    assert _self_ids(db) == []
    assert namesake not in _self_ids(db) and old not in _self_ids(db)
    assert _marker(db) is None


def test_bootstrap_without_user_email_does_not_burn_the_marker(db):
    """USER_EMAIL 没配 → 什么都不做且**不写记号** (配好之后还能引导)。"""
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        assert ensure_self_bootstrap(conn, user_email="", now=NOW_MS) is None
        assert ensure_self_bootstrap(conn, user_email="not-an-email", now=NOW_MS) is None
    assert _marker(db) is None


def test_run_scan_bootstraps_before_resolving_the_self_set(db, monkeypatch):
    """生产路径 (run_scan 自解析自有集) 会先引导再 resolve —— 第二轮扫描时
    「我」已经标上, 出向判据就吃得到它名下的旧邮箱。"""
    from src.config import config as settings

    monkeypatch.setattr(settings, "user_email", OWN, raising=False)
    monkeypatch.setattr(settings, "self_emails", "", raising=False)
    _seed_emails(db, INBOX_ROWS)
    run_scan(db, now_ms=NOW_MS)          # 建库, 此时还标不上
    assert _self_ids(db) == []
    run_scan(db, now_ms=NOW_MS)          # 第二轮: 引导落定
    assert len(_self_ids(db)) == 1


# ---- ② 单选 + 传递关系 -------------------------------------------------------


def test_set_is_self_is_single_select(db):
    """「我」只能有一个: 标新的自动清掉旧的 (owner 拍板的 UI 需求 ③)。"""
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        first = upsert_contact_for_email(conn, email=OWN, now=NOW_MS)
        second = upsert_contact_for_email(conn, email="new-me@corp.com", now=NOW_MS)
        set_is_self(conn, first, is_self=True, now=NOW_MS)
    assert _self_ids(db) == [first]
    with repo.transaction() as conn:
        set_is_self(conn, second, is_self=True, now=NOW_MS)
    assert _self_ids(db) == [second]


def test_merging_me_away_moves_the_identity_to_the_winner(db):
    """🔴「我」被选成**被并方**时身份标签必须跟着人走 (check 轮实测的洞)。

    合并把锚点搬到 winner、给 loser 盖墓碑。不转移 is_self 的话那面旗子留在一条
    再无锚点的墓碑上 ⇒ `resolve_self_addresses` 的第三源 (WP-3 起的权威源) 塌成
    空集 ⇒ 出向判据 / 方向三分 / 置顶徽章一起失效, 而引导记号已烧掉不会重标。
    「换邮箱」正是合并功能的主场景, owner 完全可能选这个方向。
    """
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        me = upsert_contact_for_email(conn, email=OWN, now=NOW_MS)
        old = upsert_contact_for_email(conn, email="old-me@tp-link.com", now=NOW_MS)
        set_is_self(conn, me, is_self=True, now=NOW_MS)
    with repo.transaction() as conn:
        merge_contacts(
            conn, winner_id=old, loser_id=me, now=NOW_MS,
            self_addresses=frozenset(),
        )
        resolved = resolve_self_addresses(conn, user_email="", extra_raw="")
    # 自有集重新落在 winner 名下的**全部**锚点上 (合并前只有 me@corp.com 一个)。
    assert resolved == frozenset({OWN, "old-me@tp-link.com"})
    # 单选不破: 墓碑上的旗子被清掉, 库里恒只有一条 is_self=1。
    assert _self_ids(db) == [old]


def test_merging_a_stranger_into_me_does_not_move_the_identity(db):
    """反方向 (winner 就是「我」) 不受影响 —— 别把非 self 的被并方也当成「我」。"""
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        me = upsert_contact_for_email(conn, email=OWN, now=NOW_MS)
        old = upsert_contact_for_email(conn, email="old-me@tp-link.com", now=NOW_MS)
        set_is_self(conn, me, is_self=True, now=NOW_MS)
    with repo.transaction() as conn:
        merge_contacts(
            conn, winner_id=me, loser_id=old, now=NOW_MS,
            self_addresses=frozenset(),
        )
    assert _self_ids(db) == [me]


def test_self_address_set_follows_the_anchors_of_the_one_me(db):
    """自有地址集 = 「我」名下**全部锚点** + USER_EMAIL + SELF_EMAILS 兜底。
    合并进来的旧邮箱自动被认作自己, 无需另配 (owner 已手工合并过)。"""
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        mine = upsert_contact_for_email(conn, email=OWN, now=NOW_MS)
        conn.execute(
            "INSERT INTO contact_email (contact_id, email_normalized, is_primary, "
            "created_at) VALUES (?, 'old-me@tp-link.com', 0, ?)",
            (mine, NOW_MS),
        )
        set_is_self(conn, mine, is_self=True, now=NOW_MS)
        resolved = resolve_self_addresses(
            conn, user_email=OWN, extra_raw="not-an-email, spare@corp.com",
        )
    assert resolved == frozenset({OWN, "old-me@tp-link.com", "spare@corp.com"})


def test_outgoing_count_widens_once_the_old_address_is_mine(db):
    """owner 的「放宽, 老同事应该回来」: 旧地址挂进「我」之后, tp-link 时代发出的
    邮件重新计入出向 (sent_to_count>0 = 默认 known 视图的准入判据)。"""
    _seed_emails(db, (
        (1, "Lucien Chen <old-me@tp-link.com>", "Lucien Chen",
         "Gary W <gary.w@x.com>", None, "2026-03-01T08:00:00+00:00", "发件箱"),
    ))
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        mine = upsert_contact_for_email(conn, email=OWN, now=NOW_MS)

    def _gary_sent():
        return _rows(
            db,
            "SELECT c.sent_to_count FROM contact c "
            "JOIN contact_email ce ON ce.contact_id = c.id "
            "WHERE ce.email_normalized='gary.w@x.com'",
        )[0]["sent_to_count"]

    with repo.connect() as conn:
        narrow = resolve_self_addresses(conn, user_email=OWN, extra_raw="")
    run_scan(db, self_addresses=narrow, now_ms=NOW_MS)
    with repo.transaction() as conn:
        recalc_all_aggregates(conn, self_addresses=narrow, now=NOW_MS)
    assert _gary_sent() == 0, "旧地址还不算自己 —— 这就是老同事消失的机制"

    # 合并: 旧地址的锚点改指「我」(账本零搬 —— merge_contacts 的同款动作)。
    with repo.transaction() as conn:
        conn.execute(
            "UPDATE contact_email SET contact_id=? WHERE email_normalized=?",
            (mine, "old-me@tp-link.com"),
        )
        set_is_self(conn, mine, is_self=True, now=NOW_MS)
        wide = resolve_self_addresses(conn, user_email=OWN, extra_raw="")
        # 聚合缓存不是第二真源: 从账本重算 (= `mailagent contact backfill` 的校准)
        recalc_all_aggregates(conn, self_addresses=wide, now=NOW_MS)
    assert "old-me@tp-link.com" in wide
    assert _gary_sent() == 1


# ---- 四处排除的去留 ----------------------------------------------------------


def test_recipient_autocomplete_still_excludes_me(db):
    """🔴 唯一保留的排除: compose 收件人补全不该把自己补给自己。

    判据在 `_CONTACT_DIRECTORY_SQL` 的 excluded 标位 —— 它同时还要把邮件头聚合出
    的同一地址压下去, 所以这里连 history lane 一起验。
    """
    from src.repository.email_repository import EmailRepository

    _seed_emails(db, (
        (1, "Alice <alice@x.com>", "Alice", f"Me <{OWN}>", None,
         "2026-08-01T08:00:00+00:00", "收件箱"),
    ))
    run_scan(db, self_addresses=frozenset({OWN}), now_ms=NOW_MS)
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        contact_id = ensure_self_bootstrap(conn, user_email=OWN, now=NOW_MS)
    assert contact_id is not None

    emails = EmailRepository(db)
    suggestions = {s.email for s in emails.suggest_contacts("me", limit=20)}
    assert OWN not in suggestions
    assert "alice@x.com" in {s.email for s in emails.suggest_contacts("alice", limit=20)}
