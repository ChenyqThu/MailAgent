"""outlook_mime.rebuild_rfc822 保真度闸 (task 08-12 P0 风险核心).

契约: COM 快照重组出的 RFC822 必须能被本仓 ``EmailReader.parse_email_source``
全字段解析 —— subject / from / date / message_id / html 正文 / thread 头 /
附件数 / 中文编码 / .ics MIME 类型 / 内联图 cid 结构。

mock 覆盖不到、必须真机 PoC 验证的点见文件尾 ``POC_CHECKLIST``。
"""
import os

os.environ.setdefault("USER_EMAIL", "ci@example.test")

from datetime import datetime, timezone
from email import policy
from email.parser import Parser

import pytest

from src.mail.backend.outlook_mime import (
    AttachmentSnapshot,
    ItemSnapshot,
    rebuild_rfc822,
)
from src.mail.reader import EmailReader

_PNG = b"\x89PNG\r\n\x1a\n" + b"fake-png-bytes"
_ICS = (
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\n"
    "BEGIN:VEVENT\r\nUID:evt-1@example.test\r\nSUMMARY:Weekly Sync\r\n"
    "DTSTART:20261001T020000Z\r\nDTEND:20261001T030000Z\r\n"
    "END:VEVENT\r\nEND:VCALENDAR\r\n"
).encode("utf-8")

_TRANSPORT_HEADERS = (
    "Received: from relay1.example.test (10.0.0.1) by mx.example.test\r\n"
    "Received: from client.example.test (10.0.0.2) by relay1.example.test\r\n"
    "From: Alice Zhang <alice@example.test>\r\n"
    "To: Bob <bob@example.test>\r\n"
    "Cc: carol@example.test\r\n"
    "Subject: =?utf-8?B?6aG555uu5ZGo5oql?= weekly report\r\n"
    "Date: Thu, 01 Oct 2026 10:00:00 +0800\r\n"
    "Message-ID: <fidelity-1@example.test>\r\n"
    "References: <root@example.test> <mid@example.test>\r\n"
    "In-Reply-To: <mid@example.test>\r\n"
    "Content-Type: multipart/alternative; boundary=\"DEAD-BOUNDARY\"\r\n"
    "MIME-Version: 1.0\r\n"
)


@pytest.fixture
def reader(monkeypatch):
    """EmailReader + 附件捕获 (不落盘 —— 镜像 test_reader_attachments 手法)."""
    r = EmailReader()
    captured: dict = {"attachments": [], "cid_map": None}

    def fake_save(self, message_id, cid_map=None, inline_images=None, skip_applescript=False):
        captured["attachments"] = list(inline_images or [])
        captured["cid_map"] = cid_map
        return captured["attachments"]

    monkeypatch.setattr(EmailReader, "_save_and_load_attachments", fake_save)
    r.captured = captured
    return r


def _snap(**kw) -> ItemSnapshot:
    defaults = dict(
        subject="项目周报 weekly report",
        sender_name="Alice Zhang",
        sender_email="alice@example.test",
        to="Bob <bob@example.test>",
        cc="carol@example.test",
        message_id="<fidelity-1@example.test>",
        received_time=datetime(2026, 10, 1, 2, 0, 0, tzinfo=timezone.utc),
        transport_headers=_TRANSPORT_HEADERS,
        html_body="<html><body><p>本周进展: 完成 <b>MIME 重组</b></p></body></html>",
        plain_body="本周进展: 完成 MIME 重组",
        entry_id="ENTRY-FIDELITY-1",
    )
    defaults.update(kw)
    return ItemSnapshot(**defaults)


# ---------------------------------------------------------------------------
# 基础保真度: 全字段过 EmailReader
# ---------------------------------------------------------------------------


def test_basic_fidelity_through_email_reader(reader):
    source = rebuild_rfc822(_snap())
    email = reader.parse_email_source(
        source, "fidelity-1@example.test", is_read=True, is_flagged=False,
    )
    assert email is not None
    assert email.message_id == "fidelity-1@example.test"
    # HTML 正文进解析产物 (含中文)
    assert "本周进展" in email.content
    assert "MIME 重组" in email.content
    # 线程: References[0] = 线程根; In-Reply-To = 直接父
    assert email.thread_id == "root@example.test"
    assert email.in_reply_to == "mid@example.test"


