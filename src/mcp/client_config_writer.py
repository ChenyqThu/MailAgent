"""Surgical MCP client configuration writer (Phase 5 WP-5C).

Writes or previews MailAgent MCP server entries into local client configs:
  - ``claude_desktop``: ``~/Library/Application Support/Claude/claude_desktop_config.json``
  - ``claude_code``: ``~/.claude.json``
  - ``cursor``: ``~/.cursor/mcp.json``
  - ``antigravity``: ``~/.gemini/config/mcp_config.json``

Guarantees:
  - Preserves all unrelated top-level keys and sibling ``mcpServers`` entries.
  - Fails closed with HTTP 409 ``E_CLIENT_CONFIG_INVALID_JSON`` if an existing
    target file contains malformed or non-object JSON.
  - Backs up any existing target file to ``<path>.bak`` before overwriting.
  - Atomically writes temp file + ``os.replace`` with ``0o600`` permissions.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any, Optional

CLIENT_TARGETS: tuple[str, ...] = (
    "claude_desktop",
    "claude_code",
    "cursor",
    "antigravity",
)

CLIENT_MODES: tuple[str, ...] = ("http", "streamable_http", "sse", "stdio")

_SERVER_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{1,48}$")

# 测试覆盖根目录（由单测设值，避免直接读未白名单化的 os.environ）。
_CONFIG_ROOT_OVERRIDE: Optional[Path] = None


class ClientConfigError(Exception):
    def __init__(self, code: str, message: str, *, http_status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.http_status = http_status


def resolve_client_config_path(
    target: str, *, config_root: Optional[Path] = None
) -> Path:
    if target not in CLIENT_TARGETS:
        raise ClientConfigError(
            "E_INVALID_ARG",
            f"target must be one of {list(CLIENT_TARGETS)}",
            http_status=400,
        )
    override_root = config_root or _CONFIG_ROOT_OVERRIDE
    if override_root is not None:
        root = Path(override_root).expanduser()
        mapping = {
            "claude_desktop": root / "claude_desktop_config.json",
            "claude_code": root / ".claude.json",
            "cursor": root / ".cursor" / "mcp.json",
            "antigravity": root / ".gemini" / "config" / "mcp_config.json",
        }
        return mapping[target]

    home = Path.home()
    if sys.platform == "darwin":
        claude_desktop = (
            home
            / "Library"
            / "Application Support"
            / "Claude"
            / "claude_desktop_config.json"
        )
    else:
        claude_desktop = home / ".config" / "Claude" / "claude_desktop_config.json"

    return {
        "claude_desktop": claude_desktop,
        "claude_code": home / ".claude.json",
        "cursor": home / ".cursor" / "mcp.json",
        "antigravity": home / ".gemini" / "config" / "mcp_config.json",
    }[target]


def _repo_root() -> str:
    return str(Path(__file__).resolve().parents[2])


def build_mcp_server_entry(
    target: str,
    *,
    mode: str = "http",
    api_base: Optional[str] = None,
    api_key: Optional[str] = None,
) -> dict[str, Any]:
    if target not in CLIENT_TARGETS:
        raise ClientConfigError(
            "E_INVALID_ARG",
            f"target must be one of {list(CLIENT_TARGETS)}",
            http_status=400,
        )
    if mode not in CLIENT_MODES:
        raise ClientConfigError(
            "E_INVALID_ARG",
            f"mode must be one of {list(CLIENT_MODES)}",
            http_status=400,
        )
    port = os.environ.get("MAILAGENT_API_PORT", "8200")
    base = (api_base or f"http://127.0.0.1:{port}").strip().rstrip("/")
    token = (api_key or "").strip() or "<YOUR_MAILAGENT_API_KEY>"

    if mode == "stdio":
        return {
            "command": sys.executable,
            "args": ["-m", "src.mcp.mailagent_mcp"],
            "cwd": _repo_root(),
            "env": {
                "MAILAGENT_API_BASE": base,
                "MAILAGENT_AGENT_KEY": token,
            },
        }

    if mode == "sse":
        return {
            "type": "sse",
            "url": f"{base}/mcp/sse",
            "headers": {
                "Authorization": f"Bearer {token}",
            },
        }

    # "http" (backward-compatible alias) and "streamable_http"
    entry: dict[str, Any] = {
        "url": f"{base}/mcp",
        "headers": {
            "Authorization": f"Bearer {token}",
        },
    }
    if target == "claude_code":
        entry["type"] = "http"
    return entry


def write_client_mcp_config(
    target: str,
    *,
    mode: str = "http",
    server_name: str = "mailagent",
    api_base: Optional[str] = None,
    api_key: Optional[str] = None,
    dry_run: bool = False,
    config_root: Optional[Path] = None,
) -> dict[str, Any]:
    if not isinstance(server_name, str) or not _SERVER_NAME_RE.match(server_name):
        raise ClientConfigError(
            "E_INVALID_ARG",
            f"server_name must match {_SERVER_NAME_RE.pattern}",
            http_status=400,
        )
    path = resolve_client_config_path(target, config_root=config_root)
    entry = build_mcp_server_entry(
        target, mode=mode, api_base=api_base, api_key=api_key
    )

    existing_existed = path.exists()
    data: dict[str, Any] = {}
    if existing_existed:
        try:
            raw_text = path.read_text(encoding="utf-8")
            if raw_text.strip():
                parsed = json.loads(raw_text)
                if not isinstance(parsed, dict):
                    raise ClientConfigError(
                        "E_CLIENT_CONFIG_INVALID_JSON",
                        f"existing config at {path} must be a JSON object",
                        http_status=409,
                    )
                data = parsed
        except ClientConfigError:
            raise
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ClientConfigError(
                "E_CLIENT_CONFIG_INVALID_JSON",
                f"refusing to modify malformed JSON config at {path}: {exc}",
                http_status=409,
            ) from exc

    servers = data.get("mcpServers")
    if servers is None:
        servers_dict: dict[str, Any] = {}
        data["mcpServers"] = servers_dict
    elif isinstance(servers, dict):
        servers_dict = dict(servers)
        data["mcpServers"] = servers_dict
    else:
        raise ClientConfigError(
            "E_CLIENT_CONFIG_INVALID_JSON",
            f"existing config at {path} has non-object 'mcpServers'",
            http_status=409,
        )

    servers_dict[server_name] = entry
    rendered = json.dumps(data, indent=2, ensure_ascii=False) + "\n"

    if dry_run:
        return {
            "target": target,
            "mode": mode,
            "server_name": server_name,
            "path": str(path),
            "exists": existing_existed,
            "dry_run": True,
            "wrote": False,
            "backup_path": None,
            "snippet": entry,
            "preview": rendered,
        }

    path.parent.mkdir(parents=True, exist_ok=True)
    backup_path: Optional[str] = None
    if existing_existed:
        bak = Path(f"{path}.bak")
        shutil.copyfile(path, bak)
        os.chmod(bak, 0o600)
        backup_path = str(bak)

    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=str(path.parent),
    )
    try:
        os.chmod(tmp_name, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(rendered)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_name, path)
        os.chmod(path, 0o600)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise

    return {
        "target": target,
        "mode": mode,
        "server_name": server_name,
        "path": str(path),
        "exists": existing_existed,
        "dry_run": False,
        "wrote": True,
        "backup_path": backup_path,
        "snippet": entry,
        "preview": rendered,
    }
