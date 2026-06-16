"""build_outgoing_mime MIME 结构测试 (reply / forward / 附件).

sender.build_outgoing_mime 是 davmail/applescript 共享的发件 MIME 构造单一来源.
覆盖: reply 线程头 / forward 跳过线程头 + intro 追加 / 附件 multipart/mixed.
"""
from __future__ import annotations

from email.parser import BytesParser

from src.mail.backend.sender import build_outgoing_mime
from src.mail.backend.types import DraftRequest


class _FakeCfg:
    user_email = "me@tp-link.com"
    user_name = ""


def _parse(draft: DraftRequest):
    return BytesParser().parsebytes(build_outgoing_mime(_FakeCfg(), draft))


def test_reply_has_threading_headers():
    d = DraftRequest(
        mode="reply", to=["a@b.com"], subject="Re: hi",
        reply_text="hello", reply_html="<p>hello</p>",
        in_reply_to="<x@y>", references="<t@y> <x@y>",
    )
    m = _parse(d)
    assert m.get("In-Reply-To") == "<x@y>"
    assert m.get("References") == "<t@y> <x@y>"
    assert m.get_content_type() == "multipart/alternative"


def test_reply_in_reply_to_wrapped_in_angle_brackets():
    d = DraftRequest(mode="reply", to=["a@b.com"], subject="Re: hi",
                     reply_text="x", in_reply_to="bare@id")
    m = _parse(d)
    assert m.get("In-Reply-To") == "<bare@id>"


def test_forward_omits_threading_headers():
    # forward 是独立邮件 — 即使 DraftRequest 带 in_reply_to / references 也不写
    d = DraftRequest(
        mode="forward", to=["c@d.com"], subject="Fwd: hi",
        reply_text="fyi", in_reply_to="<x@y>", references="<x@y>",
        forward_intro_text="---------- Forwarded message ----------\nFrom: a@b",
    )
    m = _parse(d)
    assert m.get("In-Reply-To") is None
    assert m.get("References") is None


def test_forward_intro_appended_to_plain_body():
    d = DraftRequest(
        mode="forward", to=["c@d.com"], subject="Fwd: hi", reply_text="my note",
        forward_intro_text="---------- Forwarded message ----------\nFrom: a@b",
    )
    m = _parse(d)
    plain = next(p for p in m.walk() if p.get_content_type() == "text/plain")
    body = plain.get_payload(decode=True).decode("utf-8")
    assert "my note" in body
    assert "Forwarded message" in body


def test_attachments_produce_multipart_mixed():
    d = DraftRequest(
        mode="forward", to=["c@d.com"], subject="Fwd: hi", reply_text="fyi",
        attachments=[
            ("report.pdf", b"%PDF-1.4 x", "application/pdf"),
            ("data.csv", b"a,b,c", "text/csv"),
        ],
    )
    m = _parse(d)
    assert m.get_content_type() == "multipart/mixed"
    names = sorted(p.get_filename() for p in m.walk() if p.get_filename())
    assert names == ["data.csv", "report.pdf"]
    pdf = next(p for p in m.walk() if p.get_filename() == "report.pdf")
    assert pdf.get_content_type() == "application/pdf"


def test_reply_no_attachment_stays_alternative():
    d = DraftRequest(mode="reply-all", to=["a@b.com"], subject="Re: hi",
                     reply_text="x", reply_html="<p>x</p>")
    m = _parse(d)
    assert m.get_content_type() == "multipart/alternative"


def test_malformed_attachment_entry_skipped():
    # 长度不对的 attachment tuple 应被跳过, 不抛
    d = DraftRequest(
        mode="forward", to=["c@d.com"], subject="Fwd: hi", reply_text="fyi",
        attachments=[("only-two", b"x")],  # type: ignore[list-item]
    )
    m = _parse(d)
    names = [p.get_filename() for p in m.walk() if p.get_filename()]
    assert names == []


# ─────────────────────────────────────────────────────────────────────────────
# importance 头 (Importance + X-Priority + X-MSMail-Priority 三组业界标准头)
# ─────────────────────────────────────────────────────────────────────────────


def test_importance_high_writes_all_three_headers():
    d = DraftRequest(mode="reply", to=["a@b.com"], subject="Re: hi",
                     reply_text="x", importance="high")
    m = _parse(d)
    assert m.get("Importance") == "High"
    assert m.get("X-Priority") == "1"
    assert m.get("X-MSMail-Priority") == "High"


def test_importance_low_writes_all_three_headers():
    d = DraftRequest(mode="reply", to=["a@b.com"], subject="Re: hi",
                     reply_text="x", importance="low")
    m = _parse(d)
    assert m.get("Importance") == "Low"
    assert m.get("X-Priority") == "5"
    assert m.get("X-MSMail-Priority") == "Low"


def test_importance_normal_writes_no_headers():
    d = DraftRequest(mode="reply", to=["a@b.com"], subject="Re: hi",
                     reply_text="x", importance="normal")
    m = _parse(d)
    assert m.get("Importance") is None
    assert m.get("X-Priority") is None
    assert m.get("X-MSMail-Priority") is None


def test_importance_none_writes_no_headers():
    d = DraftRequest(mode="reply", to=["a@b.com"], subject="Re: hi",
                     reply_text="x")
    m = _parse(d)
    assert m.get("Importance") is None
    assert m.get("X-Priority") is None
    assert m.get("X-MSMail-Priority") is None


def test_importance_case_insensitive():
    # "HIGH" / 带空格 大小写不敏感 — 仍写 High 头
    d = DraftRequest(mode="reply", to=["a@b.com"], subject="Re: hi",
                     reply_text="x", importance="  HIGH  ")
    m = _parse(d)
    assert m.get("Importance") == "High"
    assert m.get("X-Priority") == "1"
