"""In-memory session registry for stateful MailAgent MCP HTTP/SSE transports.

Deployment assumption:
  - MailAgent ``serve-api`` runs as a **single-worker** ``uvicorn`` process
    attached to Electron / local daemon, so session state lives in-process
    memory (``app.state.mcp_session_manager`` / module singleton). Multi-worker
    horizontal scaling without sticky sessions is NOT supported.

Security guarantees (fail-closed):
  - High-entropy session IDs via ``secrets.token_urlsafe(24)``.
  - Every session is bound at creation to ``owner_key = (principal.kind, principal.key_id or "owner")``:
      * ``human`` (dev / local / CF Access) -> ``("human", "owner")``
      * ``agent`` (scoped Bearer API key)   -> ``("agent", record.id)``
  - ``get_owned(...)`` always runs lazy TTL cleanup first, then verifies both
    ``owner_key`` and optional ``transport_kind``, returning ``None`` uniformly
    for unknown, expired, closed, mismatched-transport, or foreign sessions so
    callers return a uniform HTTP 404 without leaking session existence.
  - Bounded per-principal active sessions (``max_sessions_per_principal = 8``)
    evicting the oldest idle session when full, plus bounded outbound SSE
    queues (``queue_max_size = 128``) with ``None`` close sentinel.
"""

from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional

DEFAULT_MAX_SESSIONS_PER_PRINCIPAL = 8
DEFAULT_IDLE_TTL_SECONDS = 1800.0
DEFAULT_QUEUE_MAX_SIZE = 128
DEFAULT_KEEPALIVE_INTERVAL_SECONDS = 15.0

TRANSPORT_STREAMABLE_HTTP = "streamable_http"
TRANSPORT_LEGACY_SSE = "legacy_sse"
VALID_TRANSPORTS = frozenset({TRANSPORT_STREAMABLE_HTTP, TRANSPORT_LEGACY_SSE})


class SessionClosedError(RuntimeError):
    """Raised when attempting to enqueue onto an already-closed MCP session."""


def owner_key_for_principal(principal: Any) -> tuple[str, str]:
    """Derive canonical ``(kind, owner_id)`` binding key for a Principal."""
    kind = getattr(principal, "kind", None)
    if kind == "agent":
        key_id = getattr(principal, "key_id", None)
        if not key_id:
            raise ValueError("agent principal must carry key_id")
        return ("agent", str(key_id))
    return ("human", str(getattr(principal, "key_id", None) or "owner"))


@dataclass
class McpHttpSession:
    """Single stateful MCP HTTP or legacy SSE session."""

    session_id: str
    owner_key: tuple[str, str]
    transport_kind: str
    queue: asyncio.Queue[Optional[dict[str, Any]]]
    created_monotonic: float
    last_seen_monotonic: float
    closed: bool = False
    loop: Optional[asyncio.AbstractEventLoop] = None


