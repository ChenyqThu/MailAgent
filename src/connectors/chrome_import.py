"""Google Chrome 多 Profile 发现、macOS Cookie 解密与内置受管浏览器注入/启动器。

安全与沙箱纪律：
  - **绝不泄露明文凭据**：Chrome Safe Storage 密钥、解密后的 Cookie JSON 绝不写入日志或
    持久化到临时文件，只通过内存管道（``subprocess.run(..., input=...)`` 的 stdin）
    一次性喂给 Playwright 注入到受管浏览器 Profile（``<runtime_dir>/profile``）。
  - **SQLite 暂存零遗留**：读取运行中 Chrome 的 ``Cookies`` + WAL/SHM 时，先复制到
    ``<runtimes_base>/.tmp-chrome-cookies-<uuid>/``，解析完立刻在 ``finally`` 中删除。
  - **路径逃逸拦截**：Profile ID 严格匹配 ``^(Default|Profile \\d+)$`` 且路径必须在 Chrome
    用户数据目录内部。
"""

from __future__ import annotations

import errno
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

from loguru import logger

from src.connectors.local_installer import (
    LocalInstallerError,
    _find_executable,
    _resolve_installed_entrypoint,
    resolve_mcp_runtimes_dir,
    runtime_dir_for,
)

_PROFILE_ID_RE = re.compile(r"^(Default|Profile \d+)$")
_CHROMIUM_EPOCH_OFFSET_SEC = 11644473600.0
#: 导入时无过期时间的会话 Cookie（``has_expires=0`` / ``expires_utc=0``）赋予 7 天持久化 TTL，
#: 避免内置浏览器关闭、空闲回收或 App 重启后登录态立即消失（服务端自身仍会校验令牌有效期）。
_SESSION_COOKIE_PERSIST_SECONDS = 7 * 24 * 60 * 60
_KEYCHAIN_SERVICE = "Chrome Safe Storage"
_PBKDF2_SALT = b"saltysalt"
_PBKDF2_ITERATIONS = 1003
_AES_IV = b" " * 16
_SENSITIVE_DOMAIN_KEYWORDS = (
    "bank",
    "alipay",
    "paypal",
    "stripe",
    "1password",
    "bitwarden",
    "lastpass",
    "chase",
    "icbc",
    "cmbchina",
    "ccb",
    "boc.cn",
    "appleid",
    "icloud",
)


def _is_sensitive_domain(domain: str) -> bool:
    d = domain.lstrip(".").lower()
    return any(kw in d for kw in _SENSITIVE_DOMAIN_KEYWORDS)


def _win_known_dir(var_name: str, fallback: Path) -> Path:
    expanded = os.path.expandvars(f"%{var_name}%")
    if expanded and expanded != f"%{var_name}%":
        return Path(expanded)
    return fallback


def resolve_chrome_user_data_dir() -> Optional[Path]:
    """解析本机 Google Chrome 用户数据根目录（不存在或不支持返回 ``None``）。"""
    plat = sys.platform
    if plat == "darwin":
        cand = Path.home() / "Library" / "Application Support" / "Google" / "Chrome"
    elif plat == "win32":
        cand = _win_known_dir("LOCALAPPDATA", Path.home() / "AppData" / "Local") / "Google" / "Chrome" / "User Data"
    elif plat.startswith("linux"):
        cand = Path.home() / ".config" / "google-chrome"
    else:
        return None
    try:
        resolved = cand.expanduser().resolve()
    except OSError:
        return None
    return resolved if resolved.is_dir() else None


def _cookie_db_in_profile(profile_dir: Path) -> Optional[Path]:
    for rel in (Path("Network") / "Cookies", Path("Cookies")):
        cand = profile_dir / rel
        if cand.is_file():
            return cand
    return None


