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
        # outbox 字段恒存在; 空队列 → 无 warning
        assert payload["data"]["outbox_backlog"] == 0
        assert "outbox_dispatch_enabled" in payload["data"]
        assert "outbox_warning" not in payload["data"]

    def test_outbox_backlog_warning_when_dispatcher_disabled(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        """派发器关闭 + email_outbox 积压 → health 暴露 outbox_backlog +
        outbox_warning (打包 App 曾因 onboarding 漏写 MAILAGENT_OUTBOX_ENABLED
        静默积压 1564 条, 写操作永不同步; health 必须能看出来)。"""
        from src.sync.outbox import OutboxRepository

        monkeypatch.setenv("MAILAGENT_OUTBOX_ENABLED", "false")
        repo = OutboxRepository(str(seeded_db))
        repo.enqueue(
            internal_id=12345, op_type="flag_sync", target="mailapp",
            payload={"is_flagged": True}, source="cli",
        )
        repo.enqueue(
            internal_id=12345, op_type="flag_sync", target="notion",
            payload={"is_flagged": True}, source="cli",
        )

        result = _invoke_admin(
            cli_runner, "health", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract_last_json_object(result.output)
        assert payload["data"]["outbox_dispatch_enabled"] is False
        assert payload["data"]["outbox_backlog"] == 2
        assert "MAILAGENT_OUTBOX_ENABLED" in payload["data"]["outbox_warning"]
        # 积压是配置告警, 不翻转 healthy (schema 仍 OK, 不破坏现有健康闸语义)
        assert payload["data"]["healthy"] is True


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