class McpSessionManager:
    """Bounded, fail-closed, TTL-evicting in-memory MCP session registry."""

    def __init__(
        self,
        *,
        max_sessions_per_principal: int = DEFAULT_MAX_SESSIONS_PER_PRINCIPAL,
        idle_ttl_seconds: float = DEFAULT_IDLE_TTL_SECONDS,
        queue_max_size: int = DEFAULT_QUEUE_MAX_SIZE,
        keepalive_interval_seconds: float = DEFAULT_KEEPALIVE_INTERVAL_SECONDS,
        now_fn: Callable[[], float] = time.monotonic,
    ) -> None:
        if max_sessions_per_principal < 1:
            raise ValueError("max_sessions_per_principal must be >= 1")
        if idle_ttl_seconds <= 0:
            raise ValueError("idle_ttl_seconds must be > 0")
        if queue_max_size < 1:
            raise ValueError("queue_max_size must be >= 1")
        if keepalive_interval_seconds <= 0:
            raise ValueError("keepalive_interval_seconds must be > 0")

        self.max_sessions_per_principal = max_sessions_per_principal
        self.idle_ttl_seconds = float(idle_ttl_seconds)
        self.queue_max_size = queue_max_size
        self.keepalive_interval_seconds = float(keepalive_interval_seconds)
        self._now = now_fn
        self._sessions: dict[str, McpHttpSession] = {}

    @property
    def active_count(self) -> int:
        self.cleanup_expired()
        return len(self._sessions)

    def is_expired(self, session: McpHttpSession, *, now: Optional[float] = None) -> bool:
        current = self._now() if now is None else now
        return (current - session.last_seen_monotonic) > self.idle_ttl_seconds

    def _enqueue_close_sentinel(self, session: McpHttpSession) -> None:
        # Ensure the None sentinel fits even if a slow consumer filled the queue.
        while True:
            try:
                session.queue.put_nowait(None)
                return
            except asyncio.QueueFull:
                try:
                    session.queue.get_nowait()
                except asyncio.QueueEmpty:
                    return

    def _signal_close(self, session: McpHttpSession) -> None:
        session.closed = True
        try:
            running_loop = asyncio.get_running_loop()
        except RuntimeError:
            running_loop = None
        if (
            session.loop is not None
            and not session.loop.is_closed()
            and running_loop is not session.loop
        ):
            try:
                session.loop.call_soon_threadsafe(self._enqueue_close_sentinel, session)
                return
            except RuntimeError:
                pass
        self._enqueue_close_sentinel(session)

    def _close_session(self, session: McpHttpSession) -> None:
        self._sessions.pop(session.session_id, None)
        self._signal_close(session)

    def cleanup_expired(self) -> int:
        """Evict all sessions exceeding ``idle_ttl_seconds``."""
        now = self._now()
        expired = [s for s in list(self._sessions.values()) if self.is_expired(s, now=now)]
        for session in expired:
            self._close_session(session)
        return len(expired)

    def create_session(self, principal: Any, *, transport_kind: str) -> McpHttpSession:
        """Mint a new session bound to ``principal``, evicting oldest idle if at cap."""
        if transport_kind not in VALID_TRANSPORTS:
            raise ValueError(f"unsupported transport_kind: {transport_kind!r}")

        self.cleanup_expired()
        owner = owner_key_for_principal(principal)
        owned = [s for s in self._sessions.values() if s.owner_key == owner]
        while len(owned) >= self.max_sessions_per_principal:
            oldest = min(owned, key=lambda s: (s.last_seen_monotonic, s.created_monotonic))
            self._close_session(oldest)
            owned.remove(oldest)

        now = self._now()
        try:
            running_loop: Optional[asyncio.AbstractEventLoop] = asyncio.get_running_loop()
        except RuntimeError:
            running_loop = None
        session = McpHttpSession(
            session_id=secrets.token_urlsafe(24),
            owner_key=owner,
            transport_kind=transport_kind,
            queue=asyncio.Queue(maxsize=self.queue_max_size),
            created_monotonic=now,
            last_seen_monotonic=now,
            loop=running_loop,
        )
        self._sessions[session.session_id] = session
        return session

    def get_owned(
        self,
        session_id: Optional[str],
        principal: Any,
        *,
        transport_kind: Optional[str] = None,
        touch: bool = True,
    ) -> Optional[McpHttpSession]:
        """Return session iff valid, unexpired, and owned by ``principal`` (fail-closed)."""
        self.cleanup_expired()
        if not session_id:
            return None
        session = self._sessions.get(session_id)
        if session is None or session.closed:
            return None
        try:
            owner = owner_key_for_principal(principal)
        except ValueError:
            return None
        if session.owner_key != owner:
            return None
        if transport_kind is not None and session.transport_kind != transport_kind:
            return None
        if touch:
            session.last_seen_monotonic = self._now()
        return session

    def touch(self, session: McpHttpSession) -> None:
        if not session.closed:
            session.last_seen_monotonic = self._now()

    def enqueue(self, session: McpHttpSession, message: dict[str, Any]) -> None:
        """Enqueue a JSON-RPC server->client message without blocking.

        Raises ``asyncio.QueueFull`` when bounded queue is full (HTTP 429) or
        ``SessionClosedError`` if the session has already closed.
        """
        if session.closed:
            raise SessionClosedError("session closed")
        session.queue.put_nowait(message)

    def delete_owned(
        self,
        session_id: Optional[str],
        principal: Any,
        *,
        transport_kind: Optional[str] = None,
    ) -> bool:
        """Close and delete an owned session; returns False if unknown/foreign/expired."""
        session = self.get_owned(
            session_id,
            principal,
            transport_kind=transport_kind,
            touch=False,
        )
        if session is None:
            return False
        self._close_session(session)
        return True

    def close_session_by_id(self, session_id: str) -> bool:
        session = self._sessions.get(session_id)
        if session is None:
            return False
        self._close_session(session)
        return True

    def close_all(self) -> int:
        sessions = list(self._sessions.values())
        for session in sessions:
            self._close_session(session)
        return len(sessions)

    def count_for_principal(self, principal: Any) -> int:
        self.cleanup_expired()
        owner = owner_key_for_principal(principal)
        return sum(1 for s in self._sessions.values() if s.owner_key == owner)


_MANAGER: Optional[McpSessionManager] = None


def get_mcp_session_manager(app: Any = None) -> McpSessionManager:
    """Return process-wide / app-attached ``McpSessionManager`` singleton."""
    global _MANAGER
    if app is not None:
        existing = getattr(getattr(app, "state", None), "mcp_session_manager", None)
        if isinstance(existing, McpSessionManager):
            return existing
    if _MANAGER is None:
        _MANAGER = McpSessionManager()
    if app is not None and hasattr(app, "state"):
        app.state.mcp_session_manager = _MANAGER
    return _MANAGER


def reset_mcp_session_manager(
    app: Any = None,
    *,
    manager: Optional[McpSessionManager] = None,
) -> McpSessionManager:
    """Reset the singleton / app-attached session manager (for unit tests)."""
    global _MANAGER
    if _MANAGER is not None:
        _MANAGER.close_all()
    if app is not None and hasattr(app, "state"):
        existing = getattr(app.state, "mcp_session_manager", None)
        if isinstance(existing, McpSessionManager) and existing is not _MANAGER:
            existing.close_all()
    _MANAGER = manager if manager is not None else McpSessionManager()
    if app is not None and hasattr(app, "state"):
        app.state.mcp_session_manager = _MANAGER
    return _MANAGER
