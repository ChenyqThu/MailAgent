"""Isolated Skill Creator drafts and the publish lifecycle."""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import time
from pathlib import Path
from typing import Any, Optional

from pydantic import ValidationError

from src.agent_config.store import AgentConfigStore, SkillDraftRow, get_agent_config_store
from src.skills.models import SkillPackageManifest
from src.skills.pack_fetch import skill_dir, skills_data_root
from src.skills.pack_verify import (
    PackError,
    _assert_no_escape,
    _reject_member_path,
    compute_files_and_hash,
    verify_content_dir,
)

DRAFT_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{0,40}-[0-9a-f]{12}$")
MAX_DRAFT_FILE_BYTES = 1 * 1024 * 1024
MAX_DRAFT_FILES = 200
MAX_DRAFT_TOTAL_BYTES = 10 * 1024 * 1024
SCRIPT_NOTE_FIELDS = (
    "why_script",
    "reads",
    "writes",
    "network",
    "secrets",
    "entrypoint",
    "smoke",
)


def _draft_root() -> str:
    return os.path.join(skills_data_root(), ".draft")


def new_draft_id(name: str) -> str:
    canonical = (name or "").strip()
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,40}", canonical):
        raise PackError("E_INVALID_ARG", "invalid skill draft name", http_status=400)
    return f"{canonical}-{secrets.token_hex(6)}"


def draft_dir(draft_id: str) -> str:
    if not DRAFT_ID_RE.fullmatch(draft_id or ""):
        raise PackError("E_INVALID_ARG", "invalid skill draft id", http_status=400)
    root = os.path.realpath(_draft_root())
    candidate = os.path.realpath(os.path.join(root, draft_id))
    if not candidate.startswith(root + os.sep):
        raise PackError("E_PACK_UNSAFE_PATH", "skill draft escapes draft root", http_status=400)
    return candidate


def draft_content_dir(draft_id: str) -> str:
    return os.path.join(draft_dir(draft_id), "content")


def _require_mutable(row: SkillDraftRow) -> None:
    if row.status in {"published", "discarded"}:
        raise PackError(
            "E_DRAFT_TERMINAL", f"skill draft is already {row.status}", http_status=409
        )


def _tree_stats(content_dir: str) -> tuple[int, int]:
    count = 0
    total = 0
    if not os.path.isdir(content_dir):
        return count, total
    for root, dirs, files in os.walk(content_dir):
        for dirname in dirs:
            if os.path.islink(os.path.join(root, dirname)):
                raise PackError("E_PACK_SYMLINK", f"symlink present in draft: {dirname!r}")
        for filename in files:
            path = os.path.join(root, filename)
            if os.path.islink(path):
                raise PackError("E_PACK_SYMLINK", f"symlink present in draft: {filename!r}")
            count += 1
            total += os.path.getsize(path)
    return count, total


