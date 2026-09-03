"""多根路径 jail —— 每个挂载根一座（design §3 路径校验按根参数化，§8.2 挂载内额外拒收）。

每条进出磁盘的路径都过 :func:`resolve`：

1. 只收相对路径；拒 ``..`` 段 / 绝对路径 / NUL 字节；``.`` 段折叠；
2. NFC 归一后再 casefold 得 ``rel_key``（APFS 大小写不敏感 + 归一不敏感，索引按 key 查重）；
3. 写目标的末段过 ``AttachmentStore.sanitize_filename``（与附件落盘 / compose 暂存同一套规则）；
4. 挂载根（``id != 0``）内额外拒 ``MOUNT_DENY_SUFFIXES`` 后缀（含 ``.env*``）与 ``MOUNT_DENY_DIRS`` 段；
5. ``realpath`` 必须与拼出来的路径逐字相等 —— 路径里任何 symlink 成分（指向根外**或根内**）一律拒，
   jail 只认真实路径；根目录本身在构造 :class:`MountRoot` 时已 ``realpath`` 化，故 ``/tmp``→``/private/tmp``
   这类系统 symlink 不会误伤；
6. 真正 open 时 ``O_NOFOLLOW`` + ``fstat`` 复核是常规文件（resolve → open 之间被换成 symlink 的 TOCTOU 窗）。

exec 地板（``src/api/exec_floor.py``）是另一层：它管 agent 的 ``file_*`` 原语，本模块管资料库自己的
读写面，两者都对 ``library.db`` / 密钥后缀说不。
"""

from __future__ import annotations

import os
import stat as _stat
import unicodedata
from dataclasses import dataclass
from typing import Optional, Tuple

from src.library.constants import MOUNT_DENY_DIRS, MOUNT_DENY_SUFFIXES
from src.repository.attachment_store import AttachmentStore


