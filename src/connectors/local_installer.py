"""受管本机 stdio MCP 运行时安装器（WS-3：``browser_use`` / ``desktop_use``）。

安全与沙箱红线：
  - **绝对不写 `<runtime_base>` 之外**：下载 / 解压 / npm install 一律先在
    `<runtime_base>/.tmp-<id>-<uuid>/` 暂存，全部校验通过后才原子切换进
    `<runtime_base>/<id>/`；任何步骤失败都在 `finally` 整目录清掉。
  - **绝对不使用 `sudo`**。
  - **`desktop_use` 二进制强制校验 SHA-256**（不匹配抛 `E_CHECKSUM_MISMATCH`），
    macOS 下赋 `0o755`、剥 quarantine 并做 ad-hoc `/usr/bin/codesign --sign - --force`。
  - **不读未登记环境变量**（runtime root 仅支持内部测试覆写 ``_RUNTIMES_DIR_OVERRIDE``，
    默认由 ``src.agent_config.store.resolve_agent_config_db_path`` 推导）。
"""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional, Union

from loguru import logger

from src.agent_config.store import resolve_agent_config_db_path
from src.connectors.catalog import get_managed_local_entry

BROWSER_MODES: tuple[str, ...] = ("cdp_chrome", "extension", "isolated_profile")
DEFAULT_CDP_URL = "chrome"
PLAYWRIGHT_MCP_NPM_SPEC = "@playwright/mcp@latest"

AGENT_DESKTOP_VERSION = "v1.3.1"

_PERMISSION_PANES: dict[str, str] = {
    "accessibility": (
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
    ),
    "screen_recording": (
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
    ),
}


@dataclass(frozen=True)
class DesktopArtifactSpec:
    platform_key: str
    asset_name: str
    download_url: str
    sha256: str
    binary_name: str


_DESKTOP_ARTIFACTS: dict[str, DesktopArtifactSpec] = {
    "darwin-arm64": DesktopArtifactSpec(
        platform_key="darwin-arm64",
        asset_name=f"agent-desktop-{AGENT_DESKTOP_VERSION}-aarch64-apple-darwin.tar.gz",
        download_url=(
            f"https://github.com/vercel-labs/agent-desktop/releases/download/"
            f"{AGENT_DESKTOP_VERSION}/agent-desktop-{AGENT_DESKTOP_VERSION}-aarch64-apple-darwin.tar.gz"
        ),
        sha256="9b7b7cfc74892eab46c2c85d6cb7dc4863bf8dab0a222cfcfb8ae4604c69c86c",
        binary_name="agent-desktop",
    ),
    "win32-x64": DesktopArtifactSpec(
        platform_key="win32-x64",
        asset_name=f"agent-desktop-{AGENT_DESKTOP_VERSION}-x86_64-pc-windows-msvc.tar.gz",
        download_url=(
            f"https://github.com/vercel-labs/agent-desktop/releases/download/"
            f"{AGENT_DESKTOP_VERSION}/agent-desktop-{AGENT_DESKTOP_VERSION}-x86_64-pc-windows-msvc.tar.gz"
        ),
        sha256="6ee4b1e078f4e78792e79f16e32e4a78b9919464aa3c55629b7e27ed53a08c13",
        binary_name="agent-desktop.exe",
    ),
}


class LocalInstallerError(RuntimeError):
    """带稳定错误码与 HTTP 状态码的本机运行时安装器异常。"""

    def __init__(self, code: str, message: str, *, status_code: int = 500) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _current_platform() -> str:
    return sys.platform


def _current_machine() -> str:
    return platform.machine().lower()


def _desktop_platform_key() -> Optional[str]:
    plat = _current_platform()
    arch = _current_machine()
    if plat == "darwin" and arch in ("arm64", "aarch64"):
        return "darwin-arm64"
    if plat == "win32" and arch in ("amd64", "x86_64", "x64"):
        return "win32-x64"
    return None


def is_platform_supported(connector_id: str) -> bool:
    """当前宿主机是否支持该受管连接器（供 catalog/summary 投影用）。"""
    entry = get_managed_local_entry(connector_id)
    if entry is None:
        return False
    if connector_id == "desktop_use":
        key = _desktop_platform_key()
        return key is not None and key in _DESKTOP_ARTIFACTS
    return _current_platform() in entry.supported_platforms


