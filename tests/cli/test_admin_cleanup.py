"""admin cleanup-syncstore / cleanup-duplicates / repair-parents tests (PR-4 US-009)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

from tests.cli.conftest import extract_last_json_object as _xj


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app

    return cli_runner.invoke(
        app, ["--db-path", str(db_path), "admin", *args],
    )


class TestCleanupSyncStore:
    def test_dry_run_smoke(self, cli_runner, cli_env, seeded_db, monkeypatch):
        show_stats = MagicMock()
        monkeypatch.setattr("src.cleanup.syncstore.show_stats", show_stats)

        result = _invoke(
            cli_runner, "cleanup-syncstore",
            "-o", "json", db_path=seeded_db,
        )

        assert result.exit_code == 0, result.output
        show_stats.assert_called_once()
        payload = _xj(result.output)
        assert payload["data"]["action"] == "cleanup-syncstore"
        assert payload["data"]["dry_run"] is True
        assert payload["data"]["mode"] == "inline"
        assert payload["data"]["ok"] is True

    def test_no_dry_run_requires_yes(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        result = _invoke(
            cli_runner, "cleanup-syncstore", "--no-dry-run",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2
        payload = _xj(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"

    def test_no_dry_run_missing_auth_exit_4(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.delenv("MAILAGENT_CLI_API_KEY", raising=False)
        monkeypatch.delenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", raising=False)
        result = _invoke(
            cli_runner, "cleanup-syncstore", "--no-dry-run", "--yes",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 4


class TestCleanupDuplicates:
    def test_dry_run_smoke(self, cli_runner, cli_env, seeded_db, monkeypatch):
        async def fake_get_all_pages(client, db_id):
            return []

        extract_page_info = MagicMock()
        archive_page = AsyncMock()
        async_client = MagicMock()
        monkeypatch.setattr(
            "src.cleanup.duplicate_message_ids.get_all_pages",
            fake_get_all_pages,
        )
        monkeypatch.setattr(
            "src.cleanup.duplicate_message_ids.extract_page_info",
            extract_page_info,
        )
        monkeypatch.setattr(
            "src.cleanup.duplicate_message_ids.archive_page",
            archive_page,
        )
        monkeypatch.setattr("notion_client.AsyncClient", async_client)

        result = _invoke(
            cli_runner, "cleanup-duplicates",
            "-o", "json", db_path=seeded_db,
        )

        assert result.exit_code == 0
        async_client.assert_called_once()
        extract_page_info.assert_not_called()
        archive_page.assert_not_called()
        payload = _xj(result.output)
        assert payload["data"]["action"] == "cleanup-duplicates"
        assert payload["data"]["dry_run"] is True
        assert payload["data"]["mode"] == "inline"
        assert payload["data"]["ok"] is True
        assert payload["data"]["duplicate_message_ids"] == 0
        assert payload["data"]["duplicate_pages"] == 0


class TestRepairParents:
    def test_dry_run_smoke(self, cli_runner, cli_env, seeded_db, monkeypatch):
        class FakeCleaner:
            def __init__(self):
                self.stats = {"parent_set": 0}
                self.run = AsyncMock(return_value=True)

        cleaner = FakeCleaner()
        cleaner_cls = MagicMock(return_value=cleaner)
        monkeypatch.setattr("src.cleanup.notion_db.NotionDBCleaner", cleaner_cls)

        result = _invoke(
            cli_runner, "repair-parents",
            "-o", "json", db_path=seeded_db,
        )

        assert result.exit_code == 0
        cleaner_cls.assert_called_once()
        cleaner.run.assert_awaited_once_with(dry_run=True, parent_only=True)
        payload = _xj(result.output)
        assert payload["data"]["action"] == "repair-parents"
        assert payload["data"]["dry_run"] is True
        assert payload["data"]["mode"] == "inline"
        assert payload["data"]["ok"] is True

    def test_thread_id_passthrough(self, cli_runner, cli_env, seeded_db, monkeypatch):
        class FakeCleaner:
            def __init__(self):
                self.stats = {"parent_set": 0}
                self.repair_parents = AsyncMock(return_value=True)

        cleaner = FakeCleaner()
        cleaner_cls = MagicMock(return_value=cleaner)
        monkeypatch.setattr("src.cleanup.notion_db.NotionDBCleaner", cleaner_cls)

        result = _invoke(
            cli_runner, "repair-parents", "--thread-id", "<thread@x>",
            "-o", "json", db_path=seeded_db,
        )

        assert result.exit_code == 0
        cleaner.repair_parents.assert_awaited_once_with(
            thread_id="<thread@x>", dry_run=True,
        )
        payload = _xj(result.output)
        assert payload["data"]["thread_id"] == "<thread@x>"
        assert payload["data"]["mode"] == "inline"
