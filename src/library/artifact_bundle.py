"""Generic versioned artifact loopback preview tokens and multi-file cloud publish."""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import secrets
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from src.library.constants import AGENT_DOCS_SLUG
from src.library.service import LibraryError, LibraryService

_ARTIFACTS_PREFIX = f"{AGENT_DOCS_SLUG}/artifacts"
_SLUG_MAX_LEN = 64
_PREVIEW_TOKEN_TTL_SEC = 86400.0
_PREVIEW_MAX_TOKENS = 256
_MAX_BUNDLE_FILES = 100
_MAX_BUNDLE_TOTAL_BYTES = 20 * 1024 * 1024  # Matches artifact-server MAX_TOTAL_BYTES (20 MiB)

_TEXT_BUNDLE_EXTS = frozenset({
    ".html",
    ".htm",
    ".css",
    ".js",
    ".mjs",
    ".json",
    ".svg",
    ".txt",
    ".md",
})

_MIME_BY_EXT: dict[str, str] = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
}


@dataclass(frozen=True)
class _PreviewEntry:
    token: str
    slug: str
    version: int
    abs_dir: Path
    entry_path: str
    expires_at: float


_PREVIEW_LOCK = threading.Lock()
_PREVIEW_TOKENS: dict[str, _PreviewEntry] = {}


def normalize_artifact_slug(raw: str) -> str:
    """Normalize an arbitrary string into an ASCII kebab-case artifact slug."""
    cleaned = raw.strip().lower()
    cleaned = re.sub(r"[\s_]+", "-", cleaned)
    cleaned = re.sub(r"[^a-z0-9-]+", "", cleaned)
    cleaned = re.sub(r"-+", "-", cleaned).strip("-")
    return cleaned[:_SLUG_MAX_LEN]


def guess_media_type(rel_path: str) -> str:
    """Resolve an accurate MIME Content-Type for static/ESM web assets."""
    ext = Path(rel_path).suffix.lower()
    if ext in _MIME_BY_EXT:
        return _MIME_BY_EXT[ext]
    guessed, _ = mimetypes.guess_type(rel_path)
    return guessed or "application/octet-stream"


def _sanitize_rel_path(raw: str) -> str:
    cleaned = (raw or "").strip().lstrip("/")
    if cleaned.startswith("./"):
        cleaned = cleaned[2:]
    if not cleaned or len(cleaned) > 240 or "\\" in cleaned:
        raise LibraryError("E_INVALID_ARG", f"invalid asset relative path: {raw!r}")
    if any(ord(ch) < 0x20 or ch == "\x7f" for ch in cleaned):
        raise LibraryError("E_INVALID_ARG", f"unsafe asset path: {raw!r}")
    segments = cleaned.split("/")
    for seg in segments:
        if not seg or seg in (".", ".."):
            raise LibraryError("E_INVALID_ARG", f"invalid path segment in {raw!r}")
    return "/".join(segments)


def _list_existing_versions(service: LibraryService, clean_slug: str) -> list[int]:
    parent_virtual = f"{_ARTIFACTS_PREFIX}/{clean_slug}"
    try:
        listing = service.folder(parent_virtual, limit=200, offset=0)
    except LibraryError as exc:
        if exc.code == "E_NOT_FOUND":
            return []
        raise
    versions: list[int] = []
    for folder in listing.get("folders") or []:
        name = str(folder.get("name") or "")
        match = re.fullmatch(r"v(\d+)", name)
        if match:
            versions.append(int(match.group(1)))
    return sorted(versions)


def _resolve_artifact_version_dir(
    service: LibraryService,
    slug: str,
    version: Optional[int] = None,
) -> tuple[str, int, Path]:
    clean_slug = normalize_artifact_slug(slug)
    if not clean_slug:
        raise LibraryError("E_INVALID_ARG", "slug must contain ASCII letters or digits")

    if version is not None:
        target_ver = int(version)
        if target_ver < 1:
            raise LibraryError("E_INVALID_ARG", "version must be >= 1")
    else:
        existing = _list_existing_versions(service, clean_slug)
        if not existing:
            raise LibraryError("E_NOT_FOUND", f"artifact not found: {clean_slug}")
        target_ver = existing[-1]

    virtual_dir = f"{_ARTIFACTS_PREFIX}/{clean_slug}/v{target_ver}"
    with service.db.transaction() as conn:
        resolved = service._resolve_virtual(conn, virtual_dir)
    abs_dir = Path(resolved.abs_path)
    if not abs_dir.is_dir():
        raise LibraryError("E_NOT_FOUND", f"artifact version directory not found: {virtual_dir}")
    return clean_slug, target_ver, abs_dir.resolve()


