"""行动项派发的 REST 面（task 08-25 批次 3，Lane 1）。

域逻辑（状态机 / CAS / 幂等 / 回钩）钉在 `tests/matters/test_item_dispatch.py`；这里只钉
**边界**上那几件会静默出错的事：

- 四条路由真的挂上了，且 `GET /api/matters/item-dispatches` 没有被 `GET /{matter_id}`
  当成 `matter_id='item-dispatches'` 吃掉（FastAPI 按注册序匹配 —— `/updates` 踩过）；
- DTO 是 `extra=forbid`：多写一个字段当场 422，而不是被静默丢弃；
- `expected_version` **可缺省**（这三个动作也会从 `/today` 例外面发起，那个面拿不到事项
  版本号）；带了但不符仍然冲突；
- 域错误经 `_call` 转成结构化错误码，不是 500。

习语照 `tests/api/test_matters_p3_api.py`（依赖覆盖 + 真 FastAPI app）。
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
from src.matters.service import MatterService


@pytest.fixture
def http(tmp_path):
    path = tmp_path / "dispatch-api.db"
    SyncStore(str(path))
    settings = SimpleNamespace(sync_store_db_path=str(path))
    overrides = {
        verify_cf_access: lambda: None,
        get_settings: lambda: settings,
        get_matter_service: lambda: MatterService(MatterRepository(path)),
    }
    app.dependency_overrides.update(overrides)
    with TestClient(app) as client:
        yield client
    for dep in overrides:
        app.dependency_overrides.pop(dep, None)


def _mutation(key: str, version: int | None = None) -> dict:
    payload = {"source": "desktop_ui", "idempotency_key": key}
    if version is not None:
        payload["expected_version"] = version
    return payload


def _seed(http) -> tuple[str, int]:
    created = http.post(
        "/api/matters", json={"title": "NexPay 二期", "mutation": _mutation("m-1")}
    )
    assert created.status_code == 201
    public_id = created.json()["data"]["matter"]["public_id"]
    item = http.post(
        f"/api/matters/{public_id}/items",
        json={
            "kind": "action",
            "title": "回签补充协议",
            "mutation": _mutation("i-1", created.json()["data"]["version"]),
        },
    )
    assert item.status_code == 201
    return public_id, int(item.json()["data"]["item"]["id"])


def test_dispatch_answer_and_cancel_round_trip(http):
    public_id, item_id = _seed(http)

    dispatched = http.post(
        f"/api/matters/{public_id}/items/{item_id}/dispatch",
        json={"mutation": _mutation("d-1")},
    )
    assert dispatched.status_code == 201
    dispatch = dispatched.json()["data"]["dispatch"]
    assert dispatch["state"] == "queued"
    assert dispatch["executor_id"] == "matter_followup"

    listed = http.get(f"/api/matters/{public_id}/item-dispatches?item_id={item_id}")
    assert listed.status_code == 200
    assert [row["id"] for row in listed.json()["data"]["items"]] == [dispatch["id"]]

    canceled = http.post(
        f"/api/matters/{public_id}/item-dispatches/{dispatch['id']}/cancel",
        json={"mutation": _mutation("c-1")},
    )
    assert canceled.status_code == 200
    assert canceled.json()["data"]["dispatch"]["state"] == "canceled"


def test_the_global_surface_is_not_swallowed_by_the_matter_id_route(http):
    """🔴 `/api/matters/item-dispatches` 必须注册在 `GET /{matter_id}` **之前**，否则它会
    被当成 `matter_id='item-dispatches'` → 404（`/updates` 踩过这个坑）。"""
    public_id, item_id = _seed(http)
    http.post(
        f"/api/matters/{public_id}/items/{item_id}/dispatch",
        json={"mutation": _mutation("d-1")},
    )

    empty = http.get("/api/matters/item-dispatches")
    assert empty.status_code == 200
    # queued 不进例外面（正在排队的事不需要我处理）。
    assert empty.json()["data"]["items"] == []

    all_states = http.get("/api/matters/item-dispatches?state=queued")
    assert [row["state"] for row in all_states.json()["data"]["items"]] == ["queued"]
    # 例外面一行要说清「哪件事的哪条行动项」。
    assert all_states.json()["data"]["items"][0]["matter_public_id"] == public_id
    assert all_states.json()["data"]["items"][0]["item_title"] == "回签补充协议"


def test_an_unknown_state_filter_is_a_structured_error_not_a_500(http):
    response = http.get("/api/matters/item-dispatches?state=ghost")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "E_INVALID_ARG"


def test_dispatching_a_note_is_a_structured_error(http):
    created = http.post(
        "/api/matters", json={"title": "T", "mutation": _mutation("m-1")}
    )
    public_id = created.json()["data"]["matter"]["public_id"]
    note = http.post(
        f"/api/matters/{public_id}/notes",
        json={"text": "随手记", "mutation": _mutation("n-1", created.json()["data"]["version"])},
    )
    item_id = note.json()["data"]["item"]["id"]

    response = http.post(
        f"/api/matters/{public_id}/items/{item_id}/dispatch",
        json={"mutation": _mutation("d-1")},
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "E_INVALID_ARG"


def test_a_second_active_dispatch_is_refused_at_the_boundary(http):
    public_id, item_id = _seed(http)
    http.post(
        f"/api/matters/{public_id}/items/{item_id}/dispatch",
        json={"mutation": _mutation("d-1")},
    )

    again = http.post(
        f"/api/matters/{public_id}/items/{item_id}/dispatch",
        json={"mutation": _mutation("d-2")},
    )
    assert again.json()["error"]["code"] == "E_DISPATCH_ACTIVE"
    # 🔴 新错误码必须登记进 `ERROR_CODE_TO_HTTP`：没登记的 code 兜底 500，会把一个
    # 「你已经派过一次了」伪装成服务端崩溃（app.py 的表头注就是为这个写的）。
    assert again.status_code == 409


def test_expected_version_is_optional_but_still_checked_when_given(http):
    """`/today` 例外面只认识派发行、拿不到事项版本号 —— 强制带版本等于把这些动作锁死在
    详情页里。带了就仍然是乐观并发的锚。"""
    public_id, item_id = _seed(http)

    stale = http.post(
        f"/api/matters/{public_id}/items/{item_id}/dispatch",
        json={"mutation": _mutation("d-1", 99)},
    )
    assert stale.json()["error"]["code"] == "E_VERSION_CONFLICT"

    ok = http.post(
        f"/api/matters/{public_id}/items/{item_id}/dispatch",
        json={"mutation": _mutation("d-2")},
    )
    assert ok.status_code == 201


def test_the_dto_forbids_extra_fields(http):
    """DTO 是 `extra=forbid`：多写一个字段当场 422，不是被静默丢弃（假接口）。"""
    public_id, item_id = _seed(http)

    response = http.post(
        f"/api/matters/{public_id}/items/{item_id}/dispatch",
        json={"mutation": _mutation("d-1"), "grant_exec": True},
    )
    assert response.status_code == 422


def test_the_idempotency_header_must_match_the_envelope(http):
    public_id, item_id = _seed(http)

    response = http.post(
        f"/api/matters/{public_id}/items/{item_id}/dispatch",
        json={"mutation": _mutation("d-1")},
        headers={"Idempotency-Key": "something-else"},
    )
    assert response.json()["error"]["code"] == "E_IDEMPOTENCY_CONFLICT"


def test_an_empty_answer_is_refused_at_the_boundary(http):
    public_id, item_id = _seed(http)
    dispatched = http.post(
        f"/api/matters/{public_id}/items/{item_id}/dispatch",
        json={"mutation": _mutation("d-1")},
    )
    dispatch_id = dispatched.json()["data"]["dispatch"]["id"]

    response = http.post(
        f"/api/matters/{public_id}/item-dispatches/{dispatch_id}/answer",
        json={"text": "", "mutation": _mutation("a-1")},
    )
    assert response.status_code == 422


def test_the_item_patch_face_accepts_exec_profile(http):
    """执行档走既有的 item PATCH 面（不新开端点）—— DTO 漏了它会让整条设置路径 422。"""
    public_id, item_id = _seed(http)
    version = http.get(f"/api/matters/{public_id}").json()["data"]["matter"]["version"]

    response = http.patch(
        f"/api/matters/{public_id}/items/{item_id}",
        json={"exec_profile": "autonomous", "mutation": _mutation("p-1", version)},
    )
    assert response.status_code == 200
    assert response.json()["data"]["item"]["exec_profile"] == "autonomous"
