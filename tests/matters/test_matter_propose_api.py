"""P4 propose 内部端点（D6）：防幻觉逐条剔除 / E_PROPOSAL_EXISTS / 不 bump version /
事件 / 双 flag 门。端点 = ``POST /api/matters/{id}/runs/{run_id}/proposal``
（verify_local_token 面，测试经 dependency override 放行）。"""

from __future__ import annotations

import os
import sqlite3
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
os.environ.setdefault("MAILAGENT_API_DEV", "true")
os.environ.setdefault("MAILAGENT_API_HOST", "127.0.0.1")

from src.api.app import app
from src.api.auth import verify_cf_access, verify_local_token
from src.api.deps import get_settings
from src.api.routers.matters import get_matter_run_service, get_matter_service
from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.run_service import MatterRunService
from src.matters.service import MatterService


@pytest.fixture
def env(tmp_path):
    path = tmp_path / "propose.db"
    SyncStore(str(path))
    settings = SimpleNamespace(
        matters_enabled=True, matter_agent_enabled=True, sync_store_db_path=str(path)
    )
    run_service = MatterRunService(MatterRepository(path))
    app.dependency_overrides[verify_cf_access] = lambda: None
    app.dependency_overrides[verify_local_token] = lambda: None
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_matter_service] = lambda: MatterService(
        MatterRepository(path)
    )
    app.dependency_overrides[get_matter_run_service] = lambda: run_service
    created = run_service.create_matter(
        {"title": "Propose Matter"}, idempotency_key="create", source="desktop_ui"
    )
    pid = created["matter"]["public_id"]
    linked = run_service.add_resource(
        pid,
        {"provider": "mailagent", "external_key": "doc:d1", "kind": "doc"},
        expected_version=created["version"],
        idempotency_key="link",
        source="desktop_ui",
    )
    resource_id = linked["resources"][0]["resource"]["id"]
    run = run_service.enqueue_run(
        pid, expected_version=linked["version"], idempotency_key="run-1",
        source="desktop_ui",
    )["run"]
    assert run_service.mark_started(run["id"])
    with TestClient(app) as client:
        yield client, settings, run_service, pid, run["id"], resource_id, str(path)
    app.dependency_overrides.clear()


def _url(pid, run_id):
    return f"/api/matters/{pid}/runs/{run_id}/proposal"


def test_propose_creates_pending_update_without_version_bump(env):
    client, _, service, pid, run_id, resource_id, path = env
    version_before = service.get_matter(pid)["matter"]["version"]
    response = client.post(
        _url(pid, run_id),
        json={
            "summary": "客户确认了日期",
            "changes": [
                {
                    "id": "chg_01",
                    "kind": "fact",
                    "text": "客户确认 9/1 启动",
                    "sources": [{"resource_id": resource_id, "evidence": "见摘录"}],
                },
                {
                    "id": "chg_02",
                    "kind": "field",
                    "target": {"entity": "matter", "field": "status"},
                    "after": "active",
                    "sources": [],
                },
            ],
            "open_questions": ["是否需要采购确认？"],
            "confidence": 0.8,
        },
    )
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["dropped"] == []
    update_id = data["update_id"]
    assert update_id is not None
    # 不 bump matter.version（提案不是 aggregate 变更）
    assert service.get_matter(pid)["matter"]["version"] == version_before
    detail = service.get_update_detail(pid, update_id)["update"]
    assert detail["review_status"] == "pending"
    assert detail["created_by_kind"] == "agent"
    assert detail["agent_run_id"] == run_id
    assert detail["anchored_matter_version"] == version_before
    assert detail["original_proposal"]["open_questions"] == ["是否需要采购确认？"]
    assert detail["citations"][0]["resource_id"] == resource_id
    with sqlite3.connect(path) as conn:
        kinds = [row[0] for row in conn.execute("SELECT kind FROM matter_event")]
    assert "update_proposed" in kinds


def test_propose_validation_drops_each_rule(env):
    client, _, service, pid, run_id, resource_id, _ = env
    response = client.post(
        _url(pid, run_id),
        json={
            "summary": "混合提案",
            "changes": [
                # fact 无 source → 剔
                {"id": "chg_01", "kind": "fact", "text": "无源事实", "sources": []},
                # fact 的 source 指向非关联资源 → source 剔 → fact 失源 → 剔
                {
                    "id": "chg_02", "kind": "fact", "text": "外源事实",
                    "sources": [{"resource_id": 99_999}],
                },
                # field=description 永不允许 → 剔
                {
                    "id": "chg_03", "kind": "field",
                    "target": {"entity": "matter", "field": "description"},
                    "after": "x", "sources": [],
                },
                # field 不在白名单 → 剔
                {
                    "id": "chg_04", "kind": "field",
                    "target": {"entity": "matter", "field": "title"},
                    "after": "x", "sources": [],
                },
                # action target 不存在 → 剔
                {
                    "id": "chg_05", "kind": "action",
                    "target": {"entity": "item", "id": 424_242},
                    "after": "done", "sources": [],
                },
                # inference → 保留 + is_inference 强制回填
                {
                    "id": "chg_06", "kind": "inference",
                    "text": "推断客户在等报价", "is_inference": False, "sources": [],
                },
                # 新增 action 无 target → 合法保留
                {"id": "chg_07", "kind": "action", "text": "跟进采购", "sources": []},
            ],
        },
    )
    assert response.status_code == 200
    data = response.json()["data"]
    dropped_ids = {entry["id"] for entry in data["dropped"]}
    assert dropped_ids == {"chg_01", "chg_02", "chg_03", "chg_04", "chg_05"}
    reasons = {entry["id"]: entry["reason"] for entry in data["dropped"]}
    assert reasons["chg_01"] == "fact_without_source"
    assert reasons["chg_02"] == "fact_without_source"
    assert reasons["chg_03"] == "field_not_allowed"
    assert reasons["chg_04"] == "field_not_allowed"
    assert reasons["chg_05"] == "action_target_missing"
    detail = service.get_update_detail(pid, data["update_id"])["update"]
    kept = {c["id"]: c for c in detail["changes"]}
    assert set(kept) == {"chg_06", "chg_07"}
    assert kept["chg_06"]["is_inference"] is True
    # 剔除明细暂存进 run.error_json（worker 终态凭它判 warn）
    run = service.get_run(run_id)
    assert {d["id"] for d in service.dropped_of(run)} == dropped_ids


