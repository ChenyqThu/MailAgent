"""davmail.properties 单键同步 —— ``davmail.folderSizeLimit``。

**为什么存在**：2026-07-24 owner 收件箱 10617 封、``davmail.folderSizeLimit`` 从未配置，
每次 IMAP ``SELECT``/``STATUS`` 都让 DavMail 经 EWS 枚举全部邮件 —— 连最轻量的雷达
``STATUS (UIDNEXT)`` 都撞 30s 超时（实测裸 IMAP greeting 16.7s），整条同步链停摆。
这个参数只存在于 DavMail 自己的 ``.properties`` 里，App 用户既看不见也改不了，所以
它必然会再次发生在下一个大邮箱用户身上。本模块把它接进 App 的配置面。

**链路**：``DAVMAIL_FOLDER_SIZE_LIMIT``（config.py，默认 500）→ mail-sync 启动时
（仅 davmail 模式）写进 ``<DAVMAIL_ROOT>/config/davmail.properties``。

🔴 **写文件 ≠ 立即生效**：DavMail 只在自己启动时读 properties，写入后必须重启 davmail 桥
（``pm2 restart davmail-poc``）才读到新值。同步结果落 sync_state ``davmail.folder_size_limit.*``，
Settings 面据此**如实**显示到底写进去没有 —— ``DAVMAIL_ROOT`` 没配（打包 .app 的默认解析
会落进 site-packages）时文件根本不存在，这个设置就是不生效，必须让用户看见而不是假装成功。

**Java .properties 语义**（davmail-poc 配置里有血泪注释）：不支持行内注释，``#``/``!`` 必须
独占一行；key 与 value 用 ``=`` 或 ``:`` 分隔；同 key 重复时**后者生效**。本模块只认这种最简
形态，只改命中的那一行（或追加一行），其余字节原样保留——文件里还有 OAuth token 路径 /
cipher 等要害配置，不能被顺手重排。
"""
from __future__ import annotations

import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from loguru import logger

PROPERTY_KEY = "davmail.folderSizeLimit"

_CONFIG_RELPATH = Path("config") / "davmail.properties"

# sync_state 键前缀（镜像 davmail.* 惯例，不进 DB_VERSION）
STATE_PREFIX = "davmail.folder_size_limit."

STATUS_UPDATED = "updated"          # 文件里的值与期望不同 → 已写入（需重启 DavMail 生效）
STATUS_UNCHANGED = "unchanged"      # 文件里已是期望值
STATUS_FILE_MISSING = "file_missing"  # 找不到 davmail.properties → 该设置不生效
STATUS_ERROR = "error"              # 读写失败（权限 / IO）
STATUS_DISABLED = "disabled"        # limit<=0 → App 不管理该键，DavMail 保持自身配置


@dataclass(frozen=True)
class PropertySyncResult:
    """一次同步的结果。``file_value`` 是同步后文件里的实际值（读不到为 None）。"""

    status: str
    path: str
    desired: Optional[int]
    file_value: Optional[str]
    detail: str = ""


def properties_path(davmail_root: Path) -> Path:
    """``<davmail_root>/config/davmail.properties``（davmail-poc 部署约定）。"""
    return Path(davmail_root) / _CONFIG_RELPATH


def _decode(raw: bytes) -> tuple[str, str]:
    """utf-8 优先，失败退 latin-1（字节 1:1 映射，回写时逐字节还原不损坏原文件）。"""
    try:
        return raw.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        return raw.decode("latin-1"), "latin-1"


def _is_key_line(line: str) -> bool:
    """该行是否是 ``davmail.folderSizeLimit`` 的赋值行（非注释、非前缀相似的别的 key）。"""
    stripped = line.lstrip()
    if not stripped or stripped[0] in "#!":
        return False
    if not stripped.startswith(PROPERTY_KEY):
        return False
    rest = stripped[len(PROPERTY_KEY):].lstrip()
    return rest[:1] in ("=", ":")


def _line_value(line: str) -> str:
    rest = line.lstrip()[len(PROPERTY_KEY):].lstrip()
    return rest[1:].strip()  # 去掉分隔符本身


def read_current_value(path: Path) -> Optional[str]:
    """读文件里当前生效的值（重复 key 取最后一个，同 Java 语义）。读不到 → None。

    OSError 一律吞掉（不存在 / 无权限 / 路径不是目录）—— 这是启动路径上的只读探测，
    读不到只该让 UI 显示"未知"，不该把 mail-sync 拖崩。
    """
    try:
        text, _ = _decode(Path(path).read_bytes())
    except OSError:
        return None
    return _value_from_text(text)


def _value_from_text(text: str) -> Optional[str]:
    found: Optional[str] = None
    for line in text.splitlines():
        if _is_key_line(line):
            found = _line_value(line)  # 重复 key: 后者生效
    return found


