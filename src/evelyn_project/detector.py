"""识别 Evelyn 周项目邮件。

规则:
  - 发件人含 evelyn.wei@tp-link.com（不区分大小写）
  - 标题正则匹配 "【项目进度】项目deadline汇报 ... 市场产品"

规则来源: 用户需求 + Evelyn 实际邮件标题观察:
  - "转发: 【项目进度】项目deadline汇报0420_市场产品"
  - "转发: 【项目进度】项目deadline汇报0413_市场产品"
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional


@dataclass
class EvelynMatch:
    sender_matched: bool
    subject_matched: bool

    @property
    def both(self) -> bool:
        return self.sender_matched and self.subject_matched


class EvelynProjectDetector:
    """把"发件人 + 标题"判断封装成可重用对象。"""

    def __init__(
        self,
        sender: str = "evelyn.wei@tp-link.com",
        subject_pattern: str = r"【项目进度】项目deadline汇报.*市场产品",
    ):
        self.sender = sender.strip().lower()
        self._subject_re = re.compile(subject_pattern, re.UNICODE)

    def matches(self, *, sender: Optional[str], subject: Optional[str]) -> EvelynMatch:
        s_ok = bool(sender and self.sender in str(sender).lower())
        t_ok = bool(subject and self._subject_re.search(str(subject)))
        return EvelynMatch(sender_matched=s_ok, subject_matched=t_ok)

    def is_match(self, *, sender: Optional[str], subject: Optional[str]) -> bool:
        return self.matches(sender=sender, subject=subject).both
