"""事件路由：私聊过滤 / 去重 / 绑定流 / echo 接缝（src/im/handler.py）。"""

from __future__ import annotations

from src.im.delivery import FeishuDelivery
from src.im.handler import (
    BIND_OK_REPLY,
    ECHO_PREFIX,
    INTERNAL_ERROR_REPLY,
    ImEventRouter,
    ImMessageContext,
    STRANGER_REPLY,
    UNBOUND_REPLY,
    UNSUPPORTED_REPLY,
    handle_owner_message,
)
from src.im.pairing import issue_pair_code
from src.im.state import ImFeishuState, STATE_BOUND_OPEN_ID
from tests.im.conftest import FakeMessageEvent, FakeSender, FakeStateStore, InlineSubmit


def _router(store: FakeStateStore, sender: FakeSender, **kw):
    state = ImFeishuState(store)
    delivery = FeishuDelivery(sender, sleep=lambda _s: None)
    return ImEventRouter(
        state=state, delivery=delivery, submit=InlineSubmit(), **kw
    ), state


class TestRouting:
    def test_group_chat_is_silently_ignored(self):
        store, sender = FakeStateStore({STATE_BOUND_OPEN_ID: "ou_owner"}), FakeSender()
        router, _ = _router(store, sender)
        router.on_message(FakeMessageEvent(chat_type="group", text="hi"))
        assert sender.calls == []  # 不回应、不入会话

    def test_duplicate_event_id_is_processed_once(self):
        """飞书超时重推带同一个 event_id —— 绝不能跑两遍。"""
        store, sender = FakeStateStore({STATE_BOUND_OPEN_ID: "ou_owner"}), FakeSender()
        router, _ = _router(store, sender)
        evt = FakeMessageEvent(event_id="evt_dup", text="hi")
        router.on_message(evt)
        router.on_message(FakeMessageEvent(event_id="evt_dup", text="hi"))
        assert len(sender.calls) == 1
        assert router.event_count == 1

    def test_unparsable_event_does_not_raise(self):
        store, sender = FakeStateStore(), FakeSender()
        router, _ = _router(store, sender)
        router.on_message(object())  # 结构完全不对
        assert sender.calls == []

    def test_last_event_wall_is_memory_only(self):
        """handler 里绝不写 sqlite（3 秒 ACK 预算）—— 只更新内存。"""
        store, sender = FakeStateStore({STATE_BOUND_OPEN_ID: "ou_owner"}), FakeSender()
        router, _ = _router(store, sender)
        before = dict(store.data)
        router.on_message(FakeMessageEvent(text="hi"))
        assert router.last_event_wall is not None
        assert "im.feishu.last_event_at" not in store.data
        assert set(store.data) == set(before)  # 路由没往 sync_state 写任何东西


class TestBinding:
    def test_unbound_gets_fixed_refusal_and_no_processing(self):
        store, sender = FakeStateStore(), FakeSender()
        called = []
        router, _ = _router(store, sender, owner_handler=lambda t, c: called.append(t))
        router.on_message(FakeMessageEvent(text="帮我看下今天的邮件"))
        assert sender.sent_texts == [UNBOUND_REPLY]
        assert called == []  # 内容一个字都没进指令通道

    def test_valid_pair_code_binds_sender(self):
        store, sender = FakeStateStore(), FakeSender()
        router, state = _router(store, sender)
        code, _ = issue_pair_code(state)
        router.on_message(FakeMessageEvent(open_id="ou_me", text=code))
        assert state.get_bound_open_id() == "ou_me"
        assert sender.sent_texts == [BIND_OK_REPLY]

    def test_expired_code_does_not_bind(self):
        import time as _t

        store, sender = FakeStateStore(), FakeSender()
        router, state = _router(store, sender)
        code, _ = issue_pair_code(state, now=_t.time() - 10_000)
        router.on_message(FakeMessageEvent(open_id="ou_me", text=code))
        assert state.get_bound_open_id() == ""
        assert sender.sent_texts == [UNBOUND_REPLY]

    def test_wrong_code_does_not_bind(self):
        store, sender = FakeStateStore(), FakeSender()
        router, state = _router(store, sender)
        code, _ = issue_pair_code(state)
        wrong = "000000" if code != "000000" else "999999"
        router.on_message(FakeMessageEvent(open_id="ou_me", text=wrong))
        assert state.get_bound_open_id() == ""
        assert sender.sent_texts == [UNBOUND_REPLY]

    def test_stranger_rejected_after_binding_even_with_valid_code(self):
        """🔴 已绑定后码不再有意义 —— 否则拿到码的人能顶掉 owner。"""
        store, sender = FakeStateStore({STATE_BOUND_OPEN_ID: "ou_owner"}), FakeSender()
        router, state = _router(store, sender)
        code, _ = issue_pair_code(state)
        router.on_message(FakeMessageEvent(open_id="ou_stranger", text=code))
        assert state.get_bound_open_id() == "ou_owner"
        assert sender.sent_texts == [STRANGER_REPLY]

    def test_stranger_text_is_rejected(self):
        store, sender = FakeStateStore({STATE_BOUND_OPEN_ID: "ou_owner"}), FakeSender()
        called = []
        router, _ = _router(store, sender, owner_handler=lambda t, c: called.append(t))
        router.on_message(FakeMessageEvent(open_id="ou_other", text="删掉所有邮件"))
        assert sender.sent_texts == [STRANGER_REPLY]
        assert called == []


