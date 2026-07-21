"""mailbox_semantics 单源模块 (issue #42 C 案) — 判定/集合/SQL 辅助/re-export 兼容。"""

import pytest

from src.mail.mailbox_semantics import (
    ARCHIVE_LABEL,
    DRAFT_LABEL_VARIANTS,
    DRAFT_MAILBOX_LABELS,
    DRAFTS_LABEL,
    INBOX_LABEL,
    INBOX_LABEL_VARIANTS,
    INBOX_MAILBOX_LABELS,
    SENT_CANONICAL_LABEL,
    SENT_LABEL,
    SENT_LABEL_VARIANTS,
    SENT_MAILBOX_LABELS,
    STANDARD_MAILBOXES,
    filter_labels_for_mailbox,
    is_archive_mailbox,
    is_custom_folder_mailbox,
    is_drafts_mailbox,
    is_inbox_mailbox,
    is_sent_mailbox,
    sql_in_predicate,
    sql_not_in_or_null,
)


# ==================== canonical 常量 ====================

def test_canonical_labels():
    assert INBOX_LABEL == "收件箱"
    assert SENT_LABEL == "发件箱"
    assert DRAFTS_LABEL == "草稿箱"
    assert ARCHIVE_LABEL == "存档"
    assert SENT_CANONICAL_LABEL == SENT_LABEL


# ==================== 集合成员 (锁死变体全集, 改集合必显式过此测试) ====================

def test_sent_labels_members():
    assert SENT_MAILBOX_LABELS == frozenset(
        {"发件箱", "已发送", "已发送邮件", "Sent", "Sent Messages", "Sent Items"}
    )
    # 有序 tuple 与 frozenset 同集, canonical 在首位 (SQL 字面量序稳定)
    assert frozenset(SENT_LABEL_VARIANTS) == SENT_MAILBOX_LABELS
    assert SENT_LABEL_VARIANTS[0] == SENT_LABEL


def test_draft_labels_members():
    assert DRAFT_MAILBOX_LABELS == frozenset({"草稿箱", "草稿", "Drafts"})
    assert frozenset(DRAFT_LABEL_VARIANTS) == DRAFT_MAILBOX_LABELS
    assert DRAFT_LABEL_VARIANTS[0] == DRAFTS_LABEL


def test_inbox_labels_members():
    assert INBOX_MAILBOX_LABELS == frozenset({"收件箱", "INBOX"})


def test_standard_mailboxes_union_and_archive_exclusion():
    assert STANDARD_MAILBOXES == (
        INBOX_MAILBOX_LABELS | SENT_MAILBOX_LABELS | DRAFT_MAILBOX_LABELS
    )
    # 🔴 「存档」有意不进标准集 (PRD §7 D7: 存档按自定义文件夹享 L3 静默)
    assert ARCHIVE_LABEL not in STANDARD_MAILBOXES


# ==================== 判定函数 ====================

@pytest.mark.parametrize("mb", ["发件箱", "已发送", "已发送邮件", "Sent", "Sent Messages", "Sent Items"])
def test_is_sent_mailbox_true(mb):
    assert is_sent_mailbox(mb) is True


@pytest.mark.parametrize("mb", ["收件箱", "草稿箱", "存档", "Jira", "", None])
def test_is_sent_mailbox_false(mb):
    assert is_sent_mailbox(mb) is False


@pytest.mark.parametrize("mb", ["草稿箱", "草稿", "Drafts"])
def test_is_drafts_mailbox_true(mb):
    assert is_drafts_mailbox(mb) is True


@pytest.mark.parametrize("mb", ["发件箱", "收件箱", "", None])
def test_is_drafts_mailbox_false(mb):
    assert is_drafts_mailbox(mb) is False


@pytest.mark.parametrize("mb,expected", [
    ("收件箱", True), ("INBOX", True), ("发件箱", False), ("", False), (None, False),
])
def test_is_inbox_mailbox(mb, expected):
    assert is_inbox_mailbox(mb) is expected


@pytest.mark.parametrize("mb,expected", [
    ("存档", True), ("收件箱", False), ("Archive", False), ("", False), (None, False),
])
def test_is_archive_mailbox(mb, expected):
    assert is_archive_mailbox(mb) is expected


