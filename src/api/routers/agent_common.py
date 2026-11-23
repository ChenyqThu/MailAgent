"""Shared helpers for /api/agent router slices."""

from __future__ import annotations

from typing import Optional

from src.agent_config.store import get_agent_config_store as _ORIGINAL_GET_AGENT_CONFIG_STORE
from src.api.app import APIError


def resolve_agent_config_store():
    """Resolve AgentConfigStore honoring monkeypatches on either agent facade or store module."""
    import src.agent_config.store as store_mod
    from src.api.routers import agent as agent_mod

    facade_fn = getattr(agent_mod, "get_agent_config_store", None)
    if facade_fn is not None and facade_fn is not _ORIGINAL_GET_AGENT_CONFIG_STORE:
        return facade_fn()
    return store_mod.get_agent_config_store()

def _manifest_skill_names() -> set[str]:
    """当前 manifest 里的全部 skill 名（builtin + installed），用于 enable 端点的存在性校验。"""
    from src.skills.registry import build_manifest

    return {s.name for s in build_manifest(None).skills}



def _require_skill_creator() -> None:
    from src.skills.flags import skill_creator_enabled

    if not skill_creator_enabled():
        raise APIError(
            "E_NOT_FOUND", "skill creator feature is disabled", http_status=404, source="sqlite"
        )



def _pack_api_error(exc: Exception) -> APIError:
    from src.skills.pack_verify import PackError

    if isinstance(exc, PackError):
        hint: Optional[str] = None
        if isinstance(exc.details, dict) and isinstance(exc.details.get("availableSkills"), list):
            names = [str(n) for n in exc.details["availableSkills"] if isinstance(n, str) and n]
            if names:
                hint = ",".join(names)
        return APIError(exc.code, exc.message, hint=hint, http_status=exc.http_status, source="sqlite")
    return APIError("E_INVALID_ARG", str(exc), http_status=400, source="sqlite")


