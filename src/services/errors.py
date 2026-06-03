"""Transport-neutral service-layer errors (RFC v2 §5.2 error codes).

``ServiceError`` 携带 string ``code`` (E_* enum,被每个传输的错误映射共享) +
message/hint/context。它**故意不带** ``exit_code`` —— 退出码是 CLI 传输的关注点
(见 src/cli/exceptions.py 的 ``CODE_TO_EXIT``);FastAPI 把 ``code`` 经
src/api/app.py 的 ``ERROR_CODE_TO_HTTP`` 映成 HTTP status。

CLI 的 ``CliError`` 体系 subclass ``ServiceError`` (额外带 exit_code),于是:
  - service 方法 ``raise ServiceNotFoundError(...)``,CLI 适配器 ``except ServiceError``
    一并捕获 service 抛的 + 任何残留的 CliError;
  - 121 处 ``raise CliXxxError(...)`` 现存调用点零改动。
"""

from __future__ import annotations

from typing import Any, Optional


class ServiceError(Exception):
    """所有 service 层异常的基类。携带 string ``code`` + message/hint/context。"""

    code: str = "E_INTERNAL"

    def __init__(
        self,
        message: str,
        *,
        hint: Optional[str] = None,
        context: Optional[dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint
        self.context = context or {}


class ServiceNotFoundError(ServiceError):
    """资源 (邮件 / 附件 / page) 找不到。"""
    code = "E_NOT_FOUND"


class ServiceInvalidArgError(ServiceError):
    """参数非法 / 互斥 / 范围超出。"""
    code = "E_INVALID_ARG"


class ServiceAuthError(ServiceError):
    """写操作缺鉴权主体 / token 不匹配。"""
    code = "E_AUTH_FAILED"


class ServiceSchemaError(ServiceError):
    """DB schema mismatch / db_version 不一致。"""
    code = "E_SCHEMA_MISMATCH"


class ServicePartialFailureError(ServiceError):
    """batch 操作部分成功部分失败。"""
    code = "E_PARTIAL_FAILURE"


class ServiceAbortedError(ServiceError):
    """SIGINT / SIGTERM 主动退出。"""
    code = "E_ABORTED"


class ServiceMaxFailuresError(ServiceError):
    """长任务连续失败超阈值熔断。"""
    code = "E_MAX_FAILURES"


class ServicePM2ConflictError(ServiceError):
    """检测到 PM2 ``mail-sync`` 在跑,拒绝并发写。"""
    code = "E_PM2_RUNNING"


class ServiceLLMFailedError(ServiceError):
    """LLM gateway 调用失败 / 模型链耗尽 / Notion 写失败。"""
    code = "E_LLM_FAILED"


class ServiceNotImplementedError(ServiceError):
    """命令/能力存在但仅 stub。"""
    code = "E_NOT_IMPLEMENTED"
