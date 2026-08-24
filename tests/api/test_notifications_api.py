"""GET/POST /api/notifications* — 通知中心 REST 端点 (task 08-20-notification-center 步骤 6)。

真 `NotifyCenter` + tmp SyncStore DB (v68 `notification` 表)，经
`app.dependency_overrides[get_notify_center]` 注入 (对齐 `test_matters_p3_api.py` 的
`get_matter_service` 覆盖写法)。鉴权走 `tests/api/conftest.py` 的 session 级 auth bypass
(`MAILAGENT_API_AUTH_DISABLED=true`)，不单独 override `verify_cf_access`。

覆盖: list 空/非空 wire 形状 + 非法 category/state → 400 + unread-count 按类目/按
severity 聚合 + read-all (全量/按类目) + 单条已读 + 不存在 id → 404;
M2 动作面 (批 B1): {id}/snooze (until / preset / CAS 守卫 / 重放) + {id}/resolve +
internal {publish} (本地 token 单腿鉴权 + 非法枚举 400 + dedupe 计次)。
"""

from __future__ import annotations

import pytest

import src.api.auth as auth_mod
import src.api.routers.notifications as notifications_router
from src.api.app import app
from src.mail.sync_store import SyncStore
from src.matters.attention import SNOOZE_3D_MS
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


def test_list_state_resolved_serves_history_view(client, notify_center):
    """面板「已处理」历史视图走的就是这条 query（前端独立 query key）。"""
    live = _publish(notify_center, dedupe_key="live")
    handled = _publish(notify_center, dedupe_key="handled")
    notify_center.resolve(handled.id)

    resp = client.get("/api/notifications", params={"state": "resolved"})
    assert resp.status_code == 200
    items = resp.json()["data"]
    assert [item["id"] for item in items] == [handled.id]
    assert items[0]["state"] == "resolved"
    assert items[0]["resolvedAt"] is not None  # 行上显示的处理时刻来自这个字段

    # 活跃那条视图不受影响（两个 lane 各取各的）
    assert [item["id"] for item in client.get("/api/notifications").json()["data"]] == [live.id]


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


def test_unread_count_by_severity(client, notify_center):
    """B1: bySeverity 轴 —— 铃铛 critical 红点档的数据源。"""
    _publish(notify_center, category="results", dedupe_key="r1")
    _publish(notify_center, category="system", dedupe_key="s1", severity="critical")
    _publish(notify_center, category="system", dedupe_key="s2", severity="warn")
    data = client.get("/api/notifications/unread-count").json()["data"]
    assert data["bySeverity"] == {"info": 1, "warn": 1, "critical": 1}
    assert sum(data["bySeverity"].values()) == data["total"]


def test_unread_count_open_by_category_axis(client, notify_center):
    """C5: openByCategory 轴 —— 铃铛收编 AgentPendingBadge 后的 level 型指示。

    wire 上是第三条键恒全的轴, 且**不随 read 掉**(这正是它与 byCategory 的分工)。
    """
    pending = _publish(notify_center, category="action_required", dedupe_key="p1")
    _publish(notify_center, category="results", dedupe_key="r1")
    client.post(f"/api/notifications/{pending.id}/read")
    data = client.get("/api/notifications/unread-count").json()["data"]
    assert data["byCategory"]["action_required"] == 0  # 已读 → 未读轴掉了
    assert data["openByCategory"] == {
        "action_required": 1,
        "reviews": 0,
        "results": 1,
        "system": 0,
    }


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


# ==================== POST /{id}/snooze (M2 批 B1) ====================


def _mutation(key: str) -> dict:
    """mutation 信封 (`test_matters_p3_api.py::_mutation` 同形)。"""
    return {"source": "desktop_ui", "idempotency_key": key}


def test_snooze_with_explicit_until(client, notify_center):
    result = _publish(notify_center, dedupe_key="s1")
    until = notify_center.clock_ms() + 60_000
    resp = client.post(
        f"/api/notifications/{result.id}/snooze",
        json={"mutation": _mutation("snooze-1"), "until": until},
    )
    assert resp.status_code == 200
    item = resp.json()["data"]
    assert item["state"] == "snoozed"
    assert item["snoozedUntil"] == until
    # 未到期 → 掉出 open 口径与未读数
    assert client.get("/api/notifications").json()["data"] == []
    assert client.get("/api/notifications/unread-count").json()["data"]["total"] == 0


def test_snooze_preset_3d_converted_in_router(client, notify_center):
    """preset 换算在路由层, 预设集与 matters attention 同源 (只有 3d)。"""
    result = _publish(notify_center, dedupe_key="s2")
    before = notify_center.clock_ms()
    resp = client.post(
        f"/api/notifications/{result.id}/snooze",
        json={"mutation": _mutation("snooze-2"), "preset": "3d"},
    )
    after = notify_center.clock_ms()
    assert resp.status_code == 200
    snoozed_until = resp.json()["data"]["snoozedUntil"]
    assert before + SNOOZE_3D_MS <= snoozed_until <= after + SNOOZE_3D_MS


