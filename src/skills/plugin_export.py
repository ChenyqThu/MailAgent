"""Export installed skill packages as Skill or Agent Plugin ZIP archives."""

from __future__ import annotations

import io
import json
import os
import zipfile
from typing import Optional

from src.agent_config.store import AgentConfigStore, get_agent_config_store
from src.skills.pack_fetch import skill_dir
from src.skills.pack_verify import PackError, compute_files_and_hash


def export_skill(name: str, *, format: str = "skill", store: Optional[AgentConfigStore] = None) -> bytes:
    if format not in {"skill", "plugin"}:
        raise PackError("E_INVALID_ARG", "format must be skill|plugin")
    store = store or get_agent_config_store()
    row = store.get_skill(name)
    if row is None or not row.files_json:
        raise PackError("E_NOT_FOUND", "skill is builtin or has no exportable package files", http_status=404)
    try:
        expected_files = json.loads(row.files_json)
    except json.JSONDecodeError as exc:
        raise PackError("E_PACK_HASH_MISMATCH", "stored package file index is invalid", http_status=409) from exc
    content_dir = skill_dir(name)
    current_files, current_hash = compute_files_and_hash(content_dir)
    if current_hash != row.package_hash or current_files != expected_files:
        raise PackError("E_PACK_HASH_MISMATCH", "installed skill package has been modified", http_status=409)
    manifest = row.manifest if isinstance(row.manifest, dict) else {}
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        if format == "plugin":
            plugin = {"name": name, "version": manifest.get("version") or row.version or "0.1.0", "description": manifest.get("description") or ""}
            if manifest.get("license"):
                plugin["license"] = manifest["license"]
            archive.writestr("plugin.json", json.dumps(plugin, ensure_ascii=False, indent=2) + "\n")
        prefix = "" if format == "skill" else f"skills/{name}/"
        for rel in sorted(expected_files):
            normalized = rel.replace("\\", "/")
            if normalized == "config.json" or normalized.startswith("../") or normalized.startswith("/"):
                continue
            path = os.path.join(content_dir, *normalized.split("/"))
            archive.write(path, prefix + normalized)
    return output.getvalue()
