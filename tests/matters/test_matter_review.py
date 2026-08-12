"""P4 评审事务（D9）：accept 十步 / E_UPDATE_STALE / E_UPDATE_ALREADY_REVIEWED /
selected 子集 / edited 只引原 id / superseded 自动化 / reject bump version / stale 钩子。"""

from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.run_service import MatterRunService
from src.matters.service import MatterError

CHANGES = [
    {
        "id": "chg_01",
        "kind": "field",
        "target": {"entity": "matter", "field": "status"},
        "operation": "replace",
        "after": "active",
        "sources": [],
    },
    {
        "id": "chg_02",
        "kind": "action",
        "text": "回复客户确认日期",
        "sources": [],
    },
    {
        "id": "chg_03",
        "kind": "field",
        "target": {"entity": "matter", "field": "due_at"},
        "operation": "replace",
        "after": 1_700_000,
        "sources": [],
    },
]


@pytest.fixture
def env(tmp_path):
    path = tmp_path / "review.db"
    SyncStore(str(path))
    service = MatterRunService(MatterRepository(path), clock_ms=lambda: 55_000)
    created = service.create_matter(
        {"title": "Review Matter"}, idempotency_key="create", source="desktop_ui"
    )
    return service, created["matter"]["public_id"], created["version"], str(path)


def _insert_pending(service, pid, *, changes=None, summary="提案摘要", run=True):
    """经 propose 通道落一条 pending（走真实校验路径）。"""
    version = service.get_matter(pid)["matter"]["version"]
    if run:
        row = service.enqueue_run(
            pid, expected_version=version,
            idempotency_key=f"run-{service.clock_ms()}-{summary}",
            source="desktop_ui",
        )["run"]
        assert service.mark_started(row["id"])
        result = service.propose_update(
            pid, row["id"], {"summary": summary, "changes": changes or CHANGES}
        )
        return result["update_id"], row["id"]
    raise AssertionError("run must be true")


def test_accept_applies_selected_changes_and_bumps_version_once(env):
    service, pid, version, path = env
    update_id, run_id = _insert_pending(service, pid)
    before = service.get_matter(pid)["matter"]
    result = service.accept_update(
        pid,
        update_id,
        selected_change_ids=["chg_01", "chg_02"],
        edited_summary="编辑后的摘要",
        expected_version=before["version"],
        idempotency_key="acc-1",
        source="desktop_ui",
    )
    matter = result["matter"]
    assert matter["version"] == before["version"] + 1  # 恰 bump 一次
    assert matter["status"] == "active"  # chg_01 applied
    assert matter["due_at"] is None  # chg_03 未选 → 不应用
    assert matter["current_summary"] == "编辑后的摘要"
    assert matter["latest_accepted_update_id"] == update_id
    update = result["update"]
    assert update["review_status"] == "accepted"
    assert update["accepted_change_ids"] == ["chg_01", "chg_02"]
    assert update["reviewed_result"]["edited_summary"] == "编辑后的摘要"
    # chg_02（新增 action）落成 item
    items = service.list_items(pid)
    assert any(i["kind"] == "action" and i["title"] == "回复客户确认日期" for i in items)
    # 审计事件：update_accepted + 逐变更事件
    with sqlite3.connect(path) as conn:
        kinds = [
            row[0]
            for row in conn.execute(
                "SELECT kind FROM matter_event ORDER BY id"
            )
        ]
        attention_state = conn.execute(
            "SELECT state FROM matter_attention WHERE subject_key=? ORDER BY id DESC",
            (f"update:{update_id}",),
        ).fetchone()[0]
    assert "update_accepted" in kinds
    assert "item_created" in kinds
    assert attention_state == "resolved"


def test_accept_with_edited_change_uses_edited_after(env):
    service, pid, version, _ = env
    update_id, _ = _insert_pending(service, pid)
    before = service.get_matter(pid)["matter"]
    result = service.accept_update(
        pid,
        update_id,
        selected_change_ids=["chg_03"],
        edited_changes=[{"change_id": "chg_03", "after": 1_800_000}],
        expected_version=before["version"],
        idempotency_key="acc-1",
        source="desktop_ui",
    )
    assert result["matter"]["due_at"] == 1_800_000


def test_accept_rejects_unknown_selected_and_unselected_edit(env):
    service, pid, version, _ = env
    update_id, _ = _insert_pending(service, pid)
    before = service.get_matter(pid)["matter"]
    with pytest.raises(MatterError) as excinfo:
        service.accept_update(
            pid, update_id, selected_change_ids=["chg_99"],
            expected_version=before["version"], idempotency_key="a", source="s",
        )
    assert excinfo.value.code == "E_INVALID_ARG"
    with pytest.raises(MatterError) as excinfo:
        service.accept_update(
            pid, update_id,
            selected_change_ids=["chg_01"],
            edited_changes=[{"change_id": "chg_03", "after": 1}],
            expected_version=before["version"], idempotency_key="b", source="s",
        )
    assert excinfo.value.code == "E_INVALID_ARG"


