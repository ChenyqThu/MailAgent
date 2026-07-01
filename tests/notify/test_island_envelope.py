"""单测：island_envelope 协议层（Swift Date / size guard / metadata truncation）."""

from __future__ import annotations

import json
import time


from src.notify.island_envelope import (
    BridgeEnvelope,
    Intervention,
    InterventionOption,
    SWIFT_DATE_EPOCH_OFFSET,
    build_ping_envelope,
    swift_now,
)


def test_swift_date_offset_matches_2001_epoch():
    """Swift Date = unix epoch - 978307200 (REVIEW-LOG M-15)."""
    assert SWIFT_DATE_EPOCH_OFFSET == 978307200.0
    diff = time.time() - SWIFT_DATE_EPOCH_OFFSET - swift_now()
    assert abs(diff) < 1.0  # 调用瞬间偏差不超 1s


def test_envelope_wire_shape_minimum_fields():
    env = BridgeEnvelope(
        event_type="MailReceived",
        session_key="mailagent:email:42",
        title="hi",
        preview="hello",
    )
    body = env.to_wire_dict()
    assert body["provider"] == "mail"
    # Sprint 10 (b) §2.5.4-D 方案 A: wire 层 eventType 翻译成 ping-island 已识别
    # 的 "Notification"；原 mail event 名进 metadata.mailagent.eventType。
    assert body["eventType"] == "Notification"
    assert body["metadata"]["mailagent.eventType"] == "MailReceived"
    assert body["sessionKey"] == "mailagent:email:42"
    assert body["intervention"] is None
    assert body["expectsResponse"] is False
    assert "sentAt" in body
    # status.kind 默认 notification
    assert body["status"]["kind"] == "notification"


def test_envelope_wire_event_map_all_mail_events():
    """All 10 mail events 在 wire 层都 collapse 到 "Notification"."""
    mail_events = [
        "MailReceived", "MailReceivedUrgent",
        "LLMReviewed", "LLMReviewedUrgent",
        "MailCompleted", "SyncFailed", "DeadLetterAccum",
        "AIDraftStart", "AIDraftStream", "AIDraftReady",
    ]
    for ev in mail_events:
        env = BridgeEnvelope(event_type=ev, session_key=f"k:{ev}", title="t")
        body = env.to_wire_dict()
        assert body["eventType"] == "Notification", f"{ev} should map to Notification"
        assert body["metadata"]["mailagent.eventType"] == ev


def test_envelope_wire_passes_through_native_notification():
    """envelope.event_type='Notification'（如 reconnect ping）原样 wire 出，metadata
    仍写真值 — 调用方 / fork dispatcher 能区分 ping 还是 mail event。"""
    env = BridgeEnvelope(event_type="Notification", session_key="mailagent:system:ping", title="ping")
    body = env.to_wire_dict()
    assert body["eventType"] == "Notification"
    assert body["metadata"]["mailagent.eventType"] == "Notification"


def test_envelope_intervention_session_id_propagated():
    """intervention.sessionID 没显式给时，自动用 envelope.session_key."""
    env = BridgeEnvelope(
        event_type="LLMReviewedUrgent",
        session_key="mailagent:email:53675",
        title="t",
        intervention=Intervention(
            title="T",
            message="M",
            options=[InterventionOption(id="x", title="X")],
        ),
        expects_response=True,
    )
    body = env.to_wire_dict()
    assert body["intervention"]["sessionID"] == "mailagent:email:53675"


def test_envelope_truncates_metadata_when_oversize():
    """超 max_bytes 时优先把长 metadata 值替换成 ``<truncated>``."""
    env = BridgeEnvelope(
        event_type="MailReceived",
        session_key="mailagent:email:1",
        title="t",
        preview="p",
        metadata={f"mailagent.k{i}": "X" * 1000 for i in range(20)},
    )
    data = env.encode(max_bytes=2048)
    assert len(data) <= 2048
    body = json.loads(data)
    truncated = sum(1 for v in body["metadata"].values() if v == "<truncated>")
    assert truncated > 0, "expected at least one metadata value to be truncated"


