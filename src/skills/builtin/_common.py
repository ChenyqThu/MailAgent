"""contacts / library / matter_lookup / agents 四个 builtin 共用的入参校验与错误归一。

不是 skill（registry 不登记它）。入参纪律同 calendar / search / report：越界一律
``E_INVALID_ARG``，**在碰任何数据依赖之前**判定，不静默 clamp（契约闸
``tests/skills/test_tooldef_contract.py`` §F 用「炸 ctx」验证这一点）。
"""

from __future__ import annotations

from typing import Any, Optional, Sequence

from src.skills.errors import SkillError, http_for_code


def api_router(name: str) -> Any:
    """lazy 取一个 serve-api 路由模块（``src.api.routers.<name>``）。

    先加载 ``src.api.app``：路由模块顶层 import app，app 又 import 全部路由；从路由模块直接进入会撞
    循环 import（serve-api 进程里 app 早已加载，这里只在测试 / in-process 客户端首次调用时起作用）。
    """
    import importlib

    importlib.import_module("src.api.app")
    return importlib.import_module(f"src.api.routers.{name}")


def _invalid(message: str) -> SkillError:
    return SkillError("E_INVALID_ARG", message, http_status=400)


def int_arg(
    params: dict[str, Any], key: str, *, default: Optional[int], lo: int, hi: Optional[int] = None
) -> Optional[int]:
    """可选整数参数：缺省 → ``default``；非整数 / 越界 → ``E_INVALID_ARG``。"""
    raw = params.get(key)
    if raw is None:
        return default
    if isinstance(raw, bool) or (isinstance(raw, float) and not raw.is_integer()):
        raise _invalid(f"{key} must be an integer")
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise _invalid(f"{key} must be an integer") from None
    if value < lo or (hi is not None and value > hi):
        raise _invalid(f"{key} must be {lo}..{hi}" if hi is not None else f"{key} must be >= {lo}")
    return value


def required_int(params: dict[str, Any], key: str, *, lo: int = 1) -> int:
    value = int_arg(params, key, default=None, lo=lo)
    if value is None:
        raise _invalid(f"{key} is required")
    return value


def enum_arg(
    params: dict[str, Any], key: str, values: Sequence[str], default: Optional[str]
) -> Optional[str]:
    raw = params.get(key)
    if raw is None:
        return default
    if raw not in values:
        raise _invalid(f"{key} must be one of {list(values)}")
    return str(raw)


def str_arg(
    params: dict[str, Any], key: str, *, max_len: int, required: bool = False
) -> Optional[str]:
    """字符串参数（trim 后非空且 ≤ ``max_len``）。可选参数缺省 / 空白 → ``None``。"""
    raw = params.get(key)
    if raw is None:
        if required:
            raise _invalid(f"{key} is required")
        return None
    if not isinstance(raw, str):
        raise _invalid(f"{key} must be a string")
    value = raw.strip()
    if not value:
        if required:
            raise _invalid(f"{key} must be non-empty")
        return None
    if len(value) > max_len:
        raise _invalid(f"{key} must be at most {max_len} characters")
    return value


def cap_list(rows: Any, cap: int) -> tuple[list[Any], bool]:
    """子列表固定上限（投影层的裁剪，配 ``truncated`` 标记一起返回，不是对调用方参数的静默截断）。"""
    items = list(rows or [])
    return items[:cap], len(items) > cap


def domain_error(exc: Any) -> SkillError:
    """域异常（ContactError / LibraryError / MatterError / APIError）→ SkillError。

    各域「找不到」的码各不相同（``E_CONTACT_NOT_FOUND`` / ``E_MATTER_NOT_FOUND`` …），对外统一成
    ``E_NOT_FOUND``（404）；其余 code 原样带出，HTTP 状态取异常自带的（APIError）或按 code 推。
    """
    code = str(getattr(exc, "code", "E_INTERNAL") or "E_INTERNAL")
    message = str(getattr(exc, "message", None) or exc)
    hint = getattr(exc, "hint", None)
    if code.endswith("_NOT_FOUND"):
        return SkillError("E_NOT_FOUND", message, http_status=404, hint=hint)
    status = getattr(exc, "http_status", None)
    return SkillError(
        code, message, http_status=int(status) if isinstance(status, int) else http_for_code(code), hint=hint
    )
