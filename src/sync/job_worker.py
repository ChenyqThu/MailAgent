"""JobWorker — C1 async_jobs 长任务执行器 (asyncio loop, serve 进程内)。

与 ``FanoutWorker`` 同构: 主循环每 N 秒 claim 一个 queued job → ``asyncio.to_thread``
跑 ``job_runners.run_job`` (复用 LongTaskContext) → 写终态 + SSE。**串行** (一次一个 job,
长任务重, 不并发抢资源)。

启动: ``recover_orphaned()`` 把上次崩溃残留的 running 重置 queued → 从
``checkpoint_internal_id`` 续跑 (crash resume)。

关闭: ``stop()`` 设 stop_event; in-flight job 经 ``on_unit_done`` 协作式停 (返 False →
LongTaskContext 当前 unit 跑完即优雅中止 → 标 aborted)。

进度: 每 ``_PROGRESS_STRIDE`` 个 unit 刷一次 ``async_jobs`` 进度 + SSE ``job.progress``
(前端 events_bridge 已消费此 SSE 流; C2 才补 9200 鉴权)。

详见 docs/reference/architecture/backend-service-migration-matrix.md C1 + plan §C1。
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from loguru import logger

from src.events.publisher import safe_publish
from src.notify.center import NotifyCenter

if TYPE_CHECKING:
    from src.config import Config
    from src.cli.long_task import LongTaskSummary, UnitResult
    from src.sync.async_jobs import AsyncJob, AsyncJobRepository


# 每 N 个 unit 刷一次进度 (async_jobs 写 + SSE)。stop 检查每 unit 都做 (廉价)。
_PROGRESS_STRIDE = 10

# 通知中心文案 (task 08-20-notification-center, design §7「维护族 job 终态」行)。
# job_type 未登记时回落 job_type 原样 (前向兼容, 新 runner 上线不必同步改这里)。
_JOB_TYPE_LABELS = {
    "resync": "重传 Notion",
    "backfill_body": "回填正文",
    "backfill_metadata": "回填元数据",
}
_JOB_STATUS_LABELS = {
    "succeeded": "已完成",
    "partial_failure": "部分失败",
    "failed": "失败",
    "aborted": "已中止",
}
# design §7: failed/partial_failure=warn；succeeded/aborted=info。
_JOB_STATUS_SEVERITY = {
    "succeeded": "info",
    "aborted": "info",
    "partial_failure": "warn",
    "failed": "warn",
}


class JobWorker:
    """async_jobs 串行执行主循环。"""

    def __init__(
        self,
        *,
        repo: "AsyncJobRepository",
        config: "Config",
        poll_interval_sec: int = 5,
    ):
        self.repo = repo
        self.config = config
        self.poll_interval_sec = poll_interval_sec
        # 发布入口单源 (design §3.1): 构造只收 db_path, 不复用重 SyncStore 实例。
        self._notify_center = NotifyCenter(self.repo.db_path)

        self._stop_event = asyncio.Event()
        self._stats = {"claimed": 0, "succeeded": 0, "partial_failure": 0,
                       "failed": 0, "aborted": 0}

    @property
    def stats(self) -> dict:
        return dict(self._stats)

    def stop(self) -> None:
        """请求主循环退出. in-flight job 经 on_unit_done 协作式停 (当前 unit 跑完即止)."""
        self._stop_event.set()

    async def run(self) -> None:
        """主循环. 调用方 asyncio.create_task(worker.run())."""
        recovered = self.repo.recover_orphaned()
        logger.info(
            f"[job-worker] starting poll_interval={self.poll_interval_sec}s "
            f"(recovered {recovered} orphaned running job(s))"
        )

        while not self._stop_event.is_set():
            try:
                # 显式只 claim 维护族 (S4 D1 分区): 本 worker 跑 run_job (resync/backfill),
                # 看不到 agent_run (那族由独立 AgentRunWorker 认领, run_job 无其分支)。
                job = self.repo.claim_next(types=self.repo.MAINTENANCE_JOB_TYPES)
            except Exception as e:
                logger.error(f"[job-worker] claim crash: {e}", exc_info=True)
                job = None

            if job is not None:
                self._stats["claimed"] += 1
                try:
                    await asyncio.to_thread(self._execute, job)
                except Exception as e:  # noqa: BLE001 — 单 job 异常不杀 worker
                    logger.error(
                        f"[job-worker] execute crash job_id={job.job_id}: {e}",
                        exc_info=True,
                    )
                # claim 到 job → 立即下一轮 (不 sleep, 可能还有 queued)
                continue

            # 无 queued job → sleep poll_interval (stop_event 可立即跳出)
            try:
                await asyncio.wait_for(
                    self._stop_event.wait(), timeout=self.poll_interval_sec
                )
            except asyncio.TimeoutError:
                continue

        logger.info(f"[job-worker] stopped. stats={self._stats}")

    def _execute(self, job: "AsyncJob") -> None:
        """跑单个 job (在 to_thread 线程里): run_job → 写终态 → SSE。"""
        from src.services.context import ServiceContext
        from src.sync.job_runners import run_job, summary_to_status

        job_id = job.job_id
        resume_from = (
            job.checkpoint_internal_id + 1
            if job.checkpoint_internal_id is not None else None
        )
        safe_publish(
            "job.running",
            data={"job_id": job_id, "job_type": job.job_type,
                  "resume_from": resume_from},
            source="job-worker",
        )

        # 每 job 新建 ServiceContext (fresh NotionSync client; 与 serve-api per-request +
        # CLI batch 同语义 —— 每次 asyncio.run 新 loop, 复用同一 client 跨 loop 会撞)。
        deps = ServiceContext(self.config)
        hook = self._make_progress_hook(job_id)

        try:
            _results, summary = run_job(
                deps, job, on_unit_done=hook, resume_from=resume_from,
            )
        except Exception as e:  # noqa: BLE001 — runner 整体失败 (非 unit 级) → 标 failed
            logger.error(
                f"[job-worker] job_id={job_id} runner failed: {e}", exc_info=True
            )
            try:
                self.repo.mark_terminal(
                    job_id, status="failed",
                    last_error=f"{type(e).__name__}: {e}",
                )
            except Exception as e2:  # pragma: no cover
                logger.error(f"[job-worker] mark_terminal failed job_id={job_id}: {e2}")
            self._stats["failed"] += 1
            safe_publish(
                "job.failed",
                data={"job_id": job_id, "error": f"{type(e).__name__}: {e}"},
                source="job-worker",
            )
            self._notify_terminal(job, status="failed", error=f"{type(e).__name__}: {e}")
            return

        status = summary_to_status(summary)
        result = summary.as_dict()
        # 最终进度补一次 (最后一批可能没到 stride)
        try:
            done = summary.succeeded + summary.failed + summary.skipped
            self.repo.update_progress(job_id, done=done, total=summary.total)
            self.repo.mark_terminal(job_id, status=status, result=result)
        except Exception as e:  # pragma: no cover
            logger.error(f"[job-worker] mark_terminal failed job_id={job_id}: {e}")

        self._stats[status] = self._stats.get(status, 0) + 1
        event = "job.failed" if status in ("failed",) else "job.done"
        safe_publish(
            event,
            data={"job_id": job_id, "status": status, "summary": result},
            source="job-worker",
        )
        self._notify_terminal(job, status=status, summary=result)
        logger.info(f"[job-worker] job_id={job_id} done status={status} {result}")

    def _notify_terminal(
        self,
        job: "AsyncJob",
        *,
        status: str,
        summary: dict | None = None,
        error: str | None = None,
    ) -> None:
        """落一条 job 终态通知 (design §7「维护族 job 终态」行)。

        文案读 ``status`` (LongTaskSummary 派生), 不读 SSE 事件名 —— partial_failure/
        aborted 都走 ``job.done`` 但文案分别是「部分失败」「已中止」。通知路径绝不影响
        job 终态 (design §3.3 纪律, run_worker.py:157-160 同款): 整段 try 吞 + warning。
        """
        try:
            label = _JOB_TYPE_LABELS.get(job.job_type, job.job_type)
            status_label = _JOB_STATUS_LABELS.get(status, status)
            if summary is not None:
                body = (
                    f"成功 {summary.get('succeeded', 0)} · "
                    f"失败 {summary.get('failed', 0)} · "
                    f"跳过 {summary.get('skipped', 0)}（共 {summary.get('total', 0)}）"
                )
            else:
                body = f"执行异常：{error}" if error else ""
            self._notify_center.publish(
                category="results",
                source="job",
                title=f"{label}{status_label}",
                body=body,
                severity=_JOB_STATUS_SEVERITY.get(status, "warn"),
                dedupe_key=f"job:{job.job_type}:{job.job_id}",
                payload={
                    "link": {"type": "route", "to": "/admin/kanban"},
                    "job_id": job.job_id,
                    "job_type": job.job_type,
                    "status": status,
                },
            )
        except Exception as e:  # noqa: BLE001 — 通知路径绝不影响 job 终态
            logger.warning(
                f"[job-worker] notify_center publish failed job_id={job.job_id}: {e}"
            )

    def _make_progress_hook(self, job_id: int):
        """返回 on_unit_done 回调: 每 stride 个 unit 刷 async_jobs 进度 + SSE;
        每 unit 检查 stop_event (返 False → 协作式停止)。hook 自身异常由 LongTaskContext 吞。"""
        def _hook(res: "UnitResult", summary: "LongTaskSummary") -> bool:
            done = summary.succeeded + summary.failed + summary.skipped
            if done % _PROGRESS_STRIDE == 0 or done == summary.total:
                self.repo.update_progress(
                    job_id, done=done, total=summary.total,
                    checkpoint_internal_id=res.internal_id,
                )
                safe_publish(
                    "job.progress",
                    internal_id=res.internal_id,
                    data={"job_id": job_id, "done": done, "total": summary.total,
                          "unit_status": res.status},
                    source="job-worker",
                )
            return not self._stop_event.is_set()
        return _hook
