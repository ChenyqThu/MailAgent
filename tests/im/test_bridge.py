"""消息→agent run→回投 + 飞书内审批闭环（src/im/bridge.py）。

全离线：gateway / chat_db / sender 全替身，零网络、零 lark、零 sqlite。
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from src.im import bridge as bridge_mod
from src.im.bridge import (
    APPROVAL_DETAILS_MISSING_REPLY,
    CARD_SEND_FAILED_REPLY,
    DECIDE_BUSY_REPLY,
    DECIDE_DOWN_REPLY,
    DECIDE_INVALID_DETAIL,
    FLAG_OFF_REPLY,
    GATEWAY_DOWN_REPLY,
    ImAgentBridge,
    NEW_SESSION_REPLY,
    NO_LLM_KEY_REPLY,
    REPAUSED_NEXT_MISSING_REPLY,
    RUN_ACTIVE_REPLY,
    RUN_TIMEOUT_REPLY,
    STALE_PENDING_NOTICE,
    STOP_DONE_REPLY,
    STOP_IDLE_REPLY,
    STOP_NO_SESSION_REPLY,
    TOAST_BUSY,
    TOAST_DUPLICATE,
    TOAST_RECEIVED_APPROVE,
    TOAST_RECEIVED_REJECT,
    TOAST_UNKNOWN,
)
from src.im.cards import CARD_VALUE_KIND, build_action_value
from src.im.delivery import FeishuDelivery
from src.im.gateway_client import (
    DecideOutcome,
    ImChatOutcome,
    PendingApproval,
    StopOutcome,
)
from src.im.handler import ImMessageContext
from src.im.state import ImFeishuState, STATE_BOUND_OPEN_ID
from tests.im.conftest import (
    FakeCardActionEvent,
    FakeSender,
    FakeStateStore,
    InlineSubmit,
)


# ── 替身 ────────────────────────────────────────────────────────────────────
class FakeGateway:
    def __init__(self) -> None:
        self.chat_outcomes: List[ImChatOutcome] = []
        self.chat_calls: List[Dict[str, Any]] = []
        self.pending_results: List[Optional[PendingApproval]] = []
        self.pending_calls: List[int] = []
        self.decide_results: List[DecideOutcome] = []
        self.decide_calls: List[tuple] = []
        self.stop_results: List[StopOutcome] = []
        self.stop_calls: List[int] = []

    def stream_im_chat(self, messages, session_id):
        self.chat_calls.append({"messages": messages, "session_id": session_id})
        return self.chat_outcomes.pop(0)

    def approval_pending(self, session_id):
        self.pending_calls.append(session_id)
        if self.pending_results:
            return self.pending_results.pop(0)
        return None

    def decide(self, approval_id, decision):
        self.decide_calls.append((approval_id, decision))
        return self.decide_results.pop(0)

    def stop_run(self, session_id):
        self.stop_calls.append(session_id)
        return self.stop_results.pop(0)


class FakeChatDb:
    def __init__(self) -> None:
        self.messages: Dict[int, List[dict]] = {}
        self.latest_assistant: Dict[int, Optional[dict]] = {}

    def list_messages(self, session_id):
        return list(self.messages.get(session_id, []))

    def get_latest_assistant_message(self, session_id):
        return self.latest_assistant.get(session_id)


class RecordingSubmit:
    """只登记不执行 —— 验证「toast 路径不做任何慢事」用。"""

    def __init__(self) -> None:
        self.tasks: List[tuple] = []

    def __call__(self, fn, *args):
        self.tasks.append((fn, args))
        return True

    def run_all(self) -> None:
        while self.tasks:
            fn, args = self.tasks.pop(0)
            fn(*args)


class CountingStore(FakeStateStore):
    def __init__(self, initial=None) -> None:
        super().__init__(initial)
        self.reads = 0

    def get_state(self, key):
        self.reads += 1
        return super().get_state(key)


def make_bridge(*, store=None, submit=None):
    store = store if store is not None else FakeStateStore(
        {STATE_BOUND_OPEN_ID: "ou_owner"}
    )
    state = ImFeishuState(store)
    sender = FakeSender()
    delivery = FeishuDelivery(sender, sleep=lambda _s: None)
    gw = FakeGateway()
    db = FakeChatDb()
    bridge = ImAgentBridge(
        state=state,
        delivery=delivery,
        card_sender=sender,
        submit=submit if submit is not None else InlineSubmit(),
        gateway=gw,
        chat_db=db,
        sleep=lambda _s: None,
    )
    return bridge, state, sender, gw, db, delivery


def _ctx(delivery, *, chat_id="oc_1", event_id="evt_1") -> ImMessageContext:
    return ImMessageContext(
        open_id="ou_owner",
        chat_id=chat_id,
        message_id="om_1",
        event_id=event_id,
        received_at=0.0,
        received_wall="now",
        delivery=delivery,
    )


def _ok_outcome(**kw) -> ImChatOutcome:
    base = dict(ok=True, http_status=200, text="回复", session_id=77)
    base.update(kw)
    return ImChatOutcome(**base)


def _future_ms() -> float:
    return time.time() * 1000 + 60_000


# ── 多轮会话映射 ────────────────────────────────────────────────────────────
class TestSessionMapping:
    def test_first_turn_adopts_header_session(self):
        bridge, state, sender, gw, _db, delivery = make_bridge()
        gw.chat_outcomes = [_ok_outcome(session_id=77, text="你好")]
        bridge.handle_owner_message("hi", _ctx(delivery))
        assert state.get_active_session("oc_1") == 77
        # 第一轮：无活跃 session → 不带 sessionId、历史只有本条
        assert gw.chat_calls[0]["session_id"] is None
        assert len(gw.chat_calls[0]["messages"]) == 1
        assert sender.sent_texts == ["你好"]

    def test_second_turn_carries_session_and_history(self):
        bridge, state, sender, gw, db, delivery = make_bridge()
        state.set_active_session("oc_1", 77)
        db.messages[77] = [
            {"id": 1, "role": "user", "content": "第一轮", "ui_message_json": None},
            {"id": 2, "role": "assistant", "content": "第一轮回复", "ui_message_json": None},
        ]
        gw.chat_outcomes = [_ok_outcome(session_id=77, text="第二轮回复")]
        bridge.handle_owner_message("第二轮", _ctx(delivery, event_id="evt_2"))
        call = gw.chat_calls[0]
        assert call["session_id"] == 77
        roles = [m["role"] for m in call["messages"]]
        assert roles == ["user", "assistant", "user"]
        assert call["messages"][-1]["parts"][0]["text"] == "第二轮"

    def test_new_command_rotates_session(self):
        bridge, state, sender, gw, _db, delivery = make_bridge()
        state.set_active_session("oc_1", 77)
        bridge.handle_owner_message(" /new ", _ctx(delivery))
        assert state.get_active_session("oc_1") is None
        assert sender.sent_texts == [NEW_SESSION_REPLY]
        # 下一条消息 sessionId=null → gateway 新建
        gw.chat_outcomes = [_ok_outcome(session_id=88, text="新会话")]
        bridge.handle_owner_message("hello", _ctx(delivery, event_id="evt_3"))
        assert gw.chat_calls[0]["session_id"] is None
        assert state.get_active_session("oc_1") == 88

    def test_history_read_failure_degrades_to_fresh_turn(self):
        bridge, state, sender, gw, db, delivery = make_bridge()
        state.set_active_session("oc_1", 77)

        def boom(_sid):
            raise RuntimeError("db locked")

        db.list_messages = boom  # type: ignore[assignment]
        gw.chat_outcomes = [_ok_outcome(session_id=77)]
        bridge.handle_owner_message("hi", _ctx(delivery))
        assert len(gw.chat_calls[0]["messages"]) == 1  # 降级为无历史，不炸


# ── /stop ───────────────────────────────────────────────────────────────────
class TestStopCommand:
    def test_no_active_session(self):
        bridge, _state, sender, gw, _db, delivery = make_bridge()
        bridge.handle_owner_message("/stop", _ctx(delivery))
        assert sender.sent_texts == [STOP_NO_SESSION_REPLY]
        assert gw.stop_calls == []

    def test_stopped_and_idle(self):
        bridge, state, sender, gw, _db, delivery = make_bridge()
        state.set_active_session("oc_1", 5)
        gw.stop_results = [StopOutcome(ok=True, http_status=200, stopped=True)]
        bridge.handle_owner_message("/stop", _ctx(delivery))
        gw.stop_results = [StopOutcome(ok=True, http_status=200, stopped=False)]
        bridge.handle_owner_message("/stop", _ctx(delivery))
        assert sender.sent_texts == [STOP_DONE_REPLY, STOP_IDLE_REPLY]
        assert gw.stop_calls == [5, 5]

    def test_gateway_down(self):
        bridge, state, sender, gw, _db, delivery = make_bridge()
        state.set_active_session("oc_1", 5)
        gw.stop_results = [StopOutcome(transport_error="E_CONNECT")]
        bridge.handle_owner_message("/stop", _ctx(delivery))
        assert sender.sent_texts == [GATEWAY_DOWN_REPLY]


# ── 错误路径文案（绝不静默）─────────────────────────────────────────────────
class TestErrorPaths:
    def _run(self, outcome) -> List[str]:
        bridge, _state, sender, gw, _db, delivery = make_bridge()
        gw.chat_outcomes = [outcome]
        bridge.handle_owner_message("hi", _ctx(delivery))
        return sender.sent_texts

    def test_409_run_active(self):
        texts = self._run(ImChatOutcome(http_status=409, error_code="E_RUN_ACTIVE"))
        assert texts == [RUN_ACTIVE_REPLY]

    def test_404_flag_off(self):
        texts = self._run(ImChatOutcome(http_status=404, error_code="not_found"))
        assert texts == [FLAG_OFF_REPLY]

    def test_503_no_llm_key(self):
        texts = self._run(ImChatOutcome(http_status=503, error_code="E_NO_LLM_KEY"))
        assert texts == [NO_LLM_KEY_REPLY]

    def test_connect_refused_says_app_not_running(self):
        texts = self._run(ImChatOutcome(transport_error="E_CONNECT"))
        assert texts == [GATEWAY_DOWN_REPLY]

    def test_timeout_delivers_partial_text_then_honest_line(self):
        texts = self._run(
            ImChatOutcome(transport_error="E_TIMEOUT", text="写了一半的回复")
        )
        assert texts == ["写了一半的回复", RUN_TIMEOUT_REPLY]

    def test_stream_error_is_appended_visibly(self):
        bridge, _state, sender, gw, _db, delivery = make_bridge()
        gw.chat_outcomes = [
            _ok_outcome(text="前半段", stream_error="upstream exploded")
        ]
        bridge.handle_owner_message("hi", _ctx(delivery))
        assert sender.sent_texts == ["前半段\n\n⚠️ 生成中途出错：upstream exploded"]

    def test_empty_completed_reply_is_not_ghosted(self):
        bridge, _state, sender, gw, _db, delivery = make_bridge()
        gw.chat_outcomes = [_ok_outcome(text="")]
        bridge.handle_owner_message("hi", _ctx(delivery))
        assert sender.sent_texts == ["(空回复)"]  # delivery 的兜底占位


# ── 审批：卡片发出 ──────────────────────────────────────────────────────────
def _pending(approval_id="ap_1", tool="email_send", preview="→ a@b 「hi」"):
    return PendingApproval(
        approval_id=approval_id, tool_name=tool, input_preview=preview
    )


class TestApprovalCard:
    def test_paused_turn_sends_text_then_card(self):
        bridge, _state, sender, gw, _db, delivery = make_bridge()
        gw.chat_outcomes = [
            _ok_outcome(text="我准备发邮件", saw_approval_request=True, approval_id="ap_1")
        ]
        gw.pending_results = [_pending()]
        bridge.handle_owner_message("发个邮件", _ctx(delivery))
        assert sender.sent_texts[0] == "我准备发邮件"
        cards = sender.sent_cards
        assert len(cards) == 1
        card = cards[0]["content"]
        # value 契约：kind + approval_id + decision 白名单值 + 会话/工具上下文
        buttons = []

        def _walk(node):
            if isinstance(node, dict):
                if node.get("tag") == "button":
                    buttons.append(node)
                for v in node.values():
                    _walk(v)
            elif isinstance(node, list):
                for v in node:
                    _walk(v)

        _walk(card)
        assert len(buttons) == 2
        values = [b["behaviors"][0]["value"] for b in buttons]
        assert {v["decision"] for v in values} == {"approve", "reject"}
        for v in values:
            assert v["kind"] == CARD_VALUE_KIND
            assert v["approval_id"] == "ap_1"
            assert v["session_id"] == 77
            assert v["tool_name"] == "email_send"

    def test_pause_without_live_pending_is_honest(self):
        bridge, _state, sender, gw, _db, delivery = make_bridge()
        gw.chat_outcomes = [_ok_outcome(text="", saw_approval_request=True)]
        gw.pending_results = []  # 恒 miss
        bridge.handle_owner_message("hi", _ctx(delivery))
        assert APPROVAL_DETAILS_MISSING_REPLY in sender.sent_texts

    def test_card_send_failure_falls_back_to_text(self):
        bridge, _state, sender, gw, _db, delivery = make_bridge()
        # 第 1 条（暂停前文本）成功、第 2 条（卡片）失败 → fallback 文本
        sender.fail_first_n = 0
        gw.chat_outcomes = [
            _ok_outcome(text="准备写邮件", saw_approval_request=True)
        ]
        gw.pending_results = [_pending()]

        original = sender.create_message

        def flaky(receive_id, msg_type, content):
            if msg_type == "interactive":
                sender.calls.append(
                    {"receive_id": receive_id, "msg_type": msg_type, "content": content}
                )
                return None
            return original(receive_id, msg_type, content)

        sender.create_message = flaky  # type: ignore[assignment]
        bridge.handle_owner_message("hi", _ctx(delivery))
        assert CARD_SEND_FAILED_REPLY.format(tool="email_send") in sender.sent_texts

    def test_stale_pending_notice_on_completed_turn(self):
        bridge, _state, sender, gw, _db, delivery = make_bridge()
        gw.chat_outcomes = [_ok_outcome(text="好了")]
        gw.pending_results = [_pending(tool="email_send")]  # 完成回合却还有旧审批
        bridge.handle_owner_message("hi", _ctx(delivery))
        assert sender.sent_texts == [
            "好了",
            STALE_PENDING_NOTICE.format(tool="email_send"),
        ]
        assert sender.sent_cards == []  # 不补发旧卡（防重复卡）


# ── 卡片回调：toast 路径（WS 线程，3s 预算）──────────────────────────────────
def _click_event(
    *,
    event_id="cevt_1",
    decision="approve",
    approval_id="ap_1",
    operator="ou_owner",
    message_id="om_card_1",
    session_id=77,
):
    return FakeCardActionEvent(
        event_id=event_id,
        operator_open_id=operator,
        open_message_id=message_id,
        value=build_action_value(
            approval_id=approval_id,
            decision=decision,
            session_id=session_id,
            chat_id="oc_1",
            tool_name="email_send",
            input_preview="→ a@b 「hi」",
        ),
    )


class TestCardToastPath:
    def test_toast_shapes(self):
        submit = RecordingSubmit()
        bridge, _state, _sender, _gw, _db, _delivery = make_bridge(submit=submit)
        assert bridge.on_card_action(_click_event()) == TOAST_RECEIVED_APPROVE
        assert (
            bridge.on_card_action(_click_event(event_id="cevt_2", decision="reject"))
            == TOAST_RECEIVED_REJECT
        )

    def test_duplicate_event_is_deduped(self):
        submit = RecordingSubmit()
        bridge, _state, _sender, _gw, _db, _delivery = make_bridge(submit=submit)
        bridge.on_card_action(_click_event(event_id="cevt_dup"))
        assert bridge.on_card_action(_click_event(event_id="cevt_dup")) == TOAST_DUPLICATE
        assert len(submit.tasks) == 1  # 只受理一次

    def test_unknown_kind_and_bad_decision_are_refused(self):
        submit = RecordingSubmit()
        bridge, _state, _sender, _gw, _db, _delivery = make_bridge(submit=submit)
        evt = FakeCardActionEvent(value={"kind": "c6_spike", "action": "approve"})
        assert bridge.on_card_action(evt) == TOAST_UNKNOWN
        evt2 = FakeCardActionEvent(
            event_id="cevt_bad",
            value={"kind": CARD_VALUE_KIND, "approval_id": "x", "decision": "Approve"},
        )
        assert bridge.on_card_action(evt2) == TOAST_UNKNOWN
        assert submit.tasks == []

    def test_submit_full_returns_busy_toast(self):
        bridge, _state, _sender, _gw, _db, _delivery = make_bridge(
            submit=lambda *_a: False
        )
        assert bridge.on_card_action(_click_event()) == TOAST_BUSY

    def test_toast_path_never_touches_sqlite(self):
        """🔴 3s 预算纪律：连 get_bound_open_id（sqlite 读）都必须推迟到 executor。"""
        store = CountingStore({STATE_BOUND_OPEN_ID: "ou_owner"})
        submit = RecordingSubmit()
        bridge, _state, _sender, _gw, _db, _delivery = make_bridge(
            store=store, submit=submit
        )
        store.reads = 0
        bridge.on_card_action(_click_event())
        assert store.reads == 0


# ── 卡片回调：决定处理（executor 线程）──────────────────────────────────────
class TestCardDecision:
    def _bridge(self):
        submit = RecordingSubmit()
        return make_bridge(submit=submit) + (submit,)

    def test_approve_completed_patches_card_and_delivers_full_reply(self):
        bridge, _state, sender, gw, db, delivery, submit = self._bridge()
        gw.decide_results = [
            DecideOutcome(ok=True, http_status=200, status="completed", summary="clip")
        ]
        db.latest_assistant[77] = {
            "role": "assistant",
            "content": "完整的最终回复" * 10,
            "created_at": _future_ms(),
        }
        bridge.on_card_action(_click_event())
        submit.run_all()
        assert gw.decide_calls == [("ap_1", "approve")]
        assert len(sender.patches) == 1
        patched = sender.patches[0]
        assert patched["message_id"] == "om_card_1"
        assert patched["content"]["header"]["title"]["content"] == "✅ 已批准 · 已执行"
        # 完整回复（非 180 字符 summary）投递
        assert sender.sent_texts == ["完整的最终回复" * 10]

    def test_reject_is_a_legal_path_with_model_followup(self):
        bridge, _state, sender, gw, db, delivery, submit = self._bridge()
        gw.decide_results = [
            DecideOutcome(ok=True, http_status=200, status="rejected", summary="好的不发了")
        ]
        db.latest_assistant[77] = {
            "role": "assistant",
            "content": "好的，那我不发送了。",
            "created_at": _future_ms(),
        }
        bridge.on_card_action(_click_event(decision="reject"))
        submit.run_all()
        assert gw.decide_calls == [("ap_1", "reject")]
        assert sender.patches[0]["content"]["header"]["title"]["content"] == "❌ 已拒绝 · 未执行"
        assert sender.sent_texts == ["好的，那我不发送了。"]

    def test_in_place_updated_paused_row_counts_as_fresh(self):
        """🔴 真实 DB 形状：暂停轮的 assistant 行在**暂停时**就 eager 落库，resume 的
        persistTurn 是**就地 UPDATE**（同 UIMessage id）—— created_at 停在暂停时刻、
        只有 updated_at 前移。新鲜度闸只看 created_at 的话，owner 隔 5s 以上才点卡片
        （= 绝大多数真实点击）就恒退回 180 字符 summary，完整回复永远取不到。"""
        bridge, _state, sender, gw, db, delivery, submit = self._bridge()
        gw.decide_results = [
            DecideOutcome(ok=True, http_status=200, status="completed", summary="截断摘要…")
        ]
        db.latest_assistant[77] = {
            "role": "assistant",
            "content": "完整的最终回复（就地替换那一行）",
            # 暂停发生在 10 分钟前（owner 慢慢才点），resume 刚刚写完
            "created_at": time.time() * 1000 - 600_000,
            "updated_at": _future_ms(),
        }
        bridge.on_card_action(_click_event())
        submit.run_all()
        assert sender.sent_texts == ["完整的最终回复（就地替换那一行）"]

    def test_stale_db_reply_falls_back_to_summary(self):
        bridge, _state, sender, gw, db, delivery, submit = self._bridge()
        gw.decide_results = [
            DecideOutcome(ok=True, http_status=200, status="completed", summary="摘要兜底")
        ]
        # DB 里只有 decide 之前的旧回复（时间闸拒收）
        db.latest_assistant[77] = {
            "role": "assistant",
            "content": "上一轮的旧回复",
            "created_at": 1000,
        }
        bridge.on_card_action(_click_event())
        submit.run_all()
        assert sender.sent_texts == ["摘要兜底"]

    def test_repaused_patches_current_and_sends_next_card(self):
        """🔴 island.py:224-230 语义照抄：repaused 非终态，必须补下一张卡。"""
        bridge, _state, sender, gw, _db, delivery, submit = self._bridge()
        gw.decide_results = [
            DecideOutcome(ok=True, http_status=200, status="repaused", summary="第一步做完")
        ]
        gw.pending_results = [_pending(approval_id="ap_2", tool="email_archive")]
        bridge.on_card_action(_click_event())
        submit.run_all()
        assert (
            sender.patches[0]["content"]["header"]["title"]["content"]
            == "✅ 已批准 · 还有后续操作待确认"
        )
        cards = sender.sent_cards
        assert len(cards) == 1  # 下一张审批卡
        next_values = str(cards[0]["content"])
        assert "ap_2" in next_values and "email_archive" in next_values

    def test_repaused_without_next_pending_is_honest(self):
        bridge, _state, sender, gw, _db, delivery, submit = self._bridge()
        gw.decide_results = [
            DecideOutcome(ok=True, http_status=200, status="repaused")
        ]
        gw.pending_results = []
        bridge.on_card_action(_click_event())
        submit.run_all()
        assert REPAUSED_NEXT_MISSING_REPLY in sender.sent_texts

    def test_stale_approval_404_patches_invalid_no_second_execution(self):
        bridge, _state, sender, gw, _db, delivery, submit = self._bridge()
        gw.decide_results = [
            DecideOutcome(ok=False, http_status=404, status="not_found")
        ]
        bridge.on_card_action(_click_event(event_id="cevt_second_click"))
        submit.run_all()
        assert sender.patches[0]["content"]["header"]["title"]["content"] == "⚪ 已失效"
        assert DECIDE_INVALID_DETAIL in str(sender.patches[0]["content"])
        assert len(gw.decide_calls) == 1  # 只提交了一次，绝无二次执行

    def test_busy_409_keeps_card_actionable(self):
        bridge, _state, sender, gw, _db, delivery, submit = self._bridge()
        gw.decide_results = [DecideOutcome(ok=False, http_status=409, error="busy")]
        bridge.on_card_action(_click_event())
        submit.run_all()
        assert sender.patches == []  # 卡片不动（按钮保留，可重试）
        assert sender.sent_texts == [DECIDE_BUSY_REPLY]

    def test_gateway_down_keeps_card_actionable(self):
        bridge, _state, sender, gw, _db, delivery, submit = self._bridge()
        gw.decide_results = [DecideOutcome(transport_error="E_CONNECT")]
        bridge.on_card_action(_click_event())
        submit.run_all()
        assert sender.patches == []
        assert sender.sent_texts == [DECIDE_DOWN_REPLY]

    def test_decide_timeout_never_claims_it_did_not_run(self):
        """🔴 如实性：读超时 = 请求**已送到**，被批准的工具可能已经执行完
        （decide 超时 100s，写工具跑久了就撞上）。绝不能说「这次点击没有生效、
        再点一次」—— 那是谎报未执行 + 诱导重复操作。"""
        for terr in ("E_TIMEOUT", "E_HTTP"):
            bridge, _state, sender, gw, _db, delivery, submit = self._bridge()
            gw.decide_results = [DecideOutcome(transport_error=terr)]
            bridge.on_card_action(_click_event())
            submit.run_all()
            assert sender.patches == []  # 结果未知 → 卡片不动
            assert sender.sent_texts == [bridge_mod.DECIDE_UNKNOWN_REPLY]
            assert DECIDE_DOWN_REPLY not in sender.sent_texts

    def test_execution_error_is_surfaced_on_card(self):
        bridge, _state, sender, gw, _db, delivery, submit = self._bridge()
        gw.decide_results = [
            DecideOutcome(
                ok=False, http_status=200, status="error", error="E_APPROVAL_EXPIRED"
            )
        ]
        bridge.on_card_action(_click_event())
        submit.run_all()
        assert sender.patches[0]["content"]["header"]["title"]["content"] == "⚠️ 执行失败"
        assert "E_APPROVAL_EXPIRED" in str(sender.patches[0]["content"])

    def test_patch_failure_falls_back_to_new_message(self):
        bridge, _state, sender, gw, db, delivery, submit = self._bridge()
        sender.patch_fail = True
        gw.decide_results = [
            DecideOutcome(ok=True, http_status=200, status="rejected")
        ]
        bridge.on_card_action(_click_event(decision="reject"))
        submit.run_all()
        assert len(sender.patches) == 1  # PATCH 试过
        assert bridge_mod.REJECTED_FALLBACK_TEXT in sender.sent_texts

    def test_stranger_operator_is_refused_without_decide(self):
        bridge, _state, sender, gw, _db, delivery, submit = self._bridge()
        bridge.on_card_action(_click_event(operator="ou_stranger"))
        submit.run_all()
        assert gw.decide_calls == []
        assert sender.patches == []
