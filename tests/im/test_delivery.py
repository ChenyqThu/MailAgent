"""分块投递 + 重试 + 空回复兜底（src/im/delivery.py）。"""

from __future__ import annotations

import pytest

from src.im.delivery import (
    EMPTY_TEXT_PLACEHOLDER,
    FeishuDelivery,
    split_for_delivery,
)
from tests.im.conftest import FakeSender


class TestSplit:
    def test_short_text_single_chunk(self):
        assert split_for_delivery("hello") == ["hello"]

    def test_empty_and_blank_yield_no_chunks(self):
        assert split_for_delivery("") == []
        assert split_for_delivery("   \n\n  ") == []

    def test_hard_split_when_no_newline(self):
        chunks = split_for_delivery("x" * 25, limit=10)
        assert chunks == ["x" * 10, "x" * 10, "x" * 5]
        assert all(len(c) <= 10 for c in chunks)

    def test_prefers_newline_boundary_in_second_half(self):
        # 换行落在窗口后半段 → 在换行处切，块尾换行被去掉
        text = "aaaaaa\nbbbbbbbbbbbb"
        chunks = split_for_delivery(text, limit=10)
        assert chunks[0] == "aaaaaa"
        assert chunks[1].startswith("bbbb")

    def test_ignores_newline_in_first_half(self):
        """换行太靠前不采用 —— 否则一条长回复会被炸成几十条消息。"""
        text = "ab\n" + "c" * 40
        chunks = split_for_delivery(text, limit=10)
        # 若采用了 index=2 的换行，第一块只有 2 字符；这里必须是硬切满 10
        assert len(chunks[0]) == 10

    def test_truncates_beyond_max_chunks_and_says_so(self):
        chunks = split_for_delivery("y" * 100, limit=10, max_chunks=3)
        assert len(chunks) == 3
        assert "已截断" in chunks[-1]

    def test_rejects_non_positive_limit(self):
        with pytest.raises(ValueError):
            split_for_delivery("x", limit=0)


class TestDelivery:
    def test_sends_each_chunk_in_order(self):
        sender = FakeSender()
        d = FeishuDelivery(sender, chunk_chars=10)
        ids = d.send_text("ou_x", "z" * 25)
        assert len(ids) == 3
        assert [len(t) for t in sender.sent_texts] == [10, 10, 5]
        assert all(c["receive_id"] == "ou_x" for c in sender.calls)
        assert all(c["msg_type"] == "text" for c in sender.calls)

    def test_retries_once_then_succeeds(self):
        sender = FakeSender(fail_first_n=1)
        slept: list = []
        d = FeishuDelivery(sender, sleep=slept.append)
        ids = d.send_text("ou_x", "hi")
        assert len(ids) == 1
        assert len(sender.calls) == 2  # 首发失败 + 重试成功
        assert slept == [pytest.approx(1.0)]

    def test_aborts_remaining_chunks_after_double_failure(self):
        """两次都失败 → 停止后续分块（半截乱序消息比缺失更难判读）。"""
        sender = FakeSender(always_fail=True)
        d = FeishuDelivery(sender, chunk_chars=10, sleep=lambda _s: None)
        ids = d.send_text("ou_x", "z" * 25)
        assert ids == []
        assert len(sender.calls) == 2  # 只在第一块上试了两次，没去发第二三块

    def test_empty_text_falls_back_to_placeholder(self):
        sender = FakeSender()
        d = FeishuDelivery(sender)
        ids = d.send_text("ou_x", "")
        assert len(ids) == 1
        assert sender.sent_texts == [EMPTY_TEXT_PLACEHOLDER]

    def test_missing_open_id_is_refused(self):
        sender = FakeSender()
        assert FeishuDelivery(sender).send_text("", "hi") == []
        assert sender.calls == []

    def test_sender_exception_is_contained(self):
        class Boom:
            def create_message(self, *a, **k):
                raise RuntimeError("boom")

        d = FeishuDelivery(Boom(), sleep=lambda _s: None)
        assert d.send_text("ou_x", "hi") == []  # 不外抛
