"""P4 runs REST（D10）+ binding PATCH（D2）+ flag 面（D11）。

- runs 面挂双 flag（matters + matter_agent）；updates 面只挂 matters 闸
  （agent flag 关掉仍可清账）。
- POST /runs：expected_version 不符 → E_VERSION_CONFLICT；活跃 → 200 coalesced。
- PATCH matter：绑定三键正常走 / instructions 超长拒 / 悬空 profile 只 warning。
"""

from __future__ import annotations

import os
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
from src.reports.store import ReportStore


@pytest.fixture
def env(tmp_path):
    path = tmp_path / "runs-api.db"
    SyncStore(str(path))
    ReportStore(str(path)).create_agent(
        "profile-1", type="custom", enabled=True, title="跟进小助手"
    )
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
    with TestClient(app) as client:
        created = client.post(
            "/api/matters",
            json={"title": "Runs Matter", "mutation": _mutation("create")},
        ).json()["data"]
        yield client, settings, run_service, created["matter"]["public_id"], created["version"]
    app.dependency_overrides.clear()


def _mutation(key: str, version: int | None = None):
    payload = {"source": "desktop_ui", "idempotency_key": key}
    if version is not None:
        payload["expected_version"] = version
    return payload


def test_runs_rest_roundtrip_and_coalesce(env):
    client, _, _, pid, version = env
    created = client.post(
        f"/api/matters/{pid}/runs", json={"mutation": _mutation("r1", version)}
    )
    assert created.status_code == 200
    data = created.json()["data"]
    assert data["coalesced"] is False
    run = data["run"]
    assert run["lifecycle_state"] == "queued"

    # 版本锚不符 → 409
    conflict = client.post(
        f"/api/matters/{pid}/runs", json={"mutation": _mutation("r2", version + 9)}
    )
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "E_VERSION_CONFLICT"

    # 活跃中再来 → 200 coalesced（expected_version 可缺省）
    merged = client.post(
        f"/api/matters/{pid}/runs", json={"mutation": _mutation("r3")}
    )
    assert merged.status_code == 200
    assert merged.json()["data"]["coalesced"] is True
    assert merged.json()["data"]["run"]["id"] == run["id"]

    listed = client.get(f"/api/matters/{pid}/runs")
    assert listed.status_code == 200
    items = listed.json()["data"]["items"]
    assert [item["id"] for item in items] == [run["id"]]
    assert items[0]["coalesced_trigger_count"] == 1

    detail = client.get(f"/api/matters/{pid}/runs/{run['id']}")
    assert detail.status_code == 200
    assert detail.json()["data"]["lifecycle_state"] == "queued"

    canceled = client.post(
        f"/api/matters/{pid}/runs/{run['id']}/cancel",
        json={"mutation": _mutation("c1")},
    )
    assert canceled.status_code == 200
    assert canceled.json()["data"]["run"]["lifecycle_state"] == "canceled"


def test_runs_surface_requires_agent_flag_but_updates_surface_does_not(env):
    client, settings, service, pid, version = env
    # 先在 flag on 时落一条 pending 提案
    run = service.enqueue_run(
        pid, expected_version=version, idempotency_key="k", source="desktop_ui"
    )["run"]
    assert service.mark_started(run["id"])
    update_id = service.propose_update(pid, run["id"], {"summary": "s", "changes": []})[
        "update_id"
    ]
    service.finish_run(run["id"], "ok")

    settings.matter_agent_enabled = False
    for method, url in (
        ("get", f"/api/matters/{pid}/runs"),
        ("get", f"/api/matters/{pid}/runs/{run['id']}"),
    ):
        response = getattr(client, method)(url)
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_DISABLED"
    response = client.post(
        f"/api/matters/{pid}/runs", json={"mutation": _mutation("r9")}
    )
    assert response.status_code == 403

    # updates/review 面只挂 matters 闸：agent flag off 仍可清账
    listed = client.get(f"/api/matters/{pid}/updates")
    assert listed.status_code == 200
    assert listed.json()["data"]["items"][0]["id"] == update_id
    current = service.get_matter(pid)["matter"]["version"]
    rejected = client.post(
        f"/api/matters/{pid}/updates/{update_id}/reject",
        json={"reason": "清账", "mutation": _mutation("rej", current)},
    )
    assert rejected.status_code == 200
    assert rejected.json()["data"]["update"]["review_status"] == "rejected"


