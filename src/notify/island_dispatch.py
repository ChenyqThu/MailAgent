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
import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, TYPE_CHECKING

from src.notify import island_i18n, island_reconnect, ping_island
from src.notify.island_envelope import (
    BridgeEnvelope,
    Intervention,
    InterventionOption,
)

if TYPE_CHECKING:  # pragma: no cover
    from src.mail.sync_store import SyncStore

log = logging.getLogger(__name__)


# 默认 5 个 intervention options（顺序按 mailagent 当前架构定 — Sprint 16 davmail cutover 后)
# fork MailAgentSessionView 用 `prefix(3)` 渲染前 3 个 button (mockup §2 Scene 3 简洁风格);
# 后 2 个 (snooze + open_mail) 保留作 expanded view 显示 / Phase 2 AI 动态 fallback.
#
# 顺序说明:
# 1. open_notion  — Notion 邮件页是当前邮件 SSoT (Sprint 16 davmail cutover 后 Mail.app
#                   只是 IMAP/SMTP fallback backend, 无邮件数据). 主入口.
# 2. create_draft — AI 草稿 / 手动起草回复 (Phase 1 ship 现有)
# 3. mark_done    — Notion 标完成
# 4. snooze_1h    — 1h 后 re-emit (Phase 4 会升级到智能 snooze)
# 5. open_mail    — Mail.app deeplink (fallback for power user, 默认 prefix(3) 不渲染)
DEFAULT_OPTION_IDS = (
    "open_notion",
    "create_draft",
    "mark_done",
    "snooze_1h",
    "open_mail",
)

URGENT_PRIORITY_LABELS = {"🔴 紧急", "🟡 重要"}
ACTION_NEEDS_FLAG = {
    "需要回复", "需要决策", "需要Review", "需要会议", "需要跟进", "等待响应",
}


# ─────────────────────────────────────────────────────────────────────────────
# Phase 1 (PRD §5.1) — Mascot domain 规则表
# Mascot id ∈ {work, personal, dev, default} → fork Swift 端按 id 加载
# Mail{Logo,MascotWork,MascotPersonal,MascotDev} imageset。
# 用户自己邮箱同域 → work；env `MAILAGENT_MASCOT_DOMAIN_RULES` JSON 可覆盖默认。
# ─────────────────────────────────────────────────────────────────────────────

_DEFAULT_MASCOT_RULES: Dict[str, List[str]] = {
    "personal": [
        "gmail.com", "icloud.com", "me.com", "hotmail.com", "outlook.com",
        "yahoo.com", "163.com", "qq.com", "126.com", "foxmail.com", "live.com",
    ],
    "dev": [
        "github.com", "vercel.com", "sentry.io", "stripe.com",
        "openai.com", "anthropic.com", "circleci.com", "netlify.com",
        "supabase.io", "pypi.org", "npmjs.com", "linear.app", "notion.so",
        "cloudflare.com", "datadog.com", "snyk.io",
    ],
}


def _load_mascot_rules() -> Dict[str, List[str]]:
    """读 ``MAILAGENT_MASCOT_DOMAIN_RULES`` env 覆盖 default rules.

    格式：``{"work":["acme.com"],"personal":["gmail.com"]}``。invalid JSON 走默认。
    """
    raw = os.environ.get("MAILAGENT_MASCOT_DOMAIN_RULES")
    if not raw:
        return _DEFAULT_MASCOT_RULES
    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            return {str(k): [str(d) for d in (v or [])] for k, v in data.items()}
    except Exception as e:  # noqa: BLE001
        log.warning("[island] invalid MAILAGENT_MASCOT_DOMAIN_RULES JSON: %s", e)
    return _DEFAULT_MASCOT_RULES


