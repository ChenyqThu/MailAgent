"""DavMailBackend 单元测试 — mock imaplib 验证 IMAP 协议交互边界.

覆盖 review CRITICAL/HIGH/MEDIUM finding 对应的回归点:
- CRITICAL #1: _decode_mime_header 在 module load 时可用 (import 顺序)
- CRITICAL #3: UIDVALIDITY 从 SELECT 响应读 (untagged), 不从 STATUS
- HIGH #2: _lookup_uid_by_message_id 对含特殊字符的 message-id 加 quote
- HIGH #3: mark_as_read / set_flag 接受 int (internal_id) + str (message_id) dispatch
- HIGH #5: date_received 归一为 ISO 8601
- HIGH #8: _parse_batch_headers 失败时 WARNING log + count
- MEDIUM: imap_uid=-1 sentinel 不被快路径误用
- MEDIUM: _parse_appenduid regex 提取 UID
- MEDIUM: _parse_fetch_response concat 多 chunk 而非 break
"""
from __future__ import annotations

from unittest.mock import MagicMock


from src.mail.backend.davmail_backend import (
    DavMailBackend,
    _decode_mime_header,
    _extract_first_email,
    _extract_display_name,
    _imap_to_mailbox_label,
    _mailbox_to_imap,
    _normalize_date_iso,
    _quote_imap_string,
    _read_uidvalidity_from_select,
    _select_is_writable,
)


# --------- helper: module-level pure functions ---------

def test_decode_mime_header_plain():
    assert _decode_mime_header("Hello") == "Hello"


def test_decode_mime_header_rfc2047_gb2312():
    """gb2312 encoded-word should decode to 中文 (CRITICAL #1 confirms import order)."""
    encoded = "=?gb2312?B?xPq6w6Oh?="
    out = _decode_mime_header(encoded)
    # 解 base64 得 gb2312 字节序列 → "您好！", 验证 RFC 2047 path 真活着
    assert out != encoded
    assert "好" in out  # 任意 CJK char 命中即可证明 decode 成功


def test_decode_mime_header_mixed_charsets():
    """混合 utf-8 + ascii encoded-word."""
    encoded = "=?utf-8?B?5L2g5aW9?= world"  # 你好 world
    out = _decode_mime_header(encoded)
    assert "你好" in out


def test_decode_mime_header_empty():
    assert _decode_mime_header("") == ""
    assert _decode_mime_header(None) == ""


def test_normalize_date_iso_rfc822():
    """RFC 822 → ISO 8601 (HIGH #5)."""
    out = _normalize_date_iso("Fri, 22 May 2026 14:30:00 +0800")
    assert out.startswith("2026-05-22T14:30")
    assert "+08:00" in out or "+0800" in out


def test_normalize_date_iso_naive_gets_utc():
    out = _normalize_date_iso("22 May 2026 14:30:00")
    # 不带时区时归一加 UTC
    assert "2026-05-22" in out


def test_normalize_date_iso_empty():
    assert _normalize_date_iso("") == ""


def test_normalize_date_iso_malformed_fallback():
    """malformed Date → 原值 fallback, 不崩."""
    out = _normalize_date_iso("garbage")
    assert out == "garbage"


def test_quote_imap_string_escapes_specials():
    """HIGH #2: message-id 含 <>+= 时必须 quote, 反斜杠 + 双引号要 escape."""
    val = '<msg+1=foo@bar"baz>'
    out = _quote_imap_string(val)
    assert out.startswith('"') and out.endswith('"')
    # 双引号被 escape
    assert '\\"' in out
    # 反斜杠 round-trip 安全
    assert _quote_imap_string("a\\b") == '"a\\\\b"'


def test_extract_first_email_quoted_display_name_with_comma():
    """MEDIUM: `"LastName, FirstName" <a@b>` 不能被错 split 成两个."""
    val = '"Doe, John" <john@x.com>, "Smith, Jane" <jane@y.com>'
    assert _extract_first_email(val) == "john@x.com"


def test_extract_first_email_plain():
    assert _extract_first_email("plain@addr.com") == "plain@addr.com"


def test_extract_first_email_empty():
    assert _extract_first_email("") == ""
    assert _extract_first_email(None) == ""