def list_chrome_profiles(chrome_root: Optional[Path] = None) -> list[dict[str, Any]]:
    """列出本机 Chrome 的可用 Profile（含展示名、邮箱与是否存在 Cookies 库）。"""
    root = chrome_root if chrome_root is not None else resolve_chrome_user_data_dir()
    if root is None or not root.is_dir():
        return []
    resolved_root = root.resolve()

    info_cache: dict[str, dict[str, Any]] = {}
    local_state_path = resolved_root / "Local State"
    if local_state_path.is_file():
        try:
            raw_state = json.loads(local_state_path.read_text(encoding="utf-8"))
            cache = (raw_state.get("profile") or {}).get("info_cache")
            if isinstance(cache, dict):
                info_cache = {k: v for k, v in cache.items() if isinstance(v, dict)}
        except (OSError, ValueError, TypeError):
            info_cache = {}

    profile_ids: set[str] = set()
    try:
        for child in resolved_root.iterdir():
            if child.is_dir() and _PROFILE_ID_RE.fullmatch(child.name):
                profile_ids.add(child.name)
    except OSError:
        return []

    def _sort_key(pid: str) -> tuple[int, str]:
        if pid == "Default":
            return (0, "")
        try:
            return (1, f"{int(pid.split(' ', 1)[1]):06d}")
        except (IndexError, ValueError):
            return (2, pid)

    profiles: list[dict[str, Any]] = []
    for pid in sorted(profile_ids, key=_sort_key):
        profile_dir = (resolved_root / pid).resolve()
        if profile_dir.parent != resolved_root:
            continue
        meta = info_cache.get(pid, {})
        display_name = str(meta.get("name") or meta.get("gaia_name") or pid).strip() or pid
        user_name = str(meta.get("user_name") or "").strip() or None
        has_cookies = _cookie_db_in_profile(profile_dir) is not None
        profiles.append(
            {
                "profile_id": pid,
                "name": display_name,
                "user_name": user_name,
                "has_cookies": has_cookies,
            }
        )
    return profiles


def resolve_chrome_cookie_db(profile_id: str, chrome_root: Optional[Path] = None) -> Path:
    """校验并定位指定 Chrome Profile 的 Cookies SQLite 文件路径。"""
    pid = (profile_id or "Default").strip()
    if not _PROFILE_ID_RE.fullmatch(pid):
        raise LocalInstallerError(
            "E_INVALID_RUNTIME_OPTION",
            f"invalid chrome profile_id: {profile_id!r}",
            status_code=422,
        )
    root = chrome_root if chrome_root is not None else resolve_chrome_user_data_dir()
    if root is None or not root.is_dir():
        raise LocalInstallerError(
            "E_CHROME_NOT_FOUND",
            "未在本机找到 Google Chrome 用户目录。",
            status_code=404,
        )
    resolved_root = root.resolve()
    profile_dir = (resolved_root / pid).resolve()
    if profile_dir.parent != resolved_root or not profile_dir.is_dir():
        raise LocalInstallerError(
            "E_CHROME_PROFILE_NOT_FOUND",
            f"未找到 Chrome Profile: {pid}",
            status_code=404,
        )
    cookie_db = _cookie_db_in_profile(profile_dir)
    if cookie_db is None:
        raise LocalInstallerError(
            "E_CHROME_COOKIES_NOT_FOUND",
            f"Chrome Profile ({pid}) 下没有可用的 Cookies 数据库。",
            status_code=404,
        )
    return cookie_db


def read_macos_chrome_safe_storage_key() -> bytes:
    """从 macOS Keychain 读取 ``Chrome Safe Storage`` 对称密钥（绝不记录密钥明文）。"""
    if sys.platform != "darwin":
        raise LocalInstallerError(
            "E_PLATFORM_UNSUPPORTED",
            "当前仅支持在 macOS 上自动读取 Chrome Safe Storage 钥匙串密钥。",
            status_code=400,
        )
    proc = subprocess.run(
        ["/usr/bin/security", "find-generic-password", "-w", "-s", _KEYCHAIN_SERVICE],
        capture_output=True,
        timeout=60.0,
        check=False,
    )
    if proc.returncode != 0:
        raise LocalInstallerError(
            "E_KEYCHAIN_DENIED",
            "无法读取 macOS 钥匙串中的「Chrome Safe Storage」密钥，请在系统弹窗中点击「允许」后重试。",
            status_code=403,
        )
    secret = proc.stdout.strip()
    if not secret:
        raise LocalInstallerError(
            "E_KEYCHAIN_DENIED",
            "macOS 钥匙串返回了空的 Chrome Safe Storage 密钥。",
            status_code=403,
        )
    return secret


