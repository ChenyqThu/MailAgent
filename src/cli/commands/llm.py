"""mailagent llm — LLM 跑分 / 自检 / 重试 / 统计 / 路径对比 (RFC v2 §4.4).

PR-3 US-003: run / selftest / retry-failed.
PR-3 US-004: stats / compare-paths.
"""

from __future__ import annotations

import asyncio
import sqlite3
import time
from typing import TYPE_CHECKING, Any, Optional

import typer

from src.cli.exceptions import (
    CliError,
    CliInvalidArgError,
    CliLLMFailedError,
)
from src.cli.output import apply_local_output as _apply_local_output, emit, emit_cli_error
from src.services.errors import ServiceError

if TYPE_CHECKING:
    from src.cli.context import CliContext


# Lazy-loaded compare-paths dependencies. Keeping these names at module scope makes
# test monkeypatching straightforward without forcing AppleScript/LLM imports on CLI
# startup.
EmailReader = None
AttachmentStore = None
EmailRepository = None
LLMProcessor = None
build_storage_payloads = None

app = typer.Typer(
    name="llm",
    help="LLM 分类 run / selftest / retry-failed / stats / compare-paths (RFC §4.4)",
    no_args_is_help=True,
)


def _maybe_create_davmail_backend(cli: "CliContext"):
    """Sprint 16 dual-backend: 非 applescript 模式 (davmail / outlook_com, task
    08-12 判据泛化) 时返回 probe ok 的 backend 实例, 让 LLM runner 走协议 fetch
    而非 AppleScript ``whose id`` (后者对合成 internal_id >= 10^9 无法定位).

    applescript mode 返回 None (runner lazy-init AppleScriptArm, 老路径不变).
    probe 失败**不吞** —— 冒泡给调用方 (E1 §3.1 Step 3: 防止静默回退到
    错 id 空间的 AppleScriptArm); 调用方 (llm_retry_failed) 负责转 CLI 错误。
    """
    from src.config import config as global_cfg
    backend_name = getattr(global_cfg, "mailagent_backend", "applescript")
    if backend_name == "applescript":
        return None
    from src.mail.backend.factory import create_backend
    return create_backend(global_cfg, sync_store=cli.sync_store)


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
    """对单封邮件跑 LLM 分类 → 填 Notion AI 字段 (PR-5 起 inline; 取代旧 scripts/run_llm_on_email.py).

    A3: 编排 + 守卫下沉 src/services/llm_service.py::LlmService (token auth 留 CLI 侧;
    dry-run 真跑 LLM 不写 Notion → 跳过 token auth)。
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)

    if not dry_run:
        try:
            cli.require_auth()
        except CliError as e:
            raise emit_cli_error(cli, e)

    from src.services.guards import Actor
    from src.services.llm_service import LlmService

    svc = LlmService(cli)
    try:
        result = svc.run(
            internal_id,
            dry_run=dry_run,
            force=force,
            no_overwrite=no_overwrite,
            actor=Actor(kind="cli", authenticated=True, label="cli"),
        )
    except ServiceError as e:
        raise emit_cli_error(cli, e)

    data = {
        "internal_id": result.internal_id,
        "page_id": result.page_id,
        "mailbox": result.mailbox,
        "dry_run": result.dry_run,
        "skipped": result.skipped,
        "labels": result.labels,
        "writer_summary": result.writer_summary,
        "stored_at": result.stored_at,
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

    try:
        runner = LLMRunner(
            store=store,
            db_path=cli.cli_config.sync_store_db_path,
            attachment_storage_dir=cli.cli_config.attachment_storage_dir,
            backend=_maybe_create_davmail_backend(cli),
        )
    except Exception as e:
        # E1 §3.1 Step 3: davmail 模式下 _maybe_create_davmail_backend 不再吞
        # probe 失败 —— 这里接住转成 CLI 错误, 而不是让裸异常炸穿 typer。
        raise emit_cli_error(cli, CliLLMFailedError(
            f"davmail backend probe failed: {e!r}",
            hint="检查 davmail JVM 是否在跑 / IMAP 端口可达, 或临时切回 "
            "MAILAGENT_BACKEND=applescript",
        ))
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
# compare-paths (US-005) — inline dual-path implementation
# ============================================================

_COMPARE_KEYS = [
    "category",
    "action_type",
    "priority",
    "action_required",
    "sender_priority",
    "language",
    "daily_digest_date",
]

_ESTIMATED_INPUT_TOKENS_PER_EMAIL = 2000
_ESTIMATED_OUTPUT_TOKENS_PER_EMAIL = 200
_ESTIMATED_TOKEN_COST_PER_1K_USD = 0.003


class _MockRepo:
    """Single-email in-memory repo: forces path B onto the SQLite markdown branch."""

    def __init__(self, internal_id: int, markdown: str):
        self._iid = internal_id
        self._md = markdown

    def get_body_markdown(self, internal_id: int, max_chars: int = -1) -> Optional[str]:
        if internal_id != self._iid or not self._md:
            return None
        if max_chars > 0 and len(self._md) > max_chars:
            return self._md[:max_chars]
        return self._md


def _ensure_compare_deps() -> None:
    global AttachmentStore
    global EmailReader
    global EmailRepository
    global LLMProcessor
    global build_storage_payloads

    if EmailReader is None:
        from src.mail.reader import EmailReader as _EmailReader

        EmailReader = _EmailReader
    if AttachmentStore is None:
        from src.repository import AttachmentStore as _AttachmentStore

        AttachmentStore = _AttachmentStore
    if EmailRepository is None:
        from src.repository import EmailRepository as _EmailRepository

        EmailRepository = _EmailRepository
    if LLMProcessor is None:
        from src.llm_agent.processor import LLMProcessor as _LLMProcessor

        LLMProcessor = _LLMProcessor
    if build_storage_payloads is None:
        from src.repository.storage_payload_builder import (
            build_storage_payloads as _build_storage_payloads,
        )

        build_storage_payloads = _build_storage_payloads


def _pick_internal_ids(count: int, db_path: str) -> list[int]:
    """Pick the N most recent synced emails from SyncStore."""
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            """SELECT internal_id FROM email_metadata
               WHERE sync_status='synced' AND notion_page_id IS NOT NULL
               ORDER BY updated_at DESC LIMIT ?""",
            (count,),
        ).fetchall()
    finally:
        conn.close()
    return [int(r[0]) for r in rows]


def _lookup_metadata(internal_id: int, db_path: str) -> Optional[dict[str, Any]]:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT * FROM email_metadata WHERE internal_id = ?",
            (internal_id,),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


async def _compare_one(
    internal_id: int,
    arm: Any,
    reader: Any,
    store: Any,
) -> dict[str, Any]:
    """Run one email through fallback-regex and SQLite-markdown LLM paths."""
    _ensure_compare_deps()

    meta = _lookup_metadata(internal_id, str(store.db_path))
    if not meta:
        return {"internal_id": internal_id, "ok": False, "error": "metadata not found"}

    mailbox = meta.get("mailbox") or "收件箱"

    full = arm.fetch_email_content_by_id(internal_id, mailbox)
    if not full:
        return {
            "internal_id": internal_id,
            "ok": False,
            "error": "AppleScript fetch failed",
        }

    email = reader.parse_email_source(
        full.get("source", ""),
        meta.get("message_id") or full.get("message_id", ""),
        is_read=bool(meta.get("is_read")),
        is_flagged=bool(meta.get("is_flagged")),
    )
    if email is None:
        return {
            "internal_id": internal_id,
            "ok": False,
            "error": "parse_email_source returned None",
        }
    email.mailbox = mailbox
    email.internal_id = internal_id

    body_payload, _ = build_storage_payloads(
        email,
        internal_id,
        raw_mime_source=full.get("source"),
        attachment_store=store.attachment_store,
    )
    markdown = body_payload.markdown or ""

    proc_a = LLMProcessor(repo=None)
    fallback_text = proc_a._plaintext_body(email)
    try:
        labels_a = await proc_a.process_email(email)
    except Exception as e:
        return {"internal_id": internal_id, "ok": False, "error": f"path A LLM error: {e}"}
    finally:
        await proc_a.close()

    proc_b = LLMProcessor(repo=_MockRepo(internal_id, markdown))
    sqlite_text = proc_b._plaintext_body(email)
    try:
        labels_b = await proc_b.process_email(email)
    except Exception as e:
        return {"internal_id": internal_id, "ok": False, "error": f"path B LLM error: {e}"}
    finally:
        await proc_b.close()

    diff: dict[str, tuple[Any, Any, bool]] = {}
    for key in _COMPARE_KEYS:
        a = getattr(labels_a, key)
        b = getattr(labels_b, key)
        diff[key] = (a, b, a == b)

    return {
        "internal_id": internal_id,
        "subject": (email.subject or "")[:80],
        "mailbox": mailbox,
        "ok": True,
        "fallback_text_len": len(fallback_text),
        "sqlite_md_len": len(sqlite_text),
        "model_a": labels_a.model,
        "model_b": labels_b.model,
        "diff": diff,
        "all_match": all(d[2] for d in diff.values()),
    }


def _build_cost_preview(model: str, email_count: int) -> dict[str, Any]:
    estimated_tokens_per_email = (
        _ESTIMATED_INPUT_TOKENS_PER_EMAIL + _ESTIMATED_OUTPUT_TOKENS_PER_EMAIL
    )
    estimated_total_tokens = estimated_tokens_per_email * email_count
    estimated_cost = (
        estimated_total_tokens * _ESTIMATED_TOKEN_COST_PER_1K_USD / 1000
    )
    return {
        "model": model,
        "estimated_input_tokens_per_email": _ESTIMATED_INPUT_TOKENS_PER_EMAIL,
        "estimated_output_tokens_per_email": _ESTIMATED_OUTPUT_TOKENS_PER_EMAIL,
        "estimated_tokens_per_email": estimated_tokens_per_email,
        "total_emails": email_count,
        "estimated_total_tokens": estimated_total_tokens,
        "cost_rate_per_1k_tokens_usd": _ESTIMATED_TOKEN_COST_PER_1K_USD,
        "estimated_cost_usd": round(estimated_cost, 4),
    }


def _summarize_compare_results(results: list[dict[str, Any]]) -> dict[str, Any]:
    ok_results = [r for r in results if r.get("ok")]
    ok_count = len(ok_results)
    if ok_count == 0:
        return {
            "all_match_pct": 0.0,
            "per_field_match_pct": {},
            "input_length": {
                "avg_fallback_text_len": 0,
                "avg_sqlite_md_len": 0,
                "delta_pct": 0.0,
            },
            "ok_count": 0,
            "total": len(results),
            "verdict": "no_data",
        }

    all_match_count = sum(1 for r in ok_results if r.get("all_match"))
    all_match_ratio = all_match_count / ok_count

    per_field: dict[str, float] = {}
    for key in _COMPARE_KEYS:
        matched = sum(1 for r in ok_results if r["diff"][key][2])
        per_field[key] = round(100.0 * matched / ok_count, 1)

    avg_fallback = sum(int(r["fallback_text_len"]) for r in ok_results) / ok_count
    avg_sqlite = sum(int(r["sqlite_md_len"]) for r in ok_results) / ok_count
    if avg_fallback:
        delta_pct = round((avg_sqlite - avg_fallback) / avg_fallback * 100.0, 1)
    else:
        delta_pct = 0.0

    if all_match_ratio >= 0.8:
        verdict = "pass"
    elif all_match_ratio >= 0.6:
        verdict = "marginal"
    else:
        verdict = "fail"

    return {
        "all_match_pct": round(100.0 * all_match_ratio, 1),
        "per_field_match_pct": per_field,
        "input_length": {
            "avg_fallback_text_len": round(avg_fallback, 1),
            "avg_sqlite_md_len": round(avg_sqlite, 1),
            "delta_pct": delta_pct,
        },
        "ok_count": ok_count,
        "total": len(results),
        "verdict": verdict,
    }


def _print_compare_result(result: dict[str, Any]) -> None:
    internal_id = result["internal_id"]
    if not result.get("ok"):
        print(f"  x {internal_id}: ERROR {result.get('error')}")
        return

    mark = "ok" if result.get("all_match") else "diff"
    print(
        f"  {mark} {internal_id} [{result['mailbox']}]: {result['subject']!r} "
        f"(fallback={result['fallback_text_len']}c, md={result['sqlite_md_len']}c)"
    )
    if not result.get("all_match"):
        for key, (a, b, matched) in result["diff"].items():
            if not matched:
                print(f"      x {key}: A={a!r} B={b!r}")


def _print_compare_summary(summary: dict[str, Any]) -> None:
    print(f"\n=== Summary ({summary['ok_count']}/{summary['total']} ok) ===")
    print(f"  All-fields match: {summary['all_match_pct']}%")
    print("  Per-field consistency:")
    for key in _COMPARE_KEYS:
        value = summary.get("per_field_match_pct", {}).get(key, 0.0)
        print(f"    {key:22s} {value:>5.1f}%")
    lengths = summary["input_length"]
    print("\n  Input length (avg):")
    print(f"    Path A (fallback regex strip): {lengths['avg_fallback_text_len']:>7}")
    print(f"    Path B (SQLite markdown):      {lengths['avg_sqlite_md_len']:>7}")
    print(f"\n  Verdict: {summary['verdict']}")


@app.command("compare-paths")
def llm_compare_paths(
    ctx: typer.Context,
    count: int = typer.Option(20, "--count", help="选择最近 synced 的 N 封 (--internal-ids 优先)"),
    internal_ids: Optional[str] = typer.Option(
        None, "--internal-ids",
        help="逗号分隔; 指定后忽略 --count",
    ),
    dry_run: bool = typer.Option(
        True, "--dry-run/--no-dry-run",
        help="仅打印 plan 不实跑 LLM 对比 (默认 True)",
    ),
    yes: bool = typer.Option(False, "--yes", help="确认实跑并消耗 LLM token"),
    output: Optional[str] = typer.Option(None, "-o", "--output"),
) -> None:
    """R-15 灰度质量闸: SQLite markdown vs in-memory regex-stripped HTML 路径对比.

    默认 dry-run，只输出候选 internal_id 与粗略成本预估。实跑会对每封邮件分别调用
    fallback-regex 和 SQLite-markdown 两条 LLM 输入路径，需要 ``--no-dry-run --yes``。
    """
    cli: "CliContext" = ctx.obj
    _apply_local_output(ctx, output)
    cfg = cli.cli_config

    if count <= 0 and not internal_ids:
        raise emit_cli_error(cli, CliInvalidArgError(
            "--count must be > 0 or pass --internal-ids LIST",
        ))
    if not dry_run and not yes:
        raise emit_cli_error(cli, CliInvalidArgError(
            "Real run burns LLM tokens; pass --yes to confirm.",
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

    ids = explicit_ids if explicit_ids else _pick_internal_ids(
        count,
        cfg.sync_store_db_path,
    )
    selection_mode = "explicit" if explicit_ids else "recent"

    if dry_run:
        cost_preview = _build_cost_preview(cfg.llm_model, len(ids))
        plan = {
            "mode": "dry_run",
            "sample_size": len(ids),
            "internal_ids": ids,
            "selection_mode": selection_mode,
            "model": cfg.llm_model,
            "cost_preview": cost_preview,
        }
        data = {"action": "compare-paths", **plan, "plan": plan}
        if cli.output.lower() == "text":
            print("=== compare-paths plan (dry-run) ===")
            print(f"  candidates: {len(ids)}")
            print(f"  internal_ids: {ids}")
            print(f"  model: {cfg.llm_model}")
            print(f"  cost preview: ~${cost_preview['estimated_cost_usd']}")
        else:
            emit(cli, data)
        return

    _ensure_compare_deps()

    # E1 §3.1 Step 3: 走 cli.backend (factory 已 probe, 尊重 MAILAGENT_BACKEND)
    # 而非裸构造 AppleScriptArm — davmail 模式下后者的 `whose id` 查询无法定位
    # davmail id 空间 (>=10^9) 的 internal_id。
    arm = cli.backend
    reader = EmailReader()
    store = EmailRepository(
        db_path=cfg.sync_store_db_path,
        attachment_store=AttachmentStore(cfg.attachment_storage_dir),
    )

    async def _run_all() -> list[dict[str, Any]]:
        results = []
        for internal_id in ids:
            results.append(await _compare_one(internal_id, arm, reader, store))
        return results

    results = asyncio.run(_run_all())
    summary = _summarize_compare_results(results)

    data = {
        "action": "compare-paths",
        "mode": "inline",
        "results": results,
        "summary": summary,
        "model": cfg.llm_model,
        "selection_mode": selection_mode,
        "internal_ids": ids,
    }

    if cli.output.lower() == "text":
        print("=== compare-paths results ===")
        for result in results:
            _print_compare_result(result)
        _print_compare_summary(summary)
    else:
        emit(cli, data)
