"""history-sync 路由 — /api/history-sync* (同步历史邮件, task 09-11)。

  GET  /api/history-sync         — 能力 / 默认范围 / Notion 日期地板 / 当前(或最近)任务
  POST /api/history-sync         — 发起一次同步 {since, until}，返回 job_id
  POST /api/history-sync/cancel  — 取消进行中的那个任务

实现纪律:
  - 任务本体是 async_jobs 的 ``history_sync`` 维护任务 (JobWorker 串行执行), 本路由只
    负责发起 / 取消 / 组装读态; 进度的权威在 async_jobs 行 + sync_state 的 live KV。
  - 校验与前端**同一条式子**: 跨度判据 `until − since ≤ max_days` 复用
    ``src.sync.history_sync.validate_range`` —— 各写一份会出现"界面让点、后端拒绝"。
  - ``notion_floor`` 必须与 watcher 判 Notion 日期地板用**同一个函数**
    (``src.config.parse_sync_start_date``), 否则界面承诺的日期与实际入库行为会分裂。
  - 同一时间只允许一个任务: 已有 queued/running 时直接返回它 (was_created=False),
    重复点击 / 并发请求不会起第二个。
"""

from __future__ import annotations

from datetime import datetime, timedelta
from functools import lru_cache
from typing import TYPE_CHECKING, Any, Optional

from fastapi import APIRouter, Depends, Request

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_job_repo, get_settings
from src.events.publisher import safe_publish
from src.services.errors import ServiceInvalidArgError
from src.sync.history_sync import (
    MAX_WINDOW_DAYS,
    _COUNT_FIELDS,
    cancel_state_key,
    read_live_state,
    request_cancel,
    validate_range,
)

if TYPE_CHECKING:
    from src.config import Config
    from src.sync.async_jobs import AsyncJob, AsyncJobRepository

router = APIRouter(prefix="/api/history-sync", tags=["history-sync"])

#: 还没跑完的任务 —— 判"能不能再起一个"与"取消谁"都看这两个状态。
_ACTIVE_STATUSES = ("queued", "running")

#: 支持窗口扫描的 backend (与 ``scan_history_window`` 的实现方一致)。
_SUPPORTED_BACKENDS = ("davmail", "outlook_com")


@lru_cache(maxsize=1)
def _sync_store():
    """进程内 SyncStore 单例 (lazy)。只持 db_path，连接 per-call 短命，WAL 并发安全。

    镜像 ``routers/im.py::_sync_store`` 的构造纪律: 除本 router 外没有第二个消费方,
    没必要抬成公共依赖。
    """
    from src.config import config as _config_singleton
    from src.mail.sync_store import SyncStore

    return SyncStore(_config_singleton.sync_store_db_path)


def get_history_store():
    """FastAPI 依赖: live/cancel 两个 sync_state KV 的读写面 (测试经 overrides 换临时库)。"""
    return _sync_store()


def _backend_name(cfg: "Config") -> str:
    return (getattr(cfg, "mailagent_backend", "") or "applescript").lower()


def _latest_job(repo: "AsyncJobRepository") -> Optional["AsyncJob"]:
    """进行中的那个; 没有就返回最近一次结束的; 从未跑过 → None。"""
    jobs = repo.list_runs(job_type="history_sync", target_key=None, limit=10)
    for job in jobs:
        if job.status in _ACTIVE_STATUSES:
            return job
    return jobs[0] if jobs else None


def _active_job(repo: "AsyncJobRepository") -> Optional["AsyncJob"]:
    job = _latest_job(repo)
    return job if job is not None and job.status in _ACTIVE_STATUSES else None


