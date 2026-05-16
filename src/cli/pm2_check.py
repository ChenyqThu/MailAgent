"""PM2 conflict check (RFC v2 §5.2 exit 9 / PR-4 §2.2).

写命令启动前调 ``check_pm2_conflict(cli)``; 检到 ``mail-sync`` online → 抛
``CliPM2ConflictError`` (exit 9). 通过 ``--allow-concurrent`` 或 env
``MAILAGENT_CLI_ALLOW_CONCURRENT=true`` 绕过.

PM2 不可用 (FileNotFoundError / timeout / JSON parse err) → graceful skip + warning,
不阻塞 CLI (RFC §2.2 风险表批准).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import TYPE_CHECKING

from src.cli.exceptions import CliPM2ConflictError

if TYPE_CHECKING:
    from src.cli.context import CliContext


PM2_CMD = "pm2"
PM2_TIMEOUT = 5.0
TARGET_PROC = "mail-sync"
ENV_BYPASS = "MAILAGENT_CLI_ALLOW_CONCURRENT"


def check_pm2_conflict(
    cli: "CliContext",
    *,
    allow_concurrent: bool = False,
    runner=None,
) -> None:
    """检测 PM2 ``mail-sync`` 是否在跑.

    Args:
        cli: CliContext (用于 stderr warning, 测试可注入 mock)
        allow_concurrent: True 绕过检测; env ``MAILAGENT_CLI_ALLOW_CONCURRENT=true`` 同效
        runner: 可选, 测试注入 subprocess 替身, 默认 ``subprocess.run``

    Raises:
        CliPM2ConflictError: ``mail-sync`` 进程 status='online'
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
        # pm2 not installed → 当地无 PM2, 不冲突
        _warn(cli, "pm2 not installed; skipping conflict check")
        return
    except subprocess.TimeoutExpired:
        _warn(cli, f"pm2 jlist timed out (>{PM2_TIMEOUT}s); skipping conflict check")
        return
    except Exception as exc:  # pragma: no cover - 其他 OS 错
        _warn(cli, f"pm2 jlist failed ({type(exc).__name__}: {exc}); skipping")
        return

    if getattr(result, "returncode", 0) != 0:
        _warn(cli, f"pm2 jlist exit {result.returncode}; skipping conflict check")
        return

    try:
        procs = json.loads(result.stdout or "[]")
    except (json.JSONDecodeError, TypeError):
        _warn(cli, "pm2 jlist output not JSON; skipping conflict check")
        return

    for proc in procs:
        if not isinstance(proc, dict):
            continue
        name = proc.get("name")
        env = proc.get("pm2_env") or {}
        status = env.get("status")
        if name == TARGET_PROC and status == "online":
            raise CliPM2ConflictError(
                f"PM2 {TARGET_PROC} is online; concurrent writes may corrupt SyncStore.",
                hint=(
                    f"Stop pm2 first ('pm2 stop {TARGET_PROC}') or pass "
                    f"--allow-concurrent / export {ENV_BYPASS}=true"
                ),
                context={"pm2_proc": name, "pm2_status": status},
            )


def _warn(cli, message: str) -> None:
    """非致命 warning, 写 stderr."""
    if cli is None or not getattr(cli, "verbose", False):
        # PR-4 §2.2 风险表: pm2 不可用应静默跳过 + log warning;
        # verbose 模式才推到 stderr 避免污染 agent JSON stream.
        return
    print(f"[pm2-check] WARN: {message}", file=sys.stderr)