def test_transport_headers_preserved_and_structural_stripped():
    source = rebuild_rfc822(_snap())
    msg = Parser(policy=policy.default).parsestr(source)
    # 原 transport 头保留 (Received 链完整 = 两条)
    assert len(msg.get_all("Received")) == 2
    assert msg["Message-ID"] == "<fidelity-1@example.test>"
    assert str(msg["Subject"]) == "项目周报 weekly report"
    assert msg["References"] == "<root@example.test> <mid@example.test>"
    # 🔴 结构性头必须剥掉 — 老 boundary 已死, 泄漏会让解析器找错分界
    assert "DEAD-BOUNDARY" not in source
    assert msg.get_content_type() == "multipart/alternative"
    # From 取 transport 原文 (不是快照属性二次合成)
    assert msg["From"] == "Alice Zhang <alice@example.test>"


def test_plain_plus_html_yields_alternative_with_both_parts():
    source = rebuild_rfc822(_snap())
    msg = Parser(policy=policy.default).parsestr(source)
    types = [p.get_content_type() for p in msg.walk()]
    assert "text/plain" in types and "text/html" in types
    html = next(p for p in msg.walk() if p.get_content_type() == "text/html")
    assert "MIME 重组" in html.get_content()  # 中文往返无损


def test_html_only_no_alternative_wrapper():
    source = rebuild_rfc822(_snap(plain_body=None))
    msg = Parser(policy=policy.default).parsestr(source)
    assert msg.get_content_type() == "text/html"


# ---------------------------------------------------------------------------
# 附件: 普通附件 / 中文文件名 / .ics / 内联图
# ---------------------------------------------------------------------------


def test_pdf_attachment_multipart_mixed_and_reader_extraction(reader):
    snap = _snap(
        attachments=[AttachmentSnapshot(
            filename="季度报告.pdf", data=b"%PDF-1.4 fake", mime_type="application/pdf",
        )]
    )
    source = rebuild_rfc822(snap)
    msg = Parser(policy=policy.default).parsestr(source)
    assert msg.get_content_type() == "multipart/mixed"
    pdf = next(p for p in msg.walk() if p.get_filename())
    assert pdf.get_filename() == "季度报告.pdf"  # 中文文件名 RFC2231 往返
    assert pdf.get_content_type() == "application/pdf"
    assert pdf.get_payload(decode=True) == b"%PDF-1.4 fake"

    email = reader.parse_email_source(source, "fidelity-1@example.test")
    assert email is not None
    extracted = reader.captured["attachments"]
    assert len(extracted) == 1


def test_ics_attachment_forced_text_calendar():
    # 会议邀请链 (meeting_sync/icalendar_parser) 按 MIME 类型识别 .ics;
    # COM 侧常给 application/octet-stream → 必须强制 text/calendar
    snap = _snap(
        attachments=[AttachmentSnapshot(
            filename="invite.ics", data=_ICS, mime_type="application/octet-stream",
        )]
    )
    source = rebuild_rfc822(snap)
    msg = Parser(policy=policy.default).parsestr(source)
    ics = next(p for p in msg.walk() if (p.get_filename() or "").endswith(".ics"))
    assert ics.get_content_type() == "text/calendar"
    assert "BEGIN:VCALENDAR" in ics.get_content()
    assert "UID:evt-1@example.test" in ics.get_content()


def test_inline_image_cid_goes_multipart_related(reader):
    snap = _snap(
        html_body=(
            "<html><body><p>看图:</p>"
            '<img src="cid:image001.png@01DA"><p>完</p></body></html>'
        ),
        attachments=[
            AttachmentSnapshot(
                filename="image001.png", data=_PNG,
                content_id="<image001.png@01DA>", mime_type="image/png",
            ),
            AttachmentSnapshot(filename="notes.txt", data=b"plain notes"),
        ],
    )
    source = rebuild_rfc822(snap)
    msg = Parser(policy=policy.default).parsestr(source)
    # 内联图: html 包进 related; 普通附件: 最外层 mixed
    assert msg.get_content_type() == "multipart/mixed"
    related = next(p for p in msg.walk() if p.get_content_type() == "multipart/related")
    png = next(p for p in related.walk() if p.get_content_type() == "image/png")
    assert png.get_payload(decode=True) == _PNG
    assert (png.get("Content-ID") or "").strip("<>") == "image001.png@01DA"
    txt = next(p for p in msg.walk() if p.get_filename() == "notes.txt")
    assert txt.get_content_type() == "text/plain"

    # 过 reader: cid_map 捕获到内联图身份
    email = reader.parse_email_source(source, "fidelity-1@example.test")
    assert email is not None
    cid_map = reader.captured["cid_map"] or {}
    assert any("image001.png@01DA" in cid for cid in cid_map)


