"""Custom Agent JSON import/export compatibility helpers."""

from __future__ import annotations

import re
import uuid
from typing import Any

from src.agent_config.llm_providers import get_llm_provider_store
from src.agent_config.store import get_agent_config_store
from src.agents.agent_templates import AGENT_TEMPLATES
from src.agents.trigger import normalize_agent_config_patch
from src.reports import wire


def export_custom_agent(row: dict[str, Any]) -> dict[str, Any]:
    resolved = wire.resolve_agent(row)
    avatar = resolved.get("avatar")
    if isinstance(avatar, dict) and avatar.get("type") == "image":
        avatar = None
    return {
        "schema_version": 1,
        "kind": "mailagent.custom_agent",
        "agent": {
            "title": resolved.get("title") or "",
            "description": resolved.get("description") or "",
            "prompt": resolved.get("prompt") or "",
            "model": resolved.get("model") or None,
            "enabled": bool(resolved.get("enabled")),
            "trigger": resolved.get("trigger"),
            "tool_policy": resolved.get("tool_policy") or {"v": 1},
            "budget": resolved.get("budget") or {
                "max_runs_per_day": 24,
                "max_run_seconds": 1800,
            },
            "avatar": avatar,
        },
    }


def _new_agent_id(title: str, store: Any) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40] or "agent"
    while True:
        candidate = f"custom-{slug}-{uuid.uuid4().hex[:8]}"
        if store.get_agent(candidate) is None:
            return candidate


def _unmet_dependencies(agent: dict[str, Any]) -> list[dict[str, str]]:
    agent_store = get_agent_config_store()
    from src.skills.registry import build_manifest

    available_skills = {item.name for item in build_manifest(None).skills}
    tool_policy = agent.get("tool_policy") if isinstance(agent.get("tool_policy"), dict) else {}
    unmet: list[dict[str, str]] = []
    for name in tool_policy.get("skills") or []:
        if isinstance(name, str) and name not in available_skills:
            unmet.append({"type": "skill", "ref": name})
    grants = tool_policy.get("grant_connectors") or {}
    connector_ids = grants.keys() if isinstance(grants, dict) else grants if isinstance(grants, list) else []
    for connector_id in connector_ids:
        if isinstance(connector_id, str) and agent_store.get_connector(connector_id) is None:
            unmet.append({"type": "connector", "ref": connector_id})
    model = agent.get("model")
    if isinstance(model, str) and model:
        provider_id = model.split(":", 1)[0]
        if get_llm_provider_store().get_provider(provider_id) is None:
            unmet.append({"type": "model", "ref": model})
    return unmet


def import_custom_agent(body: dict[str, Any], store: Any) -> dict[str, Any]:
    if "template" in body:
        template = body.get("template")
        if not isinstance(template, str) or template not in AGENT_TEMPLATES:
            raise KeyError(str(template))
        agent = dict(AGENT_TEMPLATES[template])
    else:
        payload = body.get("payload")
        if not isinstance(payload, dict):
            raise ValueError("payload must be an object")
        if payload.get("schema_version") != 1 or payload.get("kind") != "mailagent.custom_agent":
            raise ValueError("schema_version must be 1 and kind must be mailagent.custom_agent")
        agent = payload.get("agent")
        if not isinstance(agent, dict):
            raise ValueError("payload.agent must be an object")
        agent = dict(agent)
    title = agent.get("title")
    if not isinstance(title, str) or not title.strip():
        raise ValueError("agent.title is required")
    agent["enabled"] = False
    normalized = normalize_agent_config_patch(agent, agent_type="custom")
    db_patch = wire.config_patch_to_db(normalized)
    agent_id = _new_agent_id(title, store)
    created = store.create_agent(agent_id, type="custom", title=title.strip(), enabled=False)
    updated = store.update_agent(agent_id, db_patch) or created
    return {
        "agent": wire.resolve_agent(updated),
        "enabled_forced_off": True,
        "unmet_dependencies": _unmet_dependencies(normalized),
    }
