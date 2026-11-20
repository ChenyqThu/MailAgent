"""Selectable notification channel preferences & meeting-prep preset synchronization.

Stored inside ``sync_state['notification.preferences.v1']`` in ``sync_store.db`` so
all workers (mail sync, CalDAV reminder, agent run worker, FastAPI routes) share a
single source of truth with zero schema migration.
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Union

NOTIFICATION_PREFS_STATE_KEY = "notification.preferences.v1"
MEETING_PREP_PRESET_AGENT_ID = "preset-meeting-prep"
MEETING_PREP_SESSION_PREFIX = "meeting_prep_session:"

SCENARIO_DELIVERY_VALUES = ("off", "center_only", "system_only", "both")
MAIL_SCOPE_VALUES = ("urgent_only", "urgent_and_important")
MEETING_LEAD_MINUTES_VALUES = (5, 10, 15, 30)
MEETING_PREP_MODE_VALUES = ("on_demand", "auto_before")
MEETING_PREP_LEAD_MINUTES_VALUES = (15, 30, 60, 120)

DEFAULT_NOTIFICATION_PREFS: Dict[str, Any] = {
    "mailDelivery": "both",
    "mailScope": "urgent_and_important",
    "mailActionsEnabled": True,
    "meetingDelivery": "both",
    "meetingLeadMinutes": 10,
    "meetingActionsEnabled": True,
    "meetingPrepEnabled": False,
    "meetingPrepMode": "on_demand",
    "meetingPrepLeadMinutes": 30,
    "agentResultsDelivery": "center_only",
    "systemAlertsDelivery": "center_only",
    "suppressBannerWhenFocused": True,
    "skipBannerWhenFeishuSent": True,
}

_DELIVERY_KEYS = (
    "mailDelivery",
    "meetingDelivery",
    "agentResultsDelivery",
    "systemAlertsDelivery",
)
_BOOL_KEYS = (
    "mailActionsEnabled",
    "meetingActionsEnabled",
    "meetingPrepEnabled",
    "suppressBannerWhenFocused",
    "skipBannerWhenFeishuSent",
)


def _meeting_prep_session_key(ical_uid: str, occurrence_start_iso: str) -> str:
    return f"{MEETING_PREP_SESSION_PREFIX}{ical_uid}:{occurrence_start_iso}"


def sanitize_notification_prefs(
    raw: Optional[Mapping[str, Any]],
    base: Optional[Mapping[str, Any]] = None,
    *,
    strict: bool = False,
) -> Dict[str, Any]:
    """Validate and merge a partial preference mapping onto ``base`` / defaults."""
    out: Dict[str, Any] = dict(DEFAULT_NOTIFICATION_PREFS)
    if base:
        for k in DEFAULT_NOTIFICATION_PREFS:
            if k in base:
                out[k] = base[k]
    if not raw or not isinstance(raw, Mapping):
        return out

    unknown = [k for k in raw if k not in DEFAULT_NOTIFICATION_PREFS]
    if strict and unknown:
        raise ValueError(f"unknown notification preference key(s): {', '.join(unknown)}")

    for k in _DELIVERY_KEYS:
        if k in raw:
            val = raw[k]
            if val in SCENARIO_DELIVERY_VALUES:
                out[k] = val
            elif strict:
                raise ValueError(f"{k} must be one of {SCENARIO_DELIVERY_VALUES}")

    if "mailScope" in raw:
        val = raw["mailScope"]
        if val in MAIL_SCOPE_VALUES:
            out["mailScope"] = val
        elif strict:
            raise ValueError(f"mailScope must be one of {MAIL_SCOPE_VALUES}")

    if "meetingLeadMinutes" in raw:
        val = raw["meetingLeadMinutes"]
        if type(val) is int and val in MEETING_LEAD_MINUTES_VALUES:
            out["meetingLeadMinutes"] = val
        elif strict:
            raise ValueError(
                f"meetingLeadMinutes must be one of {MEETING_LEAD_MINUTES_VALUES}"
            )

    if "meetingPrepMode" in raw:
        val = raw["meetingPrepMode"]
        if val in MEETING_PREP_MODE_VALUES:
            out["meetingPrepMode"] = val
        elif strict:
            raise ValueError(
                f"meetingPrepMode must be one of {MEETING_PREP_MODE_VALUES}"
            )

    if "meetingPrepLeadMinutes" in raw:
        val = raw["meetingPrepLeadMinutes"]
        if type(val) is int and val in MEETING_PREP_LEAD_MINUTES_VALUES:
            out["meetingPrepLeadMinutes"] = val
        elif strict:
            raise ValueError(
                "meetingPrepLeadMinutes must be one of "
                f"{MEETING_PREP_LEAD_MINUTES_VALUES}"
            )

    for k in _BOOL_KEYS:
        if k in raw:
            val = raw[k]
            if isinstance(val, bool):
                out[k] = val
            elif strict:
                raise ValueError(f"{k} must be a boolean")

    return out


def has_saved_notification_prefs(db_path: Union[str, Path]) -> bool:
    """Return True if ``sync_state`` holds an explicit notification preferences row."""
    if not db_path:
        return False
    try:
        conn = sqlite3.connect(str(db_path), timeout=5.0)
        try:
            row = conn.execute(
                "SELECT 1 FROM sync_state WHERE key = ?",
                (NOTIFICATION_PREFS_STATE_KEY,),
            ).fetchone()
            return row is not None
        finally:
            conn.close()
    except sqlite3.Error:
        return False


def load_notification_prefs(db_path: Union[str, Path]) -> Dict[str, Any]:
    """Read notification preferences from ``sync_state``; fail-open to defaults."""
    if not db_path:
        return dict(DEFAULT_NOTIFICATION_PREFS)
    try:
        conn = sqlite3.connect(str(db_path), timeout=5.0)
        try:
            row = conn.execute(
                "SELECT value FROM sync_state WHERE key = ?",
                (NOTIFICATION_PREFS_STATE_KEY,),
            ).fetchone()
        finally:
            conn.close()
        if row is None or not row[0]:
            return dict(DEFAULT_NOTIFICATION_PREFS)
        parsed = json.loads(row[0])
        if not isinstance(parsed, dict):
            return dict(DEFAULT_NOTIFICATION_PREFS)
        return sanitize_notification_prefs(parsed, strict=False)
    except (sqlite3.Error, ValueError, TypeError):
        return dict(DEFAULT_NOTIFICATION_PREFS)


def save_notification_prefs(
    db_path: Union[str, Path],
    patch: Mapping[str, Any],
) -> Dict[str, Any]:
    """Validate and persist a preference patch into ``sync_state``."""
    current = load_notification_prefs(db_path)
    merged = sanitize_notification_prefs(patch, base=current, strict=True)
    payload = json.dumps(merged, ensure_ascii=False)
    now = time.time()
    conn = sqlite3.connect(str(db_path), timeout=30.0)
    try:
        conn.execute("PRAGMA busy_timeout = 30000")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sync_state (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at REAL
            )
            """
        )
        conn.execute(
            """
            INSERT INTO sync_state (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
            """,
            (NOTIFICATION_PREFS_STATE_KEY, payload, now),
        )
        conn.commit()
    finally:
        conn.close()
    return merged


