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
    """抓 island_response._run 的入参; 不真跑 subprocess.

    默认 delenv MAILAGENT_CLI_API_KEY — 防 .env / shell 真值污染 argv 断言.
    需要测带 key 的用例 (api-key 前置) 自己 setenv 覆盖.
    """
    monkeypatch.delenv("MAILAGENT_CLI_API_KEY", raising=False)
    # F6 — 默认 gate off, open_* 走系统 app fallback; gate-on 测试自己 setenv
    monkeypatch.delenv("MAILAGENT_FRONTEND_DEEPLINK_ENABLED", raising=False)
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


# F6 — gate on (MAILAGENT_FRONTEND_DEEPLINK_ENABLED=true): open 类打开前端 deeplink


def test_open_mail_deeplink_when_frontend_enabled(patch_run, monkeypatch):
    """gate on → open_mail 打开前端 mailagent://email/<id> 而非系统 Mail.app."""
    monkeypatch.setenv("MAILAGENT_FRONTEND_DEEPLINK_ENABLED", "true")
    asyncio.run(island_response.handle_response(_resp("open_mail"), _meta(53675)))
    assert len(patch_run) == 1
    assert patch_run[0]["args"] == ["open", "mailagent://email/53675"]


def test_open_notion_deeplink_when_frontend_enabled(patch_run, monkeypatch):
    """gate on → open_notion 也进前端邮件视图 (前端是统一邮件入口, 不跳 Notion)."""
    monkeypatch.setenv("MAILAGENT_FRONTEND_DEEPLINK_ENABLED", "true")
    asyncio.run(island_response.handle_response(_resp("open_notion"), _meta(42)))
    assert len(patch_run) == 1
    assert patch_run[0]["args"] == ["open", "mailagent://email/42"]


def test_mark_done_invokes_cli_with_processing_status_completed(patch_run, monkeypatch):
    monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "k_abc")
    asyncio.run(island_response.handle_response(_resp("mark_done"), _meta(123)))
    assert len(patch_run) == 1
    # --api-key 前置 (global flag 在 subcommand "notion" 之前) — 防回归 Phase 1 后置 bug
    assert patch_run[0]["args"] == [
        "mailagent", "--api-key", "k_abc",
        "notion", "update-flag", "123", "--processing-status", "已完成",
    ]


def test_create_draft_invokes_cli(patch_run, monkeypatch):
    monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "k_xyz")
    asyncio.run(island_response.handle_response(_resp("create_draft"), _meta(7)))
    # --api-key 前置 subcommand "email"
    assert patch_run[0]["args"] == [
        "mailagent", "--api-key", "k_xyz", "email", "draft", "7",
    ]


def test_mailagent_args_api_key_is_leading(monkeypatch):
    """global --api-key 必须前置 subcommand (typer root callback flag).

    防回归 Phase 1 bug: 后置 --api-key 被 typer 拒 "No such option" → 用户设了
    CLI key 时所有 mark_done / create_draft handler silent fail.
    """
    monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "secret")
    args = island_response._mailagent_args("email", "draft", "7")
    assert args == ["mailagent", "--api-key", "secret", "email", "draft", "7"]
    # --api-key 必须在第一个 subcommand token 之前
    assert args.index("--api-key") < args.index("email")


def test_mailagent_args_no_key_omits_flag(monkeypatch):
    monkeypatch.delenv("MAILAGENT_CLI_API_KEY", raising=False)
    args = island_response._mailagent_args("notion", "update-flag", "1")
    assert args == ["mailagent", "notion", "update-flag", "1"]
    assert "--api-key" not in args


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
    "mark_done_no_response",
])
def test_mark_done_alias_invokes_update_flag(choice, patch_run):
    asyncio.run(island_response.handle_response(_resp(choice), _meta(53675)))
    assert len(patch_run) == 1
    args = patch_run[0]["args"]
    assert args[:5] == [
        "mailagent", "notion", "update-flag", "53675", "--processing-status",
    ]
    assert args[5] == "已完成"


def test_archive_and_unsubscribe_invokes_unsubscribe_cli(patch_run):
    """F2: archive_and_unsubscribe 走独立分支调 mailagent email unsubscribe CLI
    (不再是 mark_done alias — CLI 内部解析 List-Unsubscribe header 真退订 + mark 完成)."""
    asyncio.run(island_response.handle_response(
        _resp("archive_and_unsubscribe"), _meta(123),
    ))
    assert len(patch_run) == 1
    args = patch_run[0]["args"]
    # 无 api-key 时 ["mailagent", "email", "unsubscribe", "123"]
    assert args == ["mailagent", "email", "unsubscribe", "123"]


