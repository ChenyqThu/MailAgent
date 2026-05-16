"""docs/cli-schema/ ↔ 实际 CLI JSON 输出 契约一致性 (PR-2 critic round 3 follow-up).

每次 CLI emit 的 wrapper 必须能被对应 schema 验证。 防止 schema 文件偏离 emit() 真实行为
(round-3 bug 就是 email resync emit 了 archived_page_id 但 schema additionalProperties:false 拒之)。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest


SCHEMA_DIR = Path(__file__).resolve().parents[2] / "docs" / "cli-schema"


@pytest.fixture
def schema_loader():
    """Return a callable that loads a schema by filename + injects ``_common`` $defs.

    我们的 schema 用 ``$ref: _common.schema.json#/$defs/...``。jsonschema 默认不解析
    跨文件 $ref, 这里手动把 _common 注册进 RegistryResolver。
    """
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


class TestSchemaContract:
    """每个 leaf 命令的实际 -o json 输出走 jsonschema 验证."""

    def test_email_get_success_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "email", "get", "12345", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("email-get.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_email_list_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "email", "list", "--limit", "5", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("email-list.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_email_search_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "email", "search", "redis", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("email-search.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_email_body_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "email", "body", "12345",
                         "--format", "markdown", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("email-body.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_email_resync_dry_run_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "email", "resync", "12345", "--dry-run",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("email-resync.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_admin_health_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "admin", "health", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("admin-health.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_admin_db_version_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "admin", "db-version", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("admin-db-version.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_admin_stats_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "admin", "stats", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("admin-stats.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    # ============================================================
    # PR-3 US-001: attachment list / download / derive
    # ============================================================

    def test_attachment_list_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "attachment", "list", "12345", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("attachment-list.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_attachment_list_not_found_matches_error_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "attachment", "list", "99999",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 1
        payload = _last_json(result.output)
        schema, registry = schema_loader("attachment-list.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_attachment_download_with_dest_matches_schema(
        self, cli_runner, seeded_db_with_real_attachment,
        monkeypatch, tmp_path, schema_loader,
    ):
        from jsonschema import validate

        db_path, _, att_id = seeded_db_with_real_attachment
        monkeypatch.setenv("NOTION_TOKEN", "x")
        monkeypatch.setenv("EMAIL_DATABASE_ID", "y")
        monkeypatch.setenv("USER_EMAIL", "t@example.com")
        monkeypatch.setenv("MAIL_ACCOUNT_NAME", "t")
        dest = tmp_path / "outdir" / "x.bin"
        dest.parent.mkdir()
        result = _invoke(cli_runner, "attachment", "download", str(att_id),
                         "--dest", str(dest), "-o", "json", db_path=db_path)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("attachment-download.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_attachment_derive_dry_run_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "attachment", "derive", "12345",
                         "--dry-run", "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("attachment-derive.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    # ============================================================
    # PR-3 US-002: attachment cleanup-orphans
    # ============================================================

    def test_attachment_cleanup_orphans_matches_schema(
        self, cli_runner, cli_env, seeded_db, monkeypatch, tmp_path, schema_loader,
    ):
        from jsonschema import validate

        monkeypatch.setenv("ATTACHMENT_STORAGE_DIR", str(tmp_path / "att-co"))
        result = _invoke(cli_runner, "attachment", "cleanup-orphans",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader(
            "attachment-cleanup-orphans.schema.json"
        )
        validate(instance=payload, schema=schema, registry=registry)

    # ============================================================
    # PR-3 US-003 / US-004: llm
    # ============================================================

    def test_llm_run_dry_run_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader, monkeypatch,
    ):
        from jsonschema import validate
        from src.llm_agent import runner as runner_mod

        async def fake_run(self, internal_id, *, dry_run=False, overwrite=True,
                           force=False):
            return {
                "ok": True, "internal_id": internal_id, "page_id": "p",
                "mailbox": "收件箱", "dry_run": dry_run, "labels": {"x": 1},
            }

        async def fake_close(self):
            return None

        def safe_init(self, *args, **kwargs):
            self._processor = None
            self._writer = None
            self._store = None
            self._arm = None
            self._reader = None

        monkeypatch.setattr(runner_mod.LLMRunner, "__init__", safe_init)
        monkeypatch.setattr(runner_mod.LLMRunner, "run_for_internal_id", fake_run)
        monkeypatch.setattr(runner_mod.LLMRunner, "close", fake_close)

        result = _invoke(cli_runner, "llm", "run", "12345", "--dry-run",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("llm-run.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_llm_selftest_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader, monkeypatch,
    ):
        from jsonschema import validate

        monkeypatch.setenv("LLM_API_KEY", "k")
        monkeypatch.setenv("LLM_API_BASE", "https://e")
        monkeypatch.setenv("LLM_MODEL", "m")
        result = _invoke(cli_runner, "llm", "selftest", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("llm-selftest.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_llm_retry_failed_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "llm", "retry-failed", "--dry-run",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("llm-retry-failed.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_llm_stats_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "llm", "stats", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("llm-stats.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_llm_compare_paths_dry_run_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "llm", "compare-paths", "--count", "10",
                         "--dry-run", "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("llm-compare-paths.schema.json")
        validate(instance=payload, schema=schema, registry=registry)


from tests.cli.conftest import extract_last_json_object as _last_json  # noqa: E402
