"""Canonical Matter domain vocabulary and pure validation helpers."""

from __future__ import annotations

from enum import StrEnum
from typing import Iterable, TypeAlias
import uuid


class MatterStatus(StrEnum):
    INBOX = "inbox"
    PLANNED = "planned"
    ACTIVE = "active"
    WAITING = "waiting"
    BLOCKED = "blocked"
    MONITORING = "monitoring"
    DONE = "done"
    CANCELED = "canceled"


class MatterHealth(StrEnum):
    UNKNOWN = "unknown"
    ON_TRACK = "on_track"
    AT_RISK = "at_risk"
    OFF_TRACK = "off_track"


class MatterPriority(StrEnum):
    P0 = "p0"
    P1 = "p1"
    P2 = "p2"
    P3 = "p3"


class MatterItemKind(StrEnum):
    ACTION = "action"
    MILESTONE = "milestone"
    DECISION = "decision"
    BLOCKER = "blocker"
    QUESTION = "question"
    NOTE = "note"


class MatterItemStatus(StrEnum):
    OPEN = "open"
    IN_PROGRESS = "in_progress"
    WAITING = "waiting"
    BLOCKED = "blocked"
    DONE = "done"
    CANCELED = "canceled"


class MatterResourceKind(StrEnum):
    EMAIL = "email"
    THREAD = "thread"
    EVENT = "event"
    DOC = "doc"
    FILE = "file"
    URL = "url"


class MatterRelationType(StrEnum):
    RELATED_TO = "related_to"
    DEPENDS_ON = "depends_on"
    BLOCKS = "blocks"
    FOLLOW_UP_OF = "follow_up_of"
    SUPERSEDES = "supersedes"


class MatterAttentionKind(StrEnum):
    WAIT_OVERDUE = "wait_overdue"
    ACTION_OVERDUE = "action_overdue"
    DEADLINE_NEAR = "deadline_near"
    HEALTH_DOWN = "health_down"
    NEEDS_REVIEW = "needs_review"
    RUN_FAILED = "run_failed"
    CONTEXT_GAP = "context_gap"


class MatterAttentionState(StrEnum):
    OPEN = "open"
    RESOLVED = "resolved"
    SNOOZED = "snoozed"
    DISMISSED = "dismissed"


class MatterChangeKind(StrEnum):
    FACT = "fact"
    INFERENCE = "inference"
    FIELD = "field"
    ACTION = "action"
    RESOURCE = "resource"


class MatterRunStatus(StrEnum):
    OK = "ok"
    NOOP = "noop"
    WARN = "warn"
    FAIL = "fail"


class MatterRunTrigger(StrEnum):
    MANUAL = "manual"
    SCHEDULE = "schedule"


class MatterAccessPolicy(StrEnum):
    ALLOWED = "allowed"
    METADATA_ONLY = "metadata_only"
    EXCLUDED = "excluded"


class MatterUpdateReviewStatus(StrEnum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    SUPERSEDED = "superseded"


class MatterActorKind(StrEnum):
    USER = "user"
    AGENT = "agent"
    SYSTEM = "system"


class MatterResourceSubscriptionState(StrEnum):
    NONE = "none"
    ACTIVE = "active"
    PAUSED = "paused"


EnumValues: TypeAlias = type[StrEnum] | Iterable[str]


def _values(enum_or_values: EnumValues) -> tuple[str, ...]:
    if isinstance(enum_or_values, type) and issubclass(enum_or_values, StrEnum):
        return tuple(member.value for member in enum_or_values)
    return tuple(str(value) for value in enum_or_values)


MATTER_STATUSES = _values(MatterStatus)
MATTER_HEALTH_VALUES = _values(MatterHealth)
MATTER_PRIORITIES = _values(MatterPriority)
MATTER_ITEM_KINDS = _values(MatterItemKind)
MATTER_ITEM_STATUSES = _values(MatterItemStatus)
MATTER_RESOURCE_KINDS = _values(MatterResourceKind)
MATTER_RELATION_TYPES = _values(MatterRelationType)
MATTER_ATTENTION_KINDS = _values(MatterAttentionKind)
MATTER_ATTENTION_STATES = _values(MatterAttentionState)
MATTER_CHANGE_KINDS = _values(MatterChangeKind)
MATTER_RUN_STATUSES = _values(MatterRunStatus)
MATTER_RUN_TRIGGERS = _values(MatterRunTrigger)
MATTER_ACCESS_POLICIES = _values(MatterAccessPolicy)
MATTER_UPDATE_REVIEW_STATUSES = _values(MatterUpdateReviewStatus)
MATTER_ACTOR_KINDS = _values(MatterActorKind)
MATTER_RESOURCE_SUBSCRIPTION_STATES = _values(MatterResourceSubscriptionState)
BUILTIN_MATTER_TYPES = ("客户交付", "商务", "售前", "问题", "内部", "产品")
MATTER_SEARCH_FIELDS = (
    "title",
    "description",
    "current_summary",
    "status",
    "items",
    "stakeholders",
    "notes",
)
MATTER_PERSON_NS = uuid.UUID("6ba7b811-9dad-11d1-80b4-00c04fd430c8")

MAX_TAGS = 20
MAX_TAG_LENGTH = 64


def format_public_id(seq: int) -> str:
    if seq < 1:
        raise ValueError("Matter sequence must be positive")
    return f"MAT-{seq:04d}"


def person_key_for_email(email: str | None) -> str:
    normalized = str(email or "").strip().lower()
    if normalized:
        return str(uuid.uuid5(MATTER_PERSON_NS, normalized))
    return str(uuid.uuid4())


def normalize_tags(tags: Iterable[str] | None) -> tuple[str, ...]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw_tag in tags or ():
        tag = str(raw_tag).strip()
        if not tag:
            continue
        if len(tag) > MAX_TAG_LENGTH:
            raise ValueError(f"tag exceeds {MAX_TAG_LENGTH} characters")
        if tag not in seen:
            seen.add(tag)
            normalized.append(tag)
        if len(normalized) > MAX_TAGS:
            raise ValueError(f"at most {MAX_TAGS} tags are allowed")
    return tuple(normalized)


def sql_check_clause(enum_or_values: EnumValues) -> str:
    values = _values(enum_or_values)
    if not values:
        raise ValueError("SQL CHECK values cannot be empty")
    quoted = ", ".join("'" + value.replace("'", "''") + "'" for value in values)
    return f"IN ({quoted})"
