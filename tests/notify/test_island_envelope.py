"""单测：island_envelope 协议层（Swift Date / size guard / metadata truncation）."""

from __future__ import annotations

import json
import time

import pytest

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
    assert body["eventType"] == "MailReceived"
    assert body["sessionKey"] == "mailagent:email:42"
    assert body["intervention"] is None
    assert body["expectsResponse"] is False
    assert "sentAt" in body
    # status.kind 默认 notification
    assert body["status"]["kind"] == "notification"


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
