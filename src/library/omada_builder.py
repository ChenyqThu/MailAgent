"""Omada UI Kit real-component prototype builder, loopback preview tokens, and multi-file cloud publish."""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Optional

from src.config import config
from src.library.constants import AGENT_DOCS_SLUG
from src.library.service import Actor, LibraryError, LibraryService

OMADA_NPM_PACKAGE = "@chenyqthu/omada-ui-kit"
OMADA_CDN_CSS_URL = "https://cdn.jsdelivr.net/npm/@chenyqthu/omada-ui-kit@latest/dist/style.css"
OMADA_CDN_STANDALONE_URL = "https://cdn.jsdelivr.net/npm/@chenyqthu/omada-ui-kit@latest/dist/standalone.js"
OMADA_CDN_CATALOG_URL = "https://cdn.jsdelivr.net/npm/@chenyqthu/omada-ui-kit@latest/dist/catalog.json"
OMADA_CDN_BABEL_URL = "https://cdn.jsdelivr.net/npm/@babel/standalone@7/babel.min.js"

_CATALOG_CDN_TTL_SEC = 600.0
_CATALOG_QUERY_ACTIONS = frozenset({
    "info",
    "list_components",
    "component",
    "search_icons",
    "search_assets",
    "tokens",
    "recipes",
})
_ASSET_GROUPS = frozenset({"products", "illustrations", "clients", "brand"})

_ARTIFACTS_PREFIX = f"{AGENT_DOCS_SLUG}/artifacts"
_SLUG_MAX_LEN = 64
_BUILD_HARNESS_DIRNAME = ".mailagent-build"
_DEFAULT_BUILD_TIMEOUT_SEC = 90
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

_CATALOG_LOCK = threading.Lock()
_LOCAL_CATALOG_CACHE: Optional[tuple[str, int, dict[str, Any]]] = None
_CDN_CATALOG_CACHE: Optional[tuple[float, dict[str, Any]]] = None


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


def resolve_omada_kit_root(explicit_root: Optional[str | Path] = None) -> Path:
    """Locate and validate the local omada-ui-kit workspace."""
    raw = str(explicit_root).strip() if explicit_root else (config.omada_kit_root or "").strip()
    root = Path(raw).expanduser() if raw else (Path.home() / "Documents" / "omada-ui-kit")
    try:
        resolved = root.resolve()
    except OSError as exc:
        raise LibraryError("E_NOT_FOUND", f"cannot resolve omada-ui-kit path {root}: {exc}") from exc

    if not (resolved / "package.json").is_file() or not (resolved / "src" / "omada" / "index.ts").is_file():
        raise LibraryError(
            "E_NOT_FOUND",
            f"omada-ui-kit workspace not found at {resolved}",
            hint="Ensure ~/Documents/omada-ui-kit exists or set MAILAGENT_OMADA_KIT_ROOT",
        )
    return resolved


def _extract_exported_symbols(index_ts_text: str) -> list[str]:
    symbols: list[str] = []
    seen: set[str] = set()
    for block in re.finditer(r"export\s+(?:type\s+)?\{([^}]+)\}", index_ts_text):
        for raw_item in block.group(1).split(","):
            item = raw_item.strip()
            if not item or item.startswith("type "):
                continue
            if " as " in item:
                item = item.split(" as ", 1)[1].strip()
            if item and item not in seen:
                seen.add(item)
                symbols.append(item)
    return symbols


def read_omada_catalog(kit_root: Optional[str | Path] = None) -> dict[str, Any]:
    """Read Omada UI Kit exported components, hooks, CSS tokens, and package versions."""
    root = resolve_omada_kit_root(kit_root)
    pkg = json.loads((root / "package.json").read_text(encoding="utf-8"))
    deps = pkg.get("dependencies") if isinstance(pkg.get("dependencies"), dict) else {}
    dev_deps = pkg.get("devDependencies") if isinstance(pkg.get("devDependencies"), dict) else {}

    index_text = (root / "src" / "omada" / "index.ts").read_text(encoding="utf-8")
    exported = _extract_exported_symbols(index_text)

    components_md = ""
    md_path = root / "COMPONENTS.md"
    if md_path.is_file():
        components_md = md_path.read_text(encoding="utf-8")
        if len(components_md) > 32000:
            components_md = components_md[:32000] + "\n\n...(truncated)..."

    styles_dir = root / "src" / "styles" / "modules"
    css_modules = sorted(p.name for p in styles_dir.glob("*.css")) if styles_dir.is_dir() else []

    return {
        "ok": True,
        "name": pkg.get("name", "omada-ui-kit"),
        "packages": {
            "react": deps.get("react"),
            "antd": deps.get("antd"),
            "echarts": deps.get("echarts"),
            "lucide-react": deps.get("lucide-react"),
            "@ant-design/icons": deps.get("@ant-design/icons"),
            "vite": dev_deps.get("vite"),
        },
        "exported_symbols": exported,
        "symbol_count": len(exported),
        "css_modules": css_modules,
        "components_doc": components_md,
    }


