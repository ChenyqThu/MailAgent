"""ai_chat.db 读 + 写访问 —— serve-api 远程 chat 端点（V2.1 阶段 2 读 + 阶段 3 3b-3 写）。

ai_chat.db = 前端 owned schema（``frontend/src/electron/main/chat_db.ts``，CHAT_DB_VERSION 4）。
读函数（阶段 2）+ 写函数（3b-3）SQL **逐字镜像** chat_db.ts 对应函数，行形状对齐前端
``ChatSession`` / ``ChatSessionSummary`` / ``ChatMessage`` / ``ChatToolCall``（``model.ts``）：
  - 读：``listSessionsForEmail`` / ``listAllSessions`` / ``listMessages`` / ``listToolCallsForMessage``。
  - 写（3b-3 = ``ChatPersistPort`` 写面）：``getOrCreateSession`` / ``createNewSession`` /
    ``appendMessage`` / ``updateMessage`` / ``deleteMessagesFromId`` / ``abortStreamingMessages`` /
    ``appendToolCall`` / ``updateToolCall`` + 单行读 ``getSession`` / ``getMessage`` /
    ``getToolCallByUseId``（dispatcher 需要）。

路径 = ``DATA_ROOT/frontend/ai_chat.db``（对齐 chat_db.ts ``resolveChatDbPath``），env
``AI_CHAT_DB_PATH`` override。serve-api 由 ``backend_lifecycle`` 注入 ``MAILAGENT_DATA_ROOT``，
故 ``src.config.DATA_ROOT`` 与前端 ``resolveDataRoot()`` 同源。

graceful（读）：库不存在（全新用户无 chat 历史）/ 表未初始化 / 锁 → 返回 ``[]``（不建空库），
对齐前端 IPC handler「失败返 []」契约。

**写约束**：schema 归前端 owns（chat_db.ts ``migrate`` 是唯一真源，按 CHAT_DB_VERSION 升级）—
serve-api **只写既有表、绝不建表/改 schema**（防版本漂移）。故写路径**不**做「库不存在返
graceful」处理：生产里前端 ``getChatDb()`` 在任何 renderer harness 写之前已建好库 + 迁移
（3c cutover 序），写到缺 schema 的库是真实配置错（OperationalError 经全局 handler → 500）。
3b 不接 renderer（http persist 仅 3b-5 mock-fetch 测）→ 生产单 writer；3c（D5 本地走 serve-api）
后亦单 writer，短暂双写 WAL 安全。
"""

from __future__ import annotations

import os
import sqlite3
import time
from contextlib import contextmanager
from typing import Any, Dict, List, Optional


def _now_ms() -> int:
    """epoch 毫秒（对齐 chat_db.ts ``Date.now()``，所有写的 created_at/updated_at 用它）。"""
    return int(time.time() * 1000)


# UpdateMessagePatch / UpdateToolCallPatch（camelCase wire key → 列名）映射，**字段顺序逐字
# 镜像 chat_db.ts updateMessage / updateToolCall**。``key in patch`` 精确复刻 TS ``!== undefined``
# 语义（key 缺 → 不更；key 在即便值 None → 更为 NULL），故 patch 来自 wire 时「省略 ≠ 置空」。
_MESSAGE_PATCH_FIELDS = (
    ("content", "content"),
    ("status", "status"),
    ("tokensInput", "tokens_input"),
    ("tokensOutput", "tokens_output"),
    ("costUsd", "cost_usd"),
    ("errorMessage", "error_message"),
    ("model", "model"),
    ("metadata", "metadata"),
)
_TOOL_CALL_PATCH_FIELDS = (
    ("status", "status"),
    ("outputJson", "output_json"),
    ("durationMs", "duration_ms"),
    ("userEditedInputJson", "user_edited_input_json"),
    ("confirmedAt", "confirmed_at"),
)


def resolve_ai_chat_db_path() -> str:
    """ai_chat.db 路径：env ``AI_CHAT_DB_PATH`` override，否则 ``DATA_ROOT/frontend/ai_chat.db``。"""
    override = os.environ.get("AI_CHAT_DB_PATH")
    if override:
        return override
    # lazy import：避免裸 worktree（无 .env）import 即触发 Config 校验（与 deps.py 同纪律）。
    from src.config import DATA_ROOT

    return os.path.join(DATA_ROOT, "frontend", "ai_chat.db")


