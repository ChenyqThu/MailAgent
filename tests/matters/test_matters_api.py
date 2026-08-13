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
from src.matters.service import MatterService


@pytest.fixture
def client(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    settings = SimpleNamespace(matters_enabled=True, sync_store_db_path=str(path))
    app.dependency_overrides[verify_cf_access] = lambda: None
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_matter_service] = lambda: MatterService(
        MatterRepository(path)
    )
    with TestClient(app) as test_client:
        yield test_client, settings
    app.dependency_overrides.clear()


def _mutation(key: str, version: int | None = None):
    payload = {"source": "desktop_ui", "idempotency_key": key}
    if version is not None:
        payload["expected_version"] = version
    return payload


def test_matter_rest_smoke(client):
    http, _ = client
    created = http.post(
        "/api/matters",
        json={"title": "API Matter", "mutation": _mutation("create")},
    )
    assert created.status_code == 201
    matter = created.json()["data"]["matter"]

    listed = http.get("/api/matters")
    assert listed.status_code == 200
    assert listed.json()["data"]["items"][0]["public_id"] == matter["public_id"]

    detail = http.get(
        f"/api/matters/{matter['public_id']}?include=items,timeline,updates"
    )
    assert detail.status_code == 200

    patched = http.patch(
        f"/api/matters/{matter['public_id']}",
        json={"status": "active", "mutation": _mutation("patch", matter["version"])},
    )
    assert patched.status_code == 200
    version = patched.json()["data"]["version"]

    trashed = http.post(
        f"/api/matters/{matter['public_id']}/trash",
        json={"mutation": _mutation("trash", version)},
    )
    assert trashed.status_code == 200
    version = trashed.json()["data"]["version"]

    restored = http.post(
        f"/api/matters/{matter['public_id']}/restore",
        json={"mutation": _mutation("restore", version)},
    )
    assert restored.status_code == 200
    assert restored.json()["data"]["matter"]["deleted_at"] is None


def test_flag_off_returns_disabled_envelope_for_all_methods(client):
    http, settings = client
    settings.matters_enabled = False
    for method, path, kwargs in (
        ("get", "/api/matters", {}),
        ("post", "/api/matters", {"json": {"title": "x", "mutation": _mutation("x")}}),
        ("get", "/api/matters/MAT-0001", {}),
        ("get", "/api/matters/links/by-resource?provider=mailagent&keys=email:1", {}),
    ):
        response = getattr(http, method)(path, **kwargs)
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_DISABLED"


def test_version_conflict_error_shape(client):
    http, _ = client
    matter = http.post(
        "/api/matters", json={"title": "Conflict", "mutation": _mutation("c")}
    ).json()["data"]["matter"]
    http.patch(
        f"/api/matters/{matter['public_id']}",
        json={"title": "first", "mutation": _mutation("p1", 1)},
    )
    response = http.patch(
        f"/api/matters/{matter['public_id']}",
        json={"title": "second", "mutation": _mutation("p2", 1)},
    )
    payload = response.json()
    assert response.status_code == 409
    assert payload["status"] == "error"
    assert payload["data"] is None
    assert payload["error"]["code"] == "E_VERSION_CONFLICT"
    assert payload["error"]["hint"]


def test_p2_resource_stakeholder_relation_lookup_and_search_api(client):
    http, _ = client
    first = http.post(
        "/api/matters", json={"title": "Searchable Alpha", "mutation": _mutation("p2-first")}
    ).json()["data"]
    second = http.post(
        "/api/matters", json={"title": "Target", "mutation": _mutation("p2-second")}
    ).json()["data"]
    public_id = first["matter"]["public_id"]

    linked_response = http.post(
        f"/api/matters/{public_id}/resources",
        json={
            "provider": "mailagent",
            "external_key": "email:77",
            "kind": "email",
            "mutation": _mutation("p2-resource", first["version"]),
        },
    )
    assert linked_response.status_code == 201
    linked = linked_response.json()["data"]
    resource_id = linked["resources"][0]["resource"]["id"]

    lookup = http.get(
        "/api/matters/links/by-resource?provider=mailagent&keys=email:77"
    )
    assert lookup.status_code == 200
    assert lookup.json()["data"]["results"]["email:77"][0]["resource_id"] == resource_id

    stakeholder = http.post(
        f"/api/matters/{public_id}/stakeholders",
        json={
            "display_name": "Needle Person",
            "email": "person@example.com",
            "mutation": _mutation("p2-stakeholder", linked["version"]),
        },
    )
    assert stakeholder.status_code == 201
    stakeholder_data = stakeholder.json()["data"]

    relation = http.post(
        f"/api/matters/{public_id}/relations",
        json={
            "target_public_id": second["matter"]["public_id"],
            "relation_type": "related_to",
            "mutation": _mutation("p2-relation", stakeholder_data["version"]),
        },
    )
    assert relation.status_code == 201
    assert len(http.get(f"/api/matters/{public_id}/relations").json()["data"]["items"]) == 1

    search = http.get("/api/matters?q=Needle")
    assert search.status_code == 200
    hit = search.json()["data"]["items"][0]
    assert hit["public_id"] == public_id
    assert "stakeholders" in hit["matched_fields"]


