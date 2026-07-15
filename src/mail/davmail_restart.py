"""DavMail 自动恢复动作 (L2b, fork 31a50011 上游化) — pm2 restart callback 实现.

watchdog 检测到 IMAP LOGIN 持续失败 (token 劣化) 后的恢复策略实现。watchdog 本体
只认可注入的 ``restart_callback`` (默认 None = 仅告警), **不硬编码 pm2** —— 本模块
是「davmail-poc 归 pm2 管」部署形态的 callback 实现 (pm2 mail-sync 与打包 .app
两种形态下 davmail-poc 都留在 pm2, 见 CLAUDE.md 打包节)。

service.py 按 ``DAVMAIL_AUTO_RESTART_ENABLED`` (默认 false, 破坏性动作保守) gate
经 ``build_restart_callback(cfg)`` 注入。pm2 二进制解析不到 (无 node 环境) 时
callback 返回 ``(False, "pm2 not found...")`` → watchdog 降级为仅告警, 不误伤。
"""
from __future__ import annotations

import asyncio
import os
import shutil
from pathlib import Path
from typing import TYPE_CHECKING, Awaitable, Callable, Optional

from loguru import logger

if TYPE_CHECKING:
    from src.config import Config

# 打包 App 经 launchd 启动, PATH 不含 homebrew/node bin, shutil.which 找不到
# pm2 时按固定路径兜底 (同 office_converter 找 soffice 的套路)。
_PM2_FALLBACK_PATHS = ("/opt/homebrew/bin/pm2", "/usr/local/bin/pm2")
_PM2_PROCESS_NAME = "davmail-poc"
_PM2_RESTART_TIMEOUT_SECS = 60


def _resolve_pm2() -> Optional[str]:
    found = shutil.which("pm2")
    if found:
        return found
    for cand in _PM2_FALLBACK_PATHS:
        if Path(cand).exists():
            return cand
    return None


def _subprocess_env() -> dict[str, str]:
    """pm2 执行环境 — PATH 前置 node/pm2 常见目录 (F3).

    pm2 是 ``#!/usr/bin/env node`` shebang 脚本 (实测 /opt/homebrew/bin/pm2):
    打包 .app 经 launchd 启动时 PATH 只有系统路径, ``env`` 找不到 node →
    ``pm2 restart`` 恒 exit 127。node 与 pm2 同目录, 前置 fallback 目录即可。
    """
    env = dict(os.environ)
    prefix = ":".join(str(Path(p).parent) for p in _PM2_FALLBACK_PATHS)
    cur = env.get("PATH", "")
    env["PATH"] = f"{prefix}:{cur}" if cur else prefix
    return env


async def restart_davmail_via_pm2(
    process_name: str = _PM2_PROCESS_NAME,
) -> tuple[bool, str]:
    """执行 ``pm2 restart <process_name>``, 返回 (成功, 详情)。从不抛异常。"""
    pm2 = _resolve_pm2()
    if pm2 is None:
        return False, (
            "pm2 not found (PATH + " + " / ".join(_PM2_FALLBACK_PATHS) + ")"
        )
    try:
        proc = await asyncio.create_subprocess_exec(
            pm2,
            "restart",
            process_name,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=_subprocess_env(),
        )
        try:
            _, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=_PM2_RESTART_TIMEOUT_SECS
            )
        except asyncio.TimeoutError:
            proc.kill()
            return False, f"pm2 restart timed out ({_PM2_RESTART_TIMEOUT_SECS}s)"
        if proc.returncode != 0:
            err = (stderr or b"").decode(errors="replace").strip()[:200]
            return False, f"exit {proc.returncode}: {err}"
        return True, "exit 0"
    except Exception as e:  # noqa: BLE001 — 自愈动作失败不能挂 watchdog
        logger.warning(f"[davmail-restart] pm2 restart failed: {e}")
        return False, f"{type(e).__name__}: {e}"


def build_restart_callback(
    cfg: "Config",
) -> Optional[Callable[[], Awaitable[tuple[bool, str]]]]:
    """按 ``cfg.davmail_auto_restart_enabled`` gate 返回 restart callback (或 None)。

    None = watchdog 仅告警不自动重启 (默认)。
    """
    if not getattr(cfg, "davmail_auto_restart_enabled", False):
        return None
    return restart_davmail_via_pm2
