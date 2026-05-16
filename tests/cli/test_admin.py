"""US-006 — admin stats / health / db-version."""

from __future__ import annotations

import json


def _invoke_admin(cli_runner, *args, db_path):
    from src.cli.main import app

    return cli_runner.invoke(
        app, ["--db-path", str(db_path), "admin", *args],
    )


def _extract_last_json_object(text: str) -> dict:
    if not text:
        raise ValueError("empty output")
    candidates = []
    for line in text.strip().splitlines():
        line = line.strip()
        if not line.startswith("{") or not line.endswith("}"):
            continue
        try:
            candidates.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    if not candidates:
        raise ValueError(f"no JSON object in output: {text[:300]!r}")
    return candidates[-1]


class TestAdminDbVersion:
    def test_text(self, cli_runner, cli_env, seeded_db):
        result = _invoke_admin(cli_runner, "db-version", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        assert "5" in result.output
        assert "compatible" in result.output

    def test_json(self, cli_runner, cli_env, seeded_db):
        result = _invoke_admin(
            cli_runner, "db-version", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract_last_json_object(result.output)
        assert payload["data"]["version"] == 5
        assert payload["data"]["expected"] == 5
        assert payload["data"]["compatible"] is True

    def test_incompat_emits_error_wrapper(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        """PR-2 critic fix #3: 不兼容时 status=error E_SCHEMA_MISMATCH, 不再 status=success."""
        # 临时 patch EXPECTED_DB_VERSION 为 9 (与 seeded_db 的 5 不匹配)
        from src.cli.commands import admin

        monkeypatch.setattr(admin, "EXPECTED_DB_VERSION", 9)
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
        assert payload["data"]["db_version"] == 5
        for required in (
            "email_metadata", "email_body", "email_attachment", "email_body_fts",
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
        # 其他三段 PR-4 占位
        for sec in ("watcher", "handlers", "v4_rollout"):
            assert payload["data"][sec]["_source"] == "not_implemented_in_pr2"
