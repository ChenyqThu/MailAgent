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
import src.api.routers.llm as llm_router
from src.services.errors import (
    ServiceInvalidArgError,
    ServiceLLMFailedError,
    ServiceNotFoundError,
    ServicePM2ConflictError,
)
from src.services.llm_service import LlmRunResult
from src.services.mail_write import (
    AiFieldsResult,
    ArchiveResult,
    ComposeDraftResult,
    ComposeSendResult,
    FlagResult,
    PinResult,
    ReplySuggestionResult,
    ResyncResult,
)

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

    # --- archive (A3) ---
    def plan_archive(self, internal_id):
        self.calls.append(("plan_archive", internal_id, {}))
        if _SvcSpy._raise is not None:
            raise _SvcSpy._raise
        return {"internal_id": internal_id, "action": "archive",
                "from_mailbox": "收件箱", "to_mailbox": "存档",
                "message_id": "<m>", "has_imap_uid": False,
                "notion_page_id": "pg", "dry_run": True}

    def archive(self, internal_id, *, actor):
        self.calls.append(("archive", internal_id, {"actor": actor}))
        if _SvcSpy._raise is not None:
            raise _SvcSpy._raise
        return ArchiveResult(internal_id=internal_id, from_mailbox="收件箱",
                             to_mailbox="存档", notion_updated=True,
                             notion_error=None)

    # --- pin (A3) ---
    def plan_pin(self, internal_id, *, pinned):
        self.calls.append(("plan_pin", internal_id, {"pinned": pinned}))
        if _SvcSpy._raise is not None:
            raise _SvcSpy._raise
        return {"internal_id": internal_id, "is_pinned": pinned,
                "changed": True, "dry_run": True}

    def set_pin(self, internal_id, *, pinned, actor):
        self.calls.append(("set_pin", internal_id, {"pinned": pinned, "actor": actor}))
        if _SvcSpy._raise is not None:
            raise _SvcSpy._raise
        return PinResult(internal_id=internal_id, is_pinned=pinned, changed=True)

    # --- reply_suggestion ---
    def set_reply_suggestion(self, internal_id, reply_md, *, actor):
        self.calls.append((
            "set_reply_suggestion", internal_id,
            {"reply_md": reply_md, "actor": actor},
        ))
        if _SvcSpy._raise is not None:
            raise _SvcSpy._raise
        return ReplySuggestionResult(
            internal_id=internal_id, reply_suggestion_md=reply_md, chars=len(reply_md)
        )

    # --- ai_fields ---
    def set_ai_fields(self, internal_id, *, action=None, priority=None,
                      review_status=None, actor):
        self.calls.append((
            "set_ai_fields", internal_id,
            {"action": action, "priority": priority,
             "review_status": review_status, "actor": actor},
        ))
        if _SvcSpy._raise is not None:
            raise _SvcSpy._raise
        return AiFieldsResult(
            internal_id=internal_id, action=action, priority=priority,
            review_status=review_status,
        )

    # --- compose (A4): target = ComposeRequest (router 透传后的入参对象) ---
    def compose_plan(self, request):
        self.calls.append(("compose_plan", request, {}))
        if _SvcSpy._raise is not None:
            raise _SvcSpy._raise
        return {"internal_id": request.internal_id, "mode": request.mode,
                "to": ["x@example.com"], "cc": [], "bcc": [], "subject": "Re: S",
                "reply_source": "sqlite:llm_processing.labels_json",
                "reply_html": "<p>r</p>", "forward_intro_html": None, "dry_run": True}

    def compose_draft(self, request, *, actor):
        self.calls.append(("compose_draft", request, {"actor": actor}))
        if _SvcSpy._raise is not None:
            raise _SvcSpy._raise
        return ComposeDraftResult(
            internal_id=request.internal_id, drafts_folder="Drafts", appended_uid=7,
            method="imap_append", mode=request.mode, to_count=1, cc_count=0,
            attachments=0, warnings=[])

    def send(self, request, *, actor, confirmed):
        self.calls.append(("send", request, {"actor": actor, "confirmed": confirmed}))
        if _SvcSpy._raise is not None:
            raise _SvcSpy._raise
        return ComposeSendResult(
            internal_id=request.internal_id, mode=request.mode, message_id="<m@x>",
            archived_to_sent=False, method="smtp_davmail", to_count=1, cc_count=0,
            attachments=0, warnings=[])


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


# ===========================================================================
# POST /api/email/{id}/archive — in-process archive / plan_archive (A3)
# ===========================================================================