def test_attachment_without_cid_reference_stays_regular():
    # content_id 有值但 html 里没有 cid: 引用 → 普通附件 (不塞 related)
    snap = _snap(
        attachments=[AttachmentSnapshot(
            filename="logo.png", data=_PNG, content_id="<unreferenced@x>",
            mime_type="image/png",
        )]
    )
    source = rebuild_rfc822(snap)
    msg = Parser(policy=policy.default).parsestr(source)
    assert not any(p.get_content_type() == "multipart/related" for p in msg.walk())
    assert msg.get_content_type() == "multipart/mixed"


# ---------------------------------------------------------------------------
# 头缺失兜底: 无 transport 头 / 无 Message-ID
# ---------------------------------------------------------------------------


def test_missing_transport_headers_synthesized_from_snapshot(reader):
    snap = _snap(transport_headers=None)
    source = rebuild_rfc822(snap)
    msg = Parser(policy=policy.default).parsestr(source)
    assert msg["From"] == "Alice Zhang <alice@example.test>"
    assert msg["To"] == "Bob <bob@example.test>"
    assert msg["Cc"] == "carol@example.test"
    assert str(msg["Subject"]) == "项目周报 weekly report"
    assert msg["Message-ID"] == "<fidelity-1@example.test>"
    assert msg["Date"] is not None
    email = reader.parse_email_source(source, "fidelity-1@example.test")
    assert email is not None
    assert "本周进展" in email.content


def test_missing_message_id_synthesized_stable_from_entry_id():
    # 空 Message-ID 曾在 MailAgentWin 造成数据事故 — 合成 ID 必须稳定 (同封重抓同 ID)
    snap1 = _snap(transport_headers=None, message_id="", entry_id="ENTRY-X")
    snap2 = _snap(transport_headers=None, message_id="", entry_id="ENTRY-X")
    msg1 = Parser(policy=policy.default).parsestr(rebuild_rfc822(snap1))
    msg2 = Parser(policy=policy.default).parsestr(rebuild_rfc822(snap2))
    assert msg1["Message-ID"] == "<outlook-com-ENTRY-X@mailagent.synthetic>"
    assert msg1["Message-ID"] == msg2["Message-ID"]


def test_garbage_transport_headers_fall_back_to_synthesis():
    snap = _snap(transport_headers="\x00\x01 not headers at all \xff")
    source = rebuild_rfc822(snap)  # 不抛
    msg = Parser(policy=policy.default).parsestr(source)
    assert msg["Message-ID"] == "<fidelity-1@example.test>"
    assert msg["From"] is not None


def test_duplicate_unique_headers_first_wins():
    headers = (
        "Subject: first subject\r\n"
        "Subject: second subject\r\n"
        "From: real@example.test\r\n"
        "Message-ID: <dup@example.test>\r\n"
    )
    snap = _snap(transport_headers=headers, message_id="<dup@example.test>")
    msg = Parser(policy=policy.default).parsestr(rebuild_rfc822(snap))
    assert msg.get_all("Subject") == ["first subject"]


def test_empty_body_still_valid_rfc822(reader):
    snap = _snap(html_body=None, plain_body=None)
    source = rebuild_rfc822(snap)
    email = reader.parse_email_source(source, "fidelity-1@example.test")
    assert email is not None


# ---------------------------------------------------------------------------
# 真机 PoC checklist (mock 覆盖不到, Phase 0 闸门逐项验证)
# ---------------------------------------------------------------------------

POC_CHECKLIST = """
mock 无法覆盖、必须 Windows 真机 PoC 验证的点 (task 08-12 Phase 0):

1. PR_TRANSPORT_MESSAGE_HEADERS 真实可达性: 收件箱正常邮件/草稿/已发送三类
   item 上 DASL 取值成功率 (草稿与已发送常缺 → 走合成路径的真实占比)。
2. HTMLBody 编码: Outlook 返回的 HTMLBody 对非 UTF-8 原件 (gb2312/big5) 是否
   已归一为 Unicode str —— 重组假设输入是 str, 真机需确认无 mojibake。
3. 附件 SaveAsFile 往返: OLE 嵌入对象 (олеObject / .msg 嵌套) 的 SaveAsFile
   行为与 PR_ATTACH_MIME_TAG 缺失率。
4. 内联图 Content-ID 形态: 真实 Exchange 邮件的 PR_ATTACH_CONTENT_ID 是否带
   尖括号/大小写差异 → cid: 匹配命中率。
5. .ics 会议邀请: Outlook 把会议邀请存成 AppointmentItem 时 MailItem 附件里
   是否还有 .ics (可能需要 PR_ATTACH_METHOD 特判)。
6. 超长头/坏头: 真实世界 spam 头对 policy.default 序列化的兜底路径触发率
   (compat32 fallback 分支)。
7. Exchange DN 发件人: GetExchangeUser().PrimarySmtpAddress 解析失败率
   (离职人员/外部联系人 → sender_email 为空的占比)。
"""
