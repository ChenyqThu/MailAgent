"""IMAP client helper — DavMail 本机 IMAP/SMTP 连接的统一入口.

抽自 `davmail-poc/test_imap_suite.py` + `test_smtp_reply.py` 的 connect/auth 逻辑,
作为 DavMailBackend / draft_builder / 后续 GraphBackend 共享的薄包装层.

关键细节 (来自 davmail-poc/POC-RESULTS.md):
- DavMail 用 StringEncryptor(password) 加密 OAuth refresh token; 所有 client (mail-sync /
  CLI / 测试) 必须用同一 cipher key, 否则 BadPaddingException 触发 token 失效
- cipher key = AUTH 时的 IMAP/SMTP password, 跟 OAuth refresh 加密 key 是同一个
- 端口默认: IMAP 1143 / SMTP 1025 / CalDAV 1080 (仅 127.0.0.1 监听)
"""
from __future__ import annotations

import imaplib
import json
import re
import smtplib
import socket
from contextlib import contextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Iterator, Optional

from loguru import logger

from src.mail.backend.imap_utf7 import decode_imap_utf7

if TYPE_CHECKING:
    from src.config import Config


class DavMailConnectionError(RuntimeError):
    """DavMail 连接/认证失败."""


# IMAP LIST 响应里 \\Drafts SPECIAL-USE 标志的正则 (RFC 6154)
_DRAFTS_FLAG_PATTERN = re.compile(rb"\\Drafts", re.IGNORECASE)

# IMAP LIST 响应里 \\Archive SPECIAL-USE 标志的正则 (RFC 6154).
# 只匹配 \\Archive (不含 \\All), Outlook/Exchange 主场景用 \\Archive 或 "Archive" fallback;
# Gmail 的 "[Gmail]/All Mail" 走 fallback 名字列表.
_ARCHIVE_FLAG_PATTERN = re.compile(rb"\\Archive\b", re.IGNORECASE)

# IMAP LIST 响应里 \\Sent SPECIAL-USE 标志的正则 (RFC 6154).
_SENT_FLAG_PATTERN = re.compile(rb"\\Sent\b", re.IGNORECASE)


_POC_DEFAULT_CIPHER_KEY = "mailagent-poc-shared-key"


def get_cipher_key(cfg: "Config") -> str:
    """从配置拿 DavMail cipher key (StringEncryptor password).

    优先 ``cfg.davmail_cipher_key``. 留空时:
      - 若 ``cfg.davmail_poc_mode=True`` 或 env ``DAVMAIL_POC_MODE=1`` → fallback
        到 PoC 默认值, 兼容 ``davmail-poc/`` 共享实例.
      - 否则 raise ``DavMailConnectionError``, 避免生产环境无声 fallback 导致
        BadPaddingException → token 失效 → 用户莫名其妙 (review MEDIUM).
    """
    val = getattr(cfg, "davmail_cipher_key", "") or ""
    if val:
        return val
    import os as _os
    poc_mode = bool(getattr(cfg, "davmail_poc_mode", False)) or (
        _os.environ.get("DAVMAIL_POC_MODE", "").lower() in ("1", "true", "yes")
    )
    if poc_mode:
        logger.warning(
            "[imap-client] DAVMAIL_CIPHER_KEY empty + POC mode on → "
            "using PoC default cipher key (NOT for production)"
        )
        return _POC_DEFAULT_CIPHER_KEY
    raise DavMailConnectionError(
        "DAVMAIL_CIPHER_KEY required when MAILAGENT_BACKEND=davmail. "
        "Set DAVMAIL_CIPHER_KEY in .env to match your local DavMail StringEncryptor "
        "password (see davmail-poc/POC-RESULTS.md §StringEncryptor). "
        "For PoC/dev only: set DAVMAIL_POC_MODE=1 to fall back to the shared PoC key."
    )