def test_snooze_unknown_preset_returns_400(client, notify_center):
    """未知 preset 不静默忽略 (否则会以「until 缺失」的错误信息报出来)。"""
    result = _publish(notify_center, dedupe_key="s3")
    resp = client.post(
        f"/api/notifications/{result.id}/snooze",
        json={"mutation": _mutation("snooze-3"), "preset": "7d"},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_INVALID_ARG"
    assert "preset" in resp.json()["error"]["message"]


@pytest.mark.parametrize(
    "extra",
    [{}, {"until": 1, "preset": "3d"}],
    ids=["neither", "both"],
)
def test_snooze_requires_exactly_one_of_until_preset(client, notify_center, extra):
    result = _publish(notify_center, dedupe_key="s4")
    resp = client.post(
        f"/api/notifications/{result.id}/snooze",
        json={"mutation": _mutation("snooze-4"), **extra},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_INVALID_ARG"


def test_snooze_past_until_returns_400(client, notify_center):
    result = _publish(notify_center, dedupe_key="s5")
    resp = client.post(
        f"/api/notifications/{result.id}/snooze",
        json={"mutation": _mutation("snooze-5"), "until": 1},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_INVALID_ARG"


def test_snooze_closed_notification_returns_409(client, notify_center):
    """已关条目 (resolved) 被 core CAS 拒 → E_INVALID_STATE → 409。"""
    result = _publish(notify_center, dedupe_key="s6")
    notify_center.resolve(result.id)
    resp = client.post(
        f"/api/notifications/{result.id}/snooze",
        json={
            "mutation": _mutation("snooze-6"),
            "until": notify_center.clock_ms() + 60_000,
        },
    )
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "E_INVALID_STATE"


def test_snooze_missing_id_returns_404(client, notify_center):
    resp = client.post(
        "/api/notifications/999999/snooze",
        json={
            "mutation": _mutation("snooze-404"),
            "until": notify_center.clock_ms() + 60_000,
        },
    )
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "E_NOT_FOUND"


def test_snooze_idempotency_header_mismatch_returns_409(client, notify_center):
    result = _publish(notify_center, dedupe_key="s7")
    resp = client.post(
        f"/api/notifications/{result.id}/snooze",
        json={
            "mutation": _mutation("body-key"),
            "until": notify_center.clock_ms() + 60_000,
        },
        headers={"Idempotency-Key": "header-key"},
    )
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "E_IDEMPOTENCY_CONFLICT"


def test_snooze_replay_same_key_does_not_double_apply(client, notify_center):
    """重放安全靠 CAS + 终态一致, 不靠事件账本 (通知中心没有账本)。"""
    result = _publish(notify_center, dedupe_key="s8")
    until = notify_center.clock_ms() + 60_000
    body = {"mutation": _mutation("snooze-replay"), "until": until}
    headers = {"Idempotency-Key": "snooze-replay"}
    first = client.post(
        f"/api/notifications/{result.id}/snooze", json=body, headers=headers
    ).json()["data"]
    second = client.post(
        f"/api/notifications/{result.id}/snooze", json=body, headers=headers
    ).json()["data"]
    assert first == second  # 同 until 的重放落到同一终态, 无第二次副作用
    assert notify_center.list(state="snoozed").total == 1


# ==================== POST /{id}/resolve (M2 批 B1) ====================


def test_resolve_notification(client, notify_center):
    result = _publish(notify_center, dedupe_key="r1")
    resp = client.post(
        f"/api/notifications/{result.id}/resolve",
        json={"mutation": _mutation("resolve-1")},
        headers={"Idempotency-Key": "resolve-1"},
    )
    assert resp.status_code == 200
    item = resp.json()["data"]
    assert item["state"] == "resolved"
    assert item["resolvedAt"] is not None
    # read 与 resolve 是两个独立轴: resolve 不顺手标已读
    assert item["readAt"] is None
    # 但 resolved 行本就不计未读
    assert client.get("/api/notifications/unread-count").json()["data"]["total"] == 0


def test_resolve_replay_rejected_by_cas(client, notify_center):
    result = _publish(notify_center, dedupe_key="r2")
    body = {"mutation": _mutation("resolve-2")}
    first = client.post(f"/api/notifications/{result.id}/resolve", json=body)
    assert first.status_code == 200
    resolved_at = first.json()["data"]["resolvedAt"]
    second = client.post(f"/api/notifications/{result.id}/resolve", json=body)
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "E_INVALID_STATE"
    assert notify_center.get(result.id)["resolved_at"] == resolved_at  # 未被二次改写


def test_resolve_snoozed_notification_allowed(client, notify_center):
    """snoozed 也是活跃态 → 可直接 resolve; snoozed_until 一并清掉。"""
    result = _publish(notify_center, dedupe_key="r3")
    notify_center.snooze(result.id, until_ms=notify_center.clock_ms() + 60_000)
    resp = client.post(
        f"/api/notifications/{result.id}/resolve",
        json={"mutation": _mutation("resolve-3")},
    )
    assert resp.status_code == 200
    item = resp.json()["data"]
    assert item["state"] == "resolved" and item["snoozedUntil"] is None


def test_resolve_requires_mutation_envelope(client, notify_center):
    result = _publish(notify_center, dedupe_key="r4")
    resp = client.post(f"/api/notifications/{result.id}/resolve", json={})
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "E_INVALID_ARG"


# ==================== POST /publish (internal face, M2 批 B1) ====================


def _publish_body(**kw) -> dict:
    body = {
        "category": "system",
        "source": "updater",
        "title": "更新就绪",
        "dedupe_key": "app_update:2.17.0",
    }
    body.update(kw)
    return body


def test_publish_endpoint_returns_projection(client, notify_center):
    resp = client.post(
        "/api/notifications/publish",
        json=_publish_body(
            body="重启以安装", severity="info",
            payload={"link": {"type": "updater_restart"}},
        ),
    )
    assert resp.status_code == 200
    item = resp.json()["data"]
    assert item["category"] == "system"
    assert item["source"] == "updater"
    assert item["title"] == "更新就绪"
    assert item["body"] == "重启以安装"
    assert item["state"] == "open" and item["readAt"] is None
    assert item["recurrenceNo"] == 1
    assert item["payload"] == {"link": {"type": "updater_restart"}}
    assert "dedupeKey" not in item  # 单条投影不回 dedupe_key (M1 契约)
    assert notify_center.list(state="open").total == 1


def test_publish_endpoint_dedupes_into_recurrence(client, notify_center):
    """发布语义单源: 端点不复制 dedupe 逻辑, 计次由 NotifyCenter.publish 兜。"""
    first = client.post("/api/notifications/publish", json=_publish_body()).json()["data"]
    second = client.post(
        "/api/notifications/publish", json=_publish_body(title="更新就绪 (再次)")
    ).json()["data"]
    assert second["id"] == first["id"]
    assert second["recurrenceNo"] == 2
    assert second["title"] == "更新就绪 (再次)"
    assert notify_center.list(state="open").total == 1


@pytest.mark.parametrize(
    "override",
    [{"category": "bogus"}, {"severity": "fatal"}],
    ids=["category", "severity"],
)
def test_publish_endpoint_invalid_enum_returns_400(client, notify_center, override):
    """枚举校验留在 core (值域单源) → E_INVALID_ARG → 400, 不是 pydantic 的 422。"""
    resp = client.post("/api/notifications/publish", json=_publish_body(**override))
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "E_INVALID_ARG"


def test_publish_endpoint_rejects_unknown_body_key(client, notify_center):
    """请求体是 snake_case 单一拼法 (extra='forbid'): camelCase 变体不被默认接受。"""
    body = _publish_body()
    body["dedupeKey"] = body.pop("dedupe_key")
    resp = client.post("/api/notifications/publish", json=body)
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "E_INVALID_ARG"


def test_publish_endpoint_requires_local_token(client, notify_center, monkeypatch):
    """internal face 是 `verify_local_token` 单腿: 无 header → 403, 有 → 放行。

    (bypass 关掉才看得见这条腿 —— conftest 默认 `MAILAGENT_API_AUTH_DISABLED=true`。)
    """
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", "tok-abc")
    denied = client.post("/api/notifications/publish", json=_publish_body())
    assert denied.status_code == 403
    allowed = client.post(
        "/api/notifications/publish",
        json=_publish_body(),
        headers={auth_mod.LOCAL_TOKEN_HEADER: "tok-abc"},
    )
    assert allowed.status_code == 200


def test_publish_endpoint_rejects_valid_cf_session(client, notify_center, monkeypatch):
    """**合法** CF 会话也拒绝 —— internal face 根本不看 CF JWT (远程用户写不进通知行)。

    CF JWT 装配镜像 `test_llm_providers_api.py::_arm_cf_jwt`: 只断言「无本地 token
    被拒」不足以证明这条腿是 verify_local_token —— 那种断言在误挂成 verify_cf_access
    时同样是拒绝 (只是 401 而非 403)。
    """
    monkeypatch.setattr(auth_mod, "AUTH_DISABLED", False)
    monkeypatch.setattr(auth_mod, "_LOCAL_API_TOKEN", "tok-abc")

    class _Key:
        key = "irrelevant"

    monkeypatch.setattr(
        auth_mod._jwk_client, "get_signing_key_from_jwt", lambda _t: _Key()
    )
    monkeypatch.setattr(auth_mod.jwt, "decode", lambda *a, **k: {"email": "owner@x.com"})
    monkeypatch.setattr(auth_mod, "_resolve_allowed_emails", lambda: {"owner@x.com"})

    resp = client.post(
        "/api/notifications/publish",
        json=_publish_body(),
        headers={"Cf-Access-Jwt-Assertion": "valid-token"},
    )
    assert resp.status_code == 403
    assert notify_center.list(state="open").total == 0
    # 同一会话下 owner-facing 端点照常可用 (拒的只是 internal face)
    assert client.get(
        "/api/notifications", headers={"Cf-Access-Jwt-Assertion": "valid-token"}
    ).status_code == 200
