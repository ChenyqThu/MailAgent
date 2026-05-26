"""Tests for src.notify.island_response handle_response 17 action dispatch.

Strategy:
- subprocess (osascript / open / mailagent CLI) → monkeypatch ``_run`` 抓 args, 不真起进程
- island_snooze.add → monkeypatch 抓入参
- _seconds_until_next_monday_9am → 单元测 (datetime fixture)
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Any, Dict, List

import pytest

from src.notify import island_response, island_snooze


@pytest.fixture
def patch_run(monkeypatch):
    """抓 island_response._run 的入参; 不真跑 subprocess."""
    captured: List[Dict[str, Any]] = []

    async def fake_run(args, *, timeout: float = 10) -> None:
        captured.append({"args": list(args), "timeout": timeout})

    monkeypatch.setattr(island_response, "_run", fake_run)
    return captured


@pytest.fixture
def patch_snooze(monkeypatch):
    """抓 island_snooze.add 入参."""
    captured: List[Dict[str, Any]] = []

    def fake_add(**kwargs):
        captured.append(kwargs)

    monkeypatch.setattr(island_snooze, "add", fake_add)
    # island_response 内 from src.notify import island_snooze, 同一个 module
    monkeypatch.setattr(island_response.island_snooze, "add", fake_add)
    return captured


def _resp(choice: str) -> Dict[str, Any]:
    """构造 BridgeResponse.decision.answer.choice 形状."""
    return {"decision": {"answer": {"choice": choice}}}


def _meta(internal_id: int = 53675, **extra) -> Dict[str, str]:
    base = {
        "mailagent.internalId": str(internal_id),
        "mailagent.accountName": "Exchange",
        "mailagent.mailboxName": "收件箱",
        "mailagent.mailbox": "收件箱",
        "mailagent.notionPageId": "31a1-5375-830d-8179-8e75-fcfce933808b",
        "mailagent.subject": "Test",
        "mailagent.sender": "alice@example.com",
        "mailagent.senderName": "Alice",
        "mailagent.aiAction": "需要回复",
        "mailagent.aiPriority": "🔴 紧急",
    }
    base.update(extra)
    return base


# ─────────────────────────────────────────────────────────────────────────────
# Phase 1 静态 5 路径 (保留兼容验证)
# ─────────────────────────────────────────────────────────────────────────────


def test_open_mail_invokes_osascript_with_internal_id(patch_run):
    asyncio.run(island_response.handle_response(_resp("open_mail"), _meta(53675)))
    assert len(patch_run) == 1
    args = patch_run[0]["args"]
    assert args[0] == "osascript"
    assert "-e" in args
    script = args[2]
    assert "53675" in script
    assert 'whose name is "Exchange"' in script
    assert 'whose name is "收件箱"' in script


def test_open_notion_uses_notion_protocol_when_app_installed(patch_run, monkeypatch):
    monkeypatch.setattr(island_response.Path, "exists", lambda self: True)
    monkeypatch.setattr(island_response.shutil, "which", lambda _: "/usr/bin/open")
    asyncio.run(island_response.handle_response(_resp("open_notion"), _meta()))
    assert len(patch_run) == 1
    args = patch_run[0]["args"]
    assert args[0] == "open"
    assert args[1].startswith("notion://www.notion.so/")
    assert "-" not in args[1].split("/")[-1]  # dashless 32-hex


def test_open_notion_falls_back_to_web_url_when_app_missing(patch_run, monkeypatch):
    monkeypatch.setattr(island_response.Path, "exists", lambda self: False)
    asyncio.run(island_response.handle_response(_resp("open_notion"), _meta()))
    assert patch_run[0]["args"][1].startswith("https://www.notion.so/")


def test_open_notion_no_page_id_is_noop(patch_run):
    meta = _meta()
    meta["mailagent.notionPageId"] = ""
    asyncio.run(island_response.handle_response(_resp("open_notion"), meta))
    assert patch_run == []


def test_mark_done_invokes_cli_with_processing_status_completed(patch_run, monkeypatch):
    monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "k_abc")
    asyncio.run(island_response.handle_response(_resp("mark_done"), _meta(123)))
    assert len(patch_run) == 1
    args = patch_run[0]["args"]
    assert args[:5] == ["mailagent", "notion", "update-flag", "123", "--processing-status"]
    assert args[5] == "已完成"
    assert "--api-key" in args and "k_abc" in args


def test_create_draft_invokes_cli(patch_run, monkeypatch):
    monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "k_xyz")
    asyncio.run(island_response.handle_response(_resp("create_draft"), _meta(7)))
    assert patch_run[0]["args"][:4] == ["mailagent", "email", "draft", "7"]


def test_snooze_1h_enqueues_island_snooze(patch_snooze, patch_run):
    asyncio.run(island_response.handle_response(_resp("snooze_1h"), _meta(42)))
    assert len(patch_snooze) == 1
    assert patch_snooze[0]["internal_id"] == 42
    assert patch_snooze[0]["duration_sec"] == 3600
    assert patch_snooze[0]["subject"] == "Test"
    # snooze 路径不应触发 subprocess
    assert patch_run == []


# ─────────────────────────────────────────────────────────────────────────────
# Phase 2: mark_done aliases (5 个 → 都进 _mark_done 但 log intent 不同)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("choice", [
    "archive_only",
    "archive_and_unsubscribe",
    "mark_done_no_response",
    "convert_to_notion_task",
    "escalate_to_oncall",
])
def test_mark_done_alias_invokes_update_flag(choice, patch_run):
    asyncio.run(island_response.handle_response(_resp(choice), _meta(53675)))
    assert len(patch_run) == 1
    args = patch_run[0]["args"]
    assert args[:5] == [
        "mailagent", "notion", "update-flag", "53675", "--processing-status",
    ]
    assert args[5] == "已完成"


def test_archive_and_unsubscribe_logs_todo(patch_run, caplog):
    with caplog.at_level(logging.INFO, logger="src.notify.island_response"):
        asyncio.run(island_response.handle_response(
            _resp("archive_and_unsubscribe"), _meta(123),
        ))
    msgs = [r.message for r in caplog.records]
    assert any("archive_and_unsubscribe" in m and "TODO" in m for m in msgs)


def test_escalate_to_oncall_logs_todo(patch_run, caplog):
    with caplog.at_level(logging.INFO, logger="src.notify.island_response"):
        asyncio.run(island_response.handle_response(
            _resp("escalate_to_oncall"), _meta(99),
        ))
    msgs = [r.message for r in caplog.records]
    assert any("escalate_to_oncall" in m and "TODO" in m for m in msgs)


def test_convert_to_notion_task_logs_todo(patch_run, caplog):
    with caplog.at_level(logging.INFO, logger="src.notify.island_response"):
        asyncio.run(island_response.handle_response(
            _resp("convert_to_notion_task"), _meta(55),
        ))
    msgs = [r.message for r in caplog.records]
    assert any("convert_to_notion_task" in m and "TODO" in m for m in msgs)


# ─────────────────────────────────────────────────────────────────────────────
# Phase 2: create_draft aliases (4 个 → 都进 _create_draft)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("choice", [
    "decline_with_reason",
    "quick_reply_yes",
    "quick_reply_no_with_reason",
    "nudge_recipient",
])
def test_create_draft_alias_invokes_email_draft(choice, patch_run):
    asyncio.run(island_response.handle_response(_resp(choice), _meta(7)))
    assert len(patch_run) == 1
    args = patch_run[0]["args"]
    assert args[:4] == ["mailagent", "email", "draft", "7"]


# ─────────────────────────────────────────────────────────────────────────────
# Phase 2: 独立路径 (add_to_calendar / defer / ack_in_pagerduty)
# ─────────────────────────────────────────────────────────────────────────────


def test_add_to_calendar_opens_calendar_app(patch_run, monkeypatch):
    monkeypatch.setattr(island_response.Path, "exists", lambda self: True)
    monkeypatch.setattr(island_response.shutil, "which", lambda _: "/usr/bin/open")
    asyncio.run(island_response.handle_response(_resp("add_to_calendar"), _meta()))
    assert len(patch_run) == 1
    assert patch_run[0]["args"] == ["open", "-a", "Calendar"]


def test_add_to_calendar_skips_when_app_missing(patch_run, monkeypatch):
    monkeypatch.setattr(island_response.Path, "exists", lambda self: False)
    asyncio.run(island_response.handle_response(_resp("add_to_calendar"), _meta()))
    assert patch_run == []


def test_defer_to_monday_9am_enqueues_snooze(patch_snooze, patch_run):
    asyncio.run(island_response.handle_response(_resp("defer_to_monday_9am"), _meta(77)))
    assert len(patch_snooze) == 1
    assert patch_snooze[0]["internal_id"] == 77
    # 实际 duration 取决于当前时间; 仅断言 > 60 (至少 1min) 且 < 7d + 9h (绝对上限)
    assert 60 <= patch_snooze[0]["duration_sec"] <= 7 * 24 * 3600 + 9 * 3600


def test_ack_in_pagerduty_opens_url_when_present(patch_run):
    meta = _meta()
    meta["mailagent.pagerdutyIncidentUrl"] = "https://acme.pagerduty.com/incidents/P123"
    asyncio.run(island_response.handle_response(_resp("ack_in_pagerduty"), meta))
    assert len(patch_run) == 1
    assert patch_run[0]["args"] == ["open", "https://acme.pagerduty.com/incidents/P123"]


def test_ack_in_pagerduty_falls_back_to_open_mail_when_no_url(patch_run):
    """无 incident URL → 退化为 open_mail 路径 (osascript)."""
    asyncio.run(island_response.handle_response(_resp("ack_in_pagerduty"), _meta()))
    assert len(patch_run) == 1
    assert patch_run[0]["args"][0] == "osascript"


def test_ack_in_pagerduty_rejects_non_http_url(patch_run):
    """envelope.metadata 的 URL 不是 http/https → 不直接 open, 退化 open_mail
    (防 javascript: / file:// 等 scheme attack)."""
    meta = _meta()
    meta["mailagent.pagerdutyIncidentUrl"] = "javascript:alert('xss')"
    asyncio.run(island_response.handle_response(_resp("ack_in_pagerduty"), meta))
    # 应退到 open_mail
    assert patch_run[0]["args"][0] == "osascript"


# ─────────────────────────────────────────────────────────────────────────────
# 防御性 dispatch (未知 / 异常 input)
# ─────────────────────────────────────────────────────────────────────────────


def test_unknown_choice_is_noop_and_logs_warning(patch_run, caplog):
    with caplog.at_level(logging.WARNING, logger="src.notify.island_response"):
        asyncio.run(island_response.handle_response(
            _resp("delete_email_forever"), _meta(1),
        ))
    assert patch_run == []
    msgs = [r.message for r in caplog.records]
    assert any("unknown choice" in m.lower() for m in msgs)


def test_invalid_internal_id_returns_early(patch_run):
    meta = _meta()
    meta["mailagent.internalId"] = "not-a-number"
    asyncio.run(island_response.handle_response(_resp("mark_done"), meta))
    assert patch_run == []


def test_missing_decision_is_noop(patch_run):
    asyncio.run(island_response.handle_response({}, _meta()))
    asyncio.run(island_response.handle_response({"decision": "wrong-shape"}, _meta()))
    asyncio.run(island_response.handle_response({"decision": {"answer": None}}, _meta()))
    assert patch_run == []


def test_answer_as_str_is_accepted(patch_run):
    """``decision.answer`` 是 str 而非 dict (老 plugin / 测试 envelope shape) → 仍 dispatch."""
    asyncio.run(island_response.handle_response(
        {"decision": {"answer": "mark_done"}}, _meta(42),
    ))
    assert len(patch_run) == 1
    assert patch_run[0]["args"][3] == "42"


# ─────────────────────────────────────────────────────────────────────────────
# _seconds_until_next_monday_9am 单元
# ─────────────────────────────────────────────────────────────────────────────


def test_seconds_until_next_monday_weekday_before_9am():
    # 周二 早 8:00 → 推到当天 9:00 (1h)
    tue_8am = datetime(2026, 5, 26, 8, 0, 0)  # Tue
    sec = island_response._seconds_until_next_monday_9am(now=tue_8am)
    assert sec == 3600


def test_seconds_until_next_monday_weekday_after_9am():
    # 周二 下午 14:00 → 推到下周一 9:00
    tue_2pm = datetime(2026, 5, 26, 14, 0, 0)  # Tue
    sec = island_response._seconds_until_next_monday_9am(now=tue_2pm)
    # 周二 14:00 → 下周一 9:00 = 6 天 - 5h = 5*24h + 19h
    expected = (5 * 24 + 19) * 3600
    assert sec == expected


def test_seconds_until_next_monday_friday_evening():
    # 周五 晚 18:00 → 下周一 9:00 = 2 天 + 15h
    fri_6pm = datetime(2026, 5, 29, 18, 0, 0)  # Fri
    sec = island_response._seconds_until_next_monday_9am(now=fri_6pm)
    expected = (2 * 24 + 15) * 3600
    assert sec == expected


def test_seconds_until_next_monday_saturday():
    # 周六 任意时间 → 下周一 9:00
    sat_10am = datetime(2026, 5, 30, 10, 0, 0)  # Sat
    sec = island_response._seconds_until_next_monday_9am(now=sat_10am)
    expected = (1 * 24 + 23) * 3600  # 47h
    assert sec == expected


def test_seconds_until_next_monday_monday_before_9am():
    # 周一 早 8:00 → 推到当天 9:00 (1h)
    mon_8am = datetime(2026, 5, 25, 8, 0, 0)  # Mon
    sec = island_response._seconds_until_next_monday_9am(now=mon_8am)
    assert sec == 3600


def test_seconds_until_next_monday_monday_after_9am():
    # 周一 下午 14:00 → 推到下周一 9:00 (7 天 - 5h = 6 天 + 19h)
    mon_2pm = datetime(2026, 5, 25, 14, 0, 0)  # Mon
    sec = island_response._seconds_until_next_monday_9am(now=mon_2pm)
    expected = (6 * 24 + 19) * 3600
    assert sec == expected


# ─────────────────────────────────────────────────────────────────────────────
# _enqueue_snooze duration guard
# ─────────────────────────────────────────────────────────────────────────────


def test_enqueue_snooze_negative_duration_clamped_to_60(patch_snooze):
    island_response._enqueue_snooze(1, -100, _meta())
    assert patch_snooze[0]["duration_sec"] == 60


def test_enqueue_snooze_zero_duration_clamped_to_60(patch_snooze):
    island_response._enqueue_snooze(1, 0, _meta())
    assert patch_snooze[0]["duration_sec"] == 60


def test_enqueue_snooze_normal_duration_passes_through(patch_snooze):
    island_response._enqueue_snooze(1, 3600, _meta())
    assert patch_snooze[0]["duration_sec"] == 3600
