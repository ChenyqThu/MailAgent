"""Transport-neutral Skill 错误 —— 不 import fastapi（让 MCP/CLI 也能直接用 registry）。

``code`` 复用 error-codes.md 的 ``E_*`` enum，HTTP 适配器（``src/api/routers/skills.py``）
据 ``http_status`` 直接落 envelope；MCP 适配器据 ``code`` 转 JSON-RPC error。
"""

from __future__ import annotations

from typing import Any, Optional

# code → HTTP status（与 src/api/app.ERROR_CODE_TO_HTTP 对齐，但不 import app 保持
# transport-neutral）。未知 code → 400。
_CODE_HTTP: dict[str, int] = {
    "E_NOT_FOUND": 404,
    "E_INVALID_ARG": 400,
    "E_AUTH_FAILED": 403,
    "E_PM2_RUNNING": 409,
    "E_CONFLICT": 409,
    "E_UPSTREAM": 502,
    "E_LLM_FAILED": 500,
    "E_INTERNAL": 500,
    "E_NOT_IMPLEMENTED": 400,
}


def http_for_code(code: str) -> int:
    return _CODE_HTTP.get(code, 400)


class SkillError(Exception):
    """Skill 调用域错误（unknown skill/tool / scope deny / confirmation / 输入非法 / 下游失败）。"""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        http_status: int = 400,
        hint: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status
        self.hint = hint

    @classmethod
    def from_service(cls, exc: Any) -> "SkillError":
        """从 ServiceError（src/services/errors.py）映成 SkillError（按 code 推 http_status）。"""
        code = getattr(exc, "code", "E_INTERNAL")
        return cls(
            code,
            getattr(exc, "message", str(exc)),
            http_status=http_for_code(code),
            hint=getattr(exc, "hint", None),
        )
