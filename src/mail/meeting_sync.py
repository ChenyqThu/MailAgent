"""会议邀请同步器

检测邮件中的 iCalendar 会议邀请，同步到 Notion 日程数据库。
支持邮件与日程的双向关联，并按 RFC 5545 语义处理周期会议
（RRULE 主系列展开 / RECURRENCE-ID 单实例 override / CANCEL 系列或单次）。

核心流程（按 (METHOD, RECURRENCE-ID) 4 象限分派）：

| METHOD  | RECURRENCE-ID | Handler                  |
|---------|--------------|--------------------------|
| REQUEST | None         | _handle_master_request   |
| REQUEST | set          | _handle_override_request |
| CANCEL  | None         | _handle_series_cancel    |
| CANCEL  | set          | _handle_instance_cancel  |

非周期会议（无 RRULE 且无 RECURRENCE-ID）继续走原有的单事件路径，行为零变化。

Usage:
    sync = MeetingInviteSync(sync_store=store)
    page_id, invite = await sync.process_email(email_source, message_id)
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple, TYPE_CHECKING

from loguru import logger

from src.calendar_notion.recurrence import (
    compute_since,
    expand_occurrences,
    mint_event_id,
)
from src.calendar_notion.sync import CalendarNotionSync
from src.mail.icalendar_parser import ICalendarParser, MeetingInvite
from src.models import CalendarEvent

if TYPE_CHECKING:
    from src.mail.sync_store import SyncStore


# 默认未来展开窗口（周）。运行时可由 main.py 的 expansion loop 用更大值覆盖。
DEFAULT_HORIZON_WEEKS = 4


class MeetingInviteSync:
    """会议邀请同步器（含周期展开）"""

    def __init__(
        self,
        calendar_db_id: Optional[str] = None,
        sync_store: Optional["SyncStore"] = None,
    ):
        """
        Args:
            calendar_db_id: Notion 日程数据库 ID，默认从配置读取
            sync_store: SyncStore 实例（recurring_series 表）。为 None 时退化为单事件路径，
                        所有周期会议视为单次（保留向后兼容）
        """
        self.parser = ICalendarParser()
        self.calendar_sync = CalendarNotionSync()
        self.sync_store = sync_store

        if calendar_db_id:
            self.calendar_sync.database_id = calendar_db_id

        self._stats = {
            "invites_detected": 0,
            "events_created": 0,
            "events_updated": 0,
            "events_skipped": 0,
            "events_cancelled": 0,
            "errors": 0,
            "series_upserts": 0,
            "occurrences_synced": 0,
            "relabel_applied": 0,
            "out_of_order_skipped": 0,
        }

    def has_meeting_invite(self, email_source: str) -> bool:
        """快速检查邮件是否包含会议邀请"""
        return self.parser.has_calendar_invite(email_source)

    async def process_email(
        self, email_source: str, message_id: Optional[str] = None
    ) -> Tuple[Optional[str], Optional[MeetingInvite]]:
        """处理邮件，按周期语义同步到日程。

        Returns:
            (代表性日程 page_id, MeetingInvite) - 周期主请求返回首次 occurrence 的 page_id
            非会议邀请返回 (None, None)
        """
        invite = self.parser.extract_from_email_source(email_source)
        if not invite:
            return None, None

        self._stats["invites_detected"] += 1
        msg_id_short = (message_id or "unknown")[:40]
        logger.info(
            f"Detected meeting invite: {invite.summary[:50]}... "
            f"(UID: {invite.uid[:40]}..., method: {invite.method}, "
            f"recurring: {bool(invite.recurrence_rule)}, "
            f"override: {invite.recurrence_id is not None}, "
            f"from: {msg_id_short})"
        )

        try:
            method = (invite.method or "REQUEST").upper()
            has_rec_id = invite.recurrence_id is not None

            if method == "REQUEST" and not has_rec_id:
                return await self._handle_master_request(invite, message_id)
            if method == "REQUEST" and has_rec_id:
                return await self._handle_override_request(invite, message_id)
            if method == "CANCEL" and not has_rec_id:
                return await self._handle_series_cancel(invite, message_id)
            if method == "CANCEL" and has_rec_id:
                return await self._handle_instance_cancel(invite, message_id)

            # REPLY 或其他 method 暂不入 MVP，走单事件路径保持兼容
            return await self._sync_single_event(invite)

        except Exception as e:
            self._stats["errors"] += 1
            logger.error(f"Failed to process meeting invite: {e}")
            import traceback
            logger.debug(traceback.format_exc())
            return None, invite

    # ==================== 单事件兜底（无 RRULE 且无 RECURRENCE-ID） ====================

    async def _sync_single_event(
        self, invite: MeetingInvite
    ) -> Tuple[Optional[str], MeetingInvite]:
        """退化路径：把一封邀请当作单次会议同步（旧行为）。"""
        event = self.parser.to_calendar_event(invite)
        action, page_id = await self.calendar_sync.sync_event(event)
        self._tally_action(action)
        return page_id, invite

    # ==================== REQUEST + 无 RECURRENCE-ID = 主请求 ====================

    async def _handle_master_request(
        self, invite: MeetingInvite, message_id: Optional[str]
    ) -> Tuple[Optional[str], MeetingInvite]:
        """主邀请请求处理：upsert series + 展开 + 多 occurrence sync。"""
        if not invite.recurrence_rule:
            # 非周期会议（解析层 _parse_rrule 拒绝或本身就是单次）→ 单事件路径
            return await self._sync_single_event(invite)

        if self.sync_store is None:
            # 缺 SyncStore（理论上不应发生，向后兼容）
            logger.warning(
                f"[meeting] sync_store missing, recurring UID={invite.uid[:60]} "
                f"falling back to single-event mode"
            )
            return await self._sync_single_event(invite)

        # 1. 取已有 series_state
        series_state = self.sync_store.get_recurring_series(invite.uid)

        # 2. SEQUENCE 反序保护
        if series_state and invite.sequence < int(series_state.get("last_sequence") or 0):
            logger.debug(
                f"[meeting] out-of-order REQUEST UID={invite.uid[:60]} "
                f"sequence={invite.sequence} < last={series_state['last_sequence']}, skip"
            )
            self._stats["out_of_order_skipped"] += 1
            return None, invite

        # 3. Inline relabel: 旧版本可能已存在裸 UID 页面（pre-feature 创建）
        first_page_id = await self._maybe_relabel_legacy_master(invite)

        # 4. UPSERT recurring_series
        self.sync_store.upsert_recurring_series(
            {
                "series_uid": invite.uid,
                "rrule_str": invite.recurrence_rule,
                "exdates_json": json.dumps(
                    [dt.isoformat() for dt in invite.exdates]
                ),
                "rdates_json": json.dumps(
                    [dt.isoformat() for dt in invite.rdates]
                ),
                "master_dtstart": invite.start_time.isoformat(),
                "master_dtend": invite.end_time.isoformat(),
                "master_summary": invite.summary,
                "master_organizer": invite.organizer,
                "master_organizer_email": invite.organizer_email,
                "master_location": invite.location,
                "master_description": invite.description,
                "master_tzid": invite.tzid,
                "master_is_all_day": int(invite.is_all_day),
                "last_sequence": invite.sequence,
                "last_seen_message_id": message_id,
                "last_modified": datetime.now(timezone.utc).isoformat(),
            }
        )
        self._stats["series_upserts"] += 1

        # 5. 计算 since: max(本周一, master_dtstart, last_expanded_until)
        now = datetime.now(timezone.utc)
        last_until_str = (series_state or {}).get("last_expanded_until")
        last_until = (
            datetime.fromisoformat(last_until_str) if last_until_str else None
        )
        since = compute_since(now, invite.start_time, last_until)

        # 6. 展开 occurrences
        # 注意：series_state 必须含最新 exdates_json（含本次 invite 的 EXDATE），
        # 用刚 upsert 的内容，需要从 store 重新读
        fresh_state = self.sync_store.get_recurring_series(invite.uid)
        occurrences = expand_occurrences(
            invite, since=since, horizon_weeks=DEFAULT_HORIZON_WEEKS, series_state=fresh_state
        )
        if not occurrences:
            logger.info(
                f"[meeting] no occurrences in window for UID={invite.uid[:60]} "
                f"since={since.isoformat()}; nothing to sync"
            )
            # 更新高水位以防后续 loop 再扫
            self.sync_store.update_expanded_until(
                invite.uid, (since + timedelta(weeks=DEFAULT_HORIZON_WEEKS)).isoformat()
            )
            return first_page_id, invite

        # 7. 同步 occurrences；记录代表性 page_id
        synced_first_page_id = first_page_id
        for occ in occurrences:
            try:
                action, page_id = await self.calendar_sync.sync_event(occ)
                self._tally_action(action)
                self._stats["occurrences_synced"] += 1
                if synced_first_page_id is None:
                    synced_first_page_id = page_id
            except Exception as e:
                logger.error(f"[meeting] occurrence sync failed: {e}")
                self._stats["errors"] += 1

        # 8. 更新高水位
        self.sync_store.update_expanded_until(
            invite.uid, (since + timedelta(weeks=DEFAULT_HORIZON_WEEKS)).isoformat()
        )

        return synced_first_page_id, invite

    async def _maybe_relabel_legacy_master(
        self, invite: MeetingInvite
    ) -> Optional[str]:
        """检测裸 UID 旧页面并 inline relabel 为首次 occurrence event_id。

        Returns:
            relabel 后的 page_id（或 None 若没有遗留页面）
        """
        existing = await self.calendar_sync._find_existing_event(invite.uid)
        if not existing:
            return None

        first_event_id = mint_event_id(invite.uid, invite.start_time)
        if first_event_id == invite.uid:
            # 不应发生（mint 必带 @），但兜底
            return existing["id"]

        ok = await self.calendar_sync.relabel_event_id(existing["id"], first_event_id)
        if ok:
            self._stats["relabel_applied"] += 1
            logger.info(
                f"[meeting] inline-relabel UID={invite.uid[:60]} "
                f"→ Event ID={first_event_id} page={existing['id']}"
            )
        return existing["id"]

    # ==================== REQUEST + 有 RECURRENCE-ID = 单实例 override ====================

    async def _handle_override_request(
        self, invite: MeetingInvite, message_id: Optional[str]
    ) -> Tuple[Optional[str], MeetingInvite]:
        """单实例 override：sync 一个新/已有 occurrence + EXDATE 防 loop 重建原时间。"""
        event = self.parser.to_override_event(invite)
        action, page_id = await self.calendar_sync.sync_event(event)
        self._tally_action(action)

        # 把原始 RECURRENCE-ID 写入持久 EXDATE，避免后续 loop 重建那个时间点
        if self.sync_store is not None and invite.recurrence_id is not None:
            self.sync_store.append_exdate(
                invite.uid, invite.recurrence_id.isoformat()
            )

        return page_id, invite

    # ==================== CANCEL + 无 RECURRENCE-ID = 整系列取消 ====================

    async def _handle_series_cancel(
        self, invite: MeetingInvite, message_id: Optional[str]
    ) -> Tuple[Optional[str], MeetingInvite]:
        """取消整个系列：所有未来 occurrences 标记 cancelled，过去保留。"""
        prefix = f"{invite.uid}@"
        pages = await self.calendar_sync.find_by_event_id_prefix(prefix, future_only=True)

        # 兜底: 如果没有 @ 后缀的页面（pre-feature 数据），尝试裸 UID
        if not pages:
            existing = await self.calendar_sync._find_existing_event(invite.uid)
            if existing:
                pages = [existing]

        cancelled = 0
        for page in pages:
            page_id = page.get("id")
            if not page_id:
                continue
            if await self.calendar_sync.mark_cancelled(page_id):
                cancelled += 1

        self._stats["events_cancelled"] += cancelled
        logger.info(
            f"[meeting] series cancel UID={invite.uid[:60]} → "
            f"{cancelled}/{len(pages)} pages marked cancelled"
        )

        # 标记 series 行的 last_modified
        if self.sync_store is not None:
            existing_series = self.sync_store.get_recurring_series(invite.uid)
            if existing_series:
                self.sync_store.upsert_recurring_series(
                    {
                        **existing_series,
                        "last_modified": datetime.now(timezone.utc).isoformat(),
                        "last_seen_message_id": message_id,
                    }
                )

        # 返回首个被取消的 page_id 作为代表
        rep_id = pages[0]["id"] if pages else None
        return rep_id, invite

    # ==================== CANCEL + 有 RECURRENCE-ID = 单实例取消 ====================

    async def _handle_instance_cancel(
        self, invite: MeetingInvite, message_id: Optional[str]
    ) -> Tuple[Optional[str], MeetingInvite]:
        """取消单次实例：找到 {uid}@{ts} 页面 → cancelled + 持久 EXDATE。"""
        if invite.recurrence_id is None:
            return None, invite

        event_id = mint_event_id(invite.uid, invite.recurrence_id)
        existing = await self.calendar_sync._find_existing_event(event_id)

        page_id = None
        if existing:
            page_id = existing.get("id")
            if page_id and await self.calendar_sync.mark_cancelled(page_id):
                self._stats["events_cancelled"] += 1
                logger.info(
                    f"[meeting] instance cancel UID={invite.uid[:60]} "
                    f"recurrence_id={invite.recurrence_id.isoformat()} page={page_id}"
                )

        if self.sync_store is not None:
            self.sync_store.append_exdate(invite.uid, invite.recurrence_id.isoformat())

        return page_id, invite

    # ==================== Helpers ====================

    def _tally_action(self, action: str) -> None:
        if action == "created":
            self._stats["events_created"] += 1
        elif action == "updated":
            self._stats["events_updated"] += 1
        elif action == "skipped":
            self._stats["events_skipped"] += 1

    async def update_email_relation(
        self, calendar_page_id: str, email_page_id: str
    ) -> bool:
        """更新日程页面的 Source Email 关联（保持原有 API）"""
        try:
            await self.calendar_sync.client.pages.update(
                page_id=calendar_page_id,
                properties={
                    "Source Email": {"relation": [{"id": email_page_id}]}
                },
            )
            logger.debug(
                f"Updated Source Email relation: {calendar_page_id} -> {email_page_id}"
            )
            return True
        except Exception as e:
            logger.warning(f"Failed to update Source Email relation: {e}")
            return False

    def get_stats(self) -> Dict[str, Any]:
        """获取统计信息"""
        return self._stats.copy()

    def reset_stats(self):
        """重置统计信息"""
        for key in self._stats:
            self._stats[key] = 0
