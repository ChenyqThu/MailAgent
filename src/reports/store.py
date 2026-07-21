"""ReportStore —— report_agent（配置）+ report（产物）表的读写。

表 DDL 在 SyncStore._init_database（v18）建好；本类只读写，直连 db_path
（mirror bulk_ingest / digest_query 的 sqlite3 直连模式）。Electron main
（better-sqlite3）也读同一张 report 表展示，故 schema 归 SyncStore 统一owns。
"""

from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from typing import Any, Dict, List, Optional, Tuple

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
    "trigger_mode",
    "timezone",
    "body_full_max",
    "body_full_priorities",
    "context_docs_json",  # v27: preprocess agent 的文档勾选（JSON 数组 of profile-doc 名）
    "fallback_models_json",  # v29: preprocess 行级 fallback 链（JSON 数组；NULL=跟随全局）
    "mark_read_after_processing",  # v32: preprocess 处理后自动标已读（0/1）
    "trigger_json",  # v30: custom agent 触发判别式（cron|email_filter；NULL=非事件型）
    "tool_policy_json",  # v30: custom agent 工具收窄（allowed_tools 交集；NULL=不额外收窄）
    "budget_json",  # v30: custom agent 预算（max_steps/runs_per_day/run_seconds；NULL=全默认）
}

# schedule_json 解析不出 cadence（空 / NULL / 非法 / 缺键 —— CLI 新建 report agent 的默认
# 形态）时视为哪种节律的**唯一定义**。worker 的 fire 判定与「是否走层级聚合」用的是
# schedule_of / cadence_of，本模块的排序权重也用它 —— 两处各写一个字面量默认值正是
# 「排序按 rank 3、执行按 daily」分裂的成因。
DEFAULT_CADENCE = "daily"

# list_agents 的排序权重：周 / 月报是**层级聚合** —— 跑的时候要读同一天已生成的日报
# （src/reports/worker.py::_run_aggregate）。tick_loop 在同一个 tick 里按本列表顺序串行
# await，所以 daily 必须排在 weekly / monthly 前面。改前这条依赖只靠
# 'daily_email_digest' < 'weekly_email_digest' 的**字母序巧合**成立：换个 agent id
# （或用户新建自定义报告 agent）就静默失效 —— 周报稳定少综合一份且不会重算。
# 前端 AgentsTab 用的是同一份 {daily:0, weekly:1, monthly:2} 口径。
_CADENCE_ORDER = {"daily": 0, "weekly": 1, "monthly": 2}
# 非报告型 agent（custom / search / preprocess / project_progress）不参与报告调度
# （worker 里 type != 'report' 直接 continue）→ 统一排在报告 agent 之后，彼此仍按 id 序。
_NON_REPORT_RANK = len(_CADENCE_ORDER)


def schedule_of(row: Dict[str, Any]) -> Dict[str, Any]:
    """agent 行的 schedule_json → dict；空 / NULL / 非法 JSON → ``{}``。"""
    try:
        return json.loads(row.get("schedule_json") or "{}") or {}
    except (json.JSONDecodeError, TypeError):
        return {}


def cadence_of(row: Dict[str, Any]) -> str:
    """agent 行的调度节律；解析不出 → ``DEFAULT_CADENCE``（见其注释：单一定义）。"""
    return str(schedule_of(row).get("cadence") or DEFAULT_CADENCE)


