"""内存会话管理 — messages 历史 + TTL 自动清理。"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

from loguru import logger

from .schemas import EmailContext

_SESSION_TTL = 1800  # 30 min
_CLEANUP_INTERVAL = 300  # 5 min


@dataclass
class Session:
    session_id: str
    messages: list[dict[str, Any]] = field(default_factory=list)
    email_context: Optional[EmailContext] = None
    created_at: float = field(default_factory=time.time)
    last_active: float = field(default_factory=time.time)

    def touch(self) -> None:
        self.last_active = time.time()

    @property
    def expired(self) -> bool:
        return (time.time() - self.last_active) > _SESSION_TTL


class SessionManager:
    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}
        self._cleanup_task: Optional[asyncio.Task[None]] = None

    def start_cleanup(self) -> None:
        if self._cleanup_task is None:
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def stop_cleanup(self) -> None:
        if self._cleanup_task:
            self._cleanup_task.cancel()
            self._cleanup_task = None

    def get_or_create(
        self,
        session_id: Optional[str],
        email_context: Optional[EmailContext] = None,
    ) -> Session:
        if session_id and session_id in self._sessions:
            sess = self._sessions[session_id]
            sess.touch()
            if email_context:
                sess.email_context = email_context
            return sess

        new_id = session_id or uuid.uuid4().hex[:12]
        sess = Session(session_id=new_id, email_context=email_context)
        self._sessions[new_id] = sess
        return sess

    def delete(self, session_id: str) -> bool:
        return self._sessions.pop(session_id, None) is not None

    def count(self) -> int:
        return len(self._sessions)

    async def _cleanup_loop(self) -> None:
        while True:
            await asyncio.sleep(_CLEANUP_INTERVAL)
            expired = [
                sid for sid, s in self._sessions.items() if s.expired
            ]
            for sid in expired:
                del self._sessions[sid]
            if expired:
                logger.debug(f"[agent-session] cleaned {len(expired)} expired sessions")


session_manager = SessionManager()