def _derive_chrome_macos_aes_key(safe_storage_secret: bytes) -> bytes:
    return hashlib.pbkdf2_hmac(
        "sha1", safe_storage_secret, _PBKDF2_SALT, _PBKDF2_ITERATIONS, dklen=16
    )


def _strip_pkcs7_padding(data: bytes) -> bytes:
    if not data:
        raise ValueError("empty decrypted payload")
    pad = data[-1]
    if pad < 1 or pad > 16 or pad > len(data):
        raise ValueError("invalid PKCS#7 padding length")
    if data[-pad:] != bytes([pad]) * pad:
        raise ValueError("invalid PKCS#7 padding bytes")
    return data[:-pad]


def _decrypt_v10_cookie_value(
    encrypted_value: bytes,
    aes_key: bytes,
    *,
    host_key: str,
    db_version: int,
) -> Optional[str]:
    if encrypted_value[:3] not in (b"v10", b"v11"):
        return None
    ciphertext = encrypted_value[3:]
    if not ciphertext or len(ciphertext) % 16 != 0:
        return None
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    decryptor = Cipher(algorithms.AES(aes_key), modes.CBC(_AES_IV)).decryptor()
    padded = decryptor.update(ciphertext) + decryptor.finalize()
    unpadded = _strip_pkcs7_padding(padded)

    domain_digest = hashlib.sha256(host_key.encode("utf-8")).digest()
    if len(unpadded) >= 32 and unpadded[:32] == domain_digest:
        raw_bytes = unpadded[32:]
    elif db_version >= 24 and len(unpadded) >= 32:
        raw_bytes = unpadded[32:]
    else:
        raw_bytes = unpadded
    return raw_bytes.decode("utf-8")


def _normalize_domain_filter(raw: str) -> Optional[str]:
    s = raw.strip().lower()
    if not s:
        return None
    if "://" in s:
        parsed = urllib.parse.urlsplit(s)
        s = (parsed.hostname or "").lower()
    else:
        s = s.split("/", 1)[0].split(":", 1)[0]
    s = s.lstrip(".")
    return s or None


def _domain_matches_filters(host_key: str, normalized_filters: list[str]) -> bool:
    if not normalized_filters:
        return True
    host = host_key.lstrip(".").lower()
    if not host:
        return False
    for f in normalized_filters:
        if host == f or host.endswith("." + f) or f.endswith("." + host):
            return True
    return False


def _map_samesite(raw: Any, *, is_secure: bool) -> Optional[str]:
    if raw == 2:
        return "Strict"
    if raw == 1:
        return "Lax"
    if raw == 0 and is_secure:
        return "None"
    return None


def _stage_copy_sqlite_db(cookie_db_path: Path) -> tuple[Path, Path]:
    """复制 Chrome/Chromium ``Cookies`` SQLite + sidecar 到隔离临时目录（避免占用原库文件锁）。"""
    base = resolve_mcp_runtimes_dir()
    base.mkdir(parents=True, exist_ok=True)
    stage_dir = base / f".tmp-chrome-cookies-{uuid.uuid4().hex[:12]}"
    stage_dir.mkdir(parents=True, exist_ok=False)
    staged_db = stage_dir / "Cookies"
    try:
        shutil.copyfile(cookie_db_path, staged_db)
        for sidecar in ("-wal", "-shm"):
            src_side = Path(f"{cookie_db_path}{sidecar}")
            if src_side.is_file():
                shutil.copyfile(src_side, Path(f"{staged_db}{sidecar}"))
    except OSError as exc:
        shutil.rmtree(stage_dir, ignore_errors=True)
        if isinstance(exc, PermissionError) or exc.errno in (errno.EPERM, errno.EACCES):
            raise LocalInstallerError(
                "E_CHROME_PERMISSION_DENIED",
                "macOS 隐私保护阻止读取 Chrome 登录数据：请在「系统设置 → 隐私与安全 → 完全磁盘访问权限」中勾选 MailAgent 并重启后重试（请确认应用使用同一开发者证书签名）；也可以直接点击「打开受管浏览器窗口」手动登录一次。",
                status_code=403,
            ) from None
        raise
    return stage_dir, staged_db


