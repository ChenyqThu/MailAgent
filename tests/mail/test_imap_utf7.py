"""modified UTF-7 (RFC 3501) 编解码 — 多文件夹同步文件夹名 ASCII 安全表示。"""
from __future__ import annotations

import pytest

from src.mail.backend.imap_utf7 import decode_imap_utf7, encode_imap_utf7


# 实测样本 (davmail gate 2026-06-08): IMAP 原始名 ↔ 中文 display name
KNOWN = [
    ("DMS&VvpO9lPRXgM-", "DMS固件发布"),
    ("&W1hoYw-", "存档"),
    ("&W,mL3VOGU,KLsF9V-", "对话历史记录"),
    ("&X4VSng-", "待办"),
    ("&X8WJgWWHaGON71+E-", "必要文档路径"),
]


@pytest.mark.parametrize("raw,disp", KNOWN)
def test_decode_known_samples(raw, disp):
    assert decode_imap_utf7(raw) == disp


@pytest.mark.parametrize("raw,disp", KNOWN)
def test_encode_known_samples(raw, disp):
    assert encode_imap_utf7(disp) == raw


@pytest.mark.parametrize(
    "text",
    ["INBOX", "Sent", "Unsent Messages", "Jira", "项目/2026 Q2", "DMS固件发布",
     "多文件夹探针ZZ/子文件夹", "a&b", "纯中文文件夹名", ""],
)
def test_round_trip(text):
    """encode → decode 必回到原文 (含层级路径 / 含 & / 空串)。"""
    assert decode_imap_utf7(encode_imap_utf7(text)) == text


def test_ampersand_literal():
    """字面 & 编码为 &- , 解码回 &。"""
    assert encode_imap_utf7("a&b") == "a&-b"
    assert decode_imap_utf7("a&-b") == "a&b"


def test_ascii_passthrough():
    """纯 ASCII (不含 &) 原样穿透。"""
    assert encode_imap_utf7("Sent Items") == "Sent Items"
    assert decode_imap_utf7("Sent Items") == "Sent Items"


def test_nested_path_delimiter_preserved():
    """层级分隔符 / 是 ASCII, 编码后仍在路径里 (不被 base64 吃掉)。"""
    enc = encode_imap_utf7("测试/子")
    assert "/" in enc
    assert decode_imap_utf7(enc) == "测试/子"


def test_decode_malformed_no_terminator_no_crash():
    """缺结束符 - 的非法分段: 尽力还原, 不抛异常。"""
    out = decode_imap_utf7("good&bad")  # & 后无 -
    assert isinstance(out, str)
    assert out.startswith("good")


def test_decode_malformed_bad_base64_no_crash():
    """非法 base64 分段: 保留原始, 不抛异常。"""
    out = decode_imap_utf7("&@@@-x")
    assert isinstance(out, str)
    assert out.endswith("x")
