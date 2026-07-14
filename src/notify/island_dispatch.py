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
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Tuple, TYPE_CHECKING

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
    # 邮件通知上岛范围（ISLAND_MAIL_NOTIFY_SCOPE，config 默认 'important'）。模块级缺省
    # 'all' = 旧行为——真实进程恒由 service.py 从 config 传入；init() 不传（既有测试 /
    # 老 caller）保持逐字节现状。
    mail_notify_scope: str = "all"


_state = _DispatcherState()


# ─────────────────────────────────────────────────────────────────────────────
# 问题 A 去重: 同一 (session_key, event_type) 在 DEDUP_WINDOW_SEC 内重复 → skip。
# 治理 island_dispatch 层的重复通知 (上游 LLM hook 对已 success 邮件重入 _bg 时仍调
# dispatch_*; new_watcher 修复 1 是第一道闸, 这里是 dispatch 层兜底)。
# ─────────────────────────────────────────────────────────────────────────────
# 进程级 (重启清空 OK)。snooze re-emit 间隔 ≥1h ≫ 300s, 正常放行不被挡。
DEDUP_WINDOW_SEC = 300
# dict size cap 防内存泄漏 (每封邮件 / 每天 digest 一个 key, 长跑进程会累积)。
_DEDUP_MAX_KEYS = 1000
# key = (session_key, event_type) → 上次 dispatch 的 time.monotonic()
_dedup_seen: Dict[Tuple[str, str], float] = {}
# 测试可 monkeypatch island_dispatch._monotonic 而不动 time 模块本身
# (直接 patch time.monotonic 会破坏 asyncio 内部时钟导致事件循环挂起)。
_monotonic = time.monotonic


def _dedup_should_skip(
    session_key: str, event_type: str, internal_id: Optional[int] = None
) -> bool:
    """True 表示该 envelope 在去重窗口内重复, 应 skip。

    两级去重（契约 §9-2）：
    1. 进程内内存窗口（``_dedup_seen``，快，同进程重复直接挡）；
    2. 内存未命中 → 查 SQLite ``island_dispatch`` 持久去重（跨重启：内存重启即丢，
       从最近成功派发行恢复）。命中则回填内存避免每次都查 SQLite。

    窗口一律 ``DEDUP_WINDOW_SEC``（300s < snooze 1h），snooze re-emit / scenario 变 /
    12h GC 后再推仍合法放行。超 ``_DEDUP_MAX_KEYS`` 时清空整张内存表。
    """
    now = _monotonic()
    key = (session_key, event_type)
    last = _dedup_seen.get(key)
    if last is not None and (now - last) < DEDUP_WINDOW_SEC:
        return True
    # 契约 §9-2: 内存未命中 → SQLite 持久去重 (跨重启)。fail-open。
    store = _state.sync_store
    if store is not None:
        try:
            if store.was_island_notified(
                event_type=event_type,
                internal_id=internal_id,
                session_key=session_key if internal_id is None else None,
                within_sec=DEDUP_WINDOW_SEC,
            ):
                _dedup_seen[key] = now  # 回填内存, 减少 SQLite 查询
                return True
        except Exception as e:  # noqa: BLE001
            log.debug("[island] persistent dedup check failed: %s", e)
    if len(_dedup_seen) >= _DEDUP_MAX_KEYS:
        _dedup_seen.clear()
    _dedup_seen[key] = now
    return False


