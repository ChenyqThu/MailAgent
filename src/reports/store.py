"""ReportStore —— report_agent（配置）+ report（产物）表的读写。

表 DDL 在 SyncStore._init_database（v18）建好；本类只读写，直连 db_path
（mirror bulk_ingest / digest_query 的 sqlite3 直连模式）。Electron main
（better-sqlite3）也读同一张 report 表展示，故 schema 归 SyncStore 统一owns。
"""

from __future__ import annotations

import sqlite3
import time
from contextlib import contextmanager
from typing import Any, Dict, List, Optional

# update_agent 允许 patch 的字段（白名单，防 SQL 注入 + 防误改主键）。
_AGENT_PATCH_FIELDS = {
    "enabled",
    "title",
    "schedule_json",
    "window_hours",
    "prompt",
    "model",
    "tools_json",
    "kos_enrich",
}

# 列表查询不返回 blocks_json（重），详情才取。
_REPORT_LIST_COLS = (
    "id, agent_id, cadence, report_date, window_start, window_end, status, "
    "counts_json, headline, model, input_tokens, output_tokens, cost_usd, "
    "error, created_at, generated_at"
)


class ReportStore:
    def __init__(self, db_path: str = "data/sync_store.db"):
        self.db_path = db_path

    @contextmanager
    def _connection(self):
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    # ==================== agent 配置 ====================

    def get_agent(self, agent_id: str) -> Optional[Dict[str, Any]]:
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM report_agent WHERE id = ?", (agent_id,)
            ).fetchone()
            return dict(row) if row else None

    def list_agents(self) -> List[Dict[str, Any]]:
        with self._connection() as conn:
            rows = conn.execute("SELECT * FROM report_agent ORDER BY id").fetchall()
            return [dict(r) for r in rows]

    def update_agent(self, agent_id: str, patch: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """部分更新 agent 配置（只认白名单字段）。返回更新后的行。"""
        fields = {k: v for k, v in patch.items() if k in _AGENT_PATCH_FIELDS}
        if not fields:
            return self.get_agent(agent_id)
        set_clause = ", ".join(f"{k} = ?" for k in fields) + ", updated_at = ?"
        params: List[Any] = list(fields.values()) + [time.time(), agent_id]
        with self._connection() as conn:
            conn.execute(f"UPDATE report_agent SET {set_clause} WHERE id = ?", params)
            conn.commit()
        return self.get_agent(agent_id)

    # ==================== report 产物 ====================

    def create_report(
        self,
        *,
        report_id: str,
        agent_id: str,
        cadence: str,
        report_date: str,
        window_start: str,
        window_end: str,
        status: str = "generating",
    ) -> str:
        """建一条报告行（status=generating）。同 id 覆盖（重跑同 slot）。"""
        with self._connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO report
                    (id, agent_id, cadence, report_date, window_start, window_end,
                     status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (report_id, agent_id, cadence, report_date, window_start, window_end,
                 status, time.time()),
            )
            conn.commit()
        return report_id

    def finish_report(
        self,
        report_id: str,
        *,
        status: str,
        blocks_json: Optional[str] = None,
        counts_json: Optional[str] = None,
        headline: Optional[str] = None,
        model: Optional[str] = None,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cost_usd: float = 0.0,
        error: Optional[str] = None,
    ) -> None:
        """写入终态（ready/failed/empty/skipped）+ 产物/统计。"""
        with self._connection() as conn:
            conn.execute(
                """
                UPDATE report SET
                    status = ?, blocks_json = ?, counts_json = ?, headline = ?,
                    model = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?,
                    error = ?, generated_at = ?
                WHERE id = ?
                """,
                (status, blocks_json, counts_json, headline, model, input_tokens,
                 output_tokens, cost_usd, error, time.time(), report_id),
            )
            conn.commit()

    def get_report(self, report_id: str) -> Optional[Dict[str, Any]]:
        """取单份报告（含 blocks_json）。"""
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM report WHERE id = ?", (report_id,)
            ).fetchone()
            return dict(row) if row else None

    def list_reports(
        self,
        *,
        cadence: Optional[str] = None,
        agent_id: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        """报告列表（不含 blocks_json）。按 report_date / created_at 倒序。"""
        where: List[str] = []
        params: List[Any] = []
        if cadence:
            where.append("cadence = ?")
            params.append(cadence)
        if agent_id:
            where.append("agent_id = ?")
            params.append(agent_id)
        where_sql = (" WHERE " + " AND ".join(where)) if where else ""
        params += [limit, offset]
        with self._connection() as conn:
            rows = conn.execute(
                f"SELECT {_REPORT_LIST_COLS} FROM report{where_sql} "
                "ORDER BY report_date DESC, created_at DESC LIMIT ? OFFSET ?",
                params,
            ).fetchall()
            return [dict(r) for r in rows]