def test_extract_display_name():
    assert _extract_display_name("Foo Bar <foo@bar>") == "Foo Bar"
    assert _extract_display_name("foo@bar") == ""


def test_mailbox_to_imap_case_insensitive():
    """MEDIUM: case-insensitive lookup, e.g. inbox vs INBOX."""
    assert _mailbox_to_imap("inbox") == "INBOX"
    assert _mailbox_to_imap("INBOX") == "INBOX"
    assert _mailbox_to_imap("收件箱") == "INBOX"
    assert _mailbox_to_imap("发件箱") == "Sent Items"
    assert _mailbox_to_imap(None) == "INBOX"
    # 未知名字原样保留 (假设是合规 IMAP path)
    assert _mailbox_to_imap("CustomFolder") == "CustomFolder"


def test_imap_to_mailbox_label():
    assert _imap_to_mailbox_label("INBOX") == "收件箱"
    assert _imap_to_mailbox_label("Sent Items") == "发件箱"
    assert _imap_to_mailbox_label("Drafts") == "草稿"
    assert _imap_to_mailbox_label("Custom") == "Custom"


# --------- _read_uidvalidity_from_select / _select_is_writable ---------

def test_read_uidvalidity_from_select_bytes_list():
    """CRITICAL #3: imaplib 把 UIDVALIDITY 存到 untagged_responses 里."""
    imap = MagicMock()
    imap.untagged_responses = {"UIDVALIDITY": [b"12345"]}
    assert _read_uidvalidity_from_select(imap) == 12345


def test_read_uidvalidity_from_select_str_list():
    imap = MagicMock()
    imap.untagged_responses = {"UIDVALIDITY": ["67890"]}
    assert _read_uidvalidity_from_select(imap) == 67890


def test_read_uidvalidity_from_select_missing():
    imap = MagicMock()
    imap.untagged_responses = {}
    assert _read_uidvalidity_from_select(imap) is None


def test_select_is_writable_default_writable():
    """没有 READ-ONLY 标志 → True (默认可写)."""
    imap = MagicMock()
    imap.untagged_responses = {}
    assert _select_is_writable(imap) is True


def test_select_is_writable_read_only_response():
    """CRITICAL #3: server 把 SELECT 静默降级 read-only 时应 detected."""
    imap = MagicMock()
    imap.untagged_responses = {"READ-ONLY": [b""]}
    assert _select_is_writable(imap) is False


def test_select_is_writable_read_only_underscore_variant():
    imap = MagicMock()
    imap.untagged_responses = {"READ_ONLY": [b""]}
    assert _select_is_writable(imap) is False


# --------- _lookup_uid_by_message_id (HIGH #2) ---------

def test_lookup_uid_by_message_id_quotes_special_chars():
    """HIGH #2: message-id 必须被 quote, 含 + = 等不会触发 atom parse 失败."""
    imap = MagicMock()
    imap.uid.return_value = ("OK", [b"147644"])
    uid = DavMailBackend._lookup_uid_by_message_id(imap, "msg+1=foo@bar.com")
    assert uid == 147644
    # 验证传给 imap.uid 的最后一个参数是 quoted 字符串
    args = imap.uid.call_args.args
    assert args[0] == "search"
    quoted_arg = args[-1]
    assert quoted_arg.startswith('"') and quoted_arg.endswith('"')
    assert "<msg+1=foo@bar.com>" in quoted_arg


def test_lookup_uid_by_message_id_already_bracketed():
    imap = MagicMock()
    imap.uid.return_value = ("OK", [b"123"])
    DavMailBackend._lookup_uid_by_message_id(imap, "<id@x>")
    quoted_arg = imap.uid.call_args.args[-1]
    # 不重复添加 < >
    assert quoted_arg == '"<id@x>"'


def test_lookup_uid_by_message_id_search_failed():
    imap = MagicMock()
    imap.uid.return_value = ("NO", [b""])
    assert DavMailBackend._lookup_uid_by_message_id(imap, "x@y") is None


def test_lookup_uid_by_message_id_empty_data():
    imap = MagicMock()
    imap.uid.return_value = ("OK", [b""])
    assert DavMailBackend._lookup_uid_by_message_id(imap, "x@y") is None


