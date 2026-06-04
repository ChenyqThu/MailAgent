"""email flag + resync WRITE endpoints — A2 in-process MailWriteService (no fork CLI).

A2 起 flag / resync 端点不再 fork CLI, 而是进程内调 ``MailWriteService``。这些测试把
``email_router.MailWriteService`` 换成一个记录型 spy —— 不碰真实 SQLite / Notion ——
断言 router (a) 把 body 解析成正确的 service 参数, (b) 恒传 ``allow_concurrent=True`` (#9),
(c) dry-run 走 ``plan_*`` 跳过 auth (不传 actor), (d) 把 ``ServiceError`` 经 envelope 映成
正确 HTTP。

真实 in-process 行为 (DB 写 / outbox enqueue / 与旧 fork-CLI golden 的 parity) 由
tests/cli/test_email_flag.py + tests/cli/test_service_parity.py 覆盖。
"""

from __future__ import annotations

from typing import Optional

import pytest

import src.api.routers.email as email_router
from src.services.errors import ServiceNotFoundError, ServicePM2ConflictError
from src.services.mail_write import FlagResult, ResyncResult

from tests.api.conftest import EMAIL_ID


class _SvcSpy:
    """``MailWriteService`` 替身: 记录 (method, target, kwargs), 返回 canned 结果。

    router 走 ``MailWriteService(get_service_ctx())`` 再调方法 —— patch 类符号即可。
    ``_raise`` (类属性, 由 fixture 重置) 非 None 时执行类方法抛它, 测错误映射。
    """

    instances: list["_SvcSpy"] = []
    _raise: Optional[Exception] = None

    def __init__(self, ctx=None):
        self.ctx = ctx
        self.calls: list[tuple] = []
        _SvcSpy.instances.append(self)

    # --- flags ---
    def plan_flags(self, internal_ids, *, is_read=None, is_flagged=None,
                   processing_status=None):
        self.calls.append((
            "plan_flags", list(internal_ids),
            {"is_read": is_read, "is_flagged": is_flagged,
             "processing_status": processing_status},
        ))
        return {"dry_run": True, "internal_ids": list(internal_ids),
                "payload": {}, "would_enqueue": []}

    def set_flags(self, internal_ids, *, is_read=None, is_flagged=None,
                  processing_status=None, actor, allow_concurrent=False):
        self.calls.append((
            "set_flags", list(internal_ids),
            {"is_read": is_read, "is_flagged": is_flagged,
             "processing_status": processing_status,
             "actor": actor, "allow_concurrent": allow_concurrent},
        ))
        if _SvcSpy._raise is not None:
            raise _SvcSpy._raise
        return FlagResult(updated_ids=list(internal_ids), payload={},
                          outbox_entries=[], not_found=[])

    # --- resync ---
    def plan_resync(self, internal_id, *, replace_existing=False,
                    skip_parent_lookup=False):
        self.calls.append((
            "plan_resync", internal_id,
            {"replace_existing": replace_existing,
             "skip_parent_lookup": skip_parent_lookup},
        ))
        if _SvcSpy._raise is not None:
            raise _SvcSpy._raise
        return {"internal_id": internal_id, "subject": "S", "current_page_id": None,
                "action": "replace" if replace_existing else "create_or_skip",
                "would_replace": replace_existing,
                "skip_parent_lookup": skip_parent_lookup, "dry_run": True}

    def resync(self, internal_id, *, replace_existing=False,
               skip_parent_lookup=False, actor, allow_concurrent=False):
        self.calls.append((
            "resync", internal_id,
            {"replace_existing": replace_existing,
             "skip_parent_lookup": skip_parent_lookup,
             "actor": actor, "allow_concurrent": allow_concurrent},
        ))
        if _SvcSpy._raise is not None:
            raise _SvcSpy._raise
        return ResyncResult(internal_id=internal_id, old_page_id="old-pg",
                            new_page_id="new-pg", archived_page_id=None,
                            action="created")