def _read_cookie_domain_counts(
    cookie_db_path: Path,
    *,
    now_epoch: Optional[float] = None,
) -> dict[str, int]:
    """只读聚合未过期 Cookie 的域名计数（绝不触碰 ``encrypted_value`` 或 macOS Keychain）。"""
    stage_dir, staged_db = _stage_copy_sqlite_db(cookie_db_path)
    now = float(now_epoch if now_epoch is not None else time.time())
    counts: dict[str, int] = {}
    try:
        conn = sqlite3.connect(str(staged_db))
        try:
            rows = conn.execute(
                "SELECT host_key, expires_utc, has_expires FROM cookies"
            ).fetchall()
        finally:
            conn.close()
        for host_key, expires_utc, has_expires in rows:
            if not isinstance(host_key, str):
                continue
            domain = host_key.lstrip(".").lower()
            if not domain:
                continue
            if has_expires and isinstance(expires_utc, (int, float)) and expires_utc > 0:
                expires_unix = (float(expires_utc) / 1_000_000.0) - _CHROMIUM_EPOCH_OFFSET_SEC
                if expires_unix <= now:
                    continue
            counts[domain] = counts.get(domain, 0) + 1
    finally:
        shutil.rmtree(stage_dir, ignore_errors=True)
    return counts


def list_chrome_cookie_domains(
    profile_id: str = "Default",
    *,
    chrome_root: Optional[Path] = None,
    now_epoch: Optional[float] = None,
) -> dict[str, Any]:
    """预览指定 Chrome Profile 中可导入的域名及 Cookie 数（零明文凭据、不弹窗请求 Keychain）。"""
    pid = (profile_id or "Default").strip()
    cookie_db = resolve_chrome_cookie_db(pid, chrome_root=chrome_root)
    counts = _read_cookie_domain_counts(cookie_db, now_epoch=now_epoch)
    sorted_items = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    domains = [
        {"domain": domain, "count": count, "sensitive": _is_sensitive_domain(domain)}
        for domain, count in sorted_items
    ]
    return {
        "profile_id": pid,
        "domains": domains,
        "total_cookies": sum(counts.values()),
    }


def _resolve_managed_cookie_db(profile_dir: Path) -> Optional[Path]:
    for rel in (
        Path("Default") / "Network" / "Cookies",
        Path("Default") / "Cookies",
        Path("Network") / "Cookies",
        Path("Cookies"),
    ):
        cand = profile_dir / rel
        if cand.is_file():
            return cand
    return None


def list_managed_cookie_domains(
    *,
    profile_dir: Optional[Path] = None,
    now_epoch: Optional[float] = None,
) -> dict[str, Any]:
    """查看内置浏览器当前已保存登录态的域名清单（Desktop 优先走 Electron session，余走受管 Chromium）。"""
    from src.connectors.desktop_bridge import desktop_browser_bridge

    if profile_dir is None and desktop_browser_bridge.is_alive():
        return desktop_browser_bridge.list_cookie_domains()

    from src.connectors.managed_browser import managed_browser

    if managed_browser.is_running():
        return managed_browser.list_cookie_domains_live_sync()

    p_dir = profile_dir if profile_dir is not None else runtime_dir_for("browser_use") / "profile"
    if not p_dir.is_dir():
        return {"domains": [], "total_cookies": 0}
    cookie_db = _resolve_managed_cookie_db(p_dir)
    if cookie_db is None:
        return {"domains": [], "total_cookies": 0}

    counts = _read_cookie_domain_counts(cookie_db, now_epoch=now_epoch)
    sorted_items = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return {
        "domains": [{"domain": d, "count": n} for d, n in sorted_items],
        "total_cookies": sum(counts.values()),
    }