#: Internal test override for the runtimes root directory (production uses ``<userData>/mcp-runtimes/``).
_RUNTIMES_DIR_OVERRIDE: Optional[Union[str, Path]] = None


def resolve_mcp_runtimes_dir() -> Path:
    """解析受管本机运行时根目录：``<userData>/mcp-runtimes/``（单测可通过 ``_RUNTIMES_DIR_OVERRIDE`` 隔离）。

    生产 / Electron 下 ``agent_config.db`` 位于 ``<userData>/data/agent_config.db``，
    因此取 ``db_parent.parent / "mcp-runtimes"`` 恰好落在 ``<userData>/mcp-runtimes/``；
    单测若把 ``MAILAGENT_AGENT_CONFIG_DB_PATH`` 直接指到 ``tmp_path/agent_config.db``，
    则落在 ``tmp_path/mcp-runtimes/`` 内避免污染宿主 ``/tmp``。
    """
    if _RUNTIMES_DIR_OVERRIDE:
        return Path(_RUNTIMES_DIR_OVERRIDE).expanduser().resolve()
    db_parent = Path(resolve_agent_config_db_path()).resolve().parent
    base = db_parent.parent if db_parent.name == "data" else db_parent
    return (base / "mcp-runtimes").resolve()


def _ensure_within_dir(target: Path, parent: Path) -> Path:
    resolved_parent = parent.resolve()
    resolved_target = target.resolve()
    if resolved_target == resolved_parent:
        raise LocalInstallerError(
            "E_INSTALL_FAILED",
            f"target path {resolved_target} must be strictly inside {resolved_parent}",
            status_code=500,
        )
    try:
        resolved_target.relative_to(resolved_parent)
    except ValueError as e:
        raise LocalInstallerError(
            "E_INSTALL_FAILED",
            f"path escape rejected: {resolved_target} not within {resolved_parent}",
            status_code=500,
        ) from e
    return resolved_target


def runtime_dir_for(connector_id: str) -> Path:
    entry = get_managed_local_entry(connector_id)
    if entry is None:
        raise LocalInstallerError(
            "E_CONNECTOR_UNSUPPORTED",
            f"unknown managed_local connector: {connector_id!r}",
            status_code=404,
        )
    base = resolve_mcp_runtimes_dir()
    return _ensure_within_dir(base / connector_id, base)


