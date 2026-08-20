"""Contact Directory REST 面 (task 08-13 WP2): flag 门 / 列表聚合与排序 / 搜索 /
字段编辑落锁与解锁 / 曾用守卫错误信封 / backfill 进度 / 关联邮件与事项。

fixture 镜像 tests/matters/test_matters_api.py (真 FastAPI app + dependency
overrides, 不 mock 框架层)。
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
os.environ.setdefault("MAILAGENT_API_DEV", "true")
os.environ.setdefault("MAILAGENT_API_HOST", "127.0.0.1")

from src.api.app import app
from src.api.auth import verify_cf_access
from src.api.deps import get_settings
from src.api.routers import contacts as contacts_router
from src.contacts import profile as contact_profile
from src.api.routers.contacts import get_contact_repository
from src.contacts.repository import ContactRepository
from src.contacts.scanner import WATERMARK_KEY
from src.mail.sync_store import SyncStore


@pytest.fixture
def client(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    settings = SimpleNamespace(
        sync_store_db_path=str(path),
        user_email="",
        self_emails="",
    )
    app.dependency_overrides[verify_cf_access] = lambda: None
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_contact_repository] = lambda: ContactRepository(path)
    with TestClient(app) as test_client:
        yield test_client, settings, str(path)
    app.dependency_overrides.clear()


def _conn(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def _seed_contact(
    path, *, cid, name=None, formal_name=None, org=None, kind="person",
    hidden_at=None, is_self=0, mail=0, sent=0, first=None, last=None,
    variants=None, emails=(), gender=None,
):
    with _conn(path) as conn:
        conn.execute(
            "INSERT INTO contact (id, display_name, formal_name, organization, gender, kind, "
            "hidden_at, is_self, mail_count, sent_to_count, first_seen_at, "
            "last_seen_at, name_variants_json, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 1, 1)",
            (
                cid, name, formal_name, org, gender, kind, hidden_at, is_self, mail, sent,
                first, last,
                json.dumps(variants, ensure_ascii=False) if variants else None,
            ),
        )
        for address, is_primary in emails:
            conn.execute(
                "INSERT INTO contact_email (contact_id, email_normalized, "
                "is_primary, created_at) VALUES (?,?,?,1)",
                (cid, address, is_primary),
            )
        conn.commit()


def _data(resp):
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


# ---- 列表: view 语义 + 三排序 + 搜索 ----


def _seed_list_fixture(path):
    _seed_contact(
        path, cid=1, name="Alice", org="ACME", sent=5, mail=20, last=300,
        emails=(("alice@x.com", 1), ("alice@old.com", 0)),
        variants=["Alice", "爱丽丝"],
    )
    _seed_contact(
        path, cid=2, name="Bob", sent=9, mail=10, last=200,
        emails=(("bob@y.com", 1),),
    )
    _seed_contact(  # 单向广播: sent=0 → known 不收
        path, cid=3, name="Newsletter Ned", sent=0, mail=99, last=900,
        emails=(("ned@z.com", 1),),
    )
    _seed_contact(  # robot → known 不收
        path, cid=4, name="Robo", kind="robot", sent=3, mail=50, last=100,
        emails=(("noreply@z.com", 1),),
    )
    _seed_contact(  # 已隐藏 → known 不收
        path, cid=5, name="Hidden Hu", hidden_at=1, sent=4, mail=4, last=50,
        emails=(("hu@z.com", 1),),
    )
    _seed_contact(  # 我自己 → known 不收 (WP-3 曾开 carve-out, WP-6 B 撤回)
        path, cid=6, name="Me", is_self=1, sent=2, mail=2, last=40,
        emails=(("me@corp.com", 1),),
    )
    _seed_contact(  # 裸邮箱 (无名字) → name 排序按主邮箱兜底
        path, cid=7, sent=1, mail=1, last=400, emails=(("zz@last.com", 1),),
    )


def test_list_known_view_is_two_way_people_without_me(client):
    http, _, path = client
    _seed_list_fixture(path)
    data = _data(http.get("/api/contacts"))
    ids = [item["id"] for item in data["items"]]
    # 6 =「我」(WP-6 B: 重新排除); 3 单向广播 / 4 robot / 5 隐藏同样不收。
    assert set(ids) == {1, 2, 7}
    # density: sent DESC (9 > 5 > 1)
    assert ids == [2, 1, 7]
    assert data["total"] == 3
    alice = next(i for i in data["items"] if i["id"] == 1)
    assert alice["email_count"] == 2
    assert alice["primary_email"] == "alice@x.com"
    assert alice["profile_summary"] is None


def test_list_known_view_excludes_me_even_with_two_way_traffic(client):
    """WP-6 B 撤回 WP-3 的 carve-out: 这个 tab 叫「往来的人」, 自己不是往来对象。

    🔴 fixture 里的「我」**有**双向往来 (sent>0 且 kind='person') ⇒ 唯一能把它挡
    在外面的只有 `is_self = 0` 那一条, 判据回退时本测必红 (不是被 sent=0 顺带
    挡住的假绿)。对照: 同样有双向往来的非 self 行照常在。"""
    http, _, path = client
    _seed_contact(
        path, cid=1, name="Me", is_self=1, sent=4, mail=9,
        emails=(("me@corp.com", 1),),
    )
    _seed_contact(
        path, cid=2, name="Peer", sent=4, mail=9,
        emails=(("peer@x.com", 1),),
    )
    assert [i["id"] for i in _data(http.get("/api/contacts"))["items"]] == [2]
    # 「全部」视图天然含「我」—— owner 要找自己去那边 (只过滤 merged_into)。
    assert sorted(
        i["id"] for i in _data(http.get("/api/contacts", params={"view": "all"}))["items"]
    ) == [1, 2]


def test_list_all_view_still_shows_me_when_hidden(client):
    """隐藏的「我」在「全部」里仍找得回来 (隐藏只从 known 消失, 不是删除)。

    注: known 侧的空结果自 WP-6 B 起是**过定**的 (is_self 与 hidden 各自都足以
    排除), 真正只有这里能钉的是 all 侧那条。"""
    http, _, path = client
    _seed_contact(
        path, cid=1, name="Me", is_self=1, hidden_at=1, sent=0, mail=0,
        emails=(("me@corp.com", 1),),
    )
    assert _data(http.get("/api/contacts"))["items"] == []
    assert [
        i["id"] for i in _data(http.get("/api/contacts", params={"view": "all"}))["items"]
    ] == [1]


def test_list_all_view_includes_everything(client):
    http, _, path = client
    _seed_list_fixture(path)
    data = _data(http.get("/api/contacts", params={"view": "all"}))
    assert {item["id"] for item in data["items"]} == {1, 2, 3, 4, 5, 6, 7}


def test_list_sorts(client):
    http, _, path = client
    _seed_list_fixture(path)
    recent = _data(http.get("/api/contacts", params={"sort": "recent"}))
    # last 400 > 300 > 200 (id=6「我」不在 known 视图里)
    assert [i["id"] for i in recent["items"]] == [7, 1, 2]
    name = _data(http.get("/api/contacts", params={"sort": "name"}))
    # Alice < Bob < zz@last.com (裸邮箱按主邮箱兜底比较)
    assert [i["id"] for i in name["items"]] == [1, 2, 7]


def test_list_search_hits_variants_and_secondary_email(client):
    http, _, path = client
    _seed_list_fixture(path)
    by_variant = _data(http.get("/api/contacts", params={"q": "爱丽丝"}))
    assert [i["id"] for i in by_variant["items"]] == [1]
    by_second_email = _data(http.get("/api/contacts", params={"q": "alice@old"}))
    assert [i["id"] for i in by_second_email["items"]] == [1]
    by_org = _data(http.get("/api/contacts", params={"q": "acme"}))
    assert [i["id"] for i in by_org["items"]] == [1]
    none = _data(http.get("/api/contacts", params={"q": "no-such-person"}))
    assert none["items"] == []


def test_list_rejects_bad_params(client):
    http, _, path = client
    assert http.get("/api/contacts", params={"view": "bogus"}).status_code == 400
    assert http.get("/api/contacts", params={"sort": "bogus"}).status_code == 400
    assert http.get("/api/contacts", params={"limit": 0}).status_code == 400
    assert http.get("/api/contacts", params={"limit": -3}).status_code == 400


# ---- 列表 limit (WP4: ⌘K 「人」组截断; total 仍全量) ----


def test_list_limit_truncates_but_total_stays_full(client):
    http, _, path = client
    _seed_list_fixture(path)
    data = _data(http.get("/api/contacts", params={"limit": 2}))
    # density 排序全量是 [2, 1, 7] —— 截断只留前 2, total 仍报 3 (供「+n more」)。
    assert [i["id"] for i in data["items"]] == [2, 1]
    assert data["total"] == 3


def test_list_without_limit_is_unchanged(client):
    http, _, path = client
    _seed_list_fixture(path)
    data = _data(http.get("/api/contacts"))
    assert len(data["items"]) == data["total"] == 3


# ---- 批量精确解析 (WP4: POST /resolve) ----


def test_resolve_mixed_hits_and_misses_keyed_by_original_input(client):
    http, _, path = client
    _seed_list_fixture(path)
    payload = {
        "emails": [
            "alice@x.com",       # 主锚点命中
            "alice@old.com",     # 非主锚点也命中同一人 (LIKE 面做不到的判等)
            "nobody@none.com",   # 不在库 → null
            "not-an-email",      # 非法形状 → null
        ]
    }
    data = _data(http.post("/api/contacts/resolve", json=payload))
    items = data["items"]
    # 键 = 原输入串, 一条不多一条不少。
    assert set(items.keys()) == set(payload["emails"])
    assert items["alice@x.com"]["id"] == 1
    assert items["alice@x.com"]["display_name"] == "Alice"
    assert items["alice@x.com"]["kind"] == "person"
    assert items["alice@x.com"]["primary_email"] == "alice@x.com"
    # 非主锚点命中同一人, chip 的 primary_email 仍是主邮箱 (Monogram 色相锚)。
    assert items["alice@old.com"]["id"] == 1
    assert items["alice@old.com"]["primary_email"] == "alice@x.com"
    assert items["nobody@none.com"] is None
    assert items["not-an-email"] is None


def test_resolve_normalizes_case_and_whitespace(client):
    http, _, path = client
    _seed_list_fixture(path)
    raw = "  Alice@X.COM  "
    data = _data(http.post("/api/contacts/resolve", json={"emails": [raw]}))
    # 归一 (trim+lower) 后命中; 响应键保持原输入串逐字。
    assert data["items"][raw]["id"] == 1


def test_resolve_does_not_filter_hidden_self_robot(client):
    http, _, path = client
    _seed_list_fixture(path)
    data = _data(
        http.post(
            "/api/contacts/resolve",
            json={"emails": ["noreply@z.com", "hu@z.com", "me@corp.com"]},
        )
    )
    # 「在库」判据就是 contact_email 有行 —— robot/hidden/self 一样给 chip。
    assert data["items"]["noreply@z.com"]["id"] == 4
    assert data["items"]["noreply@z.com"]["kind"] == "robot"
    assert data["items"]["hu@z.com"]["id"] == 5
    assert data["items"]["me@corp.com"]["id"] == 6


def test_resolve_rejects_more_than_100_emails(client):
    http, _, path = client
    emails = [f"user{i}@x.com" for i in range(101)]
    resp = http.post("/api/contacts/resolve", json={"emails": emails})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_INVALID_ARG"


def test_resolve_empty_list_returns_empty_map(client):
    http, _, path = client
    data = _data(http.post("/api/contacts/resolve", json={"emails": []}))
    assert data["items"] == {}


# ---- 详情 ----


def test_detail_shape(client):
    http, _, path = client
    _seed_list_fixture(path)
    data = _data(http.get("/api/contacts/1"))
    assert data["display_name"] == "Alice"
    assert data["identity_locks"] == {}
    assert data["name_variants"] == ["Alice", "爱丽丝"]
    assert [e["address"] for e in data["emails"]] == ["alice@x.com", "alice@old.com"]
    assert data["emails"][0]["is_primary"] is True
    assert data["profile"]["status"] == "unconfigured"
    assert data["profile"]["profile_min"] == 50
    # WP5 组织关系投影恒在 (未设 = null/空数组)
    assert data["manager"] is None
    assert data["manager_src"] is None
    assert data["reports"] == []
    assert data["peers"] == []
    assert http.get("/api/contacts/999").status_code == 404


def test_gender_projects_in_list_and_detail(client):
    http, _, path = client
    _seed_contact(
        path, cid=1, name="Echo", gender="male", sent=1, mail=1,
        emails=(("echo@example.com", 1),),
    )
    assert _data(http.get("/api/contacts"))["items"][0]["gender"] == "male"
    assert _data(http.get("/api/contacts/1"))["gender"] == "male"


# ---- 字段编辑落锁 / 解锁 ----


def test_patch_locks_fields_and_unlock_clears(client):
    http, _, path = client
    _seed_list_fixture(path)
    data = _data(http.patch("/api/contacts/1", json={"organization": "Initech"}))
    assert data["fields"]["organization"] == "Initech"
    assert "organization" in data["locks"]
    with _conn(path) as conn:
        row = conn.execute(
            "SELECT organization, identity_locked_at, identity_locks_json "
            "FROM contact WHERE id=1"
        ).fetchone()
    assert row["organization"] == "Initech"
    assert row["identity_locked_at"] == json.loads(row["identity_locks_json"])["organization"]

    unlocked = _data(
        http.post(
            "/api/contacts/1/locks",
            json={"field": "organization", "locked": False},
        )
    )
    assert unlocked["locks"] == {}
    with _conn(path) as conn:
        row = conn.execute(
            "SELECT identity_locked_at, identity_locks_json FROM contact WHERE id=1"
        ).fetchone()
    assert row["identity_locked_at"] is None
    assert row["identity_locks_json"] is None


def test_patch_notes_does_not_lock(client):
    http, _, path = client
    _seed_list_fixture(path)
    data = _data(http.patch("/api/contacts/1", json={"notes": "谈判偏好邮件确认"}))
    assert data["locks"] == {}
    assert data["contact"]["notes"] == "谈判偏好邮件确认"


def test_patch_role_title_derives_unlocked_enums_without_locking_them(client):
    http, _, path = client
    _seed_list_fixture(path)
    data = _data(
        http.patch("/api/contacts/1", json={"role_title": "Senior Software Engineer"})
    )
    assert data["fields"]["function"] == "tech"
    assert data["fields"]["seniority"] == "staff"
    assert set(data["locks"]) == {"role_title"}  # 派生是自动来源, 不落锁

    # 已锁的枚举位不被派生覆盖
    _data(http.patch("/api/contacts/1", json={"function": "legal"}))
    data = _data(http.patch("/api/contacts/1", json={"role_title": "Data Analyst"}))
    assert "function" not in data["fields"]  # legal 锁着, 派生绕开
    assert data["contact"]["function"] == "legal"
    assert data["contact"]["seniority"] == "staff"


def test_patch_phone_lands_in_contact_info_json(client):
    http, _, path = client
    _seed_list_fixture(path)
    data = _data(http.patch("/api/contacts/1", json={"phone": "+86 138 0000"}))
    assert data["contact"]["phone"] == "+86 138 0000"
    assert "phone" in data["locks"]
    with _conn(path) as conn:
        raw = conn.execute(
            "SELECT contact_info_json FROM contact WHERE id=1"
        ).fetchone()[0]
    assert json.loads(raw) == {"phone": "+86 138 0000"}


def test_patch_rejects_bad_enum_and_unknown_field(client):
    http, _, path = client
    _seed_list_fixture(path)
    resp = http.patch("/api/contacts/1", json={"function": "wizardry"})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_INVALID_ARG"
    assert http.patch("/api/contacts/1", json={}).status_code == 400


def test_patch_gender_accepts_domain_rejects_invalid_and_does_not_lock(client):
    http, _, path = client
    _seed_list_fixture(path)
    data = _data(http.patch("/api/contacts/1", json={"gender": "female"}))
    assert data["contact"]["gender"] == "female" and "gender" not in data["locks"]
    resp = http.patch("/api/contacts/1", json={"gender": "unknown"})
    assert resp.status_code == 400 and resp.json()["error"]["code"] == "E_INVALID_ARG"


# ---- 治理写面 + 曾用守卫 ----


def test_governance_writes_are_reversible(client):
    http, _, path = client
    _seed_list_fixture(path)
    assert _data(http.post("/api/contacts/1/hide", json={"hidden": True}))["hidden"]
    with _conn(path) as conn:
        assert conn.execute(
            "SELECT hidden_at FROM contact WHERE id=1"
        ).fetchone()[0] is not None
    _data(http.post("/api/contacts/1/hide", json={"hidden": False}))
    _data(http.post("/api/contacts/1/kind", json={"kind": "robot"}))
    with _conn(path) as conn:
        row = conn.execute(
            "SELECT kind, kind_locked_at FROM contact WHERE id=1"
        ).fetchone()
    assert row["kind"] == "robot" and row["kind_locked_at"] is not None
    _data(http.post("/api/contacts/1/self", json={"is_self": True}))
    resp = http.post("/api/contacts/1/kind", json={"kind": "alien"})
    assert resp.status_code == 400


def test_former_email_guard_rejects_primary_with_hint(client):
    http, _, path = client
    _seed_list_fixture(path)
    resp = http.post(
        "/api/contacts/1/emails/former",
        json={"email": "alice@x.com", "former": True},
    )
    assert resp.status_code == 409
    body = resp.json()["error"]
    assert body["code"] == "E_PRIMARY_EMAIL_CANNOT_BE_FORMER"
    assert body.get("hint")

    ok = _data(
        http.post(
            "/api/contacts/1/emails/former",
            json={"email": "alice@old.com", "former": True},
        )
    )
    assert ok["former"] is True
    with _conn(path) as conn:
        assert conn.execute(
            "SELECT former_at FROM contact_email WHERE email_normalized='alice@old.com'"
        ).fetchone()[0] is not None

    # 设为主邮箱 (并恢复在用): former_at 清空 + 原主降级
    _data(
        http.post(
            "/api/contacts/1/emails/primary", json={"email": "alice@old.com"}
        )
    )
    with _conn(path) as conn:
        rows = {
            r["email_normalized"]: dict(r)
            for r in _conn(path).execute(
                "SELECT email_normalized, is_primary, former_at "
                "FROM contact_email WHERE contact_id=1"
            )
        }
    assert rows["alice@old.com"]["is_primary"] == 1
    assert rows["alice@old.com"]["former_at"] is None
    assert rows["alice@x.com"]["is_primary"] == 0


# ---- backfill 进度 ----


def test_backfill_progress_numbers(client):
    http, _, path = client
    with _conn(path) as conn:
        for internal_id in (10, 20, 30, 40):
            conn.execute(
                "INSERT INTO email_metadata (internal_id, sender, mailbox) "
                "VALUES (?, 'a@x.com', '收件箱')",
                (internal_id,),
            )
        conn.execute(
            "INSERT INTO sync_state (key, value, updated_at) VALUES (?, '20', 1)",
            (WATERMARK_KEY,),
        )
        conn.commit()
    data = _data(http.get("/api/contacts/backfill/progress"))
    assert data == {"scanned": 2, "total": 4, "drained": False}

    with _conn(path) as conn:
        conn.execute(
            "UPDATE sync_state SET value='40' WHERE key=?", (WATERMARK_KEY,)
        )
        conn.commit()
    data = _data(http.get("/api/contacts/backfill/progress"))
    assert data["drained"] is True


# ---- 关联邮件 ----


def _seed_mail_links(path, *, senders=None):
    """三封邮件挂到 alice: 101 她发的 / 102 我发的 / 103 第三方发的 (WP-5 三分)。

    `sender_email` 是 v58 派生列 —— 方向判据读它, 不读 `sender`。
    """
    senders = senders or {
        101: ("Alice <alice@x.com>", "alice@x.com"),
        102: ("Lucien Chen <me@corp.com>", "me@corp.com"),
        103: ("Third Party <third@z.com>", "third@z.com"),
    }
    with _conn(path) as conn:
        for internal_id, subject, ts in (
            (101, "Kickoff", "2026-08-01T08:00:00+00:00"),
            (102, "Re: Kickoff", "2026-08-02T08:00:00+00:00"),
            (103, "FYI", "2026-08-03T08:00:00+00:00"),
        ):
            sender, sender_email = senders[internal_id]
            conn.execute(
                "INSERT INTO email_metadata (internal_id, subject, sender, "
                "sender_email, date_received, mailbox) VALUES (?,?,?,?,?, '收件箱')",
                (internal_id, subject, sender, sender_email, ts),
            )
        email_id = conn.execute(
            "SELECT id FROM contact_email WHERE email_normalized='alice@x.com'"
        ).fetchone()[0]
        for internal_id, role, seen in (
            (101, "sender", 1000),
            (102, "to", 2000),
            (102, "cc", 2000),
            (103, "cc", 3000),
        ):
            conn.execute(
                "INSERT INTO contact_email_link (email_id, internal_id, role, "
                "seen_at) VALUES (?,?,?,?)",
                (email_id, internal_id, role, seen),
            )
        conn.commit()


def _with_self(settings, *, user_email="me@corp.com", extra=""):
    settings.user_email = user_email
    settings.self_emails = extra
    return settings


def test_contact_mails_direction_split_and_pagination(client):
    http, settings, path = client
    _with_self(settings)
    _seed_list_fixture(path)
    _seed_mail_links(path)

    data = _data(http.get("/api/contacts/1/mails"))
    assert [i["internal_id"] for i in data["items"]] == [103, 102, 101]
    assert data["total"] == 3
    assert data["next_cursor"] is None
    # roles 仍在 (cc 降级为行内次要标记, 不再占 tab 轴)
    assert data["items"][1]["roles"] == ["cc", "to"]
    assert {i["internal_id"]: i["direction"] for i in data["items"]} == {
        101: "from_them", 102: "from_me", 103: "from_third",
    }

    for direction, expected in (
        ("from_them", [101]), ("from_me", [102]), ("from_third", [103]),
    ):
        page = _data(
            http.get("/api/contacts/1/mails", params={"direction": direction})
        )
        assert [i["internal_id"] for i in page["items"]] == expected, direction
        assert page["total"] == len(expected), direction

    page1 = _data(http.get("/api/contacts/1/mails", params={"limit": 2}))
    assert [i["internal_id"] for i in page1["items"]] == [103, 102]
    assert page1["next_cursor"] == "2000:102"
    page2 = _data(
        http.get(
            "/api/contacts/1/mails",
            params={"limit": 2, "cursor": page1["next_cursor"]},
        )
    )
    assert [i["internal_id"] for i in page2["items"]] == [101]
    assert page2["next_cursor"] is None

    assert http.get(
        "/api/contacts/1/mails", params={"direction": "bogus"}
    ).status_code == 400
    # 老 role 轴已退役: 传 role 只是被忽略 (不再有 to/cc 两个 tab)
    assert http.get(
        "/api/contacts/1/mails", params={"role": "cc"}
    ).status_code == 200


def test_contact_mails_directions_are_mutually_exclusive(client):
    """三类互斥: 三档条数之和 == 不过滤时的总数 (一封邮件对一个联系人只有一个方向,
    不像老 role 轴那样能同时出现在 to 与 cc 两个 tab)。"""
    http, settings, path = client
    _with_self(settings)
    _seed_list_fixture(path)
    _seed_mail_links(path)
    with _conn(path) as conn:
        email_id = conn.execute(
            "SELECT id FROM contact_email WHERE email_normalized='alice@x.com'"
        ).fetchone()[0]
        # 102 已是 to+cc 双角色 —— 老 role 轴下它在两个 tab 里各出现一次。
        conn.execute(
            "INSERT INTO contact_email_link (email_id, internal_id, role, seen_at) "
            "VALUES (?, 101, 'cc', 1000)",
            (email_id,),
        )
        conn.commit()

    total = _data(http.get("/api/contacts/1/mails"))["total"]
    counts = {
        d: _data(http.get("/api/contacts/1/mails", params={"direction": d}))["total"]
        for d in ("from_them", "from_me", "from_third")
    }
    assert sum(counts.values()) == total == 3
    assert counts == {"from_them": 1, "from_me": 1, "from_third": 1}


def test_contact_mails_direction_sender_role_wins_over_my_own_address(client):
    """🔴 优先级: 对方既是 sender 又在 to/cc 时 **sender 优先**。

    唯一能同时命中两条分支的形状 = 看「我」自己的人物页上那封「我发的、又抄送了
    自己」的邮件 (sender_email ∈ 自有集 **且** 该联系人的 role 含 sender)。判据顺序
    反过来的话它会被判成 from_me。
    """
    http, settings, path = client
    _with_self(settings)
    _seed_list_fixture(path)  # cid=6 = 「我」, 锚点 me@corp.com
    with _conn(path) as conn:
        conn.execute(
            "INSERT INTO email_metadata (internal_id, subject, sender, sender_email, "
            "date_received, mailbox) VALUES (201, '自抄送', 'Me <me@corp.com>', "
            "'me@corp.com', '2026-08-05T08:00:00+00:00', '发件箱')"
        )
        email_id = conn.execute(
            "SELECT id FROM contact_email WHERE email_normalized='me@corp.com'"
        ).fetchone()[0]
        for role in ("sender", "cc"):
            conn.execute(
                "INSERT INTO contact_email_link (email_id, internal_id, role, "
                "seen_at) VALUES (?, 201, ?, 5000)",
                (email_id, role),
            )
        conn.commit()

    data = _data(http.get("/api/contacts/6/mails"))
    assert [i["internal_id"] for i in data["items"]] == [201]
    assert sorted(data["items"][0]["roles"]) == ["cc", "sender"]
    assert data["items"][0]["direction"] == "from_them"
    assert _data(
        http.get("/api/contacts/6/mails", params={"direction": "from_me"})
    )["total"] == 0


def test_contact_mails_direction_handles_null_sender_email(client):
    """`sender_email IS NULL` (v58 派生不出地址) → from_third, 不炸也不算成我发的。"""
    http, settings, path = client
    _with_self(settings)
    _seed_list_fixture(path)
    _seed_mail_links(path, senders={
        101: ("Alice <alice@x.com>", "alice@x.com"),
        102: ("garbage-no-address", None),
        103: ("Third Party <third@z.com>", "third@z.com"),
    })
    data = _data(http.get("/api/contacts/1/mails"))
    assert {i["internal_id"]: i["direction"] for i in data["items"]}[102] == "from_third"


def test_contact_mails_direction_without_any_self_address(client):
    """自有地址集为空 (USER_EMAIL 没配、库里也没有「我」) → 没有 from_me, 但
    `IN ()` 那条 SQL 不能炸。"""
    http, settings, path = client
    _with_self(settings, user_email="", extra="")
    # 🔴 不用 _seed_list_fixture: 它带一条 is_self=1 的行, 自有地址集就不空了。
    _seed_contact(
        path, cid=1, name="Alice", sent=5, mail=20, emails=(("alice@x.com", 1),),
    )
    _seed_mail_links(path)
    data = _data(http.get("/api/contacts/1/mails"))
    assert {i["internal_id"]: i["direction"] for i in data["items"]} == {
        101: "from_them", 102: "from_third", 103: "from_third",
    }
    assert _data(
        http.get("/api/contacts/1/mails", params={"direction": "from_me"})
    )["total"] == 0


def test_contact_mails_direction_follows_is_self_anchors(client):
    """🔴 自有地址集的权威是「我」那条联系人的**全部锚点** —— 合并进来的旧邮箱
    不用另配, 用它发出的历史邮件照样算「我发的」。"""
    http, settings, path = client
    _with_self(settings, user_email="me@corp.com")
    _seed_list_fixture(path)
    _seed_mail_links(path, senders={
        101: ("Alice <alice@x.com>", "alice@x.com"),
        102: ("Lucien Chen <old-me@tp-link.com>", "old-me@tp-link.com"),
        103: ("Third Party <third@z.com>", "third@z.com"),
    })
    # 未挂到「我」名下时: 旧地址只是普通第三方
    before = _data(http.get("/api/contacts/1/mails"))
    assert {i["internal_id"]: i["direction"] for i in before["items"]}[102] == "from_third"
    # 把旧地址挂进「我」(cid=6 是 is_self=1 那条)
    with _conn(path) as conn:
        conn.execute(
            "INSERT INTO contact_email (contact_id, email_normalized, is_primary, "
            "created_at) VALUES (6, 'old-me@tp-link.com', 0, 1)"
        )
        conn.commit()
    after = _data(http.get("/api/contacts/1/mails"))
    assert {i["internal_id"]: i["direction"] for i in after["items"]}[102] == "from_me"


# ---- 关联事项 ----


def test_contact_matters_reverse_lookup(client):
    http, _, path = client
    _seed_list_fixture(path)
    with _conn(path) as conn:
        conn.execute(
            "INSERT INTO matter (id, public_id, title, status, created_at, "
            "updated_at) VALUES (1, 'MAT-0001', 'POC 验收', 'active', 1, 9)"
        )
        conn.execute(
            "INSERT INTO matter_stakeholder (matter_id, person_key, display_name, "
            "contact_id, role, created_at, updated_at) "
            "VALUES (1, 'pk-alice', 'Alice', 1, '决策人', 1, 1)"
        )
        conn.commit()
    data = _data(http.get("/api/contacts/1/matters"))
    assert len(data["items"]) == 1
    item = data["items"][0]
    assert item["public_id"] == "MAT-0001"
    assert item["title"] == "POC 验收"
    assert item["role"] == "决策人"
    assert item["status"] == "active"


# ---- 合并 (WP3) ----


def test_merge_endpoint_lands_choices_and_returns_winner_detail(client):
    """POST /{winner}/merge: 主邮箱/曾用按入参 (预览页勾选) 落库，返回 winner
    详情 (toast 的 {n} = emails 数)；loser 成墓碑但数据保留。"""
    http, _, path = client
    _seed_contact(
        path, cid=1, name="Alice", mail=4, sent=1, last=100,
        emails=(("alice@old.com", 1),),
    )
    _seed_contact(
        path, cid=2, name="Alice Chen", mail=1, sent=0, last=200,
        emails=(("alice@new.com", 1),),
    )
    detail = _data(
        http.post(
            "/api/contacts/1/merge",
            json={
                "loser_id": 2,
                "primary_email": "alice@new.com",
                "former_emails": ["alice@old.com"],
            },
        )
    )
    assert detail["id"] == 1
    by_addr = {entry["address"]: entry for entry in detail["emails"]}
    assert set(by_addr) == {"alice@old.com", "alice@new.com"}
    assert by_addr["alice@new.com"]["is_primary"] is True
    assert by_addr["alice@new.com"]["former_at"] is None
    assert by_addr["alice@old.com"]["is_primary"] is False
    assert by_addr["alice@old.com"]["former_at"] is not None
    # loser 墓碑：行保留、merged_into 指 winner (详情端点仍可读，审计视角)
    loser = _data(http.get("/api/contacts/2"))
    assert loser["merged_into"] == 1


def test_merge_endpoint_error_envelopes(client):
    http, _, path = client
    _seed_contact(path, cid=1, name="Alice", emails=(("alice@x.com", 1),))
    _seed_contact(path, cid=2, name="Bob", emails=(("bob@y.com", 1),))

    # 自并 → 400 E_MERGE_SELF；两条记录都未改动
    resp = http.post(
        "/api/contacts/1/merge",
        json={"loser_id": 1, "primary_email": "alice@x.com"},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_MERGE_SELF"

    # loser 不存在 → 404；同样零改动
    resp = http.post(
        "/api/contacts/1/merge",
        json={"loser_id": 99, "primary_email": "alice@x.com"},
    )
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "E_CONTACT_NOT_FOUND"

    # 失败分支的「两条记录都未改动」不是文案是事实：无墓碑、锚点未动
    detail = _data(http.get("/api/contacts/2"))
    assert detail["merged_into"] is None
    assert [entry["address"] for entry in detail["emails"]] == ["bob@y.com"]

    # 已成墓碑的不能再当被并方 → 409 E_CONTACT_MERGED
    assert (
        http.post(
            "/api/contacts/1/merge",
            json={"loser_id": 2, "primary_email": "alice@x.com"},
        ).status_code
        == 200
    )
    resp = http.post(
        "/api/contacts/1/merge",
        json={"loser_id": 2, "primary_email": "alice@x.com"},
    )
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "E_CONTACT_MERGED"


# ---- 组织关系 (WP5: POST /{id}/manager + 投影) ----


def test_manager_endpoint_sets_unsets_and_returns_detail(client):
    http, _, path = client
    _seed_contact(path, cid=1, name="Alice", org="ACME", emails=(("alice@x.com", 1),))
    _seed_contact(
        path, cid=2, name="Boss", org="ACME", mail=9, emails=(("boss@x.com", 1),),
    )

    data = _data(http.post("/api/contacts/1/manager", json={"manager_contact_id": 2}))
    # REST 面恒写 manual (auto 是 WP6/WP7 的事; 结构位已投影)
    assert data["manager_src"] == "manual"
    assert data["manager"]["id"] == 2
    assert data["manager"]["display_name"] == "Boss"
    assert data["manager"]["primary_email"] == "boss@x.com"
    # 只存一侧: 反查在上级那行的 detail 里
    boss = _data(http.get("/api/contacts/2"))
    assert [r["id"] for r in boss["reports"]] == [1]
    assert boss["manager"] is None

    # 解除 = null (manager_src 一并清)
    data = _data(http.post("/api/contacts/1/manager", json={"manager_contact_id": None}))
    assert data["manager"] is None
    assert data["manager_src"] is None
    assert _data(http.get("/api/contacts/2"))["reports"] == []


def test_manager_endpoint_error_envelopes(client):
    http, _, path = client
    _seed_contact(path, cid=1, name="Alice", emails=(("alice@x.com", 1),))
    _seed_contact(path, cid=2, name="Boss", emails=(("boss@x.com", 1),))

    resp = http.post("/api/contacts/1/manager", json={"manager_contact_id": 1})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_MANAGER_SELF"

    assert (
        http.post(
            "/api/contacts/1/manager", json={"manager_contact_id": 2}
        ).status_code
        == 200
    )
    resp = http.post("/api/contacts/2/manager", json={"manager_contact_id": 1})
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "E_MANAGER_CYCLE"

    resp = http.post("/api/contacts/1/manager", json={"manager_contact_id": 999})
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "E_CONTACT_NOT_FOUND"


def test_list_carries_manager_fields(client):
    http, _, path = client
    _seed_contact(
        path, cid=1, name="Alice", sent=5, mail=20, emails=(("alice@x.com", 1),),
    )
    _seed_contact(
        path, cid=2, name="Boss", sent=3, mail=9, emails=(("boss@x.com", 1),),
    )
    _data(http.post("/api/contacts/1/manager", json={"manager_contact_id": 2}))

    rows = {row["id"]: row for row in _data(http.get("/api/contacts"))["items"]}
    assert rows[1]["manager_contact_id"] == 2
    assert rows[1]["manager_display_name"] == "Boss"
    assert rows[2]["manager_contact_id"] is None
    assert rows[2]["manager_display_name"] is None


# ---- WP6 contact profile ----


def _enable_profile(path, settings):
    with _conn(path) as conn:
        conn.execute(
            "UPDATE report_agent SET enabled=1 WHERE id='contact_profile_agent'"
        )
        conn.commit()


def test_profile_refresh_below_threshold_merged_and_duplicate(client, monkeypatch):
    http, settings, path = client
    _enable_profile(path, settings)
    _seed_contact(path, cid=1, name="Tiny", mail=1, emails=(("tiny@x.com", 1),))
    generated = []

    def fake_generate(*args, **kwargs):
        generated.append((args, kwargs))
        return object()

    monkeypatch.setattr(contact_profile, "generate_contact_profile", fake_generate)
    monkeypatch.setattr(contacts_router, "_schedule_profile_task", lambda _: None)
    response = http.post("/api/contacts/1/profile/refresh")
    assert response.status_code == 202
    assert response.json()["data"] == {
        "contact_id": 1,
        "status": "running",
        "started": True,
    }
    assert generated[0][1]["full_refresh"] is True
    duplicate = http.post("/api/contacts/1/profile/refresh")
    assert duplicate.status_code == 202
    assert duplicate.json()["data"]["started"] is False

    _seed_contact(path, cid=2, name="Winner", emails=(("winner@x.com", 1),))
    _seed_contact(path, cid=3, name="Loser", emails=(("loser@x.com", 1),))
    with _conn(path) as conn:
        conn.execute("UPDATE contact SET merged_into=2 WHERE id=3")
        conn.commit()
    rejected = http.post("/api/contacts/3/profile/refresh")
    assert rejected.status_code == 403
    assert rejected.json()["error"]["code"] == "E_CONTACT_MERGED"


def test_profile_daily_summary_aggregates_local_day_and_row_fire_hour(client):
    http, settings, path = client
    _enable_profile(path, settings)
    now_ms = int(time.time() * 1000)
    yesterday_ms = now_ms - 2 * 24 * 60 * 60 * 1000
    for cid, status, attempted_at in (
        (1, "ok", now_ms - 3000),
        (2, "skipped", now_ms - 2000),
        (3, "failed", now_ms - 1000),
        (4, "ok", yesterday_ms),
    ):
        _seed_contact(path, cid=cid, name=f"C{cid}")
        with _conn(path) as conn:
            conn.execute(
                "UPDATE contact SET profile_status=?, profile_attempted_at=? WHERE id=?",
                (status, attempted_at, cid),
            )
            conn.commit()
    with _conn(path) as conn:
        conn.execute(
            "UPDATE report_agent SET trigger_json='{\"fire_hour\":7,\"daily_limit\":50}' "
            "WHERE id='contact_profile_agent'"
        )
        conn.commit()
    data = _data(http.get("/api/contacts/profile/daily-summary"))
    assert data == {
        "date": datetime.now().astimezone().date().isoformat(),
        "attempted": 3,
        "ok": 1,
        "skipped": 1,
        "failed": 1,
        "last_attempted_at": now_ms - 1000,
        "fire_hour": 7,
    }


def test_profile_adopt_locks_and_ignore_only_current_round(client):
    http, settings, path = client
    _enable_profile(path, settings)
    _seed_contact(path, cid=1, name="Alice", emails=(("alice@x.com", 1),))
    document = {
        "summary": "Profile",
        "formal_name": "Alice  Zhang [id: 1]",
        "department": "PMO [id:2]",
        "contact_info": {"phone": "+1  555 [id: 3]"},
    }
    with _conn(path) as conn:
        conn.execute(
            "UPDATE contact SET profile_json=?, profile_status='ok' WHERE id=1",
            (json.dumps(document),),
        )
        conn.commit()

    detail = _data(http.get("/api/contacts/1"))
    assert {item["field"] for item in detail["profile"]["suggestions"]} == {
        "formal_name", "department", "phone",
    }
    assert {item["field"]: item["value"] for item in detail["profile"]["suggestions"]} == {
        "formal_name": "Alice Zhang", "department": "PMO", "phone": "+1 555",
    }
    adopted = _data(
        http.post(
            "/api/contacts/1/profile/suggestions/adopt",
            json={"field": "formal_name", "value": "Alice  Zhang [id: 54216]"},
        )
    )
    assert adopted["formal_name"] == "Alice Zhang"
    assert "formal_name" in adopted["identity_locks"]
    assert "formal_name" not in {
        item["field"] for item in adopted["profile"]["suggestions"]
    }

    ignored = _data(
        http.post(
            "/api/contacts/1/profile/suggestions/ignore",
            json={"field": "department"},
        )
    )
    assert "department" not in {
        item["field"] for item in ignored["profile"]["suggestions"]
    }
    with _conn(path) as conn:
        document.pop("ignored_suggestions", None)
        conn.execute(
            "UPDATE contact SET profile_json=? WHERE id=1", (json.dumps(document),)
        )
        conn.commit()
    next_round = _data(http.get("/api/contacts/1"))
    assert "department" in {
        item["field"] for item in next_round["profile"]["suggestions"]
    }


def test_profile_detail_states_and_list_summary(client):
    http, settings, path = client
    _seed_contact(path, cid=1, name="Alice", mail=49, sent=1, emails=(("alice@x.com", 1),))
    assert _data(http.get("/api/contacts/1"))["profile"]["status"] == "unconfigured"
    _enable_profile(path, settings)
    detail = _data(http.get("/api/contacts/1"))
    assert detail["profile"]["status"] == "below_threshold"
    assert detail["profile"]["needed_mail_count"] == 1

    with _conn(path) as conn:
        conn.execute("UPDATE contact SET mail_count=50 WHERE id=1")
        conn.commit()
    assert _data(http.get("/api/contacts/1"))["profile"]["status"] == "pending_batch"
    for raw, expected in (
        ("running", "running"),
        ("failed", "failed"),
        ("skipped", "skipped"),
    ):
        with _conn(path) as conn:
            conn.execute("UPDATE contact SET profile_status=? WHERE id=1", (raw,))
            conn.commit()
        assert _data(http.get("/api/contacts/1"))["profile"]["status"] == expected

    summary = "Line one\n" + "x" * 200
    with _conn(path) as conn:
        conn.execute(
            "UPDATE contact SET profile_json=?, profile_status='ok' WHERE id=1",
            (json.dumps({"summary": summary}),),
        )
        conn.commit()
    assert _data(http.get("/api/contacts/1"))["profile"]["status"] == "ok"
    item = _data(http.get("/api/contacts"))["items"][0]
    assert "\n" not in item["profile_summary"]
    assert len(item["profile_summary"]) <= 120
    assert item["profile_min"] == 50
