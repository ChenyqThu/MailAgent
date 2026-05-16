"""PR-2 critic round 4 follow-ups (PR-3 US-009):

1. email resync 非 dry-run mock 测试 (created / replaced / archive-failure 三场景).
2. NDJSON contract: email list -o ndjson + email search -o ndjson 末行 _meta,
   每行 item 可被 _common.schema.json 的 email_list_item / email_search_hit 验证.
3. Error wrapper schema 一致性 (走 _common.schema.json#/$defs/wrapper_error).
"""

from __future__ import annotations

import json

import pytest


def _invoke(cli_runner, *args, db_path, **kwargs):
    from src.cli.main import app
    full_args = ["--db-path", str(db_path)]
    if "api_key" in kwargs:
        full_args.extend(["--api-key", kwargs["api_key"]])
    return cli_runner.invoke(app, [*full_args, *args])


def _patch_notion_sync(monkeypatch, result):
    """Replace NotionSync.create_email_page_from_sqlite with async stub returning ``result``."""
    from src.notion import sync as sync_mod

    async def fake(self, internal_id, *, repo, sync_store,
                   replace_existing=False, skip_parent_lookup=False):
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(
        sync_mod.NotionSync, "create_email_page_from_sqlite", fake,
    )


# ============================================================
# email resync mock — created / replaced / archive-failure
# ============================================================