@pytest.fixture()
def svc_spy(monkeypatch):
    """Patch the router's MailWriteService with a fresh recording spy."""
    _SvcSpy.instances = []
    _SvcSpy._raise = None
    monkeypatch.setattr(email_router, "MailWriteService", _SvcSpy)
    return _SvcSpy


def _last(svc_spy):
    """The single recorded call on the last-built spy instance."""
    assert svc_spy.instances, "MailWriteService was never constructed"
    inst = svc_spy.instances[-1]
    assert inst.calls, "no service method was called"
    return inst.calls[-1]


# ===========================================================================
# POST /api/email/{id}/flag — single (in-process set_flags / plan_flags)
# ===========================================================================


def test_flag_single_passes_structured_args(client, svc_spy):
    r = client.post(f"/api/email/{EMAIL_ID}/flag", json={"isRead": True})
    assert r.status_code == 200
    method, ids, kw = _last(svc_spy)
    assert method == "set_flags"
    assert ids == [EMAIL_ID]
    assert kw["is_read"] is True
    assert kw["is_flagged"] is None
    # 恒并发 (#9) + 已鉴权 actor (请求已过 verify_cf_access)。
    assert kw["allow_concurrent"] is True
    assert kw["actor"].authenticated is True
    assert kw["actor"].kind == "http"


def test_flag_false_values_passthrough(client, svc_spy):
    r = client.post(
        f"/api/email/{EMAIL_ID}/flag", json={"isRead": False, "isFlagged": False}
    )
    assert r.status_code == 200
    _, _, kw = _last(svc_spy)
    assert kw["is_read"] is False
    assert kw["is_flagged"] is False


def test_flag_processing_status_passthrough(client, svc_spy):
    r = client.post(
        f"/api/email/{EMAIL_ID}/flag", json={"processingStatus": "Needs Reply"}
    )
    assert r.status_code == 200
    _, _, kw = _last(svc_spy)
    assert kw["processing_status"] == "Needs Reply"
    assert kw["allow_concurrent"] is True


def test_flag_body_ids_override_path_id(client, svc_spy):
    # body.ids 走批量 (与 path id 互斥, path 被忽略)。
    r = client.post(
        f"/api/email/{EMAIL_ID}/flag", json={"isRead": True, "ids": [3, 4, 5]}
    )
    assert r.status_code == 200
    method, ids, _ = _last(svc_spy)
    assert method == "set_flags"
    assert ids == [3, 4, 5]
    assert EMAIL_ID not in ids


def test_flag_dry_run_uses_plan_and_skips_actor(client, svc_spy):
    r = client.post(
        f"/api/email/{EMAIL_ID}/flag", json={"isRead": True, "dryRun": True}
    )
    assert r.status_code == 200
    method, ids, kw = _last(svc_spy)
    # dry-run → plan_flags (纯预览), 不传 actor / allow_concurrent。
    assert method == "plan_flags"
    assert ids == [EMAIL_ID]
    assert "actor" not in kw
    assert r.json()["data"]["dry_run"] is True


def test_flag_service_error_maps_to_http(client, svc_spy):
    # ServiceError (E_PM2_RUNNING) → 409 via ERROR_CODE_TO_HTTP。
    _SvcSpy._raise = ServicePM2ConflictError("mail-sync online")
    r = client.post(f"/api/email/{EMAIL_ID}/flag", json={"isRead": True})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "E_PM2_RUNNING"
    assert r.json()["meta"]["source"] == "cli"


def test_flag_result_envelope_shape(client, svc_spy):
    r = client.post(f"/api/email/{EMAIL_ID}/flag", json={"isRead": True})
    body = r.json()
    assert body["status"] == "success"
    assert body["data"]["dry_run"] is False
    assert body["data"]["updated_ids"] == [EMAIL_ID]
    # 空 not_found 不出现在 data (历史形状)。
    assert "not_found" not in body["data"]
    assert body["meta"]["count"] == 1
    assert body["meta"]["not_found_count"] == 0


