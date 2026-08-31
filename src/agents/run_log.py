"""统一 agent 执行台账 (`agent_run_log` + `agent_run_step`, DB v73)。

Owner 的要求是「所有 agent 执行历史都有通讯录治理那样的详细过程记录」(task 08-27
L4 P4a, research/r10)。走 gateway 的成员天然有 session transcript；不走 gateway 的
三位 (报告 / 联系人画像 / 项目周报) 用这里的结构化步骤记录, 前端把步骤合成同一个
transcript 形态渲染 (design §8.1 的 trig/think/tool/out 四类节点)。

一次执行 = agent_run_log 一行; 一个节点 = agent_run_step 一行 (seq 定序)。

🔴 status **不发明词表**: 值域是 `src.agents.run_state.AGENT_RUN_STATES` (9 值域,
前端 RunStateBadge 穷举渲染的唯一词表) 的**子集**, 需要别的态从 9 值域取, 禁止
新增第 10 个值。子集关系由下方 import 时校验钉死。

🔴 kind 词表保留 `think` 是给未来开 extended thinking 留位 —— 本批**任何写入方都
不写 think 行**: Python 直连 provider 的那条腿 (LLM client 的 classify /
tool loop) 没开 thinking, 没有数据就不造思考块 (design §8.1「不走 AI 的成员没有
思考块」同一条诚实原则)。

🔴 **零依赖叶子**: 只用 stdlib + loguru + 同包的 run_state (纯 stdlib)。
`src/mail/sync_store.py` 要 import 两个值域元组给表的 CHECK 用 (值域单源, 不手抄
字符串) —— 反过来在这里 import sync_store 就是循环。表 DDL 归 sync_store 拥有
(v73 块), 本模块只读写。

时间单位: epoch **毫秒** (对齐 ai_chat_sessions / v72 惯例)。🔴 与 `async_jobs` 的
`time.time()` **秒**不是一回事 —— 投影成 run 历史行时在 API 边界换算
(`src/api/routers/agent_runs.py::_run_log_item`), 表内不留两种单位。
"""

from __future__ import annotations

import json
import sqlite3
import time
from typing import Any, Dict, Iterable, List, Mapping, Optional

from loguru import logger

from src.agents.run_state import AGENT_RUN_STATES

#: agent_run_log.status 的值域 (sync_store 的表 CHECK 引它, 单源)。
#: 是 9 值域的子集: running=开跑未收尾 (当前写入方都一次性落终态, 留位),
#: completed/failed 同 9 值域语义, skipped=触发了但没干活 (无候选 / 无新邮件 / 幂等跳过)。
AGENT_RUN_LOG_STATUS_VALUES = ("running", "completed", "failed", "skipped")

# 🔴 子集关系是契约不是巧合 —— 加值前先去 run_state.AGENT_RUN_STATES 看有没有现成的。
if not set(AGENT_RUN_LOG_STATUS_VALUES) <= AGENT_RUN_STATES:
    raise RuntimeError(
        "AGENT_RUN_LOG_STATUS_VALUES must be a subset of run_state.AGENT_RUN_STATES"
    )

#: agent_run_step.kind 的值域 (design §8.1 定死的四类节点; sync_store 的 CHECK 引它)。
AGENT_RUN_STEP_KINDS = ("trig", "think", "tool", "out")


def _connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=10.0)
    conn.row_factory = sqlite3.Row
    return conn


def record_agent_run(
    db_path: str,
    *,
    agent_id: str,
    started_at_ms: int,
    status: str,
    completed_at_ms: Optional[int] = None,
    trigger_kind: Optional[str] = None,
    trigger_detail: Optional[str] = None,
    summary: Optional[str] = None,
    model: Optional[str] = None,
    input_tokens: Optional[int] = None,
    output_tokens: Optional[int] = None,
    error: Optional[str] = None,
    steps: Iterable[Mapping[str, Any]] = (),
) -> Optional[int]:
    """一次执行 + 全部步骤落一个事务, 返回 run_log 行 id (写失败返 None)。

    ``steps`` 元素形状: {kind (必填, AGENT_RUN_STEP_KINDS 之一), name?, detail?,
    payload? (dict, 序列化成 payload_json), ok? (bool), ms? (int)}。seq 按迭代序分配。

    🔴 **写失败只 warning 不抛** (抄 v72 画像台账的纪律): 活儿已经干完了, 因为账本
    写不进去而让报告生成 / 画像批 / 周报同步失败是本末倒置; 调用方失败路径还要把
    原异常继续上抛, 这里抛新异常会把原因盖掉。
    """
    completed = completed_at_ms if completed_at_ms is not None else int(time.time() * 1000)
    now_ms = int(time.time() * 1000)
    try:
        conn = _connect(db_path)
        try:
            cursor = conn.execute(
                "INSERT INTO agent_run_log "
                "(agent_id, started_at, completed_at, status, trigger_kind, "
                "trigger_detail, summary, model, input_tokens, output_tokens, error) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    agent_id,
                    int(started_at_ms),
                    completed,
                    status,
                    trigger_kind,
                    trigger_detail,
                    summary,
                    model,
                    input_tokens,
                    output_tokens,
                    error,
                ),
            )
            run_id = int(cursor.lastrowid)
            for seq, step in enumerate(steps):
                payload = step.get("payload")
                ok = step.get("ok")
                conn.execute(
                    "INSERT INTO agent_run_step "
                    "(run_id, seq, kind, name, detail, payload_json, ok, ms, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        run_id,
                        seq,
                        step["kind"],
                        step.get("name"),
                        step.get("detail"),
                        json.dumps(payload, ensure_ascii=False, default=str)
                        if payload is not None
                        else None,
                        None if ok is None else (1 if ok else 0),
                        step.get("ms"),
                        now_ms,
                    ),
                )
            conn.commit()
            return run_id
        finally:
            conn.close()
    except (sqlite3.Error, KeyError, TypeError) as exc:
        logger.warning(f"[run-log] ledger write failed agent={agent_id}: {exc}")
        return None