def init(
    *,
    enabled: bool,
    sync_store: Optional["SyncStore"] = None,
    account_name: str = "",
    accent: str = "coral",
    theme: str = "dark",
    extra_metadata: Optional[Dict[str, str]] = None,
    mail_notify_scope: str = "all",
) -> None:
    """启动时调一次；后续 ``dispatch_*`` 根据 ``enabled`` 决定是否 emit.

    ``mail_notify_scope``: 'important'（config 新默认）= MailReceived 静默 +
    LLMReviewed(Urgent) 仅重要级别；'all' = 全量（旧行为）。非法值归一 'all'
    （fail-open 纪律：配置写错宁多勿丢通知）。
    """
    _state.enabled = bool(enabled)
    _state.sync_store = sync_store
    _state.account_name = account_name or ""
    _state.accent = accent or "coral"
    _state.theme = theme or "dark"
    _state.extra_metadata = dict(extra_metadata or {})
    scope = (mail_notify_scope or "all").strip().lower()
    _state.mail_notify_scope = scope if scope in ("important", "all") else "all"


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
    # ISLAND_MAIL_NOTIFY_SCOPE='important'（config 新默认）：MailReceived 一律静默——
    # 此时点尚无 AI priority，重要级别的弹卡由后续 LLMReviewed(Urgent) 承担；'all' =
    # 旧行为逐字节保留（回退开关）。
    if _state.mail_notify_scope == "important":
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
    # ISLAND_MAIL_NOTIFY_SCOPE='important'（config 新默认）：仅重要级别弹卡——
    # 🔴 紧急（≈ Notion Critical/Urgent）/ 🟡 重要（≈ Important）放行，🟢 一般 / ⚪ 低
    # 静默。放行后 urgent 卡 vs 普通卡的分流判定（priority+action，下一行）不动：
    # 🟡 重要 + 非 NEEDS_FLAG action 仍走普通 LLMReviewed 卡。'all' = 全量（旧行为）。
    if _state.mail_notify_scope == "important" and priority not in URGENT_PRIORITY_LABELS:
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
        # 问题 B: 业务 option 截到 2 + 追加 skip (≤3, fork prefix(3) 上限保证 skip 显示)。
        intervention: Optional[Intervention] = Intervention(
            title=title,
            message=message,
            options=_with_skip_option(options),
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
    sender_email: str = "",
    sender_name: str = "",
    extra_metadata: Optional[Dict[str, str]] = None,
) -> None:
    """Notion → Mail 已完成 → emit ``MailCompleted`` 清掉 Phase 2 dock icon.

    P0-1: ``extra_metadata`` 允许 caller 追加额外 ``mailagent.*`` key (例如 snooze 追发时
    带 ``mailagent.snoozeReason``), fork 端可读 metadata 区分真完成 vs snooze 完成。
    向后兼容: 不传 extra_metadata 时行为与之前完全一致。
    """
    if not _state.enabled:
        return
    metadata = _base_metadata(
        internal_id=internal_id, page_id=page_id, subject=subject,
        mailbox=mailbox,
        sender=sender_email, sender_name=sender_name,
        scenario="MailCompleted",
    )
    if extra_metadata:
        for k, v in extra_metadata.items():
            if isinstance(k, str) and k and isinstance(v, (str, int, bool)):
                metadata[k] = str(v)
    env = BridgeEnvelope(
        event_type="MailCompleted",
        session_key=f"mailagent:email:{internal_id}",
        title=island_i18n.t("mail.completed.title", subject=_one_line(subject)),
        preview="",
        status_kind="completed",
        metadata=metadata,
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


@dataclass
class DigestBulkAction:
    """Phase 3 DailyDigest 的一个 bulk action: id + 文案 + 代码确定性给的 internal_ids.

    与 ``digest_summarizer.DigestBulkAction`` (仅 id/title/detail) 区别: 这里多带
    ``internal_ids`` (LLM 只挑 id + 写文案; ids 来自 ``digest_query`` 代码候选)。
    """

    id: str
    title: str
    detail: str = ""
    internal_ids: List[int] = field(default_factory=list)


# title 里的"数量"数字 (如"归档5封newsletter"的 5)。dispatch 端强制 = len(ids)。
_TITLE_COUNT_RE = re.compile(r"\d+")


def _enforce_title_count(title: str, count: int) -> str:
    """把 title 里第一个数字替换成真实 ``count`` (防 LLM 写错数量误导用户)。

    risk 表第 1 条: id 列表由代码控制, 真实归档数 = len(ids); title 仅展示文案。
    title 没有数字 → 原样返回 (没有数量需要校准)。
    """
    if not title or count < 0:
        return title or ""
    return _TITLE_COUNT_RE.sub(str(count), title, count=1)


def dispatch_daily_digest(
    *,
    digest_date: str,
    headline: str,
    summary_md: str,
    unread: int,
    urgent: int,
    confirmed_actions: List[DigestBulkAction],
    max_bulk_ids: int = 30,
) -> None:
    """每日巡检 → emit ``DailyDigest`` (≤ 3 bulk action option).

    决策点 6: session_key 按天 (``mailagent:daily_digest:YYYYMMDD``), 18:00 覆盖 9:00
    同一卡片。decision 2(b): bulk action 的 internal_id 列表走 metadata 命名空间
    ``mailagent.digestBulk.<id>.ids`` (option struct 无 payload 字段, 只能 metadata 携带)。
    risk 表第 1 条: title 里数字强制 = len(internal_ids) 防 LLM 写错数量。
    """
    if not _state.enabled:
        return

    options: List[InterventionOption] = []
    meta: Dict[str, str] = {
        **_state.extra_metadata,
        "mailagent.lang": island_i18n.resolve_lang(),
        "mailagent.theme": _state.theme,
        "mailagent.accent": _state.accent,
        "mailagent.scenario": "DailyDigest",
        "mailagent.mascot": "default",
        "mailagent.digestDate": digest_date,
        "mailagent.digestHeadline": headline,
        "mailagent.aiSummary": summary_md,
        "mailagent.digestUnread": str(unread),
        "mailagent.digestUrgent": str(urgent),
        # fork makeClientInfo brand 推导 — 见 _base_metadata 同段注释
        "client_kind": "mailagent",
        "client_name": "MailAgent",
        "client_origin": "plugin",
        "client_originator": "MailAgent",
        "thread_source": "mailagent-hooks",
    }
    for a in confirmed_actions:
        ids = [int(i) for i in (a.internal_ids or [])][:max_bulk_ids]
        # risk 1: title 数字强制 = 真实 ids 数
        title = _enforce_title_count(a.title, len(ids))
        options.append(
            InterventionOption(id=a.id, title=title, detail=a.detail or None)
        )
        meta[f"mailagent.digestBulk.{a.id}.ids"] = ",".join(str(i) for i in ids)

    intervention: Optional[Intervention] = None
    if options:
        # 问题 B: 业务 bulk option 截到 2 + 追加 skip (≤3, fork prefix(3) 上限保证 skip 显示)。
        intervention = Intervention(
            title=island_i18n.t("mail.digest.title"),
            message=summary_md,
            options=_with_skip_option(options),
        )

    env = BridgeEnvelope(
        event_type="DailyDigest",
        session_key=f"mailagent:daily_digest:{digest_date}",
        title=island_i18n.t("mail.digest.title"),
        preview=_one_line(headline),
        status_kind="waitingForInput" if options else "notification",
        metadata=meta,
        intervention=intervention,
        expects_response=bool(options),
    )
    _fire(env, internal_id=None)


# ─────────────────────────────────────────────────────────────────────────────
# P0-2: AIDraft 三函数 (start / stream / ready) — DESIGN.md §7 AI ready 通道
# _WIRE_EVENT_MAP 已留位 AIDraftStart / AIDraftStream / AIDraftReady, 这里补全
# dispatch 入口给上游 LLM agent (Phase 3+) 调用; fork MailAgentSessionView
# AIDraftReady scenario 已 ship。
# ─────────────────────────────────────────────────────────────────────────────


def dispatch_ai_draft_start(
    *,
    internal_id: int,
    sender_email: str = "",
    sender_name: str = "",
    subject: str = "",
    mailbox: str = "",
    page_id: str = "",
) -> None:
    """AI 起草开始 — 状态条提示用户 AI 正在工作 (notification, 无 intervention)。"""
    if not _state.enabled:
        return
    env = BridgeEnvelope(
        event_type="AIDraftStart",
        session_key=f"mailagent:email:{internal_id}",
        title=island_i18n.t("mail.ai.draft.start.title"),
        preview=_one_line(subject or ""),
        status_kind="notification",
        metadata=_base_metadata(
            internal_id=internal_id, page_id=page_id, subject=subject,
            sender=sender_email, sender_name=sender_name, mailbox=mailbox,
            scenario="AIDraftStart",
            mascot=_resolve_mascot(sender_email) if sender_email else "default",
        ),
        intervention=None,
        expects_response=False,
    )
    _fire(env, internal_id=internal_id)


def dispatch_ai_draft_stream(
    *,
    internal_id: int,
    chunk_text: str,
    chunk_index: int = 0,
    sender_email: str = "",
    sender_name: str = "",
    subject: str = "",
    mailbox: str = "",
) -> None:
    """AI 起草流式更新 (高频, 仅在用户开了 expand 态时才视觉有意义)。

    metadata 携带 chunk index + 截断后的 chunk text (≤500 chars 防 envelope > 64KiB)。
    """
    if not _state.enabled:
        return
    metadata = _base_metadata(
        internal_id=internal_id, page_id="", subject=subject,
        sender=sender_email, sender_name=sender_name, mailbox=mailbox,
        scenario="AIDraftStream",
        mascot=_resolve_mascot(sender_email) if sender_email else "default",
    )
    metadata["mailagent.draftChunkIndex"] = str(chunk_index)
    metadata["mailagent.draftChunkText"] = (chunk_text or "")[:500]
    env = BridgeEnvelope(
        event_type="AIDraftStream",
        session_key=f"mailagent:email:{internal_id}",
        title=island_i18n.t("mail.ai.draft.stream.title"),
        preview=_one_line(chunk_text or "")[:80],
        status_kind="notification",
        metadata=metadata,
        intervention=None,
        expects_response=False,
    )
    _fire(env, internal_id=internal_id)


def dispatch_ai_draft_ready(
    *,
    internal_id: int,
    draft_text: str,
    sender_email: str = "",
    sender_name: str = "",
    subject: str = "",
    mailbox: str = "",
    page_id: str = "",
) -> None:
    """AI 草稿完成 — waitingForInput + send/edit/discard 三 option intervention。

    fork ``MailAgentSessionView`` AIDraftReady scenario 已 ship, 读 metadata
    ``mailagent.aiSummary`` 渲染草稿正文 (复用现有字段名)。
    """
    if not _state.enabled:
        return
    metadata = _base_metadata(
        internal_id=internal_id, page_id=page_id, subject=subject,
        sender=sender_email, sender_name=sender_name, mailbox=mailbox,
        scenario="AIDraftReady",
        mascot=_resolve_mascot(sender_email) if sender_email else "default",
        ai_summary=(draft_text or "")[:2000],
    )
    intervention = Intervention(
        title=island_i18n.t("mail.ai.draft.ready.title"),
        message=island_i18n.t("mail.ai.draft.ready.message"),
        options=[
            InterventionOption(id="send_draft",
                               title=island_i18n.t("mail.ai.draft.send")),
            InterventionOption(id="edit_draft",
                               title=island_i18n.t("mail.ai.draft.edit")),
            InterventionOption(id="discard_draft",
                               title=island_i18n.t("mail.ai.draft.discard")),
        ],
    )
    env = BridgeEnvelope(
        event_type="AIDraftReady",
        session_key=f"mailagent:email:{internal_id}",
        title=island_i18n.t("mail.ai.draft.ready.title"),
        preview=_one_line(draft_text or "")[:80],
        status_kind="waitingForInput",
        metadata=metadata,
        intervention=intervention,
        expects_response=True,
    )
    _fire(env, internal_id=internal_id)


# ─────────────────────────────────────────────────────────────────────────────
# P0-4: ActionAcked envelope — subprocess 结果回流 fork UI
# 用户点 fork 按钮 → mailagent 跑子进程 (mailagent notion update-flag / email
# unsubscribe 等); 当前 silent log → fork UI 不知道真实结果。新增 dispatch_action_acked
# 让 plugin 在 subprocess 完成后追发一条 envelope, fork 端读 metadata 即可。
# ─────────────────────────────────────────────────────────────────────────────


def dispatch_action_acked(
    *,
    internal_id: int,
    envelope_id: str,
    choice: str,
    ok: bool,
    error: str = "",
) -> None:
    """通知 fork: 用户 click 触发的 action 子进程已完成 (成功 or 失败)。

    成功 → ``status_kind=completed`` + preview=choice; 失败 → ``status_kind=error``
    + status_detail/preview=error。fork 端读以下 metadata 即可 (无需改 ClientProfile
    / brand 等 wire schema):

    - ``mailagent.actionAckedChoice``: 当时用户点的 option id (如 "mark_done")
    - ``mailagent.actionAckedEnvelopeId``: 触发的原 envelope id (correlation)
    - ``mailagent.actionAckedOk``: "true" / "false"
    - ``mailagent.error`` (失败时): 截 200 chars

    向后兼容: 老 fork 端不读这些 key, envelope 仍能正常解码 (生成的 wire 事件名是
    "Notification", fork dispatcher 接得住, 仅 metadata 多带几个字段)。
    """
    if not _state.enabled:
        return
    metadata = _base_metadata(
        internal_id=internal_id, page_id="",
        scenario="ActionAcked",
        error=(error or "")[:200] if not ok else "",
    )
    metadata["mailagent.actionAckedChoice"] = choice or ""
    metadata["mailagent.actionAckedEnvelopeId"] = envelope_id or ""
    metadata["mailagent.actionAckedOk"] = "true" if ok else "false"
    title_key = "mail.action.acked.ok" if ok else "mail.action.acked.fail"
    preview = choice if ok else (error or "")[:80]
    env = BridgeEnvelope(
        event_type="ActionAcked",
        session_key=f"mailagent:email:{internal_id}",
        title=island_i18n.t(title_key),
        preview=_one_line(preview),
        status_kind="completed" if ok else "error",
        status_detail=None if ok else (error or "")[:200],
        metadata=metadata,
        intervention=None,
        expects_response=False,
    )
    _fire(env, internal_id=internal_id)


# ─────────────────────────────────────────────────────────────────────────────
# 阶段2·2.5 — 会前提醒 (CalendarSyncWorker → calendar_sync/reminder.py 调用)。
# 文案内联双语, 不走 island_i18n key: locale 是 per-user 外部文件且 bootstrap
# _write_if_missing 不回填新 key → 已装机器会把新 key 渲染成裸 key (island_agent
# 同款理由, 见其 _AGENT_STRINGS 注释)。
# ─────────────────────────────────────────────────────────────────────────────

_MEETING_REMINDER_STRINGS = {
    "zh-CN": {"title": "会议即将开始", "untitled": "未命名事件"},
    "en-US": {"title": "Meeting starting soon", "untitled": "Untitled event"},
}


def _meeting_str(key: str) -> str:
    lang = island_i18n.resolve_lang()
    table = _MEETING_REMINDER_STRINGS.get(lang) or _MEETING_REMINDER_STRINGS["en-US"]
    return table.get(key) or _MEETING_REMINDER_STRINGS["en-US"][key]


def dispatch_meeting_reminder(
    *,
    ical_uid: str,
    occurrence_start_iso: str,
    summary: str,
    time_range_text: str,
    join_url: str = "",
    location: str = "",
) -> None:
    """会前 N 分钟提醒 → emit ``MeetingReminder`` (notification, 无 intervention).

    卡片能力以既有 announce 为准 (不扩 Ping Island 协议): Join 链接进 preview
    文案 + ``mailagent.joinUrl`` metadata (fork 日后想做点击动作时字段已在)。
    session_key 按 occurrence (uid + 开始时间) — dedup 粒度 = 单次发生, 配合
    §9-2 持久去重, 重启 5 分钟窗口内不重发。
    """
    if not _state.enabled:
        return
    summary_disp = _one_line(summary) or _meeting_str("untitled")
    preview_parts = [time_range_text]
    if join_url:
        preview_parts.append(join_url)
    elif location:
        preview_parts.append(_one_line(location, max_len=80))
    meta: Dict[str, str] = {
        **_state.extra_metadata,
        "mailagent.lang": island_i18n.resolve_lang(),
        "mailagent.theme": _state.theme,
        "mailagent.accent": _state.accent,
        "mailagent.scenario": "MeetingReminder",
        "mailagent.mascot": "default",
        "mailagent.icalUid": ical_uid,
        "mailagent.occurrenceStart": occurrence_start_iso,
        "mailagent.summary": summary_disp,
        # fork makeClientInfo brand 推导 — 见 _base_metadata 同段注释
        "client_kind": "mailagent",
        "client_name": "MailAgent",
        "client_origin": "plugin",
        "client_originator": "MailAgent",
        "thread_source": "mailagent-hooks",
    }
    if join_url:
        meta["mailagent.joinUrl"] = join_url
    if location:
        meta["mailagent.location"] = _one_line(location)
    env = BridgeEnvelope(
        event_type="MeetingReminder",
        session_key=f"mailagent:calendar:{ical_uid}:{occurrence_start_iso}",
        title=f"{_meeting_str('title')} / {summary_disp}",
        preview=_one_line(" · ".join(preview_parts)),
        status_kind="notification",
        metadata=meta,
        expects_response=False,
    )
    _fire(env, internal_id=None)


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


def _skip_option() -> InterventionOption:
    """问题 B: "跳过"次级 option, 让用户不选业务操作直接 dismiss (response 端 no-op)。"""
    from src.notify.island_action_whitelist import SKIP_ACTION_ID
    return InterventionOption(id=SKIP_ACTION_ID, title=island_i18n.t("mail.action.skip"))


def _with_skip_option(options: List[InterventionOption]) -> List[InterventionOption]:
    """业务 options 截到 2 个 + 末尾追加 skip, 保证总数 ≤3。

    fork interventionButtonRow 用 ``prefix(3)`` 渲染前 3 个 button; skip 必须显示, 所以
    业务 option 最多留 2 个 (``options[:2]``) 再加 skip。
    """
    return list(options[:2]) + [_skip_option()]


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


# task 06-10 (prd Fix 2d): _fire 的 background task 强引用集合 — Python 3.11
# asyncio loop 只弱引用 task, 无强引用的 pending task 可能被 GC 中途回收
# (同类生产实证见 new_watcher._rollout_flush_task 注释)。done 后自动 discard。
_bg_tasks: set = set()


def _fire(envelope: BridgeEnvelope, *, internal_id: Optional[int]) -> None:
    """把 send_async 包成 background task；记录 dispatch 结果."""
    # 问题 A 去重: 同 (session_key, event_type) 在 DEDUP_WINDOW_SEC 内重复 → 静默 skip。
    # 契约 §9-2: 传 internal_id 让持久去重按邮件精确匹配 island_dispatch 表。
    if _dedup_should_skip(envelope.session_key, envelope.event_type, internal_id):
        log.debug(
            "[island] dedup skip %s session_key=%s (within %ds window)",
            envelope.event_type, envelope.session_key, DEDUP_WINDOW_SEC,
        )
        return
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
            # P0-3: 带 status_kind 让 reconnect queue 做优先级保留 (completed /
            # error / waitingForInput 不被 queue 满淘汰除非 notification 已空)。
            try:
                island_reconnect.enqueue(
                    envelope.encode(),
                    status_kind=envelope.status_kind,
                    internal_id=internal_id,
                    event_type=envelope.event_type,
                )
            except Exception as e:  # noqa: BLE001
                log.debug("[island] enqueue backlog failed: %s", e)

        _record_dispatch(
            envelope, internal_id, ok=result.ok,
            latency_ms=result.latency_ms, response_decision=decision,
        )

        if result.ok and result.response is not None:
            # 用户在灵动岛点过 option（3s 内的同步回写；异步点击走解耦 ack 通道）
            try:
                from src.notify import island_response
                await island_response.handle_response(result.response, envelope.metadata)
            except Exception as e:  # noqa: BLE001
                log.warning("[island] response handler error: %s", e)

    # 契约 §6/§9-4: 带按钮的 envelope 发送前登记解耦 ack pending + 注入 ack_token,
    # 让 ping-island 按钮点击可经 serve-api /api/island/ack 异步回灌 (不受 3s 限制)。
    _register_ack_if_intervention(envelope, internal_id)

    task = loop.create_task(_bg())
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)


