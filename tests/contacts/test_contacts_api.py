"""Contact Directory REST 面 (task 08-13 WP2): flag 门 / 列表聚合与排序 / 搜索 /
字段编辑落锁与解锁 / 曾用守卫错误信封 / backfill 进度 / 关联邮件与事项。

fixture 镜像 tests/matters/test_matters_api.py (真 FastAPI app + dependency
overrides, 不 mock 框架层)。
"""

from __future__ import annotations

import json
import os
import sqlite3
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
os.environ.setdefault("MAILAGENT_API_DEV", "true")
os.environ.setdefault("MAILAGENT_API_HOST", "127.0.0.1")

from src.api.app import app
from src.api.auth import verify_cf_access
from src.api.deps import get_settings
from src.api.routers.contacts import get_contact_repository
from src.contacts.repository import ContactRepository
from src.contacts.scanner import WATERMARK_KEY
from src.mail.sync_store import SyncStore


@pytest.fixture
def client(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    settings = SimpleNamespace(contacts_enabled=True, sync_store_db_path=str(path))
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
    path, *, cid, name=None, name_en=None, org=None, kind="person",
    hidden_at=None, is_self=0, mail=0, sent=0, first=None, last=None,
    variants=None, emails=(),
):
    with _conn(path) as conn:
        conn.execute(
            "INSERT INTO contact (id, display_name, name_en, organization, kind, "
            "hidden_at, is_self, mail_count, sent_to_count, first_seen_at, "
            "last_seen_at, name_variants_json, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 1, 1)",
            (
                cid, name, name_en, org, kind, hidden_at, is_self, mail, sent,
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


# ---- flag 门 ----


def test_flag_off_every_endpoint_is_disabled(client):
    http, settings, _ = client
    settings.contacts_enabled = False
    for method, url in (
        ("GET", "/api/contacts"),
        ("GET", "/api/contacts/1"),
        ("GET", "/api/contacts/1/mails"),
        ("GET", "/api/contacts/1/matters"),
        ("GET", "/api/contacts/backfill/progress"),
        ("PATCH", "/api/contacts/1"),
        ("POST", "/api/contacts/1/hide"),
        ("POST", "/api/contacts/1/kind"),
        ("POST", "/api/contacts/1/self"),
        ("POST", "/api/contacts/1/locks"),
        ("POST", "/api/contacts/1/emails/primary"),
        ("POST", "/api/contacts/1/emails/former"),
    ):
        resp = http.request(method, url, json={} if method != "GET" else None)
        assert resp.status_code == 403, (method, url, resp.status_code)
        assert resp.json()["error"]["code"] == "E_DISABLED", (method, url)


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
    _seed_contact(  # 我自己 → known 不收
        path, cid=6, name="Me", is_self=1, sent=2, mail=2, last=40,
        emails=(("me@corp.com", 1),),
    )
    _seed_contact(  # 裸邮箱 (无名字) → name 排序按主邮箱兜底
        path, cid=7, sent=1, mail=1, last=400, emails=(("zz@last.com", 1),),
    )


def test_list_known_view_is_two_way_people_only(client):
    http, _, path = client
    _seed_list_fixture(path)
    data = _data(http.get("/api/contacts"))
    ids = [item["id"] for item in data["items"]]
    assert set(ids) == {1, 2, 7}
    # density: sent DESC (9 > 5 > 1)
    assert ids == [2, 1, 7]
    assert data["total"] == 3
    alice = next(i for i in data["items"] if i["id"] == 1)
    assert alice["email_count"] == 2
    assert alice["primary_email"] == "alice@x.com"
    assert alice["profile_summary"] is None


def test_list_all_view_includes_everything(client):
    http, _, path = client
    _seed_list_fixture(path)
    data = _data(http.get("/api/contacts", params={"view": "all"}))
    assert {item["id"] for item in data["items"]} == {1, 2, 3, 4, 5, 6, 7}


def test_list_sorts(client):
    http, _, path = client
    _seed_list_fixture(path)
    recent = _data(http.get("/api/contacts", params={"sort": "recent"}))
    assert [i["id"] for i in recent["items"]] == [7, 1, 2]  # last 400 > 300 > 200
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
    assert data["profile"] is None
    assert http.get("/api/contacts/999").status_code == 404


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


def _seed_mail_links(path):
    with _conn(path) as conn:
        for internal_id, subject, ts in (
            (101, "Kickoff", "2026-08-01T08:00:00+00:00"),
            (102, "Re: Kickoff", "2026-08-02T08:00:00+00:00"),
            (103, "FYI", "2026-08-03T08:00:00+00:00"),
        ):
            conn.execute(
                "INSERT INTO email_metadata (internal_id, subject, sender, "
                "date_received, mailbox) VALUES (?,?, 'x@y.com', ?, '收件箱')",
                (internal_id, subject, ts),
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


def test_contact_mails_role_filter_and_pagination(client):
    http, _, path = client
    _seed_list_fixture(path)
    _seed_mail_links(path)

    data = _data(http.get("/api/contacts/1/mails"))
    assert [i["internal_id"] for i in data["items"]] == [103, 102, 101]
    assert data["total"] == 3
    assert data["next_cursor"] is None
    assert data["items"][1]["roles"] == ["cc", "to"]

    from_them = _data(http.get("/api/contacts/1/mails", params={"role": "from"}))
    assert [i["internal_id"] for i in from_them["items"]] == [101]
    cc = _data(http.get("/api/contacts/1/mails", params={"role": "cc"}))
    assert [i["internal_id"] for i in cc["items"]] == [103, 102]

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
        "/api/contacts/1/mails", params={"role": "bogus"}
    ).status_code == 400


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