# ===========================================================================
# POST /api/email/flag — batch route (NO path id, C8 reject empty/invalid → 400)
# ===========================================================================


def test_batch_flag_passes_ids(client, svc_spy):
    r = client.post("/api/email/flag", json={"ids": [7, 8, 9], "isFlagged": True})
    assert r.status_code == 200
    method, ids, kw = _last(svc_spy)
    assert method == "set_flags"
    assert ids == [7, 8, 9]
    assert kw["is_flagged"] is True
    assert kw["allow_concurrent"] is True


def test_batch_flag_dry_run_uses_plan(client, svc_spy):
    r = client.post(
        "/api/email/flag", json={"ids": [5, 6], "isRead": True, "dryRun": True}
    )
    assert r.status_code == 200
    method, ids, kw = _last(svc_spy)
    assert method == "plan_flags"
    assert ids == [5, 6]
    assert "actor" not in kw


def test_batch_flag_rejects_empty_ids_400(client, svc_spy):
    r = client.post("/api/email/flag", json={"ids": [], "isRead": True})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert svc_spy.instances == []  # 校验早于 service 构造。


def test_batch_flag_rejects_missing_ids_400(client, svc_spy):
    r = client.post("/api/email/flag", json={"isRead": True})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert svc_spy.instances == []


def test_batch_flag_requires_mutation_field_400(client, svc_spy):
    r = client.post("/api/email/flag", json={"ids": [1, 2]})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert svc_spy.instances == []


def test_batch_flag_rejects_noninteger_ids_400(client, svc_spy):
    r = client.post("/api/email/flag", json={"ids": [1, "two"], "isRead": True})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert svc_spy.instances == []


def test_batch_flag_rejects_bool_ids_400(client, svc_spy):
    # bool 是 int 子类 — True/False 不是合法 id。
    r = client.post("/api/email/flag", json={"ids": [True], "isRead": True})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert svc_spy.instances == []


def test_single_flag_requires_mutation_field_400(client, svc_spy):
    # 单封端点同样要求至少一个 flag 字段 (校验早于 service)。
    r = client.post(f"/api/email/{EMAIL_ID}/flag", json={})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert svc_spy.instances == []


# ===========================================================================
# POST /api/email/{id}/resync — in-process resync / plan_resync
# ===========================================================================


def test_resync_executed_passes_args_and_envelope(client, svc_spy):
    r = client.post(
        f"/api/email/{EMAIL_ID}/resync",
        json={"replaceExisting": True, "skipParentLookup": True},
    )
    assert r.status_code == 200
    method, iid, kw = _last(svc_spy)
    assert method == "resync"
    assert iid == EMAIL_ID
    assert kw["replace_existing"] is True
    assert kw["skip_parent_lookup"] is True
    assert kw["allow_concurrent"] is True
    assert kw["actor"].authenticated is True
    # data 形状 = email-resync.schema.json result 分支。
    data = r.json()["data"]
    assert data["dry_run"] is False
    assert data["new_page_id"] == "new-pg"
    assert data["old_page_id"] == "old-pg"
    assert data["action"] == "created"


def test_resync_dry_run_uses_plan_and_skips_actor(client, svc_spy):
    r = client.post(f"/api/email/{EMAIL_ID}/resync", json={"dryRun": True})
    assert r.status_code == 200
    method, iid, kw = _last(svc_spy)
    assert method == "plan_resync"
    assert iid == EMAIL_ID
    assert "actor" not in kw
    assert r.json()["data"]["dry_run"] is True


def test_resync_not_found_maps_to_404(client, svc_spy):
    _SvcSpy._raise = ServiceNotFoundError("Email metadata not found for internal_id=42")
    r = client.post("/api/email/42/resync", json={})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


def test_resync_dry_run_not_found_maps_to_404(client, svc_spy):
    _SvcSpy._raise = ServiceNotFoundError("Email metadata not found for internal_id=42")
    r = client.post("/api/email/42/resync", json={"dryRun": True})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"
