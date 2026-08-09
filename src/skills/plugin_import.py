"""Vercel Agent Plugins 1.0 compatibility importer into isolated Skill drafts."""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Any, Optional

from src.agent_config.store import AgentConfigStore, get_agent_config_store
from src.skills.draft import (
    create_draft,
    discard_draft,
    import_file_into_draft,
    validate_draft,
)
from src.skills.pack_fetch import skills_data_root
from src.skills.pack_verify import PackError, safe_copy_tree, safe_extract_zip

MAX_PLUGIN_ZIP_BYTES = 15 * 1024 * 1024
_SKILL_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,40}$")
_ROOT_NOTICE_RE = re.compile(r"^(LICENSE|NOTICE)", re.IGNORECASE)


def _sanitize_skill_name(value: str) -> Optional[str]:
    normalized = re.sub(r"[^a-z0-9_-]+", "-", value.strip().lower()).strip("-")[:41]
    return normalized if _SKILL_NAME_RE.fullmatch(normalized) else None


def _frontmatter(skill_md: Path) -> dict[str, str]:
    try:
        text = skill_md.read_text(encoding="utf-8")
        if not text.startswith("---\n"):
            return {}
        end = text.find("\n---", 4)
        if end < 0:
            return {}
        out: dict[str, str] = {}
        for line in text[4:end].splitlines():
            key, sep, value = line.partition(":")
            if sep and key.strip() in {"name", "description"}:
                out[key.strip()] = value.strip().strip("'\"")
        return out
    except (OSError, UnicodeDecodeError):
        return {}


def _read_plugin_manifest(root: Path) -> dict[str, Any]:
    path = root / "plugin.json"
    if not path.is_file():
        raise PackError("E_PLUGIN_BAD_MANIFEST", "plugin.json not found", http_status=400)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PackError("E_PLUGIN_BAD_MANIFEST", f"cannot parse plugin.json: {exc}") from exc
    if not isinstance(raw, dict) or not isinstance(raw.get("name"), str) or not raw["name"].strip():
        raise PackError("E_PLUGIN_BAD_MANIFEST", "plugin.json.name must be a non-empty string")
    for key in ("version", "description", "license"):
        if key in raw and raw[key] is not None and not isinstance(raw[key], str):
            raise PackError("E_PLUGIN_BAD_MANIFEST", f"plugin.json.{key} must be a string")
    return raw


def _mcp_servers(root: Path) -> list[dict[str, Any]]:
    path = root / "mcp.json"
    if not path.is_file():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("mcp.json must be an object")
        names: list[str] = []
        if isinstance(raw.get("mcpServers"), dict):
            names.extend(str(name) for name in raw["mcpServers"])
        elif isinstance(raw.get("servers"), list):
            for item in raw["servers"]:
                if isinstance(item, dict) and isinstance(item.get("name"), str):
                    names.append(item["name"])
        else:
            raise ValueError("expected mcpServers object or servers array")
        return [{"name": name, "status": "detected_not_imported"} for name in names]
    except Exception as exc:  # noqa: BLE001
        return [{"name": "mcp.json", "status": "invalid", "errors": [str(exc)]}]


def _allowed_file(rel: str) -> bool:
    first = rel.split("/", 1)[0]
    return rel == "SKILL.md" or first in {"references", "assets", "scripts", "tests"} or bool(
        _ROOT_NOTICE_RE.match(first)
    )


def import_plugin(
    *,
    local_path: str | None = None,
    zip_bytes: bytes | None = None,
    store: Optional[AgentConfigStore] = None,
) -> dict:
    if (local_path is None) == (zip_bytes is None):
        raise PackError("E_INVALID_ARG", "provide exactly one of local_path or zip_bytes")
    if zip_bytes is not None and len(zip_bytes) > MAX_PLUGIN_ZIP_BYTES:
        raise PackError("E_PACK_BOMB", "plugin upload exceeds 15 MiB", http_status=413)
    store = store or get_agent_config_store()
    root = skills_data_root()
    os.makedirs(root, exist_ok=True)
    temp_unit = os.path.join(root, f".tmp-{uuid.uuid4().hex}")
    os.makedirs(temp_unit, exist_ok=False)
    try:
        source = "upload"
        if local_path is not None:
            source = os.path.basename(os.path.normpath(local_path))
            if os.path.isdir(local_path):
                safe_copy_tree(local_path, temp_unit)
            elif os.path.isfile(local_path) and local_path.lower().endswith(".zip"):
                safe_extract_zip(local_path, temp_unit)
            else:
                raise PackError("E_NOT_FOUND", "plugin source must be a directory or .zip file", http_status=404)
        else:
            with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as handle:
                handle.write(zip_bytes or b"")
                zip_path = handle.name
            try:
                safe_extract_zip(zip_path, temp_unit)
            finally:
                os.unlink(zip_path)
        unpacked = Path(temp_unit)
        manifest = _read_plugin_manifest(unpacked)
        root_notices = [p for p in unpacked.iterdir() if p.is_file() and _ROOT_NOTICE_RE.match(p.name)]
        skills: list[dict[str, Any]] = []
        skills_root = unpacked / "skills"
        candidates = sorted(
            (p for p in skills_root.iterdir() if p.is_dir() and (p / "SKILL.md").is_file()),
            key=lambda p: p.name,
        ) if skills_root.is_dir() else []
        for skill_path in candidates:
            rel_path = f"skills/{skill_path.name}"
            name = _sanitize_skill_name(skill_path.name)
            if name is None:
                skills.append({"path": rel_path, "status": "unsupported", "errors": ["skill name cannot be sanitized to a valid slug"]})
                continue
            draft_id: Optional[str] = None
            try:
                fm = _frontmatter(skill_path / "SKILL.md")
                mapped = {
                    "manifest_version": 2,
                    "name": name,
                    "title": fm.get("name") or skill_path.name,
                    "description": fm.get("description") or "",
                    "type": "document",
                    "version": manifest.get("version") or "0.1.0",
                    "docs_path": "SKILL.md",
                    "default_enabled": True,
                    "license": manifest.get("license"),
                    "tools": [],
                }
                row = create_draft(name, manifest=mapped, store=store)
                draft_id = row.id
                for path in sorted(p for p in skill_path.rglob("*") if p.is_file()):
                    rel = path.relative_to(skill_path).as_posix()
                    if rel == "manifest.json" or not _allowed_file(rel):
                        continue
                    import_file_into_draft(draft_id, rel, path.read_bytes(), store=store)
                for notice in root_notices:
                    target = skill_path / notice.name
                    if not target.exists():
                        import_file_into_draft(draft_id, notice.name, notice.read_bytes(), store=store)
                validation = validate_draft(draft_id, store=store)
                item: dict[str, Any] = {"path": rel_path, "status": "ready" if validation["valid"] else "invalid", "draftId": draft_id}
                if not validation["valid"]:
                    item["errors"] = validation["errors"]
                skills.append(item)
            except Exception as exc:  # noqa: BLE001
                if draft_id is not None:
                    try:
                        discard_draft(draft_id, store=store)
                    except Exception:  # noqa: BLE001
                        pass
                skills.append({"path": rel_path, "status": "invalid", "errors": [str(exc)]})
        plugin = {"name": manifest["name"].strip(), "source": source}
        if manifest.get("version"):
            plugin["version"] = manifest["version"]
        return {"plugin": plugin, "skills": skills, "mcpServers": _mcp_servers(unpacked)}
    finally:
        shutil.rmtree(temp_unit, ignore_errors=True)