@pytest.mark.parametrize("mb,expected", [
    ("Jira", True), ("DMS固件发布", True), ("存档", True),  # 存档按自定义处理
    ("收件箱", False), ("发件箱", False), ("已发送邮件", False),
    ("草稿", False), ("草稿箱", False), ("", False), (None, False),
])
def test_is_custom_folder_mailbox(mb, expected):
    assert is_custom_folder_mailbox(mb) is expected


# ==================== 列表过滤展开 (issue #42 后续) ====================

def test_filter_labels_expands_builtin_canonical():
    # 内建三视图的 canonical → 变体全集 (序 = *_LABEL_VARIANTS 声明序)
    assert filter_labels_for_mailbox(INBOX_LABEL) == INBOX_LABEL_VARIANTS
    assert filter_labels_for_mailbox(SENT_LABEL) == SENT_LABEL_VARIANTS
    assert filter_labels_for_mailbox(DRAFTS_LABEL) == DRAFT_LABEL_VARIANTS


def test_filter_labels_expands_from_any_variant():
    # 传变体本身也展开到同一全集 (远程 web 传 'Sent' 与桌面传 '发件箱' 同解)
    assert filter_labels_for_mailbox("Sent Items") == SENT_LABEL_VARIANTS
    assert filter_labels_for_mailbox("INBOX") == INBOX_LABEL_VARIANTS
    assert filter_labels_for_mailbox("草稿") == DRAFT_LABEL_VARIANTS


def test_filter_labels_keeps_custom_folder_exact():
    # 自定义同步文件夹 / 存档 → 单元素 = 精确匹配语义不变
    assert filter_labels_for_mailbox("DMS固件发布") == ("DMS固件发布",)
    assert filter_labels_for_mailbox(ARCHIVE_LABEL) == (ARCHIVE_LABEL,)
    assert filter_labels_for_mailbox("") == ("",)


def test_filter_labels_feeds_sql_in_predicate():
    # 与列表查询的实际用法闭环: 展开 → 参数化 IN
    pred, params = sql_in_predicate("m.mailbox", filter_labels_for_mailbox(INBOX_LABEL))
    assert pred == "m.mailbox IN (?, ?)"
    assert params == ("收件箱", "INBOX")
    # 自定义文件夹退化为单值 IN —— 与旧 `= ?` 等价
    pred, params = sql_in_predicate("m.mailbox", filter_labels_for_mailbox("ProjectX"))
    assert pred == "m.mailbox IN (?)"
    assert params == ("ProjectX",)


# ==================== SQL 辅助 ====================

def test_sql_in_predicate_shape():
    pred, params = sql_in_predicate("mailbox", SENT_LABEL_VARIANTS)
    assert pred == "mailbox IN (?, ?, ?, ?, ?, ?)"
    assert params == SENT_LABEL_VARIANTS
    # 参数化形态: 谓词里不出现 label 字面量
    assert "发件箱" not in pred


def test_sql_not_in_or_null_literal():
    # 与 email_views / 前端 DRAFTS_EXCLUDE_SQL 既有字面量逐字节一致
    assert sql_not_in_or_null("mailbox", DRAFT_LABEL_VARIANTS) == (
        "(mailbox IS NULL OR mailbox NOT IN ('草稿箱', '草稿', 'Drafts'))"
    )
    assert sql_not_in_or_null("m.mailbox", DRAFT_LABEL_VARIANTS) == (
        "(m.mailbox IS NULL OR m.mailbox NOT IN ('草稿箱', '草稿', 'Drafts'))"
    )


# ==================== re-export 兼容 (历史 import 点不断) ====================

def test_sync_store_reexports_are_same_objects():
    from src.mail import sync_store

    from src.mail import mailbox_semantics as ms

    assert sync_store.DRAFT_MAILBOX_LABELS is ms.DRAFT_MAILBOX_LABELS
    assert sync_store.SENT_MAILBOX_LABELS is ms.SENT_MAILBOX_LABELS
    assert sync_store.SENT_CANONICAL_LABEL == ms.SENT_CANONICAL_LABEL


def test_new_watcher_reexports_custom_folder_helper():
    from src.mail import new_watcher

    from src.mail import mailbox_semantics as ms

    assert new_watcher.is_custom_folder_mailbox is ms.is_custom_folder_mailbox
