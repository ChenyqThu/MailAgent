"""llm 路由 — /api/llm/*。

run (写, in-process LlmService) / stats (读, 直查 llm_processing) / selftest (读, subprocess)。
契约: llm-run.schema.json + llm-stats.schema.json + frontend llm.{run,stats}。

读端点 (stats) 经 ``Depends(get_repository)`` 拿 EmailRepository, 复用其 _connect()
直查 llm_processing 表 (镜像 src/cli/commands/llm.py llm_stats 的 SQL), meta.source='sqlite'。
写端点 (run) A3 起经进程内 ``LlmService`` (asyncio.to_thread, 不再 fork CLI), meta.source='cli';
selftest (读, 不烧 token) 仍经 cli_runner.run_cli。

统一响应走 app.success_envelope / app.APIError (与 email/attachment router 一致;
app.py 已把 router import 下沉到 helper 定义之后, 无循环导入)。
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import TYPE_CHECKING, List, Optional

import httpx
from fastapi import APIRouter, Depends, Query, Request

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.cli_runner import CliRunnerError, run_cli
from src.api.deps import get_repository, get_service_ctx, get_settings
from src.services.errors import ServiceError
from src.services.guards import Actor
from src.services.llm_service import LlmService

if TYPE_CHECKING:
    from src.repository import EmailRepository

router = APIRouter(prefix="/api/llm", tags=["llm"])

# ============================================================
# GET /api/llm/models  (读, 上游 /v1/models + TTL 缓存)
# ============================================================
# 模块级内存缓存结构：per-provider dict，key = 'main' | 'translate'。
# 每个 entry: {"models": [...], "cached_at": float, "error": str|None}
# None = 未初始化（尚未取过）。多 worker 各自独立（单 worker 场景可接受）。
_models_cache: dict = {}  # key: 'main' | 'translate' → cache entry dict
_MODELS_CACHE_TTL_SEC = 300  # 5 min
_UPSTREAM_TIMEOUT = httpx.Timeout(connect=10.0, read=10.0, write=10.0, pool=10.0)


async def _fetch_upstream_models(api_base: str, api_key: str) -> List[str]:
    """上游 GET /v1/models 双协议重试 → 解析 data[].id。

    Round 1: ``Authorization: Bearer <key>``（OpenAI 协议标准）。
    Round 2（仅当 Round 1 返 401/404）: ``x-api-key`` + ``anthropic-version: 2023-06-01``
    （Anthropic 原生协议）。
    任何网络 / 解析错误 → 返 []，不抛（best-effort，前端 fallback 到硬编码列表）。
    """
    url = f"{api_base.rstrip('/')}/v1/models"

    def _parse_models(body: dict) -> List[str]:
        data = body.get("data")
        if not isinstance(data, list):
            return []
        return [item["id"] for item in data if isinstance(item, dict) and isinstance(item.get("id"), str)]

    try:
        async with httpx.AsyncClient(timeout=_UPSTREAM_TIMEOUT) as client:
            # Round 1: Bearer
            r1 = await client.get(url, headers={"Authorization": f"Bearer {api_key}"})
            if r1.status_code not in (401, 404):
                if r1.is_success:
                    return _parse_models(r1.json())
                return []
            # Round 2: x-api-key (Anthropic)
            r2 = await client.get(
                url,
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                },
            )
            if r2.is_success:
                return _parse_models(r2.json())
            return []
    except Exception:  # noqa: BLE001 — network/parse error → graceful empty
        return []


def _resolve_translate_credentials() -> tuple[str, str]:
    """翻译 provider 的 base/key，对齐 llm_settings.ts 的回退语义。

    LLM_TRANSLATE_BASE_URL 未配置 → 回退主网关 LLM_API_BASE。
    LLM_TRANSLATE_API_KEY 未配置 → 回退主网关 LLM_API_KEY。
    热读 .env（不走 pydantic 单例，与 chat.py dotenv_values 模式一致），
    让运行中修改 .env 后 ?refresh=true 立即生效。
    """
    from dotenv import dotenv_values as _dotenv_values

    from src.api.deps import get_env_file_path

    env_path = get_env_file_path()
    env_vals: dict = {}
    if env_path:
        try:
            env_vals = {k: v for k, v in _dotenv_values(env_path).items() if v is not None}
        except Exception:  # noqa: BLE001
            pass

    cfg = get_settings()
    main_base = (getattr(cfg, "llm_api_base", None) or "").strip()
    main_key = (getattr(cfg, "llm_api_key", None) or "").strip()

    translate_base = (env_vals.get("LLM_TRANSLATE_BASE_URL") or "").strip()
    translate_key = (env_vals.get("LLM_TRANSLATE_API_KEY") or "").strip()

    api_base = translate_base if translate_base else main_base
    api_key = translate_key if translate_key else main_key
    return api_base, api_key


@router.get("/models")
async def list_upstream_models(
    request: Request,
    refresh: bool = Query(False),
    provider: str = Query("main"),
    _: None = Depends(verify_cf_access),
):
    """上游 /v1/models 全量列表（TTL 缓存 5 min，按 provider 分键）。

    ``?provider=main``（默认）用主 LLM 网关（LLM_API_BASE / LLM_API_KEY）。
    ``?provider=translate`` 用翻译 provider（LLM_TRANSLATE_BASE_URL / LLM_TRANSLATE_API_KEY，
    未配置则回退主网关，对齐 llm_settings.ts 语义）。
    其他 provider 值返 400。

    ``?refresh=true`` 强刷绕过缓存。api_base 未配置 → error:'api_base_not_configured'。
    响应恒 200：``{models, cached, cached_at, error?}``（前端 fallback 到硬编码列表）。

    鉴权：``Depends(verify_cf_access)`` （与同文件其他端点一致）。
    """
    if provider not in ("main", "translate"):
        raise APIError(
            "E_INVALID_ARG",
            f"invalid provider: {provider!r}; must be 'main' or 'translate'",
            hint="use ?provider=main or ?provider=translate",
            source="upstream",
        )

    if provider == "translate":
        api_base, api_key = _resolve_translate_credentials()
    else:
        cfg = get_settings()
        api_base = (getattr(cfg, "llm_api_base", None) or "").strip()
        api_key = (getattr(cfg, "llm_api_key", None) or "").strip()

    if not api_base:
        return success_envelope(
            {"models": [], "cached": False, "cached_at": None, "error": "api_base_not_configured"},
            request=request,
            source="upstream",
        )

    cache_entry = _models_cache.get(provider)
    now = time.time()
    use_cache = (
        not refresh
        and cache_entry is not None
        and (now - cache_entry["cached_at"]) < _MODELS_CACHE_TTL_SEC
    )
    if use_cache:
        return success_envelope(
            {
                "models": cache_entry["models"],
                "cached": True,
                "cached_at": cache_entry["cached_at"],
                "error": cache_entry.get("error"),
            },
            request=request,
            source="upstream",
        )

    try:
        models = await _fetch_upstream_models(api_base, api_key)
    except Exception:  # noqa: BLE001 — best-effort; _fetch_upstream_models should not raise
        models = []
    _models_cache[provider] = {"models": models, "cached_at": now, "error": None}
    return success_envelope(
        {"models": models, "cached": False, "cached_at": now, "error": None},
        request=request,
        source="upstream",
    )


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


def _raise_from_service_error(exc: ServiceError) -> None:
    """in-process service 抛的 ServiceError → APIError (与 _raise_from_cli_error 对称)。

    code 用 service 自报的 ``ServiceError.code`` (E_LLM_FAILED / E_NOT_FOUND / ...),
    http_status 由 app.ERROR_CODE_TO_HTTP[code] 推导。``source='cli'`` 维持既有 wire 契约。
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
    """对单封邮件跑 LLM 分类 → 填 Notion AI 字段 (A3: in-process LlmService, 不再 fork CLI)。

    LlmRunOpts: dryRun→dry_run, force→force, noOverwrite→no_overwrite。dry-run 真跑 LLM
    不写 Notion → 跳过 write auth (请求已过 verify_cf_access, 执行路径用已鉴权 Actor)。
    data 透传 llm-run.schema.json 形状 {internal_id, page_id, mailbox, dry_run, skipped,
    labels, writer_summary, stored_at}。E_LLM_FAILED → 500, E_NOT_FOUND → 404
    (service 自报 code, 经 ERROR_CODE_TO_HTTP 映射)。
    """
    svc = LlmService(get_service_ctx())
    try:
        result = await asyncio.to_thread(
            svc.run,
            internal_id,
            dry_run=dry_run,
            force=force,
            no_overwrite=no_overwrite,
            actor=Actor(kind="http", authenticated=True, label="cf-access"),
        )
    except ServiceError as exc:
        _raise_from_service_error(exc)

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
    return success_envelope(data, request=request, source="cli")


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