def _register_ack_if_intervention(
    envelope: BridgeEnvelope, internal_id: Optional[int]
) -> None:
    """带按钮 (expects_response + intervention) 的 envelope → 登记解耦 ack pending。

    生成 ``ack_token`` 注入 ``envelope.metadata`` (随 wire 发给 ping-island)。跨进程落
    SQLite (serve-api ack 端点在另一进程 resolve)。fail-open: 任何失败仅 debug, 不阻断发送。
    """
    if not (envelope.expects_response and envelope.intervention is not None):
        return
    store = _state.sync_store
    db_path = getattr(store, "db_path", None) if store is not None else None
    if not db_path:  # 无 store / 无 db_path (测试 fake) → 跳过, 不建垃圾库
        return
    try:
        from src.notify import island_ack
        from src.notify.island_envelope import deterministic_envelope_id

        meta_for_ack = dict(envelope.metadata)
        # tool_use_id 供 handle_response._extract_envelope_id (ActionAcked 关联)
        meta_for_ack.setdefault(
            "tool_use_id",
            f"bridge-{deterministic_envelope_id(envelope.session_key, envelope.event_type)}",
        )
        token = island_ack.register(
            str(db_path),
            kind="mail",
            session_key=envelope.session_key,
            event_type=envelope.event_type,
            metadata=meta_for_ack,
            choices={opt.id for opt in envelope.intervention.options},
            internal_id=internal_id,
        )
        # codex Fix 4: register 落库失败返 None → 不注入永远 resolve 不了的 ack_token（envelope
        # 仍发，按钮 no-op，等同 ack 通道上线前现状）。仅在拿到 token 时才带 ack_token/ack_url。
        if token:
            envelope.metadata["ack_token"] = token
            # serve-api ack 端点 URL 随 envelope 带出 (fork 读它, 避免硬编码端口)。
            # MAILAGENT_API_PORT 由 BackendLifecycleManager 与 serve-api 同 env 注入 (默认 8200)。
            api_port = os.environ.get("MAILAGENT_API_PORT", "8200")
            envelope.metadata["ack_url"] = f"http://127.0.0.1:{api_port}/api/island/ack"
        else:
            log.warning("[island] ack register no token — notification sent without ack")
    except Exception as e:  # noqa: BLE001
        log.debug("[island] ack register failed (fail-open): %s", e)


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
