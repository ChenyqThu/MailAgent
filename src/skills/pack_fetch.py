"""Skill 包下载 / 本地导入 → quarantine → confirm 落盘（S2 W2 供应链后端编排）。

流水线（两段式，审批在 gateway/owner API，非本层）：

    fetch(source_url|local_path)                     confirm(quarantine_id, expected_hash, expected_files)
      │ 下载(SSRF 硬化+20MiB) / 本地导入                 │ 重算 quarantine content hash 比对 owner 批准事实
      ▼                                               ▼ (不符 → 409，防 preview→rename 间被替换的 TOCTOU)
    <skills>/.quarantine/<name>-<hash12>/           promote：atomic rename content → <skills>/<name>
        content/  (解包/拷贝的 skill 文件)              (端点在 promote 前落 agent_skills 行)
        meta.json (source_type/source_uri/hash 侧记)

quarantine 内容**绝不**执行 / 进 registry；GC 清 >24h 残留。落盘位置 = ``DATA_ROOT/data/skills/``
（打包 = userData/data/skills，跨重装保留、备份边界与 sync_store 一致）。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import time
import urllib.parse
import uuid
from dataclasses import dataclass
from typing import Any, Optional

import httpx

from src.skills.pack_verify import (
    MANIFEST_FILENAME,
    SKILL_DOC_FILENAME,
    PackError,
    parse_skill_frontmatter,
    safe_copy_tree,
    safe_extract_tar_gz,
    safe_extract_zip,
    sanitize_skill_name,
    verify_content_dir,
)

# ── 下载硬编码合理默认（单本机 owner 工具，不进 config.py）─────────────────────────────────
_DOWNLOAD_TIMEOUT_SEC = 60.0  # 跨所有 redirect 跳的**总**预算
_METADATA_TIMEOUT_SEC = 15.0  # GitHub / npm 元数据 JSON 查询超时
_MAX_PACK_BYTES = 20 * 1024 * 1024  # 20 MiB 硬顶（流式写盘边写边截）
_MAX_METADATA_BYTES = 4 * 1024 * 1024  # 4 MiB JSON 元数据上限
_REPO_ARCHIVE_MAX_ENTRIES = 10_000  # GitHub/npm 全仓库暂存解包上限（选中 skill 拷贝进 content/ 仍受 MAX_ENTRIES=1000 严格限制）
_MAX_REDIRECTS = 5
# content-type 白名单（缺失也放行 —— 很多静态服务器不为 .zip 标 MIME；真实性由 zipfile/tarfile 解析兜底）。
_PACK_CONTENT_TYPES = frozenset({"application/zip", "application/octet-stream"})
_ARCHIVE_CONTENT_TYPES = frozenset(
    {
        "application/zip",
        "application/octet-stream",
        "application/gzip",
        "application/x-gzip",
        "application/x-tar",
        "application/x-tgz",
        "binary/octet-stream",
    }
)
_UA = "MailAgent-SkillFetch/1.0"

_QUARANTINE_TTL_SEC = 24 * 3600  # GC：>24h 的 quarantine 残留清掉
_QUARANTINE_DIRNAME = ".quarantine"
# quarantine_id = <name>-<hash 前 12>；name 是 skill slug，hash 是 12 位 hex。
_QID_RE = re.compile(r"^[a-z][a-z0-9_-]{0,40}-[0-9a-f]{12}$")
_GH_SEGMENT_RE = re.compile(r"^[A-Za-z0-9_.-]+$")


@dataclass(frozen=True)
class ParsedSkillSource:
    """解析后的远程安装源：``github`` / ``npm`` / ``url``。"""

    kind: str  # 'github' | 'npm' | 'url'
    owner: Optional[str] = None
    repo: Optional[str] = None
    ref: Optional[str] = None
    subpath: Optional[str] = None
    package: Optional[str] = None
    spec: Optional[str] = None
    url: Optional[str] = None


@dataclass
class FetchResult:
    """fetch 成功 → 供 owner API 渲染 preview（含 quarantine_id + 服务端算出的事实）。"""

    quarantine_id: str
    manifest_dict: dict
    package_hash: str
    files: dict  # {relpath: sha256}
    skill_md: str  # SKILL.md 全文（端点侧截断）
    source_type: str  # 'skill_pack'（URL/GitHub/npm）| 'local_folder'（本地）
    source_uri: Optional[str]
    upstream_meta: Optional[dict[str, Any]] = None


@dataclass
class ConfirmResult:
    """confirm re-hash 通过 → 供端点落 agent_skills 行的事实。"""

    name: str
    source_type: str
    source_uri: Optional[str]
    package_hash: str
    files: dict
    manifest_dict: dict
    manifest_version: str
    upstream_meta: Optional[dict[str, Any]] = None


# ── 路径 ─────────────────────────────────────────────────────────────────────────────


def skills_data_root() -> str:
    """``DATA_ROOT/data/skills`` 绝对路径。优先 ``MAILAGENT_SKILLS_DIR`` 覆盖（测试/ops），否则
    ``MAILAGENT_DATA_ROOT`` → config.DATA_ROOT → cwd（裸 worktree 兜底，镜像 agent_config 路径纪律）。"""
    override = os.environ.get("MAILAGENT_SKILLS_DIR")
    if override:
        return os.path.abspath(os.path.expanduser(override))
    root = os.environ.get("MAILAGENT_DATA_ROOT")
    if root:
        return os.path.join(os.path.abspath(os.path.expanduser(root)), "data", "skills")
    try:
        from src.config import DATA_ROOT

        return os.path.join(DATA_ROOT, "data", "skills")
    except Exception:  # noqa: BLE001 — 裸 worktree / 缺 .env
        return os.path.join(os.getcwd(), "data", "skills")


def _quarantine_root() -> str:
    return os.path.join(skills_data_root(), _QUARANTINE_DIRNAME)


def skill_dir(name: str) -> str:
    """已安装 skill 的落盘目录（<skills>/<name>）。"""
    return os.path.join(skills_data_root(), name)


def _quarantine_dir(quarantine_id: str) -> str:
    """校验 quarantine_id 安全 → 返回其目录（防路径遍历 + 越界）。"""
    if not _QID_RE.match(quarantine_id):
        raise PackError("E_INVALID_ARG", f"invalid quarantine_id: {quarantine_id!r}")
    root = _quarantine_root()
    d = os.path.join(root, quarantine_id)
    real_root = os.path.realpath(root)
    if not (os.path.realpath(d) == real_root or os.path.realpath(d).startswith(real_root + os.sep)):
        raise PackError("E_INVALID_ARG", "quarantine_id escapes quarantine root")
    return d


# ── 下载（SSRF 硬化，复用 ssrf.py 四件套）+ 源解析 ──────────────────────────────────────


def _clean_subpath(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    cleaned = raw.strip().strip("/")
    if not cleaned:
        return None
    parts = [p for p in cleaned.split("/") if p]
    if any(p in (".", "..") for p in parts):
        raise PackError("E_INVALID_ARG", f"invalid subpath in skill source: {raw!r}")
    return "/".join(parts)


def parse_skill_source(raw: str) -> ParsedSkillSource:
    """把用户输入解析为规范源描述：GitHub（``owner/repo``/URL/``github:...``）、npm（``npm:...``/``@scope/pkg``/npmjs URL）或直链 URL。"""
    s = (raw or "").strip()
    if not s:
        raise PackError("E_INVALID_ARG", "source_url must not be empty")

    # 1) canonical github:owner/repo[@ref][#subpath]
    if s.startswith("github:"):
        rest = s[len("github:") :].strip()
        repo_part, _, frag = rest.partition("#")
        subpath = _clean_subpath(frag)
        ref: Optional[str] = None
        if "@" in repo_part:
            repo_part, ref = repo_part.split("@", 1)
            ref = ref.strip() or None
        segs = [p for p in repo_part.strip("/").split("/") if p]
        if len(segs) < 2:
            raise PackError("E_INVALID_ARG", f"invalid GitHub source: {raw!r}")
        owner, repo = segs[0], segs[1].removesuffix(".git")
        if not (_GH_SEGMENT_RE.match(owner) and _GH_SEGMENT_RE.match(repo)):
            raise PackError("E_INVALID_ARG", f"invalid GitHub owner/repo: {raw!r}")
        extra_sub = _clean_subpath("/".join(segs[2:])) if len(segs) > 2 else None
        return ParsedSkillSource(
            kind="github",
            owner=owner,
            repo=repo,
            ref=ref,
            subpath=subpath or extra_sub,
        )

    # 2) canonical npm:[scope/]pkg[@spec][#subpath]
    if s.startswith("npm:"):
        rest = s[len("npm:") :].strip()
        pkg_part, _, frag = rest.partition("#")
        subpath = _clean_subpath(frag)
        if not pkg_part:
            raise PackError("E_INVALID_ARG", f"invalid npm source: {raw!r}")
        if pkg_part.startswith("@"):
            m = re.match(r"^(@[^/@\s]+/[^/@\s]+)(?:@(.+))?$", pkg_part)
        else:
            m = re.match(r"^([^/@\s]+)(?:@(.+))?$", pkg_part)
        if not m:
            raise PackError("E_INVALID_ARG", f"invalid npm package specifier: {raw!r}")
        pkg_name = m.group(1)
        spec = (m.group(2) or "").strip() or None
        return ParsedSkillSource(kind="npm", package=pkg_name, spec=spec, subpath=subpath)

    # 3) HTTP(S) URL: GitHub repo/tree/blob URL, npmjs package URL, or direct zip/tgz URL
    if s.startswith("http://") or s.startswith("https://"):
        parsed = urllib.parse.urlparse(s)
        host = (parsed.hostname or "").lower()
        frag_sub = _clean_subpath(parsed.fragment)
        if host in ("github.com", "www.github.com"):
            parts = [p for p in parsed.path.strip("/").split("/") if p]
            lower_path = parsed.path.lower()
            is_archive = (
                lower_path.endswith((".zip", ".tgz", ".tar.gz"))
                or (len(parts) >= 3 and parts[2] in ("archive", "releases"))
            )
            if len(parts) >= 2 and not is_archive:
                owner, repo = parts[0], parts[1].removesuffix(".git")
                if _GH_SEGMENT_RE.match(owner) and _GH_SEGMENT_RE.match(repo):
                    ref = None
                    subpath = frag_sub
                    if len(parts) >= 4 and parts[2] in ("tree", "blob"):
                        ref = urllib.parse.unquote(parts[3]) or None
                        tail = "/".join(parts[4:])
                        if parts[2] == "blob" and (tail == SKILL_DOC_FILENAME or tail.endswith("/" + SKILL_DOC_FILENAME)):
                            tail = tail[: -len(SKILL_DOC_FILENAME)].rstrip("/")
                        subpath = _clean_subpath(tail) or subpath
                    return ParsedSkillSource(kind="github", owner=owner, repo=repo, ref=ref, subpath=subpath)
        if host in ("www.npmjs.com", "npmjs.com"):
            parts = [p for p in parsed.path.strip("/").split("/") if p]
            if len(parts) >= 2 and parts[0] == "package":
                if parts[1].startswith("@") and len(parts) >= 3:
                    pkg_name = f"{parts[1]}/{parts[2]}"
                    idx = 3
                else:
                    pkg_name = parts[1]
                    idx = 2
                spec = None
                if len(parts) >= idx + 2 and parts[idx] == "v":
                    spec = urllib.parse.unquote(parts[idx + 1])
                return ParsedSkillSource(kind="npm", package=pkg_name, spec=spec, subpath=frag_sub)
        return ParsedSkillSource(kind="url", url=s, subpath=frag_sub)

    # 4) Scoped npm shorthand: @scope/pkg[@spec][#subpath]
    if s.startswith("@"):
        pkg_part, _, frag = s.partition("#")
        m = re.match(r"^(@[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)(?:@(.+))?$", pkg_part)
        if m:
            return ParsedSkillSource(
                kind="npm",
                package=m.group(1),
                spec=(m.group(2) or "").strip() or None,
                subpath=_clean_subpath(frag),
            )
        raise PackError("E_INVALID_ARG", f"invalid npm package specifier: {raw!r}")

    # 5) GitHub shorthand: owner/repo[/subpath][@ref][#subpath]
    if "://" not in s and not s.startswith(("/", ".", "~")):
        repo_part, _, frag = s.partition("#")
        frag_sub = _clean_subpath(frag)
        ref = None
        if "@" in repo_part:
            repo_part, ref = repo_part.split("@", 1)
            ref = ref.strip() or None
        segs = [p for p in repo_part.strip("/").split("/") if p]
        if len(segs) >= 2:
            owner, repo = segs[0], segs[1].removesuffix(".git")
            if _GH_SEGMENT_RE.match(owner) and _GH_SEGMENT_RE.match(repo):
                extra_sub = _clean_subpath("/".join(segs[2:])) if len(segs) > 2 else None
                return ParsedSkillSource(
                    kind="github",
                    owner=owner,
                    repo=repo,
                    ref=ref,
                    subpath=frag_sub or extra_sub,
                )

    raise PackError(
        "E_INVALID_ARG",
        f"unsupported skill source_url format: {raw!r} (use owner/repo, github URL, npm:pkg, or https://...zip)",
    )


def _http_get_json(url_str: str, *, headers: Optional[dict[str, str]] = None) -> tuple[Any, dict[str, str]]:
    """SSRF-hardened GET JSON（4 MiB 上限）。返回 ``(json_obj, final_headers)``。"""
    import src.api.app  # noqa: F401 — ensure routers finish importing before ssrf to avoid circular import in CLI callers
    from src.api import ssrf

    deadline = time.monotonic() + _METADATA_TIMEOUT_SEC
    current = ssrf.validate_url(url_str)
    req_headers = {
        "User-Agent": _UA,
        "Accept": "application/json",
        "Accept-Encoding": "identity",
    }
    if headers:
        req_headers.update(headers)
    with httpx.Client(trust_env=False, follow_redirects=False) as client:
        for hop in range(_MAX_REDIRECTS + 1):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise PackError("E_UPSTREAM", "upstream metadata request timed out", http_status=504)
            host, port, _scheme = ssrf.host_port_scheme(current)
            pinned_ip = ssrf.resolve_and_validate(host, port)
            try:
                resp = ssrf.pinned_send(client, current, pinned_ip, req_headers, remaining, stream=True)
            except httpx.HTTPError as e:
                raise PackError("E_UPSTREAM", f"upstream metadata request failed: {e}", http_status=502) from e
            try:
                if resp.status_code in (301, 302, 303, 307, 308):
                    loc = resp.headers.get("location")
                    if not loc or hop >= _MAX_REDIRECTS:
                        raise PackError("E_UPSTREAM", "metadata redirect failed", http_status=502)
                    current = ssrf.validate_url(str(current.join(loc)))
                    continue
                if resp.status_code != 200:
                    raise PackError(
                        "E_UPSTREAM",
                        f"upstream metadata returned {resp.status_code}",
                        http_status=404 if resp.status_code == 404 else 502,
                    )
                chunks: list[bytes] = []
                total = 0
                for chunk in resp.iter_bytes():
                    if time.monotonic() > deadline:
                        raise PackError("E_UPSTREAM", "upstream metadata timed out", http_status=504)
                    total += len(chunk)
                    if total > _MAX_METADATA_BYTES:
                        raise PackError("E_PACK_TOO_LARGE", "upstream metadata exceeds 4 MiB", http_status=413)
                    chunks.append(chunk)
                try:
                    data = json.loads(b"".join(chunks).decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as e:
                    raise PackError("E_UPSTREAM", f"invalid JSON from upstream: {e}", http_status=502) from e
                hdrs = {k.lower(): v for k, v in resp.headers.items()}
                return data, hdrs
            finally:
                resp.close()
    raise PackError("E_UPSTREAM", f"too many redirects (>{_MAX_REDIRECTS})", http_status=502)


def _download_archive(
    url_str: str,
    dest_file: str,
    *,
    allowed_content_types: frozenset[str] = _PACK_CONTENT_TYPES,
    extra_headers: Optional[dict[str, str]] = None,
) -> tuple[str, dict[str, str]]:
    """SSRF 硬化流式下载归档（zip/tgz）到 dest_file。返回 ``(final_url, header_meta)``。"""
    import src.api.app  # noqa: F401
    from src.api import ssrf

    deadline = time.monotonic() + _DOWNLOAD_TIMEOUT_SEC
    current = ssrf.validate_url(url_str)
    headers = {
        "User-Agent": _UA,
        "Accept": "application/zip,application/gzip,application/x-gzip,application/octet-stream",
        "Accept-Encoding": "identity",
    }
    if extra_headers:
        headers.update(extra_headers)
    with httpx.Client(trust_env=False, follow_redirects=False) as client:
        for hop in range(_MAX_REDIRECTS + 1):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise PackError("E_UPSTREAM", "pack download timed out", http_status=504)
            host, port, _scheme = ssrf.host_port_scheme(current)
            pinned_ip = ssrf.resolve_and_validate(host, port)  # 逐 IP 校验 + 钉死（rebinding 关）
            try:
                resp = ssrf.pinned_send(client, current, pinned_ip, headers, remaining, stream=True)
            except httpx.HTTPError as e:
                raise PackError("E_UPSTREAM", f"pack download failed: {e}", http_status=502) from e
            try:
                if resp.status_code in (301, 302, 303, 307, 308):
                    loc = resp.headers.get("location")
                    if not loc:
                        raise PackError("E_UPSTREAM", "redirect without Location", http_status=502)
                    if hop >= _MAX_REDIRECTS:
                        raise PackError(
                            "E_UPSTREAM", f"too many redirects (>{_MAX_REDIRECTS})", http_status=502
                        )
                    current = ssrf.validate_url(str(current.join(loc)))  # 下一跳重校验
                    continue
                if resp.status_code != 200:
                    raise PackError(
                        "E_UPSTREAM", f"pack download returned {resp.status_code}", http_status=502
                    )
                # content-type：present 则必 ∈ 白名单；absent 放行（真实性由归档解析兜底）。
                ct = resp.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                if ct and ct not in allowed_content_types:
                    raise PackError(
                        "E_CONTENT_TYPE", f"unsupported content-type: {ct}", http_status=415
                    )
                enc = resp.headers.get("content-encoding", "").strip().lower()
                if enc and enc not in ("identity", "gzip"):
                    # 部分 CDN 会为 .tgz/.tar.gz 附带 content-encoding，仅非 zip 场景容忍 identity/gzip
                    raise PackError(
                        "E_UPSTREAM", f"unexpected content-encoding: {enc}", http_status=502
                    )
                total = 0
                with open(dest_file, "wb") as out:
                    for chunk in resp.iter_bytes():
                        if time.monotonic() > deadline:
                            raise PackError(
                                "E_UPSTREAM", "pack download timed out", http_status=504
                            )
                        total += len(chunk)
                        if total > _MAX_PACK_BYTES:
                            raise PackError(
                                "E_PACK_TOO_LARGE",
                                f"pack exceeds {_MAX_PACK_BYTES} bytes",
                                http_status=413,
                            )
                        out.write(chunk)
                meta_hdrs: dict[str, str] = {}
                if resp.headers.get("etag"):
                    meta_hdrs["etag"] = resp.headers["etag"]
                if resp.headers.get("last-modified"):
                    meta_hdrs["last_modified"] = resp.headers["last-modified"]
                if ct:
                    meta_hdrs["content_type"] = ct
                return str(current), meta_hdrs
            finally:
                resp.close()
    raise PackError("E_UPSTREAM", f"too many redirects (>{_MAX_REDIRECTS})", http_status=502)


def _download_zip(url_str: str, dest_file: str) -> str:
    """下载 zip 到 dest_file（向后兼容旧签名，内部复用 ``_download_archive``）。"""
    final_url, _ = _download_archive(url_str, dest_file, allowed_content_types=_PACK_CONTENT_TYPES)
    return final_url


# ── skill 目录发现 + 多包选择 ───────────────────────────────────────────────────────────


def _has_skill_marker(directory: str) -> bool:
    return os.path.isfile(os.path.join(directory, MANIFEST_FILENAME)) or os.path.isfile(
        os.path.join(directory, SKILL_DOC_FILENAME)
    )


def _candidate_slug(directory: str) -> Optional[str]:
    mpath = os.path.join(directory, MANIFEST_FILENAME)
    if os.path.isfile(mpath):
        try:
            with open(mpath, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and isinstance(data.get("name"), str):
                slug = sanitize_skill_name(data["name"])
                if slug:
                    return slug
        except Exception:  # noqa: BLE001
            pass
    smpath = os.path.join(directory, SKILL_DOC_FILENAME)
    if os.path.isfile(smpath):
        try:
            with open(smpath, "r", encoding="utf-8", errors="replace") as f:
                fm = parse_skill_frontmatter(f.read())
            if isinstance(fm.get("name"), str):
                slug = sanitize_skill_name(fm["name"])
                if slug:
                    return slug
        except OSError:
            pass
    return sanitize_skill_name(os.path.basename(os.path.abspath(directory)))


def _discover_skill_candidates(root_dir: str, subpath: Optional[str]) -> list[tuple[str, str]]:
    """在已解包根目录里发现可用 skill：``[(rel_subpath, skill_name), ...]``。"""
    base_real = os.path.realpath(root_dir)
    if subpath:
        sub = _clean_subpath(subpath)
        assert sub is not None
        cand = os.path.join(root_dir, sub)
        cand_real = os.path.realpath(cand)
        if not (cand_real == base_real or cand_real.startswith(base_real + os.sep)) or not os.path.isdir(cand):
            raise PackError("E_NOT_FOUND", f"skill subpath not found: {sub}", http_status=404)
        if not _has_skill_marker(cand):
            raise PackError("E_PACK_NO_MANIFEST", f"no {MANIFEST_FILENAME} or {SKILL_DOC_FILENAME} at {sub}")
        slug = _candidate_slug(cand)
        if not slug:
            raise PackError("E_PACK_BAD_MANIFEST", f"cannot derive valid skill name from {sub}")
        return [(sub, slug)]

    found: list[tuple[str, str]] = []
    seen_names: set[str] = set()
    search_roots = [".", "skills", ".agents/skills", ".claude/skills"]
    for prefix in search_roots:
        if prefix == ".":
            if _has_skill_marker(root_dir):
                slug = _candidate_slug(root_dir)
                if slug and slug not in seen_names:
                    seen_names.add(slug)
                    found.append((".", slug))
            continue
        pdir = os.path.join(root_dir, prefix)
        if not os.path.isdir(pdir) or os.path.islink(pdir):
            continue
        for child in sorted(os.listdir(pdir)):
            cdir = os.path.join(pdir, child)
            if os.path.islink(cdir) or not os.path.isdir(cdir):
                continue
            if _has_skill_marker(cdir):
                slug = _candidate_slug(cdir)
                if slug and slug not in seen_names:
                    seen_names.add(slug)
                    found.append((f"{prefix}/{child}", slug))
    return found


def _select_candidate(
    root_dir: str, subpath: Optional[str], skill_name: Optional[str]
) -> tuple[str, Optional[str]]:
    """选定单个 skill 目录 ``(abs_dir, selected_rel_subpath_or_none)``。多 skill 时抛 ``E_PACK_MULTIPLE_SKILLS``。"""
    candidates = _discover_skill_candidates(root_dir, subpath)
    if not candidates:
        raise PackError("E_PACK_NO_MANIFEST", f"{MANIFEST_FILENAME} not found in package")

    if len(candidates) == 1:
        rel_sub, cand_slug = candidates[0]
        if skill_name:
            want = sanitize_skill_name(skill_name) or skill_name.strip().lower()
            base_slug = sanitize_skill_name(os.path.basename(rel_sub)) if rel_sub != "." else cand_slug
            if want not in (cand_slug, base_slug):
                raise PackError(
                    "E_NOT_FOUND",
                    f"skill {skill_name!r} not found in package (found {cand_slug!r})",
                    http_status=404,
                )
        target = root_dir if rel_sub == "." else os.path.join(root_dir, rel_sub)
        return target, (None if rel_sub == "." else rel_sub)

    names = [slug for _, slug in candidates]
    if not skill_name:
        raise PackError(
            "E_PACK_MULTIPLE_SKILLS",
            f"multiple skills found in package ({', '.join(names)}); please select one",
            http_status=400,
            details={"availableSkills": names},
        )
    want = sanitize_skill_name(skill_name) or skill_name.strip().lower()
    for rel_sub, slug in candidates:
        base_slug = sanitize_skill_name(os.path.basename(rel_sub)) if rel_sub != "." else slug
        if want in (slug, base_slug):
            target = root_dir if rel_sub == "." else os.path.join(root_dir, rel_sub)
            return target, (None if rel_sub == "." else rel_sub)
    raise PackError(
        "E_NOT_FOUND",
        f"skill {skill_name!r} not found; available: {', '.join(names)}",
        http_status=404,
        details={"availableSkills": names},
    )


def _read_package_json_version(directory: str) -> Optional[str]:
    p = os.path.join(directory, "package.json")
    if not os.path.isfile(p) or os.path.islink(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("version"), str) and data["version"].strip():
            return data["version"].strip()
    except (OSError, json.JSONDecodeError):
        pass
    return None


def _skill_md_has_explicit_version(skill_dir_path: str) -> bool:
    if os.path.isfile(os.path.join(skill_dir_path, MANIFEST_FILENAME)):
        return True
    smpath = os.path.join(skill_dir_path, SKILL_DOC_FILENAME)
    if not os.path.isfile(smpath):
        return False
    try:
        with open(smpath, "r", encoding="utf-8", errors="replace") as f:
            fm = parse_skill_frontmatter(f.read())
        meta = fm.get("metadata") if isinstance(fm.get("metadata"), dict) else {}
        return bool(fm.get("version") or meta.get("version"))
    except OSError:
        return False


def _is_tgz_archive(file_path: str, content_type: Optional[str] = None) -> bool:
    low = file_path.lower()
    if low.endswith((".tgz", ".tar.gz")):
        return True
    if content_type and any(tok in content_type for tok in ("gzip", "x-tar", "x-tgz")):
        return True
    try:
        with open(file_path, "rb") as f:
            return f.read(2) == b"\x1f\x8b"
    except OSError:
        return False


# ── fetch → quarantine ────────────────────────────────────────────────────────────────


def _fetch_github(
    src: ParsedSkillSource,
    tmp_unit: str,
    content: str,
    *,
    skill_name: Optional[str] = None,
) -> tuple[str, dict[str, Any], Optional[str]]:
    assert src.owner and src.repo
    owner, repo = src.owner, src.repo
    gh_headers = {"Accept": "application/vnd.github+json"}

    ref = src.ref
    if not ref:
        try:
            repo_meta, _ = _http_get_json(f"https://api.github.com/repos/{owner}/{repo}", headers=gh_headers)
            if isinstance(repo_meta, dict) and isinstance(repo_meta.get("default_branch"), str):
                ref = repo_meta["default_branch"].strip() or "main"
        except PackError as exc:
            if exc.http_status == 404:
                raise
            ref = "main"
    ref = ref or "main"

    zip_url = f"https://api.github.com/repos/{owner}/{repo}/zipball/{urllib.parse.quote(ref, safe='')}"
    zip_path = os.path.join(tmp_unit, "github.zip")
    archive_dir = os.path.join(tmp_unit, "archive")
    os.makedirs(archive_dir, exist_ok=True)
    _download_archive(zip_url, zip_path, allowed_content_types=_ARCHIVE_CONTENT_TYPES, extra_headers=gh_headers)
    top_dir = safe_extract_zip(zip_path, archive_dir, strip_top_dir=True, max_entries=_REPO_ARCHIVE_MAX_ENTRIES)
    try:
        os.remove(zip_path)
    except OSError:
        pass

    cand_dir, selected_subpath = _select_candidate(archive_dir, src.subpath, skill_name)
    safe_copy_tree(cand_dir, content)

    # 尝试解析与 update_check 对齐的 latest commit sha（回退 zipball 目录末尾 short sha）
    commit_sha: Optional[str] = None
    commit_query = f"https://api.github.com/repos/{owner}/{repo}/commits?sha={urllib.parse.quote(ref, safe='')}&per_page=1"
    if selected_subpath:
        commit_query += f"&path={urllib.parse.quote(selected_subpath, safe='/')}"
    try:
        commits, _ = _http_get_json(commit_query, headers=gh_headers)
        if isinstance(commits, list) and commits and isinstance(commits[0], dict):
            sha_val = commits[0].get("sha")
            if isinstance(sha_val, str) and sha_val:
                commit_sha = sha_val
    except PackError:
        pass
    if not commit_sha and top_dir and "-" in top_dir:
        tail = top_dir.rsplit("-", 1)[-1]
        if re.fullmatch(r"[0-9a-f]{7,40}", tail):
            commit_sha = tail

    pkg_version = _read_package_json_version(cand_dir) or _read_package_json_version(archive_dir)
    if _skill_md_has_explicit_version(content):
        resolved_version = None
    else:
        resolved_version = pkg_version

    canonical_uri = f"github:{owner}/{repo}@{ref}" + (f"#{selected_subpath}" if selected_subpath else "")
    upstream_meta: dict[str, Any] = {
        "provider": "github",
        "owner": owner,
        "repo": repo,
        "ref": ref,
        "subpath": selected_subpath,
        "commit_sha": commit_sha,
    }
    if resolved_version or pkg_version:
        upstream_meta["version"] = resolved_version or pkg_version
    return canonical_uri, upstream_meta, resolved_version


def _fetch_npm(
    src: ParsedSkillSource,
    tmp_unit: str,
    content: str,
    *,
    skill_name: Optional[str] = None,
) -> tuple[str, dict[str, Any], Optional[str]]:
    assert src.package
    pkg_name = src.package
    encoded_pkg = urllib.parse.quote(pkg_name, safe="")
    meta, _ = _http_get_json(f"https://registry.npmjs.org/{encoded_pkg}")
    if not isinstance(meta, dict):
        raise PackError("E_UPSTREAM", f"unexpected npm registry payload for {pkg_name}", http_status=502)

    spec = src.spec or "latest"
    dist_tags = meta.get("dist-tags") if isinstance(meta.get("dist-tags"), dict) else {}
    versions_map = meta.get("versions") if isinstance(meta.get("versions"), dict) else {}
    target_version = dist_tags.get(spec) if spec in dist_tags else spec
    ver_obj = versions_map.get(target_version) if isinstance(target_version, str) else None
    if not isinstance(ver_obj, dict):
        raise PackError(
            "E_NOT_FOUND", f"npm version {spec!r} not found for package {pkg_name}", http_status=404
        )
    dist = ver_obj.get("dist") if isinstance(ver_obj.get("dist"), dict) else {}
    tarball_url = dist.get("tarball")
    if not isinstance(tarball_url, str) or not tarball_url:
        raise PackError("E_UPSTREAM", f"npm package {pkg_name}@{target_version} has no tarball", http_status=502)

    tgz_path = os.path.join(tmp_unit, "npm.tgz")
    archive_dir = os.path.join(tmp_unit, "archive")
    os.makedirs(archive_dir, exist_ok=True)
    _download_archive(tarball_url, tgz_path, allowed_content_types=_ARCHIVE_CONTENT_TYPES)
    safe_extract_tar_gz(tgz_path, archive_dir, strip_top_dir=True, max_entries=_REPO_ARCHIVE_MAX_ENTRIES)
    try:
        os.remove(tgz_path)
    except OSError:
        pass

    cand_dir, selected_subpath = _select_candidate(archive_dir, src.subpath, skill_name)
    safe_copy_tree(cand_dir, content)

    is_pinned = bool(src.spec and src.spec not in dist_tags)
    uri_spec = f"@{src.spec}" if is_pinned else ""
    canonical_uri = f"npm:{pkg_name}{uri_spec}" + (f"#{selected_subpath}" if selected_subpath else "")
    upstream_meta: dict[str, Any] = {
        "provider": "npm",
        "package": pkg_name,
        "spec": src.spec or "latest",
        "version": str(target_version),
        "subpath": selected_subpath,
    }
    if isinstance(dist.get("integrity"), str):
        upstream_meta["integrity"] = dist["integrity"]
    resolved_version = None if _skill_md_has_explicit_version(content) else str(target_version)
    return canonical_uri, upstream_meta, resolved_version


def fetch_pack(
    *,
    source_url: Optional[str] = None,
    local_path: Optional[str] = None,
    skill_name: Optional[str] = None,
) -> FetchResult:
    """下载(GitHub/npm/URL) / 导入(本地 zip/tgz/目录) → quarantine content/ → manifest v2 校验
    + hash。返回 preview 事实（quarantine_id + package_hash + files + manifest + SKILL.md）。"""
    if bool(source_url) == bool(local_path):
        raise PackError("E_INVALID_ARG", "exactly one of source_url / local_path is required")

    gc_quarantine()  # 顺手清残留
    qroot = _quarantine_root()
    os.makedirs(qroot, exist_ok=True)
    tmp_unit = os.path.join(qroot, f".tmp-{uuid.uuid4().hex}")
    content = os.path.join(tmp_unit, "content")
    os.makedirs(content, exist_ok=True)

    upstream_meta: Optional[dict[str, Any]] = None
    version_override: Optional[str] = None

    try:
        if source_url:
            source_type = "skill_pack"
            parsed = parse_skill_source(source_url)
            if parsed.kind == "github":
                source_uri, upstream_meta, version_override = _fetch_github(
                    parsed, tmp_unit, content, skill_name=skill_name
                )
            elif parsed.kind == "npm":
                source_uri, upstream_meta, version_override = _fetch_npm(
                    parsed, tmp_unit, content, skill_name=skill_name
                )
            else:
                assert parsed.url is not None
                dl_path = os.path.join(tmp_unit, "pack.archive")
                source_uri, hdrs = _download_archive(
                    parsed.url, dl_path, allowed_content_types=_ARCHIVE_CONTENT_TYPES
                )
                archive_dir = os.path.join(tmp_unit, "archive")
                os.makedirs(archive_dir, exist_ok=True)
                url_path_low = urllib.parse.urlparse(parsed.url).path.lower()
                is_tgz = url_path_low.endswith((".tgz", ".tar.gz")) or _is_tgz_archive(
                    dl_path, hdrs.get("content_type")
                )
                if is_tgz:
                    safe_extract_tar_gz(dl_path, archive_dir, strip_top_dir=False)
                else:
                    safe_extract_zip(dl_path, archive_dir, strip_top_dir=False)
                try:
                    os.remove(dl_path)
                except OSError:
                    pass
                # 兼容根级直接含 manifest.json/SKILL.md，也支持单顶层目录或 skills/* 仓库归档
                if _has_skill_marker(archive_dir) and not parsed.subpath and not skill_name:
                    safe_copy_tree(archive_dir, content)
                else:
                    top_entries = [
                        e for e in os.listdir(archive_dir) if not e.startswith(".")
                    ]
                    search_root = archive_dir
                    if (
                        len(top_entries) == 1
                        and os.path.isdir(os.path.join(archive_dir, top_entries[0]))
                        and not _has_skill_marker(archive_dir)
                    ):
                        search_root = os.path.join(archive_dir, top_entries[0])
                    cand_dir, _ = _select_candidate(search_root, parsed.subpath, skill_name)
                    safe_copy_tree(cand_dir, content)
                upstream_meta = {"provider": "http", "url": source_uri}
                if hdrs.get("etag"):
                    upstream_meta["etag"] = hdrs["etag"]
                if hdrs.get("last_modified"):
                    upstream_meta["last_modified"] = hdrs["last_modified"]
        else:
            assert local_path is not None
            raw_local = os.path.abspath(os.path.expanduser(local_path))
            if os.path.isdir(raw_local):
                source_type = "local_folder"
                if _has_skill_marker(raw_local) and not skill_name:
                    source_uri = raw_local
                    safe_copy_tree(raw_local, content)
                    selected_subpath = None
                else:
                    cand_dir, selected_subpath = _select_candidate(raw_local, None, skill_name)
                    source_uri = raw_local
                    safe_copy_tree(cand_dir, content)
                upstream_meta = {
                    "provider": "local",
                    "path": raw_local,
                    **({"subpath": selected_subpath} if selected_subpath else {}),
                }
            elif os.path.isfile(raw_local):
                source_type = "skill_pack"
                source_uri = raw_local
                archive_dir = os.path.join(tmp_unit, "archive")
                os.makedirs(archive_dir, exist_ok=True)
                if _is_tgz_archive(raw_local):
                    safe_extract_tar_gz(raw_local, archive_dir, strip_top_dir=False)
                else:
                    safe_extract_zip(raw_local, archive_dir, strip_top_dir=False)
                if _has_skill_marker(archive_dir) and not skill_name:
                    safe_copy_tree(archive_dir, content)
                else:
                    cand_dir, _ = _select_candidate(archive_dir, None, skill_name)
                    safe_copy_tree(cand_dir, content)
                upstream_meta = {"provider": "local_archive", "path": raw_local}
            else:
                raise PackError("E_NOT_FOUND", f"local_path not found: {raw_local}")

        vp = verify_content_dir(content)
        manifest_dict = dict(vp.manifest_dict)
        if version_override:
            manifest_dict["version"] = version_override
        if upstream_meta is not None and not upstream_meta.get("version"):
            upstream_meta["version"] = str(manifest_dict.get("version") or vp.manifest.version)

        qid = f"{vp.manifest.name}-{vp.package_hash[:12]}"
        if not _QID_RE.match(qid):  # name 已过 pydantic，但 belt-and-suspenders
            raise PackError("E_PACK_BAD_MANIFEST", f"manifest name yields unsafe id: {qid!r}")

        final_unit = os.path.join(qroot, qid)
        if os.path.exists(final_unit):
            shutil.rmtree(final_unit, ignore_errors=True)  # 同内容重取 → 覆盖旧 quarantine
        os.rename(tmp_unit, final_unit)
        tmp_unit = final_unit  # 后续失败清理指向新名

        meta = {
            "name": vp.manifest.name,
            "source_type": source_type,
            "source_uri": source_uri,
            "package_hash": vp.package_hash,
            "manifest_version": vp.manifest.manifest_version,
            "manifest_dict": manifest_dict,
            "files": vp.files,
            "upstream_meta": upstream_meta,
            "created_at": int(time.time()),
        }
        with open(os.path.join(final_unit, "meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False)

        return FetchResult(
            quarantine_id=qid,
            manifest_dict=manifest_dict,
            package_hash=vp.package_hash,
            files=vp.files,
            skill_md=vp.skill_md,
            source_type=source_type,
            source_uri=source_uri,
            upstream_meta=upstream_meta,
        )
    except BaseException:
        shutil.rmtree(tmp_unit, ignore_errors=True)  # 任何失败不留半成品 quarantine
        raise


# ── confirm（re-hash 比对）+ promote（atomic rename）─────────────────────────────────────


def confirm_pack(
    quarantine_id: str, expected_package_hash: str, expected_files: Optional[dict] = None
) -> ConfirmResult:
    """**重算** quarantine content 的 hash（不信 meta 缓存）比对 owner 批准的事实（TOCTOU：堵
    preview 渲染 → promote 间被本机其它进程替换）。不符 → E_PACK_HASH_MISMATCH(409)。**不落库、不
    swap**（端点在此后落行、再 promote）—— 纯校验。"""
    qdir = _quarantine_dir(quarantine_id)
    content = os.path.join(qdir, "content")
    if not os.path.isdir(content):
        raise PackError("E_NOT_FOUND", f"quarantine not found: {quarantine_id}", http_status=404)

    vp = verify_content_dir(content)  # 重算 —— 与 fetch preview 同一算法
    if vp.package_hash != expected_package_hash:
        raise PackError(
            "E_PACK_HASH_MISMATCH",
            "package hash changed since preview (quarantine tampered?)",
            http_status=409,
        )
    if expected_files is not None and vp.files != expected_files:
        raise PackError(
            "E_PACK_HASH_MISMATCH",
            "per-file hashes changed since preview (quarantine tampered?)",
            http_status=409,
        )

    meta = _read_meta(qdir)
    stored_manifest = meta.get("manifest_dict") if isinstance(meta.get("manifest_dict"), dict) else None
    manifest_dict = stored_manifest if stored_manifest else vp.manifest_dict
    upstream_meta = meta.get("upstream_meta") if isinstance(meta.get("upstream_meta"), dict) else None
    return ConfirmResult(
        name=vp.manifest.name,
        source_type=meta.get("source_type", "skill_pack"),
        source_uri=meta.get("source_uri"),
        package_hash=vp.package_hash,
        files=vp.files,
        manifest_dict=manifest_dict,
        manifest_version=str(vp.manifest.manifest_version),
        upstream_meta=upstream_meta,
    )


def promote_content(quarantine_id: str, name: str) -> str:
    """把 quarantine content atomic 换到 ``<skills>/<name>``（同名升级：临时名两步交换，失败回滚 →
    不留半成品）。端点在**落 agent_skills 行之后**调用。返回最终 skill 目录。"""
    qdir = _quarantine_dir(quarantine_id)
    content = os.path.join(qdir, "content")
    if not os.path.isdir(content):
        raise PackError("E_NOT_FOUND", f"quarantine content missing: {quarantine_id}", http_status=404)

    root = skills_data_root()
    os.makedirs(root, exist_ok=True)
    target = os.path.join(root, name)
    stamp = int(time.time() * 1000)
    staging = os.path.join(root, f".incoming-{name}-{stamp}")
    trash = os.path.join(root, f".trash-{name}-{stamp}")

    os.rename(content, staging)  # atomic 移出 quarantine（同一文件系统）
    moved_old = False
    try:
        if os.path.exists(target):
            os.rename(target, trash)  # 旧版本先挪走（升级）
            moved_old = True
        os.rename(staging, target)  # 新版本就位
    except BaseException:
        # 回滚：新版退回 quarantine content，旧版恢复。
        if os.path.exists(staging):
            os.rename(staging, content)
        if moved_old and not os.path.exists(target) and os.path.exists(trash):
            os.rename(trash, target)
        raise
    shutil.rmtree(trash, ignore_errors=True)
    shutil.rmtree(qdir, ignore_errors=True)  # 装成功即清 quarantine
    return target


# ── uninstall + GC ────────────────────────────────────────────────────────────────────


def remove_skill_dir(name: str) -> bool:
    """删已安装 skill 的落盘目录（幂等：不存在返回 False）。"""
    d = skill_dir(name)
    if os.path.isdir(d):
        shutil.rmtree(d, ignore_errors=True)
        return True
    return False


def gc_quarantine(*, ttl_sec: int = _QUARANTINE_TTL_SEC) -> int:
    """清 quarantine 里 >ttl 的残留单元 + skills 根的 .incoming-/.trash- 中间态。返回清理数。"""
    removed = 0
    root = skills_data_root()
    qroot = _quarantine_root()
    now = time.time()
    if os.path.isdir(qroot):
        for entry in os.listdir(qroot):
            path = os.path.join(qroot, entry)
            if not os.path.isdir(path):
                continue
            try:
                age = now - os.path.getmtime(path)
            except OSError:
                age = ttl_sec + 1
            if entry.startswith(".tmp-") or age > ttl_sec:
                shutil.rmtree(path, ignore_errors=True)
                removed += 1
    if os.path.isdir(root):
        for entry in os.listdir(root):
            if entry.startswith(".incoming-") or entry.startswith(".trash-"):
                path = os.path.join(root, entry)
                try:
                    age = now - os.path.getmtime(path)
                except OSError:
                    age = ttl_sec + 1
                if age > ttl_sec:
                    shutil.rmtree(path, ignore_errors=True)
                    removed += 1
    return removed


def _read_meta(qdir: str) -> dict:
    mpath = os.path.join(qdir, "meta.json")
    try:
        with open(mpath, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}
