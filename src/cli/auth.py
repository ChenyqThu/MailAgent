"""mailagent CLI 鉴权 (RFC v2 §5.3).

写命令默认要 token；服务端未配 token 时默认拒绝，除非 ``MAILAGENT_CLI_ALLOW_UNAUTH_WRITES=true`` 显式 opt-in。
"""

from __future__ import annotations

import hmac
import os
from typing import TYPE_CHECKING

from src.cli.exceptions import CliAuthError

if TYPE_CHECKING:
    from src.cli.context import CliContext


UNAUTH_OPT_IN_ENV = "MAILAGENT_CLI_ALLOW_UNAUTH_WRITES"


def require_auth(ctx: "CliContext") -> None:
    """写操作前调；失败 raise CliAuthError (exit 4).

    校验流程：
    1. 优先取 ``ctx.api_key`` (来自 ``--api-key`` flag)
    2. fallback ``MAILAGENT_CLI_API_KEY`` env (或 ``.env``，通过 ``ctx.cli_config``)
    3. 服务端未配 expected token:
       - 默认拒绝（防"忘配 = 无防护"）
       - 仅当 env ``MAILAGENT_CLI_ALLOW_UNAUTH_WRITES=true`` 时放行
    4. 配了 expected token: 用 ``hmac.compare_digest`` 比对 (防 timing attack)
    """
    expected = ctx.cli_config.mailagent_cli_api_key or os.environ.get(
        "MAILAGENT_CLI_API_KEY", ""
    )
    provided = ctx.api_key or os.environ.get("MAILAGENT_CLI_API_KEY", "")

    if not expected:
        if os.environ.get(UNAUTH_OPT_IN_ENV, "").lower() == "true":
            return
        raise CliAuthError(
            "MAILAGENT_CLI_API_KEY not configured. "
            f"Set it or export {UNAUTH_OPT_IN_ENV}=true to allow unauthenticated writes."
        )

    if not provided or not hmac.compare_digest(expected, provided):
        raise CliAuthError("Invalid or missing API key")