def test_bulk_resource_suggestion_endpoint(client):
    """整批口的 REST 面：一次版本推进 + 混入非法 id 不整批失败 + 值域由 schema 挡住。"""
    http, _ = client
    created = http.post(
        "/api/matters", json={"title": "Bulk API", "mutation": _mutation("bulk-create")}
    ).json()["data"]
    public_id = created["matter"]["public_id"]

    version = created["version"]
    resource_ids = []
    for index in (91, 92, 93):
        linked = http.post(
            f"/api/matters/{public_id}/resources",
            json={
                "provider": "mailagent",
                "external_key": f"email:{index}",
                "kind": "email",
                "mutation": _mutation(f"bulk-link-{index}", version),
            },
        ).json()["data"]
        resource_ids.append(linked["resources"][0]["resource"]["id"])
        version = linked["version"]

    response = http.post(
        f"/api/matters/{public_id}/resource-suggestions/bulk",
        json={
            "action": "confirm",
            "resource_ids": [*resource_ids[:2], 424_242],
            "mutation": _mutation("bulk-confirm", version),
        },
    )
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["counts"] == {"applied": 2, "skipped": 1}
    assert data["skipped"] == [{"resource_id": 424_242, "reason": "not_linked"}]
    assert data["version"] == version + 1

    # 还有一条没处置 ⇒ 这一批真要落库 ⇒ 旧版本号必须 409（对照：整批都无事可做时不校验
    # 版本，见 test_matter_suggestion_bulk.py::test_bulk_with_nothing_applicable_keeps_the_version）。
    stale = http.post(
        f"/api/matters/{public_id}/resource-suggestions/bulk",
        json={
            "action": "reject",
            "resource_ids": resource_ids[2:],
            "mutation": _mutation("bulk-stale", version),
        },
    )
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "E_VERSION_CONFLICT"

    bad_action = http.post(
        f"/api/matters/{public_id}/resource-suggestions/bulk",
        json={
            "action": "delete",
            "resource_ids": resource_ids,
            "mutation": _mutation("bulk-bad", data["version"]),
        },
    )
    assert bad_action.status_code == 422

    empty = http.post(
        f"/api/matters/{public_id}/resource-suggestions/bulk",
        json={
            "action": "confirm",
            "resource_ids": [],
            "mutation": _mutation("bulk-empty", data["version"]),
        },
    )
    assert empty.status_code == 422


def test_list_projects_bounded_stakeholder_summary_in_one_batch(client):
    """清单端点的头像组投影（design `list.jsx` 行 2 的 AvatarStack）。

    钉三件事：① 等待中的干系人排在前（与 context_snapshot 同口径）② 预览有界、
    `stakeholder_count` 仍是**总数**，UI 才能显示 `+N` ③ 没有干系人的事项也带这两个键
    （缺键与「零干系人」在前端是两种渲染，不能靠 undefined 兜）。
    """
    http, _ = client
    created = http.post(
        "/api/matters", json={"title": "Avatars", "mutation": _mutation("stk-create")}
    ).json()["data"]
    public_id = created["matter"]["public_id"]
    version = created["version"]
    empty = http.post(
        "/api/matters", json={"title": "No people", "mutation": _mutation("stk-empty")}
    ).json()["data"]

    # 8 个 > preview_limit(6)，其中最后一个才是「正在等他」——它必须被排到预览首位。
    for index in range(8):
        response = http.post(
            f"/api/matters/{public_id}/stakeholders",
            json={
                "display_name": f"Person {index}",
                "email": f"person{index}@example.com",
                "is_waiting_on": index == 7,
                "mutation": _mutation(f"stk-{index}", version),
            },
        )
        assert response.status_code == 201
        version = response.json()["data"]["version"]

    items = http.get("/api/matters").json()["data"]["items"]
    by_id = {item["public_id"]: item for item in items}

    row = by_id[public_id]
    assert row["stakeholder_count"] == 8
    assert len(row["stakeholder_summary"]) == 6
    assert row["stakeholder_summary"][0] == {
        "display_name": "Person 7",
        "email_normalized": "person7@example.com",
        "is_waiting_on": True,
    }
    assert [person["display_name"] for person in row["stakeholder_summary"][1:]] == [
        f"Person {index}" for index in range(5)
    ]

    blank = by_id[empty["matter"]["public_id"]]
    assert blank["stakeholder_summary"] == []
    assert blank["stakeholder_count"] == 0


