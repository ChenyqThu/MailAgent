"""
Mail module constants - centralized mailbox name mappings.

This module provides a single source of truth for mailbox name mappings
used across different components (SQLite radar, AppleScript arm, etc.).

Usage:
    from src.mail.constants import MAILBOX_CONFIG

    # Get AppleScript name
    as_name = MAILBOX_CONFIG["收件箱"]["applescript_name"]

    # Get SQLite URL patterns
    patterns = MAILBOX_CONFIG["收件箱"]["sqlite_patterns"]
"""

from typing import Dict, List, TypedDict


class MailboxConfig(TypedDict):
    """Type definition for mailbox configuration."""
    applescript_name: str
    sqlite_patterns: List[str]


# Centralized mailbox configuration
# Maps user-friendly Chinese names to AppleScript and SQLite identifiers
MAILBOX_CONFIG: Dict[str, MailboxConfig] = {
    "收件箱": {
        "applescript_name": "收件箱",
        "sqlite_patterns": [
            "INBOX",
            "E6%94%B6%E4%BB%B6%E7%AE%B1",  # URL-encoded "收件箱"
        ],
    },
    "发件箱": {
        "applescript_name": "已发送邮件",
        "sqlite_patterns": [
            "Sent",
            "E5%8F%91%E4%BB%B6%E7%AE%B1",           # URL-encoded "发件箱" (ROWID=14)
            "E5%B7%B2%E5%8F%91%E9%80%81%E9%82%AE%E4%BB%B6",  # URL-encoded "已发送邮件" (ROWID=19)
            "E5%B7%B2%E5%8F%91%E9%80%81",           # URL-encoded "已发送"
        ],
    },
}


def get_applescript_name(mailbox: str) -> str:
    """Get AppleScript mailbox name from user-friendly name.

    Args:
        mailbox: User-friendly mailbox name (e.g., "收件箱", "发件箱")

    Returns:
        AppleScript mailbox name, or the original name if not found
    """
    config = MAILBOX_CONFIG.get(mailbox)
    if config:
        return config["applescript_name"]
    return mailbox


def get_sqlite_patterns(mailbox: str) -> List[str]:
    """Get SQLite URL patterns for a mailbox.

    Args:
        mailbox: User-friendly mailbox name (e.g., "收件箱", "发件箱")

    Returns:
        List of SQLite URL patterns to match
    """
    config = MAILBOX_CONFIG.get(mailbox)
    if config:
        return config["sqlite_patterns"]
    return [mailbox]


def get_all_mailbox_names() -> List[str]:
    """Get all supported mailbox names.

    Returns:
        List of user-friendly mailbox names
    """
    return list(MAILBOX_CONFIG.keys())
