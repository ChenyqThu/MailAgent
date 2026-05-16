"""Long task e2e tests (PR-4 US-010).

Covers RFC §5.2 退出码 branches not already covered in test_long_task.py:
- exit 130 (second SIGINT in run() inner) — direct sys.exit injection
- Checkpoint resume e2e: abort → resume new run → only remaining ids run
- ndjson stream + final _meta line
- partial_failure wrapper schema validation (PR-4 §2.6)
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.cli.context import CliContext
from src.cli.long_task import LongTaskContext, emit_long_task_results
from src.mail.sync_store import SyncStore


@pytest.fixture
def store(tmp_path: Path) -> SyncStore:
    return SyncStore(str(tmp_path / "s.db"))


@pytest.fixture
def cli(store: SyncStore) -> CliContext:
    ctx = CliContext.from_flags(db_path=str(store.db_path))
    ctx._sync_store = store
    return ctx


def test_sigint_second_immediate_exit_130(cli, monkeypatch):
    """SIGINT 二次 → sys.exit(130) 在 _on_sigint 内直接退."""
    ltc = LongTaskContext(
        cli=cli,
        command="test", target_kind="ids", target_key="sigint-2x",
        install_signal_handler=False,
    )
    # 模拟两次 signal — 第二次应直接 sys.exit(130)
    ltc._sigint_count = 1  # 假设已收到一次
    with pytest.raises(SystemExit) as e:
        ltc._on_sigint(None, None)
    assert e.value.code == 130


def test_checkpoint_resume_e2e(cli, store):
    """跑到一半 abort → 新 LongTaskContext 用同 PK 续跑剩余."""
    # 第一次跑: 跑 3 个 unit, 第 3 个之后 abort
    units_v1 = []
    for i in (1, 2, 3, 4, 5):
        units_v1.append((i, lambda v=i: {"v": v}))

    ltc1 = LongTaskContext(
        cli=cli,
        command="resync", target_kind="range", target_key="1-5",
        install_signal_handler=False,
        checkpoint_every=2,  # 每 2 unit 写 checkpoint
        max_failures=0,
    )

    # 在第 3 unit 后注入 sigint
    runs = []

    def _unit(idx):
        def _inner():
            runs.append(idx)
            if idx == 3:
                ltc1.receive_sigint_for_test()
            return {"v": idx}
        return _inner

    units_v1 = [(i, _unit(i)) for i in (1, 2, 3, 4, 5)]
    _, summary1 = ltc1.run(units_v1)
    assert summary1.exit_code == 7
    assert runs == [1, 2, 3]  # unit 4/5 未跑

    cp = store.get_cli_checkpoint("resync", "1-5")
    assert cp is not None
    assert cp["last_completed_internal_id"] == 3
    assert cp["aborted_at"] is not None

    # 第二次: 同 PK, 不传 resume_from → 应自动从 checkpoint resume
    runs2 = []
    ltc2 = LongTaskContext(
        cli=cli,
        command="resync", target_kind="range", target_key="1-5",
        install_signal_handler=False,
    )
    units_v2 = [(i, lambda v=i, _r=runs2: _r.append(v) or {"v": v})
                for i in (1, 2, 3, 4, 5)]
    _, summary2 = ltc2.run(units_v2)
    assert summary2.exit_code == 0
    # resume from last_completed+1=4
    assert runs2 == [4, 5]
    # 清 checkpoint
    assert store.get_cli_checkpoint("resync", "1-5") is None


def test_partial_failure_wrapper_validates_against_schema(cli, capsys):
    """PR-4 §2.6: partial_failure 输出符合 email-resync-batch.schema.json."""
    from jsonschema import validate
    from referencing import Registry, Resource
    from referencing.jsonschema import DRAFT202012

    cli.output = "json"
    ltc = LongTaskContext(
        cli=cli,
        command="resync", target_kind="ids", target_key="schema-test",
        install_signal_handler=False,
        max_failures=0,
    )

    def _fail():
        raise RuntimeError("boom")

    units = [
        (1, lambda: {"page_id": "p1", "action": "created"}),
        (2, _fail),
        (3, lambda: {"page_id": "p3", "action": "created"}),
    ]
    results, summary = ltc.run(units)
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
    assert payload["data"]["summary"]["succeeded"] == 2
    assert payload["data"]["summary"]["failed"] == 1

    # Schema validate
    schema_dir = Path(__file__).resolve().parents[2] / "docs" / "cli-schema"
    common = json.loads((schema_dir / "_common.schema.json").read_text())
    schema = json.loads((schema_dir / "email-resync-batch.schema.json").read_text())
    registry = Registry().with_resource(
        uri="_common.schema.json",
        resource=Resource(contents=common, specification=DRAFT202012),
    )
    validate(instance=payload, schema=schema, registry=registry)


def test_ndjson_per_unit_plus_meta(cli, capsys):
    """ndjson: 每 unit 一行 + 末尾 _meta."""
    cli.output = "ndjson"
    ltc = LongTaskContext(
        cli=cli,
        command="t", target_kind="ids", target_key="ndjson-e2e",
        install_signal_handler=False,
    )
    units = [
        (1, lambda: {"x": 1}),
        (2, lambda: {"x": 2}),
    ]
    results, summary = ltc.run(units)
    try:
        emit_long_task_results(cli, results, summary)
    except (SystemExit, Exception):
        pass
    out = capsys.readouterr().out
    lines = [json.loads(line) for line in out.strip().splitlines() if line.startswith("{")]
    # 2 unit lines + 1 _meta line
    assert len(lines) == 3
    assert "_meta" in lines[-1]
    assert lines[-1]["_meta"]["total"] == 2
    assert lines[-1]["_meta"]["succeeded"] == 2


def test_pm2_check_via_subprocess_mock():
    """pm2_check 直接调 → mock subprocess.run 返回 online → CliPM2ConflictError."""
    from src.cli.exceptions import CliPM2ConflictError
    from src.cli.pm2_check import check_pm2_conflict
    from types import SimpleNamespace

    def fake_run(*args, **kwargs):
        return SimpleNamespace(
            stdout=json.dumps([
                {"name": "mail-sync", "pm2_env": {"status": "online"}}
            ]),
            returncode=0,
        )

    with pytest.raises(CliPM2ConflictError) as ei:
        check_pm2_conflict(cli=None, runner=fake_run)
    assert ei.value.exit_code == 9
