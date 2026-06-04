"""jobs 路由 — /api/jobs/* (C1 async_jobs 长任务统一 API)。

  POST /api/jobs            — enqueue 长任务 (resync / backfill_*)，立即返 job_id
  GET  /api/jobs/{job_id}   — 查 job 状态 / 进度 / 终态 summary

设计 (plan §C1 + 看板 C1 格):
  - enqueue 只写 async_jobs 行 (立即返回, 不阻塞)；serve 进程内 ``JobWorker`` (灰度
    MAILAGENT_ASYNC_JOBS_ENABLED) 串行 claim + 执行 + SSE ``job.progress``。worker 未
    启用时行保持 ``queued``。
  - 鉴权同其它写端点 (``Depends(verify_cf_access)``)；enqueue **不做 pm2 检测** (job 在
    serve=mail-sync 进程内跑, 不与自己冲突, 与 CLI batch 走独立进程时的 pm2 闸不同)。
  - ``idempotencyKey`` 命中已有 → 返既有 job_id + was_created=False (弱网重发不重复起)。
  - data 形状镜像 async_jobs 行 (snake_case wire), GET 给前端轮询进度 / 终态。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional

from fastapi import APIRouter, Depends, Request

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_job_repo
from src.events.publisher import safe_publish
from src.sync.job_runners import JOB_TYPES

if TYPE_CHECKING:
    from src.sync.async_jobs import AsyncJob

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


def _job_to_dict(job: "AsyncJob") -> dict[str, Any]:
    """AsyncJob → wire dict (前端轮询进度 / 终态)。"""
    return {
        "job_id": job.job_id,
        "job_type": job.job_type,
        "target_kind": job.target_kind,
        "target_key": job.target_key,
        "status": job.status,
        "progress_done": job.progress_done,
        "progress_total": job.progress_total,
        "checkpoint_internal_id": job.checkpoint_internal_id,
        "result": job.result,
        "last_error": job.last_error,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
        "started_at": job.started_at,
        "finished_at": job.finished_at,
    }


@router.post("", dependencies=[Depends(verify_cf_access)])
async def enqueue_job(request: Request, body: Optional[dict[str, Any]] = None):
    """enqueue 一个长任务，立即返 job_id (status='queued')。

    body (camelCase): {jobType (必填), targetKind?, targetKey?, params?, idempotencyKey?}。
    job_type ∈ {resync, backfill_body, backfill_derivatives, backfill_metadata}。
    """
    opts = body or {}
    job_type = opts.get("jobType")
    if job_type not in JOB_TYPES:
        raise APIError(
            "E_INVALID_ARG",
            f"jobType must be one of {sorted(JOB_TYPES)}, got {job_type!r}",
            source="sqlite",
        )

    repo = get_job_repo()
    try:
        job_id, was_created = repo.enqueue(
            job_type=job_type,
            target_kind=str(opts.get("targetKind") or ""),
            target_key=str(opts.get("targetKey") or ""),
            params=opts.get("params") or {},
            idempotency_key=opts.get("idempotencyKey"),
        )
    except ValueError as exc:
        raise APIError("E_INVALID_ARG", str(exc), source="sqlite")

    # 仅新建发 SSE (idempotent 重发不发, 与 outbox.enqueued 「仅新 intent 通知」一致)。
    if was_created:
        safe_publish(
            "job.enqueued",
            data={"job_id": job_id, "job_type": job_type},
            source="api",
        )

    return success_envelope(
        {
            "job_id": job_id,
            "status": "queued",
            "was_created": was_created,
            "job_type": job_type,
            "target_kind": str(opts.get("targetKind") or ""),
            "target_key": str(opts.get("targetKey") or ""),
        },
        request=request,
        source="sqlite",
    )


@router.get("/{job_id:int}", dependencies=[Depends(verify_cf_access)])
async def get_job(request: Request, job_id: int):
    """查 job 状态 / 进度 / 终态。404 当 job_id 不存在。"""
    job = get_job_repo().get(job_id)
    if job is None:
        raise APIError("E_NOT_FOUND", f"job_id={job_id} not found", source="sqlite")
    return success_envelope(_job_to_dict(job), request=request, source="sqlite")
