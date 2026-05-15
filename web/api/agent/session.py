"""会话管理 — SQLite 持久化 + 内存缓存 + TTL 自动清理。"""

from __future__ import annotations

import asyncio
import json
import sqlite3
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
    def __init__(self, db_path: str = "data/sync_store.db") -> None:
        self._cache: dict[str, Session] = {}
        self._db_path = db_path
        self._cleanup_task: Optional[asyncio.Task[None]] = None
        self._ensure_table()

    def _get_conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _ensure_table(self) -> None:
        with self._get_conn() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS agent_sessions (
                    session_id TEXT PRIMARY KEY,
                    messages_json TEXT NOT NULL DEFAULT '[]',
                    email_context_json TEXT,
                    created_at REAL NOT NULL,
                    last_active REAL NOT NULL
                )
            """)

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
        # 1. 内存缓存命中
        if session_id and session_id in self._cache:
            sess = self._cache[session_id]
            sess.touch()
            if email_context:
                sess.email_context = email_context
            return sess

        # 2. SQLite 恢复
        if session_id:
            sess = self._load_from_db(session_id)
            if sess:
                sess.touch()
                if email_context:
                    sess.email_context = email_context
                self._cache[session_id] = sess
                return sess

        # 3. 新建
        new_id = session_id or uuid.uuid4().hex[:12]
        sess = Session(session_id=new_id, email_context=email_context)
        self._cache[new_id] = sess
        return sess

    def save(self, sess: Session) -> None:
        """持久化到 SQLite。每轮对话结束后调用。"""
        ctx_json = None
        if sess.email_context:
            ctx_json = json.dumps(sess.email_context.model_dump(), ensure_ascii=False)

        with self._get_conn() as conn:
            conn.execute(
                """INSERT INTO agent_sessions (session_id, messages_json, email_context_json, created_at, last_active)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(session_id) DO UPDATE SET
                     messages_json = excluded.messages_json,
                     email_context_json = excluded.email_context_json,
                     last_active = excluded.last_active
                """,
                (
                    sess.session_id,
                    json.dumps(sess.messages, ensure_ascii=False),
                    ctx_json,
                    sess.created_at,
                    sess.last_active,
                ),
            )

    def delete(self, session_id: str) -> bool:
        self._cache.pop(session_id, None)
        with self._get_conn() as conn:
            cursor = conn.execute(
                "DELETE FROM agent_sessions WHERE session_id = ?", (session_id,)
            )
            return cursor.rowcount > 0

    def count(self) -> int:
        return len(self._cache)

    def _load_from_db(self, session_id: str) -> Optional[Session]:
        with self._get_conn() as conn:
            row = conn.execute(
                "SELECT messages_json, email_context_json, created_at, last_active FROM agent_sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()

        if not row:
            return None

        messages_json, ctx_json, created_at, last_active = row

        # TTL 检查
        if (time.time() - last_active) > _SESSION_TTL:
            self._delete_from_db(session_id)
            return None

        messages = json.loads(messages_json) if messages_json else []
        email_context = None
        if ctx_json:
            try:
                ctx_data = json.loads(ctx_json)
                email_context = EmailContext(**ctx_data)
            except Exception:
                pass

        sess = Session(
            session_id=session_id,
            messages=messages,
            email_context=email_context,
            created_at=created_at,
            last_active=last_active,
        )
        logger.info(f"[agent-session] restored session {session_id} ({len(messages)} messages)")
        return sess

    def _delete_from_db(self, session_id: str) -> None:
        with self._get_conn() as conn:
            conn.execute("DELETE FROM agent_sessions WHERE session_id = ?", (session_id,))

    async def _cleanup_loop(self) -> None:
        while True:
            await asyncio.sleep(_CLEANUP_INTERVAL)
            now = time.time()
            cutoff = now - _SESSION_TTL

            # 清理内存
            expired = [sid for sid, s in self._cache.items() if s.expired]
            for sid in expired:
                del self._cache[sid]

            # 清理 SQLite
            with self._get_conn() as conn:
                cursor = conn.execute(
                    "DELETE FROM agent_sessions WHERE last_active < ?", (cutoff,)
                )
                db_cleaned = cursor.rowcount

            if expired or db_cleaned:
                logger.debug(
                    f"[agent-session] cleaned {len(expired)} memory + {db_cleaned} db expired sessions"
                )


session_manager = SessionManager()
