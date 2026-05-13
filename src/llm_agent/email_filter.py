"""Pre-LLM email filter: skip system emails that don't need AI analysis.

Matches the "第零步：邮件过滤" rules from the Notion Email Agent instructions.
Filtered emails get fixed field values written directly to Notion, bypassing LLM.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Optional

# DMS system emails
_DMS_SENDER = "dmsmailer@tp-link.com.hk"
_DMS_SUBJECT_KEYWORDS = ("DMS", "超期任务提醒", "待完成任务列表")

# TP-Link AMS system emails
_AMS_SENDER = "itsection@tp-link.com.hk"
_AMS_SUBJECT_KEYWORDS = ("AMS",)


@dataclass
class FilterResult:
    """Non-None means the email was filtered; carry the fixed labels."""
    reason: str


def check_email_filter(
    sender: str,
    subject: str,
) -> Optional[FilterResult]:
    """Return FilterResult if the email should skip LLM, else None."""
    sender_lower = (sender or "").lower()
    subject_str = subject or ""

    # DMS
    if _DMS_SENDER in sender_lower:
        return FilterResult(reason=f"DMS sender: {_DMS_SENDER}")
    for kw in _DMS_SUBJECT_KEYWORDS:
        if kw in subject_str:
            return FilterResult(reason=f"DMS subject keyword: {kw}")

    # AMS
    if _AMS_SENDER in sender_lower:
        return FilterResult(reason=f"AMS sender: {_AMS_SENDER}")
    for kw in _AMS_SUBJECT_KEYWORDS:
        if kw in subject_str:
            return FilterResult(reason=f"AMS subject keyword: {kw}")

    return None


def filtered_labels_props() -> dict:
    """Return the fixed Notion properties for a filtered email."""
    from .schema import PROCESSING_STATUS_COMPLETED

    return {
        "Processing Status": {"select": {"name": PROCESSING_STATUS_COMPLETED}},
        "Priority": {"select": {"name": "⚪ 低"}},
        "Action Required": {"checkbox": False},
        "Action Type": {"select": {"name": "仅供参考"}},
        "Mail Actions": {"multi_select": [
            {"name": "🗑️ Archived"},
            {"name": "✅ Marked as Read"},
        ]},
        "Category": {"select": {"name": "🔔 系统通知"}},
        "AI Summary": {"rich_text": [{"text": {"content": "系统通知邮件，已自动归档"}}]},
    }
