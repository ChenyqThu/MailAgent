"""LongTaskContext — 长任务契约共用 (RFC v2 §5.2 / PR-4 §2.2).

提供:
- SIGINT 二次语义: 第一次 → 当前 unit 跑完后退出 exit 7 (E_ABORTED);
  第二次 → ``sys.exit(130)`` 立即退
- ``--max-failures`` 熔断: 连续失败超过阈值 → exit 8 (E_MAX_FAILURES)
- Checkpoint: 每 ``checkpoint_every`` 个 unit UPSERT 一次
  ``cli_checkpoints`` 行
- Resume: ``resume_from`` 跳过 ``internal_id < resume_from`` 的 unit
- Progress: text mode rich.progress; ndjson 每 unit 一行; json 收集到
  末尾一次性 emit

设计原则:
- LongTaskContext 不知道具体业务 — caller 提供 ``(internal_id, callable)`` 列表
- ``callable`` 抛任意 ``Exception`` 都计为 failure (含 message + type_name)
- caller 决定 ``--allow-concurrent`` / PM2 检测时机 (在调本类之前)
"""

from __future__ import annotations

import json
import signal
import sys
import time
from dataclasses import dataclass, field
from typing import (
    Any,
    Callable,
    Iterable,
    List,
    Optional,
    Tuple,
    TYPE_CHECKING,
)

import typer

from src.cli.exceptions import (
    CliError,
)

if TYPE_CHECKING:
    from src.cli.context import CliContext


# Unit callable 返回 dict (任意业务字段, 会写进 succeeded 列表).
# 抛 Exception → 进 failed 列表.
UnitCallable = Callable[[], dict]
UnitItem = Tuple[int, UnitCallable]


@dataclass
class UnitResult:
    internal_id: int
    status: str  # 'success' | 'failed' | 'skipped'
    duration_ms: int
    data: Optional[dict] = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None


@dataclass
class LongTaskSummary:
    total: int = 0
    succeeded: int = 0
    failed: int = 0
    skipped: int = 0
    aborted: bool = False
    aborted_reason: Optional[str] = None
    max_failures_hit: bool = False
    exit_code: int = 0

    def as_dict(self) -> dict:
        return {
            "total": self.total,
            "succeeded": self.succeeded,
            "failed": self.failed,
            "skipped": self.skipped,
            "aborted": self.aborted,
            "aborted_reason": self.aborted_reason,
            "max_failures_hit": self.max_failures_hit,
        }


