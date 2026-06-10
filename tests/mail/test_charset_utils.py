"""charset_utils — 声明 charset 与实际字节不符的超集解码（gb2312/GBK 乱码修复）.

复现场景: 简中版 Outlook/Exchange 声明 ``charset=gb2312``, 实际字节是 GBK/GB18030
(繁体字、智能标点 – 落在 GBK 扩展区). 旧逻辑 strict-subset decode +
``errors="replace"`` → U+FFFD + ASCII 残留 (``�f``=協 / ``�x``=謝 / ``�C``=–).
"""
import base64
import email
from email import policy

from src.mail.backend.davmail_backend import _decode_mime_header
from src.mail.charset_utils import (
    decode_mime_bytes,
    decode_text_part,
    normalize_charset,
)
from src.mail.reader import EmailReader

# 用户反馈截图的指纹文本（繁体在 GBK 扩展区, trail byte 落 ASCII 区）
TRAD = "昨日已完成618 APP 推播任務檢查，再麻煩協助審核，希望6/12下班前協助完成，謝謝。"


def _mime_bytes(body: str, charset_decl: str, encode_as: str, subtype: str = "html") -> bytes:
    return (
        f"Subject: t\r\nMIME-Version: 1.0\r\n"
        f"Content-Type: text/{subtype}; charset={charset_decl}\r\n"
        f"Content-Transfer-Encoding: base64\r\n\r\n"
    ).encode("ascii") + base64.encodebytes(body.encode(encode_as))


class TestNormalizeCharset:
    def test_missing_falls_back_utf8(self):
        assert normalize_charset(None) == "utf-8"
        assert normalize_charset("") == "utf-8"

    def test_gb_family_to_gb18030(self):
        for cs in ("gb2312", "GB2312", '"gb2312"', "gbk", "csgb2312", "euc-cn"):
            assert normalize_charset(cs) == "gb18030", cs

    def test_big5_to_hkscs(self):
        assert normalize_charset("big5") == "big5hkscs"
        assert normalize_charset("Big5") == "big5hkscs"

    def test_passthrough_unmapped(self):
        assert normalize_charset("utf-8") == "utf-8"
        assert normalize_charset("ISO-8859-1") == "iso-8859-1"


class TestDecodeMimeBytes:
    def test_gbk_bytes_declared_gb2312(self):
        """指纹 case: 旧逻辑乱码（回归基线），新逻辑还原."""
        raw = TRAD.encode("gb18030")
        old = raw.decode("gb2312", errors="replace")
        assert "�" in old  # 旧行为确实产出 U+FFFD
        assert decode_mime_bytes(raw, "gb2312") == TRAD

    def test_real_gb2312_bytes_unchanged(self):
        """超集解码对合法 gb2312 字节逐字节一致 — 零回归."""
        s = "纯简体内容，回复：测试。"
        raw = s.encode("gb2312")
        assert decode_mime_bytes(raw, "gb2312") == raw.decode("gb2312")

    def test_smart_dash_gbk(self):
        """纯英文 + Word 智能破折号 – 同样中招（本机库 Sales Lead �C 案例）."""
        s = "Sales Lead – ACT Project"
        raw = s.encode("gb18030")
        assert decode_mime_bytes(raw, "gb2312") == s

    def test_big5_bytes_declared_big5(self):
        s = "請協助審核，謝謝"
        raw = s.encode("big5")
        assert decode_mime_bytes(raw, "big5") == s

    def test_missing_charset_utf8(self):
        assert decode_mime_bytes(TRAD.encode("utf-8"), None) == TRAD

    def test_unknown_charset_falls_back_utf8(self):
        assert decode_mime_bytes(TRAD.encode("utf-8"), "x-no-such-charset") == TRAD

    def test_garbage_bytes_never_raise(self):
        out = decode_mime_bytes(b"\xff\xfe\x81", "gb2312")
        assert isinstance(out, str)


class TestDecodeTextPart:
    def test_gbk_declared_gb2312(self):
        msg = email.message_from_bytes(
            _mime_bytes(f"<html><body>{TRAD}</body></html>", "gb2312", "gb18030"),
            policy=policy.default,
        )
        assert "�" in msg.get_content()  # 旧路径（get_content）基线乱码
        assert TRAD in decode_text_part(msg)

    def test_utf8_same_as_get_content(self):
        msg = email.message_from_bytes(
            _mime_bytes("<p>hello 中文</p>", "utf-8", "utf-8"),
            policy=policy.default,
        )
        assert decode_text_part(msg) == msg.get_content()


class TestDecodeMimeHeader:
    def test_gbk_encoded_word_declared_gb2312(self):
        """本机库 1000004545 案例: 主题存成 raw =?gb2312?B?...?= 的根因."""
        original = "回复: 協助審核 – 測試"
        token = base64.b64encode(original.encode("gb18030")).decode("ascii")
        assert _decode_mime_header(f"=?gb2312?B?{token}?=") == original

    def test_plain_ascii_passthrough(self):
        assert _decode_mime_header("Re: hello") == "Re: hello"

    def test_valid_gb2312_encoded_word(self):
        original = "回复: 测试"
        token = base64.b64encode(original.encode("gb2312")).decode("ascii")
        assert _decode_mime_header(f"=?gb2312?B?{token}?=") == original

    def test_empty(self):
        assert _decode_mime_header(None) == ""
        assert _decode_mime_header("") == ""


class TestReaderEndToEnd:
    def test_parse_email_source_gbk_declared_gb2312(self):
        """davmail 主路径: source(str) → parse_email_source → Email.content 无乱码."""
        source = _mime_bytes(f"<html><body>{TRAD}</body></html>", "gb2312", "gb18030").decode("ascii")
        email_obj = EmailReader().parse_email_source(source=source, message_id="<t@charset>")
        assert email_obj is not None
        assert email_obj.content_type == "text/html"
        assert TRAD in email_obj.content
        assert "�" not in email_obj.content

    def test_parse_email_source_plaintext_gbk(self):
        source = _mime_bytes(TRAD, "gb2312", "gb18030", subtype="plain").decode("ascii")
        email_obj = EmailReader().parse_email_source(source=source, message_id="<t2@charset>")
        assert email_obj is not None
        assert TRAD in email_obj.content
        assert "�" not in email_obj.content
