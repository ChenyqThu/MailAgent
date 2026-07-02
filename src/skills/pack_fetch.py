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
import uuid
from dataclasses import dataclass
from typing import Optional

import httpx

from src.skills.pack_verify import PackError, safe_copy_tree, safe_extract_zip, verify_content_dir

# ── 下载硬编码合理默认（单本机 owner 工具，不进 config.py）─────────────────────────────────
_DOWNLOAD_TIMEOUT_SEC = 60.0  # 跨所有 redirect 跳的**总**预算
_MAX_PACK_BYTES = 20 * 1024 * 1024  # 20 MiB 硬顶（流式写盘边写边截）
_MAX_REDIRECTS = 5
# content-type 白名单（缺失也放行 —— 很多静态服务器不为 .zip 标 MIME；真实性由 zipfile 解析兜底）。
_PACK_CONTENT_TYPES = frozenset({"application/zip", "application/octet-stream"})
_UA = "MailAgent-SkillFetch/1.0"

_QUARANTINE_TTL_SEC = 24 * 3600  # GC：>24h 的 quarantine 残留清掉
_QUARANTINE_DIRNAME = ".quarantine"
# quarantine_id = <name>-<hash 前 12>；name 是 skill slug，hash 是 12 位 hex。
_QID_RE = re.compile(r"^[a-z][a-z0-9_-]{0,40}-[0-9a-f]{12}$")


@dataclass
class FetchResult:
    """fetch 成功 → 供 owner API 渲染 preview（含 quarantine_id + 服务端算出的事实）。"""

    quarantine_id: str
    manifest_dict: dict
    package_hash: str
    files: dict  # {relpath: sha256}
    skill_md: str  # SKILL.md 全文（端点侧截断）
    source_type: str  # 'skill_pack'（URL）| 'local_folder'（本地）
    source_uri: Optional[str]


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


# ── 下载（SSRF 硬化，复用 ssrf.py 四件套）──────────────────────────────────────────────


def _download_zip(url_str: str, dest_file: str) -> str:
    """下载 zip 到 dest_file（SSRF 硬化 + 钉 IP + 逐跳 redirect 重校验 + 20MiB cap + zip content-type
    + identity 防解压炸弹）。返回跟完 redirect 的最终 URL（source_uri）。SSRF 拦截 raise APIError
    （E_SSRF_BLOCKED，端点原样透传）。

    ``ssrf`` lazy import：``ssrf`` → ``app.APIError`` 会拉起整个 FastAPI app（含 auth import-time
    guard），故只在真正下载时才引入，令 pack_fetch 的本地导入 / confirm / promote 路径可脱离 app 单测。
    """
    from src.api import ssrf

    deadline = time.monotonic() + _DOWNLOAD_TIMEOUT_SEC
    current = ssrf.validate_url(url_str)
    headers = {
        "User-Agent": _UA,
        "Accept": "application/zip,application/octet-stream",
        "Accept-Encoding": "identity",
    }
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
                # content-type：present 则必 ∈ 白名单；absent 放行（真实性由 zipfile 解析兜底）。
                ct = resp.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                if ct and ct not in _PACK_CONTENT_TYPES:
                    raise PackError(
                        "E_CONTENT_TYPE", f"unsupported content-type: {ct}", http_status=415
                    )
                enc = resp.headers.get("content-encoding", "").strip().lower()
                if enc and enc != "identity":
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
                return str(current)
            finally:
                resp.close()
    raise PackError("E_UPSTREAM", f"too many redirects (>{_MAX_REDIRECTS})", http_status=502)


# ── fetch → quarantine ────────────────────────────────────────────────────────────────


def fetch_pack(
    *, source_url: Optional[str] = None, local_path: Optional[str] = None
) -> FetchResult:
    """下载(URL) / 导入(本地 zip 或目录) → quarantine content/ → 安全解包/拷贝 → manifest v2 校验
    + hash。返回 preview 事实（quarantine_id + package_hash + files + manifest + SKILL.md）。

    quarantine 内容**不进 registry / 不执行**；confirm 时按 quarantine_id + hash 提交。"""
    if bool(source_url) == bool(local_path):
        raise PackError("E_INVALID_ARG", "exactly one of source_url / local_path is required")

    gc_quarantine()  # 顺手清残留
    qroot = _quarantine_root()
    os.makedirs(qroot, exist_ok=True)
    tmp_unit = os.path.join(qroot, f".tmp-{uuid.uuid4().hex}")
    content = os.path.join(tmp_unit, "content")
    os.makedirs(content, exist_ok=True)

    try:
        if source_url:
            source_type = "skill_pack"
            zip_path = os.path.join(tmp_unit, "pack.zip")
            source_uri: Optional[str] = _download_zip(source_url, zip_path)
            safe_extract_zip(zip_path, content)
            try:
                os.remove(zip_path)  # zip 不留（content/ 才是包内容）
            except OSError:
                pass
        else:
            assert local_path is not None
            source_uri = os.path.abspath(os.path.expanduser(local_path))
            if os.path.isdir(source_uri):
                source_type = "local_folder"
                safe_copy_tree(source_uri, content)
            elif os.path.isfile(source_uri):
                source_type = "skill_pack"  # 本地 zip 文件也是 pack
                safe_extract_zip(source_uri, content)
            else:
                raise PackError("E_NOT_FOUND", f"local_path not found: {source_uri}")

        vp = verify_content_dir(content)
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
            "files": vp.files,
            "created_at": int(time.time()),
        }
        with open(os.path.join(final_unit, "meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False)

        return FetchResult(
            quarantine_id=qid,
            manifest_dict=vp.manifest_dict,
            package_hash=vp.package_hash,
            files=vp.files,
            skill_md=vp.skill_md,
            source_type=source_type,
            source_uri=source_uri,
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
    return ConfirmResult(
        name=vp.manifest.name,
        source_type=meta.get("source_type", "skill_pack"),
        source_uri=meta.get("source_uri"),
        package_hash=vp.package_hash,
        files=vp.files,
        manifest_dict=vp.manifest_dict,
        manifest_version=str(vp.manifest.manifest_version),
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