def _prune_preview_tokens(now_mono: float) -> None:
    expired = [tok for tok, item in _PREVIEW_TOKENS.items() if item.expires_at <= now_mono]
    for tok in expired:
        _PREVIEW_TOKENS.pop(tok, None)
    if len(_PREVIEW_TOKENS) >= _PREVIEW_MAX_TOKENS:
        oldest = sorted(_PREVIEW_TOKENS.values(), key=lambda e: e.expires_at)
        for item in oldest[: len(_PREVIEW_TOKENS) - _PREVIEW_MAX_TOKENS + 1]:
            _PREVIEW_TOKENS.pop(item.token, None)


def issue_preview_token(
    service: LibraryService,
    slug: str,
    *,
    version: Optional[int] = None,
    entry_path: str = "index.html",
    base_url: Optional[str] = None,
) -> dict[str, Any]:
    """Issue a short-lived loopback capability URL for headless/browser_use inspection."""
    clean_slug, target_ver, abs_dir = _resolve_artifact_version_dir(service, slug, version)
    clean_entry = _sanitize_rel_path(entry_path or "index.html")
    entry_file = (abs_dir / clean_entry).resolve()
    if not entry_file.is_relative_to(abs_dir) or not entry_file.is_file():
        raise LibraryError("E_NOT_FOUND", f"artifact entry file not found: {clean_entry}")

    token = secrets.token_urlsafe(24)
    now_mono = time.monotonic()
    expires_mono = now_mono + _PREVIEW_TOKEN_TTL_SEC
    entry = _PreviewEntry(
        token=token,
        slug=clean_slug,
        version=target_ver,
        abs_dir=abs_dir,
        entry_path=clean_entry,
        expires_at=expires_mono,
    )
    with _PREVIEW_LOCK:
        _prune_preview_tokens(now_mono)
        _PREVIEW_TOKENS[token] = entry

    rel_url = f"/api/library/artifacts/preview/{token}/{clean_entry}"
    preview_url = f"{base_url.rstrip('/')}{rel_url}" if base_url else rel_url
    return {
        "ok": True,
        "token": token,
        "slug": clean_slug,
        "version": target_ver,
        "entry_path": clean_entry,
        "preview_url": preview_url,
        "ttl_seconds": int(_PREVIEW_TOKEN_TTL_SEC),
    }


def resolve_preview_file(token: str, rel_path: str = "") -> Path:
    """Resolve a regular file inside a capability-tokenized artifact preview directory."""
    clean_token = (token or "").strip()
    if not clean_token:
        raise LibraryError("E_NOT_FOUND", "missing preview token")

    now_mono = time.monotonic()
    with _PREVIEW_LOCK:
        _prune_preview_tokens(now_mono)
        entry = _PREVIEW_TOKENS.get(clean_token)
    if entry is None or entry.expires_at <= now_mono:
        raise LibraryError("E_NOT_FOUND", "preview session expired or not found")

    clean_rel = _sanitize_rel_path(rel_path or entry.entry_path)
    candidate = entry.abs_dir.joinpath(*clean_rel.split("/"))
    if candidate.is_symlink():
        raise LibraryError("E_AUTH_FAILED", "symlink traversal is not allowed")
    resolved = candidate.resolve()
    if not resolved.is_relative_to(entry.abs_dir) or not resolved.is_file():
        raise LibraryError("E_NOT_FOUND", f"preview asset not found: {clean_rel}")
    return resolved


