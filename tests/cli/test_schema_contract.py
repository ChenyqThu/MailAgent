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


def _last_json(text: str) -> dict:
    for line in reversed(text.strip().splitlines()):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    raise AssertionError(f"no JSON in output: {text[:300]!r}")