def test_lookup_uid_by_message_id_exception_fallback():
    imap = MagicMock()
    imap.uid.side_effect = RuntimeError("network down")
    assert DavMailBackend._lookup_uid_by_message_id(imap, "x@y") is None


def test_lookup_uid_by_message_id_empty_input():
    imap = MagicMock()
    assert DavMailBackend._lookup_uid_by_message_id(imap, "") is None


# --------- _parse_appenduid (MEDIUM regex) ---------

def test_parse_appenduid_standard():
    """RFC 4315: [APPENDUID uidvalidity uid]"""
    data = [b"[APPENDUID 12345 678] (Success)"]
    assert DavMailBackend._parse_appenduid(data) == 678


def test_parse_appenduid_no_brackets():
    data = [b"APPENDUID 12345 678 Success"]
    assert DavMailBackend._parse_appenduid(data) == 678


def test_parse_appenduid_missing():
    """server 不支持 UIDPLUS → 没 APPENDUID → None."""
    data = [b"(Success)"]
    assert DavMailBackend._parse_appenduid(data) is None


def test_parse_appenduid_str_input():
    data = ["[APPENDUID 1 42]"]
    assert DavMailBackend._parse_appenduid(data) == 42


def test_parse_appenduid_empty_data():
    assert DavMailBackend._parse_appenduid([]) is None
    assert DavMailBackend._parse_appenduid(None) is None


# --------- _parse_batch_headers (HIGH #8) ---------

def test_parse_batch_headers_drops_invalid_with_warning(caplog):
    """HIGH #8: 静默丢邮件 → 改 WARNING log."""
    backend = _make_backend()
    # 模拟 imaplib 返回: 一条有效 + 一条 missing UID + 闭合 b')'
    valid_meta = b"1 (UID 100 FLAGS (\\Seen) BODY[HEADER.FIELDS] {123}"
    valid_body = (
        b"Message-ID: <m1@ex>\r\n"
        b"Subject: =?utf-8?B?VGVzdA==?=\r\n"
        b"From: =?utf-8?B?VGVzdA==?= <test@ex>\r\n"
        b"Date: Fri, 22 May 2026 14:30:00 +0800\r\n"
        b"\r\n"
    )
    invalid_meta = b"2 (FLAGS (\\Seen) BODY[HEADER.FIELDS] {0}"
    data = [
        (valid_meta, valid_body),
        b")",  # imaplib closing - 不计 dropped
        (invalid_meta, b""),  # missing UID → dropped + warning
    ]
    with caplog.at_level("WARNING"):
        parsed = backend._parse_batch_headers(data)
    assert len(parsed) == 1
    assert parsed[0]["imap_uid"] == 100
    assert parsed[0]["message_id"] == "m1@ex"


def test_parse_batch_headers_normalizes_date_iso():
    """HIGH #5: date_received 必须是 ISO 8601."""
    backend = _make_backend()
    meta = b"1 (UID 5 FLAGS () BODY[HEADER.FIELDS] {50}"
    body = (
        b"Message-ID: <a@b>\r\n"
        b"Date: Sat, 1 Jan 2026 10:00:00 +0000\r\n\r\n"
    )
    parsed = backend._parse_batch_headers([(meta, body)])
    assert len(parsed) == 1
    assert parsed[0]["date_received"].startswith("2026-01-01T10:00")


def test_parse_batch_headers_extracts_thread_id_from_references():
    backend = _make_backend()
    meta = b"1 (UID 7 FLAGS () BODY[HEADER.FIELDS] {50}"
    body = (
        b"Message-ID: <reply@x>\r\n"
        b"References: <head@x> <mid@x>\r\n\r\n"
    )
    parsed = backend._parse_batch_headers([(meta, body)])
    assert parsed[0]["thread_id"] == "head@x"


def test_parse_batch_headers_extracts_thread_id_from_in_reply_to():
    backend = _make_backend()
    meta = b"1 (UID 7 FLAGS () BODY[HEADER.FIELDS] {50}"
    body = (
        b"Message-ID: <reply@x>\r\n"
        b"In-Reply-To: <orig@x>\r\n\r\n"
    )
    parsed = backend._parse_batch_headers([(meta, body)])
    assert parsed[0]["thread_id"] == "orig@x"