def test_propose_all_dropped_without_summary_creates_no_update(env):
    client, _, service, pid, run_id, _, _ = env
    response = client.post(
        _url(pid, run_id),
        json={
            "changes": [
                {"id": "chg_01", "kind": "fact", "text": "无源", "sources": []},
            ],
        },
    )
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["update_id"] is None
    assert len(data["dropped"]) == 1
    assert service.update_id_for_run(run_id) is None


def test_propose_twice_is_conflict(env):
    client, _, service, pid, run_id, _, _ = env
    first = client.post(_url(pid, run_id), json={"summary": "第一次", "changes": []})
    assert first.status_code == 200
    second = client.post(_url(pid, run_id), json={"summary": "第二次", "changes": []})
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "E_PROPOSAL_EXISTS"


def test_propose_requires_started_run(env):
    client, _, service, pid, run_id, _, _ = env
    # 先收敛现有 run，再造一个 queued（未 started）的
    service.finish_run(run_id, "ok")
    queued = service.enqueue_run(
        pid,
        expected_version=service.get_matter(pid)["matter"]["version"],
        idempotency_key="run-2",
        source="desktop_ui",
    )["run"]
    response = client.post(_url(pid, queued["id"]), json={"summary": "早", "changes": []})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "E_INVALID_STATE"


def test_propose_flag_gates(env):
    client, settings, service, pid, run_id, _, _ = env
    settings.matter_agent_enabled = False
    response = client.post(_url(pid, run_id), json={"summary": "x", "changes": []})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "E_DISABLED"
    settings.matter_agent_enabled = True
    settings.matters_enabled = False
    response = client.post(_url(pid, run_id), json={"summary": "x", "changes": []})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "E_DISABLED"


def test_propose_carries_a_new_resource_link_over_the_wire(env):
    """0812：新形状（change.resource + sources[].change_id）要真的穿得过 pydantic。

    provider 取 ``web`` —— 它在 builtin 白名单里，不依赖任何 connector 连接状态，所以这条
    测试钉的是**线上形状**而不是白名单（白名单裁决在 test_matter_resource_proposal.py）。
    """
    client, _, service, pid, run_id, _, _ = env
    response = client.post(
        _url(pid, run_id),
        json={
            "summary": "供应商发了故障通告",
            "changes": [
                {
                    "id": "chg_res",
                    "kind": "resource",
                    "operation": "add",
                    "resource": {
                        "provider": "web",
                        "kind": "url",
                        "external_key": "https://status.example.test/incident/42",
                        "title": "故障通告",
                        "summary": "状态页登记了一次 API 网关故障，14:20 已恢复。",
                        "diff": "影响面从 3 个区域改成 5 个，恢复时间由 14:05 更正为 14:20。",
                    },
                    "text": "供应商状态页登记了本次故障",
                    "sources": [],
                },
                {
                    "id": "chg_fact",
                    "kind": "fact",
                    "text": "故障已于 14:20 恢复",
                    "sources": [{"change_id": "chg_res", "evidence": "状态页时间线"}],
                },
            ],
        },
    )
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["dropped"] == []
    detail = service.get_update_detail(pid, data["update_id"])["update"]
    kept = {c["id"]: c for c in detail["changes"]}
    # 服务端归一后的身份（canonical_url 由 external_key 兜底），不是模型原话。
    # 🔴 逐字相等而不是子集：`summary`（批 M6）/ `diff`（批 M7）就是靠这条断言证明它们
    # **穿过了 pydantic**—— DTO 是 extra=forbid，漏加字段时上面的 200 会先变 422，而这里
    # 锁住它没有被归一层静默丢掉。
    assert kept["chg_res"]["resource"] == {
        "provider": "web",
        "kind": "url",
        "external_key": "https://status.example.test/incident/42",
        "title": "故障通告",
        "canonical_url": "https://status.example.test/incident/42",
        "summary": "状态页登记了一次 API 网关故障，14:20 已恢复。",
        "diff": "影响面从 3 个区域改成 5 个，恢复时间由 14:05 更正为 14:20。",
    }
    assert kept["chg_fact"]["sources"] == [
        {"change_id": "chg_res", "evidence": "状态页时间线"}
    ]


def test_propose_schema_forbids_anchor_fields(env):
    client, _, _, pid, run_id, _, _ = env
    response = client.post(
        _url(pid, run_id),
        json={"summary": "x", "changes": [], "anchored_matter_version": 1},
    )
    assert response.status_code == 422  # extra=forbid：锚字段结构性传不进