def create_draft(
    name: str,
    *,
    manifest: Optional[dict[str, Any]] = None,
    source_session_id: Optional[int] = None,
    store: Optional[AgentConfigStore] = None,
) -> SkillDraftRow:
    store = store or get_agent_config_store()
    draft_id = new_draft_id(name)
    content = draft_content_dir(draft_id)
    os.makedirs(content, exist_ok=False)
    draft_manifest = dict(manifest or {})
    draft_manifest.setdefault("manifest_version", 2)
    draft_manifest.setdefault("type", "document")
    draft_manifest.setdefault("name", name)
    draft_manifest.setdefault("version", "0.1.0")
    draft_manifest.setdefault("title", name.replace("_", " ").replace("-", " ").title())
    draft_manifest.setdefault("description", "")
    draft_manifest.setdefault("default_enabled", True)
    draft_manifest.setdefault("prompt_fragment", "")
    draft_manifest.setdefault("docs_path", "SKILL.md")
    draft_manifest.setdefault("tools", [])
    formal_manifest = {k: v for k, v in draft_manifest.items() if k != "script_notes"}
    Path(content, "manifest.json").write_text(
        json.dumps(formal_manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return store.create_skill_draft(
        draft_id,
        name,
        draft_dir(draft_id),
        manifest=draft_manifest,
        source_session_id=source_session_id,
    )


def write_draft_file(
    draft_id: str,
    relpath: str,
    content: str,
    *,
    store: Optional[AgentConfigStore] = None,
) -> dict[str, Any]:
    store = store or get_agent_config_store()
    row = store.get_skill_draft(draft_id)
    if row is None:
        raise PackError("E_NOT_FOUND", f"skill draft not found: {draft_id}", http_status=404)
    _require_mutable(row)
    encoded = content.encode("utf-8")
    if len(encoded) > MAX_DRAFT_FILE_BYTES:
        raise PackError("E_DRAFT_LIMIT", "draft file exceeds 1 MiB", http_status=413)
    content_dir = draft_content_dir(draft_id)
    _assert_no_escape(content_dir)
    target = _reject_member_path(relpath, content_dir)
    manifest = row.manifest
    payload = content
    if os.path.normpath(relpath) == "manifest.json":
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError as exc:
            raise PackError("E_PACK_BAD_MANIFEST", f"cannot parse manifest.json: {exc}") from exc
        if not isinstance(parsed, dict):
            raise PackError("E_PACK_BAD_MANIFEST", "manifest.json must be an object")
        manifest = parsed
        payload = json.dumps(
            {k: v for k, v in parsed.items() if k != "script_notes"},
            ensure_ascii=False,
            indent=2,
        ) + "\n"
        encoded = payload.encode("utf-8")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    existing_size = os.path.getsize(target) if os.path.isfile(target) else 0
    file_count, total_bytes = _tree_stats(content_dir)
    if not os.path.isfile(target) and file_count >= MAX_DRAFT_FILES:
        raise PackError("E_DRAFT_LIMIT", "draft exceeds 200 files", http_status=413)
    if total_bytes - existing_size + len(encoded) > MAX_DRAFT_TOTAL_BYTES:
        raise PackError("E_DRAFT_LIMIT", "draft exceeds 10 MiB", http_status=413)
    with open(target, "wb") as handle:
        handle.write(encoded)
    _assert_no_escape(content_dir)
    store.update_skill_draft(draft_id, status="draft", manifest=manifest, validation=None)
    return {"path": relpath.replace(os.sep, "/"), "bytes": len(encoded)}


def import_file_into_draft(
    draft_id: str,
    relpath: str,
    data: bytes,
    *,
    store: Optional[AgentConfigStore] = None,
) -> dict[str, Any]:
    """Import arbitrary bytes through the same draft containment and quota guards."""
    store = store or get_agent_config_store()
    row = store.get_skill_draft(draft_id)
    if row is None:
        raise PackError("E_NOT_FOUND", f"skill draft not found: {draft_id}", http_status=404)
    _require_mutable(row)
    if not isinstance(data, bytes):
        raise PackError("E_INVALID_ARG", "draft import data must be bytes", http_status=400)
    if len(data) > MAX_DRAFT_FILE_BYTES:
        raise PackError("E_DRAFT_LIMIT", "draft file exceeds 1 MiB", http_status=413)
    if os.path.normpath(relpath) == "manifest.json":
        raise PackError("E_INVALID_ARG", "manifest.json must use write_draft_file", http_status=400)
    content_dir = draft_content_dir(draft_id)
    _assert_no_escape(content_dir)
    target = _reject_member_path(relpath, content_dir)
    existing_size = os.path.getsize(target) if os.path.isfile(target) else 0
    file_count, total_bytes = _tree_stats(content_dir)
    if not os.path.isfile(target) and file_count >= MAX_DRAFT_FILES:
        raise PackError("E_DRAFT_LIMIT", "draft exceeds 200 files", http_status=413)
    if total_bytes - existing_size + len(data) > MAX_DRAFT_TOTAL_BYTES:
        raise PackError("E_DRAFT_LIMIT", "draft exceeds 10 MiB", http_status=413)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "wb") as handle:
        handle.write(data)
    _assert_no_escape(content_dir)
    store.update_skill_draft(draft_id, status="draft", validation=None)
    return {"path": relpath.replace(os.sep, "/"), "bytes": len(data)}


def delete_draft_file(
    draft_id: str, relpath: str, *, store: Optional[AgentConfigStore] = None
) -> bool:
    store = store or get_agent_config_store()
    row = store.get_skill_draft(draft_id)
    if row is None:
        raise PackError("E_NOT_FOUND", f"skill draft not found: {draft_id}", http_status=404)
    _require_mutable(row)
    target = _reject_member_path(relpath, draft_content_dir(draft_id))
    if not os.path.isfile(target):
        return False
    os.remove(target)
    _assert_no_escape(draft_content_dir(draft_id))
    store.update_skill_draft(draft_id, status="draft", validation=None)
    return True


def list_draft_tree(draft_id: str) -> list[dict[str, Any]]:
    content = draft_content_dir(draft_id)
    _assert_no_escape(content)
    out: list[dict[str, Any]] = []
    for root, _, files in os.walk(content):
        for filename in sorted(files):
            path = os.path.join(root, filename)
            rel = os.path.relpath(path, content).replace(os.sep, "/")
            out.append({"path": rel, "bytes": os.path.getsize(path)})
    out.sort(key=lambda item: item["path"])
    return out


def read_draft_file(draft_id: str, relpath: str) -> str:
    target = _reject_member_path(relpath, draft_content_dir(draft_id))
    _assert_no_escape(draft_content_dir(draft_id))
    if not os.path.isfile(target):
        raise PackError("E_NOT_FOUND", f"draft file not found: {relpath}", http_status=404)
    if os.path.getsize(target) > MAX_DRAFT_FILE_BYTES:
        raise PackError("E_DRAFT_LIMIT", "draft file exceeds readable limit", http_status=413)
    try:
        return Path(target).read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise PackError("E_INVALID_ARG", "draft file is not UTF-8 text", http_status=400) from exc


def _test_contract_errors(content_dir: str) -> tuple[list[str], dict[str, Any]]:
    tests_dir = os.path.join(content_dir, "tests")
    texts: list[str] = []
    if os.path.isdir(tests_dir):
        for root, _, files in os.walk(tests_dir):
            for filename in files:
                path = os.path.join(root, filename)
                try:
                    texts.append(Path(path).read_text(encoding="utf-8"))
                except (OSError, UnicodeDecodeError):
                    continue
    merged = "\n".join(texts).lower()
    checks = {
        "positive": "## positive" in merged or "positive:" in merged,
        "negative": "## negative" in merged or "negative:" in merged,
        "expected_output": "## expected output" in merged or "expected output:" in merged,
    }
    errors = [f"tests are missing {name.replace('_', ' ')} case" for name, ok in checks.items() if not ok]
    return errors, checks


def validate_draft(
    draft_id: str, *, store: Optional[AgentConfigStore] = None
) -> dict[str, Any]:
    store = store or get_agent_config_store()
    row = store.get_skill_draft(draft_id)
    if row is None:
        raise PackError("E_NOT_FOUND", f"skill draft not found: {draft_id}", http_status=404)
    _require_mutable(row)
    content = draft_content_dir(draft_id)
    errors: list[str] = []
    try:
        _assert_no_escape(content)
    except PackError as exc:
        errors.append(exc.message)
    skill_md_path = os.path.join(content, "SKILL.md")
    if not os.path.isfile(skill_md_path) or not Path(skill_md_path).read_text(
        encoding="utf-8", errors="replace"
    ).strip():
        errors.append("SKILL.md is required and must be non-empty")
    formal_manifest: Optional[SkillPackageManifest] = None
    try:
        raw = json.loads(read_draft_file(draft_id, "manifest.json"))
        formal_manifest = SkillPackageManifest.model_validate(raw)
    except (PackError, OSError, ValueError, ValidationError) as exc:
        errors.append(f"manifest validation failed: {exc}")
    if formal_manifest is not None:
        from src.skills.registry import code_builtin_skills

        if formal_manifest.name in {skill.name for skill in code_builtin_skills()}:
            errors.append(f"draft name conflicts with builtin skill: {formal_manifest.name}")
        if formal_manifest.name != row.name:
            errors.append("manifest.name must equal the draft name")
    script_paths = [item["path"] for item in list_draft_tree(draft_id) if item["path"].startswith("scripts/")]
    notes = (row.manifest or {}).get("script_notes") if row.manifest else None
    notes = notes if isinstance(notes, dict) else {}
    for script_path in script_paths:
        note = notes.get(script_path)
        if not isinstance(note, dict):
            errors.append(f"script {script_path} is missing script_notes")
            continue
        for field in SCRIPT_NOTE_FIELDS:
            if field not in note or note[field] in (None, "", []):
                errors.append(f"script {script_path} is missing script_notes.{field}")
    test_errors, test_summary = _test_contract_errors(content)
    errors.extend(test_errors)
    files: dict[str, str] = {}
    package_hash: Optional[str] = None
    try:
        files, package_hash = compute_files_and_hash(content)
    except (OSError, PackError) as exc:
        errors.append(f"content hashing failed: {exc}")
    result = {
        "valid": not errors,
        "errors": errors,
        "files": files,
        "package_hash": package_hash,
        "file_count": len(files),
        "scripts": {path: notes.get(path) for path in script_paths},
        "tests": test_summary,
    }
    store.update_skill_draft(
        draft_id, status="valid" if not errors else "invalid", validation=result
    )
    return result


def _promote_draft_content(draft_id: str, name: str) -> tuple[str, str, bool]:
    content = draft_content_dir(draft_id)
    if not os.path.isdir(content):
        raise PackError("E_NOT_FOUND", f"draft content missing: {draft_id}", http_status=404)
    root = skills_data_root()
    os.makedirs(root, exist_ok=True)
    target = skill_dir(name)
    stamp = int(time.time() * 1000)
    staging = os.path.join(root, f".incoming-{name}-{stamp}")
    trash = os.path.join(root, f".trash-{name}-{stamp}")
    os.rename(content, staging)
    moved_old = False
    try:
        if os.path.exists(target):
            os.rename(target, trash)
            moved_old = True
        os.rename(staging, target)
    except BaseException:
        if os.path.exists(staging):
            os.rename(staging, content)
        if moved_old and not os.path.exists(target) and os.path.exists(trash):
            os.rename(trash, target)
        raise
    return target, trash, moved_old


def _rollback_draft_promotion(
    draft_id: str, target: str, trash: str, moved_old: bool
) -> None:
    content = draft_content_dir(draft_id)
    if os.path.exists(target):
        os.rename(target, content)
    if moved_old and os.path.exists(trash):
        os.rename(trash, target)


def publish_draft(
    draft_id: str,
    enabled: bool = True,
    *,
    store: Optional[AgentConfigStore] = None,
) -> dict[str, Any]:
    store = store or get_agent_config_store()
    row = store.get_skill_draft(draft_id)
    if row is None:
        raise PackError("E_NOT_FOUND", f"skill draft not found: {draft_id}", http_status=404)
    if row.status != "valid":
        raise PackError("E_DRAFT_INVALID", "skill draft must be valid before publish", http_status=409)
    validation = validate_draft(draft_id, store=store)
    if not validation["valid"]:
        raise PackError("E_DRAFT_INVALID", "skill draft failed publish-time validation", http_status=409)
    verified = verify_content_dir(draft_content_dir(draft_id))
    if verified.package_hash != validation["package_hash"] or verified.files != validation["files"]:
        raise PackError("E_PACK_HASH_MISMATCH", "draft changed during publish", http_status=409)
    target, trash, moved_old = _promote_draft_content(draft_id, verified.manifest.name)
    try:
        store.install_skill(
            verified.manifest.name,
            source_type="user_created",
            manifest=verified.manifest_dict,
            manifest_version=str(verified.manifest.manifest_version),
            version=verified.manifest.version,
            source_uri=f"draft:{draft_id}",
            package_hash=verified.package_hash,
            trusted=False,
            enabled=enabled,
            files_json=json.dumps(verified.files, ensure_ascii=False, sort_keys=True),
            session_id=row.source_session_id,
        )
    except BaseException:
        _rollback_draft_promotion(draft_id, target, trash, moved_old)
        raise
    shutil.rmtree(trash, ignore_errors=True)
    store.mark_skill_draft_published(draft_id)
    store.record_event(
        verified.manifest.name,
        "draft_publish",
        detail={
            "draft_id": draft_id,
            "package_hash": verified.package_hash,
            "file_count": len(verified.files),
            "files": sorted(verified.files),
            "enabled": enabled,
        },
        session_id=row.source_session_id,
    )
    return {
        "draft_id": draft_id,
        "name": verified.manifest.name,
        "package_hash": verified.package_hash,
        "files": verified.files,
        "enabled": enabled,
        "install_dir": target,
    }


def discard_draft(
    draft_id: str, *, store: Optional[AgentConfigStore] = None
) -> SkillDraftRow:
    store = store or get_agent_config_store()
    row = store.get_skill_draft(draft_id)
    if row is None:
        raise PackError("E_NOT_FOUND", f"skill draft not found: {draft_id}", http_status=404)
    if row.status == "published":
        raise PackError("E_DRAFT_TERMINAL", "published drafts cannot be discarded", http_status=409)
    if row.status != "discarded":
        shutil.rmtree(draft_dir(draft_id), ignore_errors=True)
        row = store.mark_skill_draft_discarded(draft_id)
    return row
