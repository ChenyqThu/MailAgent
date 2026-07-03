"""MailWriteService 附件引用装配 — prd 07-04 D1/D2 (stage_id / attachment_id / local_path).

单元级: 直接驱动 ``_prepare_draft`` / ``send`` (stub ctx, 不碰真实 SQLite/backend),
断言 refs → DraftRequest.attachments 三元组、forward 覆盖语义、失败硬报错
(区别于 forward 自动收集的 warn+skip)、send 成功后 staging 消费清理。
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

import src.services.mail_write as mail_write
from src.services.compose_staging import stage_attachment, staging_root
from src.services.errors import ServiceInvalidArgError
from src.services.guards import Actor
from src.services.mail_write import ComposeRequest, MailWriteService


# ---------------------------------------------------------------------------
# stub ctx (ServiceDeps 结构子集: config / sync_store / email_repo / backend)
# ---------------------------------------------------------------------------


_RECORD = {
    "subject": "Hello",
    "sender": "alice@example.com",
    "to_addr": "me@mycorp.com",
    "cc_addr": "",
    "message_id": "<msg-1@example.com>",
    "thread_id": "",
    "date_received": "2026-07-01 10:00:00",
}


class _StubRepo:
    """email_repo 替身: 一个库内附件 (id=7) + forward 自动收集用的原邮件附件表。"""

    def __init__(self):
        self.records = {
            7: SimpleNamespace(
                id=7, filename="lib.pdf", content_type="application/pdf",
                is_inline=False,
            )
        }
        self.bytes_by_id = {7: b"LIB-PDF-BYTES"}
        # forward 自动收集面 (get_attachments(internal_id))
        self.email_attachments = [
            SimpleNamespace(id=7, filename="lib.pdf",
                            content_type="application/pdf", is_inline=False),
        ]

    def get_attachment_record(self, att_id):
        return self.records.get(att_id)

    def get_attachment_bytes(self, att_id):
        return self.bytes_by_id.get(att_id)

    def get_attachments(self, internal_id):
        return self.email_attachments

    def get_body_markdown(self, internal_id):
        return "orig body"

    def get_body_html(self, internal_id):
        return "<p>orig body</p>"


class _StubStore:
    def get(self, internal_id):
        return dict(_RECORD) if internal_id == 123 else None


class _StubBackend:
    def __init__(self, ok=True):
        self.ok = ok
        self.sent = []

    def send_email(self, draft):
        from src.mail.backend.types import SendResult

        self.sent.append(draft)
        if self.ok:
            return SendResult(success=True, message_id="<s@x>", method="smtp")
        return SendResult(success=False, error="boom")


class _StubCtx:
    def __init__(self, tmp_path: Path, backend=None):
        self.config = SimpleNamespace(
            sync_store_db_path=str(tmp_path / "sync_store.db"),
            user_email="me@mycorp.com",
        )
        self.sync_store = _StubStore()
        self.email_repo = _StubRepo()
        self.backend = backend or _StubBackend()


@pytest.fixture()
def ctx(tmp_path):
    return _StubCtx(tmp_path)


@pytest.fixture()
def svc(ctx):
    return MailWriteService(ctx)


def _prepare(svc, **req_kw):
    req = ComposeRequest(internal_id=123, body_html="<p>hi</p>", **req_kw)
    draft, warnings, _q = svc._prepare_draft(
        req, allow_missing_reply=False, split_quote=False
    )
    return draft, warnings


# ---------------------------------------------------------------------------
# refs 装配
# ---------------------------------------------------------------------------


def test_mixed_stage_and_attachment_and_local_refs(svc, ctx, tmp_path):
    staged = stage_attachment(ctx.config, "up.txt", b"UP-BYTES")
    local = tmp_path / "local.csv"
    local.write_bytes(b"a,b\n1,2\n")
    draft, warnings = _prepare(
        svc, mode="reply",
        attachments=[
            {"stage_id": staged["stage_id"]},
            {"attachment_id": 7},
            {"local_path": str(local)},
        ],
    )
    assert warnings == []
    assert [a[0] for a in draft.attachments] == ["up.txt", "lib.pdf", "local.csv"]
    assert draft.attachments[0][1] == b"UP-BYTES"
    assert draft.attachments[1] == ("lib.pdf", b"LIB-PDF-BYTES", "application/pdf")
    assert draft.attachments[2][2] == "text/csv"


def test_reply_mode_now_carries_attachments(svc, ctx):
    # 修复前 reply/reply-all 的 DraftRequest 恒空附件 — 显式引用后必须带上
    draft, _ = _prepare(svc, mode="reply-all", attachments=[{"attachment_id": 7}])
    assert len(draft.attachments) == 1


def test_new_mode_carries_attachments(svc, tmp_path):
    local = tmp_path / "f.bin"
    local.write_bytes(b"\x00\x01")
    req = ComposeRequest(
        internal_id=-1, mode="new", to="x@y.com", subject="S",
        body_html="<p>hi</p>", attachments=[{"local_path": str(local)}],
    )
    draft, _w, _q = svc._prepare_draft(
        req, allow_missing_reply=False, split_quote=False
    )
    assert draft.attachments == [("f.bin", b"\x00\x01", "application/octet-stream")]


def test_missing_stage_id_raises(svc):
    with pytest.raises(ServiceInvalidArgError, match="暂存不存在或已过期"):
        _prepare(svc, mode="reply", attachments=[{"stage_id": "0" * 32}])


def test_unknown_attachment_id_raises(svc):
    with pytest.raises(ServiceInvalidArgError, match="附件不存在"):
        _prepare(svc, mode="reply", attachments=[{"attachment_id": 999}])


def test_attachment_bytes_missing_raises(svc, ctx):
    ctx.email_repo.bytes_by_id[7] = None
    with pytest.raises(ServiceInvalidArgError, match="读取失败"):
        _prepare(svc, mode="reply", attachments=[{"attachment_id": 7}])


def test_local_path_missing_raises(svc, tmp_path):
    with pytest.raises(ServiceInvalidArgError, match="attach 文件读取失败"):
        _prepare(
            svc, mode="reply",
            attachments=[{"local_path": str(tmp_path / "nope.txt")}],
        )


def test_unknown_ref_shape_raises(svc):
    with pytest.raises(ServiceInvalidArgError, match="stage_id / attachment_id / local_path"):
        _prepare(svc, mode="reply", attachments=[{"foo": 1}])
    with pytest.raises(ServiceInvalidArgError, match="必须是 dict"):
        _prepare(svc, mode="reply", attachments=["not-a-dict"])


def test_cap_breach_raises_not_skips(svc, tmp_path, monkeypatch):
    monkeypatch.setattr(mail_write, "MAX_COMPOSE_ATTACH_BYTES", 10)
    big = tmp_path / "big.bin"
    big.write_bytes(b"x" * 11)
    with pytest.raises(ServiceInvalidArgError, match="总大小超"):
        _prepare(svc, mode="reply", attachments=[{"local_path": str(big)}])


# ---------------------------------------------------------------------------
# forward 覆盖语义: None=自动收集 / 显式 (含 [])=权威列表
# ---------------------------------------------------------------------------


def test_forward_none_auto_collects(svc):
    draft, _ = _prepare(svc, mode="forward", to="x@y.com")
    assert [a[0] for a in draft.attachments] == ["lib.pdf"]


def test_forward_explicit_empty_skips_auto_collect(svc):
    draft, _ = _prepare(svc, mode="forward", to="x@y.com", attachments=[])
    assert draft.attachments == []


def test_forward_explicit_refs_are_authoritative(svc, ctx):
    staged = stage_attachment(ctx.config, "extra.txt", b"E")
    draft, _ = _prepare(
        svc, mode="forward", to="x@y.com",
        attachments=[{"stage_id": staged["stage_id"]}],
    )
    # 只有显式引用的 extra.txt, 原邮件 lib.pdf 未被自动收集
    assert [a[0] for a in draft.attachments] == ["extra.txt"]


# ---------------------------------------------------------------------------
# send: 成功消费清理 staging / 失败保留
# ---------------------------------------------------------------------------


def _send(ctx, staged_id):
    svc = MailWriteService(ctx)
    req = ComposeRequest(
        internal_id=123, mode="reply", body_html="<p>hi</p>",
        attachments=[{"stage_id": staged_id}],
    )
    return svc.send(
        req, actor=Actor(kind="cli", authenticated=True, label="test"),
        confirmed=True,
    )


def test_send_success_discards_staging(tmp_path):
    ctx = _StubCtx(tmp_path, backend=_StubBackend(ok=True))
    staged = stage_attachment(ctx.config, "a.txt", b"A")
    result = _send(ctx, staged["stage_id"])
    assert result.attachments == 1
    assert not (staging_root(ctx.config) / staged["stage_id"]).exists()


def test_send_failure_keeps_staging(tmp_path):
    from src.services.errors import ServiceError

    ctx = _StubCtx(tmp_path, backend=_StubBackend(ok=False))
    staged = stage_attachment(ctx.config, "a.txt", b"A")
    with pytest.raises(ServiceError):
        _send(ctx, staged["stage_id"])
    assert (staging_root(ctx.config) / staged["stage_id"]).is_dir()