def normalize_runtime_options(
    connector_id: str,
    raw: Optional[dict[str, Any]],
    *,
    existing: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """校验并合并运行选项（如 ``browser_use`` 三模式与 ``cdp_url``）。"""
    entry = get_managed_local_entry(connector_id)
    if entry is None:
        raise LocalInstallerError(
            "E_CONNECTOR_UNSUPPORTED",
            f"unknown managed_local connector: {connector_id!r}",
            status_code=404,
        )
    payload = raw if isinstance(raw, dict) else {}
    merged: dict[str, Any] = dict(existing) if isinstance(existing, dict) else {}

    if connector_id == "browser_use":
        if "mode" in payload and payload["mode"] is not None:
            mode_val = payload["mode"]
        elif "browser_mode" in payload and payload["browser_mode"] is not None:
            mode_val = payload["browser_mode"]
        else:
            mode_val = merged.get("mode") or entry.default_mode
        if not isinstance(mode_val, str) or mode_val not in entry.supported_modes:
            raise LocalInstallerError(
                "E_INVALID_RUNTIME_OPTION",
                f"unsupported browser_use mode {mode_val!r}; expected one of {entry.supported_modes}",
                status_code=422,
            )
        merged["mode"] = mode_val
        if "cdp_url" in payload and payload["cdp_url"] is not None:
            cdp_raw = str(payload["cdp_url"]).strip()
            if cdp_raw != "chrome" and not (
                cdp_raw.startswith("http://") or cdp_raw.startswith("https://")
            ):
                raise LocalInstallerError(
                    "E_INVALID_RUNTIME_OPTION",
                    "cdp_url must be 'chrome' or start with http:// or https://",
                    status_code=422,
                )
            merged["cdp_url"] = cdp_raw
        elif mode_val == "cdp_chrome" and not merged.get("cdp_url"):
            merged["cdp_url"] = DEFAULT_CDP_URL
        return merged

    mode_extra = payload.get("mode") or payload.get("browser_mode")
    if mode_extra is not None:
        raise LocalInstallerError(
            "E_INVALID_RUNTIME_OPTION",
            f"{connector_id} does not support runtime mode overrides",
            status_code=422,
        )
    return merged


def _find_executable(candidates: list[Optional[str]]) -> Optional[str]:
    for cand in candidates:
        if not cand:
            continue
        found = shutil.which(cand) if os.sep not in cand else cand
        if found and os.path.isfile(found) and os.access(found, os.X_OK):
            return found
    return None


def _find_npm() -> Optional[str]:
    return _find_executable(
        ["npm", "/opt/homebrew/bin/npm", "/usr/local/bin/npm"]
    )


def _find_node() -> Optional[str]:
    return _find_executable(
        ["node", "nodejs", "/opt/homebrew/bin/node", "/usr/local/bin/node"]
    )


def _run_subprocess(
    cmd: list[str],
    *,
    cwd: Optional[Path] = None,
    env: Optional[dict[str, str]] = None,
    timeout: float = 180.0,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def _download_bytes(url: str) -> bytes:
    import httpx

    with httpx.Client(follow_redirects=True, timeout=120.0) as client:
        resp = client.get(url)
        resp.raise_for_status()
        return resp.content


def _safe_extract_tar_gz(archive_bytes: bytes, dest_dir: Path) -> list[Path]:
    """安全解压 tar.gz：拒绝路径逃逸、符号链接与设备节点。"""
    dest_resolved = dest_dir.resolve()
    dest_resolved.mkdir(parents=True, exist_ok=True)
    extracted: list[Path] = []
    try:
        with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as tf:
            for member in tf.getmembers():
                if member.issym() or member.islnk() or member.isdev() or member.isfifo():
                    raise LocalInstallerError(
                        "E_INSTALL_FAILED",
                        f"unsafe tar entry rejected: {member.name!r}",
                        status_code=500,
                    )
                rel = Path(member.name)
                if rel.is_absolute() or ".." in rel.parts:
                    raise LocalInstallerError(
                        "E_INSTALL_FAILED",
                        f"path traversal entry rejected: {member.name!r}",
                        status_code=500,
                    )
                if not member.isfile():
                    continue
                target = (dest_resolved / rel).resolve()
                _ensure_within_dir(target, dest_resolved)
                target.parent.mkdir(parents=True, exist_ok=True)
                src_fh = tf.extractfile(member)
                if src_fh is None:
                    continue
                with src_fh, open(target, "wb") as out_fh:
                    shutil.copyfileobj(src_fh, out_fh)
                if member.mode & 0o111:
                    os.chmod(target, 0o755)
                extracted.append(target)
    except LocalInstallerError:
        raise
    except Exception as e:  # noqa: BLE001
        raise LocalInstallerError(
            "E_INSTALL_FAILED",
            f"failed to extract archive: {e}",
            status_code=500,
        ) from e
    return extracted


def _write_manifest(staging_dir: Path, data: dict[str, Any]) -> dict[str, Any]:
    manifest_path = staging_dir / "manifest.json"
    manifest_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data


def _read_manifest(runtime_dir: Path) -> Optional[dict[str, Any]]:
    manifest_path = runtime_dir / "manifest.json"
    if not manifest_path.is_file():
        return None
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError, TypeError):
        return None


def _resolve_installed_entrypoint(connector_id: str) -> tuple[Optional[dict[str, Any]], Optional[Path]]:
    runtime_dir = runtime_dir_for(connector_id)
    manifest = _read_manifest(runtime_dir)
    if manifest is None:
        return None, None
    rel = manifest.get("entrypoint")
    if not isinstance(rel, str) or not rel.strip():
        return None, None
    try:
        ep = _ensure_within_dir(runtime_dir / rel, runtime_dir)
    except LocalInstallerError:
        return None, None
    if not ep.is_file():
        return None, None
    return manifest, ep


def _atomic_install(
    connector_id: str,
    populate_fn: Callable[[Path], dict[str, Any]],
) -> dict[str, Any]:
    base = resolve_mcp_runtimes_dir()
    base.mkdir(parents=True, exist_ok=True)
    target_dir = runtime_dir_for(connector_id)
    token = uuid.uuid4().hex[:12]
    staging_dir = base / f".tmp-{connector_id}-{token}"
    backup_dir = base / f".bak-{connector_id}-{token}"
    staging_dir.mkdir(parents=True, exist_ok=False)
    try:
        manifest = populate_fn(staging_dir)
        swapped_backup = False
        try:
            if target_dir.exists():
                os.replace(target_dir, backup_dir)
                swapped_backup = True
            os.replace(staging_dir, target_dir)
        except Exception:
            if swapped_backup and backup_dir.exists() and not target_dir.exists():
                try:
                    os.replace(backup_dir, target_dir)
                except OSError:
                    pass
            raise
        if swapped_backup and backup_dir.exists():
            shutil.rmtree(backup_dir, ignore_errors=True)
        return manifest
    finally:
        if staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)


