"""ai_chat.db 读 + 写访问 —— serve-api 远程 chat 端点（V2.1 阶段 2 读 + 阶段 3 3b-3 写）。

ai_chat.db = 前端 owned schema（``frontend/src/electron/main/chat_db.ts``，CHAT_DB_VERSION 25）。
v25（harness optimization P2，task 08-07）= ``ai_chat_sessions.parent_session_id`` /
``parent_tool_call_id`` / ``invoked_by``。三列均 nullable，父会话删除不级联；Python 只读。
v24（harness optimization P1，task 08-07）= ``ai_chat_sessions.trigger_id`` / ``trigger_kind`` /
``trigger_fired_at`` 与 agent/trigger 两个查询索引。三列均 nullable；Python 只读且通过
``_has_column`` 兼容尚未迁移的 v23 库。
v23（WP-15 context 环，task 08-05）= ``ai_chat_messages.context_tokens``：本回合最后一次
provider 调用的 prompt token 数（= composer 右下 context 环显示的「上下文占用」）。
🔴 与 ``tokens_input`` **语义不同** —— 那一列是 ai@7 的多 step **求和**（工具循环回合里同一段
prompt 被计好几遍），这一列是**末 step** 的 inputTokens。只有前端 gateway 的 persistTurn 写，
本文件**不写**这一列；读侧 ``SELECT *`` 自动带回（远程 web 因此与桌面同源）。
v22（飞书 messenger 阶段 2 PR-1，task 08-01）= ``ai_chat_sessions.origin`` 值域登记 ``'im'``
（**无 schema 变更**的 no-op ladder 步：origin 是 v19 加的无 CHECK 自由文本列，值域现为
'agent' | 'im' | NULL=交互）。'im' 行由 gateway 主进程 ``createImSession`` 写（origin='im'，
general anchor，飞书会话），默认交互列表过滤 ``COALESCE(origin,'interactive') <> 'agent'``
**有意**不动 —— 'im' 行自动进桌面会话列表（Q18=A「来自飞书」）。本文件读侧 ``SELECT *`` /
``s.*`` 自动带回，``list_all_sessions`` 的 origin 过滤参数值域暂不加 'im'（TS 侧
ChatSessionOriginFilter 已补词表、无调用方传它；两侧过滤 SQL 逐字镜像不变）。
v21（custom-agent epic W3，task 07-28）= ``ai_chat_sessions.pinned_at`` + ``starred``：
置顶分组顺序与独立星标状态；两类组织动作均不 bump updated_at。
v20（harness-chat lane A B4，task 07-15）= ``ai_chat_sessions.last_read_at``：未读徽标的
per-session 已读水位（NULL = 旧行/从未打开 → 不打点；未读判定 = updated_at > last_read_at）。
写经本文件 ``update_session_last_read``（serve-api PATCH /chat/sessions/{id}/read，远程 parity），
刻意不 bump updated_at（已读绝不重排历史）；读走 ``SELECT *`` 自动带回 + list_all_sessions 显式列
已加 s.last_read_at。additive ALTER（schema 归 chat_db connection.ts ``migrate``，本文件不建表）。
NOT EXPECTED_DB_VERSION。
v19（S4 W3，task 07-02-s4-custom-agent-core）= ``ai_chat_sessions.origin`` + ``agent_id`` +
``agent_job_id``：headless custom-agent run（cron/email 触发，ADR-003 D3）落一个一等会话行，
origin='agent' 标记（交互会话 NULL），agent_id/agent_job_id 回链 report_agent + async_jobs
（agent_job_id = async_jobs.job_id 的 TEXT，跨库无 FK）。backend_kind CHECK 不变（仍 'ai-sdk'，
引擎没变、只是发起方变）。三个 additive ALTER，读走 ``SELECT *`` 自动带回；本文件不建表/不写这三列
（schema 归 chat_db.ts ``migrate``，会话创建走 gateway 主进程 ``createAgentSession``）。NOT EXPECTED_DB_VERSION。
v18（S2 W1，task 07-02-s2-exec-skill-install）= ``chat_tool_call.whitelist_rule_id``：S2 exec 工具
（run_command / file_read / file_write）经结构化白名单 PolicyRule 命中而**免卡执行**的审计行记
``approval_status='auto_whitelist'``（approval_status 是自由 TEXT，v10 加时无 CHECK，新值无需枚举迁移）
（07-16 approval-mode switcher 无 bump 再加三个自由值：``auto_accept_edits`` / ``auto_bypass``
（owner 全局模式跳卡，含 send）/ ``auto_reversible``（既有可逆免卡路径，原先不可区分地记 'approved'）；
'approved'/'edited' 自此专指真实人工卡决定）
+ ``whitelist_rule_id`` = 命中的规则 id。gateway 在 Electron main 经 chat_db.ts 直写（本 serve-api 路径
不写此列，同 v10-v12：``append_tool_call`` 既有写面不变、新列默认 NULL；读走 ``SELECT *`` 自动带回）。
v17（S1 R1，task 07-02 openness wave1）= ``ai_chat_messages_fts``：ai_chat_messages.content 的
FTS5 external-content 索引（tokenize='trigram'，中文子串可搜）+ INSERT/UPDATE/DELETE 同步触发器
+ 存量 'rebuild' backfill。本文件新增 ``search_sessions``（**只 SELECT**，0 CREATE TABLE 不变式
保持）：≥3 字符 query 走 FTS MATCH（phrase 转义，用户输入永不解析为 FTS 语法）；<3 字符（trigram
索引够不着）或 FTS 表不存在（旧库未经前端迁移）→ LIKE 降级。
v16（M5b，2026-06-30）= agent_memory_kv 物理退役（DROP TABLE）。记忆终态 = user.md(M3 恒注入) +
mem0(M1/M2 capture/召回)；KV 表无 FK 依赖，简单事务 DROP。NOT EXPECTED_DB_VERSION。
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

import os
import sqlite3
import time
from contextlib import contextmanager
from typing import Any, Dict, List, Optional


def _now_ms() -> int:
    """epoch 毫秒（对齐 chat_db.ts ``Date.now()``，所有写的 created_at/updated_at 用它）。"""
    return int(time.time() * 1000)


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


def _clip_snippet(content: str, query: str, snippet_chars: int) -> str:
    """把命中消息裁成以命中词为中心的 snippet（≤ snippet_chars 字符）。

    大小写不敏感找 query 首次出现位置，窗口前置 ~30% 上下文；找不到（FTS 多词/大小写折叠
    差异等）退化为开头截断。截断侧加省略号标记，模型能看出这是节选。
    """
    if len(content) <= snippet_chars:
        return content
    idx = content.lower().find(query.lower())
    if idx < 0:
        return content[:snippet_chars] + "…"
    lead = max(0, idx - max(20, snippet_chars * 3 // 10))
    clipped = content[lead : lead + snippet_chars]
    prefix = "…" if lead > 0 else ""
    suffix = "…" if lead + snippet_chars < len(content) else ""
    return f"{prefix}{clipped}{suffix}"


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

    def _has_column(self, table: str, column: str) -> bool:
        """Best-effort schema probe for compatibility reads against a pre-migration frontend DB."""
        if not os.path.exists(self.db_path):
            return False
        try:
            with self._connection() as conn:
                rows = conn.execute(f"PRAGMA table_info({table})")
                return any(row["name"] == column for row in rows)
        except sqlite3.Error:
            return False

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
        origin_clause = (
            " AND COALESCE(origin, 'interactive') <> 'agent'"
            if self._has_column("ai_chat_sessions", "origin")
            else ""
        )
        return self._read_all(
            "SELECT * FROM ai_chat_sessions WHERE anchor_type = 'general'"
            f"{origin_clause} ORDER BY updated_at DESC",
        )

    def list_all_sessions(
        self,
        limit: int = 300,
        include_archived: bool = False,
        origin: str = "interactive",
        *,
        agent_id: Optional[str] = None,
        agent_job_id: Optional[str] = None,
        trigger_id: Optional[str] = None,
        trigger_kind: Optional[str] = None,
        created_after: Optional[int] = None,
        created_before: Optional[int] = None,
        archived: Optional[bool] = None,
        starred: Optional[bool] = None,
    ) -> List[Dict[str, Any]]:
        """跨邮件 session 历史（含 first_user_message 预览 + message_count，排除无消息 session）。
        镜像 listAllSessions → ChatSessionSummary[]。
        include_archived=False（默认）只返回活跃会话（archived=0）；
        include_archived=True 返回全部含归档会话（用于归档分组视图）。

        v20 起用 ``s.*``（TS 侧仍显式列）：serve-api 可能先于前端 migrate 跑到（启动竞态 /
        旧库），显式引用 last_read_at 会在 pre-v20 库上 OperationalError → _read_all 吞成 []
        = 整个历史列表被清空。``s.*`` 两个世界都成立：列在 → 带回（未读徽标），列不在 →
        缺键（前端按 undefined = 无徽标处理）。"""
        if origin not in ("interactive", "agent", "im", "all"):
            raise ValueError(f"invalid session origin filter: {origin!r}")
        clauses = []
        params: list[Any] = []
        if archived is not None:
            clauses.append("s.archived = ?")
            params.append(1 if archived else 0)
        elif not include_archived:
            clauses.append("s.archived = 0")
        has_origin = self._has_column("ai_chat_sessions", "origin")
        if origin == "interactive" and has_origin:
            clauses.append("COALESCE(s.origin, 'interactive') <> 'agent'")
        elif origin == "agent":
            if not has_origin:
                return []
            clauses.append("s.origin = 'agent'")
        elif origin == "im":
            if not has_origin:
                return []
            clauses.append("s.origin = 'im'")
        for column, value in (
            ("agent_id", agent_id), ("agent_job_id", agent_job_id),
            ("trigger_id", trigger_id), ("trigger_kind", trigger_kind),
        ):
            if value is None:
                continue
            if not self._has_column("ai_chat_sessions", column):
                return []
            clauses.append(f"s.{column} = ?")
            params.append(value)
        if created_after is not None:
            clauses.append("s.created_at >= ?")
            params.append(created_after)
        if created_before is not None:
            clauses.append("s.created_at <= ?")
            params.append(created_before)
        if starred is not None:
            if not self._has_column("ai_chat_sessions", "starred"):
                return []
            clauses.append("s.starred = ?")
            params.append(1 if starred else 0)
        clauses.append("EXISTS (SELECT 1 FROM ai_chat_messages m WHERE m.session_id = s.id)")
        where_clause = " AND ".join(clauses)
        return self._read_all(
            f"""SELECT
                 s.*,
                 (SELECT substr(m.content, 1, 500) FROM ai_chat_messages m
                    WHERE m.session_id = s.id AND m.role = 'user'
                    ORDER BY m.created_at ASC LIMIT 1) AS first_user_message,
                 (SELECT COUNT(*) FROM ai_chat_messages m WHERE m.session_id = s.id) AS message_count
               FROM ai_chat_sessions s
               WHERE {where_clause}
               ORDER BY s.updated_at DESC
               LIMIT ?""",
            (*params, max(1, min(int(limit), 300))),
        )

    # ── messages ──────────────────────────────────────────────────────────

    def list_messages(self, session_id: int) -> List[Dict[str, Any]]:
        """某 session 的全部消息（按 created_at/id 升序）。镜像 listMessages → ChatMessage[]。"""
        return self._read_all(
            "SELECT * FROM ai_chat_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC",
            (session_id,),
        )

    def get_latest_assistant_message(self, session_id: int) -> Optional[Dict[str, Any]]:
        """某 session 最新一条 assistant 消息 or None（**只读**，graceful 同 _read_one）。

        飞书 IM 桥（``src/im/bridge.py``，08-01 阶段 2 PR-3）在审批 decide 终态后
        取「本回合的完整最终回复」用 —— ``/decide`` 响应里的 ``summary`` 是 gateway
        180 字符截断的一行摘要，完整文本只在这儿。调用侧自带 created_at 时间闸 +
        有界重试，本函数不做等待。
        """
        return self._read_one(
            "SELECT * FROM ai_chat_messages WHERE session_id = ? AND role = 'assistant' "
            "ORDER BY created_at DESC, id DESC LIMIT 1",
            (session_id,),
        )

    # ── session search（S1 R1，只 SELECT — 0 CREATE TABLE 不变式）───────────

    def search_sessions(
        self,
        query: str,
        *,
        session_limit: int = 20,
        snippets_per_session: int = 3,
        snippet_chars: int = 200,
        origin: str = "all",
        agent_id: Optional[str] = None,
        agent_job_id: Optional[str] = None,
        trigger_id: Optional[str] = None,
        trigger_kind: Optional[str] = None,
        created_after: Optional[int] = None,
        created_before: Optional[int] = None,
        archived: Optional[bool] = None,
        starred: Optional[bool] = None,
    ) -> List[Dict[str, Any]]:
        """按消息内容检索历史会话，按 session 聚合返回 {session 元数据 + 命中 snippet}。

        检索路径两级：≥3 字符 query → ``ai_chat_messages_fts`` MATCH（trigram，中文子串可搜；
        query 恒转义成 FTS phrase ``"…"``，用户输入永不解析为 FTS 语法 → AND/OR/* 注入不进
        MATCH 表达式）；<3 字符（trigram 索引最小 token=3，注定 0 命中）或 FTS 表不存在
        （旧库未经前端 v17 迁移，OperationalError）→ LIKE 降级（``%``/``_``/``\\`` 转义）。

        cap：session ≤ ``session_limit``（clamp 到 [1,20]）、每 session snippet ≤
        ``snippets_per_session``、每 snippet ≤ ``snippet_chars`` 字符（命中词居中切窗）。
        排序：FTS 按 rank（bm25），LIKE 按 created_at 倒序；session 序 = 其首个命中的出现序。
        graceful（读契约）：库不存在 / 锁 / 损坏 → []。
        """
        query = (query or "").strip()
        if not query or not os.path.exists(self.db_path):
            return []
        session_limit = max(1, min(int(session_limit), 20))
        snippets_per_session = max(1, min(int(snippets_per_session), 5))
        # 命中行按 hit-cap 预取：足够填满 session_limit×snippets 的聚合，又不无界扫全库。
        hit_cap = 200
        try:
            with self._connection() as conn:
                hits: Optional[List[sqlite3.Row]] = None
                if len(query) >= 3:
                    # FTS5 phrase：内部双引号翻倍转义 → 整个 query 是单一 phrase 字面量。
                    match_expr = '"' + query.replace('"', '""') + '"'
                    try:
                        hits = conn.execute(
                            """SELECT m.session_id, m.id AS message_id, m.role,
                                      substr(m.content, 1, 4000) AS content, m.created_at
                                 FROM ai_chat_messages_fts f
                                 JOIN ai_chat_messages m ON m.id = f.rowid
                                WHERE ai_chat_messages_fts MATCH ?
                                ORDER BY rank
                                LIMIT ?""",
                            (match_expr, hit_cap),
                        ).fetchall()
                    except sqlite3.OperationalError:
                        hits = None  # FTS 表不存在（未迁移库）→ LIKE 降级
                if hits is None:
                    like_expr = (
                        "%"
                        + query.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")
                        + "%"
                    )
                    hits = conn.execute(
                        r"""SELECT m.session_id, m.id AS message_id, m.role,
                                  substr(m.content, 1, 4000) AS content, m.created_at
                             FROM ai_chat_messages m
                            WHERE m.content LIKE ? ESCAPE '\'
                            ORDER BY m.created_at DESC, m.id DESC
                            LIMIT ?""",
                        (like_expr, hit_cap),
                    ).fetchall()

                # 按 session 聚合：session 序 = 首个命中的出现序（FTS=rank / LIKE=新→旧）。
                by_session: Dict[int, List[sqlite3.Row]] = {}
                order: List[int] = []
                for h in hits:
                    sid = h["session_id"]
                    if sid not in by_session:
                        if len(order) >= session_limit:
                            continue
                        by_session[sid] = []
                        order.append(sid)
                    if len(by_session[sid]) < snippets_per_session:
                        by_session[sid].append(h)
                if not order:
                    return []

                placeholders = ",".join("?" * len(order))
                session_rows = {
                    r["id"]: dict(r)
                    for r in conn.execute(
                        f"SELECT id, email_id, anchor_type, backend_kind, title, archived, "
                        f"created_at, updated_at FROM ai_chat_sessions "
                        f"WHERE id IN ({placeholders})",
                        order,
                    ).fetchall()
                }
                allowed = {
                    row["id"]: row
                    for row in self.list_all_sessions(
                        limit=300, include_archived=True, origin=origin,
                        agent_id=agent_id, agent_job_id=agent_job_id,
                        trigger_id=trigger_id, trigger_kind=trigger_kind,
                        created_after=created_after, created_before=created_before,
                        archived=archived, starred=starred,
                    )
                }
                out: List[Dict[str, Any]] = []
                for sid in order:
                    sess = session_rows.get(sid)
                    if sess is None or sid not in allowed:
                        continue  # 孤儿消息（session 行已删）— 防御，正常被 FK CASCADE 挡住
                    sess = allowed[sid]
                    out.append(
                        {
                            "session": sess,
                            "snippets": [
                                {
                                    "message_id": h["message_id"],
                                    "role": h["role"],
                                    "snippet": _clip_snippet(
                                        h["content"], query, snippet_chars
                                    ),
                                    "created_at": h["created_at"],
                                }
                                for h in by_session[sid]
                            ],
                        }
                    )
                return out
        except sqlite3.Error:
            return []

    # ── tool calls ────────────────────────────────────────────────────────

    def list_tool_calls_for_message(self, message_id: int) -> List[Dict[str, Any]]:
        """某 assistant 消息的工具调用审计行（按 created_at/id 升序）。
        镜像 listToolCallsForMessage → ChatToolCall[]。无 tool_use 的消息返 []。"""
        return self._read_all(
            "SELECT * FROM chat_tool_call WHERE message_id = ? ORDER BY created_at ASC, id ASC",
            (message_id,),
        )

    def list_im_approvals(self, limit: int = 20) -> Optional[List[Dict[str, Any]]]:
        """飞书（``ai_chat_sessions.origin='im'``）会话里的**人工审批决定**，最近 N 条倒序。

        08-01 阶段 2 PR-4「信任可见」：设置-AI「飞书对话」区的「批过哪些操作」用。

        🔴 **只取真人决定的三个值** ``approved`` / ``edited`` / ``rejected``。另外四个
        ``auto_*``（auto_whitelist / auto_accept_edits / auto_bypass / auto_reversible）
        是**免卡执行**的审计位（值域纪律见 ``frontend/src/ai-gateway/tools/types.ts``
        的分值域注释），把它们混进「批过哪些操作」= 谎报有人批过。read 类工具该列为
        NULL，自然不入选。

        🔴 **判据是「会话 origin='im'」，不是「点击发生在飞书」** —— gateway 对桌面
        审批卡与飞书审批卡写的是同一个 ``approval_status``，DB 层分不出点击来自哪一
        侧。故本投影的诚实语义是「飞书会话里的审批决定」，调用侧文案必须照此写。

        时间取 ``COALESCE(confirmed_at, updated_at)``：``chat_tool_call`` 没有
        ``decided_at`` 列，``confirmed_at`` 是审批落定戳、``updated_at`` 兜住它为空的行
        （实测生产行 ``confirmed_at`` 恒 NULL —— 写侧 ``updateToolCall`` 至今没有调用方传它）。

        🔴 ``decided_at`` 的单位是 **epoch 毫秒**（两列都由 ``chat_db/tool_calls.ts`` 的
        ``Date.now()`` 写入），**不是秒** —— 与 sync_state 里 Python ``time.time()`` 写的那些
        时间戳单位相反，且都是整数、在 JSON 里肉眼分不出来。本方法原样透出不做换算，
        **渲染侧必须按毫秒解释**（按秒解释不会报错，只会把 2026 年画成五万七千年）。

        库不存在 / 表未初始化 / 锁 → **None**（调用方降级成「读不到」）——有意不走
        ``_read_all`` 的 graceful ``[]``：把不可达渲染成「零条审批」就是谎报，镜像
        ``count_auto_whitelist_writes`` 的 None-vs-空 纪律。
        """
        n = max(1, int(limit))
        if not os.path.exists(self.db_path):
            return None
        try:
            with self._connection() as conn:
                rows = conn.execute(
                    "SELECT tc.tool_name AS tool_name, "
                    "tc.approval_status AS approval_status, "
                    "COALESCE(tc.confirmed_at, tc.updated_at) AS decided_at, "
                    "m.session_id AS session_id, s.title AS session_title "
                    "FROM chat_tool_call tc "
                    "JOIN ai_chat_messages m ON m.id = tc.message_id "
                    "JOIN ai_chat_sessions s ON s.id = m.session_id "
                    "WHERE s.origin = 'im' "
                    "AND tc.approval_status IN ('approved', 'edited', 'rejected') "
                    "ORDER BY decided_at DESC, tc.id DESC LIMIT ?",
                    (n,),
                ).fetchall()
                return [dict(r) for r in rows]
        except sqlite3.Error:
            return None

    def count_auto_whitelist_writes(
        self, session_ids: List[int]
    ) -> Optional[Dict[int, Dict[str, Any]]]:
        """按 session 统计免卡执行审计行（S5 ADR-004 D6 badge；S6 W3-2 rev3.1 §4.4/F#3 分源）。

        ``chat_tool_call.approval_status='auto_whitelist'``（CHAT_DB v18 语义，gateway 直写）
        经 message→session join 归到会话，并按 ``whitelist_rule_id`` 是否为空分两源：
        **rule-source**（rule_id 非空 = owner 逐条建的白名单规则命中）与 **grant-source**
        （rule_id=null = grant 级免卡，如 open 档 web_fetch / web_search 授权），grant 桶按
        ``tool_name`` 细分（UI 据此区分「全开放联网」vs「搜索授权」）。🔴 投影**不得假设
        rule_id 非空**——grant 级免卡行 rule_id 天然为 null。

        返回 ``{session_id: {"total": n, "rule": n, "grant": {tool_name: n}}}``（无命中的 id
        不在 dict，调用方 default 0）。库不存在 / 表未初始化 / 锁 → **None**（调用方把字段
        降级为 null）—— 有意不走 ``_read_all`` 的 graceful ``[]``：badge 必须区分「账本可达
        且 0 次免卡」与「账本不可达」，后者渲染 0 就是谎报。
        """
        ids = [int(s) for s in session_ids]
        if not ids:
            return {}
        if not os.path.exists(self.db_path):
            return None
        placeholders = ",".join("?" * len(ids))
        try:
            with self._connection() as conn:
                rows = conn.execute(
                    "SELECT m.session_id AS sid, tc.tool_name AS tool, "
                    "(tc.whitelist_rule_id IS NULL) AS grant_source, COUNT(*) AS n "
                    "FROM chat_tool_call tc "
                    "JOIN ai_chat_messages m ON m.id = tc.message_id "
                    "WHERE tc.approval_status = 'auto_whitelist' "
                    f"AND m.session_id IN ({placeholders}) "
                    "GROUP BY m.session_id, tc.tool_name, grant_source",
                    tuple(ids),
                ).fetchall()
                out: Dict[int, Dict[str, Any]] = {}
                for r in rows:
                    sid = int(r["sid"])
                    bucket = out.setdefault(sid, {"total": 0, "rule": 0, "grant": {}})
                    n = int(r["n"])
                    bucket["total"] += n
                    if r["grant_source"]:
                        tool = str(r["tool"])
                        bucket["grant"][tool] = bucket["grant"].get(tool, 0) + n
                    else:
                        bucket["rule"] += n
                return out
        except sqlite3.Error:
            return None

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

    def update_session_model(self, session_id: int, model: Optional[str]) -> None:
        """W8 per-session 模型偏好（task 08-04 WP2）：把 composer 里刚选的模型写回该会话行。

        ``ai_chat_sessions.backend_model`` 列与 chat_db.ts ``getOrCreateSession`` 的
        refresh-on-touch 分支早就写好了，但**调用链触达不到**——renderer 只在建会话时传一次
        backendModel，之后换模型只落 localStorage（全局一份，切会话不区分）。本方法是缺的那
        一环：切模型 → 落该会话行 → 重开时回填（零 ALTER、零 CHAT_DB_VERSION bump）。

        刻意**不** bump updated_at（同 title/archived/pinned/starred 纪律：换模型不该把会话
        顶到历史列表最前）。改不存在的 id 是 no-op。``model=None`` = 清空（回落全局默认）。
        """
        with self._write_connection() as conn:
            conn.execute(
                "UPDATE ai_chat_sessions SET backend_model = ? WHERE id = ?",
                (model, session_id),
            )

    def update_session_archived(self, session_id: int, archived: bool) -> None:
        """设置 session 归档状态（软删）。镜像 chat_db.ts updateSessionArchived：刻意不 bump
        updated_at → 归档不重排历史列表。改不存在的 id 是 no-op（UPDATE 匹配 0 行）。"""
        with self._write_connection() as conn:
            conn.execute(
                "UPDATE ai_chat_sessions SET archived = ? WHERE id = ?",
                (1 if archived else 0, session_id),
            )

    def update_session_pinned(
        self, session_id: int, pinned: bool, at_ms: Optional[int] = None
    ) -> None:
        """置顶/取消置顶；置顶时间决定 pinned 分组顺序，不 bump updated_at。"""
        pinned_at = (at_ms if at_ms is not None else _now_ms()) if pinned else None
        with self._write_connection() as conn:
            conn.execute(
                "UPDATE ai_chat_sessions SET pinned_at = ? WHERE id = ?",
                (pinned_at, session_id),
            )

    def update_session_starred(self, session_id: int, starred: bool) -> None:
        """设置独立星标状态；不重排、不分组，也不 bump updated_at。"""
        with self._write_connection() as conn:
            conn.execute(
                "UPDATE ai_chat_sessions SET starred = ? WHERE id = ?",
                (1 if starred else 0, session_id),
            )

    def update_session_last_read(self, session_id: int, at_ms: Optional[int] = None) -> None:
        """harness-chat lane A B4（task 07-15）— 置 session 已读水位 last_read_at=now（v20 列）。

        刻意不 bump updated_at（已读绝不重排历史）；未读判定 = updated_at > last_read_at。
        改不存在的 id 是 no-op。pre-v20 库（前端尚未迁移 / 启动竞态）缺列 → 静默 no-op：
        已读是 best-effort UX 面，绝不该 500（写约束的「缺 schema = 真配置错」对本列例外，
        因为 serve-api 可能先于前端 migrate 服务请求）。"""
        now = at_ms if at_ms is not None else _now_ms()
        try:
            with self._write_connection() as conn:
                conn.execute(
                    "UPDATE ai_chat_sessions SET last_read_at = ? WHERE id = ?",
                    (now, session_id),
                )
        except sqlite3.OperationalError:
            # pre-v20 ai_chat.db（no such column: last_read_at）→ best-effort no-op。
            pass

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