def test_archive_executed_passes_actor_and_envelope(client, svc_spy):
    r = client.post(f"/api/email/{EMAIL_ID}/archive", json={})
    assert r.status_code == 200
    method, iid, kw = _last(svc_spy)
    assert method == "archive"
    assert iid == EMAIL_ID
    # 恒已鉴权 http actor (请求已过 verify_cf_access); archive 不传 allow_concurrent。
    assert kw["actor"].authenticated is True
    assert kw["actor"].kind == "http"
    assert "allow_concurrent" not in kw
    data = r.json()["data"]
    assert data["action"] == "archive"
    assert data["success"] is True
    assert data["to_mailbox"] == "存档"
    assert data["dry_run"] is False


def test_archive_dry_run_uses_plan_and_skips_actor(client, svc_spy):
    r = client.post(f"/api/email/{EMAIL_ID}/archive", json={"dryRun": True})
    assert r.status_code == 200
    method, iid, kw = _last(svc_spy)
    assert method == "plan_archive"
    assert iid == EMAIL_ID
    assert "actor" not in kw
    assert r.json()["data"]["dry_run"] is True


def test_archive_non_davmail_maps_to_400(client, svc_spy):
    # 非 davmail backend → service ServiceInvalidArgError → 400。
    _SvcSpy._raise = ServiceInvalidArgError("归档需要 MAILAGENT_BACKEND=davmail")
    r = client.post(f"/api/email/{EMAIL_ID}/archive", json={})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_archive_not_found_maps_to_404(client, svc_spy):
    _SvcSpy._raise = ServiceNotFoundError("Email metadata not found for internal_id=42")
    r = client.post("/api/email/42/archive", json={})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


# ===========================================================================
# POST /api/email/{id}/pin — in-process set_pin / plan_pin (A3)
# ===========================================================================


def test_pin_executed_passes_actor(client, svc_spy):
    r = client.post(f"/api/email/{EMAIL_ID}/pin", json={"pinned": True})
    assert r.status_code == 200
    method, iid, kw = _last(svc_spy)
    assert method == "set_pin"
    assert iid == EMAIL_ID
    assert kw["pinned"] is True
    assert kw["actor"].authenticated is True
    # pin 不做 pm2 检测 → 无 allow_concurrent。
    assert "allow_concurrent" not in kw
    data = r.json()["data"]
    assert data["is_pinned"] is True
    assert data["dry_run"] is False


def test_unpin_passes_pinned_false(client, svc_spy):
    r = client.post(f"/api/email/{EMAIL_ID}/pin", json={"pinned": False})
    assert r.status_code == 200
    method, _, kw = _last(svc_spy)
    assert method == "set_pin"
    assert kw["pinned"] is False


def test_pin_dry_run_uses_plan_and_skips_actor(client, svc_spy):
    r = client.post(f"/api/email/{EMAIL_ID}/pin", json={"pinned": True, "dryRun": True})
    assert r.status_code == 200
    method, _, kw = _last(svc_spy)
    assert method == "plan_pin"
    assert kw["pinned"] is True
    assert "actor" not in kw
    assert r.json()["data"]["dry_run"] is True


