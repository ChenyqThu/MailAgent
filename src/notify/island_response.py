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
from typing import Any, Awaitable, Callable, Dict, Optional, Tuple

from src.mail.mailbox_semantics import INBOX_LABEL
from src.notify import island_snooze
from src.notify.island_action_whitelist import (
    SKIP_ACTION_ID,
    is_ai_draft_action_id,
    is_bulk_action_id,
    is_known_action_id,
)

log = logging.getLogger(__name__)


# Phase 2 alias group: 这些 action id 业务上都是 "标完成 + 移除 Mail.app 旗标 + 不再
# 提醒" 一类, 调 mailagent notion update-flag --processing-status 已完成. 各自附加
# log 区分意图 (archive_only → FYI 已读完不再提醒).
_MARK_DONE_ALIASES = frozenset({
    "mark_done",                # Phase 1 静态
    "archive_only",             # Phase 2: FYI / 已读完不再提醒
    "mark_done_no_response",    # Phase 2 发件箱: 已等够久 + 不再追
    # archive_and_unsubscribe F2 起走独立 _archive_and_unsubscribe 分支 (mailagent
    # email unsubscribe 解析 List-Unsubscribe header 真退订 + CLI 内部 mark 完成),
    # 不再是 mark_done alias.
    # convert_to_notion_task F3 起走独立 _convert_to_notion_task 分支 (LLM 决策 + 真建
    # 日程库 task, create-task CLI 内部 mark 邮件完成), 不再是 mark_done alias.
    # escalate_to_oncall 已下线 (2026-05-26, 见 schema.py) — 跟 whitelist 一致移除;
    # 旧 envelope 含它时 handle_response 入口 is_known_action_id 直接 whitelist miss.
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

    # --- "跳过" 次级 action (问题 B): 纯 dismiss, no-op ---
    # 必须在下方 internalId gate 之前: skip envelope (尤其 digest) 可能没有
    # mailagent.internalId, 不该被 gate 当 invalid 提前 return; 且 skip 不调任何业务 CLI。
    if choice == SKIP_ACTION_ID:
        log.info("[island-response] skip (dismiss, no-op)")
        return

    # --- Phase 3 DailyDigest bulk action (无单一 internalId, 走 metadata ids list) ---
    # 必须在下方 internalId gate 之前处理: digest envelope 没有 mailagent.internalId,
    # 否则会被 gate 当作 invalid 提前 return。
    if is_bulk_action_id(choice):
        ids = _parse_digest_ids(envelope_meta, choice)
        log.info("[island-response] bulk choice=%s ids=%d", choice, len(ids))
        try:
            await _run_bulk(choice, ids)
        except Exception as e:  # noqa: BLE001
            log.warning("[island-response] bulk dispatch failed for %s: %s", choice, e)
        return

    internal_id_str = envelope_meta.get("mailagent.internalId", "")
    try:
        internal_id = int(internal_id_str)
    except (TypeError, ValueError):
        log.warning("[island-response] invalid internalId metadata: %r", internal_id_str)
        return

    log.info("[island-response] choice=%s internal_id=%d", choice, internal_id)

    # P0-4: subprocess 跑完后回流 ActionAcked envelope 让 fork UI 反映真实结果。
    # ack_ok=None 表示该分支无 subprocess (snooze / AI draft stub), 不发 ack;
    # ack_ok=True/False 表示 subprocess 跑过, 发 ack。ack_err 是失败时的 stderr 截短。
    ack_ok: Optional[bool] = None
    ack_err: str = ""

    try:
        # --- Phase 1 静态 5 (open / snooze 类独立路径) ---
        if choice == "open_mail":
            ack_ok, ack_err = await _open_mail(internal_id, envelope_meta)
        elif choice == "open_notion":
            ack_ok, ack_err = await _open_notion(envelope_meta)
        elif choice == "snooze_1h":
            _enqueue_snooze(internal_id, 3600, envelope_meta)
            # snooze 路径不走 ack (P0-1 已追发 MailCompleted 清 fork dock)
        # --- Phase 2 独立路径 (snooze / open URL / Calendar) ---
        elif choice == "defer_to_monday_9am":
            _enqueue_snooze(
                internal_id,
                _seconds_until_next_monday_9am(),
                envelope_meta,
            )
        elif choice == "add_to_calendar":
            ack_ok, ack_err = await _add_to_calendar(internal_id)
        elif choice == "convert_to_notion_task":
            # F3: LLM 决策 + 代码写日程库 task (create-task CLI 内部已 mark 邮件完成)
            ack_ok, ack_err = await _convert_to_notion_task(internal_id)
        elif choice == "archive_and_unsubscribe":
            # F2: 解析 List-Unsubscribe header 真退订 (unsubscribe CLI 内部 mark 完成)
            ack_ok, ack_err = await _archive_and_unsubscribe(internal_id)
        # --- 路径 1: 标完成 (Phase 1 mark_done + Phase 2 alias) ---
        elif choice in _MARK_DONE_ALIASES:
            ack_ok, ack_err = await _mark_done(internal_id)
            _log_alias_intent(choice, internal_id)
        # --- 路径 2: 起草 (Phase 1 create_draft + Phase 2 4 个 alias) ---
        elif choice in _CREATE_DRAFT_ALIASES:
            ack_ok, ack_err = await _create_draft(internal_id)
        # --- P0-2: AIDraftReady 三 option (send/edit/discard) stub ---
        # 真实业务 (发送草稿 / 打开编辑器 / 丢弃) 由上游 LLM agent Phase 3+ 接管;
        # 当前 stub 仅记录用户决策让 ops 能 grep 看流量。
        elif is_ai_draft_action_id(choice):
            _handle_ai_draft_stub(choice, internal_id, envelope_meta)
        else:
            # is_known_action_id 已 filter, 走到这里说明 KNOWN_ACTION_IDS 加了
            # action 但 dispatch table 没补. 别 silent 吞 — log 帮人修.
            log.warning(
                "[island-response] known choice %r has no dispatch branch; "
                "update _MARK_DONE_ALIASES / _CREATE_DRAFT_ALIASES / explicit branch",
                choice,
            )
            ack_ok = False
            ack_err = f"no dispatch branch for {choice!r}"
    except Exception as e:  # noqa: BLE001
        log.warning("[island-response] dispatch failed for %s: %s", choice, e)
        ack_ok = False
        ack_err = str(e)[:200]

    # P0-4: 仅 subprocess-running 分支发 ack (snooze / AI draft stub 跳过)。
    # 任何 ack 异常仅 log 不破坏主路径。
    if ack_ok is not None:
        try:
            envelope_id = _extract_envelope_id(envelope_meta)
            from src.notify import island_dispatch
            island_dispatch.dispatch_action_acked(
                internal_id=internal_id,
                envelope_id=envelope_id,
                choice=choice,
                ok=ack_ok,
                error=ack_err,
            )
        except Exception as e:  # noqa: BLE001
            log.warning("[island-response] dispatch_action_acked failed: %s", e)


def _extract_envelope_id(meta: Dict[str, str]) -> str:
    """从 envelope_meta 取触发 button click 的原 envelope id。

    fork 端 wire 时 metadata["tool_use_id"] 形如 ``"bridge-<uuid>"`` (见
    ``island_envelope.py:to_wire_dict`` 注释); 这里剥前缀返 uuid。无 tool_use_id 时
    返 ""。
    """
    tool_use_id = meta.get("tool_use_id", "") or ""
    if tool_use_id.startswith("bridge-"):
        return tool_use_id[len("bridge-"):]
    return tool_use_id


# ─────────────────────────────────────────────────────────────────────────────
# Individual handlers
# ─────────────────────────────────────────────────────────────────────────────


# F6 — open 类 action 优先打开 MailAgent 前端 (Electron) 而非系统 app.
# gate on (MAILAGENT_FRONTEND_DEEPLINK_ENABLED=true) + 前端注册了 mailagent:// scheme
# 时, open mailagent://email/<id> 唤起前端聚焦该邮件; gate off / 前端没装走系统 app
# fallback (现状). 前端是统一邮件入口, open_mail 和 open_notion gate on 都进前端邮件视图.
_FRONTEND_DEEPLINK_ENV = "MAILAGENT_FRONTEND_DEEPLINK_ENABLED"


def _frontend_deeplink_enabled() -> bool:
    return os.environ.get(_FRONTEND_DEEPLINK_ENV, "").strip().lower() == "true"


async def _open_mail(internal_id: int, meta: Dict[str, str]) -> Tuple[bool, str]:
    # F6: gate on → 打开 MailAgent 前端邮件视图
    if _frontend_deeplink_enabled():
        return await _run(["open", f"mailagent://email/{int(internal_id)}"], timeout=5)

    # fallback: 系统 Mail.app (osascript). H-12: 必须用
    # `first message of mailbox of account whose id is <int>` 语法
    account_name = meta.get("mailagent.accountName", "")
    mailbox_name = meta.get("mailagent.mailboxName") or meta.get("mailagent.mailbox") or INBOX_LABEL
    if not account_name:
        log.warning("[island-response] open_mail missing accountName; aborting")
        return False, "missing accountName"
    script = (
        'tell application "Mail"\n'
        '  activate\n'
        f'  set targetAccount to first account whose name is "{_escape(account_name)}"\n'
        f'  set targetMailbox to first mailbox of targetAccount whose name is "{_escape(mailbox_name)}"\n'
        f'  set m to first message of targetMailbox whose id is {int(internal_id)}\n'
        '  open m\n'
        'end tell\n'
    )
    return await _run(["osascript", "-e", script], timeout=8)


async def _open_notion(meta: Dict[str, str]) -> Tuple[bool, str]:
    # F6: gate on → 打开 MailAgent 前端邮件视图 (前端是统一邮件入口, 不跳 Notion)
    if _frontend_deeplink_enabled():
        internal_id_str = meta.get("mailagent.internalId", "").strip()
        if internal_id_str.isdigit():
            return await _run(
                ["open", f"mailagent://email/{int(internal_id_str)}"], timeout=5,
            )
        # 无 internalId → 落回 Notion fallback (下方)

    # fallback: Notion 页 (notion:// 桌面版 / https 兜底). M-13: 桌面版 fallback Web URL
    page_id_dashed = meta.get("mailagent.notionPageId", "").strip()
    if not page_id_dashed:
        log.debug("[island-response] open_notion no page_id; skipping")
        return False, "no page_id"
    page_id_flat = page_id_dashed.replace("-", "")
    use_app = Path("/Applications/Notion.app").exists() and bool(shutil.which("open"))
    url = (
        f"notion://www.notion.so/{page_id_flat}"
        if use_app
        else f"https://www.notion.so/{page_id_flat}"
    )
    return await _run(["open", url], timeout=5)


def _mailagent_args(*subcommand: str) -> list:
    """构造 mailagent CLI argv, global ``--api-key`` 前置 (subcommand 之前).

    关键 (实测 2026-05-26): ``--api-key`` 是 root callback global flag, **必须**放
    subcommand 之前 (``mailagent --api-key K email draft 123``); 放后面
    (``mailagent email draft 123 --api-key K``) typer 报 "No such option: --api-key".
    Phase 1 _create_draft / _mark_done 误把它后置 — 仅在用户没设 MAILAGENT_CLI_API_KEY
    (dev unauth-writes 放行) 时不触发, 一旦设了 key 全部 silent fail. 见 CLAUDE.md
    "全局 flags 写在 subcommand 之前".
    """
    args = ["mailagent"]
    api_key = os.environ.get("MAILAGENT_CLI_API_KEY", "")
    if api_key:
        args.extend(["--api-key", api_key])
    args.extend(subcommand)
    return args


async def _create_draft(internal_id: int) -> Tuple[bool, str]:
    # davmail IMAP APPEND / applescript sh; Notion retrieve 可能慢, timeout 给 60s
    return await _run(_mailagent_args("email", "draft", str(internal_id)), timeout=60)


async def _mark_done(internal_id: int) -> Tuple[bool, str]:
    return await _run(
        _mailagent_args(
            "notion", "update-flag", str(internal_id), "--processing-status", "已完成",
        ),
        timeout=30,
    )


async def _convert_to_notion_task(internal_id: int) -> Tuple[bool, str]:
    # F3: mailagent notion create-task — LLM extract_task (1 call) + 写日程库 page +
    # Email Inbox relation + 标邮件完成. LLM + Notion 写 + retrieve, timeout 给 90s.
    return await _run(
        _mailagent_args("notion", "create-task", str(internal_id)),
        timeout=90,
    )


async def _archive_and_unsubscribe(internal_id: int) -> Tuple[bool, str]:
    # F2: mailagent email unsubscribe — 解析 List-Unsubscribe header 智能退订
    # (RFC 8058 one-click POST / open URL / open mailto), unsubscribe CLI 内部
    # 默认 mark 邮件完成. backend 重抽 raw MIME + 可能 httpx POST, timeout 给 30s.
    return await _run(
        _mailagent_args("email", "unsubscribe", str(internal_id)),
        timeout=30,
    )


async def _add_to_calendar(internal_id: int) -> Tuple[bool, str]:
    # F5: LLM 抽邮件提到的会议时间 + 建日程库 page (--as-meeting). 复用 create-task
    # CLI 会议模式 (schedule_type=工作·会议 + Time 抽自邮件). meeting_sync 已自动处理
    # 标准 .ics 邀请, 这个 cover 非标准时间提及 (邮件正文说"周五 10:00"等).
    return await _run(
        _mailagent_args("notion", "create-task", str(internal_id), "--as-meeting"),
        timeout=90,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Phase 3 DailyDigest bulk handler — 循环单封 CLI (plan §3 decision 2c)
# ─────────────────────────────────────────────────────────────────────────────

# 单次 click 最多批量处理的封数 (与 dispatch 端 / config max_bulk_ids 同口径; 这里做
# 兜底硬 cap 防 metadata 被篡改塞超大列表)。
_BULK_IDS_CAP = 30


def _parse_digest_ids(meta: Dict[str, str], choice: str) -> list:
    """读 ``meta["mailagent.digestBulk.<choice>.ids"]`` 逗号分隔 → ``[int, ...]``.

    非法 token 跳过; 去重保序; cap ``_BULK_IDS_CAP``。
    """
    raw = meta.get(f"mailagent.digestBulk.{choice}.ids", "") or ""
    out: list = []
    seen: set = set()
    for tok in raw.split(","):
        tok = tok.strip()
        if not tok:
            continue
        try:
            iid = int(tok)
        except (TypeError, ValueError):
            continue
        if iid in seen:
            continue
        seen.add(iid)
        out.append(iid)
        if len(out) >= _BULK_IDS_CAP:
            break
    return out


async def _run_bulk(choice: str, ids: list) -> None:
    """循环单封 CLI 执行 bulk action (串行 + 每封独立 try, 一封失败不阻断后续).

    - ``bulk_archive_newsletter`` / ``bulk_mark_done`` →
      ``notion update-flag <id> --processing-status 已完成``
    - ``bulk_mark_read`` → ``notion update-flag <id> --is-read true``

    plan §3 decision 2c: 复用现有单封 ``update-flag`` (零新写路径 / 零新鉴权面 /
    与 Notion 反向同步行为一致)。前置 ``is_bulk_action_id`` 二次校验。
    """
    if not is_bulk_action_id(choice):
        log.warning("[island-response] _run_bulk got non-bulk choice: %s", choice)
        return
    if not ids:
        log.info("[island-response] bulk %s: empty ids, nothing to do", choice)
        return

    if choice == "bulk_mark_read":
        extra = ["--is-read", "true"]
    else:
        # bulk_archive_newsletter / bulk_mark_done → 标完成
        extra = ["--processing-status", "已完成"]

    ok = 0
    failed = 0
    for iid in ids:
        try:
            await _run(
                _mailagent_args("notion", "update-flag", str(iid), *extra),
                timeout=30,
            )
            ok += 1
        except Exception as e:  # noqa: BLE001
            failed += 1
            log.warning("[island-response] bulk %s id=%s failed: %s", choice, iid, e)
    log.info(
        "[island-response] bulk %s done: %d/%d dispatched (failed=%d)",
        choice, ok, len(ids), failed,
    )


def _enqueue_snooze(internal_id: int, duration_sec: int, meta: Dict[str, str]) -> None:
    """统一 snooze 入队 (snooze_1h 1h vs defer_to_monday_9am 算到下周一 9AM 的 seconds).

    duration_sec ≤ 0 时按 60s 兜底 (避免 island_snooze 入队负值乱序).

    P0-1: 入队后追发 ``MailCompleted`` 让 fork 端 mail session 立即清除 (否则卡在
    waitingForInput, dock/mascot 不消失)。通过 ``mailagent.snoozeReason`` metadata
    让 fork 区分真完成 vs snooze (fork 可读此字段调 UI 文案，当前忽略也无害)。
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

    # P0-1: 追发 MailCompleted 清 fork dock。reason 让 fork UI 后续可区分文案。
    # snooze_1h → "user_snooze_1h"; defer_to_monday_9am → 按 duration 推断走默认。
    reason = "user_snooze_1h" if duration_sec == 3600 else f"user_snooze_{duration_sec}s"
    try:
        # Lazy import 避 circular (dispatch -> response -> dispatch).
        from src.notify import island_dispatch
        island_dispatch.dispatch_mail_completed(
            internal_id=internal_id,
            page_id=meta.get("mailagent.notionPageId", ""),
            subject=meta.get("mailagent.subject", ""),
            mailbox=meta.get("mailagent.mailbox", ""),
            sender_email=meta.get("mailagent.sender", ""),
            sender_name=meta.get("mailagent.senderName", ""),
            extra_metadata={"mailagent.snoozeReason": reason},
        )
    except Exception as e:  # noqa: BLE001
        log.warning("[island-response] snooze post-completed dispatch failed: %s", e)


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
    """Phase 2 mark_done alias 区分意图: 标完成路径共用 _mark_done 但用户的意图不同,
    log 一行让 ops 后期 grep / 做指标 / 业务迭代时知道哪条 follow-up 真做了.

    当前 mark_done alias (mark_done / archive_only / mark_done_no_response) 都是纯
    "标完成" 语义, 无额外 follow-up; archive_and_unsubscribe (F2) / convert_to_notion_task
    (F3) 已升级为独立分支真执行, 不再走这里. 保留 hook 给未来 alias 扩展。"""
    return


def _handle_ai_draft_stub(choice: str, internal_id: int, meta: Dict[str, str]) -> None:
    """P0-2: AIDraftReady intervention click stub.

    AIDraftReady envelope 让 fork UI 展示 AI 草稿 + send/edit/discard 三 option;
    用户点击后这里仅 log 用户决策 (含 envelope_id / scenario), 真实业务 (实际发送
    SMTP / 打开编辑器 / 丢弃 draft state) 由上游 LLM agent 后续接管 — 这里不调任何
    CLI 子进程, 避免与 Phase 3+ 的 draft state machine 抢路径。
    """
    log.info(
        "[island-response] ai_draft choice=%s internal_id=%d page_id=%s "
        "(stub: real send/edit/discard handled by upstream LLM agent)",
        choice, internal_id, meta.get("mailagent.notionPageId", ""),
    )


async def _run(args, *, timeout: float = 10) -> Tuple[bool, str]:
    """fire-and-forget subprocess；不抛 (调用方需要灵动岛 click ack 即时返回)。

    返回 ``(ok, error_msg)``: ``ok=True`` 表示 rc=0; ``ok=False`` 时 error_msg 是
    截短 (≤200 chars) 的 stderr / 异常字符串, 供上游 dispatch_action_acked 回流 fork UI。

    向后兼容: 老调用方忽略返回值仍工作 (Python 隐式 ignore tuple)。
    """
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
            return False, f"timeout after {timeout}s: {args[0]}"
        if proc.returncode != 0:
            err = (stderr or b"").decode(errors="replace")[:200]
            log.warning("[island-response] %s rc=%s err=%s", args[0], proc.returncode, err)
            return False, err or f"rc={proc.returncode}"
        return True, ""
    except FileNotFoundError:
        log.warning("[island-response] command not found: %s", args[0])
        return False, f"command not found: {args[0]}"
    except Exception as e:  # noqa: BLE001
        log.warning("[island-response] subprocess error %s: %s", args[0], e)
        return False, str(e)[:200]


def _escape(text: str) -> str:
    """AppleScript 字符串字面量 escape."""
    return (text or "").replace("\\", "\\\\").replace('"', '\\"')


# Unused; intentional 占位 for tests' import sanity (确保此模块 Awaitable 类型可
# import). 不删: tests 端 `from src.notify import island_response as ir` 后引用.
_HandlerFn = Callable[[int, Dict[str, str]], Awaitable[None]]