def sync_meeting_prep_preset_agent(
    prefs: Mapping[str, Any],
    report_store: Any,
) -> Optional[str]:
    """Idempotently sync managed preset custom agent ``preset-meeting-prep``.

    When ``meetingPrepEnabled`` is False, disables the preset row if present without
    deleting user history. When True, creates the row from ``AGENT_TEMPLATES['meeting_prep']``
    if missing, enables it, and configures the ``calendar_before_start`` trigger entry's
    ``enabled`` flag according to ``meetingPrepMode`` ('auto_before' vs 'on_demand') and
    ``lead_seconds`` from ``meetingPrepLeadMinutes``.
    """
    if report_store is None:
        return None
    enabled = bool(prefs.get("meetingPrepEnabled", False))
    existing = report_store.get_agent(MEETING_PREP_PRESET_AGENT_ID)
    if not enabled:
        if existing is not None:
            report_store.update_agent(MEETING_PREP_PRESET_AGENT_ID, {"enabled": 0})
        return None

    from src.agents.agent_templates import AGENT_TEMPLATES
    from src.agents.trigger import normalize_agent_config_patch
    from src.reports import wire

    tpl = dict(AGENT_TEMPLATES["meeting_prep"])
    lead_minutes = int(prefs.get("meetingPrepLeadMinutes") or 30)
    auto_before = prefs.get("meetingPrepMode") == "auto_before"
    trigger_patch = {
        "v": 2,
        "triggers": [
            {
                "id": "trg_preset_before_start",
                "kind": "calendar_before_start",
                "enabled": auto_before,
                "lead_seconds": lead_minutes * 60,
            }
        ],
    }

    if existing is None:
        report_store.create_agent(
            MEETING_PREP_PRESET_AGENT_ID,
            type="custom",
            title=str(tpl.get("title") or "会前准备"),
            enabled=True,
        )
        config_patch: Dict[str, Any] = {
            "enabled": True,
            "title": tpl.get("title") or "会前准备",
            "description": tpl.get("description") or "",
            "prompt": tpl.get("prompt") or "",
            "model": tpl.get("model"),
            "trigger": trigger_patch,
            "tool_policy": tpl.get("tool_policy"),
            "budget": tpl.get("budget"),
            "avatar": {"type": "bot", "shape": "capsule", "color": "blue"},
        }
    else:
        config_patch = {
            "enabled": True,
            "trigger": trigger_patch,
        }

    normalized = normalize_agent_config_patch(config_patch, agent_type="custom")
    db_patch = wire.config_patch_to_db(normalized)
    report_store.update_agent(MEETING_PREP_PRESET_AGENT_ID, db_patch)
    return MEETING_PREP_PRESET_AGENT_ID


