"""Skill 包安全解包 + manifest v2 校验 + hash（S2 W2 供应链后端）。

``pack_fetch`` 把包下载/导入到 quarantine 后，本模块负责：
  - **安全解包**（zip-slip / 绝对路径 / symlink / hardlink / zip 炸弹防护），落盘后 realpath 复核无越界；
  - **manifest v2 校验**（``SkillPackageManifest``：type=script⇒tools==[]、secret 名 reserved deny）；
  - **逐文件 sha256**（``files_json``）+ **内容派生 package_hash**（确定性、**可重算** —— confirm
    时重算此值比对 owner 批准的事实，堵「preview 渲染 → atomic rename」间被本机其它进程替换的 TOCTOU）。

quarantine 内容**绝不**被加载 / 执行 / 进 registry（deny 地板由 ADR-001 W1 exec 端点覆盖）。
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import zipfile
from dataclasses import dataclass

from pydantic import ValidationError

from src.skills.models import SkillPackageManifest

# ── 解包硬上限（zip 炸弹防护）─────────────────────────────────────────────────────────
MAX_ENTRIES = 1000
MAX_TOTAL_UNCOMPRESSED = 100 * 1024 * 1024  # 100 MiB
_READ_CHUNK = 64 * 1024

MANIFEST_FILENAME = "manifest.json"
SKILL_DOC_FILENAME = "SKILL.md"


class PackError(Exception):
    """skill 包域错误（结构化 code + http_status 供端点透传）。"""

    def __init__(self, code: str, message: str, *, http_status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status


@dataclass
class VerifiedPack:
    """校验通过的 content 目录事实（preview 渲染 + confirm re-hash + 落库的真源）。"""

    manifest: SkillPackageManifest
    manifest_dict: dict  # 原始 manifest.json 解析（落 agent_skills.manifest_json）
    package_hash: str  # 内容派生（确定性、可重算）
    files: dict  # {relpath(posix): sha256}
    skill_md: str  # SKILL.md 全文（截断在端点侧做）


# ── 路径安全 ─────────────────────────────────────────────────────────────────────────


def _is_within(base: str, target: str) -> bool:
    """target 的 realpath 是否落在 base 的 realpath 内（含边界分隔符，防 /foo 匹配 /foobar）。"""
    base_r = os.path.realpath(base)
    tgt_r = os.path.realpath(target)
    return tgt_r == base_r or tgt_r.startswith(base_r + os.sep)


def _assert_no_escape(content_dir: str) -> None:
    """落盘后复核：目录内每个真实文件/子目录的 realpath 都未越出 content_dir（双保险）。"""
    for root, dirs, files in os.walk(content_dir):
        for name in list(dirs) + files:
            p = os.path.join(root, name)
            if os.path.islink(p):
                raise PackError("E_PACK_SYMLINK", f"symlink present after unpack: {name!r}")
            if not _is_within(content_dir, p):
                raise PackError("E_PACK_UNSAFE_PATH", f"member escapes package dir: {name!r}")


def _reject_member_path(name: str, dest_dir: str) -> str:
    """校验一个归档成员相对路径安全，返回落盘绝对路径；越界/绝对/traversal → PackError。"""
    if not name or name in (".", ".."):
        raise PackError("E_PACK_UNSAFE_PATH", f"invalid member name: {name!r}")
    # 绝对路径 / 盘符（Windows）/ 反斜杠绝对。
    if name.startswith("/") or name.startswith("\\") or (len(name) > 1 and name[1] == ":"):
        raise PackError("E_PACK_UNSAFE_PATH", f"absolute path member: {name!r}")
    norm = os.path.normpath(name)
    if norm.startswith("..") or os.path.isabs(norm) or (os.sep + "..") in (os.sep + norm):
        raise PackError("E_PACK_UNSAFE_PATH", f"path traversal member: {name!r}")
    target = os.path.join(dest_dir, norm)
    if not _is_within(dest_dir, target):
        raise PackError("E_PACK_UNSAFE_PATH", f"member escapes dest: {name!r}")
    return target


# ── 安全解包（zip）────────────────────────────────────────────────────────────────────


def safe_extract_zip(zip_path: str, dest_dir: str) -> None:
    """把 zip 安全解到 dest_dir（应为空/新建）。拒绝：绝对/traversal 成员、symlink/hardlink 成员、
    entry 超限、解压总量超限（炸弹，边写边累计不信 header file_size）。落盘后 realpath 复核。"""
    try:
        zf = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile as e:
        raise PackError("E_PACK_BAD_ZIP", f"not a valid zip archive: {e}") from e
    with zf:
        infos = zf.infolist()
        if len(infos) > MAX_ENTRIES:
            raise PackError(
                "E_PACK_TOO_MANY_ENTRIES", f"archive has {len(infos)} entries (> {MAX_ENTRIES})"
            )
        total = 0
        for info in infos:
            name = info.filename
            # symlink 成员：zip external_attr 高 16 位 = unix st_mode（S_IFLNK 即 symlink）。
            mode = (info.external_attr >> 16) & 0xFFFF
            if mode and stat.S_ISLNK(mode):
                raise PackError("E_PACK_SYMLINK", f"symlink member not allowed: {name!r}")
            if info.is_dir():
                target = _reject_member_path(name.rstrip("/"), dest_dir)
                os.makedirs(target, exist_ok=True)
                continue
            target = _reject_member_path(name, dest_dir)
            parent = os.path.dirname(target)
            if parent:
                os.makedirs(parent, exist_ok=True)
            # 流式解压，边写边累计总量（不信 info.file_size —— zip header 可撒谎）。
            with zf.open(info, "r") as src, open(target, "wb") as out:
                while True:
                    chunk = src.read(_READ_CHUNK)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_TOTAL_UNCOMPRESSED:
                        raise PackError(
                            "E_PACK_BOMB",
                            f"uncompressed size exceeds {MAX_TOTAL_UNCOMPRESSED} bytes (zip bomb?)",
                        )
                    out.write(chunk)
    _assert_no_escape(dest_dir)


# ── 安全导入（本地目录）────────────────────────────────────────────────────────────────


def safe_copy_tree(src_dir: str, dest_dir: str) -> None:
    """把本地目录安全拷进 dest_dir。拒绝 symlink（文件或目录）成员 + entry/总量超限；不跟随 symlink。"""
    if not os.path.isdir(src_dir):
        raise PackError("E_NOT_FOUND", f"source directory not found: {src_dir}")
    total = 0
    count = 0
    for root, dirs, files in os.walk(src_dir, followlinks=False):
        for dname in dirs:
            if os.path.islink(os.path.join(root, dname)):
                raise PackError("E_PACK_SYMLINK", f"symlink dir not allowed: {dname!r}")
        for fname in files:
            fpath = os.path.join(root, fname)
            if os.path.islink(fpath):
                raise PackError("E_PACK_SYMLINK", f"symlink file not allowed: {fname!r}")
            count += 1
            if count > MAX_ENTRIES:
                raise PackError(
                    "E_PACK_TOO_MANY_ENTRIES", f"source has > {MAX_ENTRIES} files"
                )
            rel = os.path.relpath(fpath, src_dir)
            target = _reject_member_path(rel, dest_dir)
            total += os.path.getsize(fpath)
            if total > MAX_TOTAL_UNCOMPRESSED:
                raise PackError(
                    "E_PACK_BOMB", f"total size exceeds {MAX_TOTAL_UNCOMPRESSED} bytes"
                )
            parent = os.path.dirname(target)
            if parent:
                os.makedirs(parent, exist_ok=True)
            shutil.copyfile(fpath, target)  # 不跟随 dest symlink；src 已判非 symlink
    _assert_no_escape(dest_dir)


# ── hash + manifest 校验 ───────────────────────────────────────────────────────────────


def _iter_files_sorted(content_dir: str) -> list:
    """(relpath_posix, abspath) 确定性排序列表（与打包顺序 / 系统无关）。"""
    out: list = []
    for root, dirs, files in os.walk(content_dir):
        dirs.sort()
        for fname in sorted(files):
            abspath = os.path.join(root, fname)
            rel = os.path.relpath(abspath, content_dir).replace(os.sep, "/")
            out.append((rel, abspath))
    out.sort(key=lambda t: t[0])
    return out


def _file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(_READ_CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def compute_files_and_hash(content_dir: str) -> tuple:
    """逐文件 sha256（``{relpath: sha256}``）+ 内容派生 package_hash（确定性、**可重算**）。

    ``package_hash = sha256( 对每个排序后文件: relpath \\0 sha256 \\0 )``。同内容 → 同 hash（与打包
    顺序 / 系统 / mtime / 权限位无关 —— 只吃 relpath + 内容 hash）。confirm 重算此值比对 owner 批准
    的事实（TOCTOU 防篡改）。返回 (files_dict, package_hash)。
    """
    files: dict = {}
    agg = hashlib.sha256()
    for rel, abspath in _iter_files_sorted(content_dir):
        fh = _file_sha256(abspath)
        files[rel] = fh
        agg.update(rel.encode("utf-8"))
        agg.update(b"\0")
        agg.update(fh.encode("ascii"))
        agg.update(b"\0")
    return files, agg.hexdigest()


def _read_manifest(content_dir: str) -> tuple:
    """读 + 校验 manifest.json → (SkillPackageManifest, 原始 dict)。缺失/非法 → PackError。"""
    mpath = os.path.join(content_dir, MANIFEST_FILENAME)
    if not os.path.isfile(mpath):
        raise PackError("E_PACK_NO_MANIFEST", f"{MANIFEST_FILENAME} not found in package")
    try:
        with open(mpath, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (json.JSONDecodeError, UnicodeDecodeError, OSError) as e:
        raise PackError("E_PACK_BAD_MANIFEST", f"cannot parse {MANIFEST_FILENAME}: {e}") from e
    if not isinstance(raw, dict):
        raise PackError("E_PACK_BAD_MANIFEST", f"{MANIFEST_FILENAME} must be a JSON object")
    try:
        manifest = SkillPackageManifest(**raw)
    except ValidationError as e:
        raise PackError("E_PACK_BAD_MANIFEST", f"manifest v2 validation failed: {e}") from e
    return manifest, raw


def _read_skill_md(content_dir: str) -> str:
    smpath = os.path.join(content_dir, SKILL_DOC_FILENAME)
    if not os.path.isfile(smpath):
        return ""
    try:
        with open(smpath, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def verify_content_dir(content_dir: str) -> VerifiedPack:
    """校验一个**已解包/拷贝**的 content 目录：manifest v2 + 逐文件 hash + package_hash + SKILL.md。

    幂等纯读（不改 content_dir）—— fetch 首校验与 confirm re-hash 都调它，保证 confirm 拿到的
    package_hash / files 与 preview 用同一算法算出，比对才有意义。
    """
    manifest, manifest_dict = _read_manifest(content_dir)
    files, package_hash = compute_files_and_hash(content_dir)
    skill_md = _read_skill_md(content_dir)
    return VerifiedPack(
        manifest=manifest,
        manifest_dict=manifest_dict,
        package_hash=package_hash,
        files=files,
        skill_md=skill_md,
    )
