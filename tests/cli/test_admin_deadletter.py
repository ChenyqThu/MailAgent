"""admin dead-letter list/retry + cleanup-deadletter tests (PR-4 US-009)."""

from __future__ import annotations

import sqlite3
import time


from tests.cli.conftest import extract_last_json_object as _xj


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app

    return cli_runner.invoke(
        app, ["--db-path", str(db_path), "admin", *args],
    )


def _seed_dead_letter(db_path, internal_id, mailbox="收件箱", days_ago=0):
    now = time.time() - days_ago * 86400
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute(
            "INSERT INTO email_metadata "
            "(internal_id, subject, sender, mailbox, sync_status, "
            " retry_count, sync_error, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, 'dead_letter', 5, 'AppleScript timeout', ?, ?)",
            (internal_id, f"sub-{internal_id}", f"a{internal_id}@x.com",
             mailbox, now, now),
        )
        conn.commit()
    finally:
        conn.close()


class TestDeadLetterList:
    def test_empty_list(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "dead-letter", "list", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _xj(result.output)
        assert payload["data"] == []
        assert payload["meta"]["count"] == 0

    def test_list_with_rows(self, cli_runner, cli_env, seeded_db):
        _seed_dead_letter(seeded_db, 20001)
        _seed_dead_letter(seeded_db, 20002, mailbox="发件箱")
        result = _invoke(
            cli_runner, "dead-letter", "list", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0
        payload = _xj(result.output)
        assert payload["meta"]["count"] == 2
        ids = {r["internal_id"] for r in payload["data"]}
        assert ids == {20001, 20002}

    def test_list_filter_mailbox(self, cli_runner, cli_env, seeded_db):
        _seed_dead_letter(seeded_db, 20001, mailbox="收件箱")
        _seed_dead_letter(seeded_db, 20002, mailbox="发件箱")
        result = _invoke(
            cli_runner, "dead-letter", "list", "--mailbox", "发件箱",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0
        payload = _xj(result.output)
        assert payload["meta"]["count"] == 1
        assert payload["data"][0]["internal_id"] == 20002

    def test_list_bad_limit(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "dead-letter", "list", "--limit", "1000",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2


class TestDeadLetterRetry:
    def test_retry_requires_auth(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.delenv("MAILAGENT_CLI_API_KEY", raising=False)
        monkeypatch.delenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", raising=False)
        _seed_dead_letter(seeded_db, 20001)
        result = _invoke(
            cli_runner, "dead-letter", "retry", "20001",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 4

    def test_retry_resets_status(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        _seed_dead_letter(seeded_db, 20001)
        result = _invoke(
            cli_runner, "dead-letter", "retry", "20001",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _xj(result.output)
        assert payload["data"]["new_status"] == "pending"
        assert payload["data"]["old_status"] == "dead_letter"

        # DB check
        conn = sqlite3.connect(str(seeded_db))
        try:
            row = conn.execute(
                "SELECT sync_status, retry_count, sync_error FROM email_metadata "
                "WHERE internal_id=20001"
            ).fetchone()
        finally:
            conn.close()
        assert row[0] == "pending"
        assert row[1] == 0
        assert row[2] is None

    def test_retry_not_found(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        result = _invoke(
            cli_runner, "dead-letter", "retry", "99999",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2
        payload = _xj(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"


class TestDeadLetterDelete:
    def test_delete_requires_yes(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        _seed_dead_letter(seeded_db, 20001)
        result = _invoke(
            cli_runner, "dead-letter", "delete", "20001",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2
        payload = _xj(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"
        # 未删除
        conn = sqlite3.connect(str(seeded_db))
        try:
            still = conn.execute(
                "SELECT COUNT(*) FROM email_metadata WHERE internal_id=20001"
            ).fetchone()[0]
        finally:
            conn.close()
        assert still == 1

    def test_delete_requires_auth(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.delenv("MAILAGENT_CLI_API_KEY", raising=False)
        monkeypatch.delenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", raising=False)
        _seed_dead_letter(seeded_db, 20001)
        result = _invoke(
            cli_runner, "dead-letter", "delete", "20001", "--yes",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 4

    def test_delete_removes_dead_letter(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        _seed_dead_letter(seeded_db, 20001)
        result = _invoke(
            cli_runner, "dead-letter", "delete", "20001", "--yes",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _xj(result.output)
        assert payload["data"]["deleted"] is True
        assert payload["data"]["old_status"] == "dead_letter"
        conn = sqlite3.connect(str(seeded_db))
        try:
            still = conn.execute(
                "SELECT COUNT(*) FROM email_metadata WHERE internal_id=20001"
            ).fetchone()[0]
        finally:
            conn.close()
        assert still == 0

    def test_delete_refuses_non_dead_letter(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        """铁律: 非 dead_letter 行 (seeded_db 的 12345 是 synced) 拒删。"""
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        result = _invoke(
            cli_runner, "dead-letter", "delete", "12345", "--yes",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2
        payload = _xj(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"
        # 真身仍在
        conn = sqlite3.connect(str(seeded_db))
        try:
            still = conn.execute(
                "SELECT COUNT(*) FROM email_metadata WHERE internal_id=12345"
            ).fetchone()[0]
        finally:
            conn.close()
        assert still == 1

    def test_delete_not_found(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        result = _invoke(
            cli_runner, "dead-letter", "delete", "99999", "--yes",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2
        payload = _xj(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"


class TestCleanupDeadletter:
    def test_dry_run_lists_candidates(
        self, cli_runner, cli_env, seeded_db,
    ):
        _seed_dead_letter(seeded_db, 20001, days_ago=60)  # old
        _seed_dead_letter(seeded_db, 20002, days_ago=5)   # fresh
        result = _invoke(
            cli_runner, "cleanup-deadletter", "--older-than", "30",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0
        payload = _xj(result.output)
        assert payload["data"]["candidates"] == 1
        assert payload["data"]["deleted"] == 0  # dry-run

    def test_no_dry_run_requires_yes(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        _seed_dead_letter(seeded_db, 20001, days_ago=60)
        result = _invoke(
            cli_runner, "cleanup-deadletter", "--no-dry-run",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2

    def test_no_dry_run_with_yes_deletes(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        _seed_dead_letter(seeded_db, 20001, days_ago=60)
        _seed_dead_letter(seeded_db, 20002, days_ago=5)
        result = _invoke(
            cli_runner, "cleanup-deadletter", "--no-dry-run", "--yes",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0
        payload = _xj(result.output)
        assert payload["data"]["deleted"] == 1
        # 20002 仍在
        conn = sqlite3.connect(str(seeded_db))
        try:
            still = conn.execute(
                "SELECT COUNT(*) FROM email_metadata WHERE sync_status='dead_letter'"
            ).fetchone()[0]
        finally:
            conn.close()
        assert still == 1
