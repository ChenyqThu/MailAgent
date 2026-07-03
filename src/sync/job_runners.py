"""Job runners — C1 async_jobs 子系统的执行器 (transport-neutral)。

把一个 ``async_jobs`` 行 (job_type + target + params) 编排成一组 ``(internal_id,
callable)`` unit，交 ``LongTaskContext`` 执行 (checkpoint / 熔断 / 进度全复用)。
``JobWorker`` (src/sync/job_worker.py) 在 serve 进程内 ``asyncio.to_thread`` 调本模块。

分层说明 (有意, 见 plan §C1「执行器复用 cli/long_task.py」):
  - 本模块属 **sync-engine 层** (与 fanout 并列), 故可 import ``cli/long_task`` 复用
    长任务执行器 + 同层 import ``sync/backfill_builders`` 的 transport-neutral builder。
    ``src/services/`` (MailWriteService 等) 仍**绝不 import cli** —— 那条不变式不受影响。
  - resync runner 用领域类 ``NotionSync.create_email_page_from_sqlite`` (src/notion),
    与 CLI batch ``_resync_batch._make_unit`` **逐字段对齐** (仅 CliNotFoundError →
    ServiceNotFoundError, 同 code=E_NOT_FOUND)。parity 见 tests/cli/test_service_parity.py。
  - backfill runner import ``sync/backfill_builders`` 的 picker / unit-builder (D2a 已从
    cli/commands/backfill.py 下沉到本 engine 层 → 同层 import, 消除原 lazy sync→cli)。
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any, Callable, List, Optional, Tuple

from src.cli.long_task import LongTaskContext, LongTaskSummary, UnitResult
from src.services.errors import ServiceInvalidArgError, ServiceNotFoundError

if TYPE_CHECKING:
    from src.mail.sync_store import SyncStore
    from src.services.context import ServiceDeps
    from src.sync.async_jobs import AsyncJob


# job_type 枚举 = runner registry —— 必须与 src/sync/async_jobs.py
# AsyncJobRepository.MAINTENANCE_JOB_TYPES 逐一致 (S4 D1 分区后, run_job 只处理维护族;
# agent_run 在 AGENT_JOB_TYPES, 由独立 AgentRunWorker 执行, 无 runner 分支)。
# tests/sync/test_async_jobs.py::test_job_types_match_runner_registry 断言一致。
JOB_TYPES = frozenset({
    "resync",
    "backfill_body",
    "backfill_derivatives",
    "backfill_metadata",
})

# on_unit_done hook 类型: (UnitResult, LongTaskSummary) → Optional[bool]
# 返回 False ⇒ 协作式停止 (LongTaskContext 优雅中止)。
UnitDoneHook = Callable[["UnitResult", "LongTaskSummary"], Optional[bool]]
RunOutcome = Tuple[List[UnitResult], LongTaskSummary]


# ============================================================
# 共享 LongTaskContext driver
# ============================================================

class _JobLongTaskCtx:
    """``LongTaskContext`` 要的最小 ``cli`` 接口 (.sync_store + .output)。

    worker 进程内驱动: ``output='json'`` → ``run()`` 既不走 ndjson stdout 也不走 text
    stderr (进度仅经 ``on_unit_done`` → async_jobs + SSE); ``sync_store`` 是真 SyncStore
    (resume_from 已显式传 → ``_read_resume_floor`` 不读它, 但 break 路径写 checkpoint 会用)。
    """

    def __init__(self, sync_store: "SyncStore") -> None:
        self.sync_store = sync_store
        self.output = "json"


def drive_units(
    sync_store: "SyncStore",
    *,
    command: str,
    target_kind: str,
    target_key: str,
    units: List[Tuple[int, Callable[[], dict]]],
    max_failures: int,
    resume_from: Optional[int],
    on_unit_done: Optional[UnitDoneHook],
) -> RunOutcome:
    """用 LongTaskContext 跑一组 unit (worker 上下文配置)。

    checkpoint_every=0: async_jobs 是 checkpoint 真源 (on_unit_done 持久化
    checkpoint_internal_id), 不污染 cli_checkpoints。install_signal_handler=False:
    worker 在 serve 进程内, 不劫持 serve 的 SIGINT (graceful 停由 on_unit_done 协作式停)。
    """
    ltc = LongTaskContext(
        cli=_JobLongTaskCtx(sync_store),
        command=command,
        target_kind=target_kind,
        target_key=target_key,
        max_failures=max_failures,
        checkpoint_every=0,
        progress_every=0,
        resume_from=resume_from,
        install_signal_handler=False,
    )
    return ltc.run(units, on_unit_done=on_unit_done)


def summary_to_status(summary: LongTaskSummary) -> str:
    """LongTaskSummary → async_jobs 终态 (镜像 _derive_exit_code / _status_for_summary)。

    max_failures 熔断 → failed; SIGINT/协作式中止 → aborted; 有失败但有成功 →
    partial_failure; 全失败 → failed; 否则 succeeded。
    """
    if summary.max_failures_hit:
        return "failed"
    if summary.aborted:
        return "aborted"
    if summary.failed > 0:
        return "partial_failure" if summary.succeeded > 0 else "failed"
    return "succeeded"


# ============================================================
# job_type 分发
# ============================================================

def run_job(
    deps: "ServiceDeps",
    job: "AsyncJob",
    *,
    on_unit_done: Optional[UnitDoneHook] = None,
    resume_from: Optional[int] = None,
) -> RunOutcome:
    """执行一个 job，返回 (results, summary)。caller (worker) 据 summary 写终态。"""
    if job.job_type == "resync":
        return run_resync_job(
            deps, target_kind=job.target_kind, target_key=job.target_key,
            params=job.params, on_unit_done=on_unit_done, resume_from=resume_from,
        )
    if job.job_type in ("backfill_body", "backfill_derivatives", "backfill_metadata"):
        return run_backfill_job(
            deps, job.job_type, target_kind=job.target_kind, target_key=job.target_key,
            params=job.params, on_unit_done=on_unit_done, resume_from=resume_from,
        )
    raise ServiceInvalidArgError(f"unknown job_type={job.job_type!r}")


# ============================================================
# resync (复用 NotionSync.create_email_page_from_sqlite, src/notion — 分层干净)
# ============================================================

def _resolve_resync_ids(
    target_kind: str, target_key: str, params: dict,
) -> List[int]:
    ids = params.get("internal_ids")
    if ids:
        return [int(x) for x in ids]
    if target_kind == "range" and "-" in (target_key or ""):
        lo, hi = target_key.split("-", 1)
        return list(range(int(lo), int(hi) + 1))
    raise ServiceInvalidArgError(
        "resync job 需要 params.internal_ids 或 target_kind='range' + target_key 'LO-HI'"
    )


def _make_resync_unit(
    notion_sync: Any, repo: Any, sync_store: Any, iid: int,
    *, replace_existing: bool, skip_parent_lookup: bool,
) -> Callable[[], dict]:
    """逐字段对齐 CLI _resync_batch._make_unit (仅 CliNotFoundError→ServiceNotFoundError)。"""
    def _runner() -> dict:
        try:
            result = asyncio.run(
                notion_sync.create_email_page_from_sqlite(
                    iid,
                    repo=repo,
                    sync_store=sync_store,
                    replace_existing=replace_existing,
                    skip_parent_lookup=skip_parent_lookup,
                )
            )
        except ValueError as e:
            raise ServiceNotFoundError(
                f"internal_id={iid} not in SQLite SSoT: {e}",
                hint="Run backfill body first",
            )
        return {
            "page_id": result.page_id,
            "archived_page_id": result.archived_page_id,
            "action": result.action,
        }
    return _runner


def run_resync_job(
    deps: "ServiceDeps",
    *,
    target_kind: str,
    target_key: str,
    params: dict,
    on_unit_done: Optional[UnitDoneHook],
    resume_from: Optional[int],
) -> RunOutcome:
    internal_ids = _resolve_resync_ids(target_kind, target_key, params)
    replace_existing = bool(params.get("replace_existing"))
    skip_parent_lookup = bool(params.get("skip_parent_lookup"))
    max_failures = int(params.get("max_failures", 5))

    repo = deps.email_repo
    sync_store = deps.sync_store
    notion_sync = deps.notion_sync
    units = [
        (
            iid,
            _make_resync_unit(
                notion_sync, repo, sync_store, iid,
                replace_existing=replace_existing,
                skip_parent_lookup=skip_parent_lookup,
            ),
        )
        for iid in internal_ids
    ]
    return drive_units(
        sync_store, command="job:resync", target_kind=target_kind,
        target_key=target_key, units=units, max_failures=max_failures,
        resume_from=resume_from, on_unit_done=on_unit_done,
    )


# ============================================================
# backfill (复用 cli/commands/backfill 现成 builder — backfill.py 零改动)
# ============================================================

def run_backfill_job(
    deps: "ServiceDeps",
    job_type: str,
    *,
    target_kind: str,
    target_key: str,
    params: dict,
    on_unit_done: Optional[UnitDoneHook],
    resume_from: Optional[int],
) -> RunOutcome:
    # 同层 engine import (D2a 已把 backfill builder 从 cli/commands/backfill.py 下沉到
    # src/sync/backfill_builders.py, 消除原 lazy sync→cli 反向 import)。lazy import 仅为
    # 避免顶部拉重 domain 依赖 (NotionSync/AppleScriptArm 等)。
    # job 恒 dry_run=False (dry-run 是 CLI 预览语义, job 一定实跑)。
    from src.sync import backfill_builders as bf

    cfg = deps.config
    db_path = cfg.sync_store_db_path
    sync_store = deps.sync_store
    max_failures = int(params.get("max_failures", 20))
    internal_ids = params.get("internal_ids")

    if job_type == "backfill_body":
        from src.mail.reader import EmailReader

        if internal_ids:
            records = bf._hydrate_internal_ids([int(x) for x in internal_ids], sync_store)
        else:
            records = bf._pick_candidates(
                db_path,
                force=bool(params.get("force")),
                since_date=params.get("since_date"),
                until_date=params.get("until_date"),
                mailbox=params.get("mailbox"),
                limit=params.get("limit"),
            )
        bf._ensure_dead_table(db_path)
        units = bf._make_body_units(
            records,
            # E1 §3.1 Step 3: 走 deps.backend (factory 已 probe, 尊重
            # MAILAGENT_BACKEND) 而非裸构造 AppleScriptArm — davmail 模式下后者
            # 的 `whose id` 查询无法定位 davmail id 空间 (>=10^9) 的 internal_id。
            arm=deps.backend,
            reader=EmailReader(),
            repo=deps.email_repo,
            notion_sync=deps.notion_sync,
            sync_store=sync_store,
            db_path=db_path,
            dry_run=False,
        )

    elif job_type == "backfill_derivatives":
        single = internal_ids[0] if internal_ids else params.get("internal_id")
        candidates = bf._find_candidates(
            db_path, int(single) if single is not None else None,
        )
        units = bf._make_derivative_units(candidates, repo=deps.email_repo, dry_run=False)

    elif job_type == "backfill_metadata":
        source = params.get("source", "notion")
        if source not in ("notion", "applescript"):
            raise ServiceInvalidArgError(
                f"backfill_metadata source must be notion|applescript, got {source!r}"
            )
        if source == "applescript" and getattr(cfg, "mailagent_backend", "applescript") == "davmail":
            raise ServiceInvalidArgError(
                "backfill_metadata source=applescript unsupported when "
                "MAILAGENT_BACKEND=davmail (AppleScript `whose id` 无法定位 davmail "
                "id 空间 >=10^9 的 internal_id)",
                hint="改用 source=notion (默认), 或临时切回 "
                "MAILAGENT_BACKEND=applescript 跑完本次回填",
            )
        if internal_ids:
            records = bf._hydrate_metadata_records(
                [int(x) for x in internal_ids], sync_store,
            )
        else:
            records = bf._pick_metadata_candidates(
                db_path,
                force=bool(params.get("force")),
                since_date=params.get("since_date"),
                until_date=params.get("until_date"),
                mailbox=params.get("mailbox"),
                limit=params.get("limit"),
            )
        notion_client = None
        arm = None
        reader = None
        if source == "notion":
            from notion_client import Client as NotionSyncClient
            notion_client = NotionSyncClient(auth=cfg.notion_token)
        else:
            from src.mail.reader import EmailReader
            # 走到这里已确保 mailagent_backend != davmail (上面 guard 挡了),
            # deps.backend 即等价的已 probe AppleScriptBackend 实例。
            arm = deps.backend
            reader = EmailReader()
        units = bf._make_metadata_units(
            records,
            source=source,
            notion_client=notion_client,
            arm=arm,
            reader=reader,
            sync_store=sync_store,
            dry_run=False,
        )
    else:  # pragma: no cover — run_job 已挡, 双保险
        raise ServiceInvalidArgError(f"unknown backfill job_type={job_type!r}")

    return drive_units(
        sync_store, command=f"job:{job_type}", target_kind=target_kind,
        target_key=target_key, units=units, max_failures=max_failures,
        resume_from=resume_from, on_unit_done=on_unit_done,
    )
