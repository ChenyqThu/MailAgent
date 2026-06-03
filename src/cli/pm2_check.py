"""PM2 conflict check —— CLI 适配 shim (RFC v2 §5.2 exit 9 / PR-4 §2.2).

实现已下沉到 transport-neutral 的 ``src/services/guards.py::check_pm2_conflict``
(抛中性 ``ServicePM2ConflictError``)。本模块保留旧公开签名
``check_pm2_conflict(cli, *, allow_concurrent, runner)`` + 常量 ``ENV_BYPASS`` 等,
并把中性异常转回 ``CliPM2ConflictError`` (exit 9),让现存命令调用点 +
``tests/cli/test_pm2_check.py`` (``pytest.raises(CliPM2ConflictError)``) 零改动。

PM2 不可用 (FileNotFoundError / timeout / JSON parse err) → graceful skip + warning,
不阻塞 CLI (RFC §2.2 风险表批准)。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from src.cli.exceptions import CliPM2ConflictError
from src.services.errors import ServicePM2ConflictError
from src.services.guards import (  # 常量从单一真源 re-export (测试 import ENV_BYPASS)
    ENV_BYPASS,
    PM2_CMD,
    PM2_TIMEOUT,
    TARGET_PROC,
)
from src.services.guards import check_pm2_conflict as _check_pm2_conflict

if TYPE_CHECKING:
    from src.cli.context import CliContext

__all__ = ["check_pm2_conflict", "ENV_BYPASS", "PM2_CMD", "PM2_TIMEOUT", "TARGET_PROC"]


def check_pm2_conflict(
    cli: "CliContext" = None,
    *,
    allow_concurrent: bool = False,
    runner=None,
) -> None:
    """检测 PM2 ``mail-sync`` 是否在跑 (CLI shim over services.guards)。

    Args:
        cli: CliContext (仅用于 verbose stderr warning; 测试可传 None)
        allow_concurrent: True 绕过检测; env ``MAILAGENT_CLI_ALLOW_CONCURRENT=true`` 同效
        runner: 可选, 测试注入 subprocess 替身, 默认 ``subprocess.run``

    Raises:
        CliPM2ConflictError: ``mail-sync`` 进程 status='online' (exit 9)
    """
    try:
        _check_pm2_conflict(
            allow_concurrent=allow_concurrent,
            verbose=getattr(cli, "verbose", False),
            runner=runner,
        )
    except ServicePM2ConflictError as e:
        # 转回 CLI 专属异常,保 exit 9 + ``except CliError`` / pytest.raises 契约。
        raise CliPM2ConflictError(e.message, hint=e.hint, context=e.context) from None