def _agent_sort_key(row: Dict[str, Any]) -> Tuple[int, str]:
    if str(row.get("type") or "report") != "report":
        return _NON_REPORT_RANK, str(row.get("id") or "")
    # 未知 cadence 在 worker 里也走 daily 分支（只有 weekly / monthly 才层级聚合）→
    # 排序同样按 daily，保持「排序 rank ≡ 执行语义」。
    cadence = cadence_of(row)
    return _CADENCE_ORDER.get(cadence, _CADENCE_ORDER[DEFAULT_CADENCE]), str(row.get("id") or "")


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
        """全部 agent 行，按 (cadence 日→周→月, id) 排序 —— 见 ``_agent_sort_key``。"""
        with self._connection() as conn:
            rows = conn.execute("SELECT * FROM report_agent ORDER BY id").fetchall()
            return sorted((dict(r) for r in rows), key=_agent_sort_key)

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

    def create_agent(
        self,
        agent_id: str,
        *,
        type: str = "report",
        title: Optional[str] = None,
        enabled: bool = False,
        model: Optional[str] = None,
        prompt: Optional[str] = None,
        tools_json: Optional[str] = None,
    ) -> Dict[str, Any]:
        """新建一行 agent（type 多态：'report' / 'search' / …）。返回 get_agent(id)。

        冲突语义：id 已存在 → 抛 ``ValueError``（明确报错，区别于 update 的幂等）。
        显式创建意图下静默吞掉冲突会掩盖 UI 重复建同名 agent 的 bug，故选硬报错。
        report 专属列（schedule/window/kos_enrich/…）这里不写（留 NULL/DEFAULT），由
        update_agent 后续按需补；search agent 不需要这些列。
        """
        if self.get_agent(agent_id) is not None:
            raise ValueError(f"report_agent {agent_id!r} already exists")
        with self._connection() as conn:
            conn.execute(
                "INSERT INTO report_agent (id, type, enabled, title, model, prompt, "
                "tools_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    agent_id, type, 1 if enabled else 0, title, model, prompt,
                    tools_json, time.time(),
                ),
            )
            conn.commit()
        return self.get_agent(agent_id) or {}

    def delete_agent(self, agent_id: str) -> bool:
        """删一行 agent。返回是否真的删到（不存在 → False）。"""
        with self._connection() as conn:
            cur = conn.execute("DELETE FROM report_agent WHERE id = ?", (agent_id,))
            conn.commit()
            return cur.rowcount > 0

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

    def reclaim_stale_generating(self, *, stale_sec: int = 900) -> int:
        """回收孤儿 generating 行 → failed（进程在生成中途被杀/崩溃的遗留）。

        generating 无终态写入时 UI 永远转圈且 worker 不重试 (dogfood round 3:
        用户点日报生成后 app 重启, 行卡 generating 永不恢复)。每 tick 调一次,
        把 created_at 早于 stale_sec (默认 15min, 远大于单份报告 LLM 生成时长)
        的 generating 行标 failed — UI 即显示失败态可手动重新生成。返回回收数。
        """
        cutoff = time.time() - stale_sec
        with self._connection() as conn:
            cur = conn.execute(
                """
                UPDATE report SET
                    status = 'failed',
                    error = 'orphaned: process exited mid-generation (auto-reclaimed)',
                    generated_at = ?
                WHERE status = 'generating' AND created_at < ?
                """,
                (time.time(), cutoff),
            )
            conn.commit()
            return cur.rowcount

    def get_report(self, report_id: str) -> Optional[Dict[str, Any]]:
        """取单份报告（含 blocks_json）。"""
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM report WHERE id = ?", (report_id,)
            ).fetchone()
            return dict(row) if row else None

    def delete_report(self, report_id: str) -> bool:
        """删一份报告。返回是否真的删到（不存在 → False）。"""
        with self._connection() as conn:
            cur = conn.execute("DELETE FROM report WHERE id = ?", (report_id,))
            conn.commit()
            return cur.rowcount > 0

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

    def list_reports_in_range(
        self,
        *,
        cadence: str,
        start_date: str,
        end_date: str,
        status: str = "ready",
        limit: int = 400,
    ) -> List[Dict[str, Any]]:
        """取某 cadence 在 [start_date, end_date]（含, 'YYYY-MM-DD'）内的报告，**含 blocks_json**。

        周 / 月报层级聚合用：综合下层报告（需要子报告内容，故带 blocks_json）。report_date
        字典序与日期序一致，可直接 >= / <= 比较；按日期升序返回（便于按时间叙述）。
        也带 window_start / window_end —— 调用方（worker._select_period_subreports）按
        子报告的**内容窗口**而非 report_date 判归属（rolling_24h 日报两者差一天）。
        """
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT id, agent_id, cadence, report_date, window_start, window_end, "
                "status, headline, blocks_json, counts_json FROM report "
                "WHERE cadence = ? AND report_date >= ? AND report_date <= ? AND status = ? "
                "ORDER BY report_date ASC LIMIT ?",
                (cadence, start_date, end_date, status, limit),
            ).fetchall()
            return [dict(r) for r in rows]
