"""
日历读取模块 - 使用 AppleScript 读取 macOS 日历事件
比 EventKit 更稳定，不会因为息屏/睡眠丢失权限
"""

import subprocess
from datetime import datetime, timedelta, timezone
from typing import List, Optional
from loguru import logger

from src.config import config
from src.models import CalendarEvent, Attendee, EventStatus


# 分隔符定义
FIELD_DELIMITER = "|||FIELD|||"
EVENT_DELIMITER = "|||EVENT|||"
ATTENDEE_DELIMITER = "|||ATT|||"


class CalendarAppleScriptReader:
    """使用 AppleScript 读取 macOS 日历事件"""

    def __init__(self):
        self.calendar_name = config.calendar_name
        self._connected = False
        self._calendar_index = None  # 日历在列表中的索引（用于处理同名日历）

    def _run_applescript(self, script: str, timeout: int = 60) -> Optional[str]:
        """执行 AppleScript 并返回结果"""
        try:
            result = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True,
                text=True,
                timeout=timeout
            )
            if result.returncode != 0:
                error_msg = result.stderr.strip()
                logger.error(f"AppleScript 执行失败: {error_msg}")
                return None
            return result.stdout.strip()
        except subprocess.TimeoutExpired:
            logger.error(f"AppleScript 执行超时 ({timeout}s)")
            return None
        except Exception as e:
            logger.error(f"AppleScript 执行异常: {e}")
            return None

    def _check_calendar_exists(self) -> bool:
        """检查目标日历是否存在，优先选择事件最多的同名日历（通常是 Exchange）"""
        # 先获取所有同名日历的索引和事件数
        script = f'''
        tell application "Calendar"
            set output to ""
            set idx to 1
            repeat with cal in calendars
                if name of cal is "{self.calendar_name}" then
                    set evtCount to count of events of cal
                    set output to output & idx & ":" & evtCount & ","
                end if
                set idx to idx + 1
            end repeat
            return output
        end tell
        '''
        result = self._run_applescript(script)

        if not result:
            logger.error(f"未找到日历: {self.calendar_name}")
            return False

        # 解析结果，找出事件最多的日历索引
        best_idx = None
        max_events = -1

        for item in result.strip(",").split(","):
            if ":" in item:
                parts = item.split(":")
                idx = int(parts[0])
                count = int(parts[1])
                if count > max_events:
                    max_events = count
                    best_idx = idx

        if best_idx is None:
            logger.error(f"未找到日历: {self.calendar_name}")
            # 列出可用日历
            list_script = '''
            tell application "Calendar"
                set calNames to {}
                repeat with cal in calendars
                    set end of calNames to name of cal
                end repeat
                return calNames as text
            end tell
            '''
            available = self._run_applescript(list_script)
            if available:
                logger.info(f"可用日历: {available}")
            return False

        self._calendar_index = best_idx
        if not self._connected:
            logger.info(f"已连接日历: {self.calendar_name} (索引 {best_idx}, {max_events} 个事件)")
            self._connected = True
        return True

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
        if not self._check_calendar_exists():
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
        events = self.get_events()
        return [
            e for e in events
            if e.last_modified and e.last_modified > since
        ]

    def _fetch_events(self, start: datetime, end: datetime) -> List[CalendarEvent]:
        """从 Calendar.app 获取事件"""
        # 计算距离今天的天数差
        now = datetime.now()
        days_past = (now - start).days
        days_future = (end - now).days

        # AppleScript 获取事件列表，使用分隔符格式
        # 使用 current date 加减天数，避免日期字符串格式问题
        script = f'''
        set fieldDelim to "{FIELD_DELIMITER}"
        set eventDelim to "{EVENT_DELIMITER}"
        set attDelim to "{ATTENDEE_DELIMITER}"

        on formatDate(theDate)
            if theDate is missing value then return ""
            set y to year of theDate
            set m to month of theDate as integer
            set d to day of theDate
            set h to hours of theDate
            set mins to minutes of theDate
            set s to seconds of theDate
            set mStr to text -2 thru -1 of ("0" & m)
            set dStr to text -2 thru -1 of ("0" & d)
            set hStr to text -2 thru -1 of ("0" & h)
            set minStr to text -2 thru -1 of ("0" & mins)
            set sStr to text -2 thru -1 of ("0" & s)
            return (y as text) & "-" & mStr & "-" & dStr & "T" & hStr & ":" & minStr & ":" & sStr
        end formatDate

        on safeText(theValue)
            if theValue is missing value then return ""
            try
                return theValue as text
            on error
                return ""
            end try
        end safeText

        tell application "Calendar"
            set targetCal to item {self._calendar_index} of calendars
            set now to current date
            set startDate to now - {days_past} * days
            set endDate to now + {days_future} * days

            set eventList to (every event of targetCal whose start date >= startDate and start date <= endDate)

            set output to ""

            repeat with evt in eventList
                try
                    set evtUID to uid of evt
                    set evtSummary to my safeText(summary of evt)
                    set evtStart to my formatDate(start date of evt)
                    set evtEnd to my formatDate(end date of evt)
                    set evtAllDay to allday event of evt
                    set evtLocation to my safeText(location of evt)
                    set evtDescription to my safeText(description of evt)

                    set evtUrl to ""
                    try
                        set evtUrl to url of evt as text
                        if evtUrl is "missing value" then set evtUrl to ""
                    end try

                    set evtRecurrence to ""
                    try
                        set evtRecurrence to recurrence of evt as text
                        if evtRecurrence is "missing value" then set evtRecurrence to ""
                    end try

                    set evtStamp to my formatDate(stamp date of evt)

                    -- 状态
                    set evtStatus to "confirmed"
                    try
                        set rawStatus to status of evt
                        if rawStatus is cancelled then
                            set evtStatus to "cancelled"
                        else if rawStatus is tentative then
                            set evtStatus to "tentative"
                        end if
                    end try

                    -- 组织者
                    set evtOrganizer to ""
                    set evtOrganizerEmail to ""
                    try
                        set org to organizer of evt
                        if org is not missing value then
                            set evtOrganizer to my safeText(display name of org)
                            set evtOrganizerEmail to my safeText(email of org)
                        end if
                    end try

                    -- 参与者列表
                    set attendeeList to ""
                    try
                        set attList to attendees of evt
                        repeat with att in attList
                            try
                                set attEmail to my safeText(email of att)
                                set attName to my safeText(display name of att)
                                set attStatus to participation status of att as text

                                if attendeeList is not "" then
                                    set attendeeList to attendeeList & attDelim
                                end if
                                set attendeeList to attendeeList & attEmail & ":" & attName & ":" & attStatus
                            end try
                        end repeat
                    end try

                    -- 组装事件数据
                    if output is not "" then
                        set output to output & eventDelim
                    end if

                    set output to output & evtUID & fieldDelim
                    set output to output & evtSummary & fieldDelim
                    set output to output & evtStart & fieldDelim
                    set output to output & evtEnd & fieldDelim
                    set output to output & evtAllDay & fieldDelim
                    set output to output & evtLocation & fieldDelim
                    set output to output & evtDescription & fieldDelim
                    set output to output & evtUrl & fieldDelim
                    set output to output & evtRecurrence & fieldDelim
                    set output to output & evtStamp & fieldDelim
                    set output to output & evtStatus & fieldDelim
                    set output to output & evtOrganizer & fieldDelim
                    set output to output & evtOrganizerEmail & fieldDelim
                    set output to output & attendeeList

                end try
            end repeat

            return output
        end tell
        '''

        result = self._run_applescript(script, timeout=120)
        if not result:
            return []

        # 解析分隔符格式的数据
        events = []
        event_strs = result.split(EVENT_DELIMITER)

        logger.info(f"获取到 {len(event_strs)} 个事件")

        for event_str in event_strs:
            if not event_str.strip():
                continue
            try:
                event = self._parse_event(event_str)
                if event:
                    events.append(event)
            except Exception as e:
                logger.warning(f"解析事件失败: {e}")
                continue

        return events

    def _parse_event(self, event_str: str) -> Optional[CalendarEvent]:
        """解析单个事件字符串"""
        fields = event_str.split(FIELD_DELIMITER)
        if len(fields) < 14:
            logger.warning(f"事件字段不足: {len(fields)} < 14")
            return None

        try:
            uid = fields[0]
            title = fields[1] or "(无标题)"
            start_str = fields[2]
            end_str = fields[3]
            is_all_day = fields[4].lower() == "true"
            location = fields[5] or None
            description = fields[6] or None
            url = fields[7] or None
            recurrence = fields[8] or None
            stamp_str = fields[9]
            status_str = fields[10]
            organizer = fields[11] or None
            organizer_email = fields[12] or None
            attendees_str = fields[13] if len(fields) > 13 else ""

            # 解析时间
            if not start_str or not end_str:
                return None

            start_time = datetime.strptime(start_str, "%Y-%m-%dT%H:%M:%S")
            end_time = datetime.strptime(end_str, "%Y-%m-%dT%H:%M:%S")

            # 添加本地时区
            import time
            local_offset = -time.timezone if time.daylight == 0 else -time.altzone
            local_tz = timezone(timedelta(seconds=local_offset))
            start_time = start_time.replace(tzinfo=local_tz)
            end_time = end_time.replace(tzinfo=local_tz)

            # 清理 URL
            if url == "missing value":
                url = None

            # 状态
            status_map = {
                "confirmed": EventStatus.CONFIRMED,
                "tentative": EventStatus.TENTATIVE,
                "cancelled": EventStatus.CANCELLED
            }
            status = status_map.get(status_str, EventStatus.TENTATIVE)

            # 解析参与者
            attendees = []
            if attendees_str:
                for att_str in attendees_str.split(ATTENDEE_DELIMITER):
                    parts = att_str.split(":", 2)
                    if len(parts) >= 1:
                        attendees.append(Attendee(
                            email=parts[0],
                            name=parts[1] if len(parts) > 1 else None,
                            status=parts[2].lower() if len(parts) > 2 else "unknown"
                        ))

            # 重复规则
            is_recurring = bool(recurrence)

            # 对于重复事件，使用 uid + 开始时间作为唯一标识
            if is_recurring:
                start_ts = int(start_time.timestamp())
                event_id = f"{uid}_{start_ts}"
            else:
                event_id = uid

            # 最后修改时间
            last_modified = None
            if stamp_str:
                try:
                    last_modified = datetime.strptime(stamp_str, "%Y-%m-%dT%H:%M:%S")
                    last_modified = last_modified.replace(tzinfo=timezone.utc)
                except:
                    pass

            event = CalendarEvent(
                event_id=event_id,
                calendar_name=self.calendar_name,
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
                recurrence_rule=recurrence,
                last_modified=last_modified
            )

            # 保存原始描述用于解析器
            if description:
                event._raw_description = description

            return event

        except Exception as e:
            logger.warning(f"转换事件时出错: {e}")
            return None