def clear_omada_catalog_cache() -> None:
    """Clear cached local and CDN Omada UI Kit catalog data."""
    global _LOCAL_CATALOG_CACHE, _CDN_CATALOG_CACHE
    with _CATALOG_LOCK:
        _LOCAL_CATALOG_CACHE = None
        _CDN_CATALOG_CACHE = None


def _resolve_catalog_root(explicit_root: Optional[str | Path] = None) -> Path:
    raw = str(explicit_root).strip() if explicit_root else (config.omada_kit_root or "").strip()
    return Path(raw).expanduser() if raw else (Path.home() / "Documents" / "omada-ui-kit")


def _validate_catalog_payload(payload: Any, origin: str) -> dict[str, Any]:
    if (
        not isinstance(payload, dict)
        or not isinstance(payload.get("components"), list)
        or not isinstance(payload.get("assets"), dict)
    ):
        raise LibraryError("E_REMOTE_ERROR", f"invalid omada catalog payload from {origin}")
    return payload


def _load_omada_catalog_json(kit_root: Optional[str | Path] = None) -> tuple[dict[str, Any], str]:
    """Load catalog.json from local omada-ui-kit first, falling back to jsDelivr CDN with TTL cache."""
    global _LOCAL_CATALOG_CACHE, _CDN_CATALOG_CACHE
    root = _resolve_catalog_root(kit_root)
    for rel in ("dist/catalog.json", "skills/omada-ui-kit/references/catalog.json"):
        candidate = root / rel
        try:
            if not candidate.is_file():
                continue
            resolved = str(candidate.resolve())
            mtime_ns = candidate.stat().st_mtime_ns
        except OSError:
            continue

        with _CATALOG_LOCK:
            if (
                _LOCAL_CATALOG_CACHE is not None
                and _LOCAL_CATALOG_CACHE[0] == resolved
                and _LOCAL_CATALOG_CACHE[1] == mtime_ns
            ):
                return _LOCAL_CATALOG_CACHE[2], "local"

        try:
            data = _validate_catalog_payload(
                json.loads(candidate.read_text(encoding="utf-8")),
                resolved,
            )
        except (OSError, json.JSONDecodeError, LibraryError):
            continue

        with _CATALOG_LOCK:
            _LOCAL_CATALOG_CACHE = (resolved, mtime_ns, data)
        return data, "local"

    now_mono = time.monotonic()
    with _CATALOG_LOCK:
        if _CDN_CATALOG_CACHE is not None and (now_mono - _CDN_CATALOG_CACHE[0]) < _CATALOG_CDN_TTL_SEC:
            return _CDN_CATALOG_CACHE[1], "cdn"

    req = urllib.request.Request(
        OMADA_CDN_CATALOG_URL,
        headers={"User-Agent": "MailAgent/1.0", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw_text = resp.read().decode("utf-8")
        data = _validate_catalog_payload(json.loads(raw_text), OMADA_CDN_CATALOG_URL)
    except (OSError, urllib.error.URLError, ValueError, LibraryError) as exc:
        raise LibraryError(
            "E_NOT_FOUND",
            f"failed to load omada-ui-kit catalog from local workspace or CDN: {exc}",
            hint="Ensure ~/Documents/omada-ui-kit/dist/catalog.json exists or network access to jsDelivr is available",
        ) from exc

    with _CATALOG_LOCK:
        _CDN_CATALOG_CACHE = (time.monotonic(), data)
    return data, "cdn"


def query_omada_catalog(
    action: str = "info",
    *,
    query: Optional[str] = None,
    asset_group: Optional[str] = None,
    theme: str = "light",
    limit: int = 25,
    kit_root: Optional[str | Path] = None,
) -> dict[str, Any]:
    """Query @chenyqthu/omada-ui-kit components, props, Figma assets, tokens, and recipes."""
    clean_action = (action or "").strip().lower()
    if clean_action not in _CATALOG_QUERY_ACTIONS:
        raise LibraryError(
            "E_INVALID_ARG",
            f"invalid omada catalog action: {action!r}",
            hint=f"action must be one of: {', '.join(sorted(_CATALOG_QUERY_ACTIONS))}",
        )

    try:
        clamped_limit = max(1, min(100, int(limit if limit is not None else 25)))
    except (TypeError, ValueError) as exc:
        raise LibraryError("E_INVALID_ARG", f"invalid limit: {limit!r}") from exc

    q_clean = (query or "").strip()
    q_lower = q_clean.lower()

    catalog, source = _load_omada_catalog_json(kit_root)
    components = [c for c in (catalog.get("components") or []) if isinstance(c, dict)]
    assets = catalog.get("assets") if isinstance(catalog.get("assets"), dict) else {}

    if clean_action == "info":
        pkg_raw = catalog.get("package") if isinstance(catalog.get("package"), dict) else {}
        cdn_raw = pkg_raw.get("cdn") if isinstance(pkg_raw.get("cdn"), dict) else {}
        cdn = {
            "jsdelivrCss": OMADA_CDN_CSS_URL,
            "jsdelivrStandalone": OMADA_CDN_STANDALONE_URL,
            "catalogUrl": OMADA_CDN_CATALOG_URL,
            **cdn_raw,
            "babelUrl": OMADA_CDN_BABEL_URL,
        }
        pkg = {
            "name": OMADA_NPM_PACKAGE,
            **pkg_raw,
            "cdn": cdn,
        }
        categories = sorted({str(c.get("category") or "") for c in components if c.get("category")})
        return {
            "ok": True,
            "source": source,
            "package": pkg,
            "counts": catalog.get("counts") or {},
            "categories": categories,
            "icon_categories": list(assets.get("iconCategories") or []),
        }

    if clean_action == "list_components":
        if not q_lower:
            matched = [c for c in components if c.get("kind") not in ("antd-primitive", "data")]
        else:
            matched = [c for c in components if str(c.get("category") or "").lower() == q_lower]
            if not matched:
                matched = [
                    c
                    for c in components
                    if q_lower in str(c.get("name") or "").lower()
                    or q_lower in str(c.get("category") or "").lower()
                    or q_lower in str(c.get("description") or "").lower()
                ]
        categories = sorted({str(c.get("category") or "") for c in matched if c.get("category")})
        items = [
            {
                "name": c.get("name"),
                "category": c.get("category"),
                "kind": c.get("kind"),
                "prop_count": len(c.get("props") or []),
                "description": str(c.get("description") or "")[:200],
            }
            for c in matched
        ]
        return {
            "ok": True,
            "source": source,
            "query": q_clean,
            "total": len(items),
            "categories": categories,
            "items": items,
        }

    if clean_action == "component":
        if not q_lower:
            raise LibraryError("E_INVALID_ARG", "query (component name) is required for action='component'")
        exact = [c for c in components if str(c.get("name") or "").lower() == q_lower]
        matched = exact[:1] if exact else [c for c in components if q_lower in str(c.get("name") or "").lower()][:8]
        return {
            "ok": True,
            "source": source,
            "query": q_clean,
            "matches": [
                {
                    "name": c.get("name"),
                    "category": c.get("category"),
                    "kind": c.get("kind"),
                    "description": c.get("description") or "",
                    "sourcePath": c.get("sourcePath"),
                    "extends": c.get("extends"),
                    "propsType": c.get("propsType"),
                    "props": list(c.get("props") or []),
                }
                for c in matched
            ],
        }

    if clean_action == "search_icons":
        icons = [item for item in (assets.get("icons") or []) if isinstance(item, dict)]
        matched = [
            icon
            for icon in icons
            if not q_lower
            or q_lower in str(icon.get("name") or "").lower()
            or q_lower in str(icon.get("category") or "").lower()
            or q_lower in str(icon.get("figmaName") or "").lower()
        ]
        sliced = matched[:clamped_limit]
        return {
            "ok": True,
            "source": source,
            "query": q_clean,
            "total_matches": len(matched),
            "showing": len(sliced),
            "items": sliced,
            "categories": list(assets.get("iconCategories") or []),
        }

    if clean_action == "search_assets":
        group = (asset_group or "products").strip().lower()
        if group not in _ASSET_GROUPS:
            raise LibraryError(
                "E_INVALID_ARG",
                f"invalid asset_group: {group!r}",
                hint="asset_group must be one of: products, illustrations, clients, brand",
            )
        entries = [item for item in (assets.get(group) or []) if isinstance(item, dict)]
        matched = [
            entry
            for entry in entries
            if not q_lower
            or q_lower in str(entry.get("name") or "").lower()
            or q_lower in str(entry.get("category") or "").lower()
        ]
        sliced = matched[:clamped_limit]
        return {
            "ok": True,
            "source": source,
            "group": group,
            "query": q_clean,
            "total_matches": len(matched),
            "showing": len(sliced),
            "items": sliced,
        }

    if clean_action == "tokens":
        mode = "dark" if (theme or "").strip().lower() == "dark" else "light"
        tokens = catalog.get("tokens") if isinstance(catalog.get("tokens"), dict) else {}
        semantic_all = tokens.get("semantic") if isinstance(tokens.get("semantic"), dict) else {}
        port_all = tokens.get("portColors") if isinstance(tokens.get("portColors"), dict) else {}
        palette_all = tokens.get("chartPalette")
        chart_palette = palette_all.get(mode) if isinstance(palette_all, dict) else palette_all
        return {
            "ok": True,
            "source": source,
            "theme": mode,
            "semantic": semantic_all.get(mode),
            "layout": tokens.get("layout"),
            "radius": tokens.get("radius"),
            "portColors": port_all.get(mode),
            "chartPalette": chart_palette,
        }

    # clean_action == "recipes"
    recipes = [r for r in (catalog.get("recipes") or []) if isinstance(r, dict)]
    matched_recipes = [
        r
        for r in recipes
        if not q_lower
        or q_lower in str(r.get("id") or "").lower()
        or q_lower in str(r.get("title") or "").lower()
        or q_lower in str(r.get("summary") or "").lower()
    ]
    return {
        "ok": True,
        "source": source,
        "query": q_clean,
        "recipes": matched_recipes,
    }


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


def _render_entry_css(clean_slug: str) -> str:
    return f"""@import "../../src/styles/tokens.css";
@source "../../src/omada";
@source "../../src/demos/{clean_slug}";
"""


def _render_entry_tsx(clean_slug: str, theme_mode: Literal["light", "dark"], css_modules: list[str]) -> str:
    module_imports = "\n".join(f"import '../../src/styles/modules/{name}';" for name in css_modules)
    safe_theme = "dark" if theme_mode == "dark" else "light"
    return f"""import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/manrope/latin-400.css';
import '@fontsource/manrope/latin-500.css';
import '@fontsource/manrope/latin-600.css';
import '@fontsource/manrope/latin-700.css';
import './entry.css';
import '../../src/styles/omada-antd-overrides.css';
{module_imports}
import {{ OmadaProvider }} from '@/omada';
import * as DemoMod from '../../src/demos/{clean_slug}/Demo';

const ResolvedDemo = (
  (DemoMod as {{ default?: React.ComponentType; Demo?: React.ComponentType }}).default ??
  (DemoMod as {{ Demo?: React.ComponentType }}).Demo ??
  Object.values(DemoMod).find((val) => typeof val === 'function')
) as React.ComponentType | undefined;

if (!ResolvedDemo) {{
  throw new Error('Demo.tsx must export a default React component (or named export Demo).');
}}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <OmadaProvider defaultThemeMode="{safe_theme}">
      <ResolvedDemo />
    </OmadaProvider>
  </React.StrictMode>,
);
"""


def _render_index_html(title: str) -> str:
    safe_title = (
        title.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )
    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{safe_title}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./entry.tsx"></script>
  </body>
</html>
"""


def _render_vite_config_mjs() -> str:
    return """import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const kitRoot = path.resolve(__dirname, '../..');
const omadaDirPrefix = path.resolve(kitRoot, 'src/omada') + path.sep;

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
}

function inlineSingleFilePlugin() {
  return {
    name: 'mailagent-inline-singlefile',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const htmlEntry = bundle['index.html'];
      if (!htmlEntry || htmlEntry.type !== 'asset' || typeof htmlEntry.source !== 'string') {
        return;
      }
      let html = htmlEntry.source;
      const toDelete = [];

      for (const [fileName, asset] of Object.entries(bundle)) {
        if (asset.type !== 'asset' || !fileName.endsWith('.css')) continue;
        const cssText = typeof asset.source === 'string'
          ? asset.source
          : Buffer.from(asset.source).toString('utf8');
        const escaped = escapeRegExp(fileName);
        const linkRe = new RegExp(
          `<link[^>]+rel=["']stylesheet["'][^>]*href=["'](?:\\.\\/)?${escaped}["'][^>]*>|<link[^>]+href=["'](?:\\.\\/)?${escaped}["'][^>]*rel=["']stylesheet["'][^>]*>`,
          'gi'
        );
        if (linkRe.test(html)) {
          html = html.replace(linkRe, () => `<style>${cssText}</style>`);
          toDelete.push(fileName);
        }
      }

      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type !== 'chunk' || !fileName.endsWith('.js')) continue;
        const escaped = escapeRegExp(fileName);
        const preloadRe = new RegExp(
          `<link[^>]+rel=["']modulepreload["'][^>]*href=["'](?:\\.\\/)?${escaped}["'][^>]*>\\s*`,
          'gi'
        );
        html = html.replace(preloadRe, '');
        const scriptRe = new RegExp(
          `<script[^>]+src=["'](?:\\.\\/)?${escaped}["'][^>]*>\\s*<\\/script>`,
          'gi'
        );
        if (scriptRe.test(html)) {
          const safeCode = chunk.code.replace(/<\\/(script)/gi, '<\\\\/$1');
          html = html.replace(scriptRe, () => `<script type="module">${safeCode}<\\/script>`);
          toDelete.push(fileName);
        }
      }

      htmlEntry.source = html;
      for (const key of toDelete) {
        delete bundle[key];
      }
    },
  };
}

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react(), tailwindcss(), inlineSingleFilePlugin()],
  resolve: {
    alias: {
      '@': path.resolve(kitRoot, 'src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100 * 1024,
    chunkSizeWarningLimit: 6000,
    rolldownOptions: {
      treeshake: {
        moduleSideEffects(id) {
          const cleanId = id.split('?')[0];
          if (
            cleanId.startsWith(omadaDirPrefix) &&
            (cleanId.endsWith('.ts') || cleanId.endsWith('.tsx'))
          ) {
            return false;
          }
          return true;
        },
      },
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
"""


def build_omada_demo(
    service: LibraryService,
    slug: str,
    code: str,
    *,
    title: Optional[str] = None,
    change_note: Optional[str] = None,
    theme_mode: Literal["light", "dark"] = "light",
    actor: Optional[Actor] = None,
    kit_root: Optional[str | Path] = None,
    base_url: Optional[str] = None,
    build_timeout_sec: int = _DEFAULT_BUILD_TIMEOUT_SEC,
) -> dict[str, Any]:
    """Write ``src/demos/<slug>/Demo.tsx`` in omada-ui-kit, build with Vite, ingest into LibraryService."""
    clean_slug = normalize_artifact_slug(slug)
    if not clean_slug:
        raise LibraryError("E_INVALID_ARG", "slug must contain ASCII letters or digits")
    if not isinstance(code, str) or not code.strip():
        raise LibraryError("E_INVALID_ARG", "code must be a non-empty TSX string")

    clean_title = (title or clean_slug).strip()[:160] or clean_slug
    note = (change_note or f"omada prototype: {clean_title}").strip()[:200]
    root = resolve_omada_kit_root(kit_root)
    vite_bin = root / "node_modules" / ".bin" / "vite"
    if not vite_bin.is_file():
        raise LibraryError(
            "E_DEPENDENCY",
            f"vite executable not found at {vite_bin}",
            hint="Install dependencies in omada-ui-kit first",
        )

    demo_dir = root / "src" / "demos" / clean_slug
    demo_dir.mkdir(parents=True, exist_ok=True)
    demo_file = demo_dir / "Demo.tsx"
    demo_file.write_text(code, encoding="utf-8")

    styles_dir = root / "src" / "styles" / "modules"
    css_modules = sorted(p.name for p in styles_dir.glob("*.css")) if styles_dir.is_dir() else []

    harness_parent = root / _BUILD_HARNESS_DIRNAME
    harness_dir = harness_parent / f"{clean_slug}-{secrets.token_hex(4)}"
    harness_dir.mkdir(parents=True, exist_ok=True)

    started = time.monotonic()
    built_files: list[tuple[str, bytes]] = []
    try:
        (harness_dir / "index.html").write_text(_render_index_html(clean_title), encoding="utf-8")
        (harness_dir / "entry.css").write_text(_render_entry_css(clean_slug), encoding="utf-8")
        (harness_dir / "entry.tsx").write_text(
            _render_entry_tsx(clean_slug, theme_mode, css_modules), encoding="utf-8"
        )
        vite_cfg = harness_dir / "vite.config.mjs"
        vite_cfg.write_text(_render_vite_config_mjs(), encoding="utf-8")

        env = os.environ.copy()
        env["CI"] = "true"
        try:
            proc = subprocess.run(
                [str(vite_bin), "build", "--config", str(vite_cfg)],
                cwd=str(root),
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=max(10, int(build_timeout_sec)),
                env=env,
            )
        except subprocess.TimeoutExpired as exc:
            raise LibraryError(
                "E_BUILD_FAILED",
                f"Vite build timed out after {build_timeout_sec}s while building {clean_slug}",
            ) from exc

        if proc.returncode != 0:
            combined = "\n".join(part for part in (proc.stderr, proc.stdout) if part).strip()
            tail = "\n".join(combined.splitlines()[-40:])
            raise LibraryError(
                "E_BUILD_FAILED",
                f"Vite build failed for {clean_slug}:\n{tail or f'exit code {proc.returncode}'}",
            )

        dist_dir = harness_dir / "dist"
        if not (dist_dir / "index.html").is_file():
            raise LibraryError("E_BUILD_FAILED", f"Vite build completed without producing dist/index.html")

        for item in sorted(dist_dir.rglob("*")):
            if not item.is_file() or item.is_symlink():
                continue
            rel = item.relative_to(dist_dir).as_posix()
            if rel.endswith(".map"):
                continue
            built_files.append((rel, item.read_bytes()))
    finally:
        shutil.rmtree(harness_dir, ignore_errors=True)
        try:
            if harness_parent.is_dir() and not any(harness_parent.iterdir()):
                harness_parent.rmdir()
        except OSError:
            pass

    build_ms = int((time.monotonic() - started) * 1000)

    # Actor(kind="user") keeps LibraryService jail + index intact while allowing Vite .js/.css/.woff2 assets >1 MiB.
    ingest_actor = Actor(
        kind="user",
        agent_id=actor.agent_id if actor else None,
        session_id=actor.session_id if actor else None,
        message_id=actor.message_id if actor else None,
    )
    source_ref = (
        f"{actor.session_id}:{actor.message_id}"
        if actor and actor.session_id is not None and actor.message_id is not None
        else None
    )

    existing_versions = _list_existing_versions(service, clean_slug)
    version = (existing_versions[-1] if existing_versions else 0) + 1

    # Bump on conflict just in case of concurrent builds for the same slug.
    entry_row: Optional[dict[str, Any]] = None
    for attempt in range(3):
        ver_folder = f"{_ARTIFACTS_PREFIX}/{clean_slug}/v{version}"
        try:
            entry_bytes = next(data for rel, data in built_files if rel == "index.html")
            entry_row = service.create_file(
                f"{ver_folder}/index.html",
                entry_bytes,
                actor=ingest_actor,
                source="agent",
                source_ref=source_ref,
                change_note=note,
            )
            break
        except LibraryError as exc:
            if exc.code == "E_VERSION_CONFLICT" and attempt < 2:
                version += 1
                continue
            raise

    assert entry_row is not None
    ver_folder = f"{_ARTIFACTS_PREFIX}/{clean_slug}/v{version}"
    total_bytes = sum(len(data) for _, data in built_files)

    for rel, data in built_files:
        if rel == "index.html":
            continue
        service.create_file(
            f"{ver_folder}/{rel}",
            data,
            actor=ingest_actor,
            source="agent",
            source_ref=source_ref,
            change_note=note,
        )

    preview = issue_preview_token(
        service,
        clean_slug,
        version=version,
        entry_path="index.html",
        base_url=base_url,
    )

    return {
        "ok": True,
        "slug": clean_slug,
        "title": clean_title,
        "artifact_type": "app",
        "version": version,
        "entry_path": "index.html",
        "file_id": int(entry_row["id"]),
        "path": entry_row["path"],
        "folder": ver_folder,
        "file_count": len(built_files),
        "size_bytes": total_bytes,
        "build_ms": build_ms,
        "source_demo": f"omada-ui-kit/src/demos/{clean_slug}/Demo.tsx",
        "preview_token": preview["token"],
        "local_preview_url": preview["preview_url"],
        "change_note": note,
    }


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
