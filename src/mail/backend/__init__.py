"""Mail backend abstraction — single-driver switch between AppleScript and DavMail.

详见 plan: `~/.claude/plans/ultrathink-docs-dual-backend-architectur-fluttering-bentley.md`
背景文档: `docs/dual-backend-architecture-handoff.md`

Public API:
    create_backend(cfg) -> IMailBackend       # factory, probe-or-raise
    IMailBackend (Protocol)                    # 8-method contract
    BackendStartupError                        # probe 失败专用异常
    EmailContent / EmailMeta / RadarTick       # 共享 dataclass
    BackendHealth / DraftAppendResult          # 健康检查 + draft 返回
    BackendOrigin                              # Literal['applescript', 'davmail']
"""
from __future__ import annotations

from src.mail.backend.base import BackendStartupError, IMailBackend
from src.mail.backend.factory import create_backend
from src.mail.backend.types import (
    BackendHealth,
    BackendOrigin,
    DraftAppendResult,
    DraftMode,
    DraftRequest,
    EmailContent,
    EmailMeta,
    RadarTick,
    SendResult,
)

__all__ = [
    "BackendHealth",
    "BackendOrigin",
    "BackendStartupError",
    "DraftAppendResult",
    "DraftMode",
    "DraftRequest",
    "EmailContent",
    "EmailMeta",
    "IMailBackend",
    "RadarTick",
    "SendResult",
    "create_backend",
]
