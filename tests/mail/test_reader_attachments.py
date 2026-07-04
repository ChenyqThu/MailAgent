"""reader.parse_email_source 附件抽取回归 —— 覆盖 HTML/.txt 文件附件被静默丢弃的 bug。

根因: davmail 主路径 walk 把 text/plain / text/html part 无条件当正文 skip，带
``Content-Disposition: attachment`` 的 text/* 文件附件永远轮不到 attachment 分支 →
被丢弃 (task 07-04-html-attachment-missing)。这里构造取证同形态的合成 MIME
(multipart/mixed → alternative(plain,html) 正文 + text/html 附件 + text/plain 附件，
filename 用 RFC2047 gb2312 encoded-word / folded header) 验证修复。

不落盘: monkeypatch ``_save_and_load_attachments`` 捕获抽取到的 (inline_images +
regular_attachments) 列表，直接断言 filename / content，避开 data/attachments 副作用。
"""
import base64

import pytest

from src.mail.reader import EmailReader


def _encoded_word(text: str, charset: str = "gb2312") -> str:
    """构造 RFC 2047 encoded-word (Outlook/Exchange 中文附件名常见形态)。"""
    token = base64.b64encode(text.encode(charset)).decode("ascii")
    return f"=?{charset}?B?{token}?="


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _build_source(attachment_parts: list[str]) -> str:
    """multipart/mixed: 正文 alternative(plain,html) + 若干附件 part。

    ``attachment_parts`` 是已拼好的 part 块 (不含前导 boundary)，用 CRLF 拼成完整
    MIME 源码 —— 与 IMAP BODY.PEEK 实拉字节口径一致。
    """
    lines = [
        "MIME-Version: 1.0",
        "Message-ID: <att-test@example.com>",
        "Subject: attachment regression",
        "From: sender@example.com",
        "To: me@example.com",
        "Date: Fri, 04 Jul 2026 10:00:00 +0800",
        'Content-Type: multipart/mixed; boundary="MIXED"',
        "",
        "--MIXED",
        'Content-Type: multipart/alternative; boundary="ALT"',
        "",
        "--ALT",
        'Content-Type: text/plain; charset="utf-8"',
        "Content-Transfer-Encoding: 7bit",
        "",
        "BODY_PLAIN_MARKER",
        "--ALT",
        'Content-Type: text/html; charset="utf-8"',
        "Content-Transfer-Encoding: 7bit",
        "",
        "<html><body>BODY_HTML_MARKER</body></html>",
        "--ALT--",
    ]
    for block in attachment_parts:
        lines.append("--MIXED")
        lines.extend(block.split("\n"))
    lines.append("--MIXED--")
    lines.append("")
    return "\r\n".join(lines)


@pytest.fixture
def capture_extracted(monkeypatch):
    """monkeypatch _save_and_load_attachments，捕获抽取列表并原样返回 (不落盘)。"""
    captured: dict = {"extracted": []}

    def fake_save(self, message_id, cid_map=None, inline_images=None, skip_applescript=False):
        captured["extracted"] = list(inline_images or [])
        captured["cid_map"] = cid_map
        return captured["extracted"]

    monkeypatch.setattr(EmailReader, "_save_and_load_attachments", fake_save)
    return captured


def _regular_filenames(extracted: list) -> list[str]:
    """抽取列表里无 Content-ID 的常规附件文件名。"""
    return [a["filename"] for a in extracted if a.get("content_id") is None]


def test_html_file_attachment_extracted_with_decoded_name(capture_extracted):
    """text/html 文件附件 (无 Content-ID, disposition=attachment) 被抽取，中文名解码。"""
    fn = _encoded_word("运维报告.html")
    block = "\n".join([
        f'Content-Type: text/html; charset="gb2312"; name="{fn}"',
        "Content-Transfer-Encoding: base64",
        f'Content-Disposition: attachment; filename="{fn}"',
        "",
        _b64("<html>ATTACHMENT_HTML_CONTENT</html>".encode("gb2312")),
    ])
    email_obj = EmailReader().parse_email_source(
        _build_source([block]), "<att-test@example.com>"
    )
    assert email_obj is not None
    names = _regular_filenames(capture_extracted["extracted"])
    assert "运维报告.html" in names


def test_txt_file_attachment_extracted(capture_extracted):
    """text/plain (.txt) 文件附件同样被抽取，不再当正文丢弃。"""
    fn = _encoded_word("会议纪要.txt")
    block = "\n".join([
        f'Content-Type: text/plain; charset="gb2312"; name="{fn}"',
        "Content-Transfer-Encoding: base64",
        f'Content-Disposition: attachment; filename="{fn}"',
        "",
        _b64("附件正文内容".encode("gb2312")),
    ])
    email_obj = EmailReader().parse_email_source(
        _build_source([block]), "<att-test@example.com>"
    )
    assert email_obj is not None
    names = _regular_filenames(capture_extracted["extracted"])
    assert "会议纪要.txt" in names


def test_body_parts_not_treated_as_attachments(capture_extracted):
    """multipart/alternative 里的 text/plain + text/html 正文不得被当附件。"""
    fn = _encoded_word("运维报告.html")
    block = "\n".join([
        f'Content-Type: text/html; charset="gb2312"; name="{fn}"',
        "Content-Transfer-Encoding: base64",
        f'Content-Disposition: attachment; filename="{fn}"',
        "",
        _b64("<html>ATTACHMENT_HTML_CONTENT</html>".encode("gb2312")),
    ])
    email_obj = EmailReader().parse_email_source(
        _build_source([block]), "<att-test@example.com>"
    )
    assert email_obj is not None
    # 正文取自 alternative 的 text/html，不含附件内容
    assert email_obj.content_type == "text/html"
    assert "BODY_HTML_MARKER" in email_obj.content
    assert "ATTACHMENT_HTML_CONTENT" not in email_obj.content
    # 只抽出 1 个附件（两条正文 part 未混入）
    assert len(_regular_filenames(capture_extracted["extracted"])) == 1


def test_text_html_attachment_without_filename_skipped(capture_extracted):
    """无 filename 的 text/html attachment part 照旧跳过 (reader :720-721 现状语义)。"""
    block = "\n".join([
        'Content-Type: text/html; charset="utf-8"',
        "Content-Transfer-Encoding: 7bit",
        "Content-Disposition: attachment",
        "",
        "<html>NAMELESS_ATTACHMENT</html>",
    ])
    email_obj = EmailReader().parse_email_source(
        _build_source([block]), "<att-test@example.com>"
    )
    assert email_obj is not None
    assert _regular_filenames(capture_extracted["extracted"]) == []


def test_folded_disposition_header_real_form(capture_extracted):
    """取证实测形态: disposition 折行 (attachment;\\r\\n\\tfilename=...) 仍被抽取。"""
    fn = _encoded_word("运维报告.html")
    block = "\n".join([
        f'Content-Type: text/html; charset="gb2312"; name="{fn}"',
        "Content-Transfer-Encoding: base64",
        "Content-Disposition: attachment;",
        f'\tfilename="{fn}"',
        "",
        _b64("<html>FOLDED_ATTACHMENT</html>".encode("gb2312")),
    ])
    email_obj = EmailReader().parse_email_source(
        _build_source([block]), "<att-test@example.com>"
    )
    assert email_obj is not None
    names = _regular_filenames(capture_extracted["extracted"])
    assert "运维报告.html" in names
