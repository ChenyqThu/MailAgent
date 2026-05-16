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


class _AsyncFailOne:
    """async functor that raises for one page_id and records every attempt."""

    def __init__(self, failing_page_id: str):
        self.failing_page_id = failing_page_id
        self.calls = []

    async def __call__(self, **kwargs):
        self.calls.append(kwargs)
        if kwargs.get("page_id") == self.failing_page_id:
            raise RuntimeError("archive failed")
        return {"object": "page", "id": kwargs.get("page_id", "")}


def _patch_notion_client(monkeypatch, *, pages_update=None, query_results=None):
    """Replace NotionClient with a stub that won't touch the network.

    Covers both old API surface (``query_database``) and new pagination path
    (``client.data_sources.query`` + ``get_data_source_id``) — PR-3 round-5 fix
    for codex critic blocker (notion page-orphans needs real pagination).
    """
    from src.notion import client as client_mod
    results_list = list(query_results or [])

    class StubDataSources:
        async def query(self, **kwargs):
            # Single page — has_more=False so pagination stops after one call.
            return {"results": results_list, "has_more": False, "next_cursor": None}

    class StubClient:
        def __init__(self, *args, **kwargs):
            # 接受任意 token/email_db_id kwargs (PR-3 round-5 加的 CliContext 透传)
            self.email_db_id = kwargs.get("email_db_id") or "stub-email-db-id"
            self.client = type("PagesNS", (), {})()
            self.client.pages = type("Pages", (), {})()
            self.client.pages.update = pages_update or _AsyncNoop()
            self.client.data_sources = StubDataSources()

        async def get_data_source_id(self, db_id):
            return "stub-data-source-id"

        async def query_database(self, **kwargs):
            return results_list

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

    def test_no_dry_run_without_repair_or_yes_rejected(
        self, cli_runner, cli_env, seeded_db,
    ):
        result = _invoke(cli_runner, "notion", "page-orphans",
                         "--no-dry-run", "-o", "json", db_path=seeded_db)
        assert result.exit_code == 2, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"
        assert (
            "requires --yes and one of --archive-orphan-pages / --insert-stub-metadata"
            in payload["error"]["message"]
        )

    def test_archive_orphan_pages_yes_mocked(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        stub = _AsyncNoop()
        _patch_notion_client(monkeypatch, pages_update=stub, query_results=[
            {
                "id": "ghost-page-id",
                "properties": {
                    "Message ID": {
                        "rich_text": [{"plain_text": "<ghost@example.com>"}],
                    },
                    "Subject": {"title": [{"plain_text": "Ghost Mail"}]},
                },
            },
        ])
        result = _invoke(
            cli_runner, "notion", "page-orphans",
            "--no-dry-run", "--archive-orphan-pages", "--yes",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["mode"] == "inline"
        assert payload["data"]["action"] == "archive"
        assert payload["data"]["archived"] == ["ghost-page-id"]
        assert payload["data"]["failed"] == []
        assert len(stub.calls) == 1
        assert stub.calls[0]["page_id"] == "ghost-page-id"
        assert stub.calls[0]["archived"] is True

    def test_archive_partial_failure(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        stub = _AsyncFailOne("ghost-page-2")
        _patch_notion_client(monkeypatch, pages_update=stub, query_results=[
            {
                "id": "ghost-page-1",
                "properties": {
                    "Message ID": {
                        "rich_text": [{"plain_text": "<ghost1@example.com>"}],
                    },
                    "Subject": {"title": [{"plain_text": "Ghost 1"}]},
                },
            },
            {
                "id": "ghost-page-2",
                "properties": {
                    "Message ID": {
                        "rich_text": [{"plain_text": "<ghost2@example.com>"}],
                    },
                    "Subject": {"title": [{"plain_text": "Ghost 2"}]},
                },
            },
            {
                "id": "ghost-page-3",
                "properties": {
                    "Message ID": {
                        "rich_text": [{"plain_text": "<ghost3@example.com>"}],
                    },
                    "Subject": {"title": [{"plain_text": "Ghost 3"}]},
                },
            },
        ])

        result = _invoke(
            cli_runner, "notion", "page-orphans",
            "--no-dry-run", "--archive-orphan-pages", "--yes",
            "-o", "json", db_path=seeded_db,
        )

        assert result.exit_code == 6, result.output
        payload = _last_json(result.output)
        assert payload["data"]["archived"] == ["ghost-page-1", "ghost-page-3"]
        assert len(payload["data"]["failed"]) == 1
        assert payload["data"]["failed"][0]["page_id"] == "ghost-page-2"
        assert "RuntimeError: archive failed" in payload["data"]["failed"][0]["error"]
        assert len(stub.calls) == 3

    def test_insert_stub_metadata_yes_mocked(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        import sqlite3

        _patch_notion_client(monkeypatch, query_results=[
            {
                "id": "ghost-page-id",
                "properties": {
                    "Message ID": {
                        "rich_text": [{"plain_text": "<ghost@example.com>"}],
                    },
                    "Subject": {"title": [{"plain_text": "Ghost Mail"}]},
                },
            },
        ])
        result = _invoke(
            cli_runner, "notion", "page-orphans",
            "--no-dry-run", "--insert-stub-metadata", "--yes",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["mode"] == "inline"
        assert payload["data"]["action"] == "insert-stub"
        assert payload["data"]["archived"] == ["ghost-page-id"]
        conn = sqlite3.connect(str(seeded_db))
        try:
            rows = conn.execute(
                """SELECT internal_id, notion_page_id, sync_status
                   FROM email_metadata
                   WHERE notion_page_id = ?""",
                ("ghost-page-id",),
            ).fetchall()
        finally:
            conn.close()
        assert len(rows) == 1
        assert rows[0][0] < 0
        assert rows[0][2] == "dead_letter"

    def test_no_repair_flag_with_no_dry_run(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "notion", "page-orphans",
            "--no-dry-run", "--yes", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"

    def test_both_repair_flags_mutually_exclusive(
        self, cli_runner, cli_env, seeded_db,
    ):
        result = _invoke(
            cli_runner, "notion", "page-orphans",
            "--no-dry-run", "--archive-orphan-pages", "--insert-stub-metadata",
            "--yes", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"

    def test_max_pages_caps_archive(self, cli_runner, cli_env, seeded_db, monkeypatch):
        stub = _AsyncNoop()
        _patch_notion_client(monkeypatch, pages_update=stub, query_results=[
            {
                "id": "ghost-page-1",
                "properties": {
                    "Message ID": {
                        "rich_text": [{"plain_text": "<ghost1@example.com>"}],
                    },
                    "Subject": {"title": [{"plain_text": "Ghost 1"}]},
                },
            },
            {
                "id": "ghost-page-2",
                "properties": {
                    "Message ID": {
                        "rich_text": [{"plain_text": "<ghost2@example.com>"}],
                    },
                    "Subject": {"title": [{"plain_text": "Ghost 2"}]},
                },
            },
            {
                "id": "ghost-page-3",
                "properties": {
                    "Message ID": {
                        "rich_text": [{"plain_text": "<ghost3@example.com>"}],
                    },
                    "Subject": {"title": [{"plain_text": "Ghost 3"}]},
                },
            },
        ])
        result = _invoke(
            cli_runner, "notion", "page-orphans",
            "--no-dry-run", "--archive-orphan-pages", "--yes",
            "--max-pages", "2", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["archived"] == ["ghost-page-1", "ghost-page-2"]
        assert payload["data"]["orphans_found"] == 3
        assert payload["data"]["max_pages"] == 2
        assert len(stub.calls) == 2

    def test_max_pages_zero_rejected(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "notion", "page-orphans",
            "--no-dry-run", "--archive-orphan-pages", "--yes",
            "--max-pages", "0", "-o", "json", db_path=seeded_db,
        )

        assert result.exit_code == 2, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"
        assert "--max-pages must be > 0" in payload["error"]["message"]


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
            "--no-dry-run", "--yes", "--max-files", "0", "-o", "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 2, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"
        assert "--max-files must be > 0" in payload["error"]["message"]

    def test_audit_upload_missing_yes_mocked(
        self, cli_runner, cli_env, seeded_db, monkeypatch, tmp_path,
    ):
        import sqlite3
        from unittest.mock import AsyncMock, MagicMock

        test_file = tmp_path / "test.pdf"
        test_file.write_bytes(b"PDF data")

        conn = sqlite3.connect(str(seeded_db))
        try:
            conn.execute(
                """UPDATE email_attachment
                   SET local_path = ?
                   WHERE notion_file_id IS NULL""",
                (str(test_file),),
            )
            conn.commit()
        finally:
            conn.close()

        fake_client = MagicMock()
        fake_client.upload_file = AsyncMock(return_value="fake-file-id-123")
        fake_client.close = AsyncMock()
        monkeypatch.setattr(
            "src.cli.commands.notion.NotionClient",
            lambda **kwargs: fake_client,
        )

        result = _invoke(
            cli_runner, "notion", "file-link-audit",
            "--no-dry-run", "--yes", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["mode"] == "inline"
        assert len(payload["data"]["uploaded"]) == 1
        assert payload["data"]["uploaded"][0]["notion_file_id"] == "fake-file-id-123"
        fake_client.upload_file.assert_awaited_once_with(str(test_file))

        conn = sqlite3.connect(str(seeded_db))
        try:
            rows = conn.execute(
                """SELECT notion_file_id
                   FROM email_attachment
                   WHERE local_path = ?""",
                (str(test_file),),
            ).fetchall()
        finally:
            conn.close()
        assert rows[0][0] == "fake-file-id-123"

    def test_audit_upload_local_file_missing(
        self, cli_runner, cli_env, seeded_db, monkeypatch, tmp_path,
    ):
        import sqlite3
        from unittest.mock import AsyncMock, MagicMock

        missing_file = tmp_path / "missing.pdf"
        conn = sqlite3.connect(str(seeded_db))
        try:
            conn.execute(
                """UPDATE email_attachment
                   SET local_path = ?, notion_file_id = NULL
                   WHERE internal_id = ?""",
                (str(missing_file), 12345),
            )
            conn.commit()
        finally:
            conn.close()

        fake_client = MagicMock()
        fake_client.upload_file = AsyncMock()
        fake_client.close = AsyncMock()
        monkeypatch.setattr(
            "src.cli.commands.notion.NotionClient",
            lambda **kwargs: fake_client,
        )

        result = _invoke(
            cli_runner, "notion", "file-link-audit",
            "--no-dry-run", "--yes", "-o", "json", db_path=seeded_db,
        )

        assert result.exit_code == 6, result.output
        payload = _last_json(result.output)
        assert len(payload["data"]["failed"]) == 1
        assert "file missing" in payload["data"]["failed"][0]["error"]
        assert str(missing_file) in payload["data"]["failed"][0]["error"]
        fake_client.upload_file.assert_not_awaited()

    def test_audit_archive_dead_flag_accepted_but_noop(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        import sqlite3
        from unittest.mock import AsyncMock, MagicMock

        conn = sqlite3.connect(str(seeded_db))
        try:
            conn.execute(
                """UPDATE email_attachment
                   SET notion_file_id = ?
                   WHERE internal_id = ?""",
                ("existing-file-id", 12345),
            )
            conn.commit()
        finally:
            conn.close()

        fake_client = MagicMock()
        fake_client.upload_file = AsyncMock()
        fake_client.close = AsyncMock()
        monkeypatch.setattr(
            "src.cli.commands.notion.NotionClient",
            lambda **kwargs: fake_client,
        )

        result = _invoke(
            cli_runner, "notion", "file-link-audit",
            "--no-dry-run", "--yes", "--archive-dead",
            "-o", "json", db_path=seeded_db,
        )

        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["archive_dead"] is True
        assert payload["data"]["dead_link_archived"] == []
        assert payload["data"]["uploaded"] == []
        assert payload["data"]["failed"] == []
        fake_client.upload_file.assert_not_awaited()

    def test_audit_real_run_requires_yes(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "notion", "file-link-audit",
            "--no-dry-run", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"
        assert "requires --yes" in payload["error"]["message"]

    def test_audit_max_files_caps(
        self, cli_runner, cli_env, seeded_db, monkeypatch, tmp_path,
    ):
        import sqlite3
        import time
        from unittest.mock import AsyncMock, MagicMock

        files = []
        for idx in range(3):
            p = tmp_path / f"report-{idx}.pdf"
            p.write_bytes(f"PDF data {idx}".encode("utf-8"))
            files.append(p)

        conn = sqlite3.connect(str(seeded_db))
        try:
            conn.execute(
                """UPDATE email_attachment
                   SET local_path = ?, notion_file_id = NULL
                   WHERE internal_id = ?""",
                (str(files[0]), 12345),
            )
            now = time.time()
            for idx in range(1, 3):
                conn.execute(
                    """INSERT INTO email_attachment
                         (internal_id, content_id, filename, content_type, size_bytes,
                          is_inline, local_path, sha256, derived_from, derived_format,
                          created_at, schema_version)
                       VALUES (?, NULL, ?, ?, ?, 0, ?, ?, NULL, NULL, ?, 1)""",
                    (
                        12345,
                        f"report-{idx}.pdf",
                        "application/pdf",
                        files[idx].stat().st_size,
                        str(files[idx]),
                        str(idx) * 64,
                        now,
                    ),
                )
            conn.commit()
        finally:
            conn.close()

        fake_client = MagicMock()
        fake_client.upload_file = AsyncMock(return_value="fake-file-id-capped")
        fake_client.close = AsyncMock()
        monkeypatch.setattr(
            "src.cli.commands.notion.NotionClient",
            lambda **kwargs: fake_client,
        )

        result = _invoke(
            cli_runner, "notion", "file-link-audit",
            "--no-dry-run", "--yes", "--max-files", "1",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["missing_upload_found"] == 3
        assert payload["data"]["max_files"] == 1
        assert len(payload["data"]["uploaded"]) == 1
        assert fake_client.upload_file.await_count == 1
