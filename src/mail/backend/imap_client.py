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
import re
import smtplib
import socket
from contextlib import contextmanager
from typing import TYPE_CHECKING, Iterator, Optional

from loguru import logger

if TYPE_CHECKING:
    from src.config import Config


class DavMailConnectionError(RuntimeError):
    """DavMail 连接/认证失败."""


# IMAP LIST 响应里 \\Drafts SPECIAL-USE 标志的正则 (RFC 6154)
_DRAFTS_FLAG_PATTERN = re.compile(rb"\\Drafts", re.IGNORECASE)


def get_cipher_key(cfg: "Config") -> str:
    """从配置拿 DavMail cipher key (StringEncryptor password).

    优先 cfg.davmail_cipher_key, fallback `davmail-poc/` 的默认值 (兼容现有 PoC 实例).
    """
    val = getattr(cfg, "davmail_cipher_key", "") or ""
    if not val:
        val = "mailagent-poc-shared-key"
    return val


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

    # Fallback: 试常见名字
    for candidate in ("INBOX/Drafts", "Drafts", "草稿", "[Gmail]/Drafts"):
        try:
            typ, _ = imap.select(candidate, readonly=True)
            if typ == "OK":
                imap.close()
                logger.debug(f"[imap-client] found Drafts via fallback: {candidate!r}")
                return candidate
        except Exception:
            continue

    logger.warning("[imap-client] could not discover Drafts folder")
    return None