def test_archive_and_unsubscribe_api_key_leading(patch_run, monkeypatch):
    """unsubscribe 也走 _mailagent_args → --api-key 前置 subcommand."""
    monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "k_unsub")
    asyncio.run(island_response.handle_response(
        _resp("archive_and_unsubscribe"), _meta(123),
    ))
    args = patch_run[0]["args"]
    assert args == [
        "mailagent", "--api-key", "k_unsub", "email", "unsubscribe", "123",
    ]


def test_escalate_to_oncall_now_whitelist_miss(patch_run, caplog):
    """escalate_to_oncall 2026-05-26 下线 → handle_response 入口 whitelist miss,
    不触发任何 subprocess (旧 envelope 含它时安全拒绝)."""
    with caplog.at_level(logging.WARNING, logger="src.notify.island_response"):
        asyncio.run(island_response.handle_response(
            _resp("escalate_to_oncall"), _meta(99),
        ))
    assert patch_run == []
    msgs = [r.message.lower() for r in caplog.records]
    assert any("unknown choice" in m for m in msgs)


def test_convert_to_notion_task_invokes_create_task_cli(patch_run):
    """F3: convert_to_notion_task 走独立分支调 mailagent notion create-task CLI
    (不再是 mark_done alias)."""
    asyncio.run(island_response.handle_response(
        _resp("convert_to_notion_task"), _meta(55),
    ))
    assert len(patch_run) == 1
    args = patch_run[0]["args"]
    # 无 api-key 时 ["mailagent", "notion", "create-task", "55"]
    assert args == ["mailagent", "notion", "create-task", "55"]


def test_convert_to_notion_task_api_key_leading(patch_run, monkeypatch):
    """create-task 也走 _mailagent_args → --api-key 前置."""
    monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "k_conv")
    asyncio.run(island_response.handle_response(
        _resp("convert_to_notion_task"), _meta(55),
    ))
    args = patch_run[0]["args"]
    assert args == ["mailagent", "--api-key", "k_conv", "notion", "create-task", "55"]


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
# Phase 2: 独立路径 (add_to_calendar / defer_to_monday_9am)
# ─────────────────────────────────────────────────────────────────────────────


def test_add_to_calendar_invokes_create_task_as_meeting(patch_run):
    """F5: add_to_calendar 改调 create-task --as-meeting (LLM 抽会议时间真建日程),
    不再 open Calendar.app."""
    asyncio.run(island_response.handle_response(_resp("add_to_calendar"), _meta(77)))
    assert len(patch_run) == 1
    args = patch_run[0]["args"]
    assert args == ["mailagent", "notion", "create-task", "77", "--as-meeting"]


def test_add_to_calendar_api_key_leading(patch_run, monkeypatch):
    monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "k_cal")
    asyncio.run(island_response.handle_response(_resp("add_to_calendar"), _meta(77)))
    args = patch_run[0]["args"]
    assert args == [
        "mailagent", "--api-key", "k_cal",
        "notion", "create-task", "77", "--as-meeting",
    ]


def test_defer_to_monday_9am_enqueues_snooze(patch_snooze, patch_run):
    asyncio.run(island_response.handle_response(_resp("defer_to_monday_9am"), _meta(77)))
    assert len(patch_snooze) == 1
    assert patch_snooze[0]["internal_id"] == 77
    # 实际 duration 取决于当前时间; 仅断言 > 60 (至少 1min) 且 < 7d + 9h (绝对上限)
    assert 60 <= patch_snooze[0]["duration_sec"] <= 7 * 24 * 3600 + 9 * 3600


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
# Phase 3 DailyDigest bulk handler (_parse_digest_ids + _run_bulk)
# ─────────────────────────────────────────────────────────────────────────────


def _digest_meta(choice: str, ids_csv: str) -> Dict[str, str]:
    """digest envelope metadata: 无 mailagent.internalId, ids 走 digestBulk 命名空间。"""
    return {
        "mailagent.scenario": "DailyDigest",
        "mailagent.digestDate": "20260526",
        f"mailagent.digestBulk.{choice}.ids": ids_csv,
    }


def test_parse_digest_ids_basic():
    meta = _digest_meta("bulk_mark_read", "101,102,103")
    assert island_response._parse_digest_ids(meta, "bulk_mark_read") == [101, 102, 103]


def test_parse_digest_ids_skips_invalid_and_dedups():
    meta = _digest_meta("bulk_mark_read", "101, foo, 102, 101, , 103")
    assert island_response._parse_digest_ids(meta, "bulk_mark_read") == [101, 102, 103]


