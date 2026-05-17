"""``BridgeResponse.decision.answer.choice`` 5 选 1 dispatch.

来源：``frontend/ISLAND-PLUGIN.md`` §3.4 + REVIEW-LOG H-12 / M-13.

实现注意：
- ``open_mail`` —— AppleScript **必须** 用 ``first message of mailbox X of account Y whose id is N`` 路径，
  不能简化为 ``open message id N``（顶层语法无效）
- ``open_notion`` —— 桌面版 Notion.app 装了就 ``notion://``，没装 fallback ``https://www.notion.so/``；
  page_id 用 dashless 32-hex 拼 URL（envelope 里是 dashed UUID，这里 ``replace('-', '')``）
- ``create_draft`` —— 调 ``mailagent email draft`` CLI（API key 从 env 取）
- ``snooze_1h`` —— 入 ``island_snooze`` 队列（envelope metadata 提供 page_id / mailbox / subject）
- ``mark_done`` —— 调 ``mailagent notion update-flag`` CLI
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
from pathlib import Path
from typing import Any, Dict, Optional

from src.notify import island_snooze

log = logging.getLogger(__name__)


async def handle_response(response: Dict[str, Any], envelope_meta: Dict[str, str]) -> None:
    """``ping_island`` 收到的 BridgeResponse 解析 + 派发；fail-open."""
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

    internal_id_str = envelope_meta.get("mailagent.internalId", "")
    try:
        internal_id = int(internal_id_str)
    except (TypeError, ValueError):
        log.warning("[island-response] invalid internalId metadata: %r", internal_id_str)
        return

    log.info("[island-response] choice=%s internal_id=%d", choice, internal_id)

    try:
        if choice == "open_mail":
            await _open_mail(internal_id, envelope_meta)
        elif choice == "open_notion":
            await _open_notion(envelope_meta)
        elif choice == "create_draft":
            await _create_draft(internal_id)
        elif choice == "snooze_1h":
            island_snooze.add(
                internal_id=internal_id,
                duration_sec=3600,
                mailbox=envelope_meta.get("mailagent.mailbox", ""),
                subject=envelope_meta.get("mailagent.subject", ""),
                sender=envelope_meta.get("mailagent.sender", ""),
                sender_name=envelope_meta.get("mailagent.senderName", ""),
                page_id=envelope_meta.get("mailagent.notionPageId", ""),
                ai_action=envelope_meta.get("mailagent.aiAction", ""),
                ai_priority=envelope_meta.get("mailagent.aiPriority", ""),
            )
        elif choice == "mark_done":
            await _mark_done(internal_id)
        else:
            log.warning("[island-response] unknown choice: %s", choice)
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


async def _run(args, *, timeout: float = 10) -> None:
    """fire-and-forget subprocess；不抛 (fail-open)."""
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