def _resolve_mascot(sender_email: str) -> str:
    """Domain → mascot id 映射，fallback ``"default"``.

    顺序：
      1. env / default 规则表（``personal`` / ``dev`` / ``work`` / …）按精确或子域后缀匹配
      2. 用户 ``USER_EMAIL`` 同域 → ``"work"``
      3. 否则 → ``"default"``
    """
    if not sender_email or "@" not in sender_email:
        return "default"
    domain = sender_email.rsplit("@", 1)[-1].strip().lower()
    if not domain:
        return "default"
    for mascot_id, domains in _load_mascot_rules().items():
        for d in (domains or []):
            d_norm = (d or "").lower().lstrip(".")
            if not d_norm:
                continue
            if domain == d_norm or domain.endswith("." + d_norm):
                return str(mascot_id)
    user_email = (os.environ.get("USER_EMAIL") or "").strip()
    if "@" in user_email:
        user_domain = user_email.rsplit("@", 1)[-1].strip().lower()
        if user_domain and (domain == user_domain or domain.endswith("." + user_domain)):
            return "work"
    return "default"


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
    sender_digest: str = "",
) -> None:
    """新邮件 Notion sync 成功 → emit ``MailReceived``.

    Phase 1 不在此判定 priority；urgent / intervention 由后续 ``LLMReviewed`` 决定。
    ``is_flagged`` 仅作为 metadata 透传，让 ping-island 在 dashboard 可视化。
    ``sender_digest`` 为 Phase 2 KOS L1 hot block 预留接口（暂可空）。
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
            scenario="MailReceived",
            mascot=_resolve_mascot(sender_email),
            sender_digest=sender_digest,
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
    ai_summary: str = "",
    sender_digest: str = "",
    recommended_actions: Optional[List[Dict[str, Any]]] = None,
) -> None:
    """LLM 处理完 → emit ``LLMReviewed`` 或 ``LLMReviewedUrgent`` (带 1-5 option).

    Urgent 条件：``priority`` 命中 ``URGENT_PRIORITY_LABELS`` AND ``action`` 命中
    ``ACTION_NEEDS_FLAG``，与 ``handlers.handle_ai_reviewed`` 的飞书通知规则同。
    ``ai_summary`` 透传 LLM ``AILabels.ai_summary``（2-4 句中文摘要，≤ 2000）。

    Phase 2 (PRD §5.2): ``recommended_actions`` 是 processor 已 sanitize 的 dict list
    (每项含 id/title/detail/confidence). urgent 分支用 ``_build_dynamic_options`` 再做
    一次 confidence >= 0.5 + handler whitelist 防御性 filter, 输出 1-3 个 InterventionOption
    替代 DEFAULT_OPTION_IDS. filter 后空 list → 退回静态 5 fallback.
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
        dynamic_options = _build_dynamic_options(recommended_actions or [])
        if dynamic_options:
            options = dynamic_options
            log.info(
                "[island] dispatch_llm_reviewed internal_id=%d urgent dynamic_options=%d "
                "ids=%s",
                internal_id, len(options), [o.id for o in options],
            )
        else:
            options = [_default_option(oid) for oid in DEFAULT_OPTION_IDS]
        intervention: Optional[Intervention] = Intervention(
            title=title,
            message=message,
            options=options,
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
            ai_summary=ai_summary,
            scenario=event_type,
            mascot=_resolve_mascot(sender_email),
            sender_digest=sender_digest,
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
            scenario="MailCompleted",
        ),
        expects_response=False,
    )
    _fire(env, internal_id=internal_id)