class PathError(Exception):
    """路径校验失败。``code`` 直接是 API 错误码（默认 400 E_INVALID_ARG；地板类拒收 403 E_AUTH_FAILED）。"""

    def __init__(self, message: str, *, code: str = "E_INVALID_ARG", hint: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint


@dataclass(frozen=True)
class MountRoot:
    """一座 jail 的根。``id == 0`` 是库根（userData 内），其余是用户挂载的外部目录。"""

    id: int
    label: str
    abs_path: str  # 已 realpath 化的根目录
    mode: str  # 'ro' | 'rw'

    @property
    def is_external(self) -> bool:
        return self.id != 0


@dataclass(frozen=True)
class ResolvedPath:
    mount: MountRoot
    rel_path: str  # NFC 归一、'/' 分隔、无 '.'/'..'/空段；'' = 根本身
    rel_key: str
    parent_path: str  # '' = 顶层
    filename: str  # '' 当 rel_path == ''
    abs_path: str

    @property
    def virtual_path(self) -> str:
        return join_virtual(self.mount, self.rel_path)


def _nfc(value: str) -> str:
    return unicodedata.normalize("NFC", value)


def rel_key_of(rel: str) -> str:
    """索引比对键：casefold(NFC(rel))。"""
    return _nfc(rel).casefold()


def normalize_rel(rel: str) -> str:
    """校验 + 归一相对路径（不碰磁盘）。返回 ``'a/b/c'`` 形态；空串表示根本身。"""
    if rel is None:
        raise PathError("path is required")
    if "\x00" in rel:
        raise PathError("path contains NUL byte")
    raw = _nfc(str(rel)).replace("\\", "/")
    if raw.startswith("/"):
        raise PathError("absolute paths are not allowed", hint="路径必须相对于库根 / 挂载根")
    segments = []
    for seg in raw.split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            raise PathError("path traversal is not allowed")
        if any(ord(c) < 0x20 or c == "\x7f" for c in seg):
            raise PathError("path contains control characters")
        segments.append(seg)
    return "/".join(segments)


def split_virtual(path: str) -> Tuple[Optional[str], str]:
    """虚拟路径 → ``(挂载 label | None, rel)``。``@label/...`` 指挂载根；其余落库根。"""
    rel = normalize_rel(path)
    if not rel.startswith("@"):
        return None, rel
    head, _, rest = rel.partition("/")
    label = head[1:]
    if not label:
        raise PathError("mount label is empty", hint="挂载路径形如 @label/sub/file.md")
    return label, rest


def join_virtual(mount: MountRoot, rel: str) -> str:
    if not mount.is_external:
        return rel
    return f"@{mount.label}/{rel}" if rel else f"@{mount.label}"


def denied_reason(mount: MountRoot, rel: str) -> Optional[str]:
    """挂载根内的额外拒收（库根不适用 —— 那是 exec 地板的事）。"""
    if not mount.is_external or not rel:
        return None
    segments = rel.split("/")
    for seg in segments:
        if seg in MOUNT_DENY_DIRS:
            return f"denied directory {seg!r}"
    name = segments[-1].casefold()
    if name == ".env" or name.startswith(".env."):
        return "denied suffix '.env'"
    for suffix in MOUNT_DENY_SUFFIXES:
        if name.endswith(suffix):
            return f"denied suffix {suffix!r}"
    return None


def resolve(mount: MountRoot, rel: str, *, for_write: bool = False) -> ResolvedPath:
    """把相对路径钉进 ``mount`` 的 jail；任何越界 / symlink / 拒收后缀 → :class:`PathError`。"""
    rel_path = normalize_rel(rel)
    if for_write and rel_path:
        segments = rel_path.split("/")
        segments[-1] = AttachmentStore.sanitize_filename(segments[-1])
        rel_path = "/".join(segments)
    reason = denied_reason(mount, rel_path)
    if reason:
        raise PathError(reason, code="E_AUTH_FAILED", hint="挂载根内该路径按规则拒收")
    abs_path = os.path.join(mount.abs_path, *rel_path.split("/")) if rel_path else mount.abs_path
    real = os.path.realpath(abs_path)
    if real != abs_path:
        raise PathError("path traverses a symlink", code="E_AUTH_FAILED", hint="资料库只认真实路径")
    if real != mount.abs_path and not real.startswith(mount.abs_path + os.sep):
        raise PathError("path escapes the mount root", code="E_AUTH_FAILED")
    parent, _, filename = rel_path.rpartition("/")
    return ResolvedPath(
        mount=mount,
        rel_path=rel_path,
        rel_key=rel_key_of(rel_path),
        parent_path=parent,
        filename=filename,
        abs_path=abs_path,
    )


def _check_regular(fd: int, abs_path: str) -> None:
    st = os.fstat(fd)
    if not _stat.S_ISREG(st.st_mode):
        raise PathError(f"not a regular file: {abs_path}")


def open_read(resolved: ResolvedPath) -> int:
    """``O_NOFOLLOW`` 打开只读 fd 并复核常规文件；调用方负责 ``os.close``。"""
    try:
        fd = os.open(resolved.abs_path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as exc:
        raise PathError(f"cannot open {resolved.rel_path or '/'}: {exc.strerror}", code="E_NOT_FOUND") from exc
    try:
        _check_regular(fd, resolved.abs_path)
    except BaseException:
        os.close(fd)
        raise
    return fd


def open_write(resolved: ResolvedPath, mode: str) -> int:
    """``mode`` ∈ overwrite / append / create_new。inode 复核在截断之前（抄 exec_floor 的次序）。"""
    if not resolved.filename:
        raise PathError("cannot write to a directory path")
    flags = os.O_WRONLY | os.O_NOFOLLOW | os.O_CREAT
    if mode == "create_new":
        flags |= os.O_EXCL
    elif mode == "append":
        flags |= os.O_APPEND
    elif mode != "overwrite":
        raise ValueError(f"unknown write mode: {mode!r}")
    os.makedirs(os.path.dirname(resolved.abs_path), exist_ok=True)
    try:
        fd = os.open(resolved.abs_path, flags, 0o644)
    except FileExistsError as exc:
        raise PathError(f"already exists: {resolved.rel_path}", code="E_VERSION_CONFLICT") from exc
    except OSError as exc:
        raise PathError(f"cannot open {resolved.rel_path}: {exc.strerror}") from exc
    try:
        _check_regular(fd, resolved.abs_path)
        if mode == "overwrite":
            os.ftruncate(fd, 0)
    except BaseException:
        os.close(fd)
        raise
    return fd
