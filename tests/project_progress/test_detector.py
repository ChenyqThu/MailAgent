"""detector.py 单元测试.

规则:
- sender_pattern 空 + subject_pattern 配置 → 仅看 subject (推荐, 实际发件人会变).
- 两者都配 → 双判定 (向后兼容).
- 两者全空 → 永不匹配 (force user .env config).
"""

from src.project_progress.detector import ProjectProgressDetector


# 测试用 fake email + 自定义 subject pattern, 不依赖 default
WEEKLY_SENDER = "weekly-sender@example.com"
WEEKLY_PATTERN = r"\[weekly\] project deadline"


def _new(sender=WEEKLY_SENDER, subject_pattern=WEEKLY_PATTERN):
    return ProjectProgressDetector(sender=sender, subject_pattern=subject_pattern)


def test_match_both():
    d = _new()
    assert d.is_match(
        sender="Weekly Sender <weekly-sender@example.com>",
        subject="[weekly] project deadline 0420 update",
    )


def test_default_empty_never_matches():
    """default sender + pattern 都为 "" → 任何邮件都不会匹配 (force user .env config)."""
    d = ProjectProgressDetector()
    assert not d.is_match(sender="anyone@example.com", subject="anything")


def test_wrong_sender():
    d = _new()
    assert not d.is_match(
        sender="someone-else@example.com",
        subject="[weekly] project deadline 0420 update",
    )


def test_wrong_subject():
    d = _new()
    assert not d.is_match(
        sender="weekly-sender@example.com",
        subject="some other subject",
    )


def test_custom_pattern_arbitrary_team():
    """其他 BU 复用模块: 自定义 sender + subject."""
    d = _new(sender="foo@bar.com", subject_pattern=r"^WEEKLY:")
    assert d.is_match(sender="foo@bar.com", subject="WEEKLY: report")
    assert not d.is_match(sender="foo@bar.com", subject="weekly: lowercased")


def test_case_insensitive_sender():
    d = _new()
    assert d.is_match(
        sender="WEEKLY-SENDER@EXAMPLE.COM",
        subject="[weekly] project deadline update",
    )


def test_none_inputs():
    d = _new()
    assert not d.is_match(sender=None, subject=None)
    assert not d.is_match(sender="weekly-sender@example.com", subject=None)


def test_subject_only_match_when_sender_empty():
    """sender 留空, 仅 subject 配置 → 任意发件人都可匹配."""
    d = _new(sender="", subject_pattern=WEEKLY_PATTERN)
    assert d.is_match(sender="anyone@example.com", subject="[weekly] project deadline 0420")
    assert d.is_match(sender="liuxiangjiang@tp-link.com.hk", subject="[weekly] project deadline 0420")
    # subject 不匹配仍然 false
    assert not d.is_match(sender="anyone@example.com", subject="some unrelated subject")


def test_subject_only_requires_subject():
    """sender 留空时, subject 是 None 仍然不匹配."""
    d = _new(sender="", subject_pattern=WEEKLY_PATTERN)
    assert not d.is_match(sender="anyone@example.com", subject=None)


def test_matches_struct_carries_sender_required_flag():
    d_strict = _new()  # sender + subject 都配
    m = d_strict.matches(sender="weekly-sender@example.com", subject="[weekly] project deadline")
    assert m.sender_required is True
    assert m.both is True

    d_lax = _new(sender="")  # 仅 subject
    m2 = d_lax.matches(sender="whoever@example.com", subject="[weekly] project deadline")
    assert m2.sender_required is False
    assert m2.sender_matched is False  # sender 未配置, s_ok 为 False
    assert m2.subject_matched is True
    assert m2.both is True  # 只看 subject
