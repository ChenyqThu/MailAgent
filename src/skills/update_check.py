"""Skill 包上游更新检测（GitHub / npm / HTTP 压缩包 ETag / 本地目录 hash）+ 600s TTL 缓存。"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import re
import threading
import time
import urllib.parse
from typing import Any, Optional

import httpx

from src.agent_config.store import AgentConfigStore, SkillRow
from src.skills.pack_fetch import (
    _http_get_json,
    parse_skill_source,
)
from src.skills.pack_verify import PackError, compute_files_and_hash

_CACHE_TTL_SEC = 600.0
_HEAD_TIMEOUT_SEC = 10.0
_MAX_REDIRECTS = 5
_UA = "MailAgent-SkillUpdateCheck/1.0"

_CACHE_LOCK = threading.Lock()
_UPDATE_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}

_VER_RE = re.compile(
    r"^[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$"
)


def invalidate_skill_update_cache() -> None:
    """安装/升级/卸载 skill 后立即清空更新检测缓存。"""
    with _CACHE_LOCK:
        _UPDATE_CACHE.clear()


def parse_version(raw: Optional[str]) -> Optional[tuple[int, int, int, int, tuple[tuple[int, Any], ...]]]:
    """解析常见 semver 字符串用于大小比较；无法解析返回 None。"""
    s = (raw or "").strip()
    if not s:
        return None
    m = _VER_RE.match(s)
    if not m:
        return None
    major = int(m.group(1))
    minor = int(m.group(2) or 0)
    patch = int(m.group(3) or 0)
    pre_raw = m.group(4)
    if not pre_raw:
        # 正式版 > 预发布版
        return (major, minor, patch, 1, ())
    pre_parts: list[tuple[int, Any]] = []
    for seg in pre_raw.split("."):
        if seg.isdigit():
            pre_parts.append((0, int(seg)))
        else:
            pre_parts.append((1, seg))
    return (major, minor, patch, 0, tuple(pre_parts))


def version_gt(candidate: Optional[str], current: Optional[str]) -> bool:
    """仅当 ``candidate`` 严格高于 ``current`` 时返回 True。"""
    c_parsed = parse_version(candidate)
    cur_parsed = parse_version(current)
    if c_parsed is not None and cur_parsed is not None:
        return c_parsed > cur_parsed
    c_str = (candidate or "").strip().lstrip("vV")
    cur_str = (current or "").strip().lstrip("vV")
    if c_str and not cur_str:
        return True
    return False


def _http_head_headers(url_str: str) -> dict[str, str]:
    """SSRF 硬化 HEAD 请求（若上游回 405 则回落 GET Range: bytes=0-0）。"""
    import src.api.app  # noqa: F401
    from src.api import ssrf

    deadline = time.monotonic() + _HEAD_TIMEOUT_SEC
    current = ssrf.validate_url(url_str)
    req_headers = {"User-Agent": _UA, "Accept-Encoding": "identity"}

    def _send(method: str, extra: Optional[dict[str, str]] = None) -> tuple[str, dict[str, str]]:
        cur = current
        hdrs = dict(req_headers)
        if extra:
            hdrs.update(extra)
        with httpx.Client(trust_env=False, follow_redirects=False) as client:
            for hop in range(_MAX_REDIRECTS + 1):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise PackError("E_UPSTREAM", "update check timed out", http_status=504)
                host, port, _ = ssrf.host_port_scheme(cur)
                pinned_ip = ssrf.resolve_and_validate(host, port)
                req = client.build_request(method, cur, headers=hdrs)
                if cur.scheme.lower() == "https":
                    req.extensions["sni_hostname"] = cur.host.encode("ascii")
                pinned_url = req.url.copy_with(host=pinned_ip)
                resp = client.send(
                    httpx.Request(
                        method=req.method,
                        url=pinned_url,
                        headers=req.headers,
                        extensions=req.extensions,
                    ),
                    follow_redirects=False,
                    stream=True,
                )
                try:
                    if resp.status_code in (301, 302, 303, 307, 308):
                        loc = resp.headers.get("location")
                        if not loc or hop >= _MAX_REDIRECTS:
                            raise PackError("E_UPSTREAM", "redirect failed", http_status=502)
                        cur = ssrf.validate_url(str(cur.join(loc)))
                        continue
                    if method == "HEAD" and resp.status_code == 405:
                        return "RETRY_GET", {}
                    if resp.status_code not in (200, 206):
                        raise PackError("E_UPSTREAM", f"upstream returned {resp.status_code}", http_status=502)
                    out: dict[str, str] = {}
                    if resp.headers.get("etag"):
                        out["etag"] = resp.headers["etag"]
                    if resp.headers.get("last-modified"):
                        out["last_modified"] = resp.headers["last-modified"]
                    return "OK", out
                finally:
                    resp.close()
        raise PackError("E_UPSTREAM", "too many redirects", http_status=502)

    status, headers = _send("HEAD")
    if status == "RETRY_GET":
        _, headers = _send("GET", {"Range": "bytes=0-0"})
    return headers


def _check_github_skill(row: SkillRow, meta: dict[str, Any]) -> dict[str, Any]:
    owner = meta.get("owner")
    repo = meta.get("repo")
    ref = meta.get("ref") or "main"
    subpath = meta.get("subpath")
    if not (owner and repo) and row.source_uri:
        parsed = parse_skill_source(row.source_uri)
        if parsed.kind == "github":
            owner = parsed.owner
            repo = parsed.repo
            ref = parsed.ref or ref
            subpath = parsed.subpath or subpath
    if not (owner and repo):
        raise ValueError("missing GitHub owner/repo metadata")

    gh_headers = {"Accept": "application/vnd.github+json"}
    query = f"https://api.github.com/repos/{owner}/{repo}/commits?sha={urllib.parse.quote(str(ref), safe='')}&per_page=1"
    if subpath:
        query += f"&path={urllib.parse.quote(str(subpath), safe='/')}"
    commits, _ = _http_get_json(query, headers=gh_headers)
    latest_sha = ""
    if isinstance(commits, list) and commits and isinstance(commits[0], dict):
        latest_sha = str(commits[0].get("sha") or "")

    installed_sha = str(meta.get("commit_sha") or "")
    has_update = False
    if latest_sha and installed_sha:
        ls = latest_sha.lower()
        is_ = installed_sha.lower()
        has_update = not (ls.startswith(is_) or is_.startswith(ls))

    return {
        "name": row.skill_name,
        "provider": "github",
        "sourceUri": row.source_uri,
        "installedVersion": row.version,
        "latestVersion": None,
        "installedRef": installed_sha[:7] if installed_sha else None,
        "latestRef": latest_sha[:7] if latest_sha else None,
        "updateAvailable": has_update,
        "canAutoUpdate": bool(row.source_uri),
        "error": None,
    }


def _check_npm_skill(row: SkillRow, meta: dict[str, Any]) -> dict[str, Any]:
    pkg = meta.get("package")
    spec = meta.get("spec") or "latest"
    if not pkg and row.source_uri:
        parsed = parse_skill_source(row.source_uri)
        if parsed.kind == "npm":
            pkg = parsed.package
            spec = parsed.spec or spec
    if not pkg:
        raise ValueError("missing npm package metadata")

    encoded_pkg = urllib.parse.quote(str(pkg), safe="")
    # spec 若本身已是固定版本号，也查 latest dist-tag 便于发现新版本，但标记 spec
    tag = spec if spec in ("latest", "next", "beta", "alpha") else "latest"
    latest_version: Optional[str] = None
    try:
        data, _ = _http_get_json(f"https://registry.npmjs.org/{encoded_pkg}/{urllib.parse.quote(tag, safe='')}")
        if isinstance(data, dict) and isinstance(data.get("version"), str):
            latest_version = data["version"].strip()
    except PackError:
        reg, _ = _http_get_json(f"https://registry.npmjs.org/{encoded_pkg}")
        if isinstance(reg, dict):
            dt = reg.get("dist-tags") if isinstance(reg.get("dist-tags"), dict) else {}
            v = dt.get(tag)
            if isinstance(v, str):
                latest_version = v.strip()

    installed_ver = row.version or meta.get("version")
    has_update = version_gt(latest_version, installed_ver)
    return {
        "name": row.skill_name,
        "provider": "npm",
        "sourceUri": row.source_uri,
        "installedVersion": installed_ver,
        "latestVersion": latest_version,
        "installedRef": installed_ver,
        "latestRef": latest_version,
        "updateAvailable": has_update,
        "canAutoUpdate": bool(row.source_uri),
        "error": None,
    }


def _check_http_skill(row: SkillRow, meta: dict[str, Any]) -> dict[str, Any]:
    url = str(meta.get("url") or row.source_uri or "")
    hdrs = _http_head_headers(url)
    old_etag = meta.get("etag")
    new_etag = hdrs.get("etag")
    old_lm = meta.get("last_modified")
    new_lm = hdrs.get("last_modified")
    has_update = False
    if old_etag and new_etag:
        has_update = old_etag != new_etag
    elif old_lm and new_lm:
        has_update = old_lm != new_lm
    return {
        "name": row.skill_name,
        "provider": "http",
        "sourceUri": row.source_uri,
        "installedVersion": row.version,
        "latestVersion": None,
        "installedRef": (old_etag or old_lm),
        "latestRef": (new_etag or new_lm),
        "updateAvailable": has_update,
        "canAutoUpdate": bool(row.source_uri),
        "error": None,
    }


def _check_local_skill(row: SkillRow, meta: dict[str, Any]) -> dict[str, Any]:
    base = str(meta.get("path") or row.source_uri or "")
    sub = meta.get("subpath")
    target = base if not sub else f"{base}/{sub}"
    import os

    if not target or not os.path.isdir(target):
        return {
            "name": row.skill_name,
            "provider": "local",
            "sourceUri": row.source_uri,
            "installedVersion": row.version,
            "latestVersion": None,
            "installedRef": row.package_hash[:7] if row.package_hash else None,
            "latestRef": None,
            "updateAvailable": False,
            "canAutoUpdate": False,
            "error": "local source directory not found",
        }
    _, cur_hash = compute_files_and_hash(target)
    has_update = bool(row.package_hash and cur_hash != row.package_hash)
    return {
        "name": row.skill_name,
        "provider": "local",
        "sourceUri": row.source_uri,
        "installedVersion": row.version,
        "latestVersion": None,
        "installedRef": row.package_hash[:7] if row.package_hash else None,
        "latestRef": cur_hash[:7],
        "updateAvailable": has_update,
        "canAutoUpdate": True,
        "error": None,
    }


def _check_one_skill(row: SkillRow) -> dict[str, Any]:
    meta = dict(row.upstream_meta or {})
    provider = str(meta.get("provider") or "")
    uri = (row.source_uri or "").strip()

    try:
        if provider == "github" or uri.startswith("github:"):
            return _check_github_skill(row, meta)
        if provider == "npm" or uri.startswith("npm:"):
            return _check_npm_skill(row, meta)
        if row.source_type == "local_folder" or provider == "local":
            return _check_local_skill(row, meta)
        if provider == "http" or uri.startswith(("http://", "https://")):
            return _check_http_skill(row, meta)
        return {
            "name": row.skill_name,
            "provider": provider or row.source_type,
            "sourceUri": row.source_uri,
            "installedVersion": row.version,
            "latestVersion": None,
            "installedRef": row.package_hash[:7] if row.package_hash else None,
            "latestRef": None,
            "updateAvailable": False,
            "canAutoUpdate": False,
            "error": None,
        }
    except Exception as exc:  # noqa: BLE001 — 单条上游失败隔离，不拖垮其它 skill 检测
        return {
            "name": row.skill_name,
            "provider": provider or row.source_type,
            "sourceUri": row.source_uri,
            "installedVersion": row.version,
            "latestVersion": None,
            "installedRef": row.package_hash[:7] if row.package_hash else None,
            "latestRef": None,
            "updateAvailable": False,
            "canAutoUpdate": bool(row.source_uri),
            "error": str(exc),
        }


def check_skill_updates(store: AgentConfigStore, *, force: bool = False) -> dict[str, Any]:
    """检测全部已安装 skill 包（skill_pack / local_folder）是否有可用更新（带 600s TTL 缓存）。"""
    rows = [
        r
        for r in store.list_skills()
        if r.source_type in ("skill_pack", "local_folder") and r.files_json
    ]
    rows.sort(key=lambda r: r.skill_name)
    cache_key = "|".join(
        f"{r.skill_name}:{r.source_type}:{r.source_uri or ''}:{r.version or ''}:{r.package_hash or ''}"
        for r in rows
    )

    now = time.time()
    if not force:
        with _CACHE_LOCK:
            hit = _UPDATE_CACHE.get(cache_key)
            if hit and (now - hit[0]) < _CACHE_TTL_SEC:
                return hit[1]

    if not rows:
        result = {"checkedAt": int(now), "updatesAvailableCount": 0, "skills": []}
    else:
        workers = min(4, len(rows))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            items = list(pool.map(_check_one_skill, rows))
        updates_count = sum(1 for item in items if item.get("updateAvailable"))
        result = {
            "checkedAt": int(time.time()),
            "updatesAvailableCount": updates_count,
            "skills": items,
        }

    with _CACHE_LOCK:
        _UPDATE_CACHE.clear()
        _UPDATE_CACHE[cache_key] = (time.time(), result)
    return result
