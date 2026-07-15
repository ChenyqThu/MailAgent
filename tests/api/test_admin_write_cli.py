"""admin WRITE endpoints — cleanup-dead-letter / dead-letter retry (E2-C in-process AdminService).

E2-C 起这两个端点不再 fork CLI, 而是进程内调 ``AdminService`` (``src/services/admin_service.py``)。
这些测试把 ``admin_router.AdminService`` 换成一个记录型 spy (与 test_email_write_service.py 的
``_SvcSpy`` 同构) —— 不碰真实 SQLite —— 断言 router (a) 把 query 参数正确透传成 service kwargs,
(b) 恒传已鉴权 ``actor`` (两端点都过了 ``verify_cf_access``), (c) 把 ``ServiceError`` 经 envelope
映成正确 HTTP。

真实 SQL 行为 (UPDATE 重置字段 / cutoff 计数删除) 由 tests/services/test_admin_service.py
(真实 SQLite) 覆盖。cleanup-dead-letter 已不存在"部分失败"路径 —— 迁移前 CLI 子进程退出码 6
(partial_failure → HTTP 207) 的分支随 fork 一并退役 (AdminService.cleanup_dead_letter 是单条
原子 DELETE), 故不再有对应测试。
"""

from __future__ import annotations

from typing import Any, Optional

import pytest

import src.api.routers.admin as admin_router
from src.services.errors import ServiceInvalidArgError


class _AdminSvcSpy:
    """``AdminService`` 替身: 记录 (method, target, kwargs), 返回 canned 结果。

    router 走 ``AdminService(get_service_ctx())`` 再调方法 —— patch 类符号即可。
    ``_raise`` (类属性, 由 fixture 重置) 非 None 时执行类方法抛它, 测错误映射。
    """

    instances: list["_AdminSvcSpy"] = []
    _raise: Optional[Exception] = None

    def __init__(self, ctx=None):
        self.ctx = ctx
        self.calls: list[tuple] = []
        _AdminSvcSpy.instances.append(self)

    def retry_dead_letter(self, internal_id: int, *, actor):
        self.calls.append(("retry_dead_letter", internal_id, {"actor": actor}))
        if _AdminSvcSpy._raise is not None:
            raise _AdminSvcSpy._raise
        return {"internal_id": internal_id, "old_status": "dead_letter", "new_status": "pending"}

    def delete_dead_letter(self, internal_id: int, *, actor):
        self.calls.append(("delete_dead_letter", internal_id, {"actor": actor}))
        if _AdminSvcSpy._raise is not None:
            raise _AdminSvcSpy._raise
        return {"internal_id": internal_id, "old_status": "dead_letter", "deleted": True}

    def cleanup_dead_letter(self, *, older_than: int = 30, dry_run: bool = True, actor):
        self.calls.append((
            "cleanup_dead_letter", None,
            {"older_than": older_than, "dry_run": dry_run, "actor": actor},
        ))
        if _AdminSvcSpy._raise is not None:
            raise _AdminSvcSpy._raise
        return {
            "action": "cleanup-deadletter",
            "older_than_days": older_than,
            "candidates": 0,
            "deleted": 0,
            "dry_run": dry_run,
            "mode": "dry-run" if dry_run else "delete",
            "ok": True,
        }


@pytest.fixture()
def admin_svc_spy(monkeypatch):
    """Patch the router's AdminService with a fresh recording spy."""
    _AdminSvcSpy.instances = []
    _AdminSvcSpy._raise = None
    monkeypatch.setattr(admin_router, "AdminService", _AdminSvcSpy)
    return _AdminSvcSpy


def _last(spy) -> tuple[str, Any, dict]:
    """The single recorded call on the last-built spy instance."""
    assert spy.instances, "AdminService was never constructed"
    inst = spy.instances[-1]
    assert inst.calls, "no service method was called"
    return inst.calls[-1]


# ---------------------------------------------------------------------------
# POST /api/admin/cleanup-dead-letter
# ---------------------------------------------------------------------------


def test_cleanup_dead_letter_success_200(client, admin_svc_spy):
    r = client.post("/api/admin/cleanup-dead-letter")

    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "success"
    assert body["data"]["dry_run"] is True
    assert body["meta"]["source"] == "cli"

    method, _, kw = _last(admin_svc_spy)
    assert method == "cleanup_dead_letter"
    # 未传 query 参数时走 service 默认值 (older_than=30, dry_run=True)。
    assert kw["older_than"] == 30
    assert kw["dry_run"] is True
    assert kw["actor"].authenticated is True
    assert kw["actor"].kind == "http"


def test_cleanup_dead_letter_real_delete_passes_flags(client, admin_svc_spy):
    r = client.post(
        "/api/admin/cleanup-dead-letter",
        params={"dry_run": False, "older_than": 7},
    )

    assert r.status_code == 200
    method, _, kw = _last(admin_svc_spy)
    assert method == "cleanup_dead_letter"
    assert kw["older_than"] == 7
    assert kw["dry_run"] is False


def test_cleanup_dead_letter_service_error_maps_http(client, admin_svc_spy):
    """A ServiceError (e.g. E_INVALID_ARG) → mapped HTTP via ERROR_CODE_TO_HTTP."""
    admin_svc_spy._raise = ServiceInvalidArgError("bad older_than", hint="use >=0")

    r = client.post("/api/admin/cleanup-dead-letter", params={"older_than": -5})

    assert r.status_code == 400
    body = r.json()
    assert body["status"] == "error"
    assert body["error"]["code"] == "E_INVALID_ARG"
    assert body["meta"]["source"] == "cli"


# ---------------------------------------------------------------------------
# POST /api/admin/dead-letter/{internal_id}/retry
# ---------------------------------------------------------------------------


def test_dead_letter_retry_success_passthrough(client, admin_svc_spy):
    r = client.post("/api/admin/dead-letter/53675/retry")

    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "success"
    assert body["data"] == {
        "internal_id": 53675, "old_status": "dead_letter", "new_status": "pending",
    }

    method, target, kw = _last(admin_svc_spy)
    assert method == "retry_dead_letter"
    assert target == 53675
    assert kw["actor"].authenticated is True
    assert kw["actor"].kind == "http"


def test_dead_letter_retry_not_found_maps_400(client, admin_svc_spy):
    admin_svc_spy._raise = ServiceInvalidArgError("internal_id 999999 not found")

    r = client.post("/api/admin/dead-letter/999999/retry")

    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


# ---------------------------------------------------------------------------
# POST /api/admin/dead-letter/{internal_id}/delete
# ---------------------------------------------------------------------------


def test_dead_letter_delete_success_passthrough(client, admin_svc_spy):
    r = client.post("/api/admin/dead-letter/53675/delete")

    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "success"
    assert body["data"] == {
        "internal_id": 53675, "old_status": "dead_letter", "deleted": True,
    }

    method, target, kw = _last(admin_svc_spy)
    assert method == "delete_dead_letter"
    assert target == 53675
    assert kw["actor"].authenticated is True
    assert kw["actor"].kind == "http"


def test_dead_letter_delete_non_dead_letter_maps_400(client, admin_svc_spy):
    admin_svc_spy._raise = ServiceInvalidArgError("internal_id 2 is sync_status='synced'")

    r = client.post("/api/admin/dead-letter/2/delete")

    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
