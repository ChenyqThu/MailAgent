"""Pydantic response schemas for Notification Center REST endpoints."""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel


class NotificationItemDto(BaseModel):
    """Single notification projection (`notifications._to_wire`)."""

    id: int
    category: str
    source: str
    severity: str
    state: str
    title: str
    body: str
    payload: Optional[dict[str, Any]] = None
    recurrenceNo: int
    firstCreatedAt: int
    lastEventAt: int
    readAt: Optional[int] = None
    snoozedUntil: Optional[int] = None
    resolvedAt: Optional[int] = None
    dismissedAt: Optional[int] = None


class NotificationUnreadCountResponse(BaseModel):
    """Badge aggregates returned by `GET /api/notifications/unread-count`."""

    total: int
    byCategory: dict[str, int]
    bySeverity: dict[str, int]
    openByCategory: dict[str, int]


class NotificationPreferencesDto(BaseModel):
    """Per-scenario notification delivery & meeting-prep preset config."""

    mailDelivery: str
    mailScope: str
    mailActionsEnabled: bool
    meetingDelivery: str
    meetingLeadMinutes: int
    meetingActionsEnabled: bool
    meetingPrepEnabled: bool
    meetingPrepMode: str
    meetingPrepLeadMinutes: int
    agentResultsDelivery: str
    systemAlertsDelivery: str
    suppressBannerWhenFocused: bool
    skipBannerWhenFeishuSent: bool


class NotificationReadAllResponse(BaseModel):
    """`POST /api/notifications/read-all` payload."""

    updated: int


__all__ = [
    "NotificationItemDto",
    "NotificationUnreadCountResponse",
    "NotificationPreferencesDto",
    "NotificationReadAllResponse",
]