def test_accept_already_reviewed_and_stale_paths(env):
    service, pid, version, _ = env
    update_id, _ = _insert_pending(service, pid)
    current = service.get_matter(pid)["matter"]["version"]
    service.accept_update(
        pid, update_id, expected_version=current,
        idempotency_key="acc-1", source="desktop_ui",
    )
    with pytest.raises(MatterError) as excinfo:
        service.accept_update(
            pid, update_id, expected_version=current + 1,
            idempotency_key="acc-2", source="desktop_ui",
        )
    assert excinfo.value.code == "E_UPDATE_ALREADY_REVIEWED"


def test_stale_hook_marks_pending_and_accept_rejects_stale(env):
    service, pid, version, path = env
    update_id, _ = _insert_pending(service, pid)
    # 与提案目标**重叠**的写路径（CHANGES 里 chg_03 改 due_at，这里也改 due_at）
    # 必须触发 stale 钩子。改无关字段不再触发 —— 见
    # test_matter_proposal_scope.py::test_unrelated_field_write_keeps_proposal_acceptable。
    current = service.get_matter(pid)["matter"]["version"]
    service.patch_matter(
        pid, {"due_at": 1_900_000}, expected_version=current,
        idempotency_key="patch-1", source="desktop_ui",
    )
    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT is_stale, stale_reason FROM matter_update WHERE id=?",
            (update_id,),
        ).fetchone()
    assert row["is_stale"] == 1
    assert row["stale_reason"] == "matter_version_advanced"
    new_version = service.get_matter(pid)["matter"]["version"]
    with pytest.raises(MatterError) as excinfo:
        service.accept_update(
            pid, update_id, expected_version=new_version,
            idempotency_key="acc-1", source="desktop_ui",
        )
    assert excinfo.value.code == "E_UPDATE_STALE"
    # stale 行仍可拒绝（拒绝 stale 合法）
    result = service.reject_update(
        pid, update_id, reason="过期不采纳", expected_version=new_version,
        idempotency_key="rej-1", source="desktop_ui",
    )
    assert result["update"]["review_status"] == "rejected"


def test_accept_supersedes_other_pendings(env):
    service, pid, version, path = env
    first_id, first_run = _insert_pending(service, pid, summary="第一份")
    # 第一份提案的 run 先收敛，才允许第二个 run 入队（单活跃）
    service.finish_run(first_run, "ok")
    second_id, _ = _insert_pending(service, pid, summary="第二份")
    current = service.get_matter(pid)["matter"]["version"]
    service.accept_update(
        pid, second_id, expected_version=current,
        idempotency_key="acc-1", source="desktop_ui",
    )
    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        first = conn.execute(
            "SELECT review_status FROM matter_update WHERE id=?", (first_id,)
        ).fetchone()
        first_attention = conn.execute(
            "SELECT state FROM matter_attention WHERE subject_key=? ORDER BY id DESC",
            (f"update:{first_id}",),
        ).fetchone()[0]
        kinds = [
            row[0] for row in conn.execute("SELECT kind FROM matter_event")
        ]
    assert first["review_status"] == "superseded"
    assert first_attention == "resolved"
    assert "update_superseded" in kinds


def test_reject_requires_reason_and_bumps_version(env):
    service, pid, version, path = env
    update_id, _ = _insert_pending(service, pid)
    before = service.get_matter(pid)["matter"]
    with pytest.raises(MatterError) as excinfo:
        service.reject_update(
            pid, update_id, reason="  ", expected_version=before["version"],
            idempotency_key="r0", source="desktop_ui",
        )
    assert excinfo.value.code == "E_INVALID_ARG"
    result = service.reject_update(
        pid, update_id, reason="信息不足", expected_version=before["version"],
        idempotency_key="r1", source="desktop_ui",
    )
    # version 照 bump（REST #3）；不应用任何 change
    assert result["matter"]["version"] == before["version"] + 1
    assert result["matter"]["status"] == before["status"]
    assert result["update"]["review_status"] == "rejected"
    assert result["update"]["review_reason"] == "信息不足"
    assert result["undo"] is None  # reject 无 undo
    with sqlite3.connect(path) as conn:
        kinds = [row[0] for row in conn.execute("SELECT kind FROM matter_event")]
        attention_state = conn.execute(
            "SELECT state FROM matter_attention WHERE subject_key=? ORDER BY id DESC",
            (f"update:{update_id}",),
        ).fetchone()[0]
    assert "update_rejected" in kinds
    assert attention_state == "dismissed"


def test_list_updates_page_summary_projection(env):
    service, pid, version, _ = env
    update_id, _ = _insert_pending(service, pid)
    page = service.list_updates_page(pid, review_status="pending")
    assert page["next_cursor"] is None
    item = page["items"][0]
    assert item["id"] == update_id
    assert item["review_status"] == "pending"
    assert item["change_count"] == len(CHANGES)
    assert item["is_stale"] is False
    assert item["agent_run_id"] is not None
    detail = service.get_update_detail(pid, update_id)["update"]
    assert [c["id"] for c in detail["changes"]] == ["chg_01", "chg_02", "chg_03"]