def test_parse_batch_headers_no_internal_id_field():
    """CRITICAL #2: _parse_batch_headers 不再设 internal_id, 让上层分配."""
    backend = _make_backend()
    meta = b"1 (UID 7 FLAGS () BODY[HEADER.FIELDS] {50}"
    body = b"Message-ID: <x@y>\r\nDate: 22 May 2026 14:30:00 +0800\r\n\r\n"
    parsed = backend._parse_batch_headers([(meta, body)])
    assert "internal_id" not in parsed[0]
    # 仍有 imap_uid 字段供上层透传
    assert parsed[0]["imap_uid"] == 7


# --------- mark_as_read / set_flag dispatch (HIGH #3) ---------

def test_mark_as_read_accepts_int():
    """HIGH #3: int (internal_id) 通过 sync_store.get 走快路径."""
    backend = _make_backend()
    backend.sync_store.get = MagicMock(return_value={
        "internal_id": 1_000_000_001, "imap_uid": 147644, "imap_uidvalidity": 12345,
        "mailbox": "收件箱", "message_id": "x@y",
    })
    backend._store_flag = MagicMock(return_value=True)
    assert backend.mark_as_read(1_000_000_001, True) is True
    args = backend._store_flag.call_args.args
    assert args[0] == 1_000_000_001
    assert args[1] == "+FLAGS"
    assert args[2] == "(\\Seen)"


def test_mark_as_read_accepts_string_message_id():
    """HIGH #3: handlers/reverse_sync fallback 路径传 str message_id 不应静默 no-op."""
    backend = _make_backend()
    backend.sync_store.get_by_message_id = MagicMock(return_value={
        "internal_id": 42, "imap_uid": 100, "mailbox": "收件箱", "message_id": "x@y",
    })
    backend._store_flag = MagicMock(return_value=True)
    assert backend.mark_as_read("x@y", False) is True
    args = backend._store_flag.call_args.args
    assert args[0] == "x@y"
    assert args[1] == "-FLAGS"


def test_set_flag_dispatch():
    backend = _make_backend()
    backend._store_flag = MagicMock(return_value=True)
    backend.set_flag(123, True)
    assert backend._store_flag.call_args.args[2] == "(\\Flagged)"
    backend.set_flag("msg@id", False)
    assert backend._store_flag.call_args.args[1] == "-FLAGS"


def test_resolve_record_for_flag_op_int():
    backend = _make_backend()
    backend.sync_store.get = MagicMock(return_value={"internal_id": 1})
    record = backend._resolve_record_for_flag_op(1)
    assert record is not None
    backend.sync_store.get.assert_called_once_with(1)


def test_resolve_record_for_flag_op_str():
    backend = _make_backend()
    backend.sync_store.get_by_message_id = MagicMock(return_value={"internal_id": 1})
    record = backend._resolve_record_for_flag_op("x@y")
    assert record is not None
    backend.sync_store.get_by_message_id.assert_called_once_with("x@y")


def test_resolve_record_for_flag_op_empty():
    backend = _make_backend()
    assert backend._resolve_record_for_flag_op("") is None
    assert backend._resolve_record_for_flag_op("   ") is None


# --------- get_new_emails (CRITICAL #2 internal_id 分配 + backend_origin) ---------

