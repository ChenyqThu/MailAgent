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
