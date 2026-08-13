"""W-C 全局干系人库：写侧隐式维护（upsert/写穿）+ 池查询 + 一键邮件提取。

🔴 邮件提取的 fixture 列名/值形状对齐 `email_metadata` 的**真实产出**（前轮 review
HIGH-2 教训）：`sender` 是裸地址、`sender_name` 是显示名（不是 from_name）、
`to_addr`/`cc_addr` 是逗号分隔的 ``Name <email>`` 列表、`date_received` 是 ISO TEXT。
"""

from __future__ import annotations

import os
from types import SimpleNamespace

import pytest

from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.service import MatterService

os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
os.environ.setdefault("MAILAGENT_API_DEV", "true")
os.environ.setdefault("MAILAGENT_API_HOST", "127.0.0.1")


@pytest.fixture
def service(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    return MatterService(MatterRepository(path), clock_ms=lambda: 1_800_000_000_000)


def _mutation(version: int, key: str):
    return {
        "expected_version": version,
        "idempotency_key": key,
        "source": "desktop_ui",
    }


def _create_matter(service: MatterService, key: str):
    return service.create_matter(
        {"title": f"Matter {key}"}, idempotency_key=key, source="desktop_ui"
    )


def _contact_rows(service: MatterService) -> dict[str, dict]:
    # v54 (task 08-13): 全局库 = 通讯录三表, 按锚点邮箱展开 (一人一锚时形状与
    # 旧 matter_contact 逐键等价: id/display_name/organization + email_normalized)。
    with service.repository.connect() as conn:
        return {
            row["email_normalized"]: dict(row)
            for row in conn.execute(
                "SELECT c.*, ce.email_normalized FROM contact c "
                "JOIN contact_email ce ON ce.contact_id = c.id"
            )
        }


def test_create_stakeholder_upserts_contact_and_links(service):
    created = _create_matter(service, "m1")
    public_id = created["matter"]["public_id"]
    result = service.create_stakeholder(
        public_id,
        {"display_name": "Alice", "email": "Alice@X.com", "organization": "ACME"},
        **_mutation(created["version"], "sh-1"),
    )
    stakeholder = result["stakeholder"]
    contacts = _contact_rows(service)
    assert set(contacts) == {"alice@x.com"}
    assert contacts["alice@x.com"]["display_name"] == "Alice"
    assert contacts["alice@x.com"]["organization"] == "ACME"
    assert stakeholder["contact_id"] == contacts["alice@x.com"]["id"]


def test_same_email_across_matters_shares_one_contact(service):
    first = _create_matter(service, "m1")
    second = _create_matter(service, "m2")
    a = service.create_stakeholder(
        first["matter"]["public_id"],
        {"display_name": "Alice", "email": "alice@x.com"},
        **_mutation(first["version"], "sh-a"),
    )
    b = service.create_stakeholder(
        second["matter"]["public_id"],
        {"email": "ALICE@X.COM"},
        **_mutation(second["version"], "sh-b"),
    )
    assert a["stakeholder"]["contact_id"] == b["stakeholder"]["contact_id"]
    assert len(_contact_rows(service)) == 1
    # 从库里挑人只给 email：姓名从全局库回填进本行
    assert b["stakeholder"]["display_name"] == "Alice"


def test_no_email_stakeholder_stays_matter_local(service):
    created = _create_matter(service, "m1")
    result = service.create_stakeholder(
        created["matter"]["public_id"],
        {"display_name": "Ghost"},
        **_mutation(created["version"], "sh-ghost"),
    )
    assert result["stakeholder"]["contact_id"] is None
    assert _contact_rows(service) == {}


def test_rename_propagates_globally_but_role_stays_local(service):
    first = _create_matter(service, "m1")
    second = _create_matter(service, "m2")
    a = service.create_stakeholder(
        first["matter"]["public_id"],
        {"display_name": "Alice", "email": "alice@x.com", "role": "决策人"},
        **_mutation(first["version"], "sh-a"),
    )
    service.create_stakeholder(
        second["matter"]["public_id"],
        {"email": "alice@x.com", "role": "知情人"},
        **_mutation(second["version"], "sh-b"),
    )
    # 在事项 1 改名 + 改角色
    service.update_stakeholder(
        first["matter"]["public_id"],
        a["stakeholder"]["id"],
        {"display_name": "Alice Chen", "role": "审批人"},
        **_mutation(a["version"], "sh-a-rename"),
    )
    contacts = _contact_rows(service)
    assert contacts["alice@x.com"]["display_name"] == "Alice Chen"
    # 姓名写穿到事项 2 的行；角色仍是事项 2 自己的
    others = service.list_stakeholders(second["matter"]["public_id"])
    assert others[0]["display_name"] == "Alice Chen"
    assert others[0]["role"] == "知情人"
    # 写穿不撞其它事项的乐观锁（version 不变）
    assert service.get_matter(second["matter"]["public_id"])["matter"]["version"] == 2


def test_update_adding_email_links_contact(service):
    created = _create_matter(service, "m1")
    result = service.create_stakeholder(
        created["matter"]["public_id"],
        {"display_name": "Late Mail"},
        **_mutation(created["version"], "sh-late"),
    )
    assert result["stakeholder"]["contact_id"] is None
    patched = service.update_stakeholder(
        created["matter"]["public_id"],
        result["stakeholder"]["id"],
        {"email": "late@x.com"},
        **_mutation(result["version"], "sh-late-mail"),
    )
    contacts = _contact_rows(service)
    assert patched["stakeholder"]["contact_id"] == contacts["late@x.com"]["id"]


def test_changing_email_carries_the_row_identity_into_the_new_contact(service):
    """换邮箱、没同时改名 → 新联系人沿用本行姓名/组织，不是一条裸邮箱。

    create 路径本来就把姓名写进全局库，update 路径漏了 ⇒ 库里多出「只有邮箱」的人，
    在选人面板里就是一行光秃秃的地址。"""
    created = _create_matter(service, "m1")
    result = service.create_stakeholder(
        created["matter"]["public_id"],
        {"display_name": "Alice", "email": "alice@x.com", "organization": "ACME"},
        **_mutation(created["version"], "sh-a"),
    )
    patched = service.update_stakeholder(
        created["matter"]["public_id"],
        result["stakeholder"]["id"],
        {"email": "alice@new.com"},
        **_mutation(result["version"], "sh-a-newmail"),
    )
    contacts = _contact_rows(service)
    assert patched["stakeholder"]["contact_id"] == contacts["alice@new.com"]["id"]
    assert contacts["alice@new.com"]["display_name"] == "Alice"
    assert contacts["alice@new.com"]["organization"] == "ACME"


def test_changing_email_onto_an_existing_contact_does_not_rename_them(service):
    """兜底只填新建的空位：改到**别人**已在库里的邮箱，不许把那个人改名。"""
    first = _create_matter(service, "m1")
    second = _create_matter(service, "m2")
    a = service.create_stakeholder(
        first["matter"]["public_id"],
        {"display_name": "Alice", "email": "alice@x.com", "organization": "ACME"},
        **_mutation(first["version"], "sh-a"),
    )
    service.create_stakeholder(
        second["matter"]["public_id"],
        {"display_name": "Bob", "email": "bob@y.com", "organization": "BCorp"},
        **_mutation(second["version"], "sh-b"),
    )
    service.update_stakeholder(
        first["matter"]["public_id"],
        a["stakeholder"]["id"],
        {"email": "bob@y.com"},
        **_mutation(a["version"], "sh-a-tobob"),
    )
    contacts = _contact_rows(service)
    assert contacts["bob@y.com"]["display_name"] == "Bob"
    assert contacts["bob@y.com"]["organization"] == "BCorp"


def test_list_contacts_aggregates_and_search(service):
    first = _create_matter(service, "m1")
    second = _create_matter(service, "m2")
    service.create_stakeholder(
        first["matter"]["public_id"],
        {"display_name": "Alice", "email": "alice@x.com", "organization": "ACME"},
        **_mutation(first["version"], "sh-a"),
    )
    service.create_stakeholder(
        second["matter"]["public_id"],
        {"email": "alice@x.com"},
        **_mutation(second["version"], "sh-a2"),
    )
    service.create_stakeholder(
        first["matter"]["public_id"],
        {"display_name": "Bob", "email": "bob@y.com"},
        **_mutation(2, "sh-b"),
    )
    pool = service.list_contacts()
    assert [entry["email_normalized"] for entry in pool] == ["alice@x.com", "bob@y.com"]
    assert pool[0]["matter_count"] == 2
    assert pool[1]["matter_count"] == 1
    # 搜索命中姓名 / 邮箱 / 组织
    assert [e["email_normalized"] for e in service.list_contacts(query="acme")] == ["alice@x.com"]
    assert [e["email_normalized"] for e in service.list_contacts(query="bob@")] == ["bob@y.com"]
    assert service.list_contacts(query="nobody") == []


def _seed_emails(service: MatterService) -> None:
    rows = (
        # (internal_id, sender, sender_name, to_addr, cc_addr, date_received)
        (1, "alice@x.com", "Alice Old", "Me <me@corp.com>", None,
         "2026-08-01T08:00:00+00:00"),
        (2, "alice@x.com", "Alice New",
         "Bob <bob@y.com>, me@corp.com", "Carol Chen <carol@z.com>",
         "2026-08-10T08:00:00+00:00"),
        (3, "bob@y.com", "Bob",
         "me@corp.com", None, "2026-08-11T08:00:00+00:00"),
        # 非法地址 + 空 sender 行：不产出候选
        (4, "not-an-email", "Broken", None, None, "2026-08-12T08:00:00+00:00"),
    )
    with service.repository.connect() as conn:
        for row in rows:
            conn.execute(
                "INSERT INTO email_metadata "
                "(internal_id, sender, sender_name, to_addr, cc_addr, date_received) "
                "VALUES (?,?,?,?,?,?)",
                row,
            )
        conn.commit()


def test_extract_contact_candidates_scans_real_shapes(service):
    _seed_emails(service)
    candidates = service.extract_contact_candidates(exclude_emails=("me@corp.com",))
    by_email = {entry["email"]: entry for entry in candidates}
    # owner 自己的地址被排除
    assert "me@corp.com" not in by_email
    assert set(by_email) == {"alice@x.com", "bob@y.com", "carol@z.com"}
    # 频次：alice 2 次（两封 sender）、bob 2 次（sender + to）、carol 1 次
    assert by_email["alice@x.com"]["mail_count"] == 2
    assert by_email["bob@y.com"]["mail_count"] == 2
    assert by_email["carol@z.com"]["mail_count"] == 1
    # 显示名取最近一次非空（行按 date_received 降序扫）
    assert by_email["alice@x.com"]["display_name"] == "Alice New"
    assert by_email["carol@z.com"]["display_name"] == "Carol Chen"
    # 排序：频次降序，同频次按最近出现
    assert [entry["email"] for entry in candidates][:2] == ["bob@y.com", "alice@x.com"]
    # last_seen_at 是 epoch ms（取该地址最近出现的那封）
    from datetime import datetime

    expected = int(
        datetime.fromisoformat("2026-08-10T08:00:00+00:00").timestamp() * 1000
    )
    assert by_email["alice@x.com"]["last_seen_at"] == expected


def test_extract_contact_candidates_marks_library_membership_and_filters(service):
    _seed_emails(service)
    created = _create_matter(service, "m1")
    service.create_stakeholder(
        created["matter"]["public_id"],
        {"email": "alice@x.com", "display_name": "Alice"},
        **_mutation(created["version"], "sh-a"),
    )
    contacts = _contact_rows(service)
    candidates = service.extract_contact_candidates(exclude_emails=("me@corp.com",))
    by_email = {entry["email"]: entry for entry in candidates}
    assert by_email["alice@x.com"]["contact_id"] == contacts["alice@x.com"]["id"]
    assert by_email["bob@y.com"]["contact_id"] is None
    # query 过滤命中邮箱与姓名
    assert [e["email"] for e in service.extract_contact_candidates(query="carol")] == ["carol@z.com"]


@pytest.fixture
def client(tmp_path):
    from fastapi.testclient import TestClient

    from src.api.app import app
    from src.api.auth import verify_cf_access
    from src.api.deps import get_settings
    from src.api.routers.matters import get_matter_service

    path = tmp_path / "sync.db"
    SyncStore(str(path))
    service = MatterService(MatterRepository(path))
    settings = SimpleNamespace(
        matters_enabled=True,
        sync_store_db_path=str(path),
        user_email="me@corp.com",
    )
    app.dependency_overrides[verify_cf_access] = lambda: None
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_matter_service] = lambda: service
    with TestClient(app) as test_client:
        yield test_client, service
    app.dependency_overrides.clear()


def test_contacts_rest_endpoints(client):
    http, service = client
    _seed_emails(service)
    created = service.create_matter(
        {"title": "REST"}, idempotency_key="rest-m", source="desktop_ui"
    )
    service.create_stakeholder(
        created["matter"]["public_id"],
        {"email": "alice@x.com", "display_name": "Alice"},
        **_mutation(created["version"], "rest-sh"),
    )

    pool = http.get("/api/matters/contacts")
    assert pool.status_code == 200
    items = pool.json()["data"]["items"]
    assert [entry["email_normalized"] for entry in items] == ["alice@x.com"]

    extracted = http.get("/api/matters/contacts/email-candidates")
    assert extracted.status_code == 200
    emails = [entry["email"] for entry in extracted.json()["data"]["items"]]
    # owner 地址（settings.user_email）被服务端排除
    assert "me@corp.com" not in emails
    assert "bob@y.com" in emails

    filtered = http.get("/api/matters/contacts", params={"query": "nobody"})
    assert filtered.json()["data"]["items"] == []
