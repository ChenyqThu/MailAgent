"""
日历读取模块 - 使用 EventKit 读取 macOS 日历事件
"""

from datetime import datetime, timedelta, timezone
from typing import List, Optional
from loguru import logger

from src.config import config
from src.models import CalendarEvent, Attendee, EventStatus


class CalendarReader:
    """使用 EventKit 读取 macOS 日历事件"""

    def __init__(self):
        self.calendar_name = config.calendar_name
        self._store = None
        self._target_calendar = None
        self._initialized = False

    def _init_eventkit(self) -> bool:
        """初始化 EventKit（延迟加载）"""
        if self._initialized:
            return True

        try:
            import EventKit
            from Foundation import NSDate
            import threading

            self._EventKit = EventKit
            self._NSDate = NSDate

            # 创建事件存储
            self._store = EventKit.EKEventStore.alloc().init()

            # 请求访问权限
            access_granted = [None]
            done_event = threading.Event()

            def completion_handler(granted, error):
                access_granted[0] = granted
                done_event.set()

            self._store.requestAccessToEntityType_completion_(
                EventKit.EKEntityTypeEvent,
                completion_handler
            )

            done_event.wait(timeout=30)

            if not access_granted[0]:
                logger.error("日历访问被拒绝，请在 系统设置 > 隐私与安全 > 日历 中授权")
                return False

            # 查找目标日历
            calendars = self._store.calendarsForEntityType_(EventKit.EKEntityTypeEvent)
            for cal in calendars:
                source = cal.source()
                source_type = source.sourceType() if source else -1
                # Exchange 类型 = 1，且名称匹配
                if source_type == 1 and cal.title() == self.calendar_name:
                    self._target_calendar = cal
                    break

            if not self._target_calendar:
                # 如果没找到完全匹配的，尝试任意名称匹配的 Exchange 日历
                for cal in calendars:
                    if cal.title() == self.calendar_name:
                        self._target_calendar = cal
                        break

            if not self._target_calendar:
                logger.error(f"未找到日历: {self.calendar_name}")
                logger.info("可用日历列表:")
                for cal in calendars:
                    logger.info(f"  - {cal.title()}")
                return False

            logger.info(f"已连接日历: {self._target_calendar.title()}")
            self._initialized = True
            return True

        except ImportError:
            logger.error("缺少 pyobjc-framework-EventKit，请运行: pip install pyobjc-framework-EventKit")
            return False
        except Exception as e:
            logger.error(f"初始化 EventKit 失败: {e}")
            return False

    def get_events(
        self,
        days_past: Optional[int] = None,
        days_future: Optional[int] = None
    ) -> List[CalendarEvent]:
        """
        获取指定时间范围内的日历事件

        Args:
            days_past: 过去多少天（默认使用配置）
            days_future: 未来多少天（默认使用配置）

        Returns:
            CalendarEvent 列表
        """
        if not self._init_eventkit():
            return []

        days_past = days_past or config.calendar_past_days
        days_future = days_future or config.calendar_future_days

        now = datetime.now()
        start = now - timedelta(days=days_past)
        end = now + timedelta(days=days_future)

        return self._fetch_events(start, end)

    def get_events_since(self, since: datetime) -> List[CalendarEvent]:
        """
        获取指定时间之后修改的事件（用于增量同步）

        Args:
            since: 从何时开始

        Returns:
            CalendarEvent 列表
        """
        # EventKit 不直接支持按修改时间过滤，
        # 我们获取所有事件后在内存中过滤
        events = self.get_events()
        return [
            e for e in events
            if e.last_modified and e.last_modified > since
        ]

    def _fetch_events(self, start: datetime, end: datetime) -> List[CalendarEvent]:
        """从 EventKit 获取事件"""
        try:
            # 转换时间
            start_ns = self._NSDate.dateWithTimeIntervalSince1970_(start.timestamp())
            end_ns = self._NSDate.dateWithTimeIntervalSince1970_(end.timestamp())

            # 创建查询
            predicate = self._store.predicateForEventsWithStartDate_endDate_calendars_(
                start_ns, end_ns, [self._target_calendar]
            )

            # 执行查询
            ek_events = self._store.eventsMatchingPredicate_(predicate)

            logger.debug(f"获取到 {len(ek_events)} 个事件")

            # 转换为 CalendarEvent
            events = []
            for ek_event in ek_events:
                try:
                    event = self._convert_event(ek_event)
                    if event:
                        events.append(event)
                except Exception as e:
                    logger.warning(f"转换事件失败: {e}")
                    continue

            return events

        except Exception as e:
            logger.error(f"获取日历事件失败: {e}")
            return []

    def _convert_event(self, ek_event) -> Optional[CalendarEvent]:
        """将 EventKit 事件转换为 CalendarEvent"""
        try:
            # 基本信息
            event_id = ek_event.calendarItemIdentifier()
            title = ek_event.title() or "(无标题)"

            # 时间
            start_ns = ek_event.startDate()
            end_ns = ek_event.endDate()

            if not start_ns or not end_ns:
                return None

            start_time = datetime.fromtimestamp(start_ns.timeIntervalSince1970())
            end_time = datetime.fromtimestamp(end_ns.timeIntervalSince1970())

            # 获取事件自带的时区，如果没有则使用系统时区
            event_tz = ek_event.timeZone()
            if event_tz:
                # 使用事件的原始时区
                tz_offset_seconds = event_tz.secondsFromGMT()
                tz_info = timezone(timedelta(seconds=tz_offset_seconds))
                # 需要将 UTC 时间转换为事件时区的本地时间
                start_utc = datetime.utcfromtimestamp(start_ns.timeIntervalSince1970())
                end_utc = datetime.utcfromtimestamp(end_ns.timeIntervalSince1970())
                start_time = start_utc.replace(tzinfo=timezone.utc).astimezone(tz_info)
                end_time = end_utc.replace(tzinfo=timezone.utc).astimezone(tz_info)
            else:
                # 没有时区信息，使用系统本地时区
                import time
                start_local = time.localtime(start_ns.timeIntervalSince1970())
                if start_local.tm_isdst > 0:
                    start_offset = -time.altzone
                else:
                    start_offset = -time.timezone
                start_tz = timezone(timedelta(seconds=start_offset))
                start_time = start_time.replace(tzinfo=start_tz)

                end_local = time.localtime(end_ns.timeIntervalSince1970())
                if end_local.tm_isdst > 0:
                    end_offset = -time.altzone
                else:
                    end_offset = -time.timezone
                end_tz = timezone(timedelta(seconds=end_offset))
                end_time = end_time.replace(tzinfo=end_tz)

            is_all_day = ek_event.isAllDay()

            # 地点
            location = ek_event.location() or None

            # 描述 - 保留原始格式用于解析，同时创建清理版本用于摘要
            notes = ek_event.notes()
            description = None
            raw_description = None
            if notes:
                # 保存原始描述用于解析器
                raw_description = notes

                # 清理格式用于摘要显示
                import re
                desc = notes
                # 替换 \r\n 和 \r 为 \n
                desc = desc.replace('\r\n', '\n').replace('\r', '\n')
                # 清理 <mailto:xxx> 格式，保留邮箱
                desc = re.sub(r'<mailto:([^>]+)>', r'\1', desc)
                # 清理 <https://xxx> 格式，保留链接
                desc = re.sub(r'<(https?://[^>]+)>', r'\1', desc)
                # 限制长度
                description = desc[:2000] if len(desc) > 2000 else desc

            # URL
            url = None
            ek_url = ek_event.URL()
            if ek_url:
                url = ek_url.absoluteString()

            # 状态 - Exchange 通常返回 0 (none)，默认改为 tentative
            status_map = {
                0: EventStatus.TENTATIVE,  # none -> 默认为 tentative
                1: EventStatus.CONFIRMED,
                2: EventStatus.TENTATIVE,
                3: EventStatus.CANCELLED
            }
            status = status_map.get(ek_event.status(), EventStatus.TENTATIVE)

            # 组织者
            organizer = None
            organizer_email = None
            ek_organizer = ek_event.organizer()
            if ek_organizer:
                organizer = ek_organizer.name() or None
                organizer_email = ek_organizer.emailAddress() or None

            # 参与者
            attendees = []
            ek_attendees = ek_event.attendees()
            if ek_attendees:
                status_str_map = {
                    0: "unknown",
                    1: "pending",
                    2: "accepted",
                    3: "declined",
                    4: "tentative"
                }
                for att in ek_attendees:
                    att_status = status_str_map.get(att.participantStatus(), "unknown")
                    attendees.append(Attendee(
                        email=att.emailAddress() or "",
                        name=att.name() or None,
                        status=att_status
                    ))

            # 重复规则
            is_recurring = ek_event.hasRecurrenceRules()
            recurrence_rule = None
            # EventKit 的 recurrenceRules 比较复杂，暂时只标记是否重复

            # 最后修改时间
            last_modified = None
            mod_date = ek_event.lastModifiedDate()
            if mod_date:
                last_modified = datetime.fromtimestamp(mod_date.timeIntervalSince1970())

            event = CalendarEvent(
                event_id=event_id,
                calendar_name=self._target_calendar.title(),
                title=title,
                start_time=start_time,
                end_time=end_time,
                is_all_day=is_all_day,
                location=location,
                description=description,
                url=url,
                status=status,
                organizer=organizer,
                organizer_email=organizer_email,
                attendees=attendees,
                is_recurring=is_recurring,
                recurrence_rule=recurrence_rule,
                last_modified=last_modified
            )

            # 保存原始描述用于解析器处理表格和 Teams 会议信息
            if raw_description:
                event._raw_description = raw_description

            return event

        except Exception as e:
            logger.warning(f"转换事件时出错: {e}")
            return None
