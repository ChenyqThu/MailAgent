"""AgentEmailMatcher 单测（S4 W1, ADR D5）—— 正则匹配 + folder 白名单 + 输入截断。"""
from __future__ import annotations

from src.agents.matcher import AgentEmailMatcher
from src.agents.trigger import MATCH_INPUT_CAP, EmailFilterTrigger


def _matcher(**kw) -> AgentEmailMatcher:
    return AgentEmailMatcher(EmailFilterTrigger(**kw))


def test_subject_match_hit():
    m = _matcher(subject_pattern="DMS.*审批")
    assert m.is_match(sender="a@b.com", subject="DMS 项目审批请处理", mailbox="收件箱")


def test_subject_match_miss():
    m = _matcher(subject_pattern="DMS.*审批")
    assert not m.is_match(sender="a@b.com", subject="普通邮件", mailbox="收件箱")


def test_sender_match_case_insensitive():
    # sender 用 IGNORECASE（邮箱大小写不敏感）。
    m = _matcher(sender_pattern=r"dms@corp\.com")
    assert m.is_match(sender="DMS@CORP.com", subject="x", mailbox="收件箱")


def test_both_patterns_are_and():
    m = _matcher(subject_pattern="审批", sender_pattern=r"dms@corp\.com")
    assert m.is_match(sender="dms@corp.com", subject="审批", mailbox="收件箱")
    assert not m.is_match(sender="other@corp.com", subject="审批", mailbox="收件箱")
    assert not m.is_match(sender="dms@corp.com", subject="无关", mailbox="收件箱")


def test_folder_default_is_inbox():
    # folders 缺省 = 收件箱：只匹配收件箱。
    m = _matcher(subject_pattern="审批")
    assert m.is_match(sender="a@b.com", subject="审批", mailbox="收件箱")
    assert not m.is_match(sender="a@b.com", subject="审批", mailbox="已发送")


def test_folder_whitelist_explicit():
    m = _matcher(subject_pattern="审批", folders=("审批箱", "收件箱"))
    assert m.is_match(sender="a@b.com", subject="审批", mailbox="审批箱")
    assert m.is_match(sender="a@b.com", subject="审批", mailbox="收件箱")
    assert not m.is_match(sender="a@b.com", subject="审批", mailbox="垃圾箱")


def test_folders_only_matches_all_in_folder():
    # 无正则、仅 folders → 匹配该文件夹所有邮件。
    m = _matcher(folders=("收件箱",))
    assert m.is_match(sender="anyone@x.com", subject="任意", mailbox="收件箱")
    assert not m.is_match(sender="anyone@x.com", subject="任意", mailbox="其它")


def test_none_inputs_safe():
    m = _matcher(subject_pattern="x")
    assert not m.is_match(sender=None, subject=None, mailbox=None)
    # mailbox None → strip → '' 不在白名单 → False（安全）。


def test_input_truncation_bounds_regex():
    # 匹配前截断 MATCH_INPUT_CAP：目标串在截断窗之外则匹配不到（证明确实截断了）。
    needle_beyond = "x" * MATCH_INPUT_CAP + "NEEDLE"
    m = _matcher(subject_pattern="NEEDLE")
    assert not m.is_match(sender="a@b.com", subject=needle_beyond, mailbox="收件箱")
    # 在窗内则匹配得到。
    needle_within = "NEEDLE" + "x" * 10
    assert m.is_match(sender="a@b.com", subject=needle_within, mailbox="收件箱")