def _atomic_write(path: Path, data: bytes) -> None:
    """同目录 tmp + ``os.replace``（半截写坏 davmail.properties = 桥起不来）。"""
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".davmail-props-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        shutil.copymode(path, tmp)  # 保持原权限位（mkstemp 是 0600）
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _patch(text: str, desired: int) -> str:
    """替换最后一处赋值行；一处都没有则在末尾追加（带独占行注释）。"""
    lines = text.splitlines(keepends=True)
    last_idx = -1
    for i, line in enumerate(lines):
        if _is_key_line(line):
            last_idx = i
    if last_idx >= 0:
        original = lines[last_idx]
        newline = ""
        for suffix in ("\r\n", "\n", "\r"):
            if original.endswith(suffix):
                newline = suffix
                break
        lines[last_idx] = f"{PROPERTY_KEY}={desired}{newline}"
        return "".join(lines)

    tail = "".join(lines)
    if tail and not tail.endswith(("\n", "\r")):
        tail += "\n"
    # 追加的注释块**恒 ASCII**: .properties 按 Java 惯例可能是 ISO-8859-1, 中文注释
    # 在 latin-1 文件上 encode 直接抛 (有单测钉住), 且落进去也是乱码。
    return (
        tail
        + "\n# Managed by MailAgent (DAVMAIL_FOLDER_SIZE_LIMIT): keep only the most recent N\n"
        + "# messages in each IMAP folder view. Without it a large mailbox makes DavMail\n"
        + "# enumerate the whole folder over EWS on every SELECT/STATUS -> timeouts.\n"
        + f"{PROPERTY_KEY}={desired}\n"
    )


def sync_folder_size_limit(davmail_root: Path, desired: Optional[int]) -> PropertySyncResult:
    """把 ``desired`` 写进 davmail.properties。从不抛异常（失败也只是这个设置不生效）。

    ``desired <= 0``（或 None）= App 不管理该键：不写文件，只读回当前值供 UI 显示。
    """
    path = properties_path(davmail_root)

    if desired is None or desired <= 0:
        return PropertySyncResult(
            status=STATUS_DISABLED,
            path=str(path),
            desired=desired,
            file_value=read_current_value(path),
        )

    try:
        raw = path.read_bytes()
    except (FileNotFoundError, NotADirectoryError):
        return PropertySyncResult(
            status=STATUS_FILE_MISSING,
            path=str(path),
            desired=desired,
            file_value=None,
            detail="davmail.properties not found (DAVMAIL_ROOT 未配置或路径不对)",
        )
    except OSError as exc:
        return PropertySyncResult(
            status=STATUS_ERROR, path=str(path), desired=desired, file_value=None, detail=str(exc)
        )

    text, encoding = _decode(raw)
    current = _value_from_text(text)  # 用同一次读到的字节判定, 不二次读盘
    if current is not None and current == str(desired):
        return PropertySyncResult(
            status=STATUS_UNCHANGED, path=str(path), desired=desired, file_value=current
        )

    try:
        _atomic_write(path, _patch(text, desired).encode(encoding))
    except OSError as exc:
        return PropertySyncResult(
            status=STATUS_ERROR,
            path=str(path),
            desired=desired,
            file_value=current,
            detail=str(exc),
        )
    return PropertySyncResult(
        status=STATUS_UPDATED,
        path=str(path),
        desired=desired,
        file_value=str(desired),
        detail=f"was {current!r}" if current is not None else "key appended",
    )


def apply_and_record(sync_store, davmail_root: Path, desired: Optional[int]) -> PropertySyncResult:
    """同步 + 把结果落 sync_state（Settings 面读它显示真实状态）+ 日志。

    sync_state 写失败不影响同步本身（DB 忙时最多是 UI 少一行状态）。
    """
    result = sync_folder_size_limit(davmail_root, desired)

    if result.status == STATUS_UPDATED:
        logger.warning(
            f"[davmail-props] {PROPERTY_KEY}={result.desired} 已写入 {result.path} "
            f"({result.detail}) —— 需重启 davmail 桥 (pm2 restart davmail-poc) 才生效"
        )
    elif result.status == STATUS_FILE_MISSING:
        logger.warning(
            f"[davmail-props] 找不到 {result.path}，{PROPERTY_KEY} 设置不生效 "
            "(打包 .app 需在 .env 配 DAVMAIL_ROOT 绝对路径)"
        )
    elif result.status == STATUS_ERROR:
        logger.warning(f"[davmail-props] 同步 {PROPERTY_KEY} 失败: {result.detail}")
    else:
        logger.info(
            f"[davmail-props] {PROPERTY_KEY} status={result.status} "
            f"file_value={result.file_value!r}"
        )

    try:
        from datetime import datetime

        sync_store.set_state(f"{STATE_PREFIX}status", result.status)
        sync_store.set_state(f"{STATE_PREFIX}path", result.path)
        sync_store.set_state(
            f"{STATE_PREFIX}desired", "" if result.desired is None else str(result.desired)
        )
        sync_store.set_state(f"{STATE_PREFIX}file_value", result.file_value or "")
        sync_store.set_state(f"{STATE_PREFIX}synced_at", datetime.now().isoformat())
    except Exception as exc:  # noqa: BLE001 — 状态记录失败不该拖垮启动
        logger.warning(f"[davmail-props] sync_state 记录失败 (non-fatal): {exc}")

    return result
