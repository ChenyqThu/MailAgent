"""llm 路由 — /api/llm/*。

run (写, subprocess) / stats (读, 直查 llm_processing)。
契约: llm-run.schema.json + llm-stats.schema.json + frontend llm.{run,stats}。

读端点 (stats) 经 ``Depends(get_repository)`` 拿 EmailRepository, 复用其 _connect()
直查 llm_processing 表 (镜像 src/cli/commands/llm.py llm_stats 的 SQL), meta.source='sqlite'。
写端点 (run) 经 cli_runner.run_cli 调 ``mailagent llm run {id}``, meta.source='cli'。

统一响应走 app.success_envelope / app.APIError (与 email/attachment router 一致;
app.py 已把 router import 下沉到 helper 定义之后, 无循环导入)。
"""

from __future__ import annotations

import json
import time
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Depends, Request

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.cli_runner import CliRunnerError, get_cli_api_key, run_cli
from src.api.deps import get_repository

if TYPE_CHECKING:
    from src.repository import EmailRepository

router = APIRouter(prefix="/api/llm", tags=["llm"])


def _zero_cost() -> dict:
    """空 cost rollup (镜像 CLI llm.py _zero_cost)。"""
    return {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
        "cache_hit_rate_pct": 0.0,
        "avg_latency_ms": 0,
        "success_rows": 0,
    }


def _raise_from_cli_error(exc: CliRunnerError) -> None:
    """CliRunnerError → APIError (全局 handler 据 code 映 HTTP)。

    优先用 CLI 自报的 ``error.code`` (exc.code); http_status 缺省由
    ERROR_CODE_TO_HTTP[code] 推导。exc.stdout/stderr 不回显客户端 (仅 runner 留底)。
    """
    raise APIError(exc.code, exc.message, hint=exc.hint, source="cli") from exc


# ============================================================
# GET /api/llm/stats?days=7  (读, 直查 llm_processing)
# ============================================================
@router.get("/stats")
async def llm_stats(
    request: Request,
    days: int = 7,
    _: None = Depends(verify_cf_access),
    repo: "EmailRepository" = Depends(get_repository),
):
    """``llm_processing`` 表统计 (status 分布 + cost + cache hit + latency)。

    镜像 ``mailagent llm stats`` 的查询: by_status / total / cost rollup。
    days>0 → 仅统计过去 N 天 (updated_at >= now-N*86400); days=-1 → 全量;
    days=0 → E_INVALID_ARG (与 CLI 一致, 用 -1 表全量)。

    返回 data = {total, by_status, days, since_ts, cost{...}} (LlmStatsData / llm-stats.schema.json)。
    """
    if days == 0:
        raise APIError(
            "E_INVALID_ARG",
            "days 0 invalid; use -1 (all) or >=1",
            hint="days=-1 for all-time, or days>=1 for a window",
            source="sqlite",
        )

    since_ts: Optional[float] = None
    if days > 0:
        since_ts = time.time() - days * 86400

    conn = repo._connect()
    try:
        # llm_processing 表可能不存在 (空 DB / 全新 install) — 防御性检
        table_exists = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='llm_processing'"
        ).fetchone() is not None

        if not table_exists:
            data = {
                "total": 0,
                "by_status": {},
                "days": days,
                "since_ts": since_ts,
                "cost": _zero_cost(),
                "_source": "table_missing",
            }
            return success_envelope(data, request=request, source="sqlite")

        where = "WHERE updated_at >= ?" if since_ts is not None else ""
        params: list = [since_ts] if since_ts is not None else []

        by_status_rows = conn.execute(
            f"SELECT status, COUNT(*) AS n FROM llm_processing {where} GROUP BY status",
            params,
        ).fetchall()
        by_status = {r["status"] or "(null)": int(r["n"]) for r in by_status_rows}
        total = sum(by_status.values())

        cost_row = conn.execute(
            f"""SELECT
                    COALESCE(SUM(input_tokens), 0)                 AS in_tok,
                    COALESCE(SUM(output_tokens), 0)                AS out_tok,
                    COALESCE(SUM(cache_creation_input_tokens), 0)  AS cache_write,
                    COALESCE(SUM(cache_read_input_tokens), 0)      AS cache_read,
                    COALESCE(AVG(latency_ms), 0)                   AS avg_ms,
                    COALESCE(SUM(CASE WHEN cache_read_input_tokens > 0
                                      THEN 1 ELSE 0 END), 0)        AS hit_count,
                    COUNT(*) AS rows_n
                FROM llm_processing
                {where} {'AND' if where else 'WHERE'} status='success'""",
            params,
        ).fetchone()

        rows_n = int(cost_row["rows_n"]) if cost_row else 0
        hit_count = int(cost_row["hit_count"]) if cost_row else 0
        cache_hit_rate_pct = round(100.0 * hit_count / rows_n, 1) if rows_n > 0 else 0.0
        cost = {
            "input_tokens": int(cost_row["in_tok"] or 0),
            "output_tokens": int(cost_row["out_tok"] or 0),
            "cache_creation_input_tokens": int(cost_row["cache_write"] or 0),
            "cache_read_input_tokens": int(cost_row["cache_read"] or 0),
            "cache_hit_rate_pct": cache_hit_rate_pct,
            "avg_latency_ms": int(cost_row["avg_ms"] or 0),
            "success_rows": rows_n,
        }
    finally:
        conn.close()

    data = {
        "total": total,
        "by_status": by_status,
        "days": days,
        "since_ts": since_ts,
        "cost": cost,
        "_source": "live_query",
    }
    return success_envelope(data, request=request, source="sqlite")


