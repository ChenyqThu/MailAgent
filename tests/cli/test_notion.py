"""CLI notion 子命令测试 (RFC v2 §4.6, PR-3 US-005/US-006)."""

from __future__ import annotations

from tests.cli.conftest import extract_last_json_object as _last_json


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app
    return cli_runner.invoke(app, ["--db-path", str(db_path), *args])


class _AsyncNoop:
    """async functor that records calls but does nothing."""

    def __init__(self):
        self.calls = []

    async def __call__(self, **kwargs):
        self.calls.append(kwargs)
        return {"object": "page", "id": kwargs.get("page_id", "")}


def _patch_notion_client(monkeypatch, *, pages_update=None, query_results=None):
    """Replace NotionClient with a stub that won't touch the network."""
    from src.notion import client as client_mod

    class StubClient:
        def __init__(self):
            self.client = type("PagesNS", (), {})()
            self.client.pages = type("Pages", (), {})()
            self.client.pages.update = pages_update or _AsyncNoop()

        async def query_database(self, **kwargs):
            return query_results or []

        async def close(self):
            return None

    monkeypatch.setattr(client_mod, "NotionClient", StubClient)


# ============================================================
# US-005: resync alias (delegate to email resync)
# ============================================================

class TestNotionResyncAlias:
    def test_resync_dry_run_delegates(self, cli_runner, cli_env, seeded_db):
        result = _invoke(cli_runner, "notion", "resync", "12345", "--dry-run",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["dry_run"] is True
        assert payload["data"]["internal_id"] == 12345


# ============================================================
# US-005: update-flag
# ============================================================

class TestNotionUpdateFlag:
    def test_dry_run_is_read_true(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "notion", "update-flag", "12345",
            "--is-read", "true", "--dry-run", "-o", "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["updated_properties"]["Is Read"] is True
        assert payload["data"]["dry_run"] is True

    def test_dry_run_processing_status(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "notion", "update-flag", "12345",
            "--processing-status", "AI Reviewed", "--dry-run", "-o", "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["updated_properties"]["Processing Status"] == "AI Reviewed"

    def test_no_flags_rejected(self, cli_runner, cli_env, seeded_db):
        result = _invoke(cli_runner, "notion", "update-flag", "12345",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 2, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"

    def test_invalid_processing_status(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "notion", "update-flag", "12345",
            "--processing-status", "bogus", "--dry-run", "-o", "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 2, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"

    def test_not_found(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "notion", "update-flag", "99999",
            "--is-read", "true", "--dry-run", "-o", "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 1, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_NOT_FOUND"

    def test_no_notion_page(self, cli_runner, cli_env, seeded_db):
        # internal_id=12346 fixture 没填 notion_page_id
        result = _invoke(
            cli_runner, "notion", "update-flag", "12346",
            "--is-read", "true", "--dry-run", "-o", "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 1, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_NOT_FOUND"

    def test_actual_update_with_stub(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        stub = _AsyncNoop()
        _patch_notion_client(monkeypatch, pages_update=stub)
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        result = _invoke(
            cli_runner, "notion", "update-flag", "12345",
            "--is-flagged", "true", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["dry_run"] is False
        # 确认底层 pages.update 真被调
        assert len(stub.calls) == 1
        called = stub.calls[0]
        assert called["page_id"] == "abc12345-0000-0000-0000-000000000001"
        assert called["properties"]["Is Flagged"]["checkbox"] is True


# ============================================================
# US-005: archive
# ============================================================

class TestNotionArchive:
    def test_dry_run(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "notion", "archive",
            "some-page-id", "--dry-run", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["action"] == "would_archive"

    def test_without_yes_rejected(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "notion", "archive",
            "some-page-id", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"

    def test_with_yes_and_stub(self, cli_runner, cli_env, seeded_db, monkeypatch):
        stub = _AsyncNoop()
        _patch_notion_client(monkeypatch, pages_update=stub)
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        result = _invoke(
            cli_runner, "notion", "archive",
            "some-page-id", "--yes", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["action"] == "archived"
        assert len(stub.calls) == 1
        assert stub.calls[0]["page_id"] == "some-page-id"
        assert stub.calls[0]["archived"] is True


# ============================================================
# US-006: page-orphans
# ============================================================

class TestNotionPageOrphans:
    def test_orphans_dry_run_empty(self, cli_runner, cli_env, seeded_db, monkeypatch):
        _patch_notion_client(monkeypatch, query_results=[])
        result = _invoke(cli_runner, "notion", "page-orphans",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["total_orphans"] == 0
        assert payload["data"]["dry_run"] is True

    def test_orphans_finds_unknown_page(self, cli_runner, cli_env, seeded_db, monkeypatch):
        _patch_notion_client(monkeypatch, query_results=[
            {
                "id": "ghost-page-id",
                "properties": {
                    "Message ID": {
                        "rich_text": [{"plain_text": "<unknown@example.com>"}]
                    },
                    "Subject": {"title": [{"plain_text": "Ghost Mail"}]},
                },
            },
            # 已知 fixture msg id; 应被过滤掉
            {
                "id": "known-page-id",
                "properties": {
                    "Message ID": {
                        "rich_text": [{"plain_text": "<msg-12345@example.com>"}]
                    },
                    "Subject": {"title": [{"plain_text": "Known"}]},
                },
            },
        ])
        result = _invoke(cli_runner, "notion", "page-orphans",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["total_orphans"] == 1
        assert payload["data"]["orphans"][0]["message_id"] == "<unknown@example.com>"
        assert payload["data"]["orphans"][0]["subject"] == "Ghost Mail"

    def test_no_dry_run_rejected(self, cli_runner, cli_env, seeded_db):
        result = _invoke(cli_runner, "notion", "page-orphans",
                         "--no-dry-run", "-o", "json", db_path=seeded_db)
        assert result.exit_code == 2, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"


# ============================================================
# US-006: file-link-audit
# ============================================================

class TestNotionFileLinkAudit:
    def test_audit_default(self, cli_runner, cli_env, seeded_db):
        result = _invoke(cli_runner, "notion", "file-link-audit",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        # fixture 插了 1 个 attachment, notion_file_id 是 NULL → missing_upload
        assert payload["data"]["total"] == 1
        assert payload["data"]["by_status"]["missing_upload"] == 1
        assert payload["data"]["by_status"]["ok"] == 0

    def test_audit_internal_id_filter(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "notion", "file-link-audit",
            "--internal-id", "12345", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["internal_id_filter"] == 12345
        assert payload["data"]["total"] == 1

    def test_audit_internal_id_not_found(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "notion", "file-link-audit",
            "--internal-id", "99999", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 1, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_NOT_FOUND"

    def test_audit_no_dry_run_rejected(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "notion", "file-link-audit",
            "--no-dry-run", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"