@dataclass
class LongTaskContext:
    """长任务执行上下文 — caller 拿到本对象后调 ``run(units)``.

    Args:
        cli: CliContext (用于 output / sync_store / 写 checkpoint)
        command: checkpoint 表 PK 第一段 (如 'email-resync')
        target_kind: 'range' / 'ids' / 'all' (RFC §2.2 表)
        target_key: PK 第二段 (如 '53000-53100' / 'ids:53674,53675')
        max_failures: 连续失败阈值, 0 = 不熔断
        checkpoint_every: 每 N unit 写一次 checkpoint
        progress_every: text 模式 progress bar refresh / ndjson stream emit 频率
        resume_from: 跳过 ``internal_id < resume_from`` 的 unit; None = 全跑
        payload: 写入 checkpoint payload 列 (JSON, 命令上下文)
        install_signal_handler: 是否注册 SIGINT handler; 测试场景常 False
    """

    cli: "CliContext"
    command: str
    target_kind: str
    target_key: str
    max_failures: int = 0
    checkpoint_every: int = 50
    progress_every: int = 10
    resume_from: Optional[int] = None
    payload: Optional[dict] = None
    install_signal_handler: bool = True

    _sigint_count: int = field(default=0, init=False)
    _consecutive_failures: int = field(default=0, init=False)

    # ------------------------------------------------------------
    # SIGINT handling
    # ------------------------------------------------------------

    def _on_sigint(self, signum, frame):  # pragma: no cover - signal path
        self._sigint_count += 1
        if self._sigint_count == 1:
            print(
                "\n[long-task] SIGINT received — finishing current unit; "
                "press Ctrl-C again to abort immediately.",
                file=sys.stderr,
            )
        else:
            print("\n[long-task] second SIGINT — aborting now.", file=sys.stderr)
            sys.exit(130)

    def _install_signal(self) -> Optional[Callable]:
        if not self.install_signal_handler:
            return None
        try:
            prev = signal.getsignal(signal.SIGINT)
            signal.signal(signal.SIGINT, self._on_sigint)
            return prev
        except Exception:  # pragma: no cover - non-main thread
            return None

    def _restore_signal(self, prev) -> None:
        if prev is None or not self.install_signal_handler:
            return
        try:
            signal.signal(signal.SIGINT, prev)
        except Exception:  # pragma: no cover
            return

    @property
    def first_sigint_received(self) -> bool:
        return self._sigint_count >= 1

    def receive_sigint_for_test(self) -> None:
        """测试 helper — 模拟一次 SIGINT 不依赖真实信号."""
        self._sigint_count += 1

    # ------------------------------------------------------------
    # Resume / checkpoint
    # ------------------------------------------------------------

    def _read_resume_floor(self) -> Optional[int]:
        """读 ``resume_from`` 或 checkpoint, 返回 internal_id 下限 (含此值不跑)."""
        if self.resume_from is not None:
            return self.resume_from
        try:
            store = self.cli.sync_store
        except Exception:
            return None
        row = store.get_cli_checkpoint(self.command, self.target_key)
        if not row or row.get("aborted_at") is None:
            # 没 checkpoint 或上次干净结束 — 不 resume
            return None
        last = row.get("last_completed_internal_id")
        return int(last) + 1 if last is not None else None

    def _write_checkpoint(
        self,
        *,
        last_completed: Optional[int],
        succeeded: int,
        failed: int,
        aborted_at: Optional[float] = None,
    ) -> None:
        try:
            store = self.cli.sync_store
        except Exception:
            return
        try:
            store.upsert_cli_checkpoint(
                command=self.command,
                target_kind=self.target_kind,
                target_key=self.target_key,
                last_completed_internal_id=last_completed,
                succeeded=succeeded,
                failed=failed,
                aborted_at=aborted_at,
                payload=self.payload,
            )
        except Exception as exc:  # pragma: no cover - 写 checkpoint 失败不影响主流程
            print(
                f"[long-task] WARN: checkpoint write failed: "
                f"{type(exc).__name__}: {exc}",
                file=sys.stderr,
            )

    def _clear_checkpoint_on_success(self) -> None:
        try:
            store = self.cli.sync_store
        except Exception:
            return
        try:
            store.delete_cli_checkpoint(self.command, self.target_key)
        except Exception:  # pragma: no cover
            return

    # ------------------------------------------------------------
    # 主执行流程
    # ------------------------------------------------------------

    def run(
        self,
        units: Iterable[UnitItem],
        *,
        dry_run: bool = False,
    ) -> Tuple[List[UnitResult], LongTaskSummary]:
        """执行一组 unit, 返回 (results, summary).

        caller 拿到结果后自行 ``emit_results_and_exit``.
        """
        resume_floor = self._read_resume_floor()
        units_list = list(units)
        if resume_floor is not None:
            units_list = [(iid, fn) for iid, fn in units_list if iid >= resume_floor]

        prev_handler = self._install_signal()
        summary = LongTaskSummary(total=len(units_list))
        results: List[UnitResult] = []
        is_ndjson = self.cli.output.lower() == "ndjson"

        try:
            for idx, (internal_id, fn) in enumerate(units_list):
                t0 = time.monotonic()
                try:
                    data = fn()
                    dur = int((time.monotonic() - t0) * 1000)
                    res = UnitResult(
                        internal_id=internal_id,
                        status="success",
                        duration_ms=dur,
                        data=data,
                    )
                    self._consecutive_failures = 0
                    summary.succeeded += 1
                except CliError as exc:
                    dur = int((time.monotonic() - t0) * 1000)
                    res = UnitResult(
                        internal_id=internal_id,
                        status="failed",
                        duration_ms=dur,
                        error_code=exc.code,
                        error_message=exc.message,
                    )
                    self._consecutive_failures += 1
                    summary.failed += 1
                except Exception as exc:  # noqa: BLE001 — caller-domain failures
                    dur = int((time.monotonic() - t0) * 1000)
                    res = UnitResult(
                        internal_id=internal_id,
                        status="failed",
                        duration_ms=dur,
                        error_code="E_INTERNAL",
                        error_message=f"{type(exc).__name__}: {exc}",
                    )
                    self._consecutive_failures += 1
                    summary.failed += 1

                results.append(res)

                if is_ndjson:
                    self._emit_ndjson_line(res)
                else:
                    self._maybe_print_progress(idx + 1, summary, res)

                # checkpoint
                if (
                    self.checkpoint_every > 0
                    and (idx + 1) % self.checkpoint_every == 0
                    and not dry_run
                ):
                    self._write_checkpoint(
                        last_completed=internal_id,
                        succeeded=summary.succeeded,
                        failed=summary.failed,
                    )

                # max-failures 熔断
                if (
                    self.max_failures > 0
                    and self._consecutive_failures >= self.max_failures
                ):
                    summary.max_failures_hit = True
                    summary.aborted = True
                    summary.aborted_reason = (
                        f"Hit --max-failures={self.max_failures} "
                        f"after {self._consecutive_failures} consecutive failures"
                    )
                    if not dry_run:
                        self._write_checkpoint(
                            last_completed=internal_id,
                            succeeded=summary.succeeded,
                            failed=summary.failed,
                            aborted_at=time.time(),
                        )
                    break

                # SIGINT first — 当前 unit 已跑完, exit 7
                if self.first_sigint_received:
                    summary.aborted = True
                    summary.aborted_reason = "SIGINT received (gracefully aborted)"
                    if not dry_run:
                        self._write_checkpoint(
                            last_completed=internal_id,
                            succeeded=summary.succeeded,
                            failed=summary.failed,
                            aborted_at=time.time(),
                        )
                    break

            # 全部跑完且没中断 → 清 checkpoint (避免下次 resume 到老记录)
            if not summary.aborted and not dry_run:
                self._clear_checkpoint_on_success()

        finally:
            self._restore_signal(prev_handler)

        summary.exit_code = self._derive_exit_code(summary)
        return results, summary

    def _maybe_print_progress(
        self, done: int, summary: LongTaskSummary, last: UnitResult,
    ) -> None:
        if self.cli.output.lower() != "text":
            return
        if self.progress_every <= 0:
            return
        if done % self.progress_every != 0 and done != summary.total:
            return
        pct = (done / summary.total * 100) if summary.total else 100.0
        marker = "✓" if last.status == "success" else "✗"
        print(
            f"[long-task] {marker} {last.internal_id} | "
            f"{done}/{summary.total} ({pct:.0f}%) | "
            f"ok={summary.succeeded} fail={summary.failed}",
            file=sys.stderr,
        )

    def _emit_ndjson_line(self, res: UnitResult) -> None:
        line: dict[str, Any] = {
            "internal_id": res.internal_id,
            "status": res.status,
            "duration_ms": res.duration_ms,
        }
        if res.error_code:
            line["error"] = {
                "code": res.error_code,
                "message": res.error_message,
            }
        if res.data:
            line["data"] = res.data
        print(json.dumps(line, ensure_ascii=False))

    def _derive_exit_code(self, summary: LongTaskSummary) -> int:
        """RFC §5.2 退出码体系:
            0  全 OK (失败=0)
            6  partial_failure (有 succ + 有 fail, 非熔断)
            7  SIGINT first → aborted
            8  max-failures 熔断
            9  PM2 conflict — 在 caller 调本类之前已 raise, 这里不命中
            130 SIGINT second — sys.exit 直接退, 这里不命中
        """
        if summary.max_failures_hit:
            return 8
        if summary.aborted:
            return 7
        if summary.failed > 0:
            return 6 if summary.succeeded > 0 else 1
        return 0