class TestOwnerSeam:
    def test_echo_placeholder_is_delivered(self):
        store, sender = FakeStateStore({STATE_BOUND_OPEN_ID: "ou_owner"}), FakeSender()
        router, _ = _router(store, sender)
        router.on_message(FakeMessageEvent(open_id="ou_owner", text="你好"))
        assert sender.sent_texts == [ECHO_PREFIX + "你好"]

    def test_ctx_contract_for_pr3(self):
        """🔴 PR-3 契约：ctx 字段只增不改，且 delivery 直接可用。"""
        store, sender = FakeStateStore({STATE_BOUND_OPEN_ID: "ou_owner"}), FakeSender()
        seen: list = []
        router, _ = _router(store, sender, owner_handler=lambda t, c: seen.append((t, c)))
        router.on_message(
            FakeMessageEvent(
                open_id="ou_owner",
                chat_id="oc_42",
                message_id="om_42",
                event_id="evt_42",
                text="做点事",
            )
        )
        text, ctx = seen[0]
        assert text == "做点事"
        assert isinstance(ctx, ImMessageContext)
        assert (ctx.open_id, ctx.chat_id, ctx.message_id, ctx.event_id) == (
            "ou_owner",
            "oc_42",
            "om_42",
            "evt_42",
        )
        assert isinstance(ctx.received_at, float) and ctx.received_wall
        ctx.delivery.send_text(ctx.open_id, "from-pr3")
        assert sender.sent_texts == ["from-pr3"]

    def test_default_owner_handler_is_the_echo_seam(self):
        sender = FakeSender()
        ctx = ImMessageContext(
            open_id="ou_owner",
            chat_id="oc_1",
            message_id="om_1",
            event_id="evt_1",
            received_at=0.0,
            received_wall="now",
            delivery=FeishuDelivery(sender, sleep=lambda _s: None),
        )
        handle_owner_message("ping", ctx)
        assert sender.sent_texts == [ECHO_PREFIX + "ping"]

    def test_non_text_message_from_owner_is_answered_honestly(self):
        store, sender = FakeStateStore({STATE_BOUND_OPEN_ID: "ou_owner"}), FakeSender()
        router, _ = _router(store, sender)
        router.on_message(
            FakeMessageEvent(open_id="ou_owner", message_type="image", text="")
        )
        assert sender.sent_texts == [UNSUPPORTED_REPLY]

    def test_owner_handler_exception_gets_an_honest_reply(self):
        store, sender = FakeStateStore({STATE_BOUND_OPEN_ID: "ou_owner"}), FakeSender()

        def boom(_t, _c):
            raise RuntimeError("gateway down")

        router, _ = _router(store, sender, owner_handler=boom)
        router.on_message(FakeMessageEvent(open_id="ou_owner", text="hi"))
        assert sender.sent_texts == [INTERNAL_ERROR_REPLY]
