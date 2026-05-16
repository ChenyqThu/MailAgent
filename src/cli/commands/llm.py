"""mailagent llm — LLM 跑分 / 自检 / 重试 / 统计 / 路径对比 (RFC v2 §4.4).

PR-3 US-003: run / selftest / retry-failed.
PR-3 US-004: stats / compare-paths.
"""

from __future__ import annotations

import asyncio
import sqlite3
import time
from typing import TYPE_CHECKING, Optional

import typer

from src.cli.exceptions import (
    CliError,
    CliInvalidArgError,
    CliLLMFailedError,
    CliNotFoundError,
    CliNotImplementedError,
)
from src.cli.output import apply_local_output as _apply_local_output, emit, emit_cli_error

if TYPE_CHECKING:
    from src.cli.context import CliContext

app = typer.Typer(
    name="llm",
    help="LLM 分类 run / selftest / retry-failed / stats / compare-paths (RFC §4.4)",
    no_args_is_help=True,
)


# ============================================================
# run (US-003)
# ============================================================

@app.command("run")
def llm_run(
    ctx: typer.Context,
    internal_id: int = typer.Argument(..., help="邮件 internal_id"),
    dry_run: bool = typer.Option(False, "--dry-run", help="不写 Notion, 仅烧 LLM"),
    force: bool = typer.Option(False, "--force", help="即使 success 也重跑"),
    no_overwrite: bool = typer.Option(
        False, "--no-overwrite",
        help="保留 Notion 中已手改的非空字段 (与 LLM 输出取并集)",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """对单封邮件跑 LLM 分类 → 填 Notion AI 字段 (对应 scripts/run_llm_on_email.py)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if not dry_run:
        try:
            cli.require_auth()
        except CliError as e:
            raise emit_cli_error(cli, e)

    from src.llm_agent.runner import LLMRunner

    cfg = cli.cli_config
    runner = LLMRunner(
        db_path=cfg.sync_store_db_path,
        attachment_storage_dir=cfg.attachment_storage_dir,
    )
    try:
        result = asyncio.run(runner.run_for_internal_id(
            internal_id,
            dry_run=dry_run,
            overwrite=not no_overwrite,
            force=force,
        ))
    except Exception as e:  # pragma: no cover - 兜底网关意外异常
        raise emit_cli_error(cli, CliLLMFailedError(
            f"LLMRunner unexpected error: {e!r}",
            hint="网关/依赖故障; 看 pm2 logs 或检查 LLM_API_KEY / LLM_API_BASE",
        ))
    finally:
        # runner.close() 是 async, 但 LLMRunner.close 内部 try/except, 不重试
        try:
            asyncio.run(runner.close())
        except Exception:
            pass

    if not result.get("ok"):
        err = result.get("error") or "unknown LLM error"
        if "not found" in err.lower() or "notion_page_id empty" in err.lower():
            raise emit_cli_error(cli, CliNotFoundError(
                err,
                hint="确认 internal_id 已 sync 到 Notion (notion_page_id != null)",
            ))
        raise emit_cli_error(cli, CliLLMFailedError(
            err,
            hint=f"retry_count={result.get('retry_count')} status={result.get('status')}",
        ))

    data = {
        "internal_id": result.get("internal_id"),
        "page_id": result.get("page_id"),
        "mailbox": result.get("mailbox"),
        "dry_run": result.get("dry_run", dry_run),
        "skipped": result.get("skipped"),
        "labels": result.get("labels"),
        "writer_summary": result.get("writer_summary"),
        "stored_at": result.get("stored_at"),
    }

    if cli.output.lower() == "text":
        print(f"internal_id   {data['internal_id']}")
        print(f"page_id       {data['page_id']}")
        if data.get("skipped"):
            print(f"skipped       {data['skipped']}")
        if data.get("labels"):
            print(f"labels        {data['labels']}")
        if data.get("dry_run"):
            print("dry_run       True (Notion 未写)")
    else:
        emit(cli, data)


# ============================================================
# selftest (US-003)
# ============================================================

@app.command("selftest")
def llm_selftest(
    ctx: typer.Context,
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """LLM gateway 健康检查 (不烧 token, 不写 Notion, 仅检 cfg)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    cfg = cli.cli_config
    reasons: list[str] = []
    healthy = True
    if not cfg.llm_api_key:
        reasons.append("LLM_API_KEY is empty")
        healthy = False
    if not cfg.llm_api_base:
        reasons.append("LLM_API_BASE is empty")
        healthy = False
    if not cfg.llm_model:
        reasons.append("LLM_MODEL is empty")
        healthy = False

    fallback = [m.strip() for m in (cfg.llm_fallback_models or "").split(",") if m.strip()]

    data = {
        "healthy": healthy,
        "api_base": cfg.llm_api_base,
        "primary_model": cfg.llm_model,
        "fallback_chain": fallback,
        "llm_agent_enabled": cfg.llm_agent_enabled,
        "reasons": reasons,
    }

    if cli.output.lower() == "text":
        print(f"healthy        {healthy}")
        print(f"api_base       {data['api_base']}")
        print(f"primary_model  {data['primary_model']}")
        print(f"fallback       {','.join(fallback) if fallback else '(none)'}")
        if reasons:
            print(f"reasons        {'; '.join(reasons)}")
    else:
        emit(cli, data)
    if not healthy:
        raise typer.Exit(code=1)


# ============================================================
# retry-failed (US-003)
# ============================================================

@app.command("retry-failed")
def llm_retry_failed(
    ctx: typer.Context,
    limit: int = typer.Option(10, "--limit", help="一次最多重跑 N 封"),
    dry_run: bool = typer.Option(False, "--dry-run", help="仅列出候选, 不实跑"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """跑 LLM retry queue (llm_processing.status='failed' 且 next_retry_at<=now)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if limit <= 0:
        raise emit_cli_error(cli, CliInvalidArgError(
            f"--limit must be > 0, got {limit}",
        ))

    if not dry_run:
        try:
            cli.require_auth()
        except CliError as e:
            raise emit_cli_error(cli, e)

    from src.llm_agent.runner import LLMRunner
    from src.llm_agent.store import LLMProcessingStore

    store = LLMProcessingStore(db_path=cli.cli_config.sync_store_db_path)
    candidates = store.get_ready_for_retry(limit=limit)

    if dry_run:
        data = {
            "candidates": len(candidates),
            "candidate_internal_ids": [c["internal_id"] for c in candidates],
            "dry_run": True,
            "items": [],
            "succeeded": 0,
            "failed": 0,
        }
        if cli.output.lower() == "text":
            print(f"candidates     {len(candidates)}")
            for c in candidates[:limit]:
                print(f"  internal_id={c['internal_id']} retries={c['retry_count']}")
        else:
            emit(cli, data)
        return

    runner = LLMRunner(
        store=store,
        db_path=cli.cli_config.sync_store_db_path,
        attachment_storage_dir=cli.cli_config.attachment_storage_dir,
    )
    items: list[dict] = []
    succeeded = 0
    failed = 0
    try:
        for cand in candidates:
            iid = cand["internal_id"]
            try:
                result = asyncio.run(runner.run_for_internal_id(iid, force=True))
            except Exception as e:  # pragma: no cover
                result = {"ok": False, "internal_id": iid, "error": repr(e)}
            ok = bool(result.get("ok"))
            items.append({
                "internal_id": iid,
                "ok": ok,
                "error": result.get("error"),
                "skipped": result.get("skipped"),
            })
            if ok:
                succeeded += 1
            else:
                failed += 1
    finally:
        try:
            asyncio.run(runner.close())
        except Exception:
            pass

    data = {
        "candidates": len(candidates),
        "candidate_internal_ids": [c["internal_id"] for c in candidates],
        "dry_run": False,
        "items": items,
        "succeeded": succeeded,
        "failed": failed,
    }

    if cli.output.lower() == "text":
        print(f"candidates  {data['candidates']}")
        print(f"succeeded   {succeeded}")
        print(f"failed      {failed}")
        for it in items:
            tag = "OK" if it["ok"] else "FAIL"
            extra = it["error"] or it["skipped"] or ""
            print(f"  [{tag}] internal_id={it['internal_id']} {extra}")
    else:
        emit(cli, data)


# ============================================================
# stats (US-004)
# ============================================================

@app.command("stats")
def llm_stats(
    ctx: typer.Context,
    days: int = typer.Option(
        7, "--days", help="过去 N 天的 stats (-1 表示全量)",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """``llm_processing`` 表统计 (status 分布 + cost + cache hit + latency)."""
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if days == 0:
        raise emit_cli_error(cli, CliInvalidArgError(
            "--days 0 invalid; 用 -1 (全量) 或 >=1",
        ))

    db_path = cli.cli_config.sync_store_db_path
    since_ts: Optional[float] = None
    if days > 0:
        since_ts = time.time() - days * 86400

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
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
            if cli.output.lower() == "text":
                print("(llm_processing table does not exist; nothing to report)")
            else:
                emit(cli, data)
            return

        where = "WHERE updated_at >= ?" if since_ts is not None else ""
        params = [since_ts] if since_ts is not None else []

        by_status_rows = conn.execute(
            f"SELECT status, COUNT(*) AS n FROM llm_processing {where} "
            f"GROUP BY status",
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
        cache_hit_rate_pct = (
            round(100.0 * hit_count / rows_n, 1) if rows_n > 0 else 0.0
        )
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

    if cli.output.lower() == "text":
        print(f"days={days}  total={total}")
        for k, v in sorted(by_status.items()):
            print(f"  {k:12} {v}")
        print(f"input_tokens     {cost['input_tokens']}")
        print(f"output_tokens    {cost['output_tokens']}")
        print(f"cache_read       {cost['cache_read_input_tokens']}")
        print(f"cache_hit_rate   {cost['cache_hit_rate_pct']}%")
        print(f"avg_latency_ms   {cost['avg_latency_ms']}")
    else:
        emit(cli, data)


def _zero_cost() -> dict:
    return {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
        "cache_hit_rate_pct": 0.0,
        "avg_latency_ms": 0,
        "success_rows": 0,
    }


# ============================================================
# compare-paths (US-004) — PR-3 stub + dry-run plan
# ============================================================

@app.command("compare-paths")
def llm_compare_paths(
    ctx: typer.Context,
    count: int = typer.Option(20, "--count", help="随机抽 N 封对比 (--internal-ids 优先)"),
    internal_ids: Optional[str] = typer.Option(
        None, "--internal-ids",
        help="逗号分隔; 指定后忽略 --count",
    ),
    dry_run: bool = typer.Option(
        False, "--dry-run",
        help="仅打印 plan 不实跑 LLM 对比",
    ),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """R-15 灰度质量闸: SQLite markdown vs in-memory regex-stripped HTML 路径对比.

    PR-3 范围: 落 command 入口 + dry-run plan 输出; 实跑路径 (烧 token, 调
    LLMProcessor 双路径 + diff AILabels) 暂调用 ``scripts/compare_llm_path.py``
    或推迟到 PR-3 follow-up。
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if count <= 0 and not internal_ids:
        raise emit_cli_error(cli, CliInvalidArgError(
            "--count must be > 0 or pass --internal-ids LIST",
        ))

    explicit_ids: list[int] = []
    if internal_ids:
        try:
            for part in internal_ids.split(","):
                if not part.strip():
                    continue
                explicit_ids.append(int(part.strip()))
        except ValueError as e:
            raise emit_cli_error(cli, CliInvalidArgError(
                f"--internal-ids must be comma-separated integers: {e}",
            ))

    plan = {
        "sample_size": len(explicit_ids) if explicit_ids else count,
        "internal_ids": explicit_ids or None,
        "mode": "explicit" if explicit_ids else "random",
        "dry_run": True,
    }

    if dry_run:
        data = {"plan": plan, "status": "pr3_stub"}
        if cli.output.lower() == "text":
            print("=== compare-paths plan (dry-run) ===")
            for k, v in plan.items():
                print(f"{k:14} {v}")
        else:
            emit(cli, data)
        return

    # 非 dry-run 实跑路径 — PR-3 暂不接入烧 token 的双路径对比
    # 用户用 scripts/compare_llm_path.py 临时跑
    raise emit_cli_error(cli, CliNotImplementedError(
        "compare-paths non-dry-run path not yet implemented in PR-3.",
        hint=(
            "用 --dry-run 看 plan; 或临时跑 "
            "'python scripts/compare_llm_path.py --count N' / '--internal-ids ...'"
        ),
    ))