def imap_connect(cfg: "Config", *, timeout: int = 60) -> imaplib.IMAP4:
    """建立 IMAP 连接 + LOGIN.

    Raises:
        DavMailConnectionError: connect / login 失败.
    """
    host = getattr(cfg, "davmail_imap_host", "") or "127.0.0.1"
    port = int(getattr(cfg, "davmail_imap_port", 0) or 1143)
    user = cfg.user_email
    cipher = get_cipher_key(cfg)

    logger.debug(f"[imap-client] connecting IMAP {host}:{port} user={user}")
    try:
        imap = imaplib.IMAP4(host, port, timeout=timeout)
    except (ConnectionRefusedError, socket.timeout, OSError) as e:
        raise DavMailConnectionError(
            f"connect IMAP {host}:{port} failed: {e} (DavMail running? pm2 ls | grep davmail)"
        ) from e

    try:
        typ, data = imap.login(user, cipher)
        if typ != "OK":
            raise DavMailConnectionError(f"IMAP LOGIN failed: {data}")
    except imaplib.IMAP4.error as e:
        raise DavMailConnectionError(
            f"IMAP LOGIN error: {e} (token expired? cipher key mismatch? "
            f"check davmail-poc/POC-RESULTS.md §StringEncryptor)"
        ) from e

    return imap


@contextmanager
def imap_session(cfg: "Config", *, timeout: int = 60) -> Iterator[imaplib.IMAP4]:
    """IMAP 连接 context manager, 自动 logout."""
    imap = imap_connect(cfg, timeout=timeout)
    try:
        yield imap
    finally:
        try:
            imap.logout()
        except Exception:
            pass


def smtp_connect(cfg: "Config", *, timeout: int = 300) -> smtplib.SMTP:
    """建立 SMTP 连接 + LOGIN.

    timeout 默认 300s: 首次 AUTH 可能触发 OAuth manual flow, 用户在浏览器 1-3min 完成
    MFA + 粘 callback URL; 后续 cached token 秒回, 但保留长 timeout 防 refresh.
    """
    host = getattr(cfg, "davmail_imap_host", "") or "127.0.0.1"
    port = int(getattr(cfg, "davmail_smtp_port", 0) or 1025)
    user = cfg.user_email
    cipher = get_cipher_key(cfg)

    logger.debug(f"[imap-client] connecting SMTP {host}:{port} user={user}")
    try:
        s = smtplib.SMTP(host, port, timeout=timeout)
    except (ConnectionRefusedError, socket.timeout, OSError) as e:
        raise DavMailConnectionError(
            f"connect SMTP {host}:{port} failed: {e}"
        ) from e

    try:
        s.ehlo()
        s.login(user, cipher)
    except smtplib.SMTPAuthenticationError as e:
        raise DavMailConnectionError(
            f"SMTP AUTH failed: {e} (token expired? cipher key mismatch?)"
        ) from e

    return s


@contextmanager
def smtp_session(cfg: "Config", *, timeout: int = 300) -> Iterator[smtplib.SMTP]:
    """SMTP 连接 context manager, 自动 quit."""
    s = smtp_connect(cfg, timeout=timeout)
    try:
        yield s
    finally:
        try:
            s.quit()
        except Exception:
            pass


def probe_tcp(host: str, port: int, *, timeout: float = 2.0) -> tuple[bool, str]:
    """TCP probe (不建立 IMAP/SMTP 协议会话, 仅检查端口可达).

    Returns:
        (ok, detail).
    """
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True, f"{host}:{port} reachable"
    except Exception as e:
        return False, f"{host}:{port} unreachable: {e}"


def discover_drafts_folder(imap: imaplib.IMAP4) -> Optional[str]:
    """通过 IMAP LIST SPECIAL-USE 标志找 \\Drafts 文件夹 (RFC 6154).

    DavMail Outlook 中文环境可能叫 "草稿" / "Drafts" / "INBOX/Drafts" / "[Gmail]/Drafts",
    用 SPECIAL-USE 是最稳的探测方式. Fallback 试常见名字.

    Returns:
        文件夹名 (IMAP path, 带 quote 或路径分隔符如原样), 或 None 表示找不到.
    """
    # 先尝试 LIST-EXTENDED 拿 SPECIAL-USE
    try:
        typ, data = imap.list()
        if typ == "OK" and data:
            for entry in data:
                if entry and _DRAFTS_FLAG_PATTERN.search(entry):
                    # entry 形如: b'(\\HasNoChildren \\Drafts) "/" "INBOX/Drafts"'
                    # 拿最后一个 token (邮箱名)
                    parts = entry.decode("utf-8", errors="replace").rsplit(" ", 1)
                    if len(parts) >= 2:
                        folder = parts[-1].strip().strip('"')
                        logger.debug(
                            f"[imap-client] found Drafts via SPECIAL-USE: {folder!r}"
                        )
                        return folder
    except Exception as e:
        logger.warning(f"[imap-client] LIST SPECIAL-USE failed: {e}")

    # Fallback: 试常见名字. 不在循环里调 imap.close() 触发 EXPUNGE/状态机切换 — 让
    # imap_session context manager 自己 logout 即可 (review HIGH #1).
    for candidate in ("INBOX/Drafts", "Drafts", "草稿", "[Gmail]/Drafts"):
        try:
            typ, _ = imap.select(candidate, readonly=True)
            if typ == "OK":
                logger.debug(f"[imap-client] found Drafts via fallback: {candidate!r}")
                return candidate
        except Exception:
            continue

    logger.warning("[imap-client] could not discover Drafts folder")
    return None


