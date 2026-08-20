"""通讯录治理专型 agent 的 report_agent 行内热读配置。"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from typing import List, Optional

from loguru import logger

CONTACT_GOVERNANCE_AGENT_ID = "contact_governance_agent"


@dataclass
class ContactGovernanceAgentConfig:
    row_exists: bool = False
    enabled: bool = False
    model: str = ""
    fallback_models: Optional[List[str]] = None
    fire_hour: int = 5


def get_contact_governance_agent_config(db_path: str) -> ContactGovernanceAgentConfig:
    """裸 sqlite3 热读；行/列缺失与坏 JSON 均 graceful 回默认。"""
    try:
        conn = sqlite3.connect(db_path, timeout=5.0)
        try:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                "SELECT enabled, model, fallback_models_json, trigger_json "
                "FROM report_agent WHERE id = ?",
                (CONTACT_GOVERNANCE_AGENT_ID,),
            ).fetchone()
        finally:
            conn.close()
    except sqlite3.Error as exc:
        logger.debug(f"[contact-governance-config] read skipped: {exc}")
        return ContactGovernanceAgentConfig(row_exists=False)

    if row is None:
        return ContactGovernanceAgentConfig(row_exists=False)

    fallback_models: Optional[List[str]] = None
    raw_fallbacks = row["fallback_models_json"]
    if raw_fallbacks:
        try:
            parsed = json.loads(raw_fallbacks)
            if isinstance(parsed, list):
                fallback_models = [
                    str(item).strip() for item in parsed if str(item).strip()
                ]
        except (json.JSONDecodeError, TypeError):
            fallback_models = None

    fire_hour = 5
    raw_trigger = row["trigger_json"]
    if raw_trigger:
        try:
            trigger = json.loads(raw_trigger)
            if isinstance(trigger, dict):
                candidate = int(trigger.get("fire_hour", fire_hour))
                if 0 <= candidate <= 23:
                    fire_hour = candidate
        except (json.JSONDecodeError, TypeError, ValueError):
            pass

    return ContactGovernanceAgentConfig(
        row_exists=True,
        enabled=bool(row["enabled"]),
        model=str(row["model"] or "").strip(),
        fallback_models=fallback_models,
        fire_hour=fire_hour,
    )
