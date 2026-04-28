"""识别项目周报邮件.

通过发件人 + 标题正则双重匹配判断邮件是否是项目周报. 默认值留空, 需在 .env
显式配置 PROJECT_PROGRESS_SENDER / PROJECT_PROGRESS_SUBJECT_PATTERN.

历史: v1 消费某转发版 (单 sheet, 15 列, 状态靠 diff 推断不准);
v2 切到直接发件人版 (4 sheet 全表 + 已出货 + 已暂停, 状态权威).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional


@dataclass
class ProjectProgressMatch:
    sender_matched: bool
    subject_matched: bool

    @property
    def both(self) -> bool:
        return self.sender_matched and self.subject_matched


class ProjectProgressDetector:
    """把"发件人 + 标题"判断封装成可重用对象."""

    def __init__(
        self,
        sender: str = "",
        subject_pattern: str = "",
    ):
        self.sender = sender.strip().lower()
        self._subject_re = re.compile(subject_pattern or r".^", re.UNICODE)  # 空 pattern 永不匹配

    def matches(self, *, sender: Optional[str], subject: Optional[str]) -> ProjectProgressMatch:
        s_ok = bool(sender and self.sender and self.sender in str(sender).lower())
        t_ok = bool(subject and self._subject_re.search(str(subject)))
        return ProjectProgressMatch(sender_matched=s_ok, subject_matched=t_ok)

    def is_match(self, *, sender: Optional[str], subject: Optional[str]) -> bool:
        return self.matches(sender=sender, subject=subject).both
