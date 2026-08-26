"""行动项交付内部端点（task 08-25 批次 3，Lane 2）：
``POST /api/matters/{id}/item-dispatches/{dispatch_id}/report``。

只钉 HTTP 边界上说了算的事（业务语义由 `tests/matters/test_item_dispatch_run.py` 覆盖）：
DTO 形状（extra=forbid，锚字段结构上传不进来）/ 错误码 → HTTP 映射（重复交付恒 409，
不是伪装成 500 的崩溃）/ 鉴权面（verify_local_token 腿，与提案端点同档）。
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
from src.sync.async_jobs import AsyncJobRepository


@pytest.fixture
def env(tmp_path):
    path = tmp_path / "item-report.db"
    SyncStore(str(path))
    settings = SimpleNamespace(sync_store_db_path=str(path))
    service = MatterRunService(MatterRepository(path))
    app.dependency_overrides[verify_cf_access] = lambda: None
    app.dependency_overrides[verify_local_token] = lambda: None
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_matter_service] = lambda: MatterService(
        MatterRepository(path)
    )
    app.dependency_overrides[get_matter_run_service] = lambda: service
    matter = service.create_matter(
        {"title": "Report Matter"}, idempotency_key="m", source="desktop_ui"
    )
    pid = str(matter["matter"]["public_id"])
    item = service.create_item(
        pid,
        {"kind": "action", "title": "回签补充协议"},
        expected_version=matter["version"],
        idempotency_key="i",
        source="desktop_ui",
    )
    dispatch = service.dispatch_item(
        pid, int(item["item"]["id"]), idempotency_key="d", source="desktop_ui"
    )["dispatch"]
    job = AsyncJobRepository(str(path)).claim_next(types=AsyncJobRepository.AGENT_JOB_TYPES)
    assert service.mark_dispatch_started(int(dispatch["id"]), async_job_id=job.job_id)
    with TestClient(app) as client:
        yield client, service, pid, int(dispatch["id"]), int(item["item"]["id"])
    app.dependency_overrides.clear()


def _url(pid: str, dispatch_id: int) -> str:
    return f"/api/matters/{pid}/item-dispatches/{dispatch_id}/report"


def test_report_returns_the_dispatch_state_and_proposal(env):
    client, _, pid, dispatch_id, item_id = env

    resp = client.post(
        _url(pid, dispatch_id),
        json={
            "summary": "已回签。",
            "changes": [
                {
                    "id": "chg_01",
                    "kind": "action",
                    "target": {"entity": "item", "id": item_id},
                    "after": "done",
                }
            ],
        },
    )

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["state"] == "proposed"
    assert data["update_id"] is not None
    assert data["dropped"] == []


def test_needs_input_shape_is_accepted(env):
    client, _, pid, dispatch_id, _ = env

    resp = client.post(
        _url(pid, dispatch_id),
        json={"needs_input": {"question": "用哪个主体？", "options": ["A", "B"]}},
    )

    assert resp.status_code == 200
    assert resp.json()["data"]["state"] == "awaiting_input"


def test_delivering_twice_is_409_not_500(env):
    """🔴 未登记的错误码会兜底成 500 —— 「这一轮已经报过了」不许伪装成服务端崩溃。"""
    client, _, pid, dispatch_id, _ = env
    assert client.post(_url(pid, dispatch_id), json={"summary": "第一次"}).status_code == 200

    resp = client.post(_url(pid, dispatch_id), json={"summary": "第二次"})

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "E_INVALID_STATE"


def test_both_shapes_at_once_is_400(env):
    client, _, pid, dispatch_id, _ = env

    resp = client.post(
        _url(pid, dispatch_id),
        json={"summary": "写了一半", "needs_input": {"question": "还有个问题"}},
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_INVALID_ARG"


def test_anchor_fields_are_structurally_unreachable(env):
    """extra=forbid：模型没法在 body 里指定别的事项 / 别的派发（锚只在 path 上）。"""
    client, _, pid, dispatch_id, _ = env

    resp = client.post(
        _url(pid, dispatch_id),
        json={"summary": "越权尝试", "dispatch_id": 999, "matter_id": "MT-XXXX"},
    )

    assert resp.status_code == 422


def test_unknown_dispatch_is_404(env):
    client, _, pid, _, _ = env

    resp = client.post(_url(pid, 999_999), json={"summary": "无主交付"})

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "E_CHILD_NOT_FOUND"