def _resolve_playwright_entrypoint(pkg_dir: Path) -> tuple[str, str]:
    """定位 `@playwright/mcp` 包版本与相对 ``pkg_dir`` 的入口脚本路径。"""
    pkg_json_path = pkg_dir / "node_modules" / "@playwright" / "mcp" / "package.json"
    version = "unknown"
    rel_candidates: list[Path] = []
    if pkg_json_path.is_file():
        try:
            meta = json.loads(pkg_json_path.read_text(encoding="utf-8"))
            if isinstance(meta.get("version"), str) and meta["version"]:
                version = meta["version"]
            bin_field = meta.get("bin")
            if isinstance(bin_field, str) and bin_field:
                rel_candidates.append(pkg_json_path.parent / bin_field)
            elif isinstance(bin_field, dict):
                for val in bin_field.values():
                    if isinstance(val, str) and val:
                        rel_candidates.append(pkg_json_path.parent / val)
        except (OSError, ValueError, TypeError):
            pass
    rel_candidates.extend(
        [
            pkg_dir / "node_modules" / "@playwright" / "mcp" / "cli.js",
            pkg_dir / "node_modules" / ".bin" / "playwright-mcp",
            pkg_dir / "node_modules" / ".bin" / "mcp-server-playwright",
        ]
    )
    for cand in rel_candidates:
        try:
            resolved = _ensure_within_dir(cand, pkg_dir.parent)
        except LocalInstallerError:
            continue
        if resolved.is_file():
            return version, resolved.relative_to(pkg_dir.parent).as_posix()
    raise LocalInstallerError(
        "E_INSTALL_FAILED",
        "@playwright/mcp installed without an entrypoint script",
        status_code=500,
    )


def _install_browser_use(staging_dir: Path) -> dict[str, Any]:
    npm_exe = _find_npm()
    if not npm_exe:
        raise LocalInstallerError(
            "E_RUNTIME_TOOL_MISSING",
            "npm was not found on PATH; Node.js/npm is required to install @playwright/mcp",
            status_code=409,
        )
    pkg_dir = staging_dir / "pkg"
    cache_dir = staging_dir / ".npm-cache"
    pkg_dir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)

    env = os.environ.copy()
    env["npm_config_cache"] = str(cache_dir)
    proc = _run_subprocess(
        [
            npm_exe,
            "install",
            "--prefix",
            str(pkg_dir),
            "--cache",
            str(cache_dir),
            "--no-audit",
            "--no-fund",
            PLAYWRIGHT_MCP_NPM_SPEC,
        ],
        cwd=staging_dir,
        env=env,
        timeout=240.0,
    )
    shutil.rmtree(cache_dir, ignore_errors=True)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()[:300]
        raise LocalInstallerError(
            "E_INSTALL_FAILED",
            f"npm install @playwright/mcp failed (rc={proc.returncode}): {detail}",
            status_code=500,
        )
    version, rel_entrypoint = _resolve_playwright_entrypoint(pkg_dir)
    return _write_manifest(
        staging_dir,
        {
            "connector_id": "browser_use",
            "version": version,
            "entrypoint": rel_entrypoint,
            "installed_at": int(time.time()),
            "platform": _current_platform(),
        },
    )


