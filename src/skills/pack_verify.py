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
import re
import shutil
import stat
import tarfile
import zipfile
from dataclasses import dataclass
from typing import Any, Optional

from pydantic import ValidationError

from src.skills.models import SkillPackageManifest

# ── 解包硬上限（zip 炸弹防护）─────────────────────────────────────────────────────────
MAX_ENTRIES = 1000
MAX_TOTAL_UNCOMPRESSED = 100 * 1024 * 1024  # 100 MiB
_READ_CHUNK = 64 * 1024

MANIFEST_FILENAME = "manifest.json"
SKILL_DOC_FILENAME = "SKILL.md"
_SKILL_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,40}$")


def sanitize_skill_name(value: str) -> Optional[str]:
    """把任意名字归一化为合法 skill slug；不合规则返回 None。"""
    normalized = re.sub(r"[^a-z0-9_-]+", "-", (value or "").strip().lower()).strip("-_")[:41]
    return normalized if _SKILL_NAME_RE.fullmatch(normalized) else None


class PackError(Exception):
    """skill 包域错误（结构化 code + http_status + 可选 details 供端点透传）。"""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        http_status: int = 400,
        details: Optional[dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status
        self.details = details


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


def _single_top_dir(rel_names: list[str]) -> Optional[str]:
    """若所有非空归档成员共用同一顶层目录 `<top>/...` 且无顶层散落文件，返回 `<top>`。"""
    top: Optional[str] = None
    has_child = False
    for raw in rel_names:
        cleaned = raw.lstrip("./").strip("/")
        if not cleaned or cleaned == ".":
            continue
        if "/" not in cleaned:
            # 可能是 `<top>` 自身目录项，或者顶层散落文件；仅当同名为所有人的唯一前缀才可剥
            if top is None:
                top = cleaned
            elif cleaned != top:
                return None
            continue
        head = cleaned.split("/", 1)[0]
        if top is None:
            top = head
        elif head != top:
            return None
        has_child = True
    return top if (top and has_child) else None


def safe_extract_zip(
    zip_path: str,
    dest_dir: str,
    *,
    strip_top_dir: bool = False,
    max_entries: int = MAX_ENTRIES,
) -> Optional[str]:
    """把 zip 安全解到 dest_dir（应为空/新建）。拒绝：绝对/traversal 成员、symlink/hardlink 成员、
    entry 超限、解压总量超限（炸弹，边写边累计不信 header file_size）。落盘后 realpath 复核。
    若 strip_top_dir=True 且全员共属单顶层目录，则剥去该前缀并返回被剥目录名。"""
    try:
        zf = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile as e:
        raise PackError("E_PACK_BAD_ZIP", f"not a valid zip archive: {e}") from e
    with zf:
        infos = zf.infolist()
        if len(infos) > max_entries:
            raise PackError(
                "E_PACK_TOO_MANY_ENTRIES", f"archive has {len(infos)} entries (> {max_entries})"
            )
        top_prefix = _single_top_dir([i.filename for i in infos]) if strip_top_dir else None
        total = 0
        for info in infos:
            name = info.filename
            # symlink 成员：zip external_attr 高 16 位 = unix st_mode（S_IFLNK 即 symlink）。
            mode = (info.external_attr >> 16) & 0xFFFF
            if mode and stat.S_ISLNK(mode):
                raise PackError("E_PACK_SYMLINK", f"symlink member not allowed: {name!r}")
            if top_prefix:
                cleaned = name.rstrip("/")
                if cleaned == top_prefix:
                    continue
                if name.startswith(top_prefix + "/"):
                    name = name[len(top_prefix) + 1 :]
                if not name:
                    continue
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
    return top_prefix


def safe_extract_tar_gz(
    tgz_path: str,
    dest_dir: str,
    *,
    strip_top_dir: bool = False,
    max_entries: int = MAX_ENTRIES,
) -> Optional[str]:
    """把 .tar.gz/.tgz 安全解到 dest_dir。拒绝 traversal / symlink / hardlink / 特殊设备 / 炸弹。"""
    try:
        tf = tarfile.open(tgz_path, mode="r:gz")
    except (tarfile.TarError, EOFError, OSError) as e:
        raise PackError("E_PACK_BAD_ARCHIVE", f"not a valid tar.gz archive: {e}") from e
    with tf:
        try:
            members = tf.getmembers()
        except (tarfile.TarError, EOFError, OSError) as e:
            raise PackError("E_PACK_BAD_ARCHIVE", f"corrupted tar.gz archive: {e}") from e
        if len(members) > max_entries:
            raise PackError(
                "E_PACK_TOO_MANY_ENTRIES", f"archive has {len(members)} entries (> {max_entries})"
            )

        usable: list[tuple[tarfile.TarInfo, str]] = []
        for m in members:
            if m.type == tarfile.XGLTYPE or m.name == "pax_global_header":
                continue
            if m.issym() or m.islnk():
                raise PackError("E_PACK_SYMLINK", f"symlink/hardlink member not allowed: {m.name!r}")
            if not (m.isdir() or m.isfile()):
                raise PackError("E_PACK_UNSAFE_PATH", f"unsupported archive member: {m.name!r}")
            rel = m.name
            while rel.startswith("./"):
                rel = rel[2:]
            if rel in ("", "."):
                continue
            usable.append((m, rel))

        top_prefix = _single_top_dir([rel for _, rel in usable]) if strip_top_dir else None
        total = 0
        for m, rel in usable:
            name = rel
            if top_prefix:
                cleaned = name.rstrip("/")
                if cleaned == top_prefix:
                    continue
                if name.startswith(top_prefix + "/"):
                    name = name[len(top_prefix) + 1 :]
                if not name:
                    continue
            if m.isdir():
                target = _reject_member_path(name.rstrip("/"), dest_dir)
                os.makedirs(target, exist_ok=True)
                continue
            target = _reject_member_path(name, dest_dir)
            parent = os.path.dirname(target)
            if parent:
                os.makedirs(parent, exist_ok=True)
            src = tf.extractfile(m)
            if src is None:
                raise PackError("E_PACK_BAD_ARCHIVE", f"cannot read archive member: {m.name!r}")
            with src, open(target, "wb") as out:
                while True:
                    chunk = src.read(_READ_CHUNK)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_TOTAL_UNCOMPRESSED:
                        raise PackError(
                            "E_PACK_BOMB",
                            f"uncompressed size exceeds {MAX_TOTAL_UNCOMPRESSED} bytes (archive bomb?)",
                        )
                    out.write(chunk)
    _assert_no_escape(dest_dir)
    return top_prefix


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


def _unquote_scalar(val: str) -> str:
    s = val.strip()
    if len(s) >= 2 and ((s[0] == s[-1] == '"') or (s[0] == s[-1] == "'")):
        inner = s[1:-1]
        if s[0] == '"':
            inner = inner.replace('\\"', '"').replace("\\n", "\n").replace("\\\\", "\\")
        else:
            inner = inner.replace("''", "'")
        return inner
    return s


def parse_skill_frontmatter(text: str) -> dict[str, Any]:
    """解析 Agent Skill standard ``SKILL.md`` 顶部 YAML frontmatter（无外部 YAML 依赖）。

    支持引号标量、folded/literal 多行块（``>`` / ``>-`` / ``|`` / ``|-``）以及单层缩进子映射
    （如 ``metadata: { version: ... }``）。无 frontmatter 时返回 ``{}``。
    """
    normalized = (text or "").lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    if not normalized.startswith("---\n"):
        return {}
    lines = normalized.split("\n")
    end_idx: Optional[int] = None
    for idx in range(1, len(lines)):
        if lines[idx].strip() == "---":
            end_idx = idx
            break
    if end_idx is None:
        return {}

    fm_lines = lines[1:end_idx]
    out: dict[str, Any] = {}
    i = 0
    while i < len(fm_lines):
        raw_line = fm_lines[i]
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            i += 1
            continue
        if raw_line[0].isspace():
            i += 1
            continue
        key, sep, rest = raw_line.partition(":")
        if not sep:
            i += 1
            continue
        k = key.strip()
        v = rest.strip()
        if v in (">", ">-", "|", "|-"):
            folded = v.startswith(">")
            block_lines: list[str] = []
            i += 1
            base_indent: Optional[int] = None
            while i < len(fm_lines):
                nxt = fm_lines[i]
                if not nxt.strip():
                    block_lines.append("")
                    i += 1
                    continue
                indent = len(nxt) - len(nxt.lstrip(" \t"))
                if indent == 0:
                    break
                if base_indent is None:
                    base_indent = indent
                block_lines.append(nxt[min(indent, base_indent) :])
                i += 1
            while block_lines and block_lines[-1] == "":
                block_lines.pop()
            if folded:
                joined_parts: list[str] = []
                for bl in block_lines:
                    if bl == "":
                        joined_parts.append("\n")
                    elif joined_parts and joined_parts[-1] != "\n":
                        joined_parts.append(" " + bl.strip())
                    else:
                        joined_parts.append(bl.strip())
                out[k] = "".join(joined_parts).strip()
            else:
                out[k] = "\n".join(block_lines)
            continue
        if v == "":
            nested: dict[str, Any] = {}
            i += 1
            while i < len(fm_lines):
                nxt = fm_lines[i]
                if not nxt.strip() or nxt.strip().startswith("#"):
                    i += 1
                    continue
                if not nxt[0].isspace():
                    break
                sk, ssep, srest = nxt.strip().partition(":")
                if ssep and sk.strip():
                    nested[sk.strip()] = _unquote_scalar(srest)
                i += 1
            out[k] = nested
            continue
        out[k] = _unquote_scalar(v)
        i += 1
    return out


def _synthesize_manifest_from_skill_md(content_dir: str, smpath: str) -> tuple:
    """无 manifest.json 时从标准 Agent Skill ``SKILL.md`` 合成严格校验的 manifest v2。"""
    try:
        with open(smpath, "r", encoding="utf-8", errors="replace") as f:
            skill_md = f.read()
    except OSError as e:
        raise PackError("E_PACK_BAD_MANIFEST", f"cannot read {SKILL_DOC_FILENAME}: {e}") from e

    fm = parse_skill_frontmatter(skill_md)
    candidate_name = fm.get("name") if isinstance(fm.get("name"), str) else ""
    skill_name = sanitize_skill_name(candidate_name) or sanitize_skill_name(
        os.path.basename(os.path.abspath(content_dir))
    )
    if not skill_name:
        raise PackError(
            "E_PACK_BAD_MANIFEST",
            f"{SKILL_DOC_FILENAME} frontmatter must declare a valid lowercase slug 'name'",
        )

    scripts_dir = os.path.join(content_dir, "scripts")
    has_scripts = os.path.isdir(scripts_dir) and any(
        os.path.isfile(os.path.join(root, fname))
        for root, _dirs, files in os.walk(scripts_dir)
        for fname in files
    )
    meta_block = fm.get("metadata") if isinstance(fm.get("metadata"), dict) else {}
    version = str(
        fm.get("version") or meta_block.get("version") or "0.1.0"
    ).strip() or "0.1.0"
    title = str(fm.get("title") or fm.get("name") or skill_name).strip() or skill_name
    description = str(fm.get("description") or "").strip()
    raw_default = fm.get("default_enabled")
    if isinstance(raw_default, str):
        default_enabled = raw_default.strip().lower() not in ("false", "0", "no", "off")
    elif isinstance(raw_default, bool):
        default_enabled = raw_default
    else:
        default_enabled = True

    raw: dict[str, Any] = {
        "manifest_version": 2,
        "type": "script" if has_scripts else "document",
        "name": skill_name,
        "version": version,
        "title": title,
        "description": description,
        "default_enabled": default_enabled,
        "tools": [],
    }
    license_val = fm.get("license")
    if isinstance(license_val, str) and license_val.strip():
        raw["license"] = license_val.strip()

    try:
        manifest = SkillPackageManifest(**raw)
    except ValidationError as e:
        raise PackError("E_PACK_BAD_MANIFEST", f"synthesized manifest v2 invalid: {e}") from e
    return manifest, raw


def _read_manifest(content_dir: str) -> tuple:
    """读 + 校验 manifest.json（若缺失则从标准 Agent Skill ``SKILL.md`` 合成 v2）→ (SkillPackageManifest, dict)。"""
    mpath = os.path.join(content_dir, MANIFEST_FILENAME)
    if not os.path.isfile(mpath):
        smpath = os.path.join(content_dir, SKILL_DOC_FILENAME)
        if not os.path.isfile(smpath):
            raise PackError("E_PACK_NO_MANIFEST", f"{MANIFEST_FILENAME} not found in package")
        return _synthesize_manifest_from_skill_md(content_dir, smpath)
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