class ChatDb:
    """ai_chat.db 读 + 写访问。连接 per-call 短命（WAL 并发安全，与 mail-sync/前端 writer 不冲突）。

    读 graceful（库不存在 → []）；写假设 schema 已存在（前端 owns，见模块 docstring「写约束」）。
    """

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

    @contextmanager
    def _write_connection(self):
        """写连接：clean exit 自动 commit，异常 rollback，总 close（per-call 短命，WAL 安全）。

        ``foreign_keys = ON`` 对齐 chat_db.ts ``getChatDb``（真实 schema 的 ON DELETE CASCADE +
        message→session FK 在生产里据此生效；测试 DDL 无 FK → no-op）。journal_mode 不在此设：
        库的 WAL 模式是持久化属性，已由前端首次 ``getChatDb`` 建立，任何后开连接自动沿用。
        """
        conn = sqlite3.connect(self.db_path, timeout=5.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
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

    def _read_one(self, sql: str, params: tuple = ()) -> Optional[Dict[str, Any]]:
        """单行读（graceful 同 _read_all：库不存在/表未初始化/锁 → None）。镜像 chat_db.ts
        ``getSession`` / ``getMessage`` / ``getToolCallByUseId`` 的 ``row ?? null``。"""
        if not os.path.exists(self.db_path):
            return None
        try:
            with self._connection() as conn:
                row = conn.execute(sql, params).fetchone()
                return dict(row) if row is not None else None
        except sqlite3.Error:
            return None

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

    # ── sessions（写 + 单读，3b-3）─────────────────────────────────────────

    def get_or_create_session(
        self,
        email_id: int,
        backend_kind: str,
        backend_model: Optional[str] = None,
        backend_agent_page_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """复用既有 (email,kind,pageId) session 或新建。镜像 chat_db.ts getOrCreateSession。

        pageId 为 None 时走 ``IS NULL`` 分支（SQLite 把 UNIQUE NULL 当永远互异，不能只靠
        UNIQUE 查）。命中且 backendModel 变了 → 刷新 model + updated_at（用户切 BackendSelector）。
        """
        now = _now_ms()
        with self._write_connection() as conn:
            if backend_agent_page_id is None:
                existing = conn.execute(
                    "SELECT * FROM ai_chat_sessions "
                    "WHERE email_id = ? AND backend_kind = ? AND backend_agent_page_id IS NULL",
                    (email_id, backend_kind),
                ).fetchone()
            else:
                existing = conn.execute(
                    "SELECT * FROM ai_chat_sessions "
                    "WHERE email_id = ? AND backend_kind = ? AND backend_agent_page_id = ?",
                    (email_id, backend_kind, backend_agent_page_id),
                ).fetchone()

            if existing is not None:
                if backend_model and backend_model != existing["backend_model"]:
                    conn.execute(
                        "UPDATE ai_chat_sessions SET backend_model = ?, updated_at = ? WHERE id = ?",
                        (backend_model, now, existing["id"]),
                    )
                    return {**dict(existing), "backend_model": backend_model, "updated_at": now}
                return dict(existing)

            cur = conn.execute(
                "INSERT INTO ai_chat_sessions "
                "(email_id, backend_kind, backend_model, backend_agent_page_id, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (email_id, backend_kind, backend_model, backend_agent_page_id, now, now),
            )
            return {
                "id": int(cur.lastrowid),
                "email_id": email_id,
                "backend_kind": backend_kind,
                "backend_model": backend_model,
                "backend_agent_page_id": backend_agent_page_id,
                "created_at": now,
                "updated_at": now,
            }

    def create_new_session(
        self,
        email_id: int,
        backend_kind: str,
        backend_model: Optional[str] = None,
        backend_agent_page_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """无条件 INSERT 新 session（绕过复用查找）。镜像 chat_db.ts createNewSession
        （「+ 新建会话」显式意图，v4 drop UNIQUE 后多 session/邮件合法）。"""
        now = _now_ms()
        with self._write_connection() as conn:
            cur = conn.execute(
                "INSERT INTO ai_chat_sessions "
                "(email_id, backend_kind, backend_model, backend_agent_page_id, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (email_id, backend_kind, backend_model, backend_agent_page_id, now, now),
            )
            return {
                "id": int(cur.lastrowid),
                "email_id": email_id,
                "backend_kind": backend_kind,
                "backend_model": backend_model,
                "backend_agent_page_id": backend_agent_page_id,
                "created_at": now,
                "updated_at": now,
            }

    def get_session(self, session_id: int) -> Optional[Dict[str, Any]]:
        """单 session 行 or None。镜像 chat_db.ts getSession → ChatSession | null。"""
        return self._read_one(
            "SELECT * FROM ai_chat_sessions WHERE id = ?", (session_id,)
        )

    def delete_session(self, session_id: int) -> None:
        """删整个 session（其消息 + 工具调用经 FK ON DELETE CASCADE 连带删）。镜像 chat_db.ts
        deleteSession（3c-2 补：cutover 后 renderer ChatRuntime.deleteSession 经此删，取代
        electron chat:deleteSession IPC）。CASCADE 由 _write_connection 的 ``PRAGMA foreign_keys
        = ON`` + 真实 schema 的 message→session / tool_call→message FK 生效（删不存在的 id 是
        no-op，对齐 fire-and-forget 语义）。"""
        with self._write_connection() as conn:
            conn.execute("DELETE FROM ai_chat_sessions WHERE id = ?", (session_id,))

    # ── messages（写 + 单读，3b-3）─────────────────────────────────────────

    def append_message(
        self,
        session_id: int,
        role: str,
        content: str,
        status: str,
        model: Optional[str] = None,
        tokens_input: Optional[int] = None,
        tokens_output: Optional[int] = None,
        cost_usd: Optional[float] = None,
        error_message: Optional[str] = None,
        metadata: Optional[str] = None,
    ) -> Dict[str, Any]:
        """INSERT 一条消息 + bump session updated_at（列表排序反映新活动）。镜像 chat_db.ts
        appendMessage → ChatMessage。两条语句同一 now、同一事务。"""
        now = _now_ms()
        with self._write_connection() as conn:
            cur = conn.execute(
                "INSERT INTO ai_chat_messages "
                "(session_id, role, content, tokens_input, tokens_output, cost_usd, "
                "model, status, error_message, metadata, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    session_id,
                    role,
                    content,
                    tokens_input,
                    tokens_output,
                    cost_usd,
                    model,
                    status,
                    error_message,
                    metadata,
                    now,
                    now,
                ),
            )
            conn.execute(
                "UPDATE ai_chat_sessions SET updated_at = ? WHERE id = ?", (now, session_id)
            )
            return {
                "id": int(cur.lastrowid),
                "session_id": session_id,
                "role": role,
                "content": content,
                "tokens_input": tokens_input,
                "tokens_output": tokens_output,
                "cost_usd": cost_usd,
                "model": model,
                "status": status,
                "error_message": error_message,
                "metadata": metadata,
                "created_at": now,
                "updated_at": now,
            }

    def update_message(self, message_id: int, patch: Dict[str, Any]) -> None:
        """部分更新一条消息（streamContent 仅 content / finalizeMessage 终态全字段）。镜像
        chat_db.ts updateMessage：动态拼字段（``key in patch`` = TS ``!== undefined``），无字段
        即 no-op，**不** bump session updated_at。patch 用 camelCase wire key（见 _MESSAGE_PATCH_FIELDS）。"""
        fields: List[str] = []
        params: List[Any] = []
        for key, col in _MESSAGE_PATCH_FIELDS:
            if key in patch:
                fields.append(f"{col} = ?")
                params.append(patch[key])
        if not fields:
            return
        fields.append("updated_at = ?")
        params.append(_now_ms())
        params.append(message_id)
        with self._write_connection() as conn:
            conn.execute(
                f"UPDATE ai_chat_messages SET {', '.join(fields)} WHERE id = ?", params
            )

    def get_message(self, message_id: int) -> Optional[Dict[str, Any]]:
        """单消息行 or None。镜像 chat_db.ts getMessage → ChatMessage | null。"""
        return self._read_one(
            "SELECT * FROM ai_chat_messages WHERE id = ?", (message_id,)
        )

    def delete_messages_from_id(self, session_id: int, from_message_id: int) -> int:
        """删 from_message_id 及之后所有消息（含自身，行内编辑重跑）。镜像 chat_db.ts
        deleteMessagesFromId → 删除行数（``>= ?`` 不是 ``> ?``：调用方随后 appendMessage 重建编辑行）。"""
        with self._write_connection() as conn:
            cur = conn.execute(
                "DELETE FROM ai_chat_messages WHERE session_id = ? AND id >= ?",
                (session_id, from_message_id),
            )
            return cur.rowcount

    def abort_streaming_messages(self, session_id: int) -> int:
        """把该 session 的 pending/streaming 消息标 aborted（切邮件/关面板时）。镜像 chat_db.ts
        abortStreamingMessages → 翻转行数。"""
        now = _now_ms()
        with self._write_connection() as conn:
            cur = conn.execute(
                "UPDATE ai_chat_messages SET status = 'aborted', updated_at = ? "
                "WHERE session_id = ? AND status IN ('pending', 'streaming')",
                (now, session_id),
            )
            return cur.rowcount

    # ── chat_tool_call（写 + 单读，3b-3）───────────────────────────────────

    def append_tool_call(
        self,
        message_id: int,
        tool_use_id: str,
        tool_name: str,
        input_json: str,
        confirmation_tier: str,
        status: str,
    ) -> Dict[str, Any]:
        """INSERT 一条工具调用审计行（user_edited/output/duration/confirmed_at 初始 NULL）。
        镜像 chat_db.ts appendToolCall → ChatToolCall。"""
        now = _now_ms()
        with self._write_connection() as conn:
            cur = conn.execute(
                "INSERT INTO chat_tool_call "
                "(message_id, tool_use_id, tool_name, input_json, "
                "user_edited_input_json, output_json, "
                "status, duration_ms, confirmation_tier, confirmed_at, "
                "created_at, updated_at) "
                "VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?, NULL, ?, ?)",
                (
                    message_id,
                    tool_use_id,
                    tool_name,
                    input_json,
                    status,
                    confirmation_tier,
                    now,
                    now,
                ),
            )
            return {
                "id": int(cur.lastrowid),
                "message_id": message_id,
                "tool_use_id": tool_use_id,
                "tool_name": tool_name,
                "input_json": input_json,
                "user_edited_input_json": None,
                "output_json": None,
                "status": status,
                "duration_ms": None,
                "confirmation_tier": confirmation_tier,
                "confirmed_at": None,
                "created_at": now,
                "updated_at": now,
            }

    def update_tool_call(self, tool_call_id: int, patch: Dict[str, Any]) -> None:
        """部分更新一条工具调用（status/output/duration/userEditedInput/confirmedAt）。镜像
        chat_db.ts updateToolCall：动态拼字段（``key in patch``），无字段即 no-op。patch 用
        camelCase wire key（见 _TOOL_CALL_PATCH_FIELDS）。"""
        fields: List[str] = []
        params: List[Any] = []
        for key, col in _TOOL_CALL_PATCH_FIELDS:
            if key in patch:
                fields.append(f"{col} = ?")
                params.append(patch[key])
        if not fields:
            return
        fields.append("updated_at = ?")
        params.append(_now_ms())
        params.append(tool_call_id)
        with self._write_connection() as conn:
            conn.execute(
                f"UPDATE chat_tool_call SET {', '.join(fields)} WHERE id = ?", params
            )

    def get_tool_call_by_use_id(
        self, message_id: int, tool_use_id: str
    ) -> Optional[Dict[str, Any]]:
        """单工具调用（by message + tool_use_id）or None。镜像 chat_db.ts getToolCallByUseId
        → ChatToolCall | null（dispatcher 据此判「这个 tool_use_id 见过没」）。"""
        return self._read_one(
            "SELECT * FROM chat_tool_call WHERE message_id = ? AND tool_use_id = ?",
            (message_id, tool_use_id),
        )
