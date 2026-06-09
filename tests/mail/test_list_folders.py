"""文件夹发现: IMAP LIST 解析 → FolderInfo + 层级树 + special-use + 系统标记。

不连真实 IMAP — 喂 mock LIST 字节响应 (取自 davmail gate 2026-06-08 实测), 验证纯解析逻辑。
"""
from __future__ import annotations

from src.mail.backend.imap_client import (
    FolderInfo,
    build_folder_tree,
    parse_list_line,
    parse_list_response,
    quote_mailbox,
)


def test_quote_mailbox_space():
    """含空格的 mailbox 名必须 quote (imaplib 不自动加)。"""
    assert quote_mailbox("Unsent Messages") == '"Unsent Messages"'
    assert quote_mailbox("Sent Items") == '"Sent Items"'


def test_quote_mailbox_simple_still_quoted():
    """简单名也加引号 (无害, 实测 davmail 接受 "INBOX")。"""
    assert quote_mailbox("INBOX") == '"INBOX"'


def test_quote_mailbox_escapes_specials():
    """含 \\ 与 \" 的名字按 RFC 3501 quoted-string 转义。"""
    assert quote_mailbox('a"b') == '"a\\"b"'
    assert quote_mailbox("a\\b") == '"a\\\\b"'

# davmail 实测 LIST 响应 (18 文件夹的代表性子集 + 人造嵌套行)
MOCK_LIST = [
    rb'(\HasNoChildren) "/" "INBOX"',
    rb'(\HasNoChildren \Sent) "/" "Sent"',
    rb'(\HasNoChildren \Drafts) "/" "Drafts"',
    rb'(\HasNoChildren \Junk) "/" "Junk"',
    rb'(\HasNoChildren \Trash) "/" "Trash"',
    rb'(\HasNoChildren) "/" "Archive"',
    rb'(\HasNoChildren) "/" "Jira"',
    rb'(\HasNoChildren) "/" "DMS&VvpO9lPRXgM-"',          # DMS固件发布
    rb'(\HasChildren) "/" "&W,mL3VOGU,KLsF9V-"',          # 对话历史记录 (有子)
    rb'(\HasNoChildren) "/" "Unsent Messages"',           # 含空格名
    rb'(\HasNoChildren) "/" "&WRplh072WTljopSI-ZZ/&W1Blh072WTk-"',  # 多文件夹探针ZZ/子文件夹
]


def test_parse_single_line_inbox():
    fi = parse_list_line(rb'(\HasNoChildren) "/" "INBOX"')
    assert fi.imap_name == "INBOX"
    assert fi.display_name == "INBOX"
    assert fi.is_system is True
    assert fi.parent is None


def test_parse_chinese_name_decoded():
    fi = parse_list_line(rb'(\HasNoChildren) "/" "DMS&VvpO9lPRXgM-"')
    assert fi.imap_name == "DMS&VvpO9lPRXgM-"
    assert fi.display_name == "DMS固件发布"
    assert fi.is_system is False


def test_parse_special_use_system_flags():
    """\\Sent / \\Drafts / \\Junk / \\Trash → is_system; \\Archive 不算系统。"""
    sent = parse_list_line(rb'(\HasNoChildren \Sent) "/" "Sent"')
    assert sent.special_use == "\\sent" and sent.is_system is True
    junk = parse_list_line(rb'(\HasNoChildren \Junk) "/" "Junk"')
    assert junk.is_system is True
    archive = parse_list_line(rb'(\HasNoChildren) "/" "Archive"')
    assert archive.special_use is None and archive.is_system is False


def test_parse_has_children_flag():
    fi = parse_list_line(rb'(\HasChildren) "/" "&W,mL3VOGU,KLsF9V-"')
    assert fi.display_name == "对话历史记录"
    assert fi.has_children is True


def test_parse_name_with_space():
    fi = parse_list_line(rb'(\HasNoChildren) "/" "Unsent Messages"')
    assert fi.imap_name == "Unsent Messages"


def test_parse_nested_parent_derived():
    fi = parse_list_line(rb'(\HasNoChildren) "/" "&WRplh072WTljopSI-ZZ/&W1Blh072WTk-"')
    assert fi.display_name == "多文件夹探针ZZ/子文件夹"
    assert fi.parent == "&WRplh072WTljopSI-ZZ"
    assert fi.delimiter == "/"


def test_parse_unparseable_returns_none():
    assert parse_list_line(b"garbage no parens") is None
    assert parse_list_line(b"") is None


def test_parse_list_response_skips_bad_lines():
    lines = MOCK_LIST + [b"* OK garbage", None]
    out = parse_list_response(lines)
    assert len(out) == len(MOCK_LIST)
    assert all(isinstance(f, FolderInfo) for f in out)


def test_system_folder_count():
    folders = parse_list_response(MOCK_LIST)
    systems = [f.display_name for f in folders if f.is_system]
    # INBOX + Sent + Drafts + Junk + Trash = 5 系统; Archive/Jira/中文/嵌套 = 非系统
    assert set(systems) == {"INBOX", "Sent", "Drafts", "Junk", "Trash"}


def test_build_folder_tree_nesting():
    """父 imap_name 在列表里 → 子挂到 children; 孤儿 (父不在) 当顶层。"""
    folders = [
        parse_list_line(rb'(\HasChildren) "/" "Parent"'),
        parse_list_line(rb'(\HasNoChildren) "/" "Parent/Child"'),
        parse_list_line(rb'(\HasNoChildren) "/" "Orphan/Sub"'),  # 父 Orphan 不在列表
    ]
    tree = build_folder_tree(folders)
    by_name = {n["imap_name"]: n for n in tree}
    # Parent 是顶层且含 1 子; Orphan/Sub 父不在列表 → 降级当顶层
    assert "Parent" in by_name
    assert len(by_name["Parent"]["children"]) == 1
    assert by_name["Parent"]["children"][0]["imap_name"] == "Parent/Child"
    assert "Orphan/Sub" in by_name  # 孤儿当顶层, 不丢


def test_build_tree_flat_all_roots():
    """无嵌套时全是顶层根节点。"""
    folders = parse_list_response(
        [rb'(\HasNoChildren) "/" "A"', rb'(\HasNoChildren) "/" "B"']
    )
    tree = build_folder_tree(folders)
    assert len(tree) == 2
    assert all(n["children"] == [] for n in tree)