async def publish_artifact_bundle(
    service: LibraryService,
    slug: str,
    *,
    version: Optional[int] = None,
    title: Optional[str] = None,
    artifact_type: str = "app",
    project: Optional[str] = None,
    visibility: Optional[str] = None,
    change_note: Optional[str] = None,
    entry_path: str = "index.html",
) -> dict[str, Any]:
    """Read an entire versioned artifact directory and publish it via the `artifact_server` MCP connector."""
    from src.connectors.service import invoke_connector_tool

    clean_slug, target_ver, abs_dir = _resolve_artifact_version_dir(service, slug, version)
    clean_entry = _sanitize_rel_path(entry_path or "index.html")
    if not (abs_dir / clean_entry).is_file():
        raise LibraryError("E_NOT_FOUND", f"entry file missing from bundle: {clean_entry}")

    files_payload: list[dict[str, str]] = []
    total_bytes = 0

    for root_str, _dirs, filenames in os.walk(abs_dir):
        root_path = Path(root_str)
        for name in sorted(filenames):
            full_path = root_path / name
            if full_path.is_symlink():
                raise LibraryError("E_AUTH_FAILED", "symlink files cannot be published")
            resolved = full_path.resolve()
            if not resolved.is_relative_to(abs_dir) or not resolved.is_file():
                continue
            rel = resolved.relative_to(abs_dir).as_posix()
            data = resolved.read_bytes()
            total_bytes += len(data)
            if len(files_payload) >= _MAX_BUNDLE_FILES:
                raise LibraryError(
                    "E_INVALID_ARG",
                    f"bundle exceeds max {_MAX_BUNDLE_FILES} files",
                )
            if total_bytes > _MAX_BUNDLE_TOTAL_BYTES:
                raise LibraryError(
                    "E_INVALID_ARG",
                    f"bundle exceeds max {_MAX_BUNDLE_TOTAL_BYTES // (1024 * 1024)} MiB total limit",
                )

            ext = resolved.suffix.lower()
            content_type = guess_media_type(rel)
            if ext in _TEXT_BUNDLE_EXTS:
                files_payload.append({
                    "path": rel,
                    "content": data.decode("utf-8"),
                    "content_type": content_type,
                    "encoding": "utf8",
                })
            else:
                files_payload.append({
                    "path": rel,
                    "content": base64.b64encode(data).decode("ascii"),
                    "content_type": content_type,
                    "encoding": "base64",
                })

    if not files_payload:
        raise LibraryError("E_NOT_FOUND", f"no files found inside {clean_slug}/v{target_ver}")

    args: dict[str, Any] = {
        "slug": clean_slug,
        "title": (title or clean_slug).strip()[:160] or clean_slug,
        "artifact_type": artifact_type or "app",
        "entry_path": clean_entry,
        "files": files_payload,
    }
    if project:
        args["project"] = project
    if visibility:
        args["visibility"] = visibility
    if change_note:
        args["change_note"] = change_note

    res = await invoke_connector_tool(
        "artifact_server",
        "artifact_publish",
        args,
        deny_ask_mode=False,
    )
    if res.get("is_error"):
        raise LibraryError("E_REMOTE_ERROR", str(res.get("content") or "artifact_publish failed"))

    raw_content = str(res.get("content") or "{}")
    try:
        parsed = json.loads(raw_content)
    except json.JSONDecodeError as exc:
        raise LibraryError("E_REMOTE_ERROR", f"Invalid JSON response from artifact_server: {raw_content[:200]}") from exc

    if not isinstance(parsed, dict) or parsed.get("ok") is False:
        raise LibraryError("E_REMOTE_ERROR", str(parsed.get("message") if isinstance(parsed, dict) else raw_content))

    links = parsed.get("links") if isinstance(parsed.get("links"), dict) else {}
    return {
        "ok": True,
        "slug": parsed.get("slug", clean_slug),
        "title": parsed.get("title", args["title"]),
        "version": parsed.get("version"),
        "local_version": target_ver,
        "file_count": parsed.get("file_count", len(files_payload)),
        "size_bytes": parsed.get("size_bytes", total_bytes),
        "review_url": parsed.get("review_url") or links.get("review_url"),
        "share_url": parsed.get("share_url") or links.get("share_url"),
        "raw_url": parsed.get("raw_url") or links.get("raw_url"),
    }
