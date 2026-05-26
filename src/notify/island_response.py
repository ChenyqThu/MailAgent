"""``BridgeResponse.decision.answer.choice`` 17 action dispatch.

来源：``frontend/ISLAND-PLUGIN.md`` §3.4 + REVIEW-LOG H-12 / M-13 (Phase 1 static 5) +
``docs/plans/ultrathink-session-curious-cloud.md`` §5.2 (Phase 2 dynamic 12).

Action 全集 17 = ``island_action_whitelist.KNOWN_ACTION_IDS``:

  Phase 1 静态 5 (fallback when LLM 不出 recommended_actions):
    open_mail / open_notion / create_draft / mark_done / snooze_1h

  Phase 2 LLM dynamic 12 (10 inbox + 2 sent):
    archive_and_unsubscribe / archive_only
    add_to_calendar / decline_with_reason
    defer_to_monday_9am / convert_to_notion_task
    ack_in_pagerduty / escalate_to_oncall
    quick_reply_yes / quick_reply_no_with_reason
    mark_done_no_response / nudge_recipient

实现注意：
- ``open_mail`` —— AppleScript **必须** 用 ``first message of mailbox X of account Y whose id is N`` 路径
  (H-12)，不能简化为 ``open message id N`` 顶层语法
- ``open_notion`` —— 桌面版 Notion.app 装了就 ``notion://``，否则 fallback ``https://www.notion.so/``；
  page_id 用 dashless 32-hex 拼 URL（envelope 是 dashed UUID, 这里 ``replace('-', '')``）
- ``create_draft`` / Phase 2 reply aliases —— 调 ``mailagent email draft`` CLI (API key 从 env 取)
- ``mark_done`` / Phase 2 archive aliases —— 调 ``mailagent notion update-flag`` CLI
- ``snooze_1h`` / ``defer_to_monday_9am`` —— 入 ``island_snooze`` 队列, dispatch 到期 re-emit envelope
- ``add_to_calendar`` —— ``osascript`` 拉起 Calendar.app, 由用户手动加 (envelope 未携带 .ics 完整体)
- ``ack_in_pagerduty`` —— envelope.metadata.pagerdutyIncidentUrl 存在 → ``open`` URL, 否则 fallback open_mail
- 业务复杂 / 待 Phase 3 接 (``convert_to_notion_task`` / ``escalate_to_oncall``) —— 先 mark_done 标完成
  + 写 log TODO 留 trace, 业务层 Phase 3 扩 CLI 再升级

Defense in depth: 未知 choice → ``log.warning`` 并 return, 不调任何 subprocess.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, Optional

from src.notify import island_snooze
from src.notify.island_action_whitelist import is_known_action_id

log = logging.getLogger(__name__)


# Phase 2 alias group: 这些 action id 业务上都是 "标完成 + 移除 Mail.app 旗标 + 不再
# 提醒" 一类, 调 mailagent notion update-flag --processing-status 已完成. 各自附加
# log 区分意图 (archive_and_unsubscribe → user 想退订, 业务 follow-up Phase 3 可加
# unsubscribe URL 抽取; escalate_to_oncall → user 升级了 oncall, 业务 Phase 3 可加
# PagerDuty / 飞书通知派发).
_MARK_DONE_ALIASES = frozenset({
    "mark_done",                # Phase 1 静态
    "archive_only",             # Phase 2: FYI / 已读完不再提醒
    "archive_and_unsubscribe",  # Phase 2: newsletter 归档并退订
    "mark_done_no_response",    # Phase 2 发件箱: 已等够久 + 不再追
    "convert_to_notion_task",   # Phase 2: TODO Phase 3 接 Notion task API
    "escalate_to_oncall",       # Phase 2: TODO Phase 3 接 oncall page
})

# Phase 2 alias group: 这些 action id 都是 "起一封回复草稿" 一类, 调 mailagent email
# draft CLI. (TODO: draft CLI 暂未实现; Phase 1 _create_draft 已假设其存在, Phase 2
# 沿用同口径, 实际命令 ship 见 T2.4 跟进.)
_CREATE_DRAFT_ALIASES = frozenset({
    "create_draft",             # Phase 1 静态
    "decline_with_reason",      # Phase 2: 婉拒会议
    "quick_reply_yes",          # Phase 2: 快速 Y
    "quick_reply_no_with_reason",  # Phase 2: 快速 N + 理由
    "nudge_recipient",          # Phase 2 发件箱: 催办
})


async def handle_response(response: Dict[str, Any], envelope_meta: Dict[str, str]) -> None:
    """``ping_island`` 收到的 BridgeResponse 解析 + 派发；任何 handler 失败仅 log 不 raise."""
    decision = response.get("decision") if isinstance(response, dict) else None
    if not isinstance(decision, dict):
        return
    answer = decision.get("answer")
    choice: Optional[str] = None
    if isinstance(answer, dict):
        choice = answer.get("choice") or answer.get("optionId") or answer.get("id")
    elif isinstance(answer, str):
        choice = answer
    if not isinstance(choice, str) or not choice:
        return

    if not is_known_action_id(choice):
        log.warning("[island-response] unknown choice (whitelist miss): %s", choice)
        return

    internal_id_str = envelope_meta.get("mailagent.internalId", "")
    try:
        internal_id = int(internal_id_str)
    except (TypeError, ValueError):
        log.warning("[island-response] invalid internalId metadata: %r", internal_id_str)
        return

    log.info("[island-response] choice=%s internal_id=%d", choice, internal_id)

    try:
        # --- Phase 1 静态 5 (open / snooze 类独立路径) ---
        if choice == "open_mail":
            await _open_mail(internal_id, envelope_meta)
        elif choice == "open_notion":
            await _open_notion(envelope_meta)
        elif choice == "snooze_1h":
            _enqueue_snooze(internal_id, 3600, envelope_meta)
        # --- Phase 2 独立路径 (snooze / open URL / Calendar) ---
        elif choice == "defer_to_monday_9am":
            _enqueue_snooze(
                internal_id,
                _seconds_until_next_monday_9am(),
                envelope_meta,
            )
        elif choice == "add_to_calendar":
            await _add_to_calendar()
        elif choice == "ack_in_pagerduty":
            await _ack_in_pagerduty(internal_id, envelope_meta)
        # --- 路径 1: 标完成 (Phase 1 mark_done + Phase 2 5 个 alias) ---
        elif choice in _MARK_DONE_ALIASES:
            await _mark_done(internal_id)
            _log_alias_intent(choice, internal_id)
        # --- 路径 2: 起草 (Phase 1 create_draft + Phase 2 4 个 alias) ---
        elif choice in _CREATE_DRAFT_ALIASES:
            await _create_draft(internal_id)
        else:
            # is_known_action_id 已 filter, 走到这里说明 KNOWN_ACTION_IDS 加了
            # action 但 dispatch table 没补. 别 silent 吞 — log 帮人修.
            log.warning(
                "[island-response] known choice %r has no dispatch branch; "
                "update _MARK_DONE_ALIASES / _CREATE_DRAFT_ALIASES / explicit branch",
                choice,
            )
    except Exception as e:  # noqa: BLE001
        log.warning("[island-response] dispatch failed for %s: %s", choice, e)


# ─────────────────────────────────────────────────────────────────────────────
# Individual handlers
# ─────────────────────────────────────────────────────────────────────────────


async def _open_mail(internal_id: int, meta: Dict[str, str]) -> None:
    account_name = meta.get("mailagent.accountName", "")
    mailbox_name = meta.get("mailagent.mailboxName") or meta.get("mailagent.mailbox") or "收件箱"
    if not account_name:
        log.warning("[island-response] open_mail missing accountName; aborting")
        return

    # H-12: 必须用 `first message of mailbox of account whose id is <int>` 语法
    script = (
        'tell application "Mail"\n'
        '  activate\n'
        f'  set targetAccount to first account whose name is "{_escape(account_name)}"\n'
        f'  set targetMailbox to first mailbox of targetAccount whose name is "{_escape(mailbox_name)}"\n'
        f'  set m to first message of targetMailbox whose id is {int(internal_id)}\n'
        '  open m\n'
        'end tell\n'
    )
    await _run(["osascript", "-e", script], timeout=8)


async def _open_notion(meta: Dict[str, str]) -> None:
    page_id_dashed = meta.get("mailagent.notionPageId", "").strip()
    if not page_id_dashed:
        log.debug("[island-response] open_notion no page_id; skipping")
        return
    page_id_flat = page_id_dashed.replace("-", "")
    # M-13: 桌面版 fallback Web URL
    use_app = Path("/Applications/Notion.app").exists() and bool(shutil.which("open"))
    url = (
        f"notion://www.notion.so/{page_id_flat}"
        if use_app
        else f"https://www.notion.so/{page_id_flat}"
    )
    await _run(["open", url], timeout=5)


async def _create_draft(internal_id: int) -> None:
    api_key = os.environ.get("MAILAGENT_CLI_API_KEY", "")
    args = ["mailagent", "email", "draft", str(internal_id)]
    if api_key:
        args.extend(["--api-key", api_key])
    await _run(args, timeout=30)


async def _mark_done(internal_id: int) -> None:
    api_key = os.environ.get("MAILAGENT_CLI_API_KEY", "")
    args = [
        "mailagent", "notion", "update-flag", str(internal_id),
        "--processing-status", "已完成",
    ]
    if api_key:
        args.extend(["--api-key", api_key])
    await _run(args, timeout=30)


async def _add_to_calendar() -> None:
    """Phase 2: 拉起 Calendar.app 让用户手动加 (envelope 未含完整 .ics).

    业务跟进 (Phase 3): 真做 .ics 抽取 + ``mailagent calendar create`` CLI 直接建事件,
    无需用户额外操作.
    """
    use_app = Path("/Applications/Calendar.app").exists() and bool(shutil.which("open"))
    if not use_app:
        log.warning("[island-response] add_to_calendar: Calendar.app missing; aborting")
        return
    await _run(["open", "-a", "Calendar"], timeout=5)


async def _ack_in_pagerduty(internal_id: int, meta: Dict[str, str]) -> None:
    """envelope.metadata.pagerdutyIncidentUrl 存在 → ``open`` 跳转; 否则降级 _open_mail.

    业务跟进 (Phase 3): mail-sync 端在 LLM classify 时把 PagerDuty alert 邮件的 incident
    URL 抽出来塞 envelope.metadata.mailagent.pagerdutyIncidentUrl, 这里直接 open.
    """
    url = meta.get("mailagent.pagerdutyIncidentUrl", "").strip()
    if url and url.startswith(("http://", "https://")):
        await _run(["open", url], timeout=5)
        return
    log.info(
        "[island-response] ack_in_pagerduty: no incident URL in envelope; opening mail %d",
        internal_id,
    )
    await _open_mail(internal_id, meta)


def _enqueue_snooze(internal_id: int, duration_sec: int, meta: Dict[str, str]) -> None:
    """统一 snooze 入队 (snooze_1h 1h vs defer_to_monday_9am 算到下周一 9AM 的 seconds).

    duration_sec ≤ 0 时按 60s 兜底 (避免 island_snooze 入队负值乱序).
    """
    if duration_sec <= 0:
        duration_sec = 60
    island_snooze.add(
        internal_id=internal_id,
        duration_sec=duration_sec,
        mailbox=meta.get("mailagent.mailbox", ""),
        subject=meta.get("mailagent.subject", ""),
        sender=meta.get("mailagent.sender", ""),
        sender_name=meta.get("mailagent.senderName", ""),
        page_id=meta.get("mailagent.notionPageId", ""),
        ai_action=meta.get("mailagent.aiAction", ""),
        ai_priority=meta.get("mailagent.aiPriority", ""),
    )


def _seconds_until_next_monday_9am(*, now: Optional[datetime] = None) -> int:
    """计算到下一个工作日（周一）9:00 (本地时区) 的秒数.

    周一 ~ 周五的 上午 9:00 之前 → 推到当天 9:00 (不跨周末);
    周末或 ≥ 9:00 → 推到下周一 9:00. 算出 seconds 给 island_snooze.add.
    """
    n = now or datetime.now()
    # weekday(): Mon=0 ... Sun=6
    today_9am = n.replace(hour=9, minute=0, second=0, microsecond=0)
    if n.weekday() < 5 and n < today_9am:
        # 工作日早上 9 点之前 → 推到当天 9 点
        target = today_9am
    else:
        # 周末或 ≥ 9 点 → 推到下周一 9 点
        days_until_monday = (7 - n.weekday()) % 7
        if days_until_monday == 0:  # 今天就是周一但 ≥ 9 点
            days_until_monday = 7
        target = today_9am + timedelta(days=days_until_monday)
    delta = (target - n).total_seconds()
    return max(60, int(delta))


def _log_alias_intent(choice: str, internal_id: int) -> None:
    """Phase 2 alias 区分意图: 标完成路径共用 _mark_done 但用户的意图不同,
    log 一行让 ops 后期 grep / 做指标 / 业务迭代时知道哪条 follow-up 真做了."""
    if choice == "archive_and_unsubscribe":
        # TODO Phase 3: 抽 unsubscribe URL 自动 open (需先在 LLM context 加邮件正文头扫)
        log.info(
            "[island-response] archive_and_unsubscribe internal_id=%d "
            "(TODO Phase 3: auto-open unsubscribe URL from List-Unsubscribe header)",
            internal_id,
        )
    elif choice == "convert_to_notion_task":
        # TODO Phase 3: 调 Notion API 在用户的项目 backlog 库建 task page
        log.info(
            "[island-response] convert_to_notion_task internal_id=%d "
            "(TODO Phase 3: create Notion task in backlog DB)",
            internal_id,
        )
    elif choice == "escalate_to_oncall":
        # TODO Phase 3: 发飞书消息 / PagerDuty trigger 到 oncall channel
        log.info(
            "[island-response] escalate_to_oncall internal_id=%d "
            "(TODO Phase 3: page oncall via Feishu/PagerDuty)",
            internal_id,
        )


async def _run(args, *, timeout: float = 10) -> None:
    """fire-and-forget subprocess；不抛 (调用方需要灵动岛 click ack 即时返回)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            log.warning("[island-response] cmd timeout: %s", args[0])
            return
        if proc.returncode != 0:
            err = (stderr or b"").decode(errors="replace")[:200]
            log.warning("[island-response] %s rc=%s err=%s", args[0], proc.returncode, err)
    except FileNotFoundError:
        log.warning("[island-response] command not found: %s", args[0])
    except Exception as e:  # noqa: BLE001
        log.warning("[island-response] subprocess error %s: %s", args[0], e)


def _escape(text: str) -> str:
    """AppleScript 字符串字面量 escape."""
    return (text or "").replace("\\", "\\\\").replace('"', '\\"')


# Unused; intentional 占位 for tests' import sanity (确保此模块 Awaitable 类型可
# import). 不删: tests 端 `from src.notify import island_response as ir` 后引用.
_HandlerFn = Callable[[int, Dict[str, str]], Awaitable[None]]
