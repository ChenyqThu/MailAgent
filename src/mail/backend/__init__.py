"""Mail backend abstraction — single-driver switch between AppleScript and DavMail.

详见 plan: `~/.claude/plans/ultrathink-docs-dual-backend-architectur-fluttering-bentley.md`
背景文档: `docs/archive/2026-05/dual-backend-architecture-handoff.md`

Public API:
    create_backend(cfg) -> IMailBackend       # factory, probe-or-raise
    IMailBackend (Protocol)                    # 真实消费面契约 (E1 收口, 见 e1-contract-inventory.md)
    BackendStartupError                        # probe 失败专用异常
    EmailContent / EmailMeta / RadarTick       # 共享 dataclass (backend 内部 / 遗留类型)
    BackendHealth / DraftAppendResult          # 遗留类型 + draft 返回
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
