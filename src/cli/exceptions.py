"""mailagent CLI 异常 + exit_code 映射 (RFC v2 §5.2).

CLI 传输专属层:每个 ``CliError`` 子类 = 一个 transport-neutral ``ServiceError``
(src/services/errors.py) + CLI 的 ``exit_code`` (int)。退出码是 CLI transport 的关注
点,故 ``ServiceError`` 不带 exit_code,而由本模块的 ``CliXxxError`` 子类 +
``CODE_TO_EXIT`` 表承载。

``CliError(ServiceError)`` 让 ``except ServiceError`` 能同时捕获 service 抛的
``ServiceError`` 与 CLI 抛的 ``CliError``;121 处 ``raise CliXxxError(...)`` 调用点
零改动 (code / exit_code 逐字段不变)。
"""

from __future__ import annotations

from src.services.errors import ServiceError


class CliError(ServiceError):
    """所有 CLI 异常的基类。= ``ServiceError`` (code/message/hint/context) + CLI exit_code。"""

    code: str = "E_INTERNAL"
    exit_code: int = 1


class CliAuthError(CliError):
    """写命令缺 API key / token 不匹配 (RFC §5.2 exit 4)."""
    code = "E_AUTH_FAILED"
    exit_code = 4


class CliNotFoundError(CliError):
    """资源 (邮件 / 附件 / page) 找不到 (RFC §5.2 exit 1)."""
    code = "E_NOT_FOUND"
    exit_code = 1


class CliInvalidArgError(CliError):
    """参数非法 / 互斥 / 范围超出 (RFC §5.2 exit 2)."""
    code = "E_INVALID_ARG"
    exit_code = 2


class CliSchemaError(CliError):
    """DB schema mismatch / db_version 不一致 (RFC §5.2 exit 5)."""
    code = "E_SCHEMA_MISMATCH"
    exit_code = 5


class CliPartialFailureError(CliError):
    """batch 命令部分成功部分失败 (RFC §5.2 exit 6) — PR-4 范围占位。"""
    code = "E_PARTIAL_FAILURE"
    exit_code = 6


class CliAbortedError(CliError):
    """SIGINT / SIGTERM 主动退出 (RFC §5.2 exit 7) — PR-4 范围。"""
    code = "E_ABORTED"
    exit_code = 7


class CliMaxFailuresError(CliError):
    """长任务连续失败超 ``--max-failures`` 熔断 (RFC §5.2 exit 8) — PR-4 范围。"""
    code = "E_MAX_FAILURES"
    exit_code = 8


class CliPM2ConflictError(CliError):
    """写命令检测到 PM2 ``mail-sync`` 在跑 (RFC §5.2 exit 9) — PR-4 范围。"""
    code = "E_PM2_RUNNING"
    exit_code = 9


class CliLLMFailedError(CliError):
    """LLM gateway 调用失败 / 模型链耗尽 / Notion 写失败 (PR-3 §4.4)."""
    code = "E_LLM_FAILED"
    exit_code = 1


class CliNotImplementedError(CliError):
    """命令存在但 PR-3 仅 stub, 完整实现在后续 PR (PR-3 §4.4 compare-paths 等)."""
    code = "E_NOT_IMPLEMENTED"
    exit_code = 2


# code → CLI exit code。service 层抛的 transport-neutral ``ServiceError`` 没有
# ``exit_code``,CLI adapter (src/cli/output.py::emit_cli_error) 用此表按 ``code`` 回填。
# 值与上面各 ``CliXxxError.exit_code`` 严格一致 (改一处必同步另一处)。
CODE_TO_EXIT: dict[str, int] = {
    "E_INTERNAL": 1,
    "E_AUTH_FAILED": 4,
    "E_NOT_FOUND": 1,
    "E_INVALID_ARG": 2,
    "E_SCHEMA_MISMATCH": 5,
    "E_PARTIAL_FAILURE": 6,
    "E_ABORTED": 7,
    "E_MAX_FAILURES": 8,
    "E_PM2_RUNNING": 9,
    "E_LLM_FAILED": 1,
    "E_NOT_IMPLEMENTED": 2,
}