def test_list_projects_next_action_in_one_batch(client):
    """清单端点的「下一步」投影（design `list.jsx` 行 2）。

    钉四件事：① 优先级 action(open/in_progress) > action(waiting) > blocker
    ② 同档取 `position, id` 靠前的那条 ③ 三档都没有 ⇒ `next_action` 为 None（状态派生
    的 monitoring/done/missing 留给前端单源）④ 一次列表调用就把整页算完（不按行发请求）。
    """
    http, _ = client

    def make(title: str, key: str) -> tuple[str, int]:
        payload = http.post(
            "/api/matters", json={"title": title, "mutation": _mutation(key)}
        ).json()["data"]
        return payload["matter"]["public_id"], payload["version"]

    def add_item(public_id: str, version: int, key: str, **item: object) -> int:
        response = http.post(
            f"/api/matters/{public_id}/items",
            json={**item, "mutation": _mutation(key, version)},
        )
        assert response.status_code == 201, response.text
        return int(response.json()["data"]["version"])

    # ① 三档同时在场 —— 必须挑出可执行的那条，而不是排在更前面的 blocker。
    mixed, version = make("Mixed", "na-mixed")
    version = add_item(mixed, version, "na-mixed-blk", kind="blocker", title="Blocked", position=0)
    version = add_item(
        mixed, version, "na-mixed-wait", kind="action", title="Waiting", status="waiting", position=1
    )
    version = add_item(
        mixed,
        version,
        "na-mixed-ready",
        kind="action",
        title="Ready",
        status="in_progress",
        position=2,
        due_at=1_800_000_000_000,
    )

    # ② 同档两条 —— 取 position 靠前的。
    ordered, version = make("Ordered", "na-ordered")
    version = add_item(
        ordered, version, "na-ordered-b", kind="action", title="Second", status="open", position=5
    )
    version = add_item(
        ordered, version, "na-ordered-a", kind="action", title="First", status="open", position=1
    )

    # 等待档只在没有可执行 action 时才出头。
    waiting, version = make("Waiting", "na-waiting")
    version = add_item(
        waiting, version, "na-waiting-done", kind="action", title="Done", status="done", position=0
    )
    version = add_item(
        waiting, version, "na-waiting-w", kind="action", title="Ping Bob", status="waiting", position=1
    )

    # ③ 只有 note ⇒ 三档都不命中。
    barren, version = make("Barren", "na-barren")
    version = add_item(barren, version, "na-barren-note", kind="note", title="FYI")

    by_id = {item["public_id"]: item for item in http.get("/api/matters").json()["data"]["items"]}
    assert by_id[mixed]["next_action"] == {
        "kind": "action",
        "title": "Ready",
        "due_at": 1_800_000_000_000,
    }
    assert by_id[ordered]["next_action"]["title"] == "First"
    assert by_id[waiting]["next_action"] == {
        "kind": "waiting",
        "title": "Ping Bob",
        "due_at": None,
    }
    assert by_id[barren]["next_action"] is None