# ============================================================
# 输出 helper — caller 拿 results + summary, 调本函数 emit + raise
# ============================================================

def emit_long_task_results(
    cli: "CliContext",
    results: List[UnitResult],
    summary: LongTaskSummary,
    *,
    extra_meta: Optional[dict] = None,
) -> "typer.Exit":
    """根据 ``cli.output`` 渲染 results + summary, 返回 ``typer.Exit``.

    text / json / yaml: 单次 wrapper, status='success' / 'partial_failure' / 'error'
    ndjson: 每行已在 LongTaskContext.run 中 emit, 这里只追加 _meta
    """
    succ = [
        {
            "internal_id": r.internal_id,
            "duration_ms": r.duration_ms,
            **(r.data or {}),
        }
        for r in results if r.status == "success"
    ]
    fail = [
        {
            "internal_id": r.internal_id,
            "duration_ms": r.duration_ms,
            "error": {"code": r.error_code, "message": r.error_message},
        }
        for r in results if r.status == "failed"
    ]

    meta = {"duration_ms": cli.elapsed_ms()}
    if extra_meta:
        meta.update(extra_meta)
    meta["aborted_by"] = summary.aborted_reason if summary.aborted else None

    if cli.output.lower() == "ndjson":
        meta.update(summary.as_dict())
        print(json.dumps({"_meta": meta}, ensure_ascii=False))
        return typer.Exit(code=summary.exit_code)

    # text / json / yaml: 单 wrapper
    status_field = _status_for_summary(summary)

    data = {
        "succeeded": succ,
        "failed": fail,
        "summary": summary.as_dict(),
    }

    if cli.output.lower() in ("json", "yaml"):
        wrapper = {
            "status": status_field,
            "schema_version": 1,
            "data": data,
            "meta": meta,
        }
        if cli.output.lower() == "json":
            print(json.dumps(wrapper, ensure_ascii=False))
        else:
            import yaml

            yaml.safe_dump(
                json.loads(json.dumps(wrapper)),
                sys.stdout, allow_unicode=True, sort_keys=False,
            )
    else:
        # text
        for s in succ:
            print(f"  ✓ {s['internal_id']} ({s.get('duration_ms', 0)}ms)")
        for f in fail:
            print(
                f"  ✗ {f['internal_id']} ({f['duration_ms']}ms) "
                f"[{f['error']['code']}] {f['error']['message']}",
                file=sys.stderr,
            )
        s_dict = summary.as_dict()
        line = (
            f"[long-task] total={s_dict['total']} "
            f"succeeded={s_dict['succeeded']} "
            f"failed={s_dict['failed']} "
            f"skipped={s_dict['skipped']}"
        )
        if s_dict["aborted"]:
            line += f" aborted={s_dict['aborted_reason']!r}"
        print(line, file=sys.stderr)

    return typer.Exit(code=summary.exit_code)


def _status_for_summary(summary: LongTaskSummary) -> str:
    if summary.max_failures_hit:
        return "error"
    if summary.aborted:
        return "error"
    if summary.failed > 0 and summary.succeeded > 0:
        return "partial_failure"
    if summary.failed > 0:
        return "error"
    return "success"
