"""Transport-neutral 写守卫: Actor 鉴权 + pm2 冲突检测 (RFC v2 §5.2/§5.3).

每个写路径无论来自哪个传输都必须过的检查。CLI / FastAPI 适配器各自构造一个
``Actor`` (CLI 用 ``--api-key`` token 校验; HTTP 用 CF Access / 本地 token),service
方法入口调 ``require_write_auth(actor)`` + ``check_pm2_conflict(...)``。

pm2 逻辑的单一真源在此; ``src/cli/pm2_check.py`` 退化成保留旧签名 + 把中性
``ServicePM2ConflictError`` 转回 ``CliPM2ConflictError`` 的薄 shim。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass

from src.services.errors import ServiceAuthError, ServicePM2ConflictError

# pm2 冲突检测常量 (沿用历史 src/cli/pm2_check.py 的值)。
PM2_CMD = "pm2"
PM2_TIMEOUT = 5.0
TARGET_PROC = "mail-sync"
ENV_BYPASS = "MAILAGENT_CLI_ALLOW_CONCURRENT"


@dataclass(frozen=True)
class Actor:
    """执行一次写操作的已鉴权主体。传输层负责构造它,service 只检 ``authenticated``。

    Args:
        kind: 'cli' | 'http' | 'system'
        authenticated: 传输层是否已完成鉴权
        label: 审计/日志用 (cli token / cf-access email / 'mail-sync')
    """

    kind: str
    authenticated: bool
    label: str = ""


def require_write_auth(actor: Actor) -> None:
    """service 入口的防御性鉴权门。未鉴权抛 ``ServiceAuthError`` (CLI→exit 4 / HTTP→403)。"""
    if not actor.authenticated:
        raise ServiceAuthError("write requires an authenticated actor")


def check_pm2_conflict(
    *,
    allow_concurrent: bool = False,
    verbose: bool = False,
    runner=None,
) -> None:
    """PM2 ``mail-sync`` online 时抛 ``ServicePM2ConflictError`` (并发写可能损坏 SyncStore)。

    ``allow_concurrent=True`` 或 env ``MAILAGENT_CLI_ALLOW_CONCURRENT=true`` 绕过。
    pm2 不可用 (未装 / timeout / 非 JSON / 非零退出) → graceful skip (verbose 才写
    stderr warning),不阻塞 (RFC §2.2 风险表批准)。

    Args:
        allow_concurrent: True 绕过检测
        verbose: True 时把 skip 原因写 stderr
        runner: 可选,测试注入 subprocess 替身,默认 ``subprocess.run``
    """
    if allow_concurrent:
        return
    if os.environ.get(ENV_BYPASS, "").lower() == "true":
        return

    run = runner or subprocess.run
    try:
        result = run(
            [PM2_CMD, "jlist"],
            capture_output=True,
            text=True,
            timeout=PM2_TIMEOUT,
        )
    except FileNotFoundError:
        _warn(verbose, "pm2 not installed; skipping conflict check")
        return
    except subprocess.TimeoutExpired:
        _warn(verbose, f"pm2 jlist timed out (>{PM2_TIMEOUT}s); skipping conflict check")
        return
    except Exception as exc:  # pragma: no cover - 其他 OS 错
        _warn(verbose, f"pm2 jlist failed ({type(exc).__name__}: {exc}); skipping")
        return

    if getattr(result, "returncode", 0) != 0:
        _warn(verbose, f"pm2 jlist exit {result.returncode}; skipping conflict check")
        return

    try:
        procs = json.loads(result.stdout or "[]")
    except (json.JSONDecodeError, TypeError):
        _warn(verbose, "pm2 jlist output not JSON; skipping conflict check")
        return

    for proc in procs:
        if not isinstance(proc, dict):
            continue
        name = proc.get("name")
        env = proc.get("pm2_env") or {}
        status = env.get("status")
        if name == TARGET_PROC and status == "online":
            raise ServicePM2ConflictError(
                f"PM2 {TARGET_PROC} is online; concurrent writes may corrupt SyncStore.",
                hint=(
                    f"Stop pm2 first ('pm2 stop {TARGET_PROC}') or pass "
                    f"--allow-concurrent / export {ENV_BYPASS}=true"
                ),
                context={"pm2_proc": name, "pm2_status": status},
            )


def _warn(verbose: bool, message: str) -> None:
    """非致命 warning, 仅 verbose 时写 stderr (避免污染 agent 的 JSON stream)。"""
    if verbose:
        print(f"[pm2-check] WARN: {message}", file=sys.stderr)
