"""build_outgoing_mime MIME 结构测试 (reply / forward / 附件).

sender.build_outgoing_mime 是 davmail/applescript 共享的发件 MIME 构造单一来源.
覆盖: reply 线程头 / forward 跳过线程头 + intro 追加 / 附件 multipart/mixed.
"""
from __future__ import annotations

from email import policy
from email.parser import BytesParser

from src.mail.backend.sender import build_outgoing_mime
from src.mail.backend.types import DraftRequest


class _FakeCfg:
    user_email = "me@tp-link.com"
    user_name = ""


def _parse(draft: DraftRequest):
    return BytesParser().parsebytes(build_outgoing_mime(_FakeCfg(), draft))


def _parse_default(draft: DraftRequest):
    """default policy 解析 — header 返回 unfold 后的逻辑值。

    长 header 序列化时会被 email 库合法 RFC-fold (行 ≤78 字符, continuation
    以空白开头); compat32 的 ``get`` 原样返回带 fold 换行的 wire 值, default
    policy 则还原为逻辑值, 适合断言"内容已 unfold 干净"。
    """
    return BytesParser(policy=policy.default).parsebytes(
        build_outgoing_mime(_FakeCfg(), draft)
    )


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


# ─────────────────────────────────────────────────────────────────────────────
# header CR/LF sanitize — 原邮件长 Subject 被 RFC 折叠后入库残留 \n (真机
# internal_id=1000000950); forward/reply/send/草稿 全走 build_outgoing_mime,
# 直接塞含换行的 header 会让 Python email 序列化抛
# "Header values may not contain linefeed or carriage return characters".
# 修复: _sanitize_header unfold (换行+随后空白 → 单空格) + strip。
# ─────────────────────────────────────────────────────────────────────────────


def test_forward_subject_with_folded_newline_does_not_crash():
    # 复现 internal_id=1000000950: subject 含 RFC 折叠残留的 "\n " continuation.
    d = DraftRequest(
        mode="forward", to=["c@d.com"],
        subject="Fwd: Re: [R&D Internal Project] AI-Enhanced PDLC Workflow for the App\n Team_project approval",
        reply_text="fyi",
        forward_intro_text="---------- Forwarded message ----------\nFrom: a@b",
    )
    # 修复前: build_outgoing_mime 在 as_bytes() 抛 ValueError。能解析即证明没抛。
    m = _parse_default(d)
    # default policy 返回 unfold 后逻辑值 — 换行已归一为单空格。
    assert str(m["Subject"]) == (
        "Fwd: Re: [R&D Internal Project] AI-Enhanced PDLC Workflow "
        "for the App Team_project approval"
    )


def test_subject_with_crlf_is_unfolded():
    d = DraftRequest(mode="reply", to=["a@b.com"],
                     subject="Re: line1\r\n line2", reply_text="x")
    m = _parse(d)
    assert m.get("Subject") == "Re: line1 line2"


def test_recipient_with_newline_does_not_crash():
    d = DraftRequest(mode="forward", to=["a@b.com", "x@y.com\n bad@z.com"],
                     subject="Fwd: hi", reply_text="x")
    m = _parse(d)
    to = m.get("To")
    assert "\n" not in to and "\r" not in to


def test_attachment_filename_with_newline_does_not_crash():
    d = DraftRequest(
        mode="forward", to=["c@d.com"], subject="Fwd: hi", reply_text="fyi",
        attachments=[("report\n v2.pdf", b"%PDF-1.4 x", "application/pdf")],
    )
    m = _parse(d)  # 修复前: add_attachment 在此抛 ValueError
    names = [p.get_filename() for p in m.walk() if p.get_filename()]
    assert names == ["report v2.pdf"]
    assert all("\n" not in n and "\r" not in n for n in names)
