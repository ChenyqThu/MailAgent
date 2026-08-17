"""通讯录组织关系 (task 08-13 WP5): set_manager 守卫全套 / 反查 / peers 派生 /
detail 投影 / merge 后 manager 语义显式断言。

service 走 src/contacts/service.py 单源; 投影走 routers/contacts.py::_load_detail
(REST 信封面在 tests/contacts/test_contacts_api.py)。
"""

from __future__ import annotations

import os
import sqlite3

import pytest

# 投影函数活在 router 模块里, import 链会拉起 src.api.app 的 auth 自检 ——
# 镜像 tests/contacts/test_contacts_api.py 的 dev 环境三件套。
os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
os.environ.setdefault("MAILAGENT_API_DEV", "true")
os.environ.setdefault("MAILAGENT_API_HOST", "127.0.0.1")

import src.api.app  # noqa: F401 — 先完成 app←routers 的环, 才能直取 router 模块
from src.api.routers.contacts import _load_detail
from src.contacts.repository import ContactRepository
from src.contacts.service import (
    ContactError,
    merge_contacts,
    set_manager,
    upsert_contact_for_email,
)
from src.mail.sync_store import SyncStore

NOW_MS = 1_800_000_000_000
SELF = frozenset({"me@corp.com"})


@pytest.fixture
def db(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    return str(path)


def _mk(
    conn: sqlite3.Connection, email: str, *, name=None, org=None, dept=None,
    role=None, kind="person", is_self=0, hidden_at=None, mail=0,
) -> int:
    """建一个联系人 (经 upsert 单源拿主邮箱锚点) + 直落测试用属性列。"""
    contact_id = upsert_contact_for_email(
        conn, email=email, now=NOW_MS, display_name=name, organization=org,
    )
    conn.execute(
        "UPDATE contact SET department=?, role_title=?, kind=?, is_self=?, "
        "hidden_at=?, mail_count=? WHERE id=?",
        (dept, role, kind, is_self, hidden_at, mail, contact_id),
    )
    return contact_id


def _row(conn, contact_id):
    return conn.execute(
        "SELECT * FROM contact WHERE id=?", (contact_id,)
    ).fetchone()


# ==================== set_manager 守卫 ====================


def test_set_and_unset_manager(db):
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        alice = _mk(conn, "alice@x.com", name="Alice")
        boss = _mk(conn, "boss@x.com", name="Boss")
        set_manager(conn, alice, boss, src="manual", now_ms=NOW_MS)
        row = _row(conn, alice)
        assert row["manager_contact_id"] == boss
        assert row["manager_src"] == "manual"
        # 解除: 两列一并清 NULL
        set_manager(conn, alice, None, src="manual", now_ms=NOW_MS + 1)
        row = _row(conn, alice)
        assert row["manager_contact_id"] is None
        assert row["manager_src"] is None


def test_set_manager_rejects_self(db):
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        alice = _mk(conn, "alice@x.com")
        with pytest.raises(ContactError) as e:
            set_manager(conn, alice, alice, src="manual", now_ms=NOW_MS)
        assert e.value.code == "E_MANAGER_SELF"


def test_set_manager_rejects_two_node_cycle(db):
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        a = _mk(conn, "a@x.com")
        b = _mk(conn, "b@x.com")
        set_manager(conn, a, b, src="manual", now_ms=NOW_MS)
        with pytest.raises(ContactError) as e:
            set_manager(conn, b, a, src="manual", now_ms=NOW_MS)
        assert e.value.code == "E_MANAGER_CYCLE"
        # 未写入 (b 的 manager 仍空)
        assert _row(conn, b)["manager_contact_id"] is None


def test_set_manager_rejects_deep_cycle(db):
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        a = _mk(conn, "a@x.com")
        b = _mk(conn, "b@x.com")
        c = _mk(conn, "c@x.com")
        set_manager(conn, b, a, src="manual", now_ms=NOW_MS)  # b→a
        set_manager(conn, c, b, src="manual", now_ms=NOW_MS)  # c→b→a
        with pytest.raises(ContactError) as e:
            set_manager(conn, a, c, src="manual", now_ms=NOW_MS)  # a→c 成环
        assert e.value.code == "E_MANAGER_CYCLE"


def test_set_manager_rejects_preexisting_dirty_cycle(db):
    """库里已有环 (脏数据) 时, 沿链上溯走不到链头 → hop 上限保守拒绝, 不追加新边。"""
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        x = _mk(conn, "x@x.com")
        y = _mk(conn, "y@x.com")
        z = _mk(conn, "z@x.com")
        # 直落一个既有 2-环 (绕过守卫, 模拟脏数据)
        conn.execute(
            "UPDATE contact SET manager_contact_id=? WHERE id=?", (y, x)
        )
        conn.execute(
            "UPDATE contact SET manager_contact_id=? WHERE id=?", (x, y)
        )
        with pytest.raises(ContactError) as e:
            set_manager(conn, z, x, src="manual", now_ms=NOW_MS)
        assert e.value.code == "E_MANAGER_CYCLE"
        assert _row(conn, z)["manager_contact_id"] is None


def test_set_manager_requires_live_contacts(db):
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        alice = _mk(conn, "alice@x.com")
        ghost = _mk(conn, "ghost@x.com")
        winner = _mk(conn, "winner@x.com")
        merge_contacts(
            conn, winner, ghost, now=NOW_MS, self_addresses=SELF,
        )
        # 上级是墓碑 → 拒
        with pytest.raises(ContactError) as e:
            set_manager(conn, alice, ghost, src="manual", now_ms=NOW_MS)
        assert e.value.code == "E_CONTACT_MERGED"
        # 本人是墓碑 → 拒
        with pytest.raises(ContactError) as e:
            set_manager(conn, ghost, alice, src="manual", now_ms=NOW_MS)
        assert e.value.code == "E_CONTACT_MERGED"
        # 不存在 → 404 语义
        with pytest.raises(ContactError) as e:
            set_manager(conn, alice, 99_999, src="manual", now_ms=NOW_MS)
        assert e.value.code == "E_CONTACT_NOT_FOUND"


def test_set_manager_rejects_bad_src(db):
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        alice = _mk(conn, "alice@x.com")
        boss = _mk(conn, "boss@x.com")
        with pytest.raises(ContactError) as e:
            set_manager(conn, alice, boss, src="psychic", now_ms=NOW_MS)
        assert e.value.code == "E_INVALID_ARG"


# ==================== 反查 + detail 投影 ====================


def test_detail_projection_manager_reports_peers(db):
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        boss = _mk(
            conn, "boss@x.com", name="Boss", org="ACME", role="Director", mail=9,
        )
        alice = _mk(
            conn, "alice@x.com", name="Alice", org="ACME", dept="交付", mail=50,
        )
        # 下级三人 (mail_count 降序断言) + 一个隐藏下级 + 一个墓碑下级
        r1 = _mk(conn, "r1@x.com", name="R1", mail=5)
        r2 = _mk(conn, "r2@x.com", name="R2", mail=30)
        r_hidden = _mk(conn, "rh@x.com", name="RH", hidden_at=NOW_MS, mail=99)
        r_dead = _mk(conn, "rd@x.com", name="RD", mail=99)
        for rid in (r1, r2, r_hidden, r_dead):
            set_manager(conn, rid, alice, src="manual", now_ms=NOW_MS)
        sink = _mk(conn, "sink@x.com", name="Sink")
        merge_contacts(conn, sink, r_dead, now=NOW_MS, self_addresses=SELF)
        # 墓碑化会把 r_dead 的 manager 引用… (merge 只改「指向 loser」的引用;
        # r_dead 自己的 manager 列随墓碑行保留, 投影层必须靠 merged_into 过滤)
        set_manager(conn, alice, boss, src="manual", now_ms=NOW_MS)

        detail = _load_detail(conn, alice)
        assert detail["manager"] == {
            "id": boss, "display_name": "Boss", "name_en": None,
            "organization": "ACME", "role_title": "Director", "kind": "person",
            "mail_count": 9, "primary_email": "boss@x.com",
        }
        assert detail["manager_src"] == "manual"
        # 反查: 只剩 r2/r1 (mail_count 降序); 隐藏/墓碑排除
        assert [r["id"] for r in detail["reports"]] == [r2, r1]
        assert detail["reports"][0]["primary_email"] == "r2@x.com"
        # boss 的详情: manager 空 + reports 反查得 alice (只存一侧的另一半)
        boss_detail = _load_detail(conn, boss)
        assert boss_detail["manager"] is None
        assert [r["id"] for r in boss_detail["reports"]] == [alice]


def test_peers_derivation(db):
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        subject = _mk(
            conn, "s@x.com", name="Subject", org="ACME", dept="交付", mail=1,
        )
        same_dept = _mk(
            conn, "p1@x.com", name="P1", org="ACME", dept="交付", mail=40,
        )
        no_dept = _mk(conn, "p2@x.com", name="P2", org="ACME", mail=30)
        other_dept = _mk(
            conn, "p3@x.com", name="P3", org="ACME", dept="法务", mail=99,
        )
        other_org = _mk(conn, "p4@x.com", name="P4", org="EvilCorp", mail=99)
        robot = _mk(conn, "bot@x.com", org="ACME", kind="robot", mail=99)
        hidden = _mk(conn, "h@x.com", org="ACME", hidden_at=NOW_MS, mail=99)
        # 🔴 task 08-14 WP-3: 「我」不再从同事推荐里排除 (owner「上下级也无法关联
        # 我」) —— mail=99 让它排在最前, 位置本身就是「不再被筛掉」的判据。
        selfy = _mk(conn, "me2@x.com", org="ACME", is_self=1, mail=99)
        del other_org, robot, hidden

        detail = _load_detail(conn, subject)
        # 同 org; 双方都有 dept 才要求相同 (无 dept 的同事仍收) —— cdata.jsx:314-317
        assert [p["id"] for p in detail["peers"]] == [selfy, same_dept, no_dept]
        assert other_dept not in [p["id"] for p in detail["peers"]]

        # subject 无 dept → 同 org 全收 (mail_count 降序)
        no_dept_subject = _mk(conn, "s2@x.com", org="ACME", mail=1)
        detail2 = _load_detail(conn, no_dept_subject)
        assert [p["id"] for p in detail2["peers"]] == [
            other_dept, selfy, same_dept, no_dept, subject,
        ]

        # 无组织 → 恒空
        loner = _mk(conn, "loner@x.com", mail=1)
        assert _load_detail(conn, loner)["peers"] == []


def test_peers_capped_at_six(db):
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        subject = _mk(conn, "s@x.com", org="ACME", mail=1)
        for i in range(8):
            _mk(conn, f"p{i}@x.com", org="ACME", mail=10 + i)
        peers = _load_detail(conn, subject)["peers"]
        assert len(peers) == 6
        # mail_count 降序: 17,16,…,12
        assert [p["mail_count"] for p in peers] == [17, 16, 15, 14, 13, 12]


# ==================== merge 后 manager 语义 (裁决 11 显式断言) ====================


def test_merge_keeps_winner_manager_value(db):
    """「上级取保留方的值」= winner.manager 原样不动 (loser 的 manager 值弃);
    指向 loser 的第三方 manager 引用改指 winner。"""
    repo = ContactRepository(db)
    with repo.transaction() as conn:
        mgr_w = _mk(conn, "mw@x.com", name="WinnerBoss")
        mgr_l = _mk(conn, "ml@x.com", name="LoserBoss")
        winner = _mk(conn, "w@x.com", name="Winner")
        loser = _mk(conn, "l@x.com", name="Loser")
        third = _mk(conn, "t@x.com", name="Third")
        set_manager(conn, winner, mgr_w, src="manual", now_ms=NOW_MS)
        set_manager(conn, loser, mgr_l, src="manual", now_ms=NOW_MS)
        set_manager(conn, third, loser, src="manual", now_ms=NOW_MS)

        merge_contacts(conn, winner, loser, now=NOW_MS, self_addresses=SELF)

        assert _row(conn, winner)["manager_contact_id"] == mgr_w  # 保留方的值
        assert _row(conn, third)["manager_contact_id"] == winner  # 引用改指
        assert _row(conn, loser)["merged_into"] == winner