def clear_managed_cookies(
    domain: Optional[str] = None,
    *,
    profile_dir: Optional[Path] = None,
) -> dict[str, Any]:
    """清理内置浏览器已保存的 Cookie（支持按域名单点清理或全部清空）。"""
    clean_domain = domain.strip() if isinstance(domain, str) and domain.strip() else None
    from src.connectors.desktop_bridge import desktop_browser_bridge

    if profile_dir is None and desktop_browser_bridge.is_alive():
        return desktop_browser_bridge.clear_cookies(clean_domain)

    from src.connectors.managed_browser import managed_browser

    if managed_browser.is_running():
        return managed_browser.clear_cookies_live_sync(clean_domain)

    p_dir = profile_dir if profile_dir is not None else runtime_dir_for("browser_use") / "profile"
    if not p_dir.is_dir():
        return {"cleared": 0, "domain": clean_domain}
    cookie_db = _resolve_managed_cookie_db(p_dir)
    if cookie_db is None:
        return {"cleared": 0, "domain": clean_domain}

    cleared = 0
    conn = sqlite3.connect(str(cookie_db), timeout=5.0)
    try:
        if clean_domain is None:
            cur = conn.execute("DELETE FROM cookies")
            if cur.rowcount is not None and cur.rowcount > 0:
                cleared = int(cur.rowcount)
        else:
            norm = _normalize_domain_filter(clean_domain)
            if norm:
                rows = conn.execute("SELECT rowid, host_key FROM cookies").fetchall()
                rowids = [
                    int(rowid)
                    for rowid, host_key in rows
                    if isinstance(host_key, str) and _domain_matches_filters(host_key, [norm])
                ]
                chunk_size = 500
                for idx in range(0, len(rowids), chunk_size):
                    batch = rowids[idx : idx + chunk_size]
                    placeholders = ",".join("?" for _ in batch)
                    cur = conn.execute(f"DELETE FROM cookies WHERE rowid IN ({placeholders})", batch)
                    if cur.rowcount is not None and cur.rowcount > 0:
                        cleared += int(cur.rowcount)
        conn.commit()
    finally:
        conn.close()

    return {"cleared": cleared, "domain": clean_domain}


def decrypt_chrome_cookies_from_db(
    cookie_db_path: Path,
    safe_storage_secret: bytes,
    *,
    domain_filters: Optional[list[str]] = None,
    now_epoch: Optional[float] = None,
) -> list[dict[str, Any]]:
    """暂存复制 Chrome ``Cookies`` SQLite + WAL 后解密并转换为 Playwright Cookie 列表。"""
    now = float(now_epoch if now_epoch is not None else time.time())
    normalized_filters = [
        nf for item in (domain_filters or []) if isinstance(item, str) and (nf := _normalize_domain_filter(item))
    ]
    aes_key = _derive_chrome_macos_aes_key(safe_storage_secret)
    stage_dir, staged_db = _stage_copy_sqlite_db(cookie_db_path)
    out: list[dict[str, Any]] = []

    try:
        conn = sqlite3.connect(str(staged_db))
        try:
            db_version = 0
            try:
                ver_row = conn.execute(
                    "SELECT value FROM meta WHERE key='version'"
                ).fetchone()
                if ver_row is not None and ver_row[0] is not None:
                    db_version = int(ver_row[0])
            except (sqlite3.Error, ValueError, TypeError):
                db_version = 0

            rows = conn.execute(
                "SELECT host_key, name, value, encrypted_value, path, expires_utc, "
                "is_secure, is_httponly, samesite, has_expires FROM cookies"
            ).fetchall()
        finally:
            conn.close()

        for (
            host_key,
            name,
            plain_val,
            enc_val,
            path_val,
            expires_utc,
            is_secure,
            is_httponly,
            samesite,
            has_expires,
        ) in rows:
            if not isinstance(host_key, str) or not host_key or not isinstance(name, str) or not name:
                continue
            if not _domain_matches_filters(host_key, normalized_filters):
                continue

            expires_unix: Optional[float] = None
            if has_expires and isinstance(expires_utc, (int, float)) and expires_utc > 0:
                expires_unix = (float(expires_utc) / 1_000_000.0) - _CHROMIUM_EPOCH_OFFSET_SEC
                if expires_unix <= now:
                    continue

            cookie_value: Optional[str] = None
            if isinstance(plain_val, str) and plain_val != "":
                cookie_value = plain_val
            elif isinstance(enc_val, (bytes, bytearray)) and len(enc_val) > 0:
                try:
                    cookie_value = _decrypt_v10_cookie_value(
                        bytes(enc_val),
                        aes_key,
                        host_key=host_key,
                        db_version=db_version,
                    )
                except Exception:  # noqa: BLE001 — 单条坏密文跳过，不中断整批导入
                    continue
            elif plain_val == "":
                cookie_value = ""

            if cookie_value is None:
                continue

            secure_bool = bool(is_secure)
            httponly_bool = bool(is_httponly)
            cookie_path = path_val if isinstance(path_val, str) and path_val.startswith("/") else "/"

            if name.startswith("__Host-"):
                clean_host = host_key.lstrip(".")
                if not clean_host:
                    continue
                item: dict[str, Any] = {
                    "name": name,
                    "value": cookie_value,
                    "url": f"https://{clean_host}/",
                    "secure": True,
                    "httpOnly": httponly_bool,
                }
                mapped_ss = _map_samesite(samesite, is_secure=True)
            else:
                if name.startswith("__Secure-"):
                    secure_bool = True
                item = {
                    "name": name,
                    "value": cookie_value,
                    "domain": host_key,
                    "path": cookie_path,
                    "secure": secure_bool,
                    "httpOnly": httponly_bool,
                }
                mapped_ss = _map_samesite(samesite, is_secure=secure_bool)

            if mapped_ss is not None:
                item["sameSite"] = mapped_ss
            if expires_unix is not None:
                item["expires"] = round(expires_unix, 3)
            else:
                # 会议/SSO 会话 Cookie 转持久化，避免内置浏览器关闭或重启后登录态丢失
                item["expires"] = round(now + _SESSION_COOKIE_PERSIST_SECONDS, 3)
            out.append(item)
    finally:
        shutil.rmtree(stage_dir, ignore_errors=True)

    return out