def test_parse_digest_ids_missing_key_empty():
    assert island_response._parse_digest_ids({}, "bulk_mark_read") == []


def test_parse_digest_ids_caps_at_30():
    ids = ",".join(str(i) for i in range(1, 50))  # 49
    meta = _digest_meta("bulk_archive_newsletter", ids)
    out = island_response._parse_digest_ids(meta, "bulk_archive_newsletter")
    assert len(out) == 30
    assert out == list(range(1, 31))


def test_bulk_mark_read_loops_update_flag_is_read(patch_run):
    """bulk_mark_read → 每封 notion update-flag --is-read true (循环单封 CLI)。"""
    meta = _digest_meta("bulk_mark_read", "10,11,12")
    asyncio.run(island_response.handle_response(_resp("bulk_mark_read"), meta))
    assert len(patch_run) == 3
    for i, iid in enumerate(["10", "11", "12"]):
        args = patch_run[i]["args"]
        assert args == ["mailagent", "notion", "update-flag", iid, "--is-read", "true"]


@pytest.mark.parametrize("choice", ["bulk_archive_newsletter", "bulk_mark_done"])
def test_bulk_mark_done_aliases_loop_update_flag_completed(choice, patch_run):
    """bulk_archive_newsletter / bulk_mark_done → 每封 update-flag --processing-status 已完成。"""
    meta = _digest_meta(choice, "20,21")
    asyncio.run(island_response.handle_response(_resp(choice), meta))
    assert len(patch_run) == 2
    for i, iid in enumerate(["20", "21"]):
        args = patch_run[i]["args"]
        assert args == [
            "mailagent", "notion", "update-flag", iid, "--processing-status", "已完成",
        ]


def test_bulk_api_key_leading(patch_run, monkeypatch):
    """bulk 也走 _mailagent_args → --api-key 前置 subcommand。"""
    monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "k_bulk")
    meta = _digest_meta("bulk_mark_read", "5")
    asyncio.run(island_response.handle_response(_resp("bulk_mark_read"), meta))
    assert patch_run[0]["args"] == [
        "mailagent", "--api-key", "k_bulk", "notion", "update-flag", "5",
        "--is-read", "true",
    ]


def test_bulk_empty_ids_is_noop(patch_run):
    """空 ids → 不调任何 subprocess。"""
    meta = _digest_meta("bulk_mark_read", "")
    asyncio.run(island_response.handle_response(_resp("bulk_mark_read"), meta))
    assert patch_run == []


def test_bulk_does_not_require_internal_id(patch_run):
    """digest envelope 无 mailagent.internalId 也能跑 (bulk 分支在 internalId gate 之前)。"""
    meta = _digest_meta("bulk_mark_read", "9")
    assert "mailagent.internalId" not in meta
    asyncio.run(island_response.handle_response(_resp("bulk_mark_read"), meta))
    assert len(patch_run) == 1


def test_bulk_invalid_ids_skipped_others_run(patch_run):
    """非法 id 跳过, 合法 id 仍各跑一次 CLI。"""
    meta = _digest_meta("bulk_mark_read", "30, bad, 31")
    asyncio.run(island_response.handle_response(_resp("bulk_mark_read"), meta))
    assert len(patch_run) == 2
    assert patch_run[0]["args"][3] == "30"
    assert patch_run[1]["args"][3] == "31"


def test_run_bulk_rejects_non_bulk_choice(patch_run):
    """_run_bulk 二次校验: 非 bulk choice 直接 return 不跑。"""
    asyncio.run(island_response._run_bulk("mark_done", [1, 2, 3]))
    assert patch_run == []


# ─────────────────────────────────────────────────────────────────────────────
# 问题 B — "跳过" 次级 action (纯 dismiss, no-op)
# ─────────────────────────────────────────────────────────────────────────────


def test_skip_choice_is_noop(patch_run):
    """choice=skip → 不调任何 CLI / osascript (纯 dismiss)。"""
    asyncio.run(island_response.handle_response(_resp("skip"), _meta()))
    assert patch_run == []


def test_skip_choice_noop_without_internal_id(patch_run):
    """skip envelope (如 digest) 没有 mailagent.internalId 也 no-op, 不报 invalid。"""
    meta = {"mailagent.accountName": "Exchange"}  # 无 internalId
    asyncio.run(island_response.handle_response(_resp("skip"), meta))
    assert patch_run == []


def test_skip_choice_does_not_enqueue_snooze(patch_run, patch_snooze):
    """skip 不入 snooze 队列 (区别于 snooze_1h)。"""
    asyncio.run(island_response.handle_response(_resp("skip"), _meta()))
    assert patch_run == []
    assert patch_snooze == []


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