def test_envelope_truncates_preview_when_still_oversize():
    """metadata 全替换后还超限 → 截 preview 到 200 字符."""
    env = BridgeEnvelope(
        event_type="MailReceived",
        session_key="mailagent:email:1",
        title="t",
        preview="P" * 10000,
        metadata={},
    )
    data = env.encode(max_bytes=400)
    body = json.loads(data)
    assert len(body["preview"]) <= 201  # 200 + 1 ellipsis char "…"


def test_intervention_option_to_dict_omits_blank_detail():
    opt = InterventionOption(id="x", title="X")
    assert opt.to_dict() == {"id": "x", "title": "X"}
    opt2 = InterventionOption(id="y", title="Y", detail="d")
    assert opt2.to_dict()["detail"] == "d"


def test_build_ping_envelope_is_notification_no_response():
    env = build_ping_envelope()
    assert env.event_type == "Notification"
    assert env.expects_response is False
    assert env.status_kind == "notification"
    assert env.metadata.get("mailagent.kind") == "ping"


def test_envelope_id_deterministic_and_valid_uuid():
    """契约 §9-1: 同 (session_key, event_type) → 同一确定性 UUID (Swift id: UUID 需合法)."""
    import uuid as _uuid

    def _wire_id(sk: str, ev: str) -> str:
        return BridgeEnvelope(event_type=ev, session_key=sk, title="t").to_wire_dict()["id"]

    id1 = _wire_id("mailagent:email:53675", "LLMReviewedUrgent")
    id2 = _wire_id("mailagent:email:53675", "LLMReviewedUrgent")
    id3 = _wire_id("mailagent:email:53675", "MailReceived")  # 换 scenario
    id4 = _wire_id("mailagent:email:99", "LLMReviewedUrgent")  # 换邮件
    assert id1 == id2, "同 (邮件, scenario) 必须同 id (幂等)"
    assert id1 != id3, "不同 scenario 必须不同 id (能再提醒)"
    assert id1 != id4, "不同邮件必须不同 id"
    # 必须是合法 UUID (Swift BridgeEnvelope.id: UUID 解码前提)
    assert str(_uuid.UUID(id1)) == id1
    # tool_use_id 随 envelope_id 确定性
    body = BridgeEnvelope(
        event_type="LLMReviewedUrgent", session_key="mailagent:email:53675", title="t",
    ).to_wire_dict()
    assert body["metadata"]["tool_use_id"] == f"bridge-{id1}"


def test_intervention_id_deterministic_matches_fork_stable_id():
    """契约 §9-1/§10: intervention.id = mail:{resolvedSessionID}:{event_type} (对齐 fork)."""
    env = BridgeEnvelope(
        event_type="LLMReviewedUrgent",
        session_key="mailagent:email:99",
        title="t",
        intervention=Intervention(
            title="T", message="M", options=[InterventionOption(id="mark_done", title="X")],
        ),
        expects_response=True,
    )
    body = env.to_wire_dict()
    # 匹配 PING-ISLAND-INTERFACE.md §10 self-verify 例子 "mail:email:99:LLMReviewedUrgent"
    assert body["intervention"]["id"] == "mail:email:99:LLMReviewedUrgent"
    # 重发同身份 (幂等)
    assert env.to_wire_dict()["intervention"]["id"] == body["intervention"]["id"]


def test_envelope_explicit_id_overrides_deterministic():
    """显式传 envelope_id 时不派生 (probe / 特殊场景可覆盖)."""
    env = BridgeEnvelope(
        event_type="Notification", session_key="mailagent:system:ping", title="p",
        envelope_id="fixed-explicit-id",
    )
    assert env.to_wire_dict()["id"] == "fixed-explicit-id"


def test_envelope_metadata_values_are_str_in_wire():
    """to_wire_dict() 必须把 metadata 值统一 str 化（Swift Codable 严格类型）."""
    env = BridgeEnvelope(
        event_type="MailReceived",
        session_key="x",
        title="t",
        metadata={"mailagent.count": 42, "mailagent.flag": True},  # type: ignore[dict-item]
    )
    body = env.to_wire_dict()
    assert body["metadata"]["mailagent.count"] == "42"
    assert body["metadata"]["mailagent.flag"] == "True"