def _job_payload(job: Optional["AsyncJob"], store: Any) -> Optional[dict[str, Any]]:
    """async_jobs 行 + live KV → 前端契约的 ``job`` 字段 (design §5.1)。"""
    if job is None:
        return None
    live = read_live_state(store, job.job_id)
    live_counts = live.get("counts") or {}
    params = job.params or {}

    if job.status == "running":
        phase = str(live.get("phase") or "scanning")
    elif job.status == "queued":
        phase = "scanning"          # 还没开跑; 前端 queued 态不看 phase
    else:
        phase = "done"

    live_done = live.get("progress_done")
    live_total = live.get("progress_total")
    try:
        cancel_requested = str(store.get_state(cancel_state_key(job.job_id)) or "") == "1"
    except Exception:
        cancel_requested = False

    return {
        "job_id": job.job_id,
        "status": job.status,
        "phase": phase,
        "since": str(params.get("since") or live.get("since") or ""),
        "until": str(params.get("until") or live.get("until") or ""),
        "counts": {f: int(live_counts.get(f, 0) or 0) for f in _COUNT_FIELDS},
        "progress_done": (
            int(live_done) if live_done is not None else int(job.progress_done)
        ),
        "progress_total": (
            int(live_total) if live_total is not None else int(job.progress_total)
        ),
        "complete": bool(live.get("complete", True)),
        "covered_from": live.get("covered_from"),
        "cancel_requested": cancel_requested,
        "started_at": job.started_at if job.started_at is not None else job.created_at,
        "finished_at": job.finished_at,
        "updated_at": job.updated_at,
        # 停滞这类"任务没抛异常但也没做完"的原因只在 live 里 (async_jobs.last_error
        # 由 worker 在 runner 抛异常时才写), 两处都要看, 否则失败会显示成 0 封成功。
        "last_error": job.last_error or live.get("last_error"),
    }


@router.get("", dependencies=[Depends(verify_cf_access)])
async def get_history_sync(
    request: Request,
    cfg: "Config" = Depends(get_settings),
    store: Any = Depends(get_history_store),
):
    """能力 + 默认范围 + 当前(或最近一次)任务 —— 前端唯一状态源。"""
    from src.config import notion_enabled, parse_sync_start_date

    backend = _backend_name(cfg)
    supported = backend in _SUPPORTED_BACKENDS
    today = datetime.now().date()
    lookback = max(
        1, min(MAX_WINDOW_DAYS, int(getattr(cfg, "sync_lookback_days", 14) or 14))
    )
    floor = parse_sync_start_date(cfg)

    return success_envelope(
        {
            "supported": supported,
            "unsupported_reason": None if supported else "backend_applescript",
            "backend": backend,
            "defaults": {
                "since": (today - timedelta(days=lookback)).isoformat(),
                "until": today.isoformat(),
            },
            "max_days": MAX_WINDOW_DAYS,
            "notion_enabled": notion_enabled(cfg),
            "notion_floor": floor.strftime("%Y-%m-%d") if floor else None,
            "job": _job_payload(_latest_job(get_job_repo()), store),
        },
        request=request,
        source="sqlite",
    )


@router.post("", dependencies=[Depends(verify_cf_access)])
async def start_history_sync(
    request: Request,
    body: Optional[dict[str, Any]] = None,
    cfg: "Config" = Depends(get_settings),
):
    """发起一次历史邮件同步。已有进行中的任务 → 直接返回它 (不起第二个)。"""
    opts = body or {}
    backend = _backend_name(cfg)
    if backend not in _SUPPORTED_BACKENDS:
        raise APIError(
            "E_INVALID_ARG",
            f"当前邮件后端 ({backend}) 不支持同步历史邮件",
            hint="AppleScript 模式请用 `mailagent init fetch-cache`",
            source="sqlite",
        )

    since = str(opts.get("since") or "")
    until = str(opts.get("until") or "")
    try:
        validate_range(since, until)
    except ServiceInvalidArgError as exc:
        raise APIError("E_INVALID_ARG", str(exc), source="sqlite")

    repo = get_job_repo()
    existing = _active_job(repo)
    if existing is not None:
        return success_envelope(
            {"job_id": existing.job_id, "was_created": False},
            request=request,
            source="sqlite",
        )

    job_id, was_created = repo.enqueue(
        job_type="history_sync",
        target_kind="range",
        target_key=f"{since}..{until}",
        params={"since": since, "until": until},
    )
    if was_created:
        safe_publish(
            "job.enqueued",
            data={"job_id": job_id, "job_type": "history_sync"},
            source="api",
        )
    return success_envelope(
        {"job_id": job_id, "was_created": was_created},
        request=request,
        source="sqlite",
    )


@router.post("/cancel", dependencies=[Depends(verify_cf_access)])
async def cancel_history_sync(
    request: Request,
    body: Optional[dict[str, Any]] = None,
    store: Any = Depends(get_history_store),
):
    """请求取消进行中的任务 —— 只置标记, 已入库的邮件照常被流水线处理完。"""
    job = _active_job(get_job_repo())
    if job is None:
        raise APIError(
            "E_NOT_FOUND", "没有正在进行的历史邮件同步任务", source="sqlite"
        )
    request_cancel(store, job.job_id)
    return success_envelope(
        {"job_id": job.job_id, "cancel_requested": True},
        request=request,
        source="sqlite",
    )