def discover_archive_folder(imap: imaplib.IMAP4) -> Optional[str]:
    """通过 IMAP LIST SPECIAL-USE 标志找 Archive 文件夹 (RFC 6154 \\Archive).

    Outlook/Exchange 通常叫 "Archive"; 中文环境可能 "存档" / "归档"; Gmail 是
    "[Gmail]/All Mail". 用 SPECIAL-USE 最稳, fallback 试常见名字.

    Returns:
        文件夹名 (IMAP path), 或 None 表示找不到 (调用方应跳过 archive 同步).
    """
    try:
        typ, data = imap.list()
        if typ == "OK" and data:
            for entry in data:
                if entry and _ARCHIVE_FLAG_PATTERN.search(entry):
                    # entry 形如: b'(\\HasNoChildren \\Archive) "/" "Archive"'
                    parts = entry.decode("utf-8", errors="replace").rsplit(" ", 1)
                    if len(parts) >= 2:
                        folder = parts[-1].strip().strip('"')
                        logger.debug(
                            f"[imap-client] found Archive via SPECIAL-USE: {folder!r}"
                        )
                        return folder
    except Exception as e:
        logger.warning(f"[imap-client] LIST SPECIAL-USE (archive) failed: {e}")

    # Fallback: 试常见名字 (同 discover_drafts_folder 风格, 不在循环里 close).
    for candidate in ("Archive", "INBOX/Archive", "存档", "已归档", "归档", "[Gmail]/All Mail"):
        try:
            typ, _ = imap.select(candidate, readonly=True)
            if typ == "OK":
                logger.debug(f"[imap-client] found Archive via fallback: {candidate!r}")
                return candidate
        except Exception:
            continue

    logger.warning("[imap-client] could not discover Archive folder")
    return None


def discover_sent_folder(imap: imaplib.IMAP4) -> Optional[str]:
    """通过 IMAP LIST SPECIAL-USE 标志找 Sent 文件夹 (RFC 6154 \\Sent).

    Outlook/Exchange 通常叫 "Sent Items"; 中文环境 "已发送邮件" / "已发送"; Gmail 是
    "[Gmail]/Sent Mail". 用 SPECIAL-USE 最稳, fallback 试常见名字.

    Returns:
        文件夹名 (IMAP path), 或 None 表示找不到 (调用方应跳过 Sent 归档).
    """
    try:
        typ, data = imap.list()
        if typ == "OK" and data:
            for entry in data:
                if entry and _SENT_FLAG_PATTERN.search(entry):
                    parts = entry.decode("utf-8", errors="replace").rsplit(" ", 1)
                    if len(parts) >= 2:
                        folder = parts[-1].strip().strip('"')
                        logger.debug(
                            f"[imap-client] found Sent via SPECIAL-USE: {folder!r}"
                        )
                        return folder
    except Exception as e:
        logger.warning(f"[imap-client] LIST SPECIAL-USE (sent) failed: {e}")

    for candidate in (
        "Sent Items", "Sent", "已发送邮件", "已发送", "INBOX/Sent", "[Gmail]/Sent Mail",
    ):
        try:
            typ, _ = imap.select(candidate, readonly=True)
            if typ == "OK":
                logger.debug(f"[imap-client] found Sent via fallback: {candidate!r}")
                return candidate
        except Exception:
            continue

    logger.warning("[imap-client] could not discover Sent folder")
    return None


