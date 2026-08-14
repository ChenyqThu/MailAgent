"""W-C 全局干系人库：写侧隐式维护（upsert / 写穿 / 兜底建 contact / 重复早退）。

池查询（`list_contacts`）与一键邮件提取（`extract_contact_candidates`）已随通讯录
WP3 退役 —— picker 改读 `/api/contacts`，list 搜索的等价覆盖在
`tests/contacts/test_contacts_api.py`。本文件只钉 matters 侧仍活着的写穿语义。
"""

from __future__ import annotations

import pytest

from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.service import MatterService


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


def test_duplicate_create_same_person_early_returns_without_insert(service):
    """同事项同 person_key 重复 create → 早退返回 already_linked，不 INSERT。

    picker 的「已在事项中」置灰是 UI 层防线，这里钉住数据层兜底（service
    `_mutate_stakeholder` 的 duplicate 分支）：绕过 UI 直接重复添加同一个人
    （含大小写变体）也不会产出第二行。"""
    created = _create_matter(service, "m1")
    public_id = created["matter"]["public_id"]
    first = service.create_stakeholder(
        public_id,
        {"display_name": "Alice", "email": "alice@x.com"},
        **_mutation(created["version"], "sh-1"),
    )
    result = service.create_stakeholder(
        public_id,
        {"email": "ALICE@X.COM", "role": "审批人"},
        **_mutation(first["version"], "sh-2"),
    )
    assert result.get("warnings") == ["already_linked"]
    # 返回的是既有行（id 相同），第二次的 role 不落任何地方
    assert result["stakeholder"]["id"] == first["stakeholder"]["id"]
    rows = service.list_stakeholders(public_id)
    assert len(rows) == 1
    assert rows[0]["role"] is None