def _macos_unquarantine_and_codesign(paths: list[Path]) -> None:
    for p in paths:
        os.chmod(p, 0o755)
        _run_subprocess(["/usr/bin/xattr", "-d", "com.apple.quarantine", str(p)], timeout=30.0)
        proc = _run_subprocess(
            ["/usr/bin/codesign", "--sign", "-", "--force", str(p)],
            timeout=60.0,
        )
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "").strip()[:300]
            raise LocalInstallerError(
                "E_CODESIGN_FAILED",
                f"ad-hoc codesign failed for {p.name}: {detail}",
                status_code=500,
            )


def _install_desktop_use(staging_dir: Path) -> dict[str, Any]:
    key = _desktop_platform_key()
    artifact = _DESKTOP_ARTIFACTS.get(key or "")
    if artifact is None:
        raise LocalInstallerError(
            "E_PLATFORM_UNSUPPORTED",
            f"desktop_use is not supported on platform {_current_platform()}/{_current_machine()}",
            status_code=400,
        )
    try:
        archive_bytes = _download_bytes(artifact.download_url)
    except Exception as e:  # noqa: BLE001
        raise LocalInstallerError(
            "E_INSTALL_FAILED",
            f"failed to download {artifact.asset_name}: {e}",
            status_code=502,
        ) from e

    actual_sha = hashlib.sha256(archive_bytes).hexdigest()
    if not hmac.compare_digest(actual_sha.lower(), artifact.sha256.lower()):
        raise LocalInstallerError(
            "E_CHECKSUM_MISMATCH",
            (
                f"SHA-256 verification failed for {artifact.asset_name}: "
                f"expected {artifact.sha256}, got {actual_sha}"
            ),
            status_code=500,
        )

    bin_dir = staging_dir / "bin"
    extracted = _safe_extract_tar_gz(archive_bytes, bin_dir)
    main_bin = next((p for p in extracted if p.name == artifact.binary_name), None)
    if main_bin is None or not main_bin.is_file():
        raise LocalInstallerError(
            "E_INSTALL_FAILED",
            f"archive {artifact.asset_name} did not contain {artifact.binary_name}",
            status_code=500,
        )

    if _current_platform() == "darwin":
        sign_targets = [
            p for p in extracted if p == main_bin or p.suffix in (".dylib", ".so") or os.access(p, os.X_OK)
        ]
        _macos_unquarantine_and_codesign(sign_targets)
    else:
        os.chmod(main_bin, 0o755)

    rel_ep = main_bin.relative_to(staging_dir).as_posix()
    return _write_manifest(
        staging_dir,
        {
            "connector_id": "desktop_use",
            "version": AGENT_DESKTOP_VERSION,
            "entrypoint": rel_ep,
            "sha256": actual_sha,
            "installed_at": int(time.time()),
            "platform": key,
        },
    )