def record_meeting_prep_session(
    db_path: Union[str, Path],
    ical_uid: str,
    occurrence_start_iso: str,
    session_id: int,
    agent_id: str = MEETING_PREP_PRESET_AGENT_ID,
) -> None:
    """Associate a completed meeting-prep chat session with a calendar occurrence."""
    if not db_path or not ical_uid or not occurrence_start_iso or session_id <= 0:
        return
    key = _meeting_prep_session_key(ical_uid, occurrence_start_iso)
    val = json.dumps(
        {"session_id": int(session_id), "agent_id": agent_id},
        ensure_ascii=False,
    )
    try:
        conn = sqlite3.connect(str(db_path), timeout=10.0)
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS sync_state (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    updated_at REAL
                )
                """
            )
            conn.execute(
                """
                INSERT INTO sync_state (key, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
                """,
                (key, val, time.time()),
            )
            conn.commit()
        finally:
            conn.close()
    except sqlite3.Error:
        return


def lookup_meeting_prep_session(
    db_path: Union[str, Path],
    ical_uid: str,
    occurrence_start_iso: str,
) -> Optional[Dict[str, Any]]:
    """Look up the completed meeting-prep session for ``(ical_uid, occurrence_start_iso)``."""
    if not db_path or not ical_uid or not occurrence_start_iso:
        return None
    key = _meeting_prep_session_key(ical_uid, occurrence_start_iso)
    try:
        conn = sqlite3.connect(str(db_path), timeout=5.0)
        try:
            row = conn.execute(
                "SELECT value FROM sync_state WHERE key = ?",
                (key,),
            ).fetchone()
        finally:
            conn.close()
        if row is None or not row[0]:
            return None
        parsed = json.loads(row[0])
        if not isinstance(parsed, dict):
            return None
        sid = parsed.get("session_id")
        if not isinstance(sid, int) or sid <= 0:
            return None
        return {
            "session_id": sid,
            "agent_id": str(parsed.get("agent_id") or MEETING_PREP_PRESET_AGENT_ID),
        }
    except (sqlite3.Error, ValueError, TypeError):
        return None
