"""PR-4 新 schema contract tests (US-011).

每个 PR-4 新加的 CLI -o json 输出走 jsonschema 验证, 抓 emit ↔ schema 漂移.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.project_progress.runner import SyncSummary
from tests.cli.conftest import extract_last_json_object as _last_json


SCHEMA_DIR = Path(__file__).resolve().parents[2] / "docs" / "cli-schema"


@pytest.fixture
def schema_loader():
    from referencing import Registry, Resource
    from referencing.jsonschema import DRAFT202012

    common_path = SCHEMA_DIR / "_common.schema.json"
    common_doc = json.loads(common_path.read_text())
    common_resource = Resource(contents=common_doc, specification=DRAFT202012)
    registry = Registry().with_resource(
        uri="_common.schema.json", resource=common_resource,
    )

    def _load(name: str) -> tuple[dict, Registry]:
        schema = json.loads((SCHEMA_DIR / name).read_text())
        return schema, registry

    return _load


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app
    return cli_runner.invoke(app, ["--db-path", str(db_path), *args])


def _fake_run(returncode=0, stdout="ok", stderr=""):
    cap = {"args": None}

    def _r(cmd, **kw):
        cap["args"] = cmd
        return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)
    return _r, cap


class TestPR4SchemaContract:
    """PR-4 新 schema 与实际 CLI -o json 输出一致性 (US-011)."""

    # ---- email resync batch ----

    def test_email_resync_batch_dry_run(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(
            cli_runner, "email", "resync", "--range", "12345-12346",
            "--dry-run", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("email-resync-batch.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    # ---- backfill ----

    def test_backfill_body_dry_run(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(
            cli_runner, "backfill", "body", "--dry-run", "--limit", "5",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("backfill-body.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_backfill_derivatives_dry_run(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(
            cli_runner, "backfill", "derivatives", "--dry-run",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0
        payload = _last_json(result.output)
        schema, registry = schema_loader("backfill-derivatives.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    # ---- project-progress ----

    def test_project_progress_sync_dry_run(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        mock_runner = MagicMock()
        mock_runner.sync_from_email = AsyncMock(return_value=SyncSummary(
            internal_id=1,
            status="completed",
            week_tag="2026-W19",
            dry_run=True,
        ))
        with patch(
            "src.cli.commands.project_progress.ProjectProgressRunner",
            return_value=mock_runner,
        ):
            result = _invoke(
                cli_runner, "project-progress", "sync",
                "--internal-id", "1", "--dry-run",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        payload = _last_json(result.output)
        schema, registry = schema_loader("project-progress-sync.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    # ---- init ----

    @pytest.mark.parametrize("subcmd,schema_name", [
        ("fetch-cache", "init-fetch-cache.schema.json"),
        ("analyze", "init-analyze.schema.json"),
    ])
    def test_init_read_actions(
        self, cli_runner, cli_env, seeded_db, schema_loader, subcmd, schema_name,
    ):
        from jsonschema import validate

        run, _ = _fake_run(0)
        with patch("src.cli.commands.init.subprocess.run", run):
            result = _invoke(
                cli_runner, "init", subcmd, "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader(schema_name)
        validate(instance=payload, schema=schema, registry=registry)

    @pytest.mark.parametrize("subcmd,schema_name", [
        ("fix-properties", "init-fix-properties.schema.json"),
        ("fix-critical", "init-fix-critical.schema.json"),
        ("update-parents", "init-update-parents.schema.json"),
        ("sync-new", "init-sync-new.schema.json"),
    ])
    def test_init_write_actions(
        self, cli_runner, cli_env, seeded_db, schema_loader,
        subcmd, schema_name, monkeypatch,
    ):
        from jsonschema import validate

        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        run, _ = _fake_run(0)
        with patch("src.cli.commands.init.subprocess.run", run):
            result = _invoke(
                cli_runner, "init", subcmd, "--yes",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        payload = _last_json(result.output)
        schema, registry = schema_loader(schema_name)
        validate(instance=payload, schema=schema, registry=registry)

    def test_init_all(self, cli_runner, cli_env, seeded_db, schema_loader, monkeypatch):
        from jsonschema import validate

        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        run, _ = _fake_run(0)
        with patch("src.cli.commands.init.subprocess.run", run):
            result = _invoke(
                cli_runner, "init", "all", "--yes", "--inbox-count", "10",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        payload = _last_json(result.output)
        schema, registry = schema_loader("init-all.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    # ---- admin dead-letter ----

    def test_admin_dead_letter_list_empty(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(
            cli_runner, "admin", "dead-letter", "list",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0
        payload = _last_json(result.output)
        schema, registry = schema_loader("admin-dead-letter.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    # ---- admin cleanup ----

    def test_admin_cleanup_deadletter_dry_run(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(
            cli_runner, "admin", "cleanup-deadletter",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0
        payload = _last_json(result.output)
        schema, registry = schema_loader("admin-cleanup.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_admin_cleanup_syncstore_dry_run(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        run, _ = _fake_run(0)
        with patch("src.cli.commands.admin.subprocess.run", run):
            result = _invoke(
                cli_runner, "admin", "cleanup-syncstore",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        payload = _last_json(result.output)
        schema, registry = schema_loader("admin-cleanup.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_admin_repair_parents_dry_run(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        run, _ = _fake_run(0)
        with patch("src.cli.commands.admin.subprocess.run", run):
            result = _invoke(
                cli_runner, "admin", "repair-parents",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        payload = _last_json(result.output)
        schema, registry = schema_loader("admin-repair-parents.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    # ---- admin stats v4_rollout ----

    def test_admin_stats_v4_rollout_section(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(
            cli_runner, "admin", "stats", "--section", "v4_rollout",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0
        payload = _last_json(result.output)
        schema, registry = schema_loader("admin-stats-v4-rollout.schema.json")
        validate(instance=payload, schema=schema, registry=registry)
