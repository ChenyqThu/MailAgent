from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Optional
from enum import Enum

@dataclass
class Attachment:
    """附件数据模型"""
    filename: str
    content_type: str
    size: int
    path: str  # 临时文件路径

@dataclass
class Email:
    """邮件数据模型"""
    message_id: str
    subject: str
    sender: str
    sender_name: Optional[str] = None
    to: str = ""
    cc: str = ""
    date: datetime = field(default_factory=datetime.now)
    content: str = ""  # HTML 或纯文本
    content_type: str = "text/plain"  # text/plain 或 text/html
    is_read: bool = False
    is_flagged: bool = False
    has_attachments: bool = False
    attachments: List[Attachment] = field(default_factory=list)
    thread_id: Optional[str] = None

    def __post_init__(self):
        """验证数据"""
        if not self.message_id:
            raise ValueError("message_id is required")
        if not self.subject:
            self.subject = "(No Subject)"
        if not self.sender_name:
            self.sender_name = self.sender.split("@")[0]
        self.has_attachments = len(self.attachments) > 0


class EventStatus(Enum):
    """日历事件状态"""
    NONE = "none"
    CONFIRMED = "confirmed"
    TENTATIVE = "tentative"
    CANCELLED = "cancelled"


@dataclass
class Attendee:
    """事件参与者"""
    email: str
    name: Optional[str] = None
    status: str = "unknown"  # accepted/declined/tentative/pending/unknown


@dataclass
class CalendarEvent:
    """日历事件数据模型"""
    # 唯一标识
    event_id: str  # Calendar Item ID，用于去重
    calendar_name: str

    # 基本信息
    title: str
    start_time: datetime
    end_time: datetime
    is_all_day: bool = False

    # 详情
    location: Optional[str] = None
    description: Optional[str] = None
    url: Optional[str] = None
    status: EventStatus = EventStatus.NONE

    # 参与者
    organizer: Optional[str] = None
    organizer_email: Optional[str] = None
    attendees: List[Attendee] = field(default_factory=list)

    # 重复规则
    is_recurring: bool = False
    recurrence_rule: Optional[str] = None

    # 元数据
    last_modified: Optional[datetime] = None

    def __post_init__(self):
        """验证数据"""
        if not self.event_id:
            raise ValueError("event_id is required")
        if not self.title:
            self.title = "(无标题)"

    @property
    def attendee_count(self) -> int:
        """参与者数量"""
        return len(self.attendees)

    @property
    def attendees_str(self) -> str:
        """参与者列表字符串"""
        if not self.attendees:
            return ""
        return ", ".join([
            f"{a.name or a.email}({a.status})"
            for a in self.attendees[:20]  # 最多20个
        ])
