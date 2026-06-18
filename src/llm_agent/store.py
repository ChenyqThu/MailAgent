"""LLMProcessingStore: track LLM runs against the main sync_store SQLite DB.

Separate table `llm_processing` keyed by internal_id. Does not touch
`email_metadata` (the main sync state); LLM success/failure is an orthogonal
layer so it can be retried / audited / observed independently.
"""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import asdict
from typing import Any, Dict, List, Optional


from src.config import config as cfg


# Exponential backoff in seconds: 1min, 5min, 15min, 1h, 2h
_BACKOFF = [60, 300, 900, 3600, 7200]


def _truncate_long_fields(d: Dict[str, Any], *, max_field_chars: int = 3500) -> Dict[str, Any]:
    """截 dict 内**字段值**而非整个 JSON 字符串, 保证序列化后仍是合法 JSON.

    Sprint 16 cutover 加固: 老代码 ``json.dumps(d)[:4000]`` 把 JSON 字符串硬切 →
    字段中间被切, JSON 不合法, 前端 ``json_extract`` 整页 query 失败.

    策略: 对超长 str 字段截到 ``max_field_chars`` + 加 ``…[truncated]`` marker;
    对 list[str] / list[dict] 做浅截 (整个元素裁短). 不动 int/float/bool/None.
    """
    if not isinstance(d, dict):
        return d
    out: Dict[str, Any] = {}
    for k, v in d.items():
        if isinstance(v, str) and len(v) > max_field_chars:
            out[k] = v[:max_field_chars] + "…[truncated]"
        elif isinstance(v, list):
            new_list: list = []
            for item in v:
                if isinstance(item, str) and len(item) > max_field_chars:
                    new_list.append(item[:max_field_chars] + "…[truncated]")
                elif isinstance(item, dict):
                    new_list.append(_truncate_long_fields(item, max_field_chars=max_field_chars // 2))
                else:
                    new_list.append(item)
            out[k] = new_list
        elif isinstance(v, dict):
            out[k] = _truncate_long_fields(v, max_field_chars=max_field_chars // 2)
        else:
            out[k] = v
    return out


def _backoff_for(retry_count: int) -> float:
    idx = min(retry_count, len(_BACKOFF) - 1)
    return time.time() + _BACKOFF[idx]


class LLMProcessingStore:
    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path or cfg.sync_store_db_path
        self._ensure_schema()

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def get_labels(self, internal_id: int) -> Optional[Dict[str, Any]]:
        """读 labels_json → dict (KOS 增量 hook 用完整 AI 字段; 无/非法则 None)。"""
        with self._conn() as c:
            row = c.execute(
                "SELECT labels_json FROM llm_processing WHERE internal_id = ?",
                (internal_id,),
            ).fetchone()
        if row and row["labels_json"]:
            try:
                return json.loads(row["labels_json"])
            except (json.JSONDecodeError, TypeError):
                return None
        return None

    def reset_stale_pending(self, *, threshold_sec: int = 300) -> int:
        """启动时调用 — pending 状态超 threshold_sec 的 row 转 failed +
        next_retry_at=now, 让 retry 队列接管.

        场景: LLM 调用中途 mail-sync 被 pm2 restart 直接 kill, row 卡
        status='pending' 永远不被 retry 队列拉 (retry queue 只看 status='failed').
        启动时一次性扫一遍 stale pending → failed, 把这些卡住的邮件还回流水线.

        Args:
            threshold_sec: pending 持续多久算 stale (默认 300s = 5 min).
                单次 LLM 调用应在 30-90s 完成, 5min 是宽松的容错窗口.

        Returns:
            被 reset 的 row 数.
        """
        now = time.time()
        cutoff = now - threshold_sec
        with self._conn() as c:
            cursor = c.execute(
                """
                UPDATE llm_processing
                   SET status = 'failed',
                       next_retry_at = ?,
                       last_error = COALESCE(
                           last_error,
                           'stale pending — process killed mid-flight, auto-reset on startup'
                       ),
                       updated_at = ?
                 WHERE status = 'pending'
                   AND updated_at < ?
                """,
                (now, now, cutoff),
            )
            c.commit()
            return cursor.rowcount

    def _ensure_schema(self) -> None:
        with self._conn() as c:
            c.execute(
                """
                CREATE TABLE IF NOT EXISTS llm_processing (
                    internal_id INTEGER PRIMARY KEY,
                    notion_page_id TEXT,
                    mailbox TEXT,
                    status TEXT,
                    retry_count INTEGER DEFAULT 0,
                    next_retry_at REAL,
                    last_error TEXT,
                    model TEXT,
                    input_tokens INTEGER,
                    output_tokens INTEGER,
                    cache_read_input_tokens INTEGER,
                    cache_creation_input_tokens INTEGER,
                    latency_ms INTEGER,
                    labels_json TEXT,
                    created_at REAL,
                    updated_at REAL
                )
                """
            )
            c.execute(
                "CREATE INDEX IF NOT EXISTS idx_llm_status ON llm_processing(status)"
            )
            c.execute(
                "CREATE INDEX IF NOT EXISTS idx_llm_retry "
                "ON llm_processing(next_retry_at) WHERE status='failed'"
            )
            c.commit()

    # ---- writers -----------------------------------------------------------

    def mark_pending(
        self, internal_id: int, notion_page_id: str, mailbox: str
    ) -> None:
        now = time.time()
        with self._conn() as c:
            c.execute(
                """
                INSERT INTO llm_processing
                    (internal_id, notion_page_id, mailbox, status, retry_count,
                     created_at, updated_at)
                VALUES (?, ?, ?, 'pending', 0, ?, ?)
                ON CONFLICT(internal_id) DO UPDATE SET
                    notion_page_id=excluded.notion_page_id,
                    mailbox=excluded.mailbox,
                    status='pending',
                    updated_at=excluded.updated_at
                """,
                (internal_id, notion_page_id, mailbox, now, now),
            )
            c.commit()

    def mark_success(
        self, internal_id: int, labels_obj: Any, page_id: str = ""
    ) -> None:
        now = time.time()
        # labels_obj is expected to be a dataclass; dump as JSON for audit
        try:
            labels_dict = asdict(labels_obj) if hasattr(labels_obj, "__dataclass_fields__") else dict(labels_obj or {})
        except Exception:
            labels_dict = {}
        # Sprint 13 round 8 — keep `reply_suggestion_md` in the SQLite
        # blob so the frontend AIFieldsBlock can render it as a hero.
        # Notion remains the canonical "Reply Suggestion" property (rich
        # text), but the markdown source we used to write it is small
        # enough to live next to ai_summary in labels_json.
        #
        # Cutover hardening: 老代码 ``json.dumps(...)[:4000]`` 暴力截字符串,
        # 字段中间被切断 → labels_json 不再是合法 JSON, 前端
        # ``json_extract(labels_json, '$.x')`` 整页 query 抛 malformed JSON
        # → EmailList 拉不到任何邮件 (Sprint 16 实测 internal_id=54214 触发).
        # 改成 dict 内部截字段 + 末尾 fallback 重序列化, 保证 JSON valid.
        labels_dict = _truncate_long_fields(labels_dict, max_field_chars=3500)
        labels_json = json.dumps(labels_dict, ensure_ascii=False)
        # 二次保险: 极端情况下 ensure_ascii=False 仍可能突破限制 (CJK 字符多),
        # 再 sanity 检查; 超长就把 reply_suggestion_md 整段裁掉再 dump.
        if len(labels_json) > 8000:
            safe_dict = {k: v for k, v in labels_dict.items()
                         if k != "reply_suggestion_md"}
            labels_json = json.dumps(safe_dict, ensure_ascii=False)

        with self._conn() as c:
            c.execute(
                """
                INSERT INTO llm_processing
                    (internal_id, notion_page_id, mailbox, status, retry_count,
                     next_retry_at, last_error, model,
                     input_tokens, output_tokens,
                     cache_read_input_tokens, cache_creation_input_tokens,
                     latency_ms, labels_json, created_at, updated_at)
                VALUES (?, ?, ?, 'success', 0, NULL, NULL, ?,
                        ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(internal_id) DO UPDATE SET
                    notion_page_id=COALESCE(excluded.notion_page_id, notion_page_id),
                    mailbox=excluded.mailbox,
                    status='success',
                    retry_count=0,
                    next_retry_at=NULL,
                    last_error=NULL,
                    model=excluded.model,
                    input_tokens=excluded.input_tokens,
                    output_tokens=excluded.output_tokens,
                    cache_read_input_tokens=excluded.cache_read_input_tokens,
                    cache_creation_input_tokens=excluded.cache_creation_input_tokens,
                    latency_ms=excluded.latency_ms,
                    labels_json=excluded.labels_json,
                    updated_at=excluded.updated_at
                """,
                (
                    internal_id,
                    page_id or labels_dict.get("notion_page_id") or None,
                    labels_dict.get("mailbox") or "",
                    labels_dict.get("model") or "",
                    int(labels_dict.get("input_tokens") or 0),
                    int(labels_dict.get("output_tokens") or 0),
                    int(labels_dict.get("cache_read_input_tokens") or 0),
                    int(labels_dict.get("cache_creation_input_tokens") or 0),
                    int(labels_dict.get("latency_ms") or 0),
                    labels_json,
                    now,
                    now,
                ),
            )
            # v14 (Sprint 16 收尾): 双写主表列 — labels.priority + labels.action_type
            # 镜像到 email_metadata.ai_priority / ai_action 让前端走索引排序/过滤.
            # labels_json 全量仍保留作 backup + 其他 AI 字段 (ai_summary 等).
            ai_priority = (labels_dict.get("priority") or "").strip() or None
            ai_action = (labels_dict.get("action_type") or "").strip() or None
            if ai_priority is not None or ai_action is not None:
                c.execute(
                    """
                    UPDATE email_metadata
                       SET ai_priority = COALESCE(?, ai_priority),
                           ai_action = COALESCE(?, ai_action),
                           updated_at = ?
                     WHERE internal_id = ?
                    """,
                    (ai_priority, ai_action, now, internal_id),
                )
            c.commit()
        # Sprint 15 Stage 2: SSE publish (out of transaction)
        try:
            from src.events.publisher import safe_publish
            safe_publish(
                "llm.success",
                internal_id=internal_id,
                data={
                    "model": labels_dict.get("model") or "",
                    "input_tokens": int(labels_dict.get("input_tokens") or 0),
                    "output_tokens": int(labels_dict.get("output_tokens") or 0),
                    "latency_ms": int(labels_dict.get("latency_ms") or 0),
                },
                source="llm_agent",
            )
        except Exception:
            pass

    def upsert_external_labels(
        self,
        internal_id: int,
        labels: Dict[str, Any],
        source: str = "notion",
        notion_page_id: Optional[str] = None,
        mailbox: Optional[str] = None,
    ) -> None:
        """v14 (Sprint 16 收尾, codex 审 P1): 把外部源 (Notion Custom Agent / 人工
        在 Notion 端改的) AI labels 写回 SQLite, 保证 listEnriched 看到完整状态.

        跟 mark_success 区别:
        - 不带 token usage 指标 (外部源没 model/tokens/latency 等可观测项)
        - status='success' (前端 mapReviewStatus 把 success 映射成 reviewed)
        - 同样写 labels_json + 双写主表列 (ai_priority / ai_action)
        - 已存在 row 时 UPDATE labels_json 但保留旧 token usage 等指标

        Args:
            internal_id: 邮件 PK
            labels: 来源 props dict, 期望含 ai_summary/key_points/category/language/
                sender_priority/action_required/action_type/priority/urgency_reason/
                reply_suggestion_md 等; **schema 跟 AILabels 字段名严格一致**
                (priority / action_type, 不是 ai_priority / ai_action — 后者是 Notion
                property 命名).
            source: 'notion' / 'manual' / 其他, 仅用于 audit 不入 SQL
            notion_page_id / mailbox: 可选, 没有就保留旧值
        """
        now = time.time()
        # 跟 mark_success 一致的字段裁剪 + JSON valid 守卫
        labels_dict = _truncate_long_fields(dict(labels), max_field_chars=3500)
        labels_json = json.dumps(labels_dict, ensure_ascii=False)
        if len(labels_json) > 8000:
            safe_dict = {k: v for k, v in labels_dict.items()
                         if k != "reply_suggestion_md"}
            labels_json = json.dumps(safe_dict, ensure_ascii=False)

        ai_priority = (labels_dict.get("priority") or "").strip() or None
        ai_action = (labels_dict.get("action_type") or "").strip() or None

        with self._conn() as c:
            c.execute(
                """
                INSERT INTO llm_processing
                    (internal_id, notion_page_id, mailbox, status, retry_count,
                     next_retry_at, last_error, model,
                     input_tokens, output_tokens,
                     cache_read_input_tokens, cache_creation_input_tokens,
                     latency_ms, labels_json, created_at, updated_at)
                VALUES (?, ?, ?, 'success', 0, NULL, NULL, ?,
                        NULL, NULL, NULL, NULL, NULL, ?, ?, ?)
                ON CONFLICT(internal_id) DO UPDATE SET
                    notion_page_id=COALESCE(excluded.notion_page_id, notion_page_id),
                    mailbox=COALESCE(excluded.mailbox, mailbox),
                    status='success',
                    last_error=NULL,
                    labels_json=excluded.labels_json,
                    updated_at=excluded.updated_at
                """,
                (
                    internal_id,
                    notion_page_id,
                    mailbox,
                    f"external:{source}",
                    labels_json,
                    now,
                    now,
                ),
            )
            # 双写 email_metadata 主表列 (同 mark_success)
            if ai_priority is not None or ai_action is not None:
                c.execute(
                    """
                    UPDATE email_metadata
                       SET ai_priority = COALESCE(?, ai_priority),
                           ai_action = COALESCE(?, ai_action),
                           updated_at = ?
                     WHERE internal_id = ?
                    """,
                    (ai_priority, ai_action, now, internal_id),
                )
            c.commit()

    def set_reply_suggestion(self, internal_id: int, reply_md: str) -> str:
        """合并 ``reply_suggestion_md`` 进 ``labels_json`` (SSoT) — 不动其它 AI 字段。

        前端 chat / 用户手动编辑回复建议时调。读现有 labels_json (无则空 dict),
        写入 / 覆盖 ``reply_suggestion_md`` 键, 重新序列化落库。row 不存在时新建一行
        (status='success', 仅 labels_json — 没跑过 LLM 也允许手动写建议)。

        与 ``mark_success`` 一致的 JSON valid 守卫: 超长字段裁剪 + 8000 字节兜底
        (极端 CJK 仍超时整段裁掉)。

        Returns:
            **实际落库**的 ``reply_suggestion_md`` 字符串 (可能被 ``_truncate_long_fields``
            或 8000-byte 兜底裁短)。调用方据此回报 chars / 构造结果, 保证「上报值 == SSoT 值」
            (否则 Craft 预填 / LLM next-turn 上下文会与上报内容不一致)。
        """
        now = time.time()
        with self._conn() as c:
            row = c.execute(
                "SELECT labels_json FROM llm_processing WHERE internal_id = ?",
                (internal_id,),
            ).fetchone()
            labels: Dict[str, Any] = {}
            if row and row["labels_json"]:
                try:
                    parsed = json.loads(row["labels_json"])
                    if isinstance(parsed, dict):
                        labels = parsed
                except (json.JSONDecodeError, TypeError):
                    labels = {}
            labels["reply_suggestion_md"] = reply_md
            labels = _truncate_long_fields(labels, max_field_chars=3500)
            labels_json = json.dumps(labels, ensure_ascii=False)
            if len(labels_json) > 8000:
                # 二次保险: 极端 CJK 仍超限 → 把刚写的 reply_suggestion_md 裁到安全长度。
                labels["reply_suggestion_md"] = reply_md[:3500] + "…[truncated]"
                labels_json = json.dumps(labels, ensure_ascii=False)
            c.execute(
                """
                INSERT INTO llm_processing
                    (internal_id, status, retry_count, labels_json, created_at, updated_at)
                VALUES (?, 'success', 0, ?, ?, ?)
                ON CONFLICT(internal_id) DO UPDATE SET
                    labels_json=excluded.labels_json,
                    updated_at=excluded.updated_at
                """,
                (internal_id, labels_json, now, now),
            )
            c.commit()
        # 返回实际落库值 (经 _truncate_long_fields / 8000-byte 兜底裁剪后的最终字符串)。
        return labels["reply_suggestion_md"]

    def set_ai_fields(
        self,
        internal_id: int,
        *,
        action: Optional[str] = None,
        priority: Optional[str] = None,
        review_status: Optional[str] = None,
    ) -> Dict[str, Optional[str]]:
        """覆盖单封邮件的 AI 分类字段 (action_type / priority / review status) — SSoT。

        前端 chat 工具 ``email_set_ai_fields`` 让用户(经 AI)覆盖 LLM 原分类时调。范式同
        ``set_reply_suggestion``: 读现有 labels_json (无则空 dict), **只**写传入的非 None
        字段, 不动其它 AI 字段 (ai_summary / reply_suggestion_md / category / language …)。

        三字段落库位置 (与 email_views.py 读链一一对应):
          - ``action``  → labels_json.action_type + 镜像 email_metadata.ai_action (v14 主表列)
          - ``priority``→ labels_json.priority    + 镜像 email_metadata.ai_priority (v14 主表列)
          - ``review_status`` → llm_processing.status: 'reviewed'→'success' /
            'pending'→'pending' (``_map_review_status`` 反向: success→reviewed,
            failed/gave_up/pending→pending)。**不传则保留旧 status** (没跑过 LLM 的新行默认
            'success', 让既有读链把它当 reviewed —— 与 ``set_reply_suggestion`` 一致)。

        合法枚举校验由调用方 (MailWriteService.set_ai_fields) 在 service 层做; 本方法只负责
        持久化 + JSON valid 守卫 (同 ``set_reply_suggestion``: 超长字段裁剪)。

        Returns:
            实际落库的 ``{"action_type", "priority", "review_status"}`` (review_status 是
            映射后的 ``status`` 列值 'success'/'pending', 上报供调用方据读链回报)。
        """
        now = time.time()
        # review_status (前端 enum) → llm_processing.status 列值。None = 不动 status。
        status_col: Optional[str] = None
        if review_status is not None:
            status_col = "success" if review_status == "reviewed" else "pending"

        with self._conn() as c:
            row = c.execute(
                "SELECT labels_json, status FROM llm_processing WHERE internal_id = ?",
                (internal_id,),
            ).fetchone()
            labels: Dict[str, Any] = {}
            if row and row["labels_json"]:
                try:
                    parsed = json.loads(row["labels_json"])
                    if isinstance(parsed, dict):
                        labels = parsed
                except (json.JSONDecodeError, TypeError):
                    labels = {}
            if action is not None:
                labels["action_type"] = action
            if priority is not None:
                labels["priority"] = priority
            labels = _truncate_long_fields(labels, max_field_chars=3500)
            labels_json = json.dumps(labels, ensure_ascii=False)
            if len(labels_json) > 8000:
                # 二次保险 (同 set_reply_suggestion): 极端 CJK 仍超限 → 裁 reply_suggestion_md。
                if isinstance(labels.get("reply_suggestion_md"), str):
                    labels["reply_suggestion_md"] = (
                        labels["reply_suggestion_md"][:3500] + "…[truncated]"
                    )
                    labels_json = json.dumps(labels, ensure_ascii=False)

            # status 列: 传了 review_status 用映射值; 否则保留旧值, 旧行不存在则默认
            # 'success' (与 set_reply_suggestion 新建行一致 — 手动写也算已 reviewed)。
            effective_status = (
                status_col
                if status_col is not None
                else ((row["status"] if row else None) or "success")
            )
            c.execute(
                """
                INSERT INTO llm_processing
                    (internal_id, status, retry_count, labels_json, created_at, updated_at)
                VALUES (?, ?, 0, ?, ?, ?)
                ON CONFLICT(internal_id) DO UPDATE SET
                    status=excluded.status,
                    labels_json=excluded.labels_json,
                    updated_at=excluded.updated_at
                """,
                (internal_id, effective_status, labels_json, now, now),
            )
            # v14 双写主表列 (同 mark_success / upsert_external_labels): 只动传入的字段。
            mirror_priority = priority if priority is not None else None
            mirror_action = action if action is not None else None
            if mirror_priority is not None or mirror_action is not None:
                c.execute(
                    """
                    UPDATE email_metadata
                       SET ai_priority = COALESCE(?, ai_priority),
                           ai_action = COALESCE(?, ai_action),
                           updated_at = ?
                     WHERE internal_id = ?
                    """,
                    (mirror_priority, mirror_action, now, internal_id),
                )
            c.commit()
        return {
            "action_type": labels.get("action_type") if action is not None else None,
            "priority": labels.get("priority") if priority is not None else None,
            "review_status": status_col,
        }

    def mark_failed(
        self, internal_id: int, error: str, max_retries: int
    ) -> Dict[str, Any]:
        """Increment retry_count, set next_retry_at. Promote to gave_up if over limit."""
        now = time.time()
        with self._conn() as c:
            row = c.execute(
                "SELECT retry_count FROM llm_processing WHERE internal_id = ?",
                (internal_id,),
            ).fetchone()
            current_retries = int((row["retry_count"] if row else 0) or 0)
            new_retries = current_retries + 1
            if new_retries >= max_retries:
                status = "gave_up"
                next_retry = None
            else:
                status = "failed"
                next_retry = _backoff_for(new_retries)
            c.execute(
                """
                INSERT INTO llm_processing
                    (internal_id, status, retry_count, next_retry_at,
                     last_error, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(internal_id) DO UPDATE SET
                    status=excluded.status,
                    retry_count=excluded.retry_count,
                    next_retry_at=excluded.next_retry_at,
                    last_error=excluded.last_error,
                    updated_at=excluded.updated_at
                """,
                (internal_id, status, new_retries, next_retry, (error or "")[:500], now, now),
            )
            c.commit()
        # Sprint 15 Stage 2: SSE publish (out of transaction)
        try:
            from src.events.publisher import safe_publish
            safe_publish(
                "llm.failed" if status == "failed" else "llm.gave_up",
                internal_id=internal_id,
                data={
                    "retry_count": new_retries,
                    "next_retry_at": next_retry,
                    "error": (error or "")[:200],
                },
                source="llm_agent",
            )
        except Exception:
            pass
        return {
            "internal_id": internal_id,
            "retry_count": new_retries,
            "status": status,
            "next_retry_at": next_retry,
        }

    # ---- readers -----------------------------------------------------------

    def get(self, internal_id: int) -> Optional[Dict[str, Any]]:
        with self._conn() as c:
            row = c.execute(
                "SELECT * FROM llm_processing WHERE internal_id = ?",
                (internal_id,),
            ).fetchone()
            return dict(row) if row else None

    def get_ready_for_retry(self, limit: int = 3) -> List[Dict[str, Any]]:
        now = time.time()
        with self._conn() as c:
            rows = c.execute(
                """
                SELECT * FROM llm_processing
                WHERE status = 'failed' AND next_retry_at <= ?
                ORDER BY next_retry_at ASC
                LIMIT ?
                """,
                (now, limit),
            ).fetchall()
            return [dict(r) for r in rows]

    def get_gave_up_count(self) -> int:
        with self._conn() as c:
            row = c.execute(
                "SELECT COUNT(*) AS n FROM llm_processing WHERE status='gave_up'"
            ).fetchone()
            return int(row["n"] if row else 0)

    def get_stats(self) -> Dict[str, int]:
        with self._conn() as c:
            rows = c.execute(
                "SELECT status, COUNT(*) AS n FROM llm_processing GROUP BY status"
            ).fetchall()
            return {r["status"]: int(r["n"]) for r in rows}
