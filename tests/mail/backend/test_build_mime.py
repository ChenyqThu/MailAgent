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


# === fix/reply-thread-rfc2047: 长 Exchange Message-ID 线程头不得被 RFC2047 编码 ===

# 真机长 Message-ID (含 outlook.com 长域名后缀, 含 <> 约 80 字符 > 78 行长上限)
_LONG_TID = "SEYPR04MB7262D3C35F698D3C4BE501BCA4C32@SEYPR04MB7262.apcprd04.prod.outlook.com"
_LONG_MID = "SJ0PR05MB785517F6ADAFA45242A7603E8AEC2@SJ0PR05MB7855.namprd05.prod.outlook.com"


def test_long_message_id_threading_headers_not_rfc2047_encoded():
    """长 Message-ID 的 In-Reply-To/References 绝不能被编码成 ``=?utf-8?q?=3C...?=``.

    修复前: EmailMessage 默认把超 78 字符的 msg-id token RFC2047 编码 → 收件方
    Outlook + 本端回读都解不出线程根 → 回复被切成新线程 (fix/reply-thread-rfc2047).
    """
    import re

    d = DraftRequest(
        mode="reply-all", to=["lucy@x.com"], subject="Re: FW: 云服务目标归属确认",
        reply_text="收到", reply_html="<p>收到</p>",
        in_reply_to=f"<{_LONG_MID}>", references=f"<{_LONG_TID}> <{_LONG_MID}>",
    )
    raw = build_outgoing_mime(_FakeCfg(), d)
    head = raw.decode("utf-8", "replace").split("\n\n", 1)[0]
    for block in re.split(r"\n(?=\S)", head):
        if block.lower().startswith(("references:", "in-reply-to:")):
            assert "=?" not in block, f"线程头被 RFC2047 编码: {block!r}"


def test_long_message_id_references_preserve_full_chain():
    """编码修复不得丢 Message-ID: References 两个 ID 都在, refs[0] 仍是线程根."""
    d = DraftRequest(
        mode="reply-all", to=["lucy@x.com"], subject="Re: hi",
        reply_text="x", in_reply_to=f"<{_LONG_MID}>",
        references=f"<{_LONG_TID}> <{_LONG_MID}>",
    )
    m = _parse_default(d)  # default policy → 逻辑值 (clean 头原样)
    refs = str(m.get("References"))
    assert _LONG_TID in refs and _LONG_MID in refs
    assert refs.split()[0].strip("<>") == _LONG_TID
    assert str(m.get("In-Reply-To")).strip("<>") == _LONG_MID
    # 中文 Subject 不受本修复影响, 仍可正常 decode 回原文
    assert m.get("Subject") == "Re: hi"


# ─────────────────────────────────────────────────────────────────────────────
# 内联图重嵌: 本地 attachments/{id}/{file} src → cid: (multipart/related)
# ─────────────────────────────────────────────────────────────────────────────

_PNG_BYTES = b"\x89PNG\r\n\x1a\nfakepng"


def _cfg_with_store(tmp_path):
    root = tmp_path / "attachments"

    class _Cfg(_FakeCfg):
        attachment_storage_dir = str(root)

    return _Cfg(), root


def test_local_inline_image_reembedded_as_cid(tmp_path):
    """引用原文里的本地内联图路径必须重嵌为 cid: — 否则收件端裂图 (入库时
    cid 已被 _rewrite_cid_to_local 改写成本地相对路径, 只有本地预览解析得了)."""
    cfg, root = _cfg_with_store(tmp_path)
    (root / "42").mkdir(parents=True)
    (root / "42" / "image001.png").write_bytes(_PNG_BYTES)

    d = DraftRequest(
        mode="reply", to=["a@b.com"], subject="Re: hi", reply_text="hello",
        reply_html='<p>hello</p><img src="attachments/42/image001.png" width="120">',
        in_reply_to="<x@y>",
    )
    m = BytesParser(policy=policy.default).parsebytes(build_outgoing_mime(cfg, d))

    html_part = next(p for p in m.walk() if p.get_content_type() == "text/html")
    html = html_part.get_content()
    assert "attachments/42/image001.png" not in html
    assert 'src="cid:' in html

    img = next(p for p in m.walk() if p.get_content_type() == "image/png")
    assert img.get_payload(decode=True) == _PNG_BYTES
    cid = (img.get("Content-ID") or "").strip("<>")
    assert cid and f'src="cid:{cid}"' in html
    # html part 已升级为 multipart/related (仍在 alternative 之下)
    related = next(p for p in m.walk() if p.get_content_type() == "multipart/related")
    assert related is not None


def test_local_inline_image_dedup_same_path_single_part(tmp_path):
    cfg, root = _cfg_with_store(tmp_path)
    (root / "7").mkdir(parents=True)
    (root / "7" / "logo.png").write_bytes(_PNG_BYTES)

    d = DraftRequest(
        mode="reply", to=["a@b.com"], subject="Re: hi", reply_text="x",
        reply_html='<img src="attachments/7/logo.png"><img src=\'attachments/7/logo.png\'>',
    )
    m = BytesParser(policy=policy.default).parsebytes(build_outgoing_mime(cfg, d))
    imgs = [p for p in m.walk() if p.get_content_type() == "image/png"]
    assert len(imgs) == 1  # 同一路径两次引用共用一个 related part


def test_local_inline_image_missing_file_left_as_is(tmp_path):
    cfg, _ = _cfg_with_store(tmp_path)
    d = DraftRequest(
        mode="reply", to=["a@b.com"], subject="Re: hi", reply_text="x",
        reply_html='<img src="attachments/9/gone.png">',
    )
    m = BytesParser(policy=policy.default).parsebytes(build_outgoing_mime(cfg, d))
    html = next(p for p in m.walk() if p.get_content_type() == "text/html").get_content()
    assert 'src="attachments/9/gone.png"' in html  # 缺文件保持原样, 不阻断发送
    assert not any(p.get_content_type() == "image/png" for p in m.walk())


def test_local_inline_image_traversal_rejected(tmp_path):
    cfg, root = _cfg_with_store(tmp_path)
    (root.parent / "secret.png").write_bytes(_PNG_BYTES)
    d = DraftRequest(
        mode="reply", to=["a@b.com"], subject="Re: hi", reply_text="x",
        reply_html='<img src="attachments/1/../../secret.png">',
    )
    m = BytesParser(policy=policy.default).parsebytes(build_outgoing_mime(cfg, d))
    html = next(p for p in m.walk() if p.get_content_type() == "text/html").get_content()
    assert "secret.png" in html  # src 原样保留
    assert not any(p.get_content_type() == "image/png" for p in m.walk())


def test_no_attachment_storage_dir_cfg_noop():
    """_FakeCfg 无 attachment_storage_dir → 整条重嵌逻辑零介入 (向后兼容)."""
    d = DraftRequest(
        mode="reply", to=["a@b.com"], subject="Re: hi", reply_text="x",
        reply_html='<img src="attachments/1/a.png">',
    )
    m = _parse_default(d)
    html = next(p for p in m.walk() if p.get_content_type() == "text/html").get_content()
    assert 'src="attachments/1/a.png"' in html
