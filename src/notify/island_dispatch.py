"""把 MailAgent 内部事件翻译成 BridgeEnvelope 并通过 unix socket 派发到 ping-island.

挂钩点来源：``frontend/ISLAND-PLUGIN.md`` §4.3。

设计：
- 模块单例 ``_dispatcher_state``：caller 在 ``main.py`` 启动时调 ``init(...)`` 一次，
  把 ``sync_store`` / 是否启用 / sock 路径等存进来；后续 ``dispatch_*`` 直接读
- 所有 ``dispatch_*`` 是同步函数（构造 envelope 不会失败），内部 ``asyncio.create_task``
  把发送动作 fire-and-forget 出去；调用方不需要 await
- 发送结果（含 ``BridgeResponse.decision``）由后台 task 自己处理：
    - dispatched_ok / dispatched_err → 写 ``island_dispatch`` 表（评估指标）
    - 用户在 ping-island 点了 option → 调 ``island_response.handle_response``
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, Optional, TYPE_CHECKING

from src.notify import island_i18n, island_reconnect, ping_island
from src.notify.island_envelope import (
    BridgeEnvelope,
    Intervention,
    InterventionOption,
)

if TYPE_CHECKING:  # pragma: no cover
    from src.mail.sync_store import SyncStore

log = logging.getLogger(__name__)


# 默认 5 个 intervention options（顺序按 REVIEW-LOG M-11 优先级排）
DEFAULT_OPTION_IDS = (
    "create_draft",
    "open_mail",
    "open_notion",
    "mark_done",
    "snooze_1h",
)

URGENT_PRIORITY_LABELS = {"🔴 紧急", "🟡 重要"}
ACTION_NEEDS_FLAG = {
    "需要回复", "需要决策", "需要Review", "需要会议", "需要跟进", "等待响应",
}


@dataclass
class _DispatcherState:
    enabled: bool = False
    sync_store: Optional["SyncStore"] = None
    account_name: str = ""
    accent: str = "coral"
    theme: str = "dark"
    extra_metadata: Dict[str, str] = field(default_factory=dict)


_state = _DispatcherState()


def init(
    *,
    enabled: bool,
    sync_store: Optional["SyncStore"] = None,
    account_name: str = "",
    accent: str = "coral",
    theme: str = "dark",
    extra_metadata: Optional[Dict[str, str]] = None,
) -> None:
    """启动时调一次；后续 ``dispatch_*`` 根据 ``enabled`` 决定是否 emit."""
    _state.enabled = bool(enabled)
    _state.sync_store = sync_store
    _state.account_name = account_name or ""
    _state.accent = accent or "coral"
    _state.theme = theme or "dark"
    _state.extra_metadata = dict(extra_metadata or {})


def is_enabled() -> bool:
    return _state.enabled


# ─────────────────────────────────────────────────────────────────────────────
# Public dispatch entry points （在 watcher / runner / handlers 里调）
# ─────────────────────────────────────────────────────────────────────────────


def dispatch_mail_received(
    *,
    internal_id: int,
    page_id: str,
    subject: str,
    sender_email: str,
    sender_name: str,
    mailbox: str,
    is_flagged: bool = False,
    attach_count: int = 0,
) -> None:
    """新邮件 Notion sync 成功 → emit ``MailReceived``.

    Phase 1 不在此判定 priority；urgent / intervention 由后续 ``LLMReviewed`` 决定。
    ``is_flagged`` 仅作为 metadata 透传，让 ping-island 在 dashboard 可视化。
    """
    if not _state.enabled:
        return
    env = BridgeEnvelope(
        event_type="MailReceived",
        session_key=f"mailagent:email:{internal_id}",
        title=island_i18n.t(
            "mail.received.title",
            sender=_friendly_sender(sender_name, sender_email),
        ),
        preview=_one_line(subject),
        status_kind="notification",
        metadata=_base_metadata(
            internal_id=internal_id, page_id=page_id, subject=subject,
            sender=sender_email, sender_name=sender_name, mailbox=mailbox,
            is_flagged=is_flagged, attach_count=attach_count,
        ),
        expects_response=False,
    )
    _fire(env, internal_id=internal_id)


def dispatch_llm_reviewed(
    *,
    internal_id: int,
    page_id: str,
    subject: str,
    sender_email: str,
    sender_name: str,
    mailbox: str,
    priority: str = "",
    action: str = "",
) -> None:
    """LLM 处理完 → emit ``LLMReviewed`` 或 ``LLMReviewedUrgent`` (带 5 option).

    Urgent 条件：``priority`` 命中 ``URGENT_PRIORITY_LABELS`` AND ``action`` 命中
    ``ACTION_NEEDS_FLAG``，与 ``handlers.handle_ai_reviewed`` 的飞书通知规则同。
    """
    if not _state.enabled:
        return

    urgent = priority in URGENT_PRIORITY_LABELS and action in ACTION_NEEDS_FLAG
    event_type = "LLMReviewedUrgent" if urgent else "LLMReviewed"

    sender_disp = _friendly_sender(sender_name, sender_email)
    if urgent:
        title = island_i18n.t("mail.urgent.title", sender=sender_disp)
        message = island_i18n.t(
            "mail.urgent.message",
            action=action or "—",
            priority=priority or "—",
            subject=subject,
        )
        intervention: Optional[Intervention] = Intervention(
            title=title,
            message=message,
            options=[_default_option(oid) for oid in DEFAULT_OPTION_IDS],
        )
        status_kind = "waitingForInput"
        expects_response = True
    else:
        title = island_i18n.t("mail.reviewed.title", sender=sender_disp)
        message = ""
        intervention = None
        status_kind = "notification"
        expects_response = False

    env = BridgeEnvelope(
        event_type=event_type,
        session_key=f"mailagent:email:{internal_id}",
        title=title,
        preview=_one_line(subject),
        status_kind=status_kind,
        metadata=_base_metadata(
            internal_id=internal_id, page_id=page_id, subject=subject,
            sender=sender_email, sender_name=sender_name, mailbox=mailbox,
            ai_action=action, ai_priority=priority,
        ),
        intervention=intervention,
        expects_response=expects_response,
    )
    _fire(env, internal_id=internal_id)


def dispatch_mail_completed(
    *,
    internal_id: int,
    page_id: str,
    subject: str,
    mailbox: str = "",
) -> None:
    """Notion → Mail 已完成 → emit ``MailCompleted`` 清掉 Phase 2 dock icon."""
    if not _state.enabled:
        return
    env = BridgeEnvelope(
        event_type="MailCompleted",
        session_key=f"mailagent:email:{internal_id}",
        title=island_i18n.t("mail.completed.title", subject=_one_line(subject)),
        preview="",
        status_kind="completed",
        metadata=_base_metadata(
            internal_id=internal_id, page_id=page_id, subject=subject,
            mailbox=mailbox,
        ),
        expects_response=False,
    )
    _fire(env, internal_id=internal_id)


def dispatch_sync_failed(
    *,
    internal_id: int,
    subject: str,
    error: str,
) -> None:
    """单封邮件 sync 失败 → emit ``SyncFailed``（Phase 1 Arrive，无 intervention）."""
    if not _state.enabled:
        return
    env = BridgeEnvelope(
        event_type="SyncFailed",
        session_key=f"mailagent:email:{internal_id}",
        title=island_i18n.t("mail.syncFailed.title", internalId=str(internal_id)),
        preview=_one_line(subject),
        status_kind="error",
        status_detail=error[:200],
        metadata=_base_metadata(
            internal_id=internal_id, page_id="", subject=subject,
            error=error[:200],
        ),
        expects_response=False,
    )
    _fire(env, internal_id=internal_id)


def dispatch_dead_letter_accum(*, count: int, threshold: int = 0) -> None:
    """死信累积告警 → emit ``DeadLetterAccum``."""
    if not _state.enabled:
        return
    env = BridgeEnvelope(
        event_type="DeadLetterAccum",
        session_key="mailagent:system:dead_letter",
        title=island_i18n.t("mail.deadLetter.title", count=str(count)),
        preview="",
        status_kind="error",
        metadata={
            **_state.extra_metadata,
            "mailagent.deadLetterCount": str(count),
            "mailagent.deadLetterThreshold": str(threshold),
            "mailagent.lang": island_i18n.resolve_lang(),
            "mailagent.theme": _state.theme,
            "mailagent.accent": _state.accent,
        },
        expects_response=False,
    )
    _fire(env, internal_id=None)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _friendly_sender(sender_name: str, sender_email: str) -> str:
    name = (sender_name or "").strip()
    if name:
        return name
    return (sender_email or "").strip() or "Unknown"


def _one_line(text: str, max_len: int = 200) -> str:
    if not text:
        return ""
    out = " ".join(text.split())
    return out[:max_len]


def _base_metadata(
    *,
    internal_id: int,
    page_id: str,
    subject: str = "",
    sender: str = "",
    sender_name: str = "",
    mailbox: str = "",
    is_flagged: bool = False,
    attach_count: int = 0,
    ai_action: str = "",
    ai_priority: str = "",
    error: str = "",
) -> Dict[str, str]:
    meta: Dict[str, str] = {
        **_state.extra_metadata,
        "mailagent.internalId": str(internal_id),
        "mailagent.subject": subject or "",
        "mailagent.sender": sender or "",
        "mailagent.senderName": sender_name or "",
        "mailagent.mailbox": mailbox or "",
        "mailagent.accountName": _state.account_name,
        "mailagent.mailboxName": mailbox or "",
        "mailagent.isFlagged": "true" if is_flagged else "false",
        "mailagent.attachCount": str(attach_count),
        "mailagent.lang": island_i18n.resolve_lang(),
        "mailagent.theme": _state.theme,
        "mailagent.accent": _state.accent,
    }
    if page_id:
        meta["mailagent.notionPageId"] = page_id
    if ai_action:
        meta["mailagent.aiAction"] = ai_action
    if ai_priority:
        meta["mailagent.aiPriority"] = ai_priority
    if error:
        meta["mailagent.error"] = error
    return meta


def _default_option(opt_id: str) -> InterventionOption:
    if opt_id == "create_draft":
        return InterventionOption(
            id="create_draft",
            title=island_i18n.t("mail.action.createDraft"),
            detail=island_i18n.t("mail.action.createDraft.detail"),
        )
    title_key = f"mail.action.{opt_id}" if opt_id != "snooze_1h" else "mail.action.snooze1h"
    # 默认 key 命名匹配 locale 文件
    title_key_map = {
        "open_mail": "mail.action.openMail",
        "open_notion": "mail.action.openNotion",
        "mark_done": "mail.action.markDone",
        "snooze_1h": "mail.action.snooze1h",
    }
    return InterventionOption(id=opt_id, title=island_i18n.t(title_key_map.get(opt_id, title_key)))


def _fire(envelope: BridgeEnvelope, *, internal_id: Optional[int]) -> None:
    """把 send_async 包成 background task；记录 dispatch 结果."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # 非 asyncio 上下文（CLI 测试 / 模块导入期）：跳过实际发送，但仍写 SQLite
        log.debug("[island] dispatch outside asyncio loop: skipping %s", envelope.event_type)
        _record_dispatch(envelope, internal_id, ok=False, latency_ms=0,
                         response_decision=None)
        return

    async def _bg():
        result = await ping_island.send_async(envelope)
        decision = None
        if result.ok and result.response:
            decision = _extract_choice(result.response)
        elif not result.ok:
            # H-17 重连队列：把 encode 后的 bytes 入队
            try:
                island_reconnect.enqueue(envelope.encode())
            except Exception as e:  # noqa: BLE001
                log.debug("[island] enqueue backlog failed: %s", e)

        _record_dispatch(
            envelope, internal_id, ok=result.ok,
            latency_ms=result.latency_ms, response_decision=decision,
        )

        if result.ok and result.response is not None:
            # 用户在灵动岛点过 option → 走 response handler
            try:
                from src.notify import island_response
                await island_response.handle_response(result.response, envelope.metadata)
            except Exception as e:  # noqa: BLE001
                log.warning("[island] response handler error: %s", e)

    loop.create_task(_bg())


def _extract_choice(response: Dict[str, Any]) -> Optional[str]:
    decision = response.get("decision")
    if not isinstance(decision, dict):
        return None
    answer = decision.get("answer")
    if isinstance(answer, dict):
        choice = answer.get("choice") or answer.get("optionId") or answer.get("id")
        if isinstance(choice, str):
            return choice
    if isinstance(answer, str):
        return answer
    return None


def _record_dispatch(
    envelope: BridgeEnvelope,
    internal_id: Optional[int],
    *,
    ok: bool,
    latency_ms: int,
    response_decision: Optional[str],
) -> None:
    store = _state.sync_store
    if store is None:
        return
    try:
        store.record_island_dispatch(
            event_type=envelope.event_type,
            session_key=envelope.session_key,
            dispatched_ok=ok,
            response_decision=response_decision,
            response_latency_ms=latency_ms,
            internal_id=internal_id,
        )
    except Exception as e:  # noqa: BLE001
        log.debug("[island] failed to record dispatch row: %s", e)


# ─────────────────────────────────────────────────────────────────────────────
# Convenience iter for tests
# ─────────────────────────────────────────────────────────────────────────────

def default_option_ids() -> Iterable[str]:
    return DEFAULT_OPTION_IDS
