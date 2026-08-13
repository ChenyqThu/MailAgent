"""create_backend(cfg, sync_store) — 根据 cfg.mailagent_backend 创建实例 + probe.

main.py 启动序列:
    sync_store = SyncStore(...)
    backend = create_backend(config, sync_store)  # probe 失败 raise BackendStartupError
    watcher = MailWatcher(backend=backend, sync_store=sync_store, ...)

切换协议详见 plan §"Single-Driver 切换的运维契约".

为什么 backend 需要 sync_store: DavMailBackend.fetch_email_by_id(internal_id) 需要查
SyncStore 拿 (imap_uidvalidity, imap_uid) 副字段; NULL fallback 时用 message_id 反查
IMAP SEARCH HEADER. AppleScriptBackend 用不到, 接受同样签名是为了 factory 调用统一.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from loguru import logger

from src.mail.backend.base import BackendStartupError, IMailBackend

if TYPE_CHECKING:
    from src.config import Config
    from src.mail.sync_store import SyncStore


def create_backend(
    cfg: "Config", sync_store: Optional["SyncStore"] = None
) -> IMailBackend:
    """根据 cfg.mailagent_backend 创建 backend 实例并 probe.

    Args:
        cfg: 全局配置.
        sync_store: 可选 (AppleScript 不需要, DavMail 必需). 留 None 时如果
            backend_name='davmail' 会 raise BackendStartupError.

    Returns:
        已 probe 通过的 IMailBackend 实例.

    Raises:
        BackendStartupError: probe 失败. main.py 捕获后 print 切换提示 + exit(1).
        ValueError: cfg.mailagent_backend 是未知值.
    """
    backend_name = getattr(cfg, "mailagent_backend", "applescript")
    logger.info(f"[backend-factory] creating backend={backend_name!r}")

    if backend_name == "applescript":
        from src.mail.backend.applescript_backend import AppleScriptBackend

        backend: IMailBackend = AppleScriptBackend(cfg, sync_store=sync_store)
    elif backend_name == "davmail":
        if sync_store is None:
            raise BackendStartupError(
                backend=backend_name,
                reason="DavMailBackend requires sync_store (for imap_uid lookup)",
                fallback_hint="Pass sync_store kwarg to create_backend()",
            )
        from src.mail.backend.davmail_backend import DavMailBackend

        backend = DavMailBackend(cfg, sync_store=sync_store)
    elif backend_name == "outlook_com":
        # task 08-12: Windows classic Outlook COM (pywin32)。平台闸在 import 前 ——
        # mac/linux 上 pywin32 不存在, 提前给出清晰错误而非 ImportError 噪音。
        import sys

        if sys.platform != "win32":
            raise BackendStartupError(
                backend=backend_name,
                reason=(
                    f"outlook_com backend 仅支持 Windows (当前 sys.platform={sys.platform!r}); "
                    "它驱动本机 classic Outlook 的 COM 对象模型"
                ),
                fallback_hint=(
                    "macOS 请用 MAILAGENT_BACKEND=applescript 或 davmail"
                ),
            )
        if sync_store is None:
            raise BackendStartupError(
                backend=backend_name,
                reason="OutlookComBackend requires sync_store (for entry_id/internal_id)",
                fallback_hint="Pass sync_store kwarg to create_backend()",
            )
        from src.mail.backend.outlook_com_backend import OutlookComBackend

        backend = OutlookComBackend(cfg, sync_store=sync_store)
    else:
        raise ValueError(
            f"unknown MAILAGENT_BACKEND={backend_name!r}, "
            f"expected 'applescript', 'davmail' or 'outlook_com'"
        )

    ok, detail = backend.probe_readiness()
    if not ok:
        # 给出切换提示, main.py print 后 exit(1)
        if backend_name == "davmail":
            fallback = (
                "回退到 AppleScript: "
                "sed -i.bak 's/^MAILAGENT_BACKEND=.*/MAILAGENT_BACKEND=applescript/' .env "
                "&& pm2 restart mail-sync"
            )
        elif backend_name == "outlook_com":
            fallback = (
                "确认本机安装并登录 classic Outlook (New Outlook/olk.exe 无 COM 接口), "
                "且 pywin32 已安装; 或切换 MAILAGENT_BACKEND=davmail"
            )
        else:
            fallback = (
                "AppleScript backend probe 失败通常意味着 Mail.app 未运行或 Full Disk Access "
                "权限缺失. 检查: pgrep -x Mail; ls ~/Library/Mail/V*/MailData/Envelope\\ Index"
            )
        raise BackendStartupError(
            backend=backend_name,
            reason=detail,
            fallback_hint=fallback,
        )

    logger.info(f"[backend-factory] backend={backend_name!r} probe ok: {detail}")
    return backend