# =============================================================================
# 多文件夹同步: 文件夹发现 (LIST → FolderInfo 树)
# =============================================================================

# IMAP LIST 行: ``(\Flags) "delim" name`` — name 可带引号(含空格如 "Sent Items")或裸 atom。
_LIST_LINE_RE = re.compile(rb'^\((?P<flags>[^)]*)\)\s+(?P<delim>"[^"]*"|NIL)\s+(?P<name>.*)$')

# 系统/受保护文件夹的 SPECIAL-USE 标志 (RFC 6154)。这些文件夹不可重命名/删除 (P4 管理 gate)，
# 且 收件箱/发件箱 由 SYNC_MAILBOXES 单独管 (不进 SYNC_FOLDERS 白名单)。
# 注意: \\Archive **不在**此列 —— Archive 是普通可同步文件夹 (用户可勾选)。
_SYSTEM_SPECIAL_USE = {"\\inbox", "\\sent", "\\drafts", "\\junk", "\\trash"}


def parse_folder_csv_or_json(raw: str) -> list[str]:
    """解析 folder 名列表配置 → 去重保序的 list。

    **JSON 数组优先** (``["Notion","&W,mL3VOGU,KLsF9V-"]``) —— modified-UTF7 名含逗号
    (base64 段用 ``,`` 代替 ``/``)，逗号分隔会拆坏。非 ``[`` 开头或 JSON 解析失败退回逗号
    分隔 (兼容旧简单 ASCII 名)。SYNC_FOLDERS / FOLDER_NOTIFY_ENABLED / FOLDER_LLM_DISABLED 共用。
    """
    raw = (raw or "").strip()
    if not raw:
        return []
    if raw.startswith("["):
        try:
            loaded = json.loads(raw)
            names = [str(x) for x in loaded] if isinstance(loaded, list) else []
        except (json.JSONDecodeError, TypeError):
            names = raw.split(",")
    else:
        names = raw.split(",")
    seen: set[str] = set()
    out: list[str] = []
    for part in names:
        n = part.strip()
        if n and n not in seen:
            seen.add(n)
            out.append(n)
    return out


def quote_mailbox(name: str) -> str:
    """IMAP mailbox 名加引号 — imaplib **不自动 quote**, 含空格/特殊字符的名字 (如
    ``Unsent Messages`` / ``Sent Items``) 不 quote 会被拆成多个 atom → ``folder not found``。
    简单名加引号无害 (实测 ``"INBOX"`` STATUS/SELECT 正常)。RFC 3501 §9 quoted-string:
    转义 ``\\`` 与 ``"``。
    """
    return '"' + name.replace("\\", "\\\\").replace('"', '\\"') + '"'


@dataclass
class FolderInfo:
    """一个 IMAP 文件夹的发现结果。

    - ``imap_name``: LIST 返回的原始名 (modified-UTF7, ASCII)。**白名单存储 / SELECT 用这个**。
    - ``display_name``: 解码后的可读名 (中文)。仅展示用。
    - ``delimiter``: 层级分隔符 (实测 davmail = "/")。
    - ``special_use``: RFC 6154 SPECIAL-USE 标志 (小写, 如 "\\sent")，无则 None。
    - ``is_system``: 系统文件夹 (INBOX 或受保护 special-use)，管理操作 gate + 前端锁定。
    - ``has_children``: LIST \\HasChildren 标志。
    - ``parent``: 父文件夹 imap_name (按 delimiter 推导)，顶层为 None。
    - ``message_count``: STATUS MESSAGES (懒加载，未取时 None)。
    """

    imap_name: str
    display_name: str
    delimiter: str = "/"
    special_use: Optional[str] = None
    is_system: bool = False
    has_children: bool = False
    parent: Optional[str] = None
    message_count: Optional[int] = None

    def to_dict(self) -> dict:
        return {
            "imap_name": self.imap_name,
            "display_name": self.display_name,
            "delimiter": self.delimiter,
            "special_use": self.special_use,
            "is_system": self.is_system,
            "has_children": self.has_children,
            "parent": self.parent,
            "message_count": self.message_count,
        }


def _special_use_from_flags(flags: str) -> Optional[str]:
    """从 LIST flags 串提取 SPECIAL-USE 标志 (小写, 如 "\\sent")，无则 None。"""
    low = flags.lower()
    for su in ("\\inbox", "\\sent", "\\drafts", "\\junk", "\\trash", "\\archive", "\\all", "\\flagged"):
        if su in low:
            return su
    return None


