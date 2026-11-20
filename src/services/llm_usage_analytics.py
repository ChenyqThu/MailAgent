"""Cross-database LLM Usage & Prompt Cache analytics service (Phase 4 WP-4D).

Aggregates LLM spend and token-weighted cache hit rate across MailAgent's three
SQLite databases without double-counting:
  1. ``ai_chat.db``:
     - ``ai_chat_messages`` (non-group assistant turns, split ``chat`` vs ``agent_run``)
     - ``ai_chat_group_turn`` (group speaker turns → ``group``)
     - ``ai_llm_usage_log`` (auxiliary gateway surfaces: auto_title, compact, search_agent, …)
  2. ``sync_store.db``:
     - ``llm_processing`` (``status = 'success'`` → ``email_classify``; uncached input convention)
     - ``report`` (``status = 'ready'`` → ``report``; uncached input convention)
     - ``matter_run`` (``chat_session_id IS NULL`` only → ``matter_run``, avoiding double count
       with headless sessions already persisted in ``ai_chat_messages``)
  3. ``agent_config.db``:
     - ``py_llm_usage_log`` (direct Python fallback auxiliary calls)
     - ``llm_probe_log`` (latest 50 connectivity/runtime diagnostic logs)
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from src.agent_config.llm_providers import parse_provider_ref
from src.agent_config.store import resolve_agent_config_db_path
from src.chat.db import resolve_ai_chat_db_path
from src.config import config
from src.llm_agent.model_cost import estimate_cache_saved_usd, estimate_cost_usd

VALID_USAGE_RANGES = ("24h", "7d", "30d")


def _non_neg(v: Any) -> int:
    if isinstance(v, bool):
        return 0
    if isinstance(v, (int, float)) and v > 0:
        return int(v)
    return 0


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    try:
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    except sqlite3.Error:
        return set()
    return {str(r[1]) for r in rows}


def _hit_rate_pct(uncached_in: int, cache_read: int, cache_write: int) -> float:
    denom = uncached_in + cache_read + cache_write
    if denom <= 0:
        return 0.0
    return round(100.0 * cache_read / denom, 1)


def _split_model_ref(raw_model: Optional[str], explicit_provider: Optional[str] = None) -> Tuple[str, Optional[str]]:
    if not raw_model or not raw_model.strip():
        return "(unknown)", explicit_provider
    s = raw_model.strip()
    if explicit_provider:
        pid, mid = parse_provider_ref(s) if ":" in s else (explicit_provider, s)
        return mid, pid
    if ":" in s:
        pid, mid = parse_provider_ref(s)
        if not s.lower().endswith((":free", ":extended", ":thinking", ":beta", ":exacto")):
            return mid or s, pid
    return s, None


def _build_buckets(range_key: str, now_sec: float) -> Tuple[List[Dict[str, Any]], datetime, bool]:
    now_dt = datetime.fromtimestamp(now_sec)
    if range_key == "24h":
        end_hour = now_dt.replace(minute=0, second=0, microsecond=0)
        start_dt = end_hour - timedelta(hours=23)
        buckets = []
        for i in range(24):
            dt = start_dt + timedelta(hours=i)
            buckets.append(
                {
                    "bucket": dt.isoformat(timespec="hours"),
                    "label": dt.strftime("%H:00"),
                    "calls": 0,
                    "inputTokens": 0,
                    "uncachedInputTokens": 0,
                    "outputTokens": 0,
                    "cacheReadTokens": 0,
                    "cacheWriteTokens": 0,
                    "tokenCacheHitRatePct": 0.0,
                    "costUsd": 0.0,
                    "cacheSavedUsd": 0.0,
                }
            )
        return buckets, start_dt, True

    days = 7 if range_key == "7d" else 30
    end_day = now_dt.replace(hour=0, minute=0, second=0, microsecond=0)
    start_dt = end_day - timedelta(days=days - 1)
    buckets = []
    for i in range(days):
        dt = start_dt + timedelta(days=i)
        buckets.append(
            {
                "bucket": dt.strftime("%Y-%m-%d"),
                "label": dt.strftime("%m-%d"),
                "calls": 0,
                "inputTokens": 0,
                "uncachedInputTokens": 0,
                "outputTokens": 0,
                "cacheReadTokens": 0,
                "cacheWriteTokens": 0,
                "tokenCacheHitRatePct": 0.0,
                "costUsd": 0.0,
                "cacheSavedUsd": 0.0,
            }
        )
    return buckets, start_dt, False


def _connect_readonly(path: Optional[str]) -> Optional[sqlite3.Connection]:
    if not path or not os.path.isfile(path):
        return None
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn
    except sqlite3.Error:
        try:
            conn = sqlite3.connect(path, timeout=10)
            conn.row_factory = sqlite3.Row
            return conn
        except sqlite3.Error:
            return None


def collect_llm_usage_analytics(
    *,
    range_key: str = "7d",
    chat_db_path: Optional[str] = None,
    sync_db_path: Optional[str] = None,
    agent_config_db_path: Optional[str] = None,
    now_sec: Optional[float] = None,
) -> Dict[str, Any]:
    if range_key not in VALID_USAGE_RANGES:
        raise ValueError(f"range must be one of {VALID_USAGE_RANGES}")

    now_val = float(now_sec if now_sec is not None else time.time())
    buckets, start_dt, is_hourly = _build_buckets(range_key, now_val)
    since_sec = start_dt.timestamp()
    since_ms = int(since_sec * 1000)
    n_buckets = len(buckets)

    surface_acc: Dict[str, Dict[str, Any]] = {}
    model_acc: Dict[Tuple[str, Optional[str]], Dict[str, Any]] = {}
    summary: Dict[str, Any] = {
        "totalCalls": 0,
        "totalInputTokens": 0,
        "uncachedInputTokens": 0,
        "outputTokens": 0,
        "cacheReadTokens": 0,
        "cacheWriteTokens": 0,
        "tokenCacheHitRatePct": 0.0,
        "estimatedCostUsd": 0.0,
        "cacheSavedUsd": 0.0,
    }

    def _bucket_index(ts_ms: int) -> int:
        if is_hourly:
            idx = int((ts_ms / 1000.0 - since_sec) // 3600)
        else:
            dt = datetime.fromtimestamp(ts_ms / 1000.0).replace(
                hour=0, minute=0, second=0, microsecond=0
            )
            idx = (dt - start_dt).days
        if idx < 0:
            return 0
        if idx >= n_buckets:
            return n_buckets - 1
        return idx

    def _record_event(
        *,
        ts_ms: int,
        surface: str,
        raw_model: Optional[str],
        provider_id: Optional[str] = None,
        protocol: Optional[str] = None,
        raw_input: int,
        output_tok: int,
        cache_read: int,
        cache_write: int,
        input_is_uncached_only: bool,
        explicit_no_cache: Optional[int] = None,
        explicit_cost_usd: Optional[float] = None,
    ) -> None:
        if ts_ms < since_ms:
            return
        if explicit_no_cache is not None and explicit_no_cache >= 0:
            uncached_in = explicit_no_cache
        elif input_is_uncached_only:
            uncached_in = raw_input
        else:
            uncached_in = max(0, raw_input - cache_read - cache_write)
        total_in = uncached_in + cache_read + cache_write

        model_name, parsed_pid = _split_model_ref(raw_model, provider_id)
        if explicit_cost_usd is not None and explicit_cost_usd >= 0:
            cost = float(explicit_cost_usd)
        else:
            est = estimate_cost_usd(
                model_name,
                input_tokens=uncached_in,
                output_tokens=output_tok,
                cache_read_tokens=cache_read,
                cache_write_tokens=cache_write,
                protocol=protocol,
                input_is_uncached_only=True,
            )
            cost = float(est or 0.0)
        saved = float(
            estimate_cache_saved_usd(
                model_name, cache_read_tokens=cache_read, protocol=protocol
            )
            or 0.0
        )

        summary["totalCalls"] += 1
        summary["totalInputTokens"] += total_in
        summary["uncachedInputTokens"] += uncached_in
        summary["outputTokens"] += output_tok
        summary["cacheReadTokens"] += cache_read
        summary["cacheWriteTokens"] += cache_write
        summary["estimatedCostUsd"] += cost
        summary["cacheSavedUsd"] += saved

        b = buckets[_bucket_index(ts_ms)]
        b["calls"] += 1
        b["inputTokens"] += total_in
        b["uncachedInputTokens"] += uncached_in
        b["outputTokens"] += output_tok
        b["cacheReadTokens"] += cache_read
        b["cacheWriteTokens"] += cache_write
        b["costUsd"] += cost
        b["cacheSavedUsd"] += saved

        s_entry = surface_acc.setdefault(
            surface,
            {
                "surface": surface,
                "calls": 0,
                "inputTokens": 0,
                "uncachedInputTokens": 0,
                "outputTokens": 0,
                "cacheReadTokens": 0,
                "cacheWriteTokens": 0,
                "tokenCacheHitRatePct": 0.0,
                "costUsd": 0.0,
                "cacheSavedUsd": 0.0,
            },
        )
        s_entry["calls"] += 1
        s_entry["inputTokens"] += total_in
        s_entry["uncachedInputTokens"] += uncached_in
        s_entry["outputTokens"] += output_tok
        s_entry["cacheReadTokens"] += cache_read
        s_entry["cacheWriteTokens"] += cache_write
        s_entry["costUsd"] += cost
        s_entry["cacheSavedUsd"] += saved

        m_key = (model_name, parsed_pid)
        m_entry = model_acc.setdefault(
            m_key,
            {
                "model": model_name,
                "providerId": parsed_pid,
                "calls": 0,
                "inputTokens": 0,
                "uncachedInputTokens": 0,
                "outputTokens": 0,
                "cacheReadTokens": 0,
                "cacheWriteTokens": 0,
                "tokenCacheHitRatePct": 0.0,
                "costUsd": 0.0,
                "cacheSavedUsd": 0.0,
            },
        )
        m_entry["calls"] += 1
        m_entry["inputTokens"] += total_in
        m_entry["uncachedInputTokens"] += uncached_in
        m_entry["outputTokens"] += output_tok
        m_entry["cacheReadTokens"] += cache_read
        m_entry["cacheWriteTokens"] += cache_write
        m_entry["costUsd"] += cost
        m_entry["cacheSavedUsd"] += saved

    # ── 1. ai_chat.db ──────────────────────────────────────────────────────────
    chat_conn = _connect_readonly(chat_db_path or resolve_ai_chat_db_path())
    if chat_conn is not None:
        try:
            msg_cols = _table_columns(chat_conn, "ai_chat_messages")
            sess_cols = _table_columns(chat_conn, "ai_chat_sessions")
            if msg_cols:
                cr_expr = "COALESCE(m.cache_read_tokens, 0)" if "cache_read_tokens" in msg_cols else "0"
                cw_expr = "COALESCE(m.cache_write_tokens, 0)" if "cache_write_tokens" in msg_cols else "0"
                origin_expr = "s.origin" if "origin" in sess_cols else "NULL"
                join_sess = "LEFT JOIN ai_chat_sessions s ON s.id = m.session_id" if sess_cols else ""
                speaker_filter = "AND m.speaker_agent_id IS NULL" if "speaker_agent_id" in msg_cols else ""
                group_filter = "AND COALESCE(s.origin, '') <> 'group'" if "origin" in sess_cols else ""
                rows = chat_conn.execute(
                    f"""
                    SELECT m.model, m.tokens_input, m.tokens_output,
                           {cr_expr} AS cache_read_tokens,
                           {cw_expr} AS cache_write_tokens,
                           m.cost_usd, m.created_at,
                           {origin_expr} AS origin
                      FROM ai_chat_messages m
                      {join_sess}
                     WHERE m.role = 'assistant'
                       AND m.status = 'complete'
                       AND m.created_at >= ?
                       {speaker_filter}
                       {group_filter}
                       AND (
                         COALESCE(m.tokens_input, 0) > 0
                         OR COALESCE(m.tokens_output, 0) > 0
                         OR {cr_expr} > 0
                         OR {cw_expr} > 0
                       )
                    """,
                    (since_ms,),
                ).fetchall()
                for r in rows:
                    surf = "agent_run" if r["origin"] == "agent" else "chat"
                    _record_event(
                        ts_ms=int(r["created_at"] or 0),
                        surface=surf,
                        raw_model=r["model"],
                        raw_input=_non_neg(r["tokens_input"]),
                        output_tok=_non_neg(r["tokens_output"]),
                        cache_read=_non_neg(r["cache_read_tokens"]),
                        cache_write=_non_neg(r["cache_write_tokens"]),
                        input_is_uncached_only=False,
                        explicit_cost_usd=(
                            float(r["cost_usd"]) if r["cost_usd"] is not None else None
                        ),
                    )

            grp_cols = _table_columns(chat_conn, "ai_chat_group_turn")
            if grp_cols:
                cr_expr = "COALESCE(cache_read_tokens, 0)" if "cache_read_tokens" in grp_cols else "0"
                cw_expr = "COALESCE(cache_write_tokens, 0)" if "cache_write_tokens" in grp_cols else "0"
                rows = chat_conn.execute(
                    f"""
                    SELECT model, tokens_input, tokens_output,
                           {cr_expr} AS cache_read_tokens,
                           {cw_expr} AS cache_write_tokens,
                           cost_usd, started_at
                      FROM ai_chat_group_turn
                     WHERE started_at >= ?
                       AND (
                         COALESCE(tokens_input, 0) > 0
                         OR COALESCE(tokens_output, 0) > 0
                         OR {cr_expr} > 0
                         OR {cw_expr} > 0
                       )
                    """,
                    (since_ms,),
                ).fetchall()
                for r in rows:
                    _record_event(
                        ts_ms=int(r["started_at"] or 0),
                        surface="group",
                        raw_model=r["model"],
                        raw_input=_non_neg(r["tokens_input"]),
                        output_tok=_non_neg(r["tokens_output"]),
                        cache_read=_non_neg(r["cache_read_tokens"]),
                        cache_write=_non_neg(r["cache_write_tokens"]),
                        input_is_uncached_only=False,
                        explicit_cost_usd=(
                            float(r["cost_usd"]) if r["cost_usd"] is not None else None
                        ),
                    )

            aux_cols = _table_columns(chat_conn, "ai_llm_usage_log")
            if aux_cols:
                rows = chat_conn.execute(
                    """
                    SELECT surface, provider_id, model, protocol,
                           tokens_input, tokens_output,
                           cache_read_tokens, cache_write_tokens,
                           cost_usd, created_at
                      FROM ai_llm_usage_log
                     WHERE status = 'ok' AND created_at >= ?
                    """,
                    (since_ms,),
                ).fetchall()
                for r in rows:
                    _record_event(
                        ts_ms=int(r["created_at"] or 0),
                        surface=str(r["surface"] or "py_loopback"),
                        raw_model=r["model"],
                        provider_id=r["provider_id"],
                        protocol=r["protocol"],
                        raw_input=_non_neg(r["tokens_input"]),
                        output_tok=_non_neg(r["tokens_output"]),
                        cache_read=_non_neg(r["cache_read_tokens"]),
                        cache_write=_non_neg(r["cache_write_tokens"]),
                        input_is_uncached_only=False,
                        explicit_cost_usd=(
                            float(r["cost_usd"]) if r["cost_usd"] is not None else None
                        ),
                    )
        finally:
            chat_conn.close()

    # ── 2. sync_store.db ───────────────────────────────────────────────────────
    sync_conn = _connect_readonly(sync_db_path or config.sync_store_db_path)
    if sync_conn is not None:
        try:
            proc_cols = _table_columns(sync_conn, "llm_processing")
            if proc_cols:
                rows = sync_conn.execute(
                    """
                    SELECT model, input_tokens, output_tokens,
                           cache_read_input_tokens, cache_creation_input_tokens, updated_at
                      FROM llm_processing
                     WHERE status = 'success' AND updated_at >= ?
                    """,
                    (since_sec,),
                ).fetchall()
                for r in rows:
                    _record_event(
                        ts_ms=int(float(r["updated_at"] or 0) * 1000),
                        surface="email_classify",
                        raw_model=r["model"],
                        raw_input=_non_neg(r["input_tokens"]),
                        output_tok=_non_neg(r["output_tokens"]),
                        cache_read=_non_neg(r["cache_read_input_tokens"]),
                        cache_write=_non_neg(r["cache_creation_input_tokens"]),
                        input_is_uncached_only=True,
                    )

            rep_cols = _table_columns(sync_conn, "report")
            if rep_cols:
                rows = sync_conn.execute(
                    """
                    SELECT model, input_tokens, output_tokens, cost_usd, generated_at
                      FROM report
                     WHERE status = 'ready' AND generated_at >= ?
                       AND (COALESCE(input_tokens, 0) > 0 OR COALESCE(output_tokens, 0) > 0)
                    """,
                    (since_sec,),
                ).fetchall()
                for r in rows:
                    c_val = r["cost_usd"]
                    explicit_c = float(c_val) if (c_val is not None and float(c_val) > 0) else None
                    _record_event(
                        ts_ms=int(float(r["generated_at"] or 0) * 1000),
                        surface="report",
                        raw_model=r["model"],
                        raw_input=_non_neg(r["input_tokens"]),
                        output_tok=_non_neg(r["output_tokens"]),
                        cache_read=0,
                        cache_write=0,
                        input_is_uncached_only=True,
                        explicit_cost_usd=explicit_c,
                    )

            mr_cols = _table_columns(sync_conn, "matter_run")
            if mr_cols:
                rows = sync_conn.execute(
                    """
                    SELECT model, usage_json, cost_usd,
                           COALESCE(completed_at, created_at) AS ts_ms
                      FROM matter_run
                     WHERE chat_session_id IS NULL
                       AND COALESCE(completed_at, created_at) >= ?
                       AND (usage_json IS NOT NULL OR cost_usd IS NOT NULL)
                    """,
                    (since_ms,),
                ).fetchall()
                for r in rows:
                    u_obj: Dict[str, Any] = {}
                    if r["usage_json"]:
                        try:
                            parsed = json.loads(r["usage_json"])
                            if isinstance(parsed, dict):
                                u_obj = (
                                    parsed.get("usage")
                                    if isinstance(parsed.get("usage"), dict)
                                    else parsed
                                )
                        except (ValueError, TypeError):
                            u_obj = {}
                    raw_in = _non_neg(u_obj.get("inputTokens") or u_obj.get("input_tokens"))
                    out_tok = _non_neg(u_obj.get("outputTokens") or u_obj.get("output_tokens"))
                    c_read = _non_neg(u_obj.get("cacheReadTokens") or u_obj.get("cache_read_tokens"))
                    c_write = _non_neg(u_obj.get("cacheWriteTokens") or u_obj.get("cache_write_tokens"))
                    no_cache = u_obj.get("noCacheTokens")
                    explicit_no_cache = _non_neg(no_cache) if no_cache is not None else None
                    c_val = r["cost_usd"]
                    _record_event(
                        ts_ms=int(r["ts_ms"] or 0),
                        surface="matter_run",
                        raw_model=r["model"],
                        raw_input=raw_in,
                        output_tok=out_tok,
                        cache_read=c_read,
                        cache_write=c_write,
                        input_is_uncached_only=False,
                        explicit_no_cache=explicit_no_cache,
                        explicit_cost_usd=float(c_val) if c_val is not None else None,
                    )
        finally:
            sync_conn.close()

    # ── 3. agent_config.db ─────────────────────────────────────────────────────
    probe_logs: List[Dict[str, Any]] = []
    cfg_conn = _connect_readonly(agent_config_db_path or resolve_agent_config_db_path())
    if cfg_conn is not None:
        try:
            py_cols = _table_columns(cfg_conn, "py_llm_usage_log")
            if py_cols:
                rows = cfg_conn.execute(
                    """
                    SELECT surface, model, protocol, input_tokens, output_tokens,
                           cache_read_tokens, cache_write_tokens, cost_usd, created_at
                      FROM py_llm_usage_log
                     WHERE status = 'ok' AND created_at >= ?
                    """,
                    (since_ms,),
                ).fetchall()
                for r in rows:
                    _record_event(
                        ts_ms=int(r["created_at"] or 0),
                        surface=str(r["surface"] or "py_loopback"),
                        raw_model=r["model"],
                        protocol=r["protocol"],
                        raw_input=_non_neg(r["input_tokens"]),
                        output_tok=_non_neg(r["output_tokens"]),
                        cache_read=_non_neg(r["cache_read_tokens"]),
                        cache_write=_non_neg(r["cache_write_tokens"]),
                        input_is_uncached_only=True,
                        explicit_cost_usd=(
                            float(r["cost_usd"]) if r["cost_usd"] is not None else None
                        ),
                    )

            probe_cols = _table_columns(cfg_conn, "llm_probe_log")
            if probe_cols:
                p_rows = cfg_conn.execute(
                    """
                    SELECT id, provider_id, protocol, model, kind, ok,
                           status_code, error_code, latency_ms, message, created_at
                      FROM llm_probe_log
                     ORDER BY id DESC
                     LIMIT 50
                    """
                ).fetchall()
                probe_logs = [
                    {
                        "id": int(r["id"]),
                        "providerId": r["provider_id"],
                        "protocol": r["protocol"],
                        "model": r["model"],
                        "kind": r["kind"],
                        "ok": bool(r["ok"]),
                        "statusCode": r["status_code"],
                        "errorCode": r["error_code"],
                        "latencyMs": r["latency_ms"],
                        "message": r["message"],
                        "createdAt": int(r["created_at"]),
                    }
                    for r in p_rows
                ]
        finally:
            cfg_conn.close()

    # ── Finalize hit rates & round floats ──────────────────────────────────────
    summary["tokenCacheHitRatePct"] = _hit_rate_pct(
        summary["uncachedInputTokens"], summary["cacheReadTokens"], summary["cacheWriteTokens"]
    )
    summary["estimatedCostUsd"] = round(summary["estimatedCostUsd"], 6)
    summary["cacheSavedUsd"] = round(summary["cacheSavedUsd"], 6)

    for b in buckets:
        b["tokenCacheHitRatePct"] = _hit_rate_pct(
            b["uncachedInputTokens"], b["cacheReadTokens"], b["cacheWriteTokens"]
        )
        b["costUsd"] = round(b["costUsd"], 6)
        b["cacheSavedUsd"] = round(b["cacheSavedUsd"], 6)

    by_surface = sorted(
        surface_acc.values(),
        key=lambda x: (-x["costUsd"], -(x["inputTokens"] + x["outputTokens"])),
    )
    for item in by_surface:
        item["tokenCacheHitRatePct"] = _hit_rate_pct(
            item["uncachedInputTokens"], item["cacheReadTokens"], item["cacheWriteTokens"]
        )
        item["costUsd"] = round(item["costUsd"], 6)
        item["cacheSavedUsd"] = round(item["cacheSavedUsd"], 6)

    by_model = sorted(
        model_acc.values(),
        key=lambda x: (-x["costUsd"], -(x["inputTokens"] + x["outputTokens"])),
    )
    for item in by_model:
        item["tokenCacheHitRatePct"] = _hit_rate_pct(
            item["uncachedInputTokens"], item["cacheReadTokens"], item["cacheWriteTokens"]
        )
        item["costUsd"] = round(item["costUsd"], 6)
        item["cacheSavedUsd"] = round(item["cacheSavedUsd"], 6)

    return {
        "range": range_key,
        "summary": summary,
        "series": buckets,
        "bySurface": by_surface,
        "byModel": by_model,
        "probeLogs": probe_logs,
    }