def test_pin_requires_bool_400(client, svc_spy):
    r = client.post(f"/api/email/{EMAIL_ID}/pin", json={"pinned": "yes"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert svc_spy.instances == []  # 校验早于 service 构造


def test_pin_not_found_maps_to_404(client, svc_spy):
    _SvcSpy._raise = ServiceNotFoundError("Email with internal_id=42 not found")
    r = client.post("/api/email/42/pin", json={"pinned": True})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


# ===========================================================================
# POST /api/email/{id}/reply-suggestion — in-process set_reply_suggestion
# ===========================================================================


def test_reply_suggestion_passes_args_and_envelope(client, svc_spy):
    r = client.post(
        f"/api/email/{EMAIL_ID}/reply-suggestion",
        json={"replySuggestionMd": "Hi there\n\n----\nBest"},
    )
    assert r.status_code == 200
    method, iid, kw = _last(svc_spy)
    assert method == "set_reply_suggestion"
    assert iid == EMAIL_ID
    assert kw["reply_md"] == "Hi there\n\n----\nBest"
    assert kw["actor"].authenticated is True
    # reply_suggestion 不做 pm2 检测 → 无 allow_concurrent。
    assert "allow_concurrent" not in kw
    data = r.json()["data"]
    assert data["internal_id"] == EMAIL_ID
    assert data["reply_suggestion_md"] == "Hi there\n\n----\nBest"
    assert data["chars"] == len("Hi there\n\n----\nBest")


def test_reply_suggestion_requires_nonempty_400(client, svc_spy):
    for bad in ({}, {"replySuggestionMd": ""}, {"replySuggestionMd": "   "}, {"replySuggestionMd": 5}):
        r = client.post(f"/api/email/{EMAIL_ID}/reply-suggestion", json=bad)
        assert r.status_code == 400
        assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert svc_spy.instances == []  # 校验早于 service 构造


def test_reply_suggestion_not_found_maps_to_404(client, svc_spy):
    _SvcSpy._raise = ServiceNotFoundError("Email with internal_id=42 not found")
    r = client.post("/api/email/42/reply-suggestion", json={"replySuggestionMd": "x"})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


# ===========================================================================
# POST /api/email/{id}/ai-fields — in-process set_ai_fields
# ===========================================================================


def test_ai_fields_passes_camel_args_and_envelope(client, svc_spy):
    r = client.post(
        f"/api/email/{EMAIL_ID}/ai-fields",
        json={
            "aiAction": "需要回复",
            "aiPriority": "🟡 重要",
            "aiReviewStatus": "reviewed",
        },
    )
    assert r.status_code == 200
    method, iid, kw = _last(svc_spy)
    assert method == "set_ai_fields"
    assert iid == EMAIL_ID
    # camelCase body → service kwargs (action / priority / review_status)。
    assert kw["action"] == "需要回复"
    assert kw["priority"] == "🟡 重要"
    assert kw["review_status"] == "reviewed"
    assert kw["actor"].authenticated is True
    # ai_fields 不做 pm2 检测 → 无 allow_concurrent。
    assert "allow_concurrent" not in kw
    data = r.json()["data"]
    assert data["internal_id"] == EMAIL_ID
    assert data["ai_action"] == "需要回复"
    assert data["ai_priority"] == "🟡 重要"
    assert data["ai_review_status"] == "reviewed"


def test_ai_fields_partial_only_one(client, svc_spy):
    r = client.post(f"/api/email/{EMAIL_ID}/ai-fields", json={"aiPriority": "🔴 紧急"})
    assert r.status_code == 200
    _, _, kw = _last(svc_spy)
    assert kw["priority"] == "🔴 紧急"
    assert kw["action"] is None
    assert kw["review_status"] is None


def test_ai_fields_requires_at_least_one_400(client, svc_spy):
    r = client.post(f"/api/email/{EMAIL_ID}/ai-fields", json={})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert svc_spy.instances == []  # 校验早于 service 构造


def test_ai_fields_rejects_non_string_400(client, svc_spy):
    r = client.post(f"/api/email/{EMAIL_ID}/ai-fields", json={"aiPriority": 5})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert svc_spy.instances == []


def test_ai_fields_invalid_enum_maps_to_400(client, svc_spy):
    # service raises ServiceInvalidArgError (非法枚举) → 400。
    _SvcSpy._raise = ServiceInvalidArgError("invalid priority 'HIGH'")
    r = client.post(f"/api/email/{EMAIL_ID}/ai-fields", json={"aiPriority": "HIGH"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_ai_fields_not_found_maps_to_404(client, svc_spy):
    _SvcSpy._raise = ServiceNotFoundError("Email with internal_id=42 not found")
    r = client.post("/api/email/42/ai-fields", json={"aiPriority": "🟡 重要"})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


# ===========================================================================
# POST /api/email/draft + /send + /draft-plan — in-process compose (A4)
# ===========================================================================
# camelCase body + list 收件人 → ComposeRequest (to/cc/bcc join 逗号串, bodyHtml 直接
# 传字符串, 不再落临时文件); 校验 (internalId / mode) 早于 service 构造。


def test_compose_draft_passes_request_and_envelope(client, svc_spy):
    r = client.post(
        "/api/email/draft",
        json={
            "internalId": EMAIL_ID, "mode": "reply",
            "to": ["x@example.com", "y@example.com"], "cc": ["c@example.com"],
            "subject": "Re: hello", "bodyHtml": "<p>hi</p>",
        },
    )
    assert r.status_code == 200
    method, req, kw = _last(svc_spy)
    assert method == "compose_draft"
    assert req.internal_id == EMAIL_ID
    assert req.mode == "reply"
    # list 收件人 join 成逗号串 (service _split_addrs 再提纯); subject 透传。
    assert req.to == "x@example.com,y@example.com"
    assert req.cc == "c@example.com"
    assert req.subject == "Re: hello"
    # bodyHtml 直接传字符串 (A4: 不再落临时文件 --body-html-file)。
    assert req.body_html == "<p>hi</p>"
    # 恒已鉴权 http actor; compose 不传 allow_concurrent。
    assert kw["actor"].authenticated is True
    assert kw["actor"].kind == "http"
    assert "allow_concurrent" not in kw
    data = r.json()["data"]
    assert data["success"] is True
    assert data["drafts_folder"] == "Drafts"
    assert data["mode"] == "reply"
    assert data["dry_run"] is False


def test_compose_draft_no_body_html_is_none(client, svc_spy):
    r = client.post("/api/email/draft", json={"internalId": EMAIL_ID, "mode": "reply"})
    assert r.status_code == 200
    _, req, _ = _last(svc_spy)
    assert req.body_html is None
    # forceSubject 缺省 → False (agent/CLI 路径默认受改主题守卫约束)
    assert req.force_subject is False


def test_compose_draft_force_subject_passthrough(client, svc_spy):
    # 前端 composer 恒传 forceSubject: true (用户改题是明确意图) → ComposeRequest.force_subject
    r = client.post(
        "/api/email/draft",
        json={"internalId": EMAIL_ID, "mode": "reply", "subject": "改过的主题", "forceSubject": True},
    )
    assert r.status_code == 200
    _, req, _ = _last(svc_spy)
    assert req.subject == "改过的主题"
    assert req.force_subject is True


def test_compose_draft_camel_keys_not_leaked(client, svc_spy):
    # camelCase body (internalId/bodyHtml) → ComposeRequest 字段, 不泄漏成 CLI flag。
    r = client.post(
        "/api/email/draft",
        json={"internalId": EMAIL_ID, "mode": "forward", "bodyHtml": "<p>x</p>"},
    )
    assert r.status_code == 200
    _, req, _ = _last(svc_spy)
    assert req.internal_id == EMAIL_ID
    assert req.mode == "forward"
    assert req.body_html == "<p>x</p>"


def test_compose_draft_new_mode_allows_sentinel_internal_id(client, svc_spy):
    # 写新邮件: 哨兵 internalId=-1 + mode='new' 不被 _require_compose_internal_id 拒
    # (adapter 层放宽), 透传到 service。回归 codex review HIGH (adapter 校验先于 service)。
    r = client.post(
        "/api/email/draft",
        json={
            "internalId": -1, "mode": "new",
            "to": ["x@example.com"], "subject": "New mail", "bodyHtml": "<p>hi</p>",
        },
    )
    assert r.status_code == 200, r.text
    method, req, _ = _last(svc_spy)
    assert method == "compose_draft"
    assert req.internal_id == -1
    assert req.mode == "new"
    assert req.to == "x@example.com"


def test_compose_draft_non_new_rejects_sentinel_internal_id(client):
    # 对照: 放宽只针对 mode='new' — 非 new 模式 + 负 internalId 仍被 adapter 拒, 不到 service。
    r = client.post("/api/email/draft", json={"internalId": -1, "mode": "reply"})
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_compose_draft_missing_internal_id_400(client, svc_spy):
    r = client.post("/api/email/draft", json={"mode": "reply"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert svc_spy.instances == []  # 校验早于 service 构造


def test_compose_draft_invalid_mode_400(client, svc_spy):
    r = client.post("/api/email/draft", json={"internalId": EMAIL_ID, "mode": "bogus"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert svc_spy.instances == []


def test_compose_draft_service_error_maps_to_404(client, svc_spy):
    _SvcSpy._raise = ServiceNotFoundError("Email 42 无 reply_suggestion")
    r = client.post("/api/email/draft", json={"internalId": EMAIL_ID, "mode": "reply"})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


def test_compose_send_passes_confirmed_true(client, svc_spy):
    r = client.post(
        "/api/email/send",
        json={"internalId": EMAIL_ID, "mode": "reply", "bodyHtml": "<p>send</p>"},
    )
    assert r.status_code == 200
    method, req, kw = _last(svc_spy)
    assert method == "send"
    assert req.internal_id == EMAIL_ID
    assert req.body_html == "<p>send</p>"
    # send 端点恒 confirmed=True (前端已弹 SendConfirmDialog); 已鉴权 actor; 无 pm2。
    assert kw["confirmed"] is True
    assert kw["actor"].authenticated is True
    assert "allow_concurrent" not in kw
    data = r.json()["data"]
    assert data["sent"] is True
    assert data["message_id"] == "<m@x>"


def test_compose_send_invalid_mode_400(client, svc_spy):
    r = client.post("/api/email/send", json={"internalId": EMAIL_ID, "mode": "bogus"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert svc_spy.instances == []


def test_draft_plan_uses_compose_plan_no_actor(client, svc_spy):
    r = client.post(f"/api/email/{EMAIL_ID}/draft-plan", json={"mode": "reply"})
    assert r.status_code == 200
    method, req, kw = _last(svc_spy)
    assert method == "compose_plan"
    assert req.internal_id == EMAIL_ID
    assert req.mode == "reply"
    assert "actor" not in kw  # dry-run 跳过 auth
    assert r.json()["data"]["dry_run"] is True


def test_draft_plan_snake_case_passthrough(client, svc_spy):
    # DraftPlanResult snake_case (reply_html / forward_intro_html / reply_source) 原样透传。
    r = client.post(f"/api/email/{EMAIL_ID}/draft-plan", json={"mode": "reply"})
    assert r.status_code == 200
    data = r.json()["data"]
    assert "reply_html" in data
    assert "reply_source" in data
    assert "replyHtml" not in data
    assert "forwardIntroHtml" not in data


# ===========================================================================
# POST /api/llm/run/{id} — in-process LlmService.run (A3, query-param opts)
# ===========================================================================


class _LlmSvcSpy:
    """``LlmService`` 替身: 记录 run 调用, 返回 canned LlmRunResult。"""

    instances: list["_LlmSvcSpy"] = []
    _raise: Optional[Exception] = None

    def __init__(self, ctx=None):
        self.ctx = ctx
        self.calls: list[tuple] = []
        _LlmSvcSpy.instances.append(self)

    def run(self, internal_id, *, dry_run=False, force=False, no_overwrite=False, actor):
        self.calls.append((
            "run", internal_id,
            {"dry_run": dry_run, "force": force, "no_overwrite": no_overwrite,
             "actor": actor},
        ))
        if _LlmSvcSpy._raise is not None:
            raise _LlmSvcSpy._raise
        return LlmRunResult(internal_id=internal_id, page_id="pg", mailbox="收件箱",
                            dry_run=dry_run, skipped=None, labels={"x": 1},
                            writer_summary=None, stored_at=None)


@pytest.fixture()
def llm_svc_spy(monkeypatch):
    """Patch llm router 的 LlmService with a fresh recording spy."""
    _LlmSvcSpy.instances = []
    _LlmSvcSpy._raise = None
    monkeypatch.setattr(llm_router, "LlmService", _LlmSvcSpy)
    return _LlmSvcSpy


def _last_llm(spy):
    assert spy.instances, "LlmService was never constructed"
    inst = spy.instances[-1]
    assert inst.calls, "run was never called"
    return inst.calls[-1]


def test_llm_run_executed_passes_args(client, llm_svc_spy):
    r = client.post(f"/api/llm/run/{EMAIL_ID}?force=true")
    assert r.status_code == 200
    method, iid, kw = _last_llm(llm_svc_spy)
    assert method == "run"
    assert iid == EMAIL_ID
    assert kw["force"] is True
    assert kw["dry_run"] is False
    assert kw["no_overwrite"] is False
    # llm run 端点总传已鉴权 actor (service.run 内部按 dry_run 决定是否 require_write_auth)。
    assert kw["actor"].authenticated is True
    assert kw["actor"].kind == "http"
    data = r.json()["data"]
    assert data["internal_id"] == EMAIL_ID
    assert data["page_id"] == "pg"
    assert data["labels"] == {"x": 1}
    assert data["dry_run"] is False


def test_llm_run_dry_run_passes_flag(client, llm_svc_spy):
    r = client.post(f"/api/llm/run/{EMAIL_ID}?dry_run=true")
    assert r.status_code == 200
    _, _, kw = _last_llm(llm_svc_spy)
    assert kw["dry_run"] is True
    assert r.json()["data"]["dry_run"] is True


def test_llm_run_no_overwrite_passes_flag(client, llm_svc_spy):
    r = client.post(f"/api/llm/run/{EMAIL_ID}?no_overwrite=true")
    assert r.status_code == 200
    _, _, kw = _last_llm(llm_svc_spy)
    assert kw["no_overwrite"] is True


def test_llm_run_failed_maps_to_500(client, llm_svc_spy):
    _LlmSvcSpy._raise = ServiceLLMFailedError("gateway HTTP 500")
    r = client.post(f"/api/llm/run/{EMAIL_ID}")
    assert r.status_code == 500
    assert r.json()["error"]["code"] == "E_LLM_FAILED"


def test_llm_run_not_found_maps_to_404(client, llm_svc_spy):
    _LlmSvcSpy._raise = ServiceNotFoundError("email not synced (notion_page_id empty)")
    r = client.post("/api/llm/run/42")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"