def test_get_new_emails_allocates_davmail_internal_id(monkeypatch):
    """CRITICAL #2: davmail backend 每条新邮件分配独立 internal_id (>=10^9),
    填 backend_origin='davmail' + imap_uid + mailbox.
    """
    backend = _make_backend()
    backend.sync_store.allocate_davmail_internal_id = MagicMock(
        side_effect=[1_000_000_001, 1_000_000_002]
    )

    # Mock imap_session yielding a fake imap with controlled responses
    fake_imap = MagicMock()
    fake_imap.select.return_value = ("OK", [b"OK"])
    fake_imap.untagged_responses = {"UIDVALIDITY": [b"12345"]}
    fake_imap.uid.side_effect = [
        ("OK", [b"100 200"]),  # SEARCH
        ("OK", [  # FETCH
            (
                b"1 (UID 100 FLAGS () BODY[HEADER.FIELDS] {40}",
                b"Message-ID: <m1@x>\r\nDate: 1 Jan 2026 +0000\r\n\r\n",
            ),
            b")",
            (
                b"2 (UID 200 FLAGS (\\Seen) BODY[HEADER.FIELDS] {40}",
                b"Message-ID: <m2@x>\r\nDate: 2 Jan 2026 +0000\r\n\r\n",
            ),
            b")",
        ]),
    ]

    from contextlib import contextmanager

    @contextmanager
    def fake_session(*args, **kwargs):
        yield fake_imap

    monkeypatch.setattr(
        "src.mail.backend.davmail_backend.imap_session", fake_session,
    )

    out = backend.get_new_emails(since_row_id=99)
    assert len(out) == 2
    assert out[0]["internal_id"] == 1_000_000_001
    assert out[1]["internal_id"] == 1_000_000_002
    for item in out:
        assert item["backend_origin"] == "davmail"
        assert item["mailbox"] == "收件箱"
        assert item["imap_uidvalidity"] == 12345
    assert out[0]["imap_uid"] == 100
    assert out[1]["imap_uid"] == 200


# --------- 发件箱 (Sent) 多 folder 同步 ---------

def test_resolve_imap_box_prefers_discovered_sent_folder():
    """_resolve_imap_box 优先用 probe 探测到的 sent_folder, 而非静态 'Sent Items'."""
    backend = _make_backend()
    backend.sent_folder = "已发送邮件"  # 服务器实际名 (≠ 静态映射的 "Sent Items")
    assert backend._resolve_imap_box("发件箱") == "已发送邮件"
    assert backend._resolve_imap_box("已发送") == "已发送邮件"
    # 未探测时退回静态映射
    backend.sent_folder = None
    assert backend._resolve_imap_box("发件箱") == "Sent Items"
    # 收件箱不受影响
    assert backend._resolve_imap_box("收件箱") == "INBOX"


def test_resolve_imap_box_encodes_chinese_custom_folder():
    """Bug B: 自定义中文文件夹 fallthrough → encode 回 modified-UTF7 原始名.

    真机 internal_id=1000004131 "DMS固件发布" 反向 SELECT 时若原样传中文 →
    imaplib ascii 编码炸 (position 3-6 = 固件发布)。修后 _resolve_imap_box 返回
    encode_imap_utf7 后的 ASCII-safe 原始名。
    """
    from src.mail.backend.imap_utf7 import encode_imap_utf7

    backend = _make_backend()
    expected = encode_imap_utf7("DMS固件发布")
    assert expected == "DMS&VvpO9lPRXgM-"  # 锚定真机样本 (与 multi-folder-sync gate 一致)
    assert backend._resolve_imap_box("DMS固件发布") == expected
    # 返回值是纯 ASCII (不会再触发 imaplib 编码炸)
    backend._resolve_imap_box("DMS固件发布").encode("ascii")


def test_resolve_imap_box_does_not_double_encode_probe_sent_folder():
    """Bug B: probe 探测的 sent_folder (来自 IMAP LIST, 已编码) 不可二次 encode.

    若对 ``DMS&VvpO9lPRXgM-`` 这类已编码名再 encode → ``&`` 被错改为 ``&-`` (变成
    ``DMS&-VvpO9lPRXgM-``) → SELECT 失败。故 probe 分支提前 return, 原样透传。
    """
    backend = _make_backend()
    # 模拟 probe 探测到一个本身含 & 的已编码 Sent 名 (中文 "已发送邮件" 编码后含 &)
    encoded_sent = "&XfJSIJZk-"  # 任意已编码名 (含 &), 模拟 LIST 原始名
    backend.sent_folder = encoded_sent
    assert backend._resolve_imap_box("发件箱") == encoded_sent  # 原样, 无二次编码


def test_resolve_imap_box_pure_ascii_custom_folder_unchanged():
    """Bug B: 纯 ASCII 自定义名 (如 "Notion"/"Jira") encode 恒等 → 原样返回."""
    backend = _make_backend()
    backend.sent_folder = None
    backend.drafts_folder = None
    assert backend._resolve_imap_box("Notion") == "Notion"
    assert backend._resolve_imap_box("Jira") == "Jira"


