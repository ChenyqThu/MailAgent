"""0813 A3 —— 时间戳单位约定显式化：全链 epoch **毫秒**，秒值在服务边界被拒。

活库实证：agent 经 gateway 工具把 2026 年的截止日期写成 1786895999（epoch 秒），全链按
毫秒解释 = 1970-01-21；attention 判「逾期」恒真。tool schema 侧已加单位 description，
这里钉服务端的硬闸（`MatterService._require_epoch_ms`，覆盖 REST/gateway/提案三条门）：

- 合法区间 [10^12, 10^15)（2001..33658 年）；秒值报错并提示 ×1000；
- 覆盖 matter.due_at（create/patch）、item.due_at/completed_at、stakeholder.last_contact_at、
  提案 field/action change 的 due_at（propose 侧 fail-closed 剔除 + accept 侧 backstop）。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.run_service import MatterRunService
from src.matters.service import MatterError, MatterService

SECONDS_2026 = 1_786_895_999  # owner 活库里那条脏行动项的原值（epoch 秒）
MS_2026 = 1_786_895_999_000


@pytest.fixture
def env(tmp_path):
    path = tmp_path / "units.db"
    SyncStore(str(path))
    service = MatterService(MatterRepository(path), clock_ms=lambda: 1_786_600_000_000)
    created = service.create_matter(
        {"title": "Unit guard"}, idempotency_key="create", source="desktop_ui"
    )
    return service, created["matter"]["public_id"], str(path)


def mutation(version: int, key: str) -> dict:
    return {"expected_version": version, "idempotency_key": key, "source": "desktop_ui"}


def test_item_due_at_seconds_rejected_with_unit_hint(env):
    service, public_id, _ = env
    with pytest.raises(MatterError) as exc:
        service.create_item(
            public_id,
            {"kind": "action", "title": "跟进", "due_at": SECONDS_2026},
            **mutation(1, "item-sec"),
        )
    assert exc.value.code == "E_INVALID_ARG"
    assert "MILLISECONDS" in str(exc.value)
    assert "multiply by 1000" in str(exc.value)


def test_item_due_at_ms_roundtrips_write_storage_projection(env):
    """真实 2026 日期穿链：写入 → SQLite 存储值 → API 投影，单位一致不缩水。"""
    service, public_id, path = env
    created = service.create_item(
        public_id,
        {"kind": "action", "title": "跟进", "due_at": MS_2026},
        **mutation(1, "item-ms"),
    )
    item_id = created["item"]["id"]
    assert created["item"]["due_at"] == MS_2026
    with sqlite3.connect(path) as conn:
        stored = conn.execute(
            "SELECT due_at FROM matter_item WHERE id=?", (item_id,)
        ).fetchone()[0]
    assert stored == MS_2026  # 存储层就是毫秒，不做任何静默换算
    projected = service.get_matter(public_id, include=["items"])["items"][0]
    assert projected["due_at"] == MS_2026
    # completed_at 同一道闸。
    with pytest.raises(MatterError) as exc:
        service.update_item(
            public_id,
            item_id,
            {"completed_at": SECONDS_2026},
            **mutation(created["version"], "done-sec"),
        )
    assert exc.value.code == "E_INVALID_ARG"


def test_matter_due_at_guard_on_create_and_patch(env):
    service, public_id, _ = env
    with pytest.raises(MatterError) as exc:
        service.create_matter(
            {"title": "bad", "due_at": SECONDS_2026},
            idempotency_key="create-bad",
            source="desktop_ui",
        )
    assert exc.value.code == "E_INVALID_ARG"
    with pytest.raises(MatterError) as exc:
        service.patch_matter(public_id, {"due_at": SECONDS_2026}, **mutation(1, "p-sec"))
    assert exc.value.code == "E_INVALID_ARG"
    ok = service.patch_matter(public_id, {"due_at": MS_2026}, **mutation(1, "p-ms"))
    assert ok["matter"]["due_at"] == MS_2026
    cleared = service.patch_matter(
        public_id, {"due_at": None}, **mutation(ok["version"], "p-null")
    )
    assert cleared["matter"]["due_at"] is None  # null 照常放行


def test_stakeholder_last_contact_guard(env):
    service, public_id, _ = env
    with pytest.raises(MatterError) as exc:
        service.create_stakeholder(
            public_id,
            {"display_name": "甲", "last_contact_at": SECONDS_2026},
            **mutation(1, "stk-sec"),
        )
    assert exc.value.code == "E_INVALID_ARG"
    created = service.create_stakeholder(
        public_id,
        {"display_name": "甲", "last_contact_at": MS_2026},
        **mutation(1, "stk-ms"),
    )
    assert created["stakeholder"]["last_contact_at"] == MS_2026
    with pytest.raises(MatterError) as exc:
        service.update_stakeholder(
            public_id,
            created["stakeholder"]["id"],
            {"last_contact_at": SECONDS_2026},
            **mutation(created["version"], "stk-edit"),
        )
    assert exc.value.code == "E_INVALID_ARG"


def test_proposal_due_at_seconds_dropped_at_propose_side(tmp_path):
    """propose 侧 fail-closed：秒值 change 被剔除并记 dropped 明细（agent 当轮可自纠）。"""
    path = tmp_path / "propose.db"
    SyncStore(str(path))
    service = MatterRunService(MatterRepository(path), clock_ms=lambda: 1_786_600_000_000)
    created = service.create_matter(
        {"title": "Proposal"}, idempotency_key="create", source="desktop_ui"
    )
    changes = [
        {
            "id": "chg_sec",
            "kind": "field",
            "target": {"entity": "matter", "field": "due_at"},
            "after": SECONDS_2026,
            "sources": [],
        },
        {
            "id": "chg_ms",
            "kind": "field",
            "target": {"entity": "matter", "field": "due_at"},
            "after": MS_2026,
            "sources": [],
        },
    ]
    with service.repository.transaction() as conn:
        matter = service.repository.get_matter(conn, created["matter"]["public_id"])
        validated, dropped = service._validate_changes(conn, matter, changes)
    assert [change["id"] for change in validated] == ["chg_ms"]
    assert dropped == [
        {
            "id": "chg_sec",
            "kind": "field",
            "reason": "timestamp_not_epoch_ms",
            "field": "due_at",
            "value": SECONDS_2026,
        }
    ]


def test_accept_backstop_rejects_seconds_in_edited_change(env):
    """accept 侧 backstop：owner 编辑值（或旧存量提案）带秒值 → E_INVALID_ARG 不落库。"""
    service, public_id, path = env
    matter = service.get_matter(public_id)["matter"]
    with sqlite3.connect(path) as conn:
        cursor = conn.execute(
            "INSERT INTO matter_update(matter_id,review_status,anchored_matter_version,"
            "original_proposal_json,changes_json,citations_json,created_by_kind,created_at) "
            "VALUES (?,'pending',?, '{}', ?, '[]','agent',1)",
            (
                matter["id"],
                matter["version"],
                '[{"id":"chg_01","kind":"field",'
                '"target":{"entity":"matter","field":"due_at"},"after":1786895999}]',
            ),
        )
        update_id = cursor.lastrowid
        conn.commit()
    with pytest.raises(MatterError) as exc:
        service.accept_update(
            public_id,
            update_id,
            selected_change_ids=["chg_01"],
            expected_version=matter["version"],
            idempotency_key="acc",
            source="desktop_ui",
        )
    assert exc.value.code == "E_INVALID_ARG"
    assert service.get_matter(public_id)["matter"]["due_at"] is None  # 未落库