def test_next_action_falls_back_to_blocker_and_skips_deleted(client):
    """blocker 是最后一档；软删的条目不参与（清单不能拿删掉的行当下一步）。"""
    http, _ = client
    created = http.post(
        "/api/matters", json={"title": "Blocked", "mutation": _mutation("na-blk")}
    ).json()["data"]
    public_id = created["matter"]["public_id"]
    version = created["version"]

    action = http.post(
        f"/api/matters/{public_id}/items",
        json={
            "kind": "action",
            "title": "Doomed",
            "status": "open",
            "position": 0,
            "mutation": _mutation("na-blk-act", version),
        },
    ).json()["data"]
    version = action["version"]
    blocker = http.post(
        f"/api/matters/{public_id}/items",
        json={
            "kind": "blocker",
            "title": "Legal review",
            "position": 1,
            "mutation": _mutation("na-blk-blk", version),
        },
    )
    assert blocker.status_code == 201
    version = blocker.json()["data"]["version"]

    listed = http.get("/api/matters").json()["data"]["items"]
    assert next(row for row in listed if row["public_id"] == public_id)["next_action"]["kind"] == (
        "action"
    )

    item_id = action["item"]["id"]
    removed = http.request(
        "DELETE",
        f"/api/matters/{public_id}/items/{item_id}",
        json={"mutation": _mutation("na-blk-del", version)},
    )
    assert removed.status_code == 200, removed.text

    listed = http.get("/api/matters").json()["data"]["items"]
    assert next(row for row in listed if row["public_id"] == public_id)["next_action"] == {
        "kind": "blocker",
        "title": "Legal review",
        "due_at": None,
    }


def test_patch_accepts_priority_and_goal_checks_over_the_wire(client):
    """0813 轮 3：详情页改优先级 / 存完成标志走的是 REST，而 DTO 白名单漏了这两个字段
    ⇒ 422 extra_forbidden。goal_checks 的既有用例全在 service 层直调（见
    test_matter_goal_checks.py），一条都碰不到 wire —— 这正是漏抄能瞒过整套测试的原因。"""
    http, _ = client
    created = http.post(
        "/api/matters",
        json={"title": "Wire patch", "mutation": _mutation("wp-create")},
    )
    assert created.status_code == 201
    matter = created.json()["data"]["matter"]
    public_id = matter["public_id"]

    patched = http.patch(
        f"/api/matters/{public_id}",
        json={
            "priority": "p0",
            "goal_checks": [
                {"t": "合同已签署", "done": False},
                {"t": "款项已到账", "done": True},
            ],
            "mutation": _mutation("wp-patch", matter["version"]),
        },
    )
    assert patched.status_code == 200, patched.text
    after = patched.json()["data"]["matter"]
    assert after["priority"] == "p0"
    assert after["goal_checks"] == [
        {"t": "合同已签署", "done": False},
        {"t": "款项已到账", "done": True},
    ]

    # 真落库（不是只在响应里回声）。
    reread = http.get(f"/api/matters/{public_id}").json()["data"]["matter"]
    assert reread["priority"] == "p0"
    assert [row["t"] for row in reread["goal_checks"]] == ["合同已签署", "款项已到账"]


def test_patch_still_rejects_fields_the_service_does_not_consume(client):
    """白名单放宽两个字段 ≠ 变成自由字典：DTO 仍 extra=forbid（422），值域仍归 service（400）。"""
    http, _ = client
    matter = http.post(
        "/api/matters",
        json={"title": "Wire patch guard", "mutation": _mutation("wpg-create")},
    ).json()["data"]["matter"]

    unknown = http.patch(
        f"/api/matters/{matter['public_id']}",
        json={"totally_unknown": 1, "mutation": _mutation("wpg-unknown", matter["version"])},
    )
    assert unknown.status_code == 422
    assert "Extra inputs are not permitted" in unknown.json()["error"]["message"]

    bad_priority = http.patch(
        f"/api/matters/{matter['public_id']}",
        json={"priority": "p9", "mutation": _mutation("wpg-prio", matter["version"])},
    )
    assert bad_priority.status_code == 400, bad_priority.text
    assert bad_priority.json()["error"]["code"] == "E_INVALID_ARG"

    # goal_checks 的两层分工（有意，不是漏）：元素形状由 DTO 判（422），值域/条数由
    # normalize_goal_checks 单判（400）—— 两侧 code 都是 E_INVALID_ARG，DTO 只是更窄。
    bad_goal_shape = http.patch(
        f"/api/matters/{matter['public_id']}",
        json={"goal_checks": ["not an object"], "mutation": _mutation("wpg-goal", matter["version"])},
    )
    assert bad_goal_shape.status_code == 422, bad_goal_shape.text
    assert bad_goal_shape.json()["error"]["code"] == "E_INVALID_ARG"

    bad_goal_value = http.patch(
        f"/api/matters/{matter['public_id']}",
        json={
            "goal_checks": [{"t": "x" * 500, "done": False}],
            "mutation": _mutation("wpg-goal-len", matter["version"]),
        },
    )
    assert bad_goal_value.status_code == 400, bad_goal_value.text
    assert bad_goal_value.json()["error"]["code"] == "E_INVALID_ARG"