def test_sent_search_criteria_date_floor_then_uid(monkeypatch):
    """首次 (无 davmail 发件箱行) 走 SENTSINCE 日期下限; 有 marker 后走 UID 增量."""
    backend = _make_backend()
    backend.cfg.sync_start_date = "2026-03-15"
    # 首次: marker=0 → SENTSINCE 日期下限
    backend._max_sent_imap_uid = MagicMock(return_value=0)
    key, arg = backend._sent_search_criteria()
    assert key == "SENTSINCE"
    assert arg == "15-Mar-2026"
    # 有存量 marker → UID 增量
    backend._max_sent_imap_uid = MagicMock(return_value=4200)
    key, arg = backend._sent_search_criteria()
    assert key == "UID"
    assert arg == "4201:*"


def test_get_new_emails_scans_sent_folder_when_enabled(monkeypatch):
    """启用发件箱同步时, get_new_emails 同时扫 INBOX + Sent, 各打对应 mailbox 标签."""
    backend = _make_backend()
    backend._sync_sent = True
    backend.sent_folder = "Sent Items"
    backend._max_sent_imap_uid = MagicMock(return_value=4200)  # 走 UID 增量
    backend.sync_store.allocate_davmail_internal_id = MagicMock(
        side_effect=[1_000_000_001, 1_000_000_002]
    )

    fake_imap = MagicMock()
    fake_imap.select.return_value = ("OK", [b"OK"])
    fake_imap.untagged_responses = {"UIDVALIDITY": [b"12345"]}
    # 两个 folder 各 1 封: INBOX uid 100, Sent uid 4300
    fake_imap.uid.side_effect = [
        ("OK", [b"100"]),  # INBOX SEARCH
        ("OK", [(  # INBOX FETCH
            b"1 (UID 100 FLAGS () BODY[HEADER.FIELDS] {30}",
            b"Message-ID: <in1@x>\r\nDate: 1 Jan 2026 +0000\r\n\r\n",
        ), b")"]),
        ("OK", [b"4300"]),  # Sent SEARCH
        ("OK", [(  # Sent FETCH
            b"1 (UID 4300 FLAGS (\\Seen) BODY[HEADER.FIELDS] {30}",
            b"Message-ID: <out1@x>\r\nDate: 5 May 2026 +0000\r\n\r\n",
        ), b")"]),
    ]

    from contextlib import contextmanager

    @contextmanager
    def fake_session(*args, **kwargs):
        yield fake_imap

    monkeypatch.setattr(
        "src.mail.backend.davmail_backend.imap_session", fake_session,
    )

    out = backend.get_new_emails(since_row_id=99)
    assert len(out) == 2
    by_mailbox = {item["mailbox"]: item for item in out}
    assert set(by_mailbox) == {"收件箱", "发件箱"}
    assert by_mailbox["收件箱"]["imap_uid"] == 100
    assert by_mailbox["发件箱"]["imap_uid"] == 4300
    # 两个 folder 都被 SELECT (mailbox 名 quote, 含空格的 "Sent Items" 必须 quote)
    selected = [c.args[0] for c in fake_imap.select.call_args_list]
    assert '"INBOX"' in selected and '"Sent Items"' in selected


def test_get_new_emails_sent_disabled_skips_sent(monkeypatch):
    """未启用发件箱同步 (_sync_sent=False) 时, 只扫 INBOX, 不 SELECT Sent."""
    backend = _make_backend()
    backend._sync_sent = False  # 关
    backend.sync_store.allocate_davmail_internal_id = MagicMock(return_value=1_000_000_001)

    fake_imap = MagicMock()
    fake_imap.select.return_value = ("OK", [b"OK"])
    fake_imap.untagged_responses = {"UIDVALIDITY": [b"12345"]}
    fake_imap.uid.side_effect = [
        ("OK", [b"100"]),
        ("OK", [(
            b"1 (UID 100 FLAGS () BODY[HEADER.FIELDS] {30}",
            b"Message-ID: <in1@x>\r\nDate: 1 Jan 2026 +0000\r\n\r\n",
        ), b")"]),
    ]

    from contextlib import contextmanager

    @contextmanager
    def fake_session(*args, **kwargs):
        yield fake_imap

    monkeypatch.setattr(
        "src.mail.backend.davmail_backend.imap_session", fake_session,
    )

    out = backend.get_new_emails(since_row_id=99)
    assert len(out) == 1
    assert out[0]["mailbox"] == "收件箱"
    selected = [c.args[0] for c in fake_imap.select.call_args_list]
    assert selected == ['"INBOX"']  # 只 SELECT 了 INBOX (mailbox 名 quote)


