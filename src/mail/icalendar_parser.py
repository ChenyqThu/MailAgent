"""
iCalendar 会议邀请解析器

从邮件的 text/calendar MIME 部分提取会议信息，
转换为 CalendarEvent 对象供 Notion 同步使用。

支持的功能：
- 解析 METHOD:REQUEST (会议邀请)
- 解析 METHOD:CANCEL (会议取消)
- 提取 Teams 会议链接、会议 ID、密码
- 使用 UID 作为唯一标识（支持会议改期更新）

Usage:
    parser = ICalendarParser()
    invite = parser.extract_from_email_source(email_source)
    if invite:
        event = parser.to_calendar_event(invite)
"""

import email
import re
from email import policy
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Tuple
from dataclasses import dataclass, field
from loguru import logger

from src.models import CalendarEvent, EventStatus, Attendee


@dataclass
class MeetingInvite:
    """会议邀请信息"""
    uid: str                          # 唯一标识 (用于去重和更新)
    method: str                       # REQUEST/CANCEL/REPLY
    summary: str                      # 标题
    start_time: datetime
    end_time: datetime
    location: Optional[str] = None
    description: Optional[str] = None
    organizer: Optional[str] = None
    organizer_email: Optional[str] = None
    attendees: List[Attendee] = field(default_factory=list)
    status: str = "confirmed"
    sequence: int = 0                 # 版本号，用于判断更新
    is_all_day: bool = False

    # Teams 会议信息 (从 description 中提取)
    teams_url: Optional[str] = None
    meeting_id: Optional[str] = None
    passcode: Optional[str] = None


