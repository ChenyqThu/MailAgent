"""
会议邀请同步器

检测邮件中的 iCalendar 会议邀请，同步到 Notion 日程数据库。
同时支持邮件与日程的双向关联。

核心流程：
1. 检测邮件是否包含 text/calendar MIME 部分
2. 解析 iCalendar 提取会议信息
3. 使用 UID 查找或创建日程页面
4. 返回日程 page_id 用于邮件关联

Usage:
    sync = MeetingInviteSync()
    calendar_page_id = await sync.process_email(email_source, message_id)
    if calendar_page_id:
        # 在邮件页面中设置 Email Events 关联
        pass
"""

from typing import Optional, Dict, Any, Tuple, TYPE_CHECKING

if TYPE_CHECKING:
    from src.mail.icalendar_parser import MeetingInvite
from datetime import datetime, timezone
from loguru import logger

from src.mail.icalendar_parser import ICalendarParser, MeetingInvite
from src.calendar_notion.sync import CalendarNotionSync
from src.models import CalendarEvent


class MeetingInviteSync:
    """会议邀请同步器"""

    def __init__(self, calendar_db_id: str = None):
        """
        Args:
            calendar_db_id: Notion 日程数据库 ID，默认从配置读取
        """
        from src.config import config

        self.parser = ICalendarParser()
        self.calendar_sync = CalendarNotionSync()

        # 如果指定了不同的数据库 ID，覆盖默认值
        if calendar_db_id:
            self.calendar_sync.database_id = calendar_db_id

        self._stats = {
            "invites_detected": 0,
            "events_created": 0,
            "events_updated": 0,
            "events_skipped": 0,
            "events_cancelled": 0,
            "errors": 0,
        }

    def has_meeting_invite(self, email_source: str) -> bool:
        """快速检查邮件是否包含会议邀请

        Args:
            email_source: 邮件 MIME 源码

        Returns:
            是否包含 iCalendar 会议邀请
        """
        return self.parser.has_calendar_invite(email_source)

    async def process_email(self, email_source: str, message_id: str = None) -> Tuple[Optional[str], Optional['MeetingInvite']]:
        """处理邮件，如果是会议邀请则同步到日程

        Args:
            email_source: 邮件 MIME 源码
            message_id: 邮件 Message-ID（用于日志）

        Returns:
            (日程页面 ID, MeetingInvite 对象) - 如果不是会议邀请则都是 None
        """
        # 1. 提取会议邀请
        invite = self.parser.extract_from_email_source(email_source)
        if not invite:
            return None, None

        self._stats["invites_detected"] += 1
        msg_id_short = (message_id or "unknown")[:40]
        logger.info(f"Detected meeting invite: {invite.summary[:50]}... (UID: {invite.uid[:40]}..., from: {msg_id_short})")

        try:
            # 2. 转换为 CalendarEvent
            event = self.parser.to_calendar_event(invite)

            # 3. 同步到 Notion
            action, page_id = await self.calendar_sync.sync_event(event)

            if action == "created":
                self._stats["events_created"] += 1
                logger.info(f"Created calendar event from email: {invite.summary[:40]}... -> {page_id}")
            elif action == "updated":
                self._stats["events_updated"] += 1
                logger.info(f"Updated calendar event from email: {invite.summary[:40]}... -> {page_id}")
            elif action == "skipped":
                self._stats["events_skipped"] += 1
                logger.debug(f"Skipped unchanged calendar event: {invite.summary[:40]}...")

            # 会议取消特殊处理
            if invite.method == "CANCEL":
                self._stats["events_cancelled"] += 1
                logger.info(f"Meeting cancelled: {invite.summary[:40]}...")

            return page_id, invite

        except Exception as e:
            self._stats["errors"] += 1
            logger.error(f"Failed to sync meeting invite: {e}")
            import traceback
            logger.debug(traceback.format_exc())
            return None, None

    async def update_email_relation(self, calendar_page_id: str, email_page_id: str) -> bool:
        """更新日程页面的 Source Email 关联

        Args:
            calendar_page_id: 日程页面 ID
            email_page_id: 邮件页面 ID

        Returns:
            是否成功
        """
        try:
            await self.calendar_sync.client.pages.update(
                page_id=calendar_page_id,
                properties={
                    "Source Email": {
                        "relation": [{"id": email_page_id}]
                    }
                }
            )
            logger.debug(f"Updated Source Email relation: {calendar_page_id} -> {email_page_id}")
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
