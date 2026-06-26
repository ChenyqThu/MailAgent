"""ai_chat.db 读 + 写访问 —— serve-api 远程 chat 端点（V2.1 阶段 2 读 + 阶段 3 3b-3 写）。

ai_chat.db = 前端 owned schema（``frontend/src/electron/main/chat_db.ts``，CHAT_DB_VERSION 15）。
v15：ai_chat_sessions.archived INTEGER NOT NULL DEFAULT 0 — 软删标志（0=正常，1=已归档）。归档会话
从 list_all_sessions 过滤（WHERE s.archived = 0）；写经 update_session_archived 镜像（ai_chat.db
own ladder，非 EXPECTED_DB_VERSION；chat_db.ts 是 schema 真源，本文件不建表）。
v14（demo-fidelity Phase 10）：ai_chat_sessions.title — 可选会话标题（gateway haiku 自动标题 /
手动改名）。读走 ``SELECT *`` 自动带回（list_all_sessions 显式列已加 s.title）；写经
update_session_title 镜像（chat_db.ts 是 schema 真源，本文件不建表）。
v7（P2c）= chat session anchor：``email_id`` 改 nullable + 加 ``anchor_type``/``anchor_id`` 列
（table CHECK 强制 email→两者非空 / general→两者 NULL，禁 emailId=0 sentinel）。
v8（P2a，task 06-23）= agent_memory_kv provenance + priority：加 ``source_session_id`` /
``source_message_id`` / ``source_tool_use_id``（写入来源的会话/消息/工具，取代
``source_wiki_path='session:<id>'`` 旧 overload）+ ``priority``（用户显式重要性，驱动
``memory_summary`` 注入相关性排序）。
v9（P4 Phase 02，task 06-23 chat-panel AI SDK Gateway）= ``ai_chat_messages.ui_message_json``：
AI SDK v6 UIMessage canonical JSON（gateway runtime 双写，与 ``content`` 提取文本并列）。读走
``SELECT *`` 自动带回；写经 ``append_message`` / ``update_message`` 镜像（legacy 行 NULL）。本
文件只 mirror 读写既有列、**绝不建表/改 schema**（schema 归 chat_db.ts ``migrate``）。
v10（P4 Phase 03b，task 06-23 chat-panel HITL write tools）= ``chat_tool_call.approval_status``
+ ``approval_hash``：AI SDK Gateway 写工具的审批审计（gateway 在 Electron main 经 chat_db.ts
直写，非本 serve-api 路径）。读走 ``SELECT *`` 自动带回（read/legacy 行 NULL），本文件的
``append_tool_call`` 不写这两列（既有写面不变，新列默认 NULL）。
v11（P4 Phase 04a，task 06-23 chat-panel A2UI tool cards）= ``chat_tool_call.ui_payload_json``：
富工具卡的 A2UI 渲染 payload（component + props + audit，protocol §3），gateway 在 Electron main
经 chat_db.ts 直写（仅 MAILAGENT_A2UI_TOOL_CARDS 开 + 工具有卡时）。读走 ``SELECT *`` 自动带回
（read/legacy/flag-off 行 NULL），``append_tool_call`` 不写此列（既有写面不变，新列默认 NULL）。
v12（P4 Phase 04b，task 06-23 chat-panel high-risk send）= ``chat_tool_call.content_hash`` +
``idempotency_key``：高风险外发（email_prepare_send）的双 guard 审计（content hash 绑定审批内容与
实发内容，idempotency_key 是 Python send ledger 的一次性键），gateway 在 Electron main 经 chat_db.ts
直写（仅 email_prepare_send 行）。读走 ``SELECT *`` 自动带回（其余/legacy 行 NULL），
``append_tool_call`` 不写此两列（既有写面不变，新列默认 NULL）。
v13（P4 Phase 06a，task 06-23 chat-panel cutover）= ``ai_chat_sessions.backend_kind`` CHECK 放宽，
加 ``'ai-sdk'``（经 AI SDK Gateway 创作的会话成为一等 backend_kind，面板按 session 路由 runtime）。
chat_db.ts ``migrate`` 表重建放宽 CHECK；本文件纯镜像不建表，``get_or_create_session`` /
``create_new_session`` 的 ``backend_kind: str`` 形参无独立 CHECK，故只需同步本头注释版本号。
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

import json
import os
import sqlite3
import time
from contextlib import contextmanager
from typing import Any, Dict, List, Optional


def _now_ms() -> int:
    """epoch 毫秒（对齐 chat_db.ts ``Date.now()``，所有写的 created_at/updated_at 用它）。"""
    return int(time.time() * 1000)


# P2a (task 06-23) — prompt-injection 相关性选择的上限。注入 system prompt 的 memory
# 是「规则化挑选」而非全量：scope 过滤 + ORDER BY priority DESC, updated_at DESC，截前
# MEMORY_INJECT_MAX_ENTRIES 条 + MEMORY_INJECT_MAX_CHARS 字符。上限防 unrelated 偏好刷屏/
# 污染上下文；``memory_summary_meta`` 暴露 injected/total/truncated 供 /chat/config 可观测。
MEMORY_INJECT_MAX_ENTRIES = 20
MEMORY_INJECT_MAX_CHARS = 2000


def _resolve_anchor(
    anchor_type: str, email_id: Optional[int]
) -> tuple[str, Optional[int], Optional[int]]:
    """P2c — 把 (anchor_type, email_id) 解析成 (anchor_type, email_id, anchor_id)。镜像
    chat_db.ts ``resolveAnchor``：email（默认）→ email_id 必须非负 int、anchor_id=email_id；
    general → 两者 NULL（**绝不**接受 emailId sentinel）。非法 email anchor 抛 ValueError
    （router 已前置校验，这里是 defense-in-depth，免得插入违反 v7 CHECK 的行）。"""
    if anchor_type == "general":
        # codex review HIGH — reject a general anchor carrying ANY non-None emailId
        # (incl. 0); never silently drop it (that's the banned sentinel).
        if email_id is not None:
            raise ValueError(f"general anchor must not carry an emailId (got {email_id!r})")
        return "general", None, None
    if anchor_type != "email":
        raise ValueError(f"anchor_type must be 'email' or 'general', got {anchor_type!r}")
    if not isinstance(email_id, int) or isinstance(email_id, bool) or email_id < 0:
        raise ValueError(
            f"anchor_type='email' requires a non-negative integer emailId, got {email_id!r}"
        )
    return "email", email_id, email_id


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
    # task 06-08-chat 需求 5 — extended-thinking summary（finalizeMessage 终态写）。
    ("thinking", "thinking"),
    # v9（P4 Phase 02）— AI SDK UIMessage canonical JSON（gateway onFinish 终态写）。
    ("uiMessageJson", "ui_message_json"),
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

    def list_general_sessions(self) -> List[Dict[str, Any]]:
        """P2c — general（无邮件 context）sessions（按 updated_at 倒序）。镜像
        listGeneralSessions → ChatSession[]。与 list_sessions_for_email 分开，general session
        绝不漏进某封邮件的 sidebar。"""
        return self._read_all(
            "SELECT * FROM ai_chat_sessions WHERE anchor_type = 'general' ORDER BY updated_at DESC",
        )

    def list_all_sessions(self, limit: int = 300) -> List[Dict[str, Any]]:
        """跨邮件 session 历史（含 first_user_message 预览 + message_count，排除无消息 session）。
        镜像 listAllSessions → ChatSessionSummary[]。"""
        return self._read_all(
            """SELECT
                 s.id, s.email_id, s.anchor_type, s.anchor_id, s.backend_kind, s.backend_model,
                 s.backend_agent_page_id, s.title, s.archived, s.created_at, s.updated_at,
                 (SELECT substr(m.content, 1, 500) FROM ai_chat_messages m
                    WHERE m.session_id = s.id AND m.role = 'user'
                    ORDER BY m.created_at ASC LIMIT 1) AS first_user_message,
                 (SELECT COUNT(*) FROM ai_chat_messages m WHERE m.session_id = s.id) AS message_count
               FROM ai_chat_sessions s
               WHERE s.archived = 0 AND EXISTS (SELECT 1 FROM ai_chat_messages m WHERE m.session_id = s.id)
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
        email_id: Optional[int] = None,
        backend_kind: str = "custom-api",
        backend_model: Optional[str] = None,
        backend_agent_page_id: Optional[str] = None,
        *,
        anchor_type: str = "email",
    ) -> Dict[str, Any]:
        """复用既有 session 或新建。镜像 chat_db.ts getOrCreateSession（P2c anchor-aware）。

        email（默认）→ 按 email_id 查复用（pre-v7 逐字节不变，邮件 sidebar 零回归）；general →
        按 anchor_type='general' AND email_id IS NULL 查、复用最近一条（无 anchor_id 去重，"latest"
        即契约；显式新建走 create_new_session）。pageId 为 None 时走 ``IS NULL`` 分支（SQLite 把
        UNIQUE NULL 当永远互异）。命中且 backendModel 变了 → 刷新 model + updated_at。
        """
        anchor_type, email_id, anchor_id = _resolve_anchor(anchor_type, email_id)
        now = _now_ms()
        page_clause = (
            "backend_agent_page_id IS NULL"
            if backend_agent_page_id is None
            else "backend_agent_page_id = ?"
        )
        page_params: tuple = () if backend_agent_page_id is None else (backend_agent_page_id,)
        with self._write_connection() as conn:
            if anchor_type == "email":
                existing = conn.execute(
                    f"SELECT * FROM ai_chat_sessions "
                    f"WHERE email_id = ? AND backend_kind = ? AND {page_clause}",
                    (email_id, backend_kind, *page_params),
                ).fetchone()
            else:
                existing = conn.execute(
                    f"SELECT * FROM ai_chat_sessions "
                    f"WHERE anchor_type = 'general' AND email_id IS NULL "
                    f"AND backend_kind = ? AND {page_clause} "
                    f"ORDER BY updated_at DESC LIMIT 1",
                    (backend_kind, *page_params),
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
                "(email_id, anchor_type, anchor_id, backend_kind, backend_model, "
                "backend_agent_page_id, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (email_id, anchor_type, anchor_id, backend_kind, backend_model,
                 backend_agent_page_id, now, now),
            )
            return {
                "id": int(cur.lastrowid),
                "email_id": email_id,
                "anchor_type": anchor_type,
                "anchor_id": anchor_id,
                "backend_kind": backend_kind,
                "backend_model": backend_model,
                "backend_agent_page_id": backend_agent_page_id,
                "title": None,
                "created_at": now,
                "updated_at": now,
            }

    def create_new_session(
        self,
        email_id: Optional[int] = None,
        backend_kind: str = "custom-api",
        backend_model: Optional[str] = None,
        backend_agent_page_id: Optional[str] = None,
        *,
        anchor_type: str = "email",
    ) -> Dict[str, Any]:
        """无条件 INSERT 新 session（绕过复用查找）。镜像 chat_db.ts createNewSession
        （「+ 新建会话」显式意图，v4 drop UNIQUE 后多 session/邮件合法；P2c anchor-aware）。"""
        anchor_type, email_id, anchor_id = _resolve_anchor(anchor_type, email_id)
        now = _now_ms()
        with self._write_connection() as conn:
            cur = conn.execute(
                "INSERT INTO ai_chat_sessions "
                "(email_id, anchor_type, anchor_id, backend_kind, backend_model, "
                "backend_agent_page_id, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (email_id, anchor_type, anchor_id, backend_kind, backend_model,
                 backend_agent_page_id, now, now),
            )
            return {
                "id": int(cur.lastrowid),
                "email_id": email_id,
                "anchor_type": anchor_type,
                "anchor_id": anchor_id,
                "backend_kind": backend_kind,
                "backend_model": backend_model,
                "backend_agent_page_id": backend_agent_page_id,
                "title": None,
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

    def update_session_title(self, session_id: int, title: str) -> None:
        """设置 session 标题（手动改名 / gateway haiku 自动标题）。镜像 chat_db.ts updateSessionTitle：
        刻意不 bump updated_at → 改名不重排历史列表。改不存在的 id 是 no-op（UPDATE 匹配 0 行）。"""
        with self._write_connection() as conn:
            conn.execute(
                "UPDATE ai_chat_sessions SET title = ? WHERE id = ?", (title, session_id)
            )

    def update_session_archived(self, session_id: int, archived: bool) -> None:
        """设置 session 归档状态（软删）。镜像 chat_db.ts updateSessionArchived：刻意不 bump
        updated_at → 归档不重排历史列表。改不存在的 id 是 no-op（UPDATE 匹配 0 行）。"""
        with self._write_connection() as conn:
            conn.execute(
                "UPDATE ai_chat_sessions SET archived = ? WHERE id = ?",
                (1 if archived else 0, session_id),
            )

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
        ui_message_json: Optional[str] = None,
    ) -> Dict[str, Any]:
        """INSERT 一条消息 + bump session updated_at（列表排序反映新活动）。镜像 chat_db.ts
        appendMessage → ChatMessage。两条语句同一 now、同一事务。

        v9（P4 Phase 02）— ``ui_message_json`` = AI SDK UIMessage canonical JSON（gateway
        runtime 双写）；legacy 写省略 → NULL（重载时由 content 合成 UIMessage）。"""
        now = _now_ms()
        with self._write_connection() as conn:
            cur = conn.execute(
                "INSERT INTO ai_chat_messages "
                "(session_id, role, content, tokens_input, tokens_output, cost_usd, "
                "model, status, error_message, metadata, ui_message_json, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                    ui_message_json,
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
                # task 06-08-chat 需求 5 — appendMessage 不 seed thinking（finalizeMessage
                # 终态经 update_message 写）；INSERT 未写该列 → 行 thinking=NULL。镜像 chat_db.ts。
                "thinking": None,
                "ui_message_json": ui_message_json,
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
        content_offset: Optional[int] = None,
    ) -> Dict[str, Any]:
        """INSERT 一条工具调用审计行（user_edited/output/duration/confirmed_at 初始 NULL）。
        镜像 chat_db.ts appendToolCall → ChatToolCall。

        ``content_offset``（task 06-08-chat Bug 2）= 该工具卡在父 assistant 消息 ``content``
        里的插入字符偏移（harness 见 tool_use 时的累积正文长度）；前端据此把 content split
        交错渲染工具卡。chat_tool_call.content_offset 列由前端 chat_db.ts v5 迁移建（schema
        归前端 owns）—— serve-api 只写既有列（生产里 renderer getChatDb() 已迁好库）。
        """
        now = _now_ms()
        with self._write_connection() as conn:
            cur = conn.execute(
                "INSERT INTO chat_tool_call "
                "(message_id, tool_use_id, tool_name, input_json, "
                "user_edited_input_json, output_json, "
                "status, duration_ms, confirmation_tier, confirmed_at, "
                "content_offset, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?, NULL, ?, ?, ?)",
                (
                    message_id,
                    tool_use_id,
                    tool_name,
                    input_json,
                    status,
                    confirmation_tier,
                    content_offset,
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
                "content_offset": content_offset,
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

    # ── agent_memory_kv（P2f — Custom AI memory WAL）───────────────────────

    def list_memory_entries(self, scope: Optional[str] = None) -> List[Dict[str, Any]]:
        """memory 条目（按 updated_at 倒序），可选 scope 过滤。镜像 chat_db.ts listMemoryEntries。"""
        if scope:
            return self._read_all(
                "SELECT * FROM agent_memory_kv WHERE scope = ? ORDER BY updated_at DESC", (scope,)
            )
        return self._read_all("SELECT * FROM agent_memory_kv ORDER BY updated_at DESC")

    def get_memory_entry(self, scope: str, key: str) -> Optional[Dict[str, Any]]:
        """单条 memory or None。镜像 chat_db.ts getMemoryEntry。"""
        return self._read_one(
            "SELECT * FROM agent_memory_kv WHERE scope = ? AND key = ?", (scope, key)
        )

    def upsert_memory_entry(
        self,
        scope: str,
        key: str,
        value_json: str,
        source_wiki_path: Optional[str] = None,
        source_session_id: Optional[int] = None,
        source_message_id: Optional[int] = None,
        source_tool_use_id: Optional[str] = None,
        priority: Optional[int] = None,
    ) -> Dict[str, Any]:
        """UPSERT 一条 memory（PK (scope,key)）。created_at 更新时保留。镜像 chat_db.ts
        upsertMemoryEntry。schema 归前端 owns（agent_memory_kv 由 chat_db.ts v3 建、v8 加
        provenance/priority 列），serve-api 只写既有表。

        v8（P2a）：provenance（source_session_id/source_message_id/source_tool_use_id）冲突时
        更新为最新写入者的会话/消息/工具。``priority`` 用 COALESCE 保留：写入省略 priority
        （如 agent 仅刷新 value）保住用户已置的优先级、不悄悄清零；显式给值则覆盖；全新行省略
        → 默认 0。"""
        now = _now_ms()
        with self._write_connection() as conn:
            conn.execute(
                "INSERT INTO agent_memory_kv "
                "(scope, key, value_json, source_wiki_path, source_session_id, "
                "source_message_id, source_tool_use_id, priority, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0), ?, ?) "
                "ON CONFLICT(scope, key) DO UPDATE SET "
                "value_json = excluded.value_json, source_wiki_path = excluded.source_wiki_path, "
                "source_session_id = excluded.source_session_id, "
                "source_message_id = excluded.source_message_id, "
                "source_tool_use_id = excluded.source_tool_use_id, "
                "priority = COALESCE(?, agent_memory_kv.priority), "
                "updated_at = excluded.updated_at",
                (
                    scope, key, value_json, source_wiki_path, source_session_id,
                    source_message_id, source_tool_use_id, priority, now, now, priority,
                ),
            )
            row = conn.execute(
                "SELECT * FROM agent_memory_kv WHERE scope = ? AND key = ?", (scope, key)
            ).fetchone()
            return dict(row)

    def delete_memory_entry(self, scope: str, key: str) -> int:
        """删一条 memory → 删除行数。镜像 chat_db.ts deleteMemoryEntry。"""
        with self._write_connection() as conn:
            cur = conn.execute(
                "DELETE FROM agent_memory_kv WHERE scope = ? AND key = ?", (scope, key)
            )
            return cur.rowcount

    def _select_injection_rows(self, scope: str, max_entries: int) -> List[Dict[str, Any]]:
        """P2a — 规则化相关性选择：scope 过滤 + ORDER BY priority DESC, updated_at DESC，取前
        max_entries 条。priority 默认 0 → 无显式优先级时退化为纯 updated_at DESC（与旧行为逐字
        一致）。priority 列 v8 引入；遇老库/未迁移库（no such column）回退纯 updated_at 排序，
        其余 sqlite 错误（库锁/表缺）→ [] graceful，不阻断 /chat/config。ORDER 串为硬编码非用户
        输入，f-string 安全。"""
        if not os.path.exists(self.db_path):
            return []
        for order in ("priority DESC, updated_at DESC", "updated_at DESC"):
            try:
                with self._connection() as conn:
                    return [
                        dict(r)
                        for r in conn.execute(
                            f"SELECT * FROM agent_memory_kv WHERE scope = ? "
                            f"ORDER BY {order} LIMIT ?",
                            (scope, max_entries),
                        ).fetchall()
                    ]
            except sqlite3.OperationalError:
                continue  # no such column: priority（老库）→ retry 纯 updated_at
            except sqlite3.Error:
                return []
        return []

    @staticmethod
    def _format_memory_value(raw: Any) -> Any:
        """value_json 解出标量则直接用，否则 compact JSON（注入 prompt 用人读形态）。"""
        try:
            parsed = json.loads(raw) if isinstance(raw, str) else raw
            if isinstance(parsed, (str, int, float, bool)):
                return parsed
            return json.dumps(parsed, ensure_ascii=False)
        except (ValueError, TypeError):
            return raw

    def memory_summary(
        self,
        scope: str = "user",
        limit: int = MEMORY_INJECT_MAX_ENTRIES,
        max_chars: int = MEMORY_INJECT_MAX_CHARS,
    ) -> str:
        """紧凑 memory 摘要文本供 system prompt 注入（规则化相关性 + 限长防污染）。
        = memory_summary_meta(...)['text']（保持原 str 契约，agent.py / projections.py 不破）。"""
        return self.memory_summary_meta(scope, limit, max_chars)["text"]

    def memory_summary_meta(
        self,
        scope: str = "user",
        limit: int = MEMORY_INJECT_MAX_ENTRIES,
        max_chars: int = MEMORY_INJECT_MAX_CHARS,
    ) -> Dict[str, Any]:
        """P2a — 注入摘要 + 可观测 meta。规则化相关性挑前 limit 条（priority DESC, updated_at
        DESC），格式化为 `- key: value`，整体截断 max_chars。返回
        {text, injected, total, chars, truncated, max_entries, max_chars}：
          - `injected` = 被条数上限选中、参与注入的条目数（`injected` < `total` 即尾部低优先级
            条目被条数上限截掉）；
          - `truncated` = 拼接文本超 max_chars 被字符级截断（此时末尾若干条目正文被裁，故实际进
            prompt 的完整条目可能少于 `injected`）。
        库不存在/表空 → text=''、计数 0（graceful，不阻断 /chat/config）。`total` 走 COUNT(*)
        单查（不 materialize 全表）。"""
        cnt = self._read_one(
            "SELECT COUNT(*) AS n FROM agent_memory_kv WHERE scope = ?", (scope,)
        )
        total = int(cnt["n"]) if cnt else 0
        rows = self._select_injection_rows(scope, limit)
        lines = [f"- {r['key']}: {self._format_memory_value(r.get('value_json'))}" for r in rows]
        text = "\n".join(lines)
        truncated = False
        if len(text) > max_chars:
            text = text[:max_chars] + "\n… (truncated)"
            truncated = True
        return {
            "text": text,
            "injected": len(rows),
            "total": total,
            "chars": len(text),
            "truncated": truncated,
            "max_entries": limit,
            "max_chars": max_chars,
        }
