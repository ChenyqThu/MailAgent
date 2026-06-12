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

import time
from typing import TYPE_CHECKING, Optional

from loguru import logger

from src.mail.backend.base import BackendStartupError, IMailBackend

if TYPE_CHECKING:
    from src.config import Config
    from src.mail.sync_store import SyncStore

# davmail probe 重试: 开机时序下登录项 App 比 pm2 davmail-poc 先就绪 (JVM 冷启
# ~30-60s), 首次 TCP probe Connection refused 不能直接判死. 5s × 24 ≈ 2 分钟窗口.
DAVMAIL_PROBE_RETRY_INTERVAL_S = 5.0
DAVMAIL_PROBE_MAX_ATTEMPTS = 24


def create_backend(
    cfg: "Config",
    sync_store: Optional["SyncStore"] = None,
    probe_max_attempts: int = 1,
) -> IMailBackend:
    """根据 cfg.mailagent_backend 创建 backend 实例并 probe.

    Args:
        cfg: 全局配置.
        sync_store: 可选 (AppleScript 不需要, DavMail 必需). 留 None 时如果
            backend_name='davmail' 会 raise BackendStartupError.
        probe_max_attempts: davmail probe 总尝试次数 (含首次). 默认 1 = 失败即抛
            (CLI 等调用方快速失败); serve 长驻服务传 DAVMAIL_PROBE_MAX_ATTEMPTS
            等 davmail JVM 冷启 (开机时序: 登录项 App 比 pm2 davmail-poc 先就绪).
            applescript 路径不受影响 (probe 失败 = Mail.app/FDA 问题, 等待无意义).

    Returns:
        已 probe 通过的 IMailBackend 实例.

    Raises:
        BackendStartupError: probe 失败 (重试耗尽). main.py 捕获后 print 切换提示 + exit(1).
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
    else:
        raise ValueError(
            f"unknown MAILAGENT_BACKEND={backend_name!r}, "
            f"expected 'applescript' or 'davmail'"
        )

    ok, detail = backend.probe_readiness()
    if not ok and backend_name == "davmail":
        # applescript 路径不重试 (probe 失败 = Mail.app/FDA 问题, 等待无意义)
        for attempt in range(2, probe_max_attempts + 1):
            logger.info(
                f"[backend-factory] davmail probe failed ({detail}), "
                f"retry {attempt}/{probe_max_attempts} "
                f"in {DAVMAIL_PROBE_RETRY_INTERVAL_S:.0f}s"
            )
            time.sleep(DAVMAIL_PROBE_RETRY_INTERVAL_S)
            ok, detail = backend.probe_readiness()
            if ok:
                logger.info(
                    f"[backend-factory] davmail probe recovered on attempt "
                    f"{attempt}/{probe_max_attempts}"
                )
                break
    if not ok:
        # 给出切换提示, main.py print 后 exit(1)
        if backend_name == "davmail":
            fallback = (
                "回退到 AppleScript: "
                "sed -i.bak 's/^MAILAGENT_BACKEND=.*/MAILAGENT_BACKEND=applescript/' .env "
                "&& pm2 restart mail-sync"
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
