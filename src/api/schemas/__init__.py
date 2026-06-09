"""Pydantic response models for the FastAPI remote-access backend.

Each `data` model mirrors the matching docs/cli-schema/*.schema.json shape (and
the frontend shared/api/types.ts aliases) so routers re-emit CLI/repo payloads
under the app.py response envelope (success_envelope / error_envelope) without
re-designing contracts. Field naming + nullability are load-bearing — the web
build's cli.gen.ts codegen and its ajv conformance tests derive from the same
JSON Schemas.

Pydantic-only (no fastapi import here) so this package imports even before
fastapi is installed; routers add the FastAPI wiring.

Convention:
  - read-endpoint `data` models = the CLI/frontend read shape (snake_case for
    CLI-derived; camelCase ONLY for the hand-written frontend AI/translation
    types).
  - loose CLI-backed write payloads use `extra="allow"` so a backend schema bump
    that adds a field doesn't break the API before this layer is updated.
"""

from __future__ import annotations

# NOTE: the response envelope is owned by src/api/app.py (success_envelope /
# error_envelope / APIError). schemas/envelope.py is now a docstring-only contract
# note — its old pydantic ApiResponse/ApiMeta/ApiError/PartialFailure* models were
# dead code (no router/test imported them) and were removed in the Sprint 1B cleanup.
from src.api.schemas.email import (
    AIPriority,
    ArchiveResult,
    BodyFormat,
    ComposeMode,
    DraftPlanResult,
    DraftResult,
    EmailBody,
    EmailBodySummary,
    EmailGetAttachmentItem,
    EmailListItem,
    EmailRecord,
    FlagOutboxEntry,
    FlagPayload,
    FlagResult,
    Lang,
    PinnedIds,
    ResyncPlan,
    ResyncResult,
    SearchHit,
    SearchResult,
    SendResult,
    SyncStatus,
)
from src.api.schemas.attachment import AttachmentItem
from src.api.schemas.admin import (
    AdminHealthData,
    AdminStatsData,
    CleanupDeadLetterResult,
    DavMailHealthData,
    DavMailLevel,
    DeadLetterItem,
    DeadLetterRetryResult,
    SyncStoreSection,
    SystemAlertItem,
    SystemAlertsData,
)
from src.api.schemas.llm import (
    LlmCost,
    LlmRunData,
    LlmSelfTestData,
    LlmStatsData,
)
from src.api.schemas.calendar import (
    CalendarEventDetail,
    CalendarEventGetData,
    CalendarEventsListData,
    CalendarEventSource,
    CalendarFilters,
    CalendarOccurrence,
    CalendarSyncStateItem,
    CalendarSyncStatusData,
    CalendarWindow,
)
from src.api.schemas.ai import (
    DeleteCachedResult,
    TargetLang,
    TranslateBatchResult,
    TranslationCache,
    TranslationSegment,
)

__all__ = [
    # (envelope: owned by src/api/app.py; schemas/envelope.py is docstring-only now)
    # email
    "SyncStatus", "AIPriority", "Lang", "BodyFormat", "ComposeMode",
    "EmailListItem", "EmailBodySummary", "EmailGetAttachmentItem", "EmailRecord",
    "EmailBody", "SearchHit", "SearchResult",
    "ResyncPlan", "ResyncResult",
    "FlagPayload", "FlagOutboxEntry", "FlagResult",
    "ArchiveResult",
    "DraftPlanResult", "DraftResult", "SendResult",
    "PinnedIds",
    # attachment
    "AttachmentItem",
    # admin
    "AdminHealthData", "SyncStoreSection", "AdminStatsData",
    "DeadLetterItem", "DeadLetterRetryResult", "CleanupDeadLetterResult",
    "DavMailLevel", "DavMailHealthData",
    "SystemAlertItem", "SystemAlertsData",
    # llm
    "LlmRunData", "LlmCost", "LlmStatsData", "LlmSelfTestData",
    # calendar
    "CalendarEventSource",
    "CalendarOccurrence", "CalendarWindow", "CalendarFilters",
    "CalendarEventsListData",
    "CalendarEventDetail", "CalendarEventGetData",
    "CalendarSyncStateItem", "CalendarSyncStatusData",
    # ai / translation
    "TargetLang", "TranslationSegment", "TranslationCache",
    "TranslateBatchResult", "DeleteCachedResult",
]
