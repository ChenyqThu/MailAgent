"""ai_chat.db 只读访问 —— serve-api 远程 chat 历史端点（V2.1 阶段 2）。

ai_chat.db = 前端 owned schema（``frontend/src/electron/main/chat_db.ts``，CHAT_DB_VERSION 4），
serve-api **只读**它。读函数 SQL 逐字镜像 chat_db.ts 的 ``listSessionsForEmail`` /
``listAllSessions`` / ``listMessages`` / ``listToolCallsForMessage``，行形状对齐前端
``ChatSession`` / ``ChatSessionSummary`` / ``ChatMessage`` / ``ChatToolCall``（``types.ts``）。

路径 = ``DATA_ROOT/frontend/ai_chat.db``（对齐 chat_db.ts ``resolveChatDbPath``），env
``AI_CHAT_DB_PATH`` override。serve-api 由 ``backend_lifecycle`` 注入 ``MAILAGENT_DATA_ROOT``，
故 ``src.config.DATA_ROOT`` 与前端 ``resolveDataRoot()`` 同源。

graceful：库不存在（全新用户无 chat 历史）/ 表未初始化 / 锁 → 返回 ``[]``（不建空库），
对齐前端 IPC handler「失败返 []」契约。
"""

from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from typing import Any, Dict, List, Optional


def resolve_ai_chat_db_path() -> str:
    """ai_chat.db 路径：env ``AI_CHAT_DB_PATH`` override，否则 ``DATA_ROOT/frontend/ai_chat.db``。"""
    override = os.environ.get("AI_CHAT_DB_PATH")
    if override:
        return override
    # lazy import：避免裸 worktree（无 .env）import 即触发 Config 校验（与 deps.py 同纪律）。
    from src.config import DATA_ROOT

    return os.path.join(DATA_ROOT, "frontend", "ai_chat.db")


class ChatDb:
    """ai_chat.db 只读访问。连接 per-call 短命（WAL 并发安全，与 mail-sync/前端 writer 不冲突）。"""

    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path or resolve_ai_chat_db_path()

    @contextmanager
    def _connection(self):
        # 默认 connect（非 mode=ro）：能读 WAL -wal 里前端 writer 尚未 checkpoint 的新数据
        # （mode=ro 读不到未 checkpoint 的 WAL）。只读查询不写，WAL 下 reader 不阻塞 writer。
        conn = sqlite3.connect(self.db_path, timeout=5.0)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    def _read_all(self, sql: str, params: tuple = ()) -> List[Dict[str, Any]]:
        # 库不存在 → 空（不让 connect 建空文件，避免在 ai_chat.db 位置留废库）。
        if not os.path.exists(self.db_path):
            return []
        try:
            with self._connection() as conn:
                return [dict(r) for r in conn.execute(sql, params).fetchall()]
        except sqlite3.Error:
            # 表未初始化（库刚建无 schema）/ 锁超时 → graceful 空（对齐前端 handler 失败返 []）。
            return []

    # ── sessions ──────────────────────────────────────────────────────────

    def list_sessions_for_email(self, email_id: int) -> List[Dict[str, Any]]:
        """某邮件的 chat sessions（按 updated_at 倒序）。镜像 listSessionsForEmail → ChatSession[]。"""
        return self._read_all(
            "SELECT * FROM ai_chat_sessions WHERE email_id = ? ORDER BY updated_at DESC",
            (email_id,),
        )

    def list_all_sessions(self, limit: int = 300) -> List[Dict[str, Any]]:
        """跨邮件 session 历史（含 first_user_message 预览 + message_count，排除无消息 session）。
        镜像 listAllSessions → ChatSessionSummary[]。"""
        return self._read_all(
            """SELECT
                 s.id, s.email_id, s.backend_kind, s.backend_model, s.backend_agent_page_id,
                 s.created_at, s.updated_at,
                 (SELECT substr(m.content, 1, 500) FROM ai_chat_messages m
                    WHERE m.session_id = s.id AND m.role = 'user'
                    ORDER BY m.created_at ASC LIMIT 1) AS first_user_message,
                 (SELECT COUNT(*) FROM ai_chat_messages m WHERE m.session_id = s.id) AS message_count
               FROM ai_chat_sessions s
               WHERE EXISTS (SELECT 1 FROM ai_chat_messages m WHERE m.session_id = s.id)
               ORDER BY s.updated_at DESC
               LIMIT ?""",
            (limit,),
        )

    # ── messages ──────────────────────────────────────────────────────────

    def list_messages(self, session_id: int) -> List[Dict[str, Any]]:
        """某 session 的全部消息（按 created_at/id 升序）。镜像 listMessages → ChatMessage[]。"""
        return self._read_all(
            "SELECT * FROM ai_chat_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC",
            (session_id,),
        )

    # ── tool calls ────────────────────────────────────────────────────────

    def list_tool_calls_for_message(self, message_id: int) -> List[Dict[str, Any]]:
        """某 assistant 消息的工具调用审计行（按 created_at/id 升序）。
        镜像 listToolCallsForMessage → ChatToolCall[]。无 tool_use 的消息返 []。"""
        return self._read_all(
            "SELECT * FROM chat_tool_call WHERE message_id = ? ORDER BY created_at ASC, id ASC",
            (message_id,),
        )