# ============================================================
# POST /api/llm/run/{internal_id}  (写, subprocess)
# ============================================================
@router.post("/run/{internal_id}")
async def llm_run(
    internal_id: int,
    request: Request,
    dry_run: bool = False,
    force: bool = False,
    no_overwrite: bool = False,
    _: None = Depends(verify_cf_access),
):
    """对单封邮件跑 LLM 分类 → 填 Notion AI 字段。

    LlmRunOpts: dryRun→--dry-run, force→--force, noOverwrite→--no-overwrite。
    经 ``mailagent llm run {id}`` subprocess (写命令, 注入 --api-key; dry-run 跳过 auth
    但 cli_runner 仍注入 key 无害)。data 透传 CLI 的 llm-run.schema.json 形状
    {internal_id, page_id, mailbox, dry_run, skipped, labels, writer_summary, stored_at}。

    E_LLM_FAILED → 500, E_NOT_FOUND → 404 (CLI 自报 code, 经 ERROR_CODE_TO_HTTP 映射)。
    """
    args = ["llm", "run", str(internal_id)]
    if dry_run:
        args.append("--dry-run")
    if force:
        args.append("--force")
    if no_overwrite:
        args.append("--no-overwrite")

    try:
        result = await run_cli(args, api_key=get_cli_api_key())
    except CliRunnerError as exc:
        _raise_from_cli_error(exc)

    return success_envelope(result.data, request=request, source="cli")


# ============================================================
# GET /api/llm/selftest  (读, subprocess — 不烧 token)
# ============================================================
@router.get("/selftest")
async def llm_selftest(
    request: Request,
    _: None = Depends(verify_cf_access),
):
    """LLM gateway 健康检查 (镜像 ``mailagent llm selftest``)。

    仅检 cfg (LLM_API_KEY/BASE/MODEL 非空 + fallback chain), **不烧 token, 不写 Notion**。
    read 端点 → 不注入 api_key (selftest 是无 auth 读命令)。

    data 透传 CLI 的 llm-selftest.schema.json 形状
    {healthy, api_base, primary_model, fallback_chain, llm_agent_enabled, reasons}
    (LlmSelfTestData; 前端只读其中 {healthy, detail?, latency_ms?} 子集)。

    **gotcha**: CLI 在 unhealthy 时 ``emit(data)`` 后 ``raise typer.Exit(1)`` —— 即
    stdout 携带 *合法* success wrapper, 但进程 exit 1。run_cli 据 exit≠0 抛
    CliRunnerError, 把 wrapper 留在 ``exc.stdout``。healthy:false 是合法诊断结果
    (与 ``admin health`` 返回 200 + healthy:false 同理), **不是** error —— 故捕获
    exit-1 后从 stdout 还原 data 照常 200 返回。任何 *无法* 还原出 wrapper 的失败
    (真崩 / 缺 bin / 超时) 才走 error 路径。
    """
    try:
        result = await run_cli(["llm", "selftest"])
        return success_envelope(result.data, request=request, source="cli")
    except CliRunnerError as exc:
        recovered = _recover_selftest_data(exc)
        if recovered is not None:
            return success_envelope(recovered, request=request, source="cli")
        _raise_from_cli_error(exc)


def _recover_selftest_data(exc: CliRunnerError) -> Optional[dict]:
    """从 ``llm selftest`` exit-1 的 stdout 还原 success wrapper 的 data。

    CLI unhealthy 路径: ``emit(cli, data)`` (success wrapper → stdout) 后
    ``raise typer.Exit(1)``。该 wrapper status=='success' 且含 ``healthy`` 字段 →
    还原其 ``data`` 当正常诊断结果返回。非该形状 (真错误 wrapper / 空 stdout) → None
    (让 caller 走 error)。
    """
    for buf in (exc.stdout, exc.stderr):
        if not buf or not buf.strip():
            continue
        try:
            wrapper = json.loads(buf.strip())
        except (json.JSONDecodeError, ValueError):
            continue
        if (
            isinstance(wrapper, dict)
            and wrapper.get("status") == "success"
            and isinstance(wrapper.get("data"), dict)
            and "healthy" in wrapper["data"]
        ):
            return wrapper["data"]
    return None