def list_run_logs(
    db_path: str, *, agent_id: str, limit: int = 20, offset: int = 0
) -> List[Dict[str, Any]]:
    """某成员最近 N 次执行 (started_at 倒序), 附 step_count 与 report_id。
    limit clamp [1,100]。表不存在 (老库没到 v73) → 空列表不抛。

    report_id: out 步骤 payload 里的 `$.report_id` (报告 worker 写入)。前端记录列
    靠它把「产物行 report:xxx」与「过程行 runlog:N」收敛成一条 —— 真实引用而不是
    时间窗启发式。同一条 SQL 里标量子查询抽出 (走 idx_agent_run_step, 无 N+1);
    非报告类的 run 没有这个 payload 键 → 自然 NULL。

    trig_internal_id: trig 步骤 payload 里的 `$.internal_id` (项目周报 runner 写入
    触发邮件的 internal_id)。同 report_id 的收敛用途 —— 周报 run 既有
    `project_progress_sync` 台账行又有 runlog 行, 记录列靠它去重。抽取手法同款
    标量子查询; 语义门 (只对 project_progress_sync 成员投影) 在 API 边界
    (`_run_log_item`), 这里只做结构抽取。
    """
    lim = max(1, min(100, limit))
    off = max(0, offset)
    try:
        conn = _connect(db_path)
        try:
            rows = conn.execute(
                "SELECT r.*, "
                "(SELECT COUNT(*) FROM agent_run_step s WHERE s.run_id = r.id) "
                "AS step_count, "
                "(SELECT json_extract(s.payload_json, '$.report_id') "
                "   FROM agent_run_step s "
                "  WHERE s.run_id = r.id AND s.kind = 'out' "
                "    AND json_valid(s.payload_json) "
                "    AND json_extract(s.payload_json, '$.report_id') IS NOT NULL "
                "  ORDER BY s.seq DESC LIMIT 1) AS report_id, "
                "(SELECT json_extract(s.payload_json, '$.internal_id') "
                "   FROM agent_run_step s "
                "  WHERE s.run_id = r.id AND s.kind = 'trig' "
                "    AND json_valid(s.payload_json) "
                "    AND json_extract(s.payload_json, '$.internal_id') IS NOT NULL "
                "  ORDER BY s.seq ASC LIMIT 1) AS trig_internal_id "
                "FROM agent_run_log r WHERE r.agent_id = ? "
                "ORDER BY r.started_at DESC, r.id DESC LIMIT ? OFFSET ?",
                (agent_id, lim, off),
            ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()
    except sqlite3.Error as exc:
        logger.debug(f"[run-log] ledger read skipped: {exc}")
        return []


def count_run_logs(db_path: str, *, agent_id: str) -> int:
    """``list_run_logs`` 同 filter 的 COUNT(*)（分页 total）。表不存在 → 0。"""
    try:
        conn = _connect(db_path)
        try:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM agent_run_log WHERE agent_id = ?",
                (agent_id,),
            ).fetchone()
            return int(row["n"]) if row else 0
        finally:
            conn.close()
    except sqlite3.Error as exc:
        logger.debug(f"[run-log] ledger count skipped: {exc}")
        return 0


def get_run_log(db_path: str, run_id: int) -> Optional[Dict[str, Any]]:
    """单行读 (steps 端点的存在性判据)。表不存在 / 无此行 → None。"""
    try:
        conn = _connect(db_path)
        try:
            row = conn.execute(
                "SELECT * FROM agent_run_log WHERE id = ?", (run_id,)
            ).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()
    except sqlite3.Error as exc:
        logger.debug(f"[run-log] ledger get skipped: {exc}")
        return None


def list_run_steps(db_path: str, run_id: int) -> List[Dict[str, Any]]:
    """一次执行的全部步骤 (seq 升序), payload_json 解析成对象 (坏 JSON → None)。"""
    try:
        conn = _connect(db_path)
        try:
            rows = conn.execute(
                "SELECT seq, kind, name, detail, payload_json, ok, ms "
                "FROM agent_run_step WHERE run_id = ? ORDER BY seq ASC",
                (run_id,),
            ).fetchall()
        finally:
            conn.close()
    except sqlite3.Error as exc:
        logger.debug(f"[run-log] steps read skipped: {exc}")
        return []
    out: List[Dict[str, Any]] = []
    for r in rows:
        payload: Optional[Dict[str, Any]] = None
        raw = r["payload_json"]
        if isinstance(raw, str) and raw:
            try:
                parsed = json.loads(raw)
                payload = parsed if isinstance(parsed, dict) else None
            except (json.JSONDecodeError, TypeError):
                payload = None
        out.append(
            {
                "seq": int(r["seq"]),
                "kind": r["kind"],
                "name": r["name"],
                "detail": r["detail"],
                "payload": payload,
                "ok": None if r["ok"] is None else bool(r["ok"]),
                "ms": r["ms"],
            }
        )
    return out
