"""US-006 — admin stats / health / db-version."""

from __future__ import annotations

from src.mail.sync_store import SyncStore
from tests.cli.conftest import extract_last_json_object as _extract_last_json_object

# 跟 SyncStore.DB_VERSION 同步, 避免每次升 schema 都改硬编码 (Sprint 16 v13).
_DB_VERSION = SyncStore.DB_VERSION


def _invoke_admin(cli_runner, *args, db_path):
    from src.cli.main import app

    return cli_runner.invoke(
        app, ["--db-path", str(db_path), "admin", *args],
    )


class TestAdminDbVersion:
    def test_text(self, cli_runner, cli_env, seeded_db):
        result = _invoke_admin(cli_runner, "db-version", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        assert str(_DB_VERSION) in result.output
        assert "compatible" in result.output

    def test_json(self, cli_runner, cli_env, seeded_db):
        result = _invoke_admin(
            cli_runner, "db-version", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract_last_json_object(result.output)
        assert payload["data"]["version"] == _DB_VERSION
        assert payload["data"]["expected"] == _DB_VERSION
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
        assert payload["data"]["db_version"] == _DB_VERSION
        for required in (
            "email_metadata", "email_body", "email_attachment", "email_body_fts",
            "cli_checkpoints", "v4_rollout_stats", "island_dispatch", "email_outbox",
        ):
            assert required in payload["data"]["tables_present"]

    def test_davmail_watch_note_present_and_healthy_unaffected(
        self, cli_runner, cli_env, seeded_db,
    ):
        """E1 Lane B: 静态 davmail 上游 watch note 不影响 healthy 语义 (纯提示新增字段)."""
        from src.cli.commands import admin

        result = _invoke_admin(
            cli_runner, "health", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract_last_json_object(result.output)
        assert payload["data"]["healthy"] is True
        notes = payload["data"]["notes"]
        assert isinstance(notes, list) and len(notes) >= 1
        assert notes == list(admin.HEALTH_WATCH_NOTES)
        combined = " ".join(notes)
        assert "EWS 2026-10-01" in combined
        assert "davmail" in combined
        # 口径死约束 (e1-backend-contract.md §3.1 Step 4): 绝不出现 Graph API 自研 /
        # 应用注册 / IT 审批相关字样。
        for forbidden in ("Graph API", "应用注册", "IT 审批", "Azure"):
            assert forbidden not in combined

    def test_davmail_watch_note_present_in_text_output(
        self, cli_runner, cli_env, seeded_db,
    ):
        result = _invoke_admin(
            cli_runner, "health", "-o", "text", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        assert "note" in result.output
        assert "davmail" in result.output


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