class TestEmailResyncMock:
    def test_resync_created(self, cli_runner, cli_env, seeded_db, monkeypatch):
        from src.notion.sync import CreateEmailFromSqliteResult

        _patch_notion_sync(monkeypatch, CreateEmailFromSqliteResult(
            page_id="new-page-001",
            action="created",
            existing_page_id=None,
            archived_page_id=None,
        ))
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        result = _invoke(cli_runner, "email", "resync", "12345",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        from tests.cli.conftest import extract_last_json_object
        payload = extract_last_json_object(result.output)
        assert payload["data"]["action"] == "created"
        assert payload["data"]["new_page_id"] == "new-page-001"
        assert payload["data"]["archived_page_id"] is None

    def test_resync_replaced(self, cli_runner, cli_env, seeded_db, monkeypatch):
        from src.notion.sync import CreateEmailFromSqliteResult

        _patch_notion_sync(monkeypatch, CreateEmailFromSqliteResult(
            page_id="new-page-002",
            action="replaced",
            existing_page_id="old-page-001",
            archived_page_id="old-page-001",
        ))
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        result = _invoke(
            cli_runner, "email", "resync", "12345", "--replace-existing",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        from tests.cli.conftest import extract_last_json_object
        payload = extract_last_json_object(result.output)
        assert payload["data"]["action"] == "replaced"
        assert payload["data"]["new_page_id"] == "new-page-002"
        assert payload["data"]["old_page_id"] == "old-page-001"
        assert payload["data"]["archived_page_id"] == "old-page-001"

    def test_resync_replace_archive_failure(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        from src.notion.sync import CreateEmailFromSqliteResult

        # action=replaced 但 archive 失败 → archived_page_id 为 None
        _patch_notion_sync(monkeypatch, CreateEmailFromSqliteResult(
            page_id="new-page-003",
            action="replaced",
            existing_page_id="old-page-002",
            archived_page_id=None,
        ))
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        result = _invoke(
            cli_runner, "email", "resync", "12345", "--replace-existing",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        from tests.cli.conftest import extract_last_json_object
        payload = extract_last_json_object(result.output)
        assert payload["data"]["action"] == "replaced"
        assert payload["data"]["new_page_id"] == "new-page-003"
        assert payload["data"]["archived_page_id"] is None  # archive failed

    def test_resync_skipped(self, cli_runner, cli_env, seeded_db, monkeypatch):
        from src.notion.sync import CreateEmailFromSqliteResult

        _patch_notion_sync(monkeypatch, CreateEmailFromSqliteResult(
            page_id="existing-page",
            action="skipped",
            existing_page_id="existing-page",
            archived_page_id=None,
        ))
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        result = _invoke(cli_runner, "email", "resync", "12345",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        from tests.cli.conftest import extract_last_json_object
        payload = extract_last_json_object(result.output)
        assert payload["data"]["action"] == "skipped"


# ============================================================
# NDJSON contract — email list / search
# ============================================================

def _parse_ndjson(output: str) -> list[dict]:
    """从 stdout 抽 NDJSON 行: 每行一独立 object, 容忍前后 log 噪音."""
    items: list[dict] = []
    for raw in output.splitlines():
        s = raw.strip()
        if not s.startswith("{") or not s.endswith("}"):
            continue
        try:
            obj = json.loads(s)
        except json.JSONDecodeError:
            continue
        items.append(obj)
    return items


class TestNdjsonContract:
    def test_email_list_ndjson_meta_last(self, cli_runner, cli_env, seeded_db):
        result = _invoke(cli_runner, "email", "list", "--limit", "5",
                         "-o", "ndjson", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        items = _parse_ndjson(result.output)
        assert len(items) >= 2  # 至少 1 邮件 + 1 _meta
        last = items[-1]
        assert "_meta" in last
        assert "duration_ms" in last["_meta"]
        # _meta 之前每行都应是邮件 item — 含 internal_id + subject
        for it in items[:-1]:
            assert "internal_id" in it, it
            assert "subject" in it, it

    def test_email_search_ndjson_meta_last(self, cli_runner, cli_env, seeded_db):
        # fixture 写了 body markdown "redis timeout" — 搜应至少命中一条
        result = _invoke(cli_runner, "email", "search", "redis", "-o", "ndjson",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        items = _parse_ndjson(result.output)
        assert len(items) >= 1
        assert "_meta" in items[-1]
        # 命中行应有 rank
        if len(items) >= 2:
            assert "rank" in items[0] or "internal_id" in items[0]


# ============================================================
# error wrapper schema 一致性 (round 4 follow-up #3)
# ============================================================

class TestErrorWrapperConsistency:
    """所有 PR-3 命令的 error 返回都必须走 _common.schema.json#/$defs/wrapper_error."""

    @pytest.mark.parametrize("cmd_args,expected_code,exit_code", [
        # email get not-found
        (["email", "get", "99999"], "E_NOT_FOUND", 1),
        # email resync batch flag rejected
        (["email", "resync", "12345", "--range", "1-10"], "E_INVALID_ARG", 2),
        # attachment list not-found
        (["attachment", "list", "99999"], "E_NOT_FOUND", 1),
        # attachment derive non-dry-run rejected
        (["attachment", "derive", "12345"], "E_INVALID_ARG", 2),
        # llm retry-failed invalid limit
        (["llm", "retry-failed", "--limit", "0"], "E_INVALID_ARG", 2),
        # llm compare-paths bad ids
        (["llm", "compare-paths", "--internal-ids", "abc"], "E_INVALID_ARG", 2),
        # notion update-flag no flags
        (["notion", "update-flag", "12345"], "E_INVALID_ARG", 2),
        # notion archive without --yes
        (["notion", "archive", "page-x"], "E_INVALID_ARG", 2),
        # notion file-link-audit not-found internal-id
        (["notion", "file-link-audit", "--internal-id", "99999"],
         "E_NOT_FOUND", 1),
        # calendar expand invalid horizon
        (["calendar", "expand", "--horizon-weeks", "0"], "E_INVALID_ARG", 2),
        # calendar recurring replay no ids
        (["calendar", "recurring", "replay", "--dry-run"], "E_INVALID_ARG", 2),
    ])
    def test_error_wrapper_validates_against_common(
        self, cli_runner, cli_env, seeded_db, cmd_args, expected_code, exit_code,
    ):
        from jsonschema import validate
        from referencing import Registry, Resource
        from referencing.jsonschema import DRAFT202012
        from pathlib import Path

        result = _invoke(cli_runner, *cmd_args, "-o", "json", db_path=seeded_db)
        assert result.exit_code == exit_code, (
            f"args={cmd_args} expected exit {exit_code} got {result.exit_code}: "
            f"{result.output}"
        )
        from tests.cli.conftest import extract_last_json_object
        payload = extract_last_json_object(result.output)
        assert payload["status"] == "error"
        assert payload["error"]["code"] == expected_code

        # Validate against the wrapper_error sub-schema from _common.schema.json
        schema_dir = Path(__file__).resolve().parents[2] / "docs" / "cli-schema"
        common = json.loads((schema_dir / "_common.schema.json").read_text())
        common_res = Resource(contents=common, specification=DRAFT202012)
        registry = Registry().with_resource(
            uri="_common.schema.json", resource=common_res,
        )
        # 用 _common 顶层 oneOf — 任意 wrapper 都应 validate
        validate(instance=payload, schema=common, registry=registry)
