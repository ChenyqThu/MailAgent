"""detector.py 单元测试 (默认 sender = "" 后必须显式配置)."""

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
