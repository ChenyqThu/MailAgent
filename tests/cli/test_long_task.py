"""LongTaskContext unit tests (PR-4 US-002 / RFC §5.2).

Covers:
- All-success exit 0
- Partial failure exit 6
- Max-failures exit 8
- SIGINT first → exit 7 (mock via receive_sigint_for_test)
- Checkpoint UPSERT + resume_from skip
- Progress emission in ndjson stream
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.cli.context import CliContext
from src.cli.exceptions import CliInvalidArgError
from src.cli.long_task import (
    LongTaskContext,
    UnitResult,
    emit_long_task_results,
)
from src.mail.sync_store import SyncStore


@pytest.fixture
def store(tmp_path: Path) -> SyncStore:
    db = tmp_path / "s.db"
    return SyncStore(str(db))


@pytest.fixture
def cli(store: SyncStore, tmp_path: Path) -> CliContext:
    ctx = CliContext.from_flags(db_path=str(store.db_path))
    ctx._sync_store = store
    return ctx


def _ok_unit(payload=None):
    return lambda: payload or {"ok": True}


def _fail_unit(exc=None):
    def _inner():
        raise exc or RuntimeError("boom")
    return _inner


def test_all_success_exit_0(cli):
    ltc = LongTaskContext(
        cli=cli,
        command="test-cmd",
        target_kind="ids",
        target_key="all-ok",
        install_signal_handler=False,
    )
    units = [
        (1, _ok_unit({"id": 1})),
        (2, _ok_unit({"id": 2})),
        (3, _ok_unit({"id": 3})),
    ]
    results, summary = ltc.run(units)
    assert summary.exit_code == 0
    assert summary.succeeded == 3
    assert summary.failed == 0
    assert summary.aborted is False
    assert all(r.status == "success" for r in results)


def test_partial_failure_exit_6(cli):
    ltc = LongTaskContext(
        cli=cli,
        command="test-cmd",
        target_kind="ids",
        target_key="partial",
        install_signal_handler=False,
        max_failures=0,  # 不熔断
    )
    units = [
        (1, _ok_unit()),
        (2, _fail_unit(RuntimeError("network"))),
        (3, _ok_unit()),
        (4, _fail_unit(ValueError("schema"))),
        (5, _ok_unit()),
    ]
    results, summary = ltc.run(units)
    assert summary.exit_code == 6
    assert summary.succeeded == 3
    assert summary.failed == 2

    failed_internal_ids = [r.internal_id for r in results if r.status == "failed"]
    assert failed_internal_ids == [2, 4]


def test_all_failed_exit_1(cli):
    ltc = LongTaskContext(
        cli=cli,
        command="test-cmd",
        target_kind="ids",
        target_key="all-fail",
        install_signal_handler=False,
        max_failures=0,
    )
    units = [
        (1, _fail_unit()),
        (2, _fail_unit()),
    ]
    _, summary = ltc.run(units)
    assert summary.failed == 2
    assert summary.succeeded == 0
    assert summary.exit_code == 1


def test_max_failures_exit_8(cli):
    ltc = LongTaskContext(
        cli=cli,
        command="test-cmd",
        target_kind="ids",
        target_key="max-fail",
        install_signal_handler=False,
        max_failures=3,
    )
    units = [
        (1, _ok_unit()),
        (2, _fail_unit()),
        (3, _fail_unit()),
        (4, _fail_unit()),  # 第 3 次连续失败, 熔断
        (5, _ok_unit()),     # 应不跑
        (6, _ok_unit()),
    ]
    results, summary = ltc.run(units)
    assert summary.exit_code == 8
    assert summary.max_failures_hit is True
    assert summary.aborted is True
    assert summary.failed == 3
    assert summary.succeeded == 1
    assert len(results) == 4  # 5/6 没跑


def test_max_failures_resets_on_success(cli):
    """连续失败计数 succ 后归零."""
    ltc = LongTaskContext(
        cli=cli,
        command="test-cmd",
        target_kind="ids",
        target_key="reset",
        install_signal_handler=False,
        max_failures=3,
    )
    units = [
        (1, _fail_unit()),
        (2, _fail_unit()),
        (3, _ok_unit()),     # reset 连续计数
        (4, _fail_unit()),
        (5, _fail_unit()),
        (6, _ok_unit()),     # reset 再 reset
    ]
    _, summary = ltc.run(units)
    # 总失败 4, 但没有连续 3 次 fail, 不熔断
    assert summary.exit_code == 6
    assert summary.max_failures_hit is False
    assert summary.failed == 4
    assert summary.succeeded == 2


def test_sigint_first_exit_7(cli):
    """SIGINT first received → 当前 unit 跑完后 break, exit 7."""
    ltc = LongTaskContext(
        cli=cli,
        command="test-cmd",
        target_kind="ids",
        target_key="sigint",
        install_signal_handler=False,
    )

    def _ok_then_sigint(idx):
        def _inner():
            if idx == 2:
                ltc.receive_sigint_for_test()
            return {"id": idx}
        return _inner

    units = [(i, _ok_then_sigint(i)) for i in range(1, 5)]
    _, summary = ltc.run(units)
    assert summary.exit_code == 7
    assert summary.aborted is True
    # SIGINT 在 unit 2 内被注入; 当前 unit 跑完 (succ), 然后 break
    assert summary.succeeded == 2  # unit 1 + 2
    assert summary.failed == 0


def test_checkpoint_upsert_on_abort(cli, store):
    ltc = LongTaskContext(
        cli=cli,
        command="email-resync",
        target_kind="range",
        target_key="200-300",
        install_signal_handler=False,
        max_failures=2,
        checkpoint_every=100,  # 不写中途 checkpoint
        payload={"mailbox": "收件箱"},
    )
    units = [
        (200, _ok_unit()),
        (201, _fail_unit()),
        (202, _fail_unit()),  # 熔断
        (203, _ok_unit()),
    ]
    _, summary = ltc.run(units)
    assert summary.exit_code == 8
    cp = store.get_cli_checkpoint("email-resync", "200-300")
    assert cp is not None
    assert cp["last_completed_internal_id"] == 202
    assert cp["succeeded"] == 1
    assert cp["failed"] == 2
    assert cp["aborted_at"] is not None
    import json as _json
    assert _json.loads(cp["payload"])["mailbox"] == "收件箱"


def test_checkpoint_cleared_on_clean_finish(cli, store):
    ltc = LongTaskContext(
        cli=cli,
        command="email-resync",
        target_kind="range",
        target_key="100-105",
        install_signal_handler=False,
    )
    # 先预置一个 checkpoint, 跑完后应被删
    store.upsert_cli_checkpoint(
        command="email-resync",
        target_kind="range",
        target_key="100-105",
        last_completed_internal_id=99,
        succeeded=0,
        failed=0,
    )
    units = [(i, _ok_unit()) for i in range(100, 106)]
    _, summary = ltc.run(units)
    assert summary.exit_code == 0
    # 干净结束 → checkpoint 应被删
    assert store.get_cli_checkpoint("email-resync", "100-105") is None


def test_resume_from_skips_lower_ids(cli):
    ltc = LongTaskContext(
        cli=cli,
        command="test-cmd",
        target_kind="range",
        target_key="resume",
        install_signal_handler=False,
        resume_from=3,
    )
    units = [(i, _ok_unit({"id": i})) for i in range(1, 6)]
    results, summary = ltc.run(units)
    assert [r.internal_id for r in results] == [3, 4, 5]
    assert summary.total == 3
    assert summary.succeeded == 3


def test_resume_from_via_checkpoint(cli, store):
    """无 resume_from 但 cli_checkpoints 有 aborted_at 行 → 从 last+1 续跑."""
    store.upsert_cli_checkpoint(
        command="test-cmd",
        target_kind="range",
        target_key="auto-resume",
        last_completed_internal_id=2,
        succeeded=2,
        failed=0,
        aborted_at=1000.0,
    )
    ltc = LongTaskContext(
        cli=cli,
        command="test-cmd",
        target_kind="range",
        target_key="auto-resume",
        install_signal_handler=False,
    )
    units = [(i, _ok_unit({"id": i})) for i in range(1, 6)]
    results, _summary = ltc.run(units)
    # last_completed=2, resume from 3
    assert [r.internal_id for r in results] == [3, 4, 5]


def test_resume_skipped_if_clean(cli, store):
    """checkpoint 但 aborted_at IS NULL → 不 resume (上次干净结束)."""
    store.upsert_cli_checkpoint(
        command="test-cmd",
        target_kind="range",
        target_key="clean-prev",
        last_completed_internal_id=2,
        succeeded=2,
        failed=0,
        aborted_at=None,
    )
    ltc = LongTaskContext(
        cli=cli,
        command="test-cmd",
        target_kind="range",
        target_key="clean-prev",
        install_signal_handler=False,
    )
    units = [(i, _ok_unit({"id": i})) for i in range(1, 6)]
    results, _ = ltc.run(units)
    # 全跑, 不 resume
    assert [r.internal_id for r in results] == [1, 2, 3, 4, 5]


def test_unit_clierror_records_error_code(cli):
    """CliError 子类 → 保留 .code."""
    ltc = LongTaskContext(
        cli=cli,
        command="test-cmd",
        target_kind="ids",
        target_key="clierror",
        install_signal_handler=False,
    )
    units = [
        (1, _ok_unit()),
        (2, _fail_unit(CliInvalidArgError("bad arg"))),
    ]
    results, summary = ltc.run(units)
    assert summary.failed == 1
    fail_res = [r for r in results if r.status == "failed"][0]
    assert fail_res.error_code == "E_INVALID_ARG"
    assert "bad arg" in fail_res.error_message


def test_ndjson_stream_emits_per_unit(cli, capsys):
    cli.output = "ndjson"
    ltc = LongTaskContext(
        cli=cli,
        command="test-cmd",
        target_kind="ids",
        target_key="ndjson",
        install_signal_handler=False,
    )
    units = [
        (10, _ok_unit({"page_id": "abc"})),
        (11, _fail_unit(RuntimeError("err"))),
    ]
    results, summary = ltc.run(units)
    out = capsys.readouterr().out
    lines = [json.loads(line) for line in out.strip().splitlines() if line.startswith("{")]
    assert len(lines) == 2
    assert lines[0]["internal_id"] == 10
    assert lines[0]["status"] == "success"
    assert lines[1]["status"] == "failed"
    assert lines[1]["error"]["code"] == "E_INTERNAL"

    # emit_long_task_results 末尾 _meta
    capsys.readouterr()  # 清掉 buffer
    try:
        emit_long_task_results(cli, results, summary)
    except SystemExit:
        pass
    except Exception:
        pass
    out2 = capsys.readouterr().out
    meta_lines = [
        json.loads(line) for line in out2.strip().splitlines()
        if line.startswith("{") and "_meta" in line
    ]
    assert meta_lines[-1]["_meta"]["total"] == 2
    assert meta_lines[-1]["_meta"]["succeeded"] == 1
    assert meta_lines[-1]["_meta"]["failed"] == 1


def test_emit_json_wrapper_partial_failure(cli, capsys):
    cli.output = "json"
    summary_fake = type("S", (), {})()
    from src.cli.long_task import LongTaskSummary

    summary = LongTaskSummary(
        total=2, succeeded=1, failed=1,
    )
    summary.exit_code = 6
    results = [
        UnitResult(internal_id=1, status="success", duration_ms=10, data={"page_id": "p1"}),
        UnitResult(
            internal_id=2, status="failed", duration_ms=20,
            error_code="E_NOT_FOUND", error_message="missing",
        ),
    ]
    try:
        emit_long_task_results(cli, results, summary)
    except (SystemExit, Exception):
        pass
    out = capsys.readouterr().out
    payload = None
    for line in out.strip().splitlines():
        if line.startswith("{"):
            payload = json.loads(line)
    assert payload is not None
    assert payload["status"] == "partial_failure"
    assert payload["data"]["summary"]["total"] == 2
    assert len(payload["data"]["succeeded"]) == 1
    assert len(payload["data"]["failed"]) == 1
    assert payload["data"]["failed"][0]["error"]["code"] == "E_NOT_FOUND"