def inject_cookies_into_managed_profile(
    cookies: list[dict[str, Any]],
    *,
    runtime_dir: Optional[Path] = None,
) -> dict[str, int]:
    """把 Cookie 列表写入受管浏览器持久目录（Desktop 态直写 Electron session，否则走 CDP/冷注入）。"""
    from src.connectors.desktop_bridge import desktop_browser_bridge

    if runtime_dir is None and desktop_browser_bridge.is_alive():
        if not cookies:
            return {"imported": 0, "skipped": 0}
        return desktop_browser_bridge.set_cookies(cookies)

    manifest, ep = _resolve_installed_entrypoint("browser_use")
    if manifest is None or ep is None:
        raise LocalInstallerError(
            "E_RUNTIME_NOT_INSTALLED",
            "请先安装 Browser Use 本地运行时后再导入 Chrome 登录态。",
            status_code=409,
        )

    rt_dir = runtime_dir if runtime_dir is not None else runtime_dir_for("browser_use")
    profile_dir = rt_dir / "profile"
    profile_dir.mkdir(parents=True, exist_ok=True)

    if not cookies:
        return {"imported": 0, "skipped": 0}

    from src.connectors.managed_browser import managed_browser

    if managed_browser.is_running():
        return managed_browser.inject_cookies_live_sync(cookies)

    return managed_browser.inject_cookies_cold_sync(cookies, profile_dir=profile_dir)


