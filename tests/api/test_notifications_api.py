"""GET/POST /api/notifications* — 通知中心 REST 端点 (task 08-20-notification-center 步骤 6)。

真 `NotifyCenter` + tmp SyncStore DB (v68 `notification` 表)，经
`app.dependency_overrides[get_notify_center]` 注入 (对齐 `test_matters_p3_api.py` 的
`get_matter_service` 覆盖写法)。鉴权走 `tests/api/conftest.py` 的 session 级 auth bypass
(`MAILAGENT_API_AUTH_DISABLED=true`)，不单独 override `verify_cf_access`。

覆盖: list 空/非空 wire 形状 + 非法 category/state → 400 + unread-count 按类目聚合 +
read-all (全量/按类目) + 单条已读 + 不存在 id → 404。
"""

from __future__ import annotations

import pytest

import src.api.routers.notifications as notifications_router
from src.api.app import app
from src.mail.sync_store import SyncStore
from src.notify.center import NotifyCenter


@pytest.fixture
def notify_center(tmp_path):
    db = tmp_path / "sync.db"
    SyncStore(str(db))  # 建全表 (含 v68 notification)
    center = NotifyCenter(str(db))
    app.dependency_overrides[notifications_router.get_notify_center] = lambda: center
    yield center
    app.dependency_overrides.pop(notifications_router.get_notify_center, None)


def _publish(center: NotifyCenter, **kw):
    defaults = dict(
        category="results", source="agent_run", title="标题", dedupe_key="k1",
        emit_event=False,
    )
    defaults.update(kw)
    return center.publish(**defaults)


# ==================== GET /api/notifications ====================


def test_list_empty_default(client, notify_center):
    resp = client.get("/api/notifications")
    assert resp.status_code == 200
    body = resp.json()
    assert body["data"] == []
    assert body["meta"]["total"] == 0
    assert body["meta"]["unread"] == 0
    assert body["meta"]["count"] == 0


def test_list_returns_camelcase_wire_shape(client, notify_center):
    result = _publish(
        notify_center, body="摘要", payload={"link": {"type": "route", "to": "/x"}}
    )
    resp = client.get("/api/notifications")
    assert resp.status_code == 200
    items = resp.json()["data"]
    assert len(items) == 1
    item = items[0]
    assert item["id"] == result.id
    assert item["category"] == "results"
    assert item["state"] == "open"
    assert item["recurrenceNo"] == 1
    assert item["firstCreatedAt"] is not None
    assert item["lastEventAt"] is not None
    assert item["readAt"] is None
    assert item["payload"] == {"link": {"type": "route", "to": "/x"}}
    # dedupe_key 是服务端去重实现细节，design §5 单条投影不上线
    assert "dedupeKey" not in item and "dedupe_key" not in item
    meta = resp.json()["meta"]
    assert meta["total"] == 1
    assert meta["unread"] == 1
    assert meta["count"] == 1


def test_list_invalid_category_returns_400(client, notify_center):
    resp = client.get("/api/notifications", params={"category": "bogus"})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_INVALID_ARG"


def test_list_invalid_state_returns_400(client, notify_center):
    resp = client.get("/api/notifications", params={"state": "bogus"})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_INVALID_ARG"


def test_list_unread_only_filters(client, notify_center):
    r1 = _publish(notify_center, dedupe_key="a")
    _publish(notify_center, dedupe_key="b")
    notify_center.mark_read(r1.id)
    resp = client.get("/api/notifications", params={"unreadOnly": "true"})
    items = resp.json()["data"]
    assert len(items) == 1
    assert items[0]["id"] != r1.id


# ==================== GET /api/notifications/unread-count ====================


def test_unread_count_by_category(client, notify_center):
    _publish(notify_center, category="results", dedupe_key="r1")
    _publish(notify_center, category="system", dedupe_key="s1", severity="critical")
    resp = client.get("/api/notifications/unread-count")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["total"] == 2
    assert data["byCategory"]["results"] == 1
    assert data["byCategory"]["system"] == 1
    assert data["byCategory"]["action_required"] == 0


# ==================== POST /api/notifications/read-all ====================


def test_read_all_clears_unread(client, notify_center):
    _publish(notify_center, dedupe_key="a")
    _publish(notify_center, dedupe_key="b")
    resp = client.post("/api/notifications/read-all")
    assert resp.status_code == 200
    assert resp.json()["data"]["updated"] == 2
    resp2 = client.get("/api/notifications/unread-count")
    assert resp2.json()["data"]["total"] == 0


def test_read_all_scoped_to_category(client, notify_center):
    _publish(notify_center, category="results", dedupe_key="a")
    _publish(notify_center, category="system", dedupe_key="b")
    resp = client.post("/api/notifications/read-all", json={"category": "results"})
    assert resp.status_code == 200
    assert resp.json()["data"]["updated"] == 1
    resp2 = client.get("/api/notifications/unread-count")
    data = resp2.json()["data"]
    assert data["byCategory"]["results"] == 0
    assert data["byCategory"]["system"] == 1


# ==================== POST /api/notifications/{id}/read ====================


def test_read_single_notification(client, notify_center):
    result = _publish(notify_center, dedupe_key="one")
    resp = client.post(f"/api/notifications/{result.id}/read")
    assert resp.status_code == 200
    item = resp.json()["data"]
    assert item["id"] == result.id
    assert item["readAt"] is not None
    resp2 = client.get("/api/notifications/unread-count")
    assert resp2.json()["data"]["total"] == 0


def test_read_single_notification_is_idempotent(client, notify_center):
    result = _publish(notify_center, dedupe_key="one")
    first = client.post(f"/api/notifications/{result.id}/read").json()["data"]
    second = client.post(f"/api/notifications/{result.id}/read").json()["data"]
    assert first["readAt"] == second["readAt"]


def test_read_missing_id_returns_404(client, notify_center):
    resp = client.post("/api/notifications/999999/read")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "E_NOT_FOUND"
