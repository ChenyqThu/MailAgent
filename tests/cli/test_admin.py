"""US-006 — admin stats / health / db-version."""

from __future__ import annotations

from tests.cli.conftest import extract_last_json_object as _extract_last_json_object


def _invoke_admin(cli_runner, *args, db_path):
    from src.cli.main import app

    return cli_runner.invoke(
        app, ["--db-path", str(db_path), "admin", *args],
    )


class TestAdminDbVersion:
    def test_text(self, cli_runner, cli_env, seeded_db):
        result = _invoke_admin(cli_runner, "db-version", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        assert "7" in result.output
        assert "compatible" in result.output

    def test_json(self, cli_runner, cli_env, seeded_db):
        result = _invoke_admin(
            cli_runner, "db-version", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract_last_json_object(result.output)
        assert payload["data"]["version"] == 7
        assert payload["data"]["expected"] == 7
        assert payload["data"]["compatible"] is True

    def test_incompat_emits_error_wrapper(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        """PR-2 critic fix #3: 不兼容时 status=error E_SCHEMA_MISMATCH, 不再 status=success."""
        # 临时 patch EXPECTED_DB_VERSION 为 99 (与 seeded_db 的当前版本不匹配)
        from src.cli.commands import admin

        monkeypatch.setattr(admin, "EXPECTED_DB_VERSION", 99)
        result = _invoke_admin(
            cli_runner, "db-version", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 5, result.output
        payload = _extract_last_json_object(result.output)
        assert payload["status"] == "error"
        assert payload["error"]["code"] == "E_SCHEMA_MISMATCH"


class TestAdminHealth:
    def test_healthy(self, cli_runner, cli_env, seeded_db):
        result = _invoke_admin(
            cli_runner, "health", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract_last_json_object(result.output)
        assert payload["data"]["healthy"] is True
        assert payload["data"]["db_version"] == 7
        for required in (
            "email_metadata", "email_body", "email_attachment", "email_body_fts",
            "cli_checkpoints", "v4_rollout_stats", "island_dispatch",
        ):
            assert required in payload["data"]["tables_present"]


class TestAdminStats:
    def test_stats_json_full(self, cli_runner, cli_env, seeded_db):
        result = _invoke_admin(
            cli_runner, "stats", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract_last_json_object(result.output)
        # 4 段必须都存在
        for sec in ("watcher", "sync_store", "handlers", "v4_rollout"):
            assert sec in payload["data"]
        # sync_store 段是 live_query
        ss = payload["data"]["sync_store"]
        assert ss["_source"] == "live_query"
        assert ss["total_emails"] >= 1
        assert "by_status" in ss
        assert "db_size_mb" in ss
        # watcher / handlers 仍为 PR-4 占位 (PR-2 留下的)
        for sec in ("watcher", "handlers"):
            assert payload["data"][sec]["_source"] == "not_implemented_in_pr2"
        # PR-4 R-06: v4_rollout 现走真实路径; 空 DB → no_data_yet
        assert payload["data"]["v4_rollout"]["_source"] == "no_data_yet"