class ICalendarParser:
    """解析邮件中的 iCalendar 会议邀请"""

    # Teams URL 模式
    TEAMS_URL_PATTERNS = [
        r'https://teams\.microsoft\.com/l/meetup-join/[^\s<>"\'\\]+',
        r'https://teams\.microsoft\.com/meet/\d+\?p=[A-Za-z0-9]+',
    ]

    # 会议 ID 模式 (支持中英文)
    MEETING_ID_PATTERNS = [
        r'(?:Meeting\s*ID|会议\s*ID|会议ID)\s*[:：]\s*([\d\s]{10,25})',
    ]

    # 密码模式
    PASSCODE_PATTERNS = [
        r'(?:Passcode|Password|Pass code|密码)\s*[:：]\s*(\S{4,20})',
    ]

    def __init__(self):
        # 北京时区
        self.beijing_tz = timezone(timedelta(hours=8))

    def has_calendar_invite(self, source: str) -> bool:
        """快速检查邮件是否包含日历邀请

        Args:
            source: 邮件 MIME 源码

        Returns:
            是否包含 text/calendar MIME 部分
        """
        if not source:
            return False
        return 'text/calendar' in source.lower() or 'BEGIN:VCALENDAR' in source

    def extract_from_email_source(self, source: str) -> Optional[MeetingInvite]:
        """从邮件源码提取会议邀请

        Args:
            source: 邮件 MIME 源码

        Returns:
            MeetingInvite 或 None (如果不是会议邀请)
        """
        if not source:
            return None

        try:
            msg = email.message_from_string(source, policy=policy.default)

            # 遍历 MIME 部分，查找 text/calendar
            for part in msg.walk():
                if part.get_content_type() == 'text/calendar':
                    payload = part.get_payload(decode=True)
                    if payload:
                        ical_content = payload.decode('utf-8', errors='replace')
                        return self._parse_icalendar(ical_content)

            return None

        except Exception as e:
            logger.warning(f"Failed to extract iCalendar from email: {e}")
            return None

    def _parse_icalendar(self, ical_content: str) -> Optional[MeetingInvite]:
        """解析 iCalendar 内容"""
        try:
            # 处理折行 (RFC 5545: 以空格或 tab 开头的行是前一行的延续)
            ical_content = re.sub(r'\r?\n[ \t]', '', ical_content)
            lines = ical_content.split('\r\n') if '\r\n' in ical_content else ical_content.split('\n')

            # 提取字段
            data = {}
            attendees_raw = []

            for line in lines:
                line = line.strip()
                if not line or ':' not in line:
                    continue

                # 处理带参数的键，如 DTSTART;TZID=China Standard Time:20260126T140000
                key_part, value = line.split(':', 1)

                # 特殊处理 ATTENDEE (可能有多个)
                if key_part.startswith('ATTENDEE'):
                    attendees_raw.append(line)
                    continue

                if ';' in key_part:
                    key = key_part.split(';')[0]
                    params = key_part.split(';')[1:]
                    data[key] = {'value': value, 'params': params}
                else:
                    data[key_part] = value

            # 必须有 UID
            uid = data.get('UID', '')
            if isinstance(uid, dict):
                uid = uid.get('value', '')
            if not uid:
                logger.debug("iCalendar missing UID, skipping")
                return None

            # 解析时间
            start_time = self._parse_datetime(data.get('DTSTART'))
            end_time = self._parse_datetime(data.get('DTEND'))

            if not start_time:
                logger.debug("iCalendar missing DTSTART, skipping")
                return None

            # 如果没有结束时间，假设为开始时间后 1 小时
            if not end_time:
                end_time = start_time + timedelta(hours=1)

            # 检查是否全天事件
            is_all_day = self._is_all_day_event(data.get('DTSTART'))

            # 解析组织者
            organizer_raw = data.get('ORGANIZER', '')
            if isinstance(organizer_raw, dict):
                organizer_raw = f"{';'.join(organizer_raw.get('params', []))}:{organizer_raw.get('value', '')}"
            organizer_name, organizer_email = self._parse_organizer(organizer_raw)

            # 解析参与者
            attendees = self._parse_attendees(attendees_raw)

            # 解析描述 (可能包含 Teams 链接)
            description = self._decode_description(data.get('DESCRIPTION', ''))

            # 提取 Teams 信息
            teams_url, meeting_id, passcode = self._extract_teams_info(description)

            # 解析状态
            # 默认为 tentative（待定），因为用户需要答复接受/拒绝
            method = data.get('METHOD', 'REQUEST')
            if isinstance(method, dict):
                method = method.get('value', 'REQUEST')

            status = 'tentative'  # 默认待定，等待用户答复
            if method == 'CANCEL':
                status = 'cancelled'
            else:
                status_raw = data.get('STATUS', '')
                if isinstance(status_raw, dict):
                    status_raw = status_raw.get('value', '')
                if status_raw.upper() == 'CANCELLED':
                    status = 'cancelled'
                # 注意：不再根据 STATUS 设置为 confirmed，保持 tentative

            # 解析地点
            location = data.get('LOCATION', '')
            if isinstance(location, dict):
                location = location.get('value', '')
            location = self._decode_description(location)

            # 解析标题
            summary = data.get('SUMMARY', '')
            if isinstance(summary, dict):
                summary = summary.get('value', '')
            summary = self._decode_description(summary)

            # 解析序列号
            sequence = data.get('SEQUENCE', '0')
            if isinstance(sequence, dict):
                sequence = sequence.get('value', '0')
            try:
                sequence = int(sequence)
            except ValueError:
                sequence = 0

            return MeetingInvite(
                uid=uid,
                method=method,
                summary=summary or "(无标题)",
                start_time=start_time,
                end_time=end_time,
                location=location if location else None,
                description=description if description else None,
                organizer=organizer_name,
                organizer_email=organizer_email,
                attendees=attendees,
                status=status,
                sequence=sequence,
                is_all_day=is_all_day,
                teams_url=teams_url,
                meeting_id=meeting_id,
                passcode=passcode,
            )

        except Exception as e:
            logger.error(f"Failed to parse iCalendar: {e}")
            import traceback
            logger.debug(traceback.format_exc())
            return None

    def _is_all_day_event(self, dt_data) -> bool:
        """判断是否为全天事件"""
        if not dt_data:
            return False

        if isinstance(dt_data, dict):
            params = dt_data.get('params', [])
            value = dt_data.get('value', '')
            # VALUE=DATE 表示全天事件
            if any('VALUE=DATE' in p for p in params):
                return True
            # 只有日期没有时间也是全天事件
            if len(value) == 8:
                return True
        elif isinstance(dt_data, str) and len(dt_data) == 8:
            return True

        return False

    def _parse_datetime(self, dt_data) -> Optional[datetime]:
        """解析 iCalendar 日期时间"""
        if not dt_data:
            return None

        try:
            if isinstance(dt_data, dict):
                value = dt_data['value']
                params = dt_data.get('params', [])

                # 查找时区
                tz_name = None
                for p in params:
                    if p.startswith('TZID='):
                        tz_name = p[5:]
                        break
            else:
                value = dt_data
                tz_name = None

            # 解析日期时间
            if len(value) == 8:  # 全天事件 YYYYMMDD
                dt = datetime.strptime(value, '%Y%m%d')
                dt = dt.replace(tzinfo=self.beijing_tz)
            elif 'T' in value:
                if value.endswith('Z'):
                    dt = datetime.strptime(value.rstrip('Z'), '%Y%m%dT%H%M%S')
                    dt = dt.replace(tzinfo=timezone.utc)
                else:
                    dt = datetime.strptime(value, '%Y%m%dT%H%M%S')
                    # 如果有时区信息或默认北京时间
                    if tz_name and ('China' in tz_name or 'Beijing' in tz_name or 'Shanghai' in tz_name):
                        dt = dt.replace(tzinfo=self.beijing_tz)
                    else:
                        # 默认使用北京时间
                        dt = dt.replace(tzinfo=self.beijing_tz)
            else:
                return None

            return dt

        except Exception as e:
            logger.warning(f"Failed to parse datetime {dt_data}: {e}")
            return None

    def _parse_organizer(self, organizer_raw: str) -> Tuple[Optional[str], Optional[str]]:
        """解析组织者信息"""
        if not organizer_raw:
            return None, None

        # 格式: CN=张三:MAILTO:zhangsan@example.com
        # 或: ORGANIZER;CN=张三:MAILTO:zhangsan@example.com
        name_match = re.search(r'CN=([^:;]+)', organizer_raw)
        email_match = re.search(r'MAILTO:([^\s;]+)', organizer_raw, re.IGNORECASE)

        name = name_match.group(1) if name_match else None
        email_addr = email_match.group(1) if email_match else None

        # 清理名称中的引号
        if name:
            name = name.strip('"\'')

        return name, email_addr

    def _parse_attendees(self, attendees_raw: List[str]) -> List[Attendee]:
        """解析参与者列表"""
        attendees = []

        for line in attendees_raw:
            try:
                # 格式: ATTENDEE;ROLE=REQ-PARTICIPANT;CN=张三:MAILTO:zhangsan@example.com
                name_match = re.search(r'CN=([^:;]+)', line)
                email_match = re.search(r'MAILTO:([^\s;]+)', line, re.IGNORECASE)

                if email_match:
                    email_addr = email_match.group(1)
                    name = name_match.group(1).strip('"\'') if name_match else None

                    # 解析参与状态
                    status = "unknown"
                    if 'PARTSTAT=ACCEPTED' in line:
                        status = "accepted"
                    elif 'PARTSTAT=DECLINED' in line:
                        status = "declined"
                    elif 'PARTSTAT=TENTATIVE' in line:
                        status = "tentative"
                    elif 'PARTSTAT=NEEDS-ACTION' in line:
                        status = "pending"

                    attendees.append(Attendee(
                        email=email_addr,
                        name=name,
                        status=status
                    ))
            except Exception as e:
                logger.debug(f"Failed to parse attendee: {e}")

        return attendees

    def _decode_description(self, desc) -> str:
        """解码描述中的转义字符"""
        if not desc:
            return ''

        if isinstance(desc, dict):
            desc = desc.get('value', '')

        # iCalendar 转义
        desc = desc.replace('\\n', '\n')
        desc = desc.replace('\\r', '\r')
        desc = desc.replace('\\,', ',')
        desc = desc.replace('\\;', ';')
        desc = desc.replace('\\\\', '\\')

        return desc

    def _extract_teams_info(self, description: str) -> Tuple[Optional[str], Optional[str], Optional[str]]:
        """从描述中提取 Teams 会议信息"""
        if not description:
            return None, None, None

        # Teams URL
        teams_url = None
        for pattern in self.TEAMS_URL_PATTERNS:
            match = re.search(pattern, description)
            if match:
                teams_url = match.group(0)
                # 清理可能的尾部字符
                teams_url = teams_url.rstrip('>')
                break

        # 会议 ID
        meeting_id = None
        for pattern in self.MEETING_ID_PATTERNS:
            match = re.search(pattern, description)
            if match:
                meeting_id = match.group(1).strip()
                break

        # 密码
        passcode = None
        for pattern in self.PASSCODE_PATTERNS:
            match = re.search(pattern, description)
            if match:
                passcode = match.group(1).strip()
                break

        return teams_url, meeting_id, passcode

    def to_calendar_event(self, invite: MeetingInvite) -> CalendarEvent:
        """转换为 CalendarEvent 对象

        Args:
            invite: MeetingInvite 对象

        Returns:
            CalendarEvent 对象
        """
        status_map = {
            'confirmed': EventStatus.CONFIRMED,
            'tentative': EventStatus.TENTATIVE,
            'cancelled': EventStatus.CANCELLED,
        }

        event = CalendarEvent(
            event_id=invite.uid,
            calendar_name="Email Invite",
            title=invite.summary,
            start_time=invite.start_time,
            end_time=invite.end_time,
            is_all_day=invite.is_all_day,
            location=invite.location,
            description=invite.description,
            url=invite.teams_url,
            status=status_map.get(invite.status, EventStatus.TENTATIVE),
            organizer=invite.organizer,
            organizer_email=invite.organizer_email,
            attendees=invite.attendees,
            is_recurring=False,
            last_modified=datetime.now(self.beijing_tz),
        )

        # 保存原始描述供 description_parser 使用
        event._raw_description = invite.description

        return event
