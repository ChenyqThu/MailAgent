"""Hot-read feature switches owned by the skills subsystem."""

from __future__ import annotations

SKILL_CREATOR_ENV = "MAILAGENT_SKILL_CREATOR"


def skill_creator_enabled() -> bool:
    """Return the current Skill Creator flag; absent or malformed values default on."""
    try:
        from dotenv import dotenv_values

        from src.api.deps import get_env_file_path

        raw = (dotenv_values(get_env_file_path()) or {}).get(SKILL_CREATOR_ENV)
    except Exception:  # noqa: BLE001
        raw = None
    if raw is None or raw == "":
        return True
    normalized = str(raw).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return True
