"""DailyDigest 编排 + 定时 loop (Phase B).

灵动岛"今日总结"巡检的编排层。把 Phase A 的纯数据/LLM 函数 (digest_query +
digest_summarizer) 串起来 → 通过 island_dispatch 推一条 ``DailyDigest`` envelope:

1. ``run_digest_once`` — 单次巡检编排:
   fetch_recent_emails → compute_counts → select_bulk_candidates → summarize_digest
   → dispatch_daily_digest。决策点 7: unread + urgent 全 0 跳过不推 (仍 set_state 防重试)。
   summarize 失败降级 (plan §3 决策 3 第 5 点): headline = 模板, summary_md 空,
   confirmed 用代码候选直接转 (LLM 挂也能推纯 counts digest)。
2. ``tick_loop`` — 照 ``island_snooze.tick_loop`` (60s tick + 可中断 sleep) 结构,
   每 tick 算当前是否落在某未触发过的 fire window (决策点 4) → 命中则 run_once。

决策点 1 (DND): ``_should_suppress`` 钩子默认 ``return False`` (Phase 4 接 DND/活跃检测)。
决策点 4 (定时): fire-window 命中 + last-fire gate (sync_store state) + 开机补推
"当天最近一个未推过的 slot" (不补历史多次)。
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, List, Optional, Tuple

from src.config import config
from src.llm_agent.digest_summarizer import DigestSummary, summarize_digest
from src.notify import digest_query
from src.notify.island_dispatch import DigestBulkAction, dispatch_daily_digest

log = logging.getLogger(__name__)

_BEIJING = timezone(timedelta(hours=8))

# 落在 fire 钟点后 ``FIRE_WINDOW_MIN`` 分钟内算"该 window";超出当前钟点 window 但
# 进程刚开机 → _missed_catchup_slot 兜底补推。
FIRE_WINDOW_MIN = 30
TICK_INTERVAL_SEC = 60

# sync_store state key: 记最近一次成功 fire 的 slot ("YYYYMMDD-HH")，防同 window 重复推。
_LAST_FIRE_STATE_KEY = "last_daily_digest_fire"


def _parse_fire_hours(raw: str) -> List[int]:
    """解析 config ``mailagent_daily_digest_hours`` ("9,18" → [9, 18])。

    非法 token 跳过; 越界 (< 0 或 > 23) 跳过; 去重保序; 空 → []。
    """
    hours: List[int] = []
    seen: set = set()
    for tok in (raw or "").split(","):
        tok = tok.strip()
        if not tok:
            continue
        try:
            h = int(tok)
        except (TypeError, ValueError):
            continue
        if h < 0 or h > 23 or h in seen:
            continue
        seen.add(h)
        hours.append(h)
    return hours


def _slot_id(now: datetime, hour: int) -> str:
    """``(date, hour)`` → slot 标识 "YYYYMMDD-HH" (HH 零填充)。"""
    return f"{now.strftime('%Y%m%d')}-{hour:02d}"


def _current_fire_slot(now: datetime, fire_hours: List[int]) -> Optional[str]:
    """``now`` (北京) 若落在某 fire window ``[HH:00, HH:00 + FIRE_WINDOW_MIN)`` 内,
    返回该 slot "YYYYMMDD-HH"; 否则 None。
    """
    for h in fire_hours:
        if now.hour == h and now.minute < FIRE_WINDOW_MIN:
            return _slot_id(now, h)
    return None


def _already_fired(sync_store: Any, slot: str) -> bool:
    """``state('last_daily_digest_fire') == slot`` ? (防同一 window 重复推)。"""
    try:
        return sync_store.get_state(_LAST_FIRE_STATE_KEY) == slot
    except Exception as e:  # noqa: BLE001
        log.debug("[daily-digest] get_state failed: %s", e)
        return False


def _missed_catchup_slot(
    now: datetime, sync_store: Any, fire_hours: List[int]
) -> Optional[str]:
    """开机补推: 当天**已过的最近一个** fire 钟点, 其 slot 未触发过 → 返回它。

    只补"当天最近一个", 不补历史多次 (digest 是当下 24h 快照, 补 3 天前无意义)。
    跨过钟点 window 末尾才开机 (如 9:45) 也认为当天 9:00 slot 该补 (用现在的 24h 快照)。
    """
    today_hours = sorted(h for h in fire_hours if h <= now.hour)
    for h in reversed(today_hours):
        slot = _slot_id(now, h)
        if not _already_fired(sync_store, slot):
            return slot
    return None


def _should_suppress() -> bool:
    """决策点 1 钩子: 是否抑制推送 (DND / 专注模式)。

    MVP 不读系统 DND (无稳定 API + FDA/sandbox 风险 + digest 低频被动通知)。
    Phase 4 智能 snooze 接 DND/活跃检测时只改这一个函数, 不动主流程。
    """
    return False


def _build_dispatch_actions(
    summary: DigestSummary,
    candidates: List[digest_query.BulkCandidate],
) -> List[DigestBulkAction]:
    """把 ``DigestSummary.confirmed_actions`` (LLM 挑的 id + 文案) 跟
    ``BulkCandidate.internal_ids`` (代码候选的 ids) 按 action_id 配对。

    LLM 只挑了 id + 写文案; internal_ids 始终来自代码候选 (爆炸半径限定在文案)。
    LLM 挑的 id 在候选里找不到 ids → 跳过该 action (无 ids 的 bulk 按钮无意义)。
    """
    ids_by_id = {c.action_id: list(c.internal_ids) for c in candidates}
    out: List[DigestBulkAction] = []
    for a in summary.confirmed_actions:
        ids = ids_by_id.get(a.id)
        if not ids:
            log.debug(
                "[daily-digest] confirmed action %s has no code candidate ids; 跳过", a.id
            )
            continue
        out.append(
            DigestBulkAction(id=a.id, title=a.title, detail=a.detail, internal_ids=ids)
        )
    return out


def _candidates_to_dispatch_fallback(
    candidates: List[digest_query.BulkCandidate],
) -> List[DigestBulkAction]:
    """summarize 失败降级: 用代码候选直接转 DigestBulkAction (无 LLM 文案)。

    title 用代码生成的占位 (dispatch 端会按 len(ids) 校准数字), detail 空。
    """
    out: List[DigestBulkAction] = []
    for c in candidates:
        out.append(
            DigestBulkAction(
                id=c.action_id,
                title=_fallback_title(c.action_id, c.count),
                detail="",
                internal_ids=list(c.internal_ids),
            )
        )
    return out


def _fallback_title(action_id: str, count: int) -> str:
    """降级路径下的中文按钮文案 (LLM 不可用时)。dispatch 端仍按 len(ids) 校准数字。"""
    if action_id == "bulk_archive_newsletter":
        return f"归档 {count} 封"
    if action_id == "bulk_mark_read":
        return f"标记 {count} 封已读"
    if action_id == "bulk_mark_done":
        return f"标记 {count} 封完成"
    return f"处理 {count} 封"


async def run_digest_once(
    *,
    sync_store: Any,
    repo: Any,
    slot: str,
    now: Optional[datetime] = None,
    dispatch_fn: Callable[..., None] = dispatch_daily_digest,
    summarize_fn: Callable[..., Awaitable[DigestSummary]] = summarize_digest,
    max_emails: int = 50,
    window_hours: int = 24,
    max_bulk_ids: int = 30,
) -> bool:
    """单次巡检编排; 返回是否真推了 envelope (跳过 / 异常 → False)。

    流程: fetch_recent_emails → compute_counts → select_bulk_candidates →
    summarize_digest → dispatch_daily_digest。

    - 决策点 7: unread + urgent 全 0 → 跳过不推 (无事不扰), 仍 set_state 防重试。
    - summarize 失败降级: headline = 模板, summary_md 空, confirmed 用代码候选直接转。
    - 无论推没推, 最后都 set_state(slot) 记 fire (避免同 window 反复重试)。
    """
    now = now or datetime.now(_BEIJING)
    fired = False
    try:
        briefs = digest_query.fetch_recent_emails(
            repo, sync_store, window_hours=window_hours, max_emails=max_emails, now=now
        )
        counts = digest_query.compute_counts(briefs)
        candidates = digest_query.select_bulk_candidates(briefs, max_ids=max_bulk_ids)

        unread = int(counts.get("unread", 0))
        urgent = int(counts.get("urgent", 0))

        # 决策点 7: 无未读 + 无紧急 → 跳过不推 (无事不扰)
        if unread == 0 and urgent == 0:
            log.info("[daily-digest] slot=%s unread=0 urgent=0, skip (无事不扰)", slot)
        else:
            summary, actions = await _summarize_with_fallback(
                briefs=briefs,
                counts=counts,
                candidates=candidates,
                now=now,
                summarize_fn=summarize_fn,
                unread=unread,
                urgent=urgent,
            )
            dispatch_fn(
                digest_date=slot.split("-")[0],
                headline=summary.headline,
                summary_md=summary.summary_md,
                unread=unread,
                urgent=urgent,
                confirmed_actions=actions,
                max_bulk_ids=max_bulk_ids,
            )
            fired = True
            log.info(
                "[daily-digest] slot=%s dispatched (unread=%d urgent=%d actions=%d)",
                slot, unread, urgent, len(actions),
            )
    except Exception as e:  # noqa: BLE001
        log.warning("[daily-digest] run_digest_once slot=%s failed: %s", slot, e)
    finally:
        # 记 fire (即使跳过 / 异常也记, 避免同 window 每 tick 反复重试)
        try:
            sync_store.set_state(_LAST_FIRE_STATE_KEY, slot)
        except Exception as e:  # noqa: BLE001
            log.debug("[daily-digest] set_state failed: %s", e)
    return fired


async def _summarize_with_fallback(
    *,
    briefs: List[digest_query.DigestEmailBrief],
    counts: dict,
    candidates: List[digest_query.BulkCandidate],
    now: datetime,
    summarize_fn: Callable[..., Awaitable[DigestSummary]],
    unread: int,
    urgent: int,
) -> Tuple[DigestSummary, List[DigestBulkAction]]:
    """调 summarize_fn; 失败降级为纯 counts digest (headline 模板 + 代码候选 actions)。"""
    emails_brief = [asdict(b) for b in briefs]
    bulk_candidates = [
        {
            "id": c.action_id,
            "count": c.count,
            "sample_subjects": list(c.sample_subjects),
        }
        for c in candidates
    ]
    try:
        summary = await summarize_fn(
            emails_brief=emails_brief,
            counts=counts,
            bulk_candidates=bulk_candidates,
            now=now,
        )
        actions = _build_dispatch_actions(summary, candidates)
        return summary, actions
    except Exception as e:  # noqa: BLE001
        log.warning("[daily-digest] summarize failed, 降级纯 counts digest: %s", e)
        fallback = DigestSummary(
            headline=f"今日 {unread} 未读 / {urgent} 紧急",
            summary_md="",
        )
        actions = _candidates_to_dispatch_fallback(candidates)
        return fallback, actions


async def tick_loop(
    *,
    sync_store: Any,
    run_once: Callable[..., Awaitable[Any]],
    shutdown_event: Optional[asyncio.Event] = None,
    interval_sec: int = TICK_INTERVAL_SEC,
    fire_hours: Optional[List[int]] = None,
    now_fn: Callable[[], datetime] = lambda: datetime.now(_BEIJING),
) -> None:
    """每 ``interval_sec`` 秒 tick 一次, 命中未触发的 fire window 则 ``await run_once(slot)``。

    照 ``island_snooze.tick_loop`` 结构 (可中断 sleep)。每 tick:
    slot = _current_fire_slot(now) or _missed_catchup_slot(...);
    slot 非空 且 not _already_fired 且 not _should_suppress → await run_once(slot)。
    """
    fh = fire_hours if fire_hours is not None else _parse_fire_hours(
        config.mailagent_daily_digest_hours
    )
    log.debug(
        "[daily-digest] tick_loop started (interval=%ds, fire_hours=%s)", interval_sec, fh
    )
    while shutdown_event is None or not shutdown_event.is_set():
        try:
            now = now_fn()
            slot = _current_fire_slot(now, fh) or _missed_catchup_slot(
                now, sync_store, fh
            )
            if slot and not _already_fired(sync_store, slot) and not _should_suppress():
                await run_once(slot)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("[daily-digest] tick error: %s", e)
        try:
            if shutdown_event is None:
                await asyncio.sleep(interval_sec)
            else:
                await asyncio.wait_for(shutdown_event.wait(), timeout=interval_sec)
                break
        except asyncio.TimeoutError:
            continue