def parse_list_line(line: bytes) -> Optional[FolderInfo]:
    """解析单行 IMAP LIST 响应 → FolderInfo (不含 message_count)。无法解析返回 None。"""
    if not line:
        return None
    m = _LIST_LINE_RE.match(line.strip())
    if not m:
        return None
    flags = m.group("flags").decode("ascii", "replace")
    delim_raw = m.group("delim").decode("ascii", "replace")
    delimiter = "" if delim_raw == "NIL" else delim_raw.strip('"')
    imap_name = m.group("name").decode("ascii", "replace").strip().strip('"')
    if not imap_name:
        return None
    special = _special_use_from_flags(flags)
    has_children = "haschildren" in flags.lower().replace("\\", "")
    is_system = imap_name.upper() == "INBOX" or (special in _SYSTEM_SPECIAL_USE)
    parent = None
    if delimiter and delimiter in imap_name:
        parent = imap_name.rsplit(delimiter, 1)[0]
    return FolderInfo(
        imap_name=imap_name,
        display_name=decode_imap_utf7(imap_name),
        delimiter=delimiter or "/",
        special_use=special,
        is_system=is_system,
        has_children=has_children,
        parent=parent,
    )


def parse_list_response(lines) -> list[FolderInfo]:
    """解析整段 IMAP LIST 响应 (list[bytes]) → list[FolderInfo]。跳过无法解析的行。"""
    out: list[FolderInfo] = []
    for line in lines or []:
        info = parse_list_line(line if isinstance(line, (bytes, bytearray)) else str(line).encode())
        if info is not None:
            out.append(info)
    return out


def _status_message_count(imap: imaplib.IMAP4, imap_name: str) -> Optional[int]:
    """STATUS <folder> (MESSAGES) → 邮件总数。失败返回 None (不阻断发现)。"""
    try:
        # imaplib 按 ASCII 编码 mailbox 名 (modified-UTF7 本就 ASCII); 但含空格的名字必须
        # quote, 否则被拆成多 atom → folder not found。
        typ, data = imap.status(quote_mailbox(imap_name), "(MESSAGES)")
        if typ == "OK" and data:
            m = re.search(rb"MESSAGES\s+(\d+)", data[0] if isinstance(data[0], (bytes, bytearray)) else str(data[0]).encode())
            if m:
                return int(m.group(1))
    except Exception as e:
        logger.debug(f"[imap-client] STATUS {imap_name!r} MESSAGES failed: {e}")
    return None


def list_folders(cfg: "Config", *, with_counts: bool = True, timeout: int = 30) -> list[FolderInfo]:
    """IMAP LIST 全部文件夹 → list[FolderInfo] (含层级 + 可选邮件数)。

    供 CLI ``folder discover`` / serve-api ``GET /api/folder/discover`` 调用。
    ``with_counts=False`` 时跳过逐文件夹 STATUS (快, 不含 message_count)。
    """
    with imap_session(cfg, timeout=timeout) as imap:
        typ, data = imap.list("", "*")
        if typ != "OK":
            raise DavMailConnectionError(f"IMAP LIST failed: {typ}")
        folders = parse_list_response(data)
        if with_counts:
            for fi in folders:
                fi.message_count = _status_message_count(imap, fi.imap_name)
    return folders


def build_folder_tree(folders: list[FolderInfo]) -> list[dict]:
    """把扁平 FolderInfo 列表按 delimiter 还原成嵌套树 (供前端 / serve-api)。

    返回顶层节点列表; 每节点 = ``{**folder.to_dict(), "children": [...]}``。孤儿节点
    (parent 不在列表里) 当顶层处理 (降级, 不丢)。顺序保持输入顺序。
    """
    by_name: dict[str, dict] = {}
    for fi in folders:
        node = fi.to_dict()
        node["children"] = []
        by_name[fi.imap_name] = node
    roots: list[dict] = []
    for fi in folders:
        node = by_name[fi.imap_name]
        parent = by_name.get(fi.parent) if fi.parent else None
        if parent is not None:
            parent["children"].append(node)
        else:
            roots.append(node)
    return roots
