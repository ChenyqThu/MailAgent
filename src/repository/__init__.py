"""Repository layer - SQLite SSoT 读写入口（v4 架构）.

Web / Agent / 反向同步 / LLM / Notion uploader 一律走 EmailRepository 读 SQLite,
不再各自重抽 AppleScript 或绕道 Notion。

详见 docs/reference/architecture/architecture_v4_sqlite_ssot.md.
"""

from src.repository.attachment_store import AttachmentStore
from src.repository.email_repository import (
    AttachmentPayload,
    AttachmentRecord,
    AttachmentSearchHit,
    AttachmentTextRecord,
    BodyPayload,
    ContactSuggestion,
    EmailBodyRecord,
    EmailFull,
    EmailMetadataRecord,
    EmailRepository,
    EmailSearchHit,
    EmailSearchResult,
    ThreadMember,
    smart_query_transform,
)
from src.repository.storage_payload_builder import build_storage_payloads
from src.repository.translation import TranslationRepository

__all__ = [
    "AttachmentPayload",
    "AttachmentRecord",
    "AttachmentSearchHit",
    "AttachmentStore",
    "AttachmentTextRecord",
    "BodyPayload",
    "ContactSuggestion",
    "EmailBodyRecord",
    "EmailFull",
    "EmailMetadataRecord",
    "EmailRepository",
    "EmailSearchHit",
    "EmailSearchResult",
    "ThreadMember",
    "TranslationRepository",
    "build_storage_payloads",
    "smart_query_transform",
]
