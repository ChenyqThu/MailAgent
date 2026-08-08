"""``AgentEmailMatcher`` —— email_filter 触发的邮件事件匹配（S4 W1，ADR D5）。

泛化 ``src/project_progress/detector.py`` 的 ``is_match``：
  - subject_pattern / sender_pattern：正则（``re.search``），匹配前输入截断 ``MATCH_INPUT_CAP``
    字符（ReDoS 收面 —— 灾难性回溯最多烧一个后台任务，不卡 watcher 主循环）；
  - folders：mailbox 显示名白名单（缺省 = 收件箱）；
  - 命中 = folder_ok AND subject_ok AND sender_ok（未配的谓词恒 True）。

纯函数对象，构造自已校验的 ``EmailFilterTrigger``（parse_trigger 保证正则可编译）。
"""

from __future__ import annotations

import re
from typing import Optional, Pattern

from src.agents.trigger import (
    MATCH_INPUT_CAP,
    CalendarBeforeStartTrigger,
    CalendarEventChangeTrigger,
    EmailFilterTrigger,
)

# folders 缺省白名单 = 收件箱（与主同步链 mailbox 显示名一致）。
_DEFAULT_FOLDER = "收件箱"


class AgentEmailMatcher:
    """把 ``EmailFilterTrigger`` 编译成可重用的邮件匹配器。"""

    def __init__(self, trigger: EmailFilterTrigger):
        self._folders = frozenset(trigger.folders) if trigger.folders else frozenset({_DEFAULT_FOLDER})
        self._thread_ids = frozenset(trigger.thread_ids)
        self._subject_re: Optional[Pattern[str]] = (
            re.compile(trigger.subject_pattern, re.UNICODE)
            if trigger.subject_pattern else None
        )
        # sender 用 IGNORECASE：邮箱地址大小写不敏感（对齐 detector 的 .lower() 语义）。
        self._sender_re: Optional[Pattern[str]] = (
            re.compile(trigger.sender_pattern, re.UNICODE | re.IGNORECASE)
            if trigger.sender_pattern else None
        )

    def is_match(
        self,
        *,
        sender: Optional[str],
        subject: Optional[str],
        mailbox: Optional[str],
        thread_id: Optional[str] = None,
    ) -> bool:
        """该邮件是否命中触发规则。输入截断 ``MATCH_INPUT_CAP`` 后再匹配。"""
        # folder gate（mailbox 显示名须在白名单内）。
        if (mailbox or "").strip() not in self._folders:
            return False
        if self._thread_ids and (thread_id or "") not in self._thread_ids:
            return False
        # subject gate（配了才要求匹配；输入截断防 ReDoS）。
        if self._subject_re is not None:
            if not self._subject_re.search((subject or "")[:MATCH_INPUT_CAP]):
                return False
        # sender gate（同上）。
        if self._sender_re is not None:
            if not self._sender_re.search((sender or "")[:MATCH_INPUT_CAP]):
                return False
        return True


class AgentCalendarMatcher:
    """Calendar trigger matcher; unlike email folders, empty calendar_ids means all."""

    def __init__(
        self,
        trigger: CalendarEventChangeTrigger | CalendarBeforeStartTrigger,
    ):
        self._calendar_ids = frozenset(trigger.calendar_ids)
        self._title_re = (
            re.compile(trigger.title_pattern, re.UNICODE)
            if trigger.title_pattern else None
        )
        self._organizer_re = (
            re.compile(trigger.organizer_pattern, re.UNICODE | re.IGNORECASE)
            if trigger.organizer_pattern else None
        )
        self._attendee_re = (
            re.compile(trigger.attendee_pattern, re.UNICODE | re.IGNORECASE)
            if trigger.attendee_pattern else None
        )

    def is_match(
        self,
        *,
        title: Optional[str],
        organizer: Optional[str],
        attendees: list[dict] | list[str],
        calendar_name: Optional[str],
    ) -> bool:
        if self._calendar_ids and (calendar_name or "") not in self._calendar_ids:
            return False
        if self._title_re and not self._title_re.search((title or "")[:MATCH_INPUT_CAP]):
            return False
        if self._organizer_re and not self._organizer_re.search(
            (organizer or "")[:MATCH_INPUT_CAP]
        ):
            return False
        if self._attendee_re:
            emails = [
                attendee.get("email", "") if isinstance(attendee, dict) else attendee
                for attendee in attendees
            ]
            if not any(
                self._attendee_re.search(str(email)[:MATCH_INPUT_CAP])
                for email in emails
            ):
                return False
        return True
