"""Compose 优化 epic T4 — D1 source_draft_id 复用 linkage + D2 引用分离 marker。

- source_draft_id (Bug A): mode='new' (草稿编辑发送/保存) 读草稿行 draft_* 列恢复
  In-Reply-To/References/internal_id_for_threading; linkage 空/行缺失回退现状零派生。
- marker (Bug B): _build_reply_quote / _build_forward_intro 产出整体包
  <div data-ma-quote="1">…</div>; split_quote 两种模式产物都带。
- HTTP 面: _compose_request_from_body 读 body key "sourceDraftId" (非 int 静默 None)。
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from src.mail.sync_store import SyncStore
from src.services.mail_write import (
    QUOTE_MARKER_ATTR,
    ComposeRequest,
    MailWriteService,
    _build_forward_intro,
    _build_reply_quote,
    _compose_reply_draft,
)

MARKER = f'{QUOTE_MARKER_ATTR}="1"'


# ─────────────────────────────────────────────────────────────────────────────
# 纯函数: _compose_reply_draft mode='new' + source_linkage
# ─────────────────────────────────────────────────────────────────────────────


def _new_draft(source_linkage=None):
    return _compose_reply_draft(
        {}, internal_id=-1, mode="new",
        reply_text="hi", reply_html="<p>hi</p>",
        extra_to=None, extra_cc=None,
        to_override="a@x.com", subject_override="Re: orig",
        self_email="me@x.com",
        source_linkage=source_linkage,
    )


def test_new_mode_without_linkage_zero_derivation():
    draft = _new_draft(None)
    assert draft.in_reply_to is None
    assert draft.references is None
    assert draft.internal_id_for_threading is None


def test_new_mode_restores_linkage():
    draft = _new_draft({
        "in_reply_to": "orig@x",
        "references": "<head@x> <orig@x>",
        "thread_id": "head@x",
        "source_internal_id": 42,
    })
    assert draft.in_reply_to == "<orig@x>"
    assert draft.references == "<head@x> <orig@x>"
    assert draft.internal_id_for_threading == 42


def test_new_mode_linkage_references_missing_derives_from_thread_id():
    """references 缺失 → thread_id + in_reply_to 拼链 (与既有 reply 分支同构)。"""
    draft = _new_draft({
        "in_reply_to": "orig@x",
        "references": None,
        "thread_id": "head@x",
        "source_internal_id": None,
    })
    assert draft.in_reply_to == "<orig@x>"
    assert draft.references == "<head@x> <orig@x>"
    assert draft.internal_id_for_threading is None  # 反查不到原行 → None


def test_new_mode_linkage_thread_root_no_duplicate_chunk():
    """原邮件是线程根 (thread_id == in_reply_to) → references 只有一个 msgid。"""
    draft = _new_draft({
        "in_reply_to": "root@x",
        "references": None,
        "thread_id": "root@x",
        "source_internal_id": 7,
    })
    assert draft.references == "<root@x>"


def test_new_mode_empty_linkage_dict_falls_back():
    draft = _new_draft({"in_reply_to": "", "references": None})
    assert draft.in_reply_to is None
    assert draft.references is None


# ─────────────────────────────────────────────────────────────────────────────
# service: _prepare_draft 读草稿行 linkage
# ─────────────────────────────────────────────────────────────────────────────


def _service(tmp_path):
    svc = MailWriteService.__new__(MailWriteService)
    ctx = MagicMock()
    ctx.sync_store = SyncStore(str(tmp_path / "t.db"))
    ctx.config.user_email = "me@x.com"
    svc._ctx = ctx
    return svc


def _seed_draft_row(store, internal_id=1_000_000_001, **overrides):
    row = {
        "internal_id": internal_id,
        "message_id": f"draft-mid-{internal_id}",
        "subject": "Re: orig",
        "sender": "me@x.com",
        "mailbox": "草稿箱",
        "sync_status": "synced",
        "backend_origin": "davmail",
        "thread_id": "head@x",
        "draft_in_reply_to": "orig@x",
        "draft_references": "<head@x> <orig@x>",
        "draft_source_internal_id": 42,
    }
    row.update(overrides)
    store.save_email(row)
    return row["internal_id"]


def _new_request(source_draft_id):
    # draft-edit 语义 (批次2 finding 5 绑定校验): 前端恒双份传草稿行自己的 id —
    # request.internal_id == sourceDraftId, 否则 linkage 被绑定闸拒。
    return ComposeRequest(
        internal_id=source_draft_id, mode="new",
        to="a@x.com", subject="Re: orig",
        body_html="<p>edited</p>",
        source_draft_id=source_draft_id,
    )


def test_prepare_draft_restores_threading_from_source_draft(tmp_path):
    svc = _service(tmp_path)
    iid = _seed_draft_row(svc._ctx.sync_store)
    draft, warnings, quote = svc._prepare_draft(
        _new_request(iid), allow_missing_reply=False, split_quote=False
    )
    assert draft.in_reply_to == "<orig@x>"
    assert draft.references == "<head@x> <orig@x>"
    assert draft.internal_id_for_threading == 42


def test_prepare_draft_source_row_missing_falls_back(tmp_path):
    svc = _service(tmp_path)
    draft, _, _ = svc._prepare_draft(
        _new_request(999_999), allow_missing_reply=False, split_quote=False
    )
    assert draft.in_reply_to is None
    assert draft.references is None
    assert draft.internal_id_for_threading is None


def test_prepare_draft_source_row_without_linkage_falls_back(tmp_path):
    """存量草稿行 (v36 前, draft_* 列 NULL) → 回退现状零派生。"""
    svc = _service(tmp_path)
    iid = _seed_draft_row(
        svc._ctx.sync_store,
        draft_in_reply_to=None, draft_references=None,
        draft_source_internal_id=None, thread_id=None,
    )
    draft, _, _ = svc._prepare_draft(
        _new_request(iid), allow_missing_reply=False, split_quote=False
    )
    assert draft.in_reply_to is None
    assert draft.references is None


def test_prepare_draft_ignores_source_draft_in_reply_mode(tmp_path):
    """非 'new' 模式忽略 source_draft_id — threading 仍按原邮件 record 推导。"""
    svc = _service(tmp_path)
    store = svc._ctx.sync_store
    store.save_email({
        "internal_id": 5, "message_id": "orig@x", "subject": "orig",
        "sender": "a@x.com", "to_addr": "me@x.com", "mailbox": "收件箱",
        "thread_id": "head@x",
    })
    draft_iid = _seed_draft_row(store, draft_in_reply_to="SHOULD-NOT-USE@x")
    svc._ctx.email_repo.get_body_markdown.return_value = ""
    svc._ctx.email_repo.get_body_html.return_value = None
    req = ComposeRequest(
        internal_id=5, mode="reply", body_text="ok",
        source_draft_id=draft_iid,
    )
    draft, _, _ = svc._prepare_draft(
        req, allow_missing_reply=False, split_quote=False
    )
    assert draft.in_reply_to == "<orig@x>"
    assert "SHOULD-NOT-USE" not in (draft.references or "")


def test_restored_linkage_survives_mime_build(tmp_path):
    """端到端: mode='new' 恢复的 threading 头真的写进发送 MIME (sender 只对
    forward 跳过 threading, new 照写)。"""
    from email.parser import BytesParser

    from src.mail.backend.sender import build_outgoing_mime

    svc = _service(tmp_path)
    iid = _seed_draft_row(svc._ctx.sync_store)
    draft, _, _ = svc._prepare_draft(
        _new_request(iid), allow_missing_reply=False, split_quote=False
    )

    class _Cfg:
        user_email = "me@x.com"
        user_name = ""

    msg = BytesParser().parsebytes(build_outgoing_mime(_Cfg(), draft))
    assert msg.get("In-Reply-To") == "<orig@x>"
    assert msg.get("References") == "<head@x> <orig@x>"


# ─────────────────────────────────────────────────────────────────────────────
# D2: 引用分离 marker
# ─────────────────────────────────────────────────────────────────────────────


def test_build_reply_quote_wrapped_in_marker():
    record = {"sender": "a@x.com", "date_received": "2026-01-01"}
    q_text, q_html = _build_reply_quote(record, "orig body", "<p>orig body</p>")
    assert q_html.startswith(f'<div {MARKER}>')
    assert q_html.endswith("</div>")
    assert "写道" in q_html
    assert "<blockquote" in q_html
    assert "写道" in q_text  # plain text 不带 marker (HTML 专属)


def test_build_forward_intro_wrapped_in_marker():
    record = {
        "sender": "a@x.com", "date_received": "2026-01-01",
        "subject": "orig", "to_addr": "me@x.com",
    }
    _, fi_html = _build_forward_intro(record, "orig body", "<p>orig body</p>")
    assert fi_html.startswith(f'<div {MARKER}>')
    assert fi_html.endswith("</div>")
    assert "Forwarded message" in fi_html


@pytest.fixture
def quote_service(tmp_path):
    """reply 引用块构造用 service: 原邮件行 + email_repo 正文。"""
    svc = _service(tmp_path)
    svc._ctx.sync_store.save_email({
        "internal_id": 1, "message_id": "orig@x", "subject": "orig",
        "sender": "a@x.com", "to_addr": "me@x.com", "mailbox": "收件箱",
        "date_received": "2026-01-01T10:00:00+00:00",
    })
    svc._ctx.email_repo.get_body_markdown.return_value = "orig body"
    svc._ctx.email_repo.get_body_html.return_value = "<p>orig body</p>"
    return svc


def test_merged_reply_html_carries_marker(quote_service):
    """split_quote=False (draft/send 执行路径): 合并正文含 marker 引用块。"""
    req = ComposeRequest(
        internal_id=1, mode="reply", body_html="<p>my reply</p>",
        quote_original=True,
    )
    draft, _, quote = quote_service._prepare_draft(
        req, allow_missing_reply=False, split_quote=False
    )
    assert quote is None
    assert MARKER in (draft.reply_html or "")
    assert draft.reply_html.index("my reply") < draft.reply_html.index(MARKER)


def test_split_quote_html_carries_marker(quote_service):
    """split_quote=True (draft-plan 预填): quote_html 单独给且带 marker,
    reply_html 干净无 marker。"""
    req = ComposeRequest(
        internal_id=1, mode="reply", body_html="<p>my reply</p>",
        quote_original=True,
    )
    draft, _, quote = quote_service._prepare_draft(
        req, allow_missing_reply=False, split_quote=True
    )
    assert quote is not None
    assert quote["html"].startswith(f'<div {MARKER}>')
    assert MARKER not in (draft.reply_html or "")


def test_forward_intro_carries_marker(quote_service):
    req = ComposeRequest(
        internal_id=1, mode="forward", body_html="<p>fyi</p>",
        to="c@x.com", quote_original=True, attachments=[],
    )
    draft, _, _ = quote_service._prepare_draft(
        req, allow_missing_reply=False, split_quote=False
    )
    assert MARKER in (draft.forward_intro_html or "")
