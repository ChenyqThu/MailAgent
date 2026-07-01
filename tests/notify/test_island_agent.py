"""island_agent envelope builder（Part B）单测 —— 不碰 socket。"""

from __future__ import annotations

from src.notify import island_agent


def test_approval_envelope_shape():
    env = island_agent.build_approval_envelope(
        session_id=5, tool_name="email_prepare_send",
        input_preview="发送给 bob@x.com：会议纪要", risk="blocking",
    )
    d = env.to_wire_dict()
    assert env.event_type == "AgentApproval"
    assert env.status_kind == "waitingForInput"
    assert env.expects_response is True
    assert d["sessionKey"] == "mailagent:agent:5"
    assert d["eventType"] == "Notification"  # wire 层一律 Notification（fork dispatcher）
    assert d["metadata"]["mailagent.scenario"] == "AgentApproval"
    assert d["metadata"]["mailagent.agentTool"] == "email_prepare_send"
    assert d["metadata"]["mailagent.agentRisk"] == "blocking"
    assert d["metadata"]["client_kind"] == "mailagent"  # brand
    # 确定性 intervention.id 对齐 fork stableID
    assert d["intervention"]["id"] == "mail:agent:5:AgentApproval"
    assert [o["id"] for o in d["intervention"]["options"]] == ["approve", "reject"]


def test_status_envelope_variants():
    completed = island_agent.build_status_envelope(
        session_id=3, status_kind="completed", summary="已执行")
    assert completed.event_type == "AgentCompleted"
    assert completed.status_kind == "completed"
    assert completed.intervention is None
    assert completed.expects_response is False

    error = island_agent.build_status_envelope(
        session_id=3, status_kind="error", summary="tool 执行失败: timeout")
    ed = error.to_wire_dict()
    assert error.event_type == "AgentError"
    assert ed["status"]["kind"] == "error"
    assert ed["status"]["detail"] == "tool 执行失败: timeout"

    running = island_agent.build_status_envelope(session_id=3, status_kind="notification")
    assert running.event_type == "AgentRunning"
    assert running.status_kind == "notification"


def test_deterministic_id_idempotent():
    # 同 (session, scenario) 重发 → 同一 envelope id + intervention id（幂等，不重弹）
    a = island_agent.build_approval_envelope(
        session_id=9, tool_name="t", input_preview="p").to_wire_dict()
    b = island_agent.build_approval_envelope(
        session_id=9, tool_name="t", input_preview="p2").to_wire_dict()
    assert a["id"] == b["id"]
    assert a["intervention"]["id"] == b["intervention"]["id"]