def dispatch_sync_failed(
    *,
    internal_id: int,
    subject: str,
    error: str,
    sender_email: str = "",
) -> None:
    """单封邮件 sync 失败 → emit ``SyncFailed``（Phase 1 Arrive，无 intervention）.

    ``sender_email`` 可选；非空时 mascot 按 domain 推断，否则用 default。
    """
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
            sender=sender_email,
            error=error[:200],
            scenario="SyncFailed",
            mascot=_resolve_mascot(sender_email) if sender_email else "default",
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
            "mailagent.scenario": "DeadLetterAccum",
            "mailagent.mascot": "default",
            # fork makeClientInfo brand 推导 — 见 _base_metadata 同段注释
            "client_kind": "mailagent",
            "client_name": "MailAgent",
            "client_origin": "plugin",
            "client_originator": "MailAgent",
            "thread_source": "mailagent-hooks",
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
    ai_summary: str = "",
    scenario: str = "",
    mascot: str = "",
    sender_digest: str = "",
    error: str = "",
) -> Dict[str, str]:
    """构造 ``metadata.mailagent.*`` 命名空间。

    Phase 1 (PRD §5.1) 新增字段（向后兼容，老 fork 端忽略未知 key）：
    - ``mailagent.aiSummary``    — LLM 给的 2-4 句中文摘要（schema.ai_summary, ≤ 2000）
    - ``mailagent.scenario``     — 路由 hint（fork 端用 scenario 选 4 scene 变体）
    - ``mailagent.mascot``       — mascot id ∈ {work, personal, dev, default}
    - ``mailagent.senderDigest`` — KOS L1 hot block（Phase 2 KOS consumer wire 上后非空）
    """
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
        # fork HookSocketServer.makeClientInfo 用这些 key 推 SessionClientInfo.profileID
        # → matchRuntimeProfile 匹配到 id="mailagent" runtime profile (brand=.mail,
        #   ping-island fork commit 171f907 ship)
        # → SessionClientInfo.brand == .mail
        # → SessionAttentionNotificationView / SessionHoverDashboardView 内 brand 分支生效
        # → 渲染 MailAgentSessionView 而非 generic HoverSessionCard.
        # 不加这些 key 时 fork 端 brand fallback .neutral, 渲染 generic (zZz mascot + 乱码).
        "client_kind": "mailagent",
        "client_name": "MailAgent",
        "client_origin": "plugin",
        "client_originator": "MailAgent",
        "thread_source": "mailagent-hooks",
    }
    if page_id:
        meta["mailagent.notionPageId"] = page_id
    if ai_action:
        meta["mailagent.aiAction"] = ai_action
    if ai_priority:
        meta["mailagent.aiPriority"] = ai_priority
    if ai_summary:
        meta["mailagent.aiSummary"] = ai_summary
    if scenario:
        meta["mailagent.scenario"] = scenario
    if mascot:
        meta["mailagent.mascot"] = mascot
    if sender_digest:
        meta["mailagent.senderDigest"] = sender_digest
    if error:
        meta["mailagent.error"] = error
    return meta


# Phase 2 (PRD §5.2): dynamic intervention.options 构造.
# processor 端 sanitize 已做 (mailbox-specific whitelist + 字段 shape + length + cap 3);
# 这里再做一次防御性 filter (confidence threshold + handler whitelist), cap 3.
_DYNAMIC_CONFIDENCE_FLOOR = 0.5


def _build_dynamic_options(recs: List[Dict[str, Any]]) -> List[InterventionOption]:
    """从 LLM ``recommended_actions`` 构造 ``InterventionOption`` list.

    输入是 processor._parse sanitize 过的 list; 这里做防御性二次过滤:
    1. id 必须在 handler whitelist (``RECOMMENDED_ACTION_IDS``, 排除 Phase 1 静态 5)
    2. confidence >= 0.5 (低置信度 LLM 自己说不准, 退回静态 5 比硬塞错建议好)
    3. title 非空字符串
    4. cap 3 (schema 已 maxItems=3, double-safe)

    全部 filter 失败 → 返 [], 上游决定是否走静态 5 fallback.
    """
    # Lazy import 避 circular (whitelist 依赖 schema, schema 不依赖此模块).
    from src.notify.island_action_whitelist import is_recommended_action_id

    out: List[InterventionOption] = []
    if not isinstance(recs, list):
        return out
    for rec in recs:
        if not isinstance(rec, dict):
            continue
        rid = rec.get("id")
        if not isinstance(rid, str) or not is_recommended_action_id(rid):
            continue
        try:
            conf = float(rec.get("confidence", 0.0))
        except (TypeError, ValueError):
            continue
        if conf != conf or conf < _DYNAMIC_CONFIDENCE_FLOOR:  # NaN guard + threshold
            continue
        title_raw = rec.get("title")
        if not isinstance(title_raw, str):
            continue
        title = title_raw.strip()
        if not title:
            continue
        detail_raw = rec.get("detail")
        detail: Optional[str] = None
        if isinstance(detail_raw, str) and detail_raw.strip():
            detail = detail_raw.strip()
        out.append(InterventionOption(id=rid, title=title, detail=detail))
        if len(out) >= 3:
            break
    return out


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