def test_updates_accept_rest_shape(env):
    client, _, service, pid, version = env
    run = service.enqueue_run(
        pid, expected_version=version, idempotency_key="k", source="desktop_ui"
    )["run"]
    assert service.mark_started(run["id"])
    update_id = service.propose_update(
        pid,
        run["id"],
        {
            "summary": "建议激活",
            "changes": [
                {
                    "id": "chg_01",
                    "kind": "field",
                    "target": {"entity": "matter", "field": "status"},
                    "after": "active",
                    "sources": [],
                }
            ],
        },
    )["update_id"]
    detail = client.get(f"/api/matters/{pid}/updates/{update_id}")
    assert detail.status_code == 200
    assert detail.json()["data"]["update"]["changes"][0]["id"] == "chg_01"
    current = service.get_matter(pid)["matter"]["version"]
    accepted = client.post(
        f"/api/matters/{pid}/updates/{update_id}/accept",
        json={
            "selected_change_ids": ["chg_01"],
            "edited_summary": "确认激活",
            "mutation": _mutation("acc", current),
        },
    )
    assert accepted.status_code == 200
    data = accepted.json()["data"]
    assert data["matter"]["status"] == "active"
    assert data["matter"]["current_summary"] == "确认激活"
    assert data["update"]["review_status"] == "accepted"
    stale = client.post(
        f"/api/matters/{pid}/updates/{update_id}/accept",
        json={"mutation": _mutation("acc2", data["version"])},
    )
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "E_UPDATE_ALREADY_REVIEWED"


def test_binding_patch_three_keys_and_guards(env):
    client, _, service, pid, version = env
    patched = client.patch(
        f"/api/matters/{pid}",
        json={
            "agent_profile_id": "profile-1",
            "agent_enabled": True,
            "matter_instructions": "重点盯采购确认",
            "mutation": _mutation("bind", version),
        },
    )
    assert patched.status_code == 200
    data = patched.json()["data"]
    assert data["matter"]["agent_profile_id"] == "profile-1"
    assert data["matter"]["agent_enabled"] == 1
    assert data["matter"]["matter_instructions"] == "重点盯采购确认"
    assert data["warnings"] == []
    # 事件 agent_binding_changed
    timeline = client.get(f"/api/matters/{pid}/timeline").json()["data"]["items"]
    assert any(event["kind"] == "agent_binding_changed" for event in timeline)

    # 悬空 profile → 200 + warning（不硬拒）
    dangling = client.patch(
        f"/api/matters/{pid}",
        json={
            "agent_profile_id": "no-such-agent",
            "mutation": _mutation("bind2", data["version"]),
        },
    )
    assert dangling.status_code == 200
    assert "agent_profile_dangling" in dangling.json()["data"]["warnings"]

    # instructions 超长（>4000）→ 422（pydantic max_length 挡在 DTO 层）
    too_long = client.patch(
        f"/api/matters/{pid}",
        json={
            "matter_instructions": "x" * 4001,
            "mutation": _mutation("bind3", dangling.json()["data"]["version"]),
        },
    )
    assert too_long.status_code == 422

    # 解绑：显式 null
    unbound = client.patch(
        f"/api/matters/{pid}",
        json={
            "agent_profile_id": None,
            "mutation": _mutation("bind4", dangling.json()["data"]["version"]),
        },
    )
    assert unbound.status_code == 200
    assert unbound.json()["data"]["matter"]["agent_profile_id"] is None


def test_service_layer_rejects_overlong_instructions(env):
    """服务端等价校验（forceApproval 语义的后端面）：绕过 DTO 直调 service 也必须拒。"""
    _, _, service, pid, version = env
    from src.matters.service import MatterError

    with pytest.raises(MatterError) as excinfo:
        service.patch_matter(
            pid,
            {"matter_instructions": "x" * 4001},
            expected_version=service.get_matter(pid)["matter"]["version"],
            idempotency_key="long",
            source="desktop_ui",
        )
    assert excinfo.value.code == "E_INVALID_ARG"