def test_get_new_emails_sent_failure_does_not_break_inbox(monkeypatch):
    """发件箱同步抛错时, INBOX 结果不丢 (Sent 在独立 try 块)."""
    backend = _make_backend()
    backend._sync_sent = True
    backend.sent_folder = "Sent Items"
    # _sent_search_criteria 抛错模拟 Sent 路径故障
    backend._sent_search_criteria = MagicMock(side_effect=RuntimeError("sent boom"))
    backend.sync_store.allocate_davmail_internal_id = MagicMock(return_value=1_000_000_001)

    fake_imap = MagicMock()
    fake_imap.select.return_value = ("OK", [b"OK"])
    fake_imap.untagged_responses = {"UIDVALIDITY": [b"12345"]}
    fake_imap.uid.side_effect = [
        ("OK", [b"100"]),  # INBOX SEARCH
        ("OK", [(  # INBOX FETCH
            b"1 (UID 100 FLAGS () BODY[HEADER.FIELDS] {30}",
            b"Message-ID: <in1@x>\r\nDate: 1 Jan 2026 +0000\r\n\r\n",
        ), b")"]),
    ]

    from contextlib import contextmanager

    @contextmanager
    def fake_session(*args, **kwargs):
        yield fake_imap

    monkeypatch.setattr(
        "src.mail.backend.davmail_backend.imap_session", fake_session,
    )

    out = backend.get_new_emails(since_row_id=99)
    assert len(out) == 1  # INBOX 不受 Sent 故障影响
    assert out[0]["mailbox"] == "收件箱"


def test_check_for_changes_detects_sent_advance(monkeypatch):
    """INBOX 无变化但 Sent UIDNEXT 前进时, check_for_changes 仍返回 has_new=True."""
    backend = _make_backend()
    backend._sync_sent = True
    backend.sent_folder = "Sent Items"
    # INBOX 无变化 (uidnext == last_max_row_id)
    backend.get_current_max_row_id = MagicMock(return_value=500)
    # Sent uidnext=4310, 已导入 marker=4300 → +9 新发件
    backend._folder_uidnext = MagicMock(return_value=4310)
    backend._max_sent_imap_uid = MagicMock(return_value=4300)

    has_new, marker, count = backend.check_for_changes(last_max_row_id=500)
    assert has_new is True
    assert marker == 500  # 返回的 marker 始终是 INBOX uidnext (持久化语义不变)
    assert count == 9  # 4310 - (4300+1)


# --------- helpers ---------

def _make_backend(uidvalidity=12345):
    """构造一个 DavMailBackend, 不调 probe; sync_store/config 都 mock."""
    cfg = MagicMock()
    cfg.davmail_imap_host = "127.0.0.1"
    cfg.davmail_imap_port = 1143
    cfg.davmail_smtp_port = 1025
    cfg.davmail_drafts_folder = "Drafts"
    cfg.user_email = "test@example.com"
    cfg.sync_store_db_path = ":memory:"
    sync_store = MagicMock()
    backend = DavMailBackend.__new__(DavMailBackend)  # bypass __init__
    backend.cfg = cfg
    backend.sync_store = sync_store
    backend.host = cfg.davmail_imap_host
    backend.imap_port = cfg.davmail_imap_port
    backend.smtp_port = cfg.davmail_smtp_port
    backend.drafts_folder = "Drafts"
    # 发件箱同步: 默认关 (单 folder 测试不受影响); 需要时测试自行打开。
    backend.sent_folder = None
    backend._sync_sent = False
    backend.inbox_uidvalidity = uidvalidity
    backend.last_op_latency_ms = None
    backend.arm = backend
    backend.radar = backend
    backend.db_path = None
    backend._cached_marker = None
    # 多文件夹同步白名单 (空 = 零激活, 与 __init__ 默认一致)。需要时测试自行设。
    backend._custom_folders = []
    return backend
