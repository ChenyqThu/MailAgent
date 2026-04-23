"""detector.py 单元测试"""

from src.evelyn_project.detector import EvelynProjectDetector


def test_match_both():
    d = EvelynProjectDetector()
    assert d.is_match(
        sender="Evelyn Wei <evelyn.wei@tp-link.com>",
        subject="转发: 【项目进度】项目deadline汇报0420_市场产品",
    )


def test_wrong_sender():
    d = EvelynProjectDetector()
    assert not d.is_match(
        sender="zhouwangfang@tp-link.com.hk",
        subject="转发: 【项目进度】项目deadline汇报0420_市场产品",
    )


def test_wrong_subject():
    d = EvelynProjectDetector()
    assert not d.is_match(
        sender="Evelyn Wei <evelyn.wei@tp-link.com>",
        subject="转发: 【认证情况汇总2026.04.21】",
    )


def test_custom_pattern():
    d = EvelynProjectDetector(
        sender="foo@bar.com", subject_pattern=r"^WEEKLY:"
    )
    assert d.is_match(sender="foo@bar.com", subject="WEEKLY: report")
    assert not d.is_match(sender="foo@bar.com", subject="weekly: lowercased")


def test_case_insensitive_sender():
    d = EvelynProjectDetector()
    assert d.is_match(
        sender="EVELYN.WEI@TP-LINK.COM",
        subject="转发: 【项目进度】项目deadline汇报0420_市场产品",
    )


def test_none_inputs():
    d = EvelynProjectDetector()
    assert not d.is_match(sender=None, subject=None)
    assert not d.is_match(sender="evelyn.wei@tp-link.com", subject=None)
