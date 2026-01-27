"""
日历监听模块 - 使用 EventKit 事件驱动机制
当日历数据变化时自动触发同步，避免长期轮询
支持权限丢失后自动恢复
"""

import asyncio
import threading
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Callable, Awaitable
from loguru import logger

from src.config import config
from src.models import CalendarEvent, Attendee, EventStatus


class EventKitWatcher:
    """
    EventKit 日历监听器

    使用事件驱动机制：
    1. 监听 EKEventStoreChangedNotification 通知
    2. 日历变化时触发回调
    3. 自动处理权限丢失和恢复
    """

    def __init__(self):
        self.calendar_name = config.calendar_name
        self._store = None
        self._target_calendar = None
        self._initialized = False
        self._observer = None
        self._callback: Optional[Callable[[], Awaitable[None]]] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._last_sync_time: Optional[datetime] = None
        self._debounce_seconds = 5  # 防抖：5秒内多次变化只触发一次
        self._pending_sync = False
        self._health_check_interval = config.health_check_interval  # 健康检查间隔

    def _init_eventkit(self) -> bool:
        """初始化 EventKit（延迟加载）"""
        try:
            import EventKit
            from Foundation import NSDate, NSNotificationCenter, NSRunLoop, NSDefaultRunLoopMode
            import objc

            self._EventKit = EventKit
            self._NSDate = NSDate
            self._NSNotificationCenter = NSNotificationCenter
            self._NSRunLoop = NSRunLoop
            self._NSDefaultRunLoopMode = NSDefaultRunLoopMode

            # 创建事件存储
            self._store = EventKit.EKEventStore.alloc().init()

            # 请求访问权限
            access_granted = [None]
            done_event = threading.Event()

            def completion_handler(granted, error):
                access_granted[0] = granted
                if error:
                    logger.warning(f"EventKit 权限请求错误: {error}")
                done_event.set()

            self._store.requestAccessToEntityType_completion_(
                EventKit.EKEntityTypeEvent,
                completion_handler
            )

            done_event.wait(timeout=30)

            if not access_granted[0]:
                logger.error("日历访问被拒绝，请在 系统设置 > 隐私与安全 > 日历 中授权")
                self._initialized = False
                return False

            # 查找目标日历
            if not self._find_target_calendar():
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

    def _find_target_calendar(self) -> bool:
        """查找目标日历（优先 Exchange 类型）"""
        calendars = self._store.calendarsForEntityType_(self._EventKit.EKEntityTypeEvent)

        # 优先查找 Exchange 类型的匹配日历
        for cal in calendars:
            source = cal.source()
            source_type = source.sourceType() if source else -1
            # Exchange 类型 = 1，且名称匹配
            if source_type == 1 and cal.title() == self.calendar_name:
                self._target_calendar = cal
                return True

        # 其次查找任意名称匹配的日历
        for cal in calendars:
            if cal.title() == self.calendar_name:
                self._target_calendar = cal
                return True

        logger.error(f"未找到日历: {self.calendar_name}")
        logger.info("可用日历列表:")
        for cal in calendars:
            source = cal.source()
            source_type = source.sourceType() if source else -1
            type_name = {0: "Local", 1: "Exchange", 2: "CalDAV", 3: "MobileMe", 4: "Subscribed", 5: "Birthdays"}.get(source_type, "Unknown")
            logger.info(f"  - {cal.title()} ({type_name})")
        return False

    def _reset_and_reinit(self) -> bool:
        """重置并重新初始化（用于权限恢复）"""
        logger.info("尝试重新初始化 EventKit...")
        self._initialized = False
        self._store = None
        self._target_calendar = None
        self._unregister_notification()
        return self._init_eventkit()

    def _register_notification(self):
        """注册日历变化通知"""
        if self._observer is not None:
            return

        try:
            from Foundation import NSNotificationCenter
            import objc

            # 创建通知处理器
            def notification_handler(notification):
                logger.debug("收到日历变化通知")
                self._on_calendar_changed()

            # 注册通知观察者
            center = NSNotificationCenter.defaultCenter()
            self._observer = center.addObserverForName_object_queue_usingBlock_(
                "EKEventStoreChangedNotification",
                self._store,
                None,
                notification_handler
            )
            logger.info("已注册日历变化通知监听")

        except Exception as e:
            logger.warning(f"注册日历通知失败: {e}")

    def _unregister_notification(self):
        """取消注册通知"""
        if self._observer is not None:
            try:
                from Foundation import NSNotificationCenter
                center = NSNotificationCenter.defaultCenter()
                center.removeObserver_(self._observer)
                self._observer = None
                logger.debug("已取消日历通知监听")
            except Exception as e:
                logger.warning(f"取消通知监听失败: {e}")

    def _on_calendar_changed(self):
        """日历变化回调（在 Cocoa 线程中调用）"""
        if self._callback is None or self._loop is None:
            return

        # 防抖：如果已有待处理的同步，跳过
        if self._pending_sync:
            logger.debug("已有待处理的同步，跳过")
            return

        self._pending_sync = True

        # 在异步事件循环中调度同步
        async def debounced_sync():
            await asyncio.sleep(self._debounce_seconds)
            self._pending_sync = False
            try:
                await self._callback()
            except Exception as e:
                logger.error(f"同步回调执行失败: {e}")

        asyncio.run_coroutine_threadsafe(debounced_sync(), self._loop)

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
        if not self._initialized:
            if not self._init_eventkit():
                return []

        days_past = days_past or config.calendar_past_days
        days_future = days_future or config.calendar_future_days

        now = datetime.now()
        start = now - timedelta(days=days_past)
        end = now + timedelta(days=days_future)

        events = self._fetch_events(start, end)

        # 如果获取失败，可能是权限问题，尝试重新初始化
        if events is None:
            if self._reset_and_reinit():
                events = self._fetch_events(start, end)

        return events or []

    def _fetch_events(self, start: datetime, end: datetime) -> Optional[List[CalendarEvent]]:
        """从 EventKit 获取事件"""
        try:
            if not self._target_calendar:
                return None

            # 转换时间
            start_ns = self._NSDate.dateWithTimeIntervalSince1970_(start.timestamp())
            end_ns = self._NSDate.dateWithTimeIntervalSince1970_(end.timestamp())

            # 创建查询
            predicate = self._store.predicateForEventsWithStartDate_endDate_calendars_(
                start_ns, end_ns, [self._target_calendar]
            )

            # 执行查询
            ek_events = self._store.eventsMatchingPredicate_(predicate)

            # 检查是否返回 None（权限问题的信号）
            if ek_events is None:
                logger.warning("EventKit 返回空，可能权限已失效")
                return None

            logger.info(f"获取到 {len(ek_events)} 个事件")

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

            self._last_sync_time = datetime.now()
            return events

        except Exception as e:
            logger.error(f"获取日历事件失败: {e}")
            # 权限问题时重置状态
            if "denied" in str(e).lower() or "permission" in str(e).lower():
                self._initialized = False
            return None

    def _convert_event(self, ek_event) -> Optional[CalendarEvent]:
        """将 EventKit 事件转换为 CalendarEvent"""
        try:
            # 基本信息
            base_id = ek_event.calendarItemIdentifier()

            if ek_event.hasRecurrenceRules():
                # 重复会议：加上 occurrenceDate 区分不同实例
                occ_date = ek_event.occurrenceDate()
                if occ_date:
                    occ_ts = int(occ_date.timeIntervalSince1970())
                    event_id = f"{base_id}_{occ_ts}"
                else:
                    start_ts = int(ek_event.startDate().timeIntervalSince1970())
                    event_id = f"{base_id}_{start_ts}"
            else:
                event_id = base_id

            title = ek_event.title() or "(无标题)"

            # 时间
            start_ns = ek_event.startDate()
            end_ns = ek_event.endDate()

            if not start_ns or not end_ns:
                return None

            start_time = datetime.fromtimestamp(start_ns.timeIntervalSince1970())
            end_time = datetime.fromtimestamp(end_ns.timeIntervalSince1970())

            # 获取事件时区
            event_tz = ek_event.timeZone()
            if event_tz:
                tz_offset_seconds = event_tz.secondsFromGMT()
                tz_info = timezone(timedelta(seconds=tz_offset_seconds))
                start_utc = datetime.utcfromtimestamp(start_ns.timeIntervalSince1970())
                end_utc = datetime.utcfromtimestamp(end_ns.timeIntervalSince1970())
                start_time = start_utc.replace(tzinfo=timezone.utc).astimezone(tz_info)
                end_time = end_utc.replace(tzinfo=timezone.utc).astimezone(tz_info)
            else:
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

            # 描述
            notes = ek_event.notes()
            description = None
            raw_description = None
            if notes:
                raw_description = notes
                import re
                desc = notes
                desc = desc.replace('\r\n', '\n').replace('\r', '\n')
                desc = re.sub(r'<mailto:([^>]+)>', r'\1', desc)
                desc = re.sub(r'<(https?://[^>]+)>', r'\1', desc)
                description = desc[:2000] if len(desc) > 2000 else desc

            # URL
            url = None
            ek_url = ek_event.URL()
            if ek_url:
                url = ek_url.absoluteString()

            # 状态
            status_map = {
                0: EventStatus.TENTATIVE,
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
            if is_recurring:
                rules = ek_event.recurrenceRules()
                if rules and len(rules) > 0:
                    rule = rules[0]
                    freq = rule.frequency()
                    interval = rule.interval()
                    freq_map = {0: 'daily', 1: 'weekly', 2: 'monthly', 3: 'yearly'}
                    freq_str = freq_map.get(freq, 'unknown')
                    if interval == 1:
                        recurrence_rule = freq_str
                    else:
                        recurrence_rule = f"every {interval} {freq_str}"

            # 最后修改时间
            last_modified = None
            mod_date = ek_event.lastModifiedDate()
            if mod_date:
                last_modified = datetime.utcfromtimestamp(mod_date.timeIntervalSince1970())
                last_modified = last_modified.replace(tzinfo=timezone.utc)

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

            if raw_description:
                event._raw_description = raw_description

            return event

        except Exception as e:
            logger.warning(f"转换事件时出错: {e}")
            return None

    async def start_watching(self, callback: Callable[[], Awaitable[None]]):
        """
        开始监听日历变化

        Args:
            callback: 日历变化时调用的异步回调函数
        """
        self._callback = callback
        self._loop = asyncio.get_event_loop()

        if not self._init_eventkit():
            logger.error("无法启动日历监听：初始化失败")
            return

        # 注册通知
        self._register_notification()

        # 启动 RunLoop 处理线程（用于接收 Cocoa 通知）
        def run_loop_thread():
            from Foundation import NSRunLoop, NSDate
            while True:
                # 运行 RunLoop 一小段时间来处理通知
                NSRunLoop.currentRunLoop().runUntilDate_(
                    NSDate.dateWithTimeIntervalSinceNow_(0.1)
                )

        runloop_thread = threading.Thread(target=run_loop_thread, daemon=True)
        runloop_thread.start()

        logger.info("日历监听已启动（事件驱动模式）")

        # 首次同步
        await callback()

        # 健康检查循环：定期检查权限和触发同步
        while True:
            try:
                await asyncio.sleep(self._health_check_interval)

                logger.debug("执行健康检查...")

                # 尝试获取事件，检测权限状态
                events = self.get_events()

                if events is not None:
                    # 权限正常，执行定期同步（作为备份）
                    await callback()
                else:
                    # 权限可能丢失，尝试恢复
                    logger.warning("健康检查发现权限问题，尝试恢复...")
                    if self._reset_and_reinit():
                        self._register_notification()
                        await callback()

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"健康检查失败: {e}")

    def stop_watching(self):
        """停止监听"""
        self._unregister_notification()
        logger.info("日历监听已停止")
