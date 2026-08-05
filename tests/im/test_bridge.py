"""消息→agent run→回投 + 飞书内审批闭环（src/im/bridge.py）。

全离线：gateway / chat_db / sender 全替身，零网络、零 lark、零 sqlite。
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from src.agent_config.enabled_models import (
    EnabledModel,
    EnabledModelCatalog,
    EnabledModelGroup,
)
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
    MODEL_EMPTY_REPLY,
    MODEL_MARK_CURRENT,
    MODEL_MARK_DEFAULT,
    MODEL_PREF_STALE_NOTICE,
    MODEL_PREF_UNVERIFIABLE_NOTICE,
    MODEL_RESET_REPLY,
    MODEL_RESET_REPLY_UNKNOWN,
    MODEL_SWITCHED_REPLY,
    MODEL_UNKNOWN_REPLY,
    MODEL_USAGE_HINT,
    NEW_SESSION_REPLY,
    NO_LLM_KEY_REPLY,
    REPAUSED_NEXT_MISSING_REPLY,
    REPAUSED_PROGRESS_PREFIX,
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
from src.im.cards import CARD_VALUE_KIND, DESTRUCTIVE_WARNING, build_action_value
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

    def stream_im_chat(self, messages, session_id, model=None):
        self.chat_calls.append(
            {"messages": messages, "session_id": session_id, "model": model}
        )
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


def _catalog(*groups, default_model="claude-sonnet-4-6", source="registry"):
    return EnabledModelCatalog(
        groups=tuple(groups), default_model=default_model, source=source
    )


def _group(provider_id, provider_name, *models):
    return EnabledModelGroup(
        provider_id=provider_id, provider_name=provider_name, models=tuple(models)
    )


def _model(ref, provider_id, model_id, display_name=""):
    return EnabledModel(
        ref=ref, provider_id=provider_id, model_id=model_id, display_name=display_name
    )


#: 默认替身清单：default provider 两个模型 + 一个第三方 provider。
DEFAULT_CATALOG = _catalog(
    _group(
        "default",
        "CRS 中转",
        _model("claude-sonnet-4-6", "default", "claude-sonnet-4-6"),
        _model("claude-opus-4-8", "default", "claude-opus-4-8", "Opus 4.8"),
    ),
    _group("dash", "阿里百炼", _model("dash:qwen-max", "dash", "qwen-max")),
)


def make_bridge(*, store=None, submit=None, catalog=DEFAULT_CATALOG):
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
        model_catalog=lambda: catalog,
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


# ── /model（列表 / 切换 / reset）──────────────────────────────────────────────
MODEL_KEY = "im.feishu.model.oc_1"


class TestModelCommand:
    def test_list_marks_current_and_default_and_ends_with_usage(self):
        """无参 ``/model``：当前/默认标注 + provider 分组 + 用法（IM 侧唯一发现入口）。"""
        bridge, _state, sender, _gw, _db, delivery = make_bridge()
        bridge.handle_owner_message("/model", _ctx(delivery))
        assert len(sender.sent_texts) == 1
        body = sender.sent_texts[0]
        assert body.startswith("🧠 当前模型：claude-sonnet-4-6")
        assert f"· claude-sonnet-4-6 —— {MODEL_MARK_CURRENT} · {MODEL_MARK_DEFAULT}" in body
        assert "【CRS 中转】" in body and "【阿里百炼】" in body
        # 有别名的模型展示「别名（ref）」；没别名的只展示 ref
        assert "· Opus 4.8（claude-opus-4-8）" in body
        assert "· dash:qwen-max" in body
        assert body.endswith(MODEL_USAGE_HINT)

    def test_list_reflects_stored_preference_as_current(self):
        bridge, state, sender, _gw, _db, delivery = make_bridge()
        state.set_model_pref("oc_1", "dash:qwen-max")
        bridge.handle_owner_message("/model", _ctx(delivery))
        body = sender.sent_texts[0]
        assert body.startswith("🧠 当前模型：dash:qwen-max")
        assert f"· dash:qwen-max —— {MODEL_MARK_CURRENT}" in body
        # 默认模型仍标「默认」（但不再是「当前」）
        assert f"· claude-sonnet-4-6 —— {MODEL_MARK_DEFAULT}" in body

    def test_list_when_catalog_empty_says_so_and_still_shows_usage(self):
        bridge, _state, sender, _gw, _db, delivery = make_bridge(
            catalog=EnabledModelCatalog(default_model="claude-sonnet-4-6")
        )
        bridge.handle_owner_message("/model", _ctx(delivery))
        assert sender.sent_texts == [f"{MODEL_EMPTY_REPLY}\n\n{MODEL_USAGE_HINT}"]

    def test_switch_accepts_three_writings_and_stores_canonical(self):
        """``provider:model`` / ``provider/model`` / 裸 ``model`` 三种写法都认，落库 canonical。"""
        for written, canonical in (
            ("dash:qwen-max", "dash:qwen-max"),
            ("dash/qwen-max", "dash:qwen-max"),
            ("claude-opus-4-8", "claude-opus-4-8"),
            # default provider 的显式写法归一成裸 id（与 enabledModels 输出一致）
            ("default:claude-opus-4-8", "claude-opus-4-8"),
        ):
            store = FakeStateStore({STATE_BOUND_OPEN_ID: "ou_owner"})
            bridge, state, sender, _gw, _db, delivery = make_bridge(store=store)
            bridge.handle_owner_message(f"/model {written}", _ctx(delivery))
            assert state.get_model_pref("oc_1") == canonical, written
            assert store.data[MODEL_KEY] == canonical, written
            assert len(sender.sent_texts) == 1

    def test_switch_reply_uses_display_label(self):
        bridge, _state, sender, _gw, _db, delivery = make_bridge()
        bridge.handle_owner_message("/model claude-opus-4-8", _ctx(delivery))
        assert sender.sent_texts == [
            MODEL_SWITCHED_REPLY.format(model="Opus 4.8（claude-opus-4-8）")
        ]

    def test_unknown_ref_is_rejected_and_not_persisted(self):
        """🔴 校验不过 = 不落库（透传到 gateway 会让整轮卡成 30 分钟读超时）。"""
        store = FakeStateStore({STATE_BOUND_OPEN_ID: "ou_owner"})
        bridge, state, sender, gw, _db, delivery = make_bridge(store=store)
        bridge.handle_owner_message("/model nope:whatever", _ctx(delivery))
        assert sender.sent_texts == [MODEL_UNKNOWN_REPLY.format(ref="nope:whatever")]
        assert state.get_model_pref("oc_1") == ""
        assert MODEL_KEY not in store.data
        assert gw.chat_calls == []  # 不当成提问跑一轮

    def test_reset_clears_preference(self):
        bridge, state, sender, _gw, _db, delivery = make_bridge()
        state.set_model_pref("oc_1", "dash:qwen-max")
        bridge.handle_owner_message("/model  RESET ", _ctx(delivery))
        assert state.get_model_pref("oc_1") == ""
        assert sender.sent_texts == [
            MODEL_RESET_REPLY.format(model="claude-sonnet-4-6")
        ]

    def test_new_command_does_not_reset_model_preference(self):
        """``/new`` 只换会话，不动模型偏好（换话题 ≠ 换模型）。"""
        bridge, state, sender, _gw, _db, delivery = make_bridge()
        state.set_model_pref("oc_1", "dash:qwen-max")
        bridge.handle_owner_message("/new", _ctx(delivery))
        assert state.get_model_pref("oc_1") == "dash:qwen-max"

    def test_modelx_is_not_a_command(self):
        """🔴 前缀匹配必须带空格：``/modelx …`` 是提问，不是命令。"""
        bridge, _state, sender, gw, _db, delivery = make_bridge()
        gw.chat_outcomes = [_ok_outcome(text="answer")]
        bridge.handle_owner_message("/modelx 是什么", _ctx(delivery))
        assert len(gw.chat_calls) == 1
        assert sender.sent_texts == ["answer"]

    def test_full_width_space_still_parses_as_the_command(self):
        """🔴 中文输入法的全角空格（U+3000）：``/model　x`` 也得是命令，不是提问。"""
        store = FakeStateStore({STATE_BOUND_OPEN_ID: "ou_owner"})
        bridge, state, _sender, gw, _db, delivery = make_bridge(store=store)
        bridge.handle_owner_message("/model　dash:qwen-max", _ctx(delivery))
        assert state.get_model_pref("oc_1") == "dash:qwen-max"
        assert gw.chat_calls == []  # 没有被当成提问跑一轮

    def test_reset_without_a_readable_catalog_does_not_name_a_model(self):
        """🔴 配置整个读不出来时，「默认模型叫什么」没有依据 —— 不许报名字。"""

        def boom():
            raise RuntimeError("agent_config.db locked")

        bridge, state, sender, _gw, _db, delivery = make_bridge()
        bridge._model_catalog = boom
        state.set_model_pref("oc_1", "dash:qwen-max")
        bridge.handle_owner_message("/model reset", _ctx(delivery))
        assert state.get_model_pref("oc_1") == ""  # 清偏好是事实，照做
        assert sender.sent_texts == [MODEL_RESET_REPLY_UNKNOWN]
        assert "claude" not in MODEL_RESET_REPLY_UNKNOWN

    def test_default_model_written_with_explicit_prefix_still_marks_current(self):
        """``LLM_MODEL=default:x`` 时清单里的 ref 是裸 ``x`` —— 标记必须归一后再比。"""
        bridge, _state, sender, _gw, _db, delivery = make_bridge(
            catalog=_catalog(
                _group(
                    "default",
                    "CRS 中转",
                    _model("claude-opus-4-8", "default", "claude-opus-4-8"),
                ),
                default_model="default:claude-opus-4-8",
            )
        )
        bridge.handle_owner_message("/model", _ctx(delivery))
        body = sender.sent_texts[0]
        assert body.startswith("🧠 当前模型：claude-opus-4-8")
        assert f"· claude-opus-4-8 —— {MODEL_MARK_CURRENT} · {MODEL_MARK_DEFAULT}" in body

    def test_ref_resolution_is_deterministic_when_slash_form_is_ambiguous(self):
        """歧义：default 下有 ``a/b`` 且 provider ``a`` 下有 ``b`` —— 第一步（原样）恒赢。"""
        bridge, state, _sender, _gw, _db, delivery = make_bridge(
            catalog=_catalog(
                _group("default", "CRS 中转", _model("a/b", "default", "a/b")),
                _group("a", "A 家", _model("a:b", "a", "b")),
            )
        )
        bridge.handle_owner_message("/model a/b", _ctx(delivery))
        assert state.get_model_pref("oc_1") == "a/b"
        bridge.handle_owner_message("/model a:b", _ctx(delivery))  # 显式冒号仍走 provider
        assert state.get_model_pref("oc_1") == "a:b"

    def test_default_provider_model_id_containing_slash_resolves(self):
        """openrouter 风格 ``anthropic/claude-x`` 挂在 default 下 —— 别被第 2 步误判成 provider。"""
        bridge, state, _sender, _gw, _db, delivery = make_bridge(
            catalog=_catalog(
                _group(
                    "default",
                    "CRS 中转",
                    _model("anthropic/claude-x", "default", "anthropic/claude-x"),
                )
            )
        )
        bridge.handle_owner_message("/model anthropic/claude-x", _ctx(delivery))
        assert state.get_model_pref("oc_1") == "anthropic/claude-x"


# ── /model 偏好 → agent run ──────────────────────────────────────────────────
class TestTurnModelSelection:
    def test_no_preference_omits_model(self):
        bridge, _state, _sender, gw, _db, delivery = make_bridge()
        gw.chat_outcomes = [_ok_outcome()]
        bridge.handle_owner_message("hi", _ctx(delivery))
        assert gw.chat_calls[0]["model"] is None

    def test_preference_is_passed_through(self):
        bridge, state, _sender, gw, _db, delivery = make_bridge()
        state.set_model_pref("oc_1", "dash:qwen-max")
        gw.chat_outcomes = [_ok_outcome()]
        bridge.handle_owner_message("hi", _ctx(delivery))
        assert gw.chat_calls[0]["model"] == "dash:qwen-max"

    def test_stale_preference_falls_back_to_default_and_says_so(self):
        """存好的模型事后被禁用 → 本轮回退默认 + 如实附提示；键**不**自动清。"""
        bridge, state, sender, gw, _db, delivery = make_bridge()
        state.set_model_pref("oc_1", "dash:qwen-max")
        # 该 provider 下架后的清单
        bridge._model_catalog = lambda: _catalog(
            _group("default", "CRS 中转", _model("claude-sonnet-4-6", "default", "claude-sonnet-4-6"))
        )
        gw.chat_outcomes = [_ok_outcome(text="回复")]
        bridge.handle_owner_message("hi", _ctx(delivery))
        assert gw.chat_calls[0]["model"] is None
        notice = MODEL_PREF_STALE_NOTICE.format(
            ref="dash:qwen-max", default="claude-sonnet-4-6"
        )
        assert sender.sent_texts == [f"回复\n\n{notice}"]
        assert state.get_model_pref("oc_1") == "dash:qwen-max"

    def test_unverifiable_catalog_does_not_claim_the_model_is_gone(self):
        """清单整体取不到 → 保守走默认，但不能断言「这个模型没了」。"""
        bridge, state, sender, gw, _db, delivery = make_bridge(
            catalog=EnabledModelCatalog(default_model="claude-sonnet-4-6")
        )
        state.set_model_pref("oc_1", "dash:qwen-max")
        gw.chat_outcomes = [_ok_outcome(text="回复")]
        bridge.handle_owner_message("hi", _ctx(delivery))
        assert gw.chat_calls[0]["model"] is None
        notice = MODEL_PREF_UNVERIFIABLE_NOTICE.format(ref="dash:qwen-max")
        # 🔴 清单读不出来时**不报**默认模型的名字（没依据的名字就是编）
        assert "claude-sonnet-4-6" not in notice
        assert sender.sent_texts == [f"回复\n\n{notice}"]

    def test_catalog_loader_exception_degrades_instead_of_breaking_the_turn(self):
        def boom():
            raise RuntimeError("agent_config.db locked")

        bridge, state, _sender, gw, _db, delivery = make_bridge()
        bridge._model_catalog = boom
        state.set_model_pref("oc_1", "dash:qwen-max")
        gw.chat_outcomes = [_ok_outcome(text="回复")]
        bridge.handle_owner_message("hi", _ctx(delivery))
        assert gw.chat_calls[0]["model"] is None  # 整轮照跑，只是不带 model


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

    def test_destructive_pending_adds_red_warning_block(self):
        """PR-4：MCP 服务方标了 destructive → 卡片上多一条**红色**警告块。

        判据来自 gateway ``/pending`` 的 ``destructive`` 位（stash 在暂停时冻住的
        manifest 事实），**不是**模型参数 —— 模型不能把自己的警告说没。措辞与桌面
        ``McpApprovalCard`` 的 ``chat.mcpApprovalCard.destructiveWarning`` 同一句。
        """
        bridge, _state, sender, gw, _db, delivery = make_bridge()
        gw.chat_outcomes = [_ok_outcome(text="", saw_approval_request=True, approval_id="ap_d")]
        gw.pending_results = [
            PendingApproval(
                approval_id="ap_d",
                tool_name="mcp__notion__notion_update_page",
                input_preview="page=x",
                destructive=True,
            )
        ]
        bridge.handle_owner_message("改一下那个页面", _ctx(delivery))
        card = str(sender.sent_cards[0]["content"])
        assert DESTRUCTIVE_WARNING in card
        assert "color='red'" in card

    def test_non_destructive_pending_has_no_warning(self):
        """反向闸：没标 destructive（含老 gateway 不返回该字段）→ 一个字都不加。

        少一句提示可以接受；凭空造一句「这可能毁数据」会让红警告贬值，真正危险的
        那次就没人当回事了。
        """
        bridge, _state, sender, gw, _db, delivery = make_bridge()
        gw.chat_outcomes = [_ok_outcome(text="", saw_approval_request=True, approval_id="ap_1")]
        gw.pending_results = [_pending()]  # destructive 默认 False
        bridge.handle_owner_message("发个邮件", _ctx(delivery))
        assert DESTRUCTIVE_WARNING not in str(sender.sent_cards[0]["content"])

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

    def test_repaused_delivers_intermediate_summary_before_next_card(self):
        """PR-4（复核留档项 2）：中间跳的叙述不能丢。

        repaused 是**非终态**，走不到「取最终回复投递」那一段 —— 修复前模型在这一跳里
        说的话整段被丢掉，用户只看到「已批准 → 又来一张卡」。现在把 ``/decide`` 的
        ``summary`` 当中间进展投递，且**显式标明是摘要**（gateway ``clipSummary`` 截到
        180 字符，不标就是把截断文本冒充成完整回复）。顺序：先叙述、后下一张卡。
        """
        bridge, _state, sender, gw, _db, delivery, submit = self._bridge()
        gw.decide_results = [
            DecideOutcome(ok=True, http_status=200, status="repaused", summary="第一步做完了")
        ]
        gw.pending_results = [_pending(approval_id="ap_2", tool="email_archive")]
        bridge.on_card_action(_click_event())
        submit.run_all()

        progress = f"{REPAUSED_PROGRESS_PREFIX}第一步做完了"
        assert progress in sender.sent_texts
        # 🔴 顺序：中间进展文本必须排在下一张审批卡**之前**（先读懂发生了什么，再面对
        # 「下一个要不要批」）。calls 是同一条时间线，比对下标即可。
        text_idx = next(
            i for i, c in enumerate(sender.calls) if c["content"].get("text") == progress
        )
        card_idx = next(i for i, c in enumerate(sender.calls) if c["msg_type"] == "interactive")
        assert text_idx < card_idx

    def test_repaused_without_summary_sends_no_empty_progress(self):
        """summary 为空（gateway 没给）→ 不发空消息，只补下一张卡。"""
        bridge, _state, sender, gw, _db, delivery, submit = self._bridge()
        gw.decide_results = [
            DecideOutcome(ok=True, http_status=200, status="repaused", summary="  ")
        ]
        gw.pending_results = [_pending(approval_id="ap_2", tool="email_archive")]
        bridge.on_card_action(_click_event())
        submit.run_all()
        # 只发了下一张卡，一条 text 消息都没有（`sent_texts` 会把卡片记成 ''，故按
        # msg_type 判而不是按文本内容判 —— 否则空串会和「没发」混成一件事）。
        assert [c["msg_type"] for c in sender.calls] == ["interactive"]

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
