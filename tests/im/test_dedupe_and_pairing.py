"""event_id 去重 + 一次性绑定码（src/im/dedupe.py, src/im/pairing.py）。"""

from __future__ import annotations

import pytest

from src.im.dedupe import EventDeduper
from src.im.pairing import (
    PAIR_CODE_DIGITS,
    PAIR_CODE_TTL_SEC,
    clear_pair_code,
    generate_pair_code,
    issue_pair_code,
    looks_like_pair_code,
    peek_pair_code_expiry,
    verify_pair_code,
)
from src.im.state import ImFeishuState, STATE_PAIR_CODE, STATE_PAIR_CODE_EXPIRES_AT
from tests.im.conftest import FakeStateStore


class TestDeduper:
    def test_first_seen_is_false_then_true(self):
        d = EventDeduper()
        assert d.seen("evt_1") is False
        assert d.seen("evt_1") is True

    def test_empty_event_id_never_dedupes(self):
        """拿不到 event_id 时宁可重复也不误吞真事件。"""
        d = EventDeduper()
        assert d.seen("") is False
        assert d.seen(None) is False
        assert d.seen("") is False

    def test_lru_evicts_oldest(self):
        d = EventDeduper(capacity=2)
        d.seen("a")
        d.seen("b")
        d.seen("c")  # 挤掉 a
        assert len(d) == 2
        assert d.seen("a") is False  # a 已被淘汰
        assert d.seen("c") is True

    def test_capacity_must_be_positive(self):
        with pytest.raises(ValueError):
            EventDeduper(capacity=0)


class TestPairing:
    def test_generated_code_shape(self):
        for _ in range(20):
            code = generate_pair_code()
            assert len(code) == PAIR_CODE_DIGITS and code.isdigit()

    def test_issue_then_verify_consumes_code(self):
        state = ImFeishuState(FakeStateStore())
        code, expires_at = issue_pair_code(state, now=1000.0)
        assert expires_at == 1000 + PAIR_CODE_TTL_SEC
        assert verify_pair_code(state, code, now=1100.0) is True
        # 一次性：同一个码不能再用
        assert verify_pair_code(state, code, now=1101.0) is False

    def test_expired_code_is_rejected_and_cleaned(self):
        store = FakeStateStore()
        state = ImFeishuState(store)
        code, _ = issue_pair_code(state, now=1000.0)
        assert verify_pair_code(state, code, now=1000.0 + PAIR_CODE_TTL_SEC + 1) is False
        # 自愈：过期码被清掉，不留僵尸
        assert store.data[STATE_PAIR_CODE] == ""
        assert store.data[STATE_PAIR_CODE_EXPIRES_AT] == ""

    def test_wrong_code_is_rejected_but_kept(self):
        state = ImFeishuState(FakeStateStore())
        code, _ = issue_pair_code(state, now=1000.0)
        wrong = "000000" if code != "000000" else "111111"
        assert verify_pair_code(state, wrong, now=1001.0) is False
        # 错码不消费有效码（打错一位不该逼你重新出码）
        assert verify_pair_code(state, code, now=1002.0) is True

    def test_no_code_issued_means_reject(self):
        state = ImFeishuState(FakeStateStore())
        assert verify_pair_code(state, "123456") is False

    def test_corrupt_expiry_is_treated_as_expired(self):
        store = FakeStateStore(
            {STATE_PAIR_CODE: "123456", STATE_PAIR_CODE_EXPIRES_AT: "not-a-number"}
        )
        assert verify_pair_code(ImFeishuState(store), "123456") is False

    def test_issue_overwrites_previous_code(self):
        state = ImFeishuState(FakeStateStore())
        first, _ = issue_pair_code(state, now=1000.0)
        second, _ = issue_pair_code(state, now=1001.0)
        assert verify_pair_code(state, first, now=1002.0) is False
        assert verify_pair_code(state, second, now=1002.0) is True

    def test_peek_never_returns_the_code_itself(self):
        state = ImFeishuState(FakeStateStore())
        _, expires_at = issue_pair_code(state, now=1000.0)
        assert peek_pair_code_expiry(state, now=1010.0) == expires_at
        assert peek_pair_code_expiry(state, now=1000.0 + PAIR_CODE_TTL_SEC + 1) is None
        clear_pair_code(state)
        assert peek_pair_code_expiry(state, now=1010.0) is None

    @pytest.mark.parametrize(
        "text,expected",
        [
            ("123456", True),
            ("  123456  ", True),
            ("12345", False),
            ("1234567", False),
            ("12345a", False),
            ("我的工号是 123456", False),  # 不在长句里捞数字
            ("", False),
        ],
    )
    def test_looks_like_pair_code(self, text, expected):
        assert looks_like_pair_code(text) is expected
