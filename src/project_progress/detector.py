"""识别项目周报邮件.

判定规则:
- 仅当 PROJECT_PROGRESS_SUBJECT_PATTERN 配置且匹配时认定为项目周报.
- PROJECT_PROGRESS_SENDER 是可选过滤项: 留空则跳过 sender 判定 (推荐, 因为
  实际发件人会变动); 配置后会做 sender + subject 双判定.
- 两者全空 → 永不匹配 (force user .env config).

历史:
- v1 消费某转发版 (单 sheet, 15 列, 状态靠 diff 推断不准).
- v2 切到直接发件人版 (4 sheet 全表 + 已出货 + 已暂停, 状态权威).
- v3 因实际发件人在不同周可能变动, sender 改为可选, 默认仅主题匹配.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional


@dataclass
class ProjectProgressMatch:
    sender_matched: bool
    subject_matched: bool
    sender_required: bool

    @property
    def both(self) -> bool:
        if self.sender_required:
            return self.sender_matched and self.subject_matched
        return self.subject_matched


class ProjectProgressDetector:
    """把"(可选发件人) + 标题"判断封装成可重用对象."""

    def __init__(
        self,
        sender: str = "",
        subject_pattern: str = "",
    ):
        self.sender = sender.strip().lower()
        self._has_pattern = bool(subject_pattern)
        self._subject_re = re.compile(subject_pattern or r".^", re.UNICODE)  # 空 pattern 永不匹配

    @property
    def sender_required(self) -> bool:
        return bool(self.sender)

    def matches(self, *, sender: Optional[str], subject: Optional[str]) -> ProjectProgressMatch:
        s_ok = bool(sender and self.sender and self.sender in str(sender).lower())
        t_ok = bool(subject and self._has_pattern and self._subject_re.search(str(subject)))
        return ProjectProgressMatch(
            sender_matched=s_ok, subject_matched=t_ok, sender_required=self.sender_required
        )

    def is_match(self, *, sender: Optional[str], subject: Optional[str]) -> bool:
        if not self._has_pattern:
            return False  # 全空配置永不匹配
        return self.matches(sender=sender, subject=subject).both