def import_chrome_cookies(
    profile_id: str = "Default",
    *,
    domain_filters: Optional[list[str]] = None,
    chrome_root: Optional[Path] = None,
    keychain_reader: Callable[[], bytes] = read_macos_chrome_safe_storage_key,
    cookie_injector: Optional[Callable[[list[dict[str, Any]], Path], dict[str, int]]] = None,
) -> dict[str, Any]:
    """端到端从指定 Chrome Profile 导入 Cookie 到内置受管浏览器持久目录。"""
    from src.connectors.desktop_bridge import desktop_browser_bridge

    desktop_alive = cookie_injector is None and desktop_browser_bridge.is_alive()
    if not desktop_alive:
        manifest, ep = _resolve_installed_entrypoint("browser_use")
        if manifest is None or ep is None:
            raise LocalInstallerError(
                "E_RUNTIME_NOT_INSTALLED",
                "请先安装 Browser Use 本地运行时后再导入 Chrome 登录态。",
                status_code=409,
            )
    pid = (profile_id or "Default").strip()
    cookie_db = resolve_chrome_cookie_db(pid, chrome_root=chrome_root)
    secret = keychain_reader()
    cookies = decrypt_chrome_cookies_from_db(
        cookie_db,
        secret,
        domain_filters=domain_filters,
    )
    if desktop_alive:
        counts = (
            desktop_browser_bridge.set_cookies(cookies)
            if cookies
            else {"imported": 0, "skipped": 0}
        )
    else:
        rt_dir = runtime_dir_for("browser_use")
        injector = cookie_injector or (
            lambda items, d: inject_cookies_into_managed_profile(items, runtime_dir=d)
        )
        counts = injector(cookies, rt_dir)
    logger.info(
        "[connector.chrome_import] imported {} cookie(s) (skipped {}) from Chrome profile {}",
        counts.get("imported", 0),
        counts.get("skipped", 0),
        pid,
    )
    return {
        "ok": True,
        "profile_id": pid,
        "matched": len(cookies),
        "imported": int(counts.get("imported", 0)),
        "skipped": int(counts.get("skipped", 0)),
    }


def _find_chrome_executable() -> Optional[str]:
    if sys.platform == "darwin":
        return _find_executable(
            [
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                str(Path.home() / "Applications" / "Google Chrome.app" / "Contents" / "MacOS" / "Google Chrome"),
            ]
        )
    if sys.platform == "win32":
        local_app = _win_known_dir("LOCALAPPDATA", Path.home() / "AppData" / "Local")
        prog_files = _win_known_dir("ProgramFiles", Path(r"C:\Program Files"))
        prog_x86 = _win_known_dir("ProgramFiles(x86)", Path(r"C:\Program Files (x86)"))
        return _find_executable(
            [
                str(prog_files / "Google" / "Chrome" / "Application" / "chrome.exe"),
                str(prog_x86 / "Google" / "Chrome" / "Application" / "chrome.exe"),
                str(local_app / "Google" / "Chrome" / "Application" / "chrome.exe"),
            ]
        )
    return _find_executable(["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"])


def launch_managed_browser_window(*, start_url: Optional[str] = None) -> dict[str, Any]:
    """以可视窗口模式启动内置受管浏览器 Profile（便于用户查看状态或手动补登 SSO/2FA）。"""
    manifest, ep = _resolve_installed_entrypoint("browser_use")
    if manifest is None or ep is None:
        raise LocalInstallerError(
            "E_RUNTIME_NOT_INSTALLED",
            "请先安装 Browser Use 本地运行时后再打开专属浏览器窗口。",
            status_code=409,
        )
    clean_url: Optional[str] = None
    if start_url is not None and str(start_url).strip():
        cand = str(start_url).strip()
        if not (cand.startswith("http://") or cand.startswith("https://")):
            raise LocalInstallerError(
                "E_INVALID_RUNTIME_OPTION",
                "url must start with http:// or https://",
                status_code=422,
            )
        clean_url = cand

    chrome_exe = _find_chrome_executable()
    if not chrome_exe:
        raise LocalInstallerError(
            "E_CHROME_NOT_FOUND",
            "未在本机检测到 Google Chrome 可执行文件，无法打开可视浏览器窗口。",
            status_code=404,
        )

    from src.connectors.managed_browser import managed_browser

    managed_browser.stop_sync()

    profile_dir = runtime_dir_for("browser_use") / "profile"
    profile_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        chrome_exe,
        f"--user-data-dir={profile_dir}",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    if clean_url:
        cmd.append(clean_url)

    subprocess.Popen(
        cmd,
        cwd=str(runtime_dir_for("browser_use")),
        start_new_session=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    logger.info("[connector.chrome_import] launched managed browser window profile={}", profile_dir)
    return {"ok": True, "launched": True, "profile_dir": str(profile_dir)}