def install_runtime(
    connector_id: str,
    runtime_config: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """一键安装受管本机运行时（全流程暂存 + 失败 fail-closed 清理），返回安装状态。"""
    normalized_rc = normalize_runtime_options(connector_id, runtime_config)
    if connector_id == "browser_use":
        _atomic_install(connector_id, _install_browser_use)
    elif connector_id == "desktop_use":
        _atomic_install(connector_id, _install_desktop_use)
    else:  # pragma: no cover — runtime_dir_for / normalize_runtime_options 已门控
        raise LocalInstallerError(
            "E_CONNECTOR_UNSUPPORTED",
            f"unknown managed_local connector: {connector_id!r}",
            status_code=404,
        )
    logger.info("[connector.local_installer] installed managed runtime {}", connector_id)
    return get_install_status(connector_id, normalized_rc)


def uninstall_runtime(connector_id: str) -> dict[str, Any]:
    """清理受管本机运行时目录，返回最新未安装状态。"""
    target = runtime_dir_for(connector_id)
    _ensure_within_dir(target, resolve_mcp_runtimes_dir())
    if target.exists():
        shutil.rmtree(target)
    logger.info("[connector.local_installer] uninstalled managed runtime {}", connector_id)
    return get_install_status(connector_id, None)


def resolve_stdio_command(
    connector_id: str,
    runtime_config: Optional[dict[str, Any]] = None,
) -> Optional[dict[str, Any]]:
    """根据本机安装清单与 ``runtime_config`` 拼装 stdio 启动参数；未装返回 ``None``。"""
    entry = get_managed_local_entry(connector_id)
    if entry is None:
        return None
    manifest, ep = _resolve_installed_entrypoint(connector_id)
    if manifest is None or ep is None:
        return None
    runtime_dir = runtime_dir_for(connector_id)

    if connector_id == "browser_use":
        rc = normalize_runtime_options("browser_use", runtime_config)
        mode = rc.get("mode") or entry.default_mode or "cdp_chrome"
        if mode == "cdp_chrome":
            endpoint = str(rc.get("cdp_url") or DEFAULT_CDP_URL)
            mode_args = [f"--cdp-endpoint={endpoint}"]
        elif mode == "extension":
            mode_args = ["--extension"]
        else:
            mode_args = ["--user-data-dir", str(runtime_dir / "profile")]
        if ep.suffix in (".js", ".mjs", ".cjs"):
            node_exe = _find_node() or "node"
            return {
                "command": node_exe,
                "args": [str(ep), *mode_args],
                "cwd": str(runtime_dir),
            }
        return {"command": str(ep), "args": mode_args, "cwd": str(runtime_dir)}

    if connector_id == "desktop_use":
        return {"command": str(ep), "args": ["mcp"], "cwd": str(runtime_dir)}

    return None


def get_install_status(
    connector_id: str,
    runtime_config: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """读取受管连接器安装态与运行时配置摘要（绝不触发安装或出网）。"""
    entry = get_managed_local_entry(connector_id)
    if entry is None:
        raise LocalInstallerError(
            "E_CONNECTOR_UNSUPPORTED",
            f"unknown managed_local connector: {connector_id!r}",
            status_code=404,
        )
    try:
        effective_rc = normalize_runtime_options(connector_id, runtime_config)
    except LocalInstallerError:
        effective_rc = normalize_runtime_options(connector_id, None)

    manifest, ep = _resolve_installed_entrypoint(connector_id)
    installed = manifest is not None and ep is not None
    return {
        "ok": True,
        "connector_id": connector_id,
        "installed": installed,
        "version": str(manifest.get("version")) if manifest and manifest.get("version") else None,
        "mode": effective_rc.get("mode") if connector_id == "browser_use" else None,
        "supported_modes": list(entry.supported_modes),
        "runtime_config": effective_rc,
        "requires_permissions": list(entry.requires_permissions),
        "platform_supported": is_platform_supported(connector_id),
        "executable": str(ep) if ep is not None else None,
        "error": None,
    }


def _probe_macos_accessibility() -> str:
    try:
        import ctypes

        lib = ctypes.CDLL(
            "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"
        )
        fn = getattr(lib, "AXIsProcessTrusted", None)
        if fn is None:
            return "unknown"
        fn.restype = ctypes.c_bool
        return "granted" if bool(fn()) else "denied"
    except Exception:  # noqa: BLE001
        return "unknown"


def _probe_macos_screen_recording() -> str:
    try:
        import ctypes

        lib = ctypes.CDLL(
            "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics"
        )
        fn = getattr(lib, "CGPreflightScreenCaptureAccess", None)
        if fn is None:
            return "unknown"
        fn.restype = ctypes.c_bool
        return "granted" if bool(fn()) else "denied"
    except Exception:  # noqa: BLE001
        return "unknown"


def check_system_permissions() -> dict[str, str]:
    """检测桌面控制所需的 TCC 权限状态（非 macOS 返回 ``unsupported``）。"""
    plat = _current_platform()
    if plat != "darwin":
        return {
            "platform": plat,
            "accessibility": "unsupported",
            "screen_recording": "unsupported",
        }
    return {
        "platform": plat,
        "accessibility": _probe_macos_accessibility(),
        "screen_recording": _probe_macos_screen_recording(),
    }


def open_system_permission_pane(kind: str) -> dict[str, Any]:
    """调起 macOS 系统设置 TCC 隐私面板。"""
    if kind not in _PERMISSION_PANES:
        raise LocalInstallerError(
            "E_INVALID_RUNTIME_OPTION",
            f"unsupported permission kind {kind!r}; expected 'accessibility' or 'screen_recording'",
            status_code=422,
        )
    plat = _current_platform()
    if plat != "darwin":
        return {"ok": False, "kind": kind, "opened": False}
    proc = _run_subprocess(["/usr/bin/open", _PERMISSION_PANES[kind]], timeout=15.0)
    opened = proc.returncode == 0
    return {"ok": opened, "kind": kind, "opened": opened}
