"""跨事项提案聚合端点 `GET /api/matters/updates`（perf-matters-request-fanout）。

钉四件事：空集 / 多事项多提案一次带齐（含 changes）/ 只回活跃事项 / 只回请求的评审状态。
逐事项的老端点 `GET /{id}/updates` 保留不动 —— 契约 additive，这里一并回归。
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
from src.api.auth import verify_cf_access
from src.api.deps import get_settings
from src.api.routers.matters import get_matter_service
from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.run_service import MatterRunService
from src.matters.service import MatterService

CHANGES = [
    {
        "id": "chg_01",
        "kind": "field",
        "target": {"entity": "matter", "field": "status"},
        "operation": "replace",
        "after": "active",
        "sources": [],
    },
    {"id": "chg_02", "kind": "action", "text": "回复客户确认日期", "sources": []},
]


@pytest.fixture
def env(tmp_path):
    path = tmp_path / "updates-batch.db"
    SyncStore(str(path))
    settings = SimpleNamespace(sync_store_db_path=str(path))
    service = MatterRunService(MatterRepository(path))
    app.dependency_overrides[verify_cf_access] = lambda: None
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_matter_service] = lambda: MatterService(
        MatterRepository(path)
    )
    with TestClient(app) as client:
        yield client, service
    app.dependency_overrides.clear()


def _matter(service: MatterRunService, title: str) -> str:
    created = service.create_matter(
        {"title": title}, idempotency_key=f"create-{title}", source="desktop_ui"
    )
    return created["matter"]["public_id"]


def _propose(service: MatterRunService, public_id: str, summary: str) -> int:
    """经真实 run 通道落一条 pending 提案（同 test_matter_review 的 `_insert_pending`）。

    末尾 `finish_run` 不是装饰：同一事项同时只允许一个活跃 run（`uq_matter_run_one_active`），
    不收尾的话下一次 `enqueue_run` 会被合并进上一条、`mark_started` 直接返 False。
    """
    version = service.get_matter(public_id)["matter"]["version"]
    run = service.enqueue_run(
        public_id,
        expected_version=version,
        idempotency_key=f"run-{public_id}-{summary}",
        source="desktop_ui",
    )["run"]
    assert service.mark_started(run["id"])
    result = service.propose_update(
        public_id, run["id"], {"summary": summary, "changes": CHANGES}
    )
    assert service.finish_run(run["id"], "ok")
    return int(result["update_id"])


def _items(response) -> list[dict]:
    assert response.status_code == 200, response.text
    return response.json()["data"]["items"]


def test_empty_when_no_proposals(env):
    http, service = env
    _matter(service, "无提案")
    assert _items(http.get("/api/matters/updates")) == []


def test_returns_every_live_matter_with_full_changes(env):
    http, service = env
    first = _matter(service, "甲")
    second = _matter(service, "乙")
    _propose(service, first, "甲-1")
    _propose(service, first, "甲-2")
    _propose(service, second, "乙-1")

    items = _items(http.get("/api/matters/updates?review_status=pending"))
    by_matter = {entry["matter_public_id"]: entry["updates"] for entry in items}
    assert set(by_matter) == {first, second}
    assert [update["summary"] for update in by_matter[first]] == ["甲-2", "甲-1"]
    assert [update["summary"] for update in by_matter[second]] == ["乙-1"]
    # 看板待审阅卡直接读 `changes`（数引用条数 / 判有没有字段级变化）——摘要不够用。
    update = by_matter[second][0]
    assert [change["id"] for change in update["changes"]] == ["chg_01", "chg_02"]
    assert update["change_count"] == 2
    assert update["review_status"] == "pending"
    assert update["is_stale"] is False
    assert "matter_public_id" not in update


def test_archived_and_trashed_matters_are_excluded(env):
    http, service = env
    live = _matter(service, "活跃")
    archived = _matter(service, "已归档")
    trashed = _matter(service, "回收站")
    _propose(service, live, "live-1")
    _propose(service, archived, "archived-1")
    _propose(service, trashed, "trashed-1")
    service.archive(
        archived,
        expected_version=service.get_matter(archived)["matter"]["version"],
        idempotency_key="archive",
        source="desktop_ui",
    )
    service.trash(
        trashed,
        expected_version=service.get_matter(trashed)["matter"]["version"],
        idempotency_key="trash",
        source="desktop_ui",
    )

    items = _items(http.get("/api/matters/updates"))
    assert [entry["matter_public_id"] for entry in items] == [live]


def test_reviewed_proposals_do_not_leak_into_pending(env):
    http, service = env
    public_id = _matter(service, "评审过")
    rejected = _propose(service, public_id, "会被拒绝")
    service.reject_update(
        public_id,
        rejected,
        reason="不需要",
        expected_version=service.get_matter(public_id)["matter"]["version"],
        idempotency_key="reject",
        source="desktop_ui",
    )
    kept = _propose(service, public_id, "仍待审")

    items = _items(http.get("/api/matters/updates"))
    assert [update["id"] for entry in items for update in entry["updates"]] == [kept]
    # 同一条按 rejected 查得到 —— 过滤的是状态，不是把行删了。
    rejected_items = _items(http.get("/api/matters/updates?review_status=rejected"))
    assert [update["id"] for entry in rejected_items for update in entry["updates"]] == [
        rejected
    ]


def test_invalid_review_status_is_rejected(env):
    http, _ = env
    response = http.get("/api/matters/updates?review_status=nope")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "E_INVALID_ARG"


def test_per_matter_endpoint_still_serves_summaries(env):
    http, service = env
    public_id = _matter(service, "老端点")
    update_id = _propose(service, public_id, "摘要面")
    response = http.get(f"/api/matters/{public_id}/updates?review_status=pending")
    assert response.status_code == 200
    items = response.json()["data"]["items"]
    assert [item["id"] for item in items] == [update_id]
