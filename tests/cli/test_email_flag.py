"""tests/cli/test_email_flag.py — Sprint 15 Stage 1.6.

`mailagent email flag` CLI 覆盖:
- dry-run: 不写 SQLite / outbox, 返回 plan
- auth required: 默认环境拒绝, ALLOW_UNAUTH_WRITES=true 放行
- 单封 / --ids 批量
- payload: --is-read / --is-flagged / --processing-status (单 + 组合)
- mailapp_payload 排除 processing_status (MailAppFanout 不读)
- not_found 列出未存在的 internal_id
- 必须至少给一个 flag 字段
- 单封 + --ids 互斥
"""

from __future__ import annotations

import sqlite3

import pytest

from tests.cli.conftest import extract_last_json_object as _extract


@pytest.fixture
def _unauth_writes_on(monkeypatch):
    """写命令测试用. 默认 cli_env 不开 ALLOW_UNAUTH_WRITES, 写命令会被 require_auth
    拒绝 (exit 4). 各 TestSingleWrite/TestBatchIds 显式开."""
    monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
    monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "")


def _invoke_flag(cli_runner, *args, db_path):
    from src.cli.main import app

    return cli_runner.invoke(
        app, ["--db-path", str(db_path), "email", "flag", *args],
    )


def _outbox_rows(db_path, internal_id: int) -> list[tuple]:
    """读 outbox 行 (outbox_id, target, source, status, payload_json)."""
    conn = sqlite3.connect(str(db_path))
    try:
        return conn.execute(
            "SELECT outbox_id, target, source, status, payload_json "
            "FROM email_outbox WHERE internal_id = ? ORDER BY outbox_id",
            (internal_id,),
        ).fetchall()
    finally:
        conn.close()


# ============================================================
# Validation
# ============================================================

class TestValidation:
    def test_no_flag_args_fails(self, cli_runner, cli_env, seeded_db):
        """必须给至少一个 flag 改动."""
        result = _invoke_flag(cli_runner, "12345", "-o", "json", db_path=seeded_db)
        assert result.exit_code == 2, result.output
        payload = _extract(result.output)
        assert payload["status"] == "error"
        assert payload["error"]["code"] == "E_INVALID_ARG"

    def test_no_target_fails(self, cli_runner, cli_env, seeded_db):
        """必须给 internal_id 或 --ids."""
        result = _invoke_flag(
            cli_runner, "--is-read", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2, result.output

    def test_single_and_ids_mutually_exclusive(self, cli_runner, cli_env, seeded_db):
        result = _invoke_flag(
            cli_runner, "12345", "--is-read", "--ids", "12345,12346",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2

    def test_invalid_ids_format(self, cli_runner, cli_env, seeded_db):
        result = _invoke_flag(
            cli_runner, "--is-read", "--ids", "abc,def",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2


# ============================================================
# Dry-run
# ============================================================

class TestDryRun:
    def test_dry_run_no_writes(self, cli_runner, cli_env, seeded_db):
        result = _invoke_flag(
            cli_runner, "12345", "--is-read", "--dry-run",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract(result.output)
        assert payload["status"] == "success"
        assert payload["data"]["dry_run"] is True
        assert payload["data"]["internal_ids"] == [12345]
        assert payload["data"]["payload"] == {"is_read": True}
        assert len(payload["data"]["would_enqueue"]) == 1
        # outbox 表无新行
        assert _outbox_rows(seeded_db, 12345) == []

    def test_dry_run_skips_auth(self, cli_runner, cli_env, seeded_db, monkeypatch):
        """dry-run 不需要 auth, 即使 MAILAGENT_CLI_API_KEY 设了."""
        monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "secret-token")
        # 不传 --api-key 也能跑
        result = _invoke_flag(
            cli_runner, "12345", "--is-read", "--dry-run",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output


# ============================================================
# Auth
# ============================================================

class TestAuth:
    def test_default_rejects_unauth(self, cli_runner, cli_env, seeded_db, monkeypatch):
        """默认 cli_env (token 空 + ALLOW_UNAUTH 空) → 写命令 exit 4 E_AUTH_FAILED."""
        # 显式清空 ALLOW_UNAUTH 防 conftest 漂移
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "")
        monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "")
        result = _invoke_flag(
            cli_runner, "12345", "--is-read",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 4, result.output
        payload = _extract(result.output)
        assert payload["error"]["code"] == "E_AUTH_FAILED"

    def test_allow_unauth_writes_dev_escape(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        """MAILAGENT_CLI_ALLOW_UNAUTH_WRITES=true + 服务端空 token = 放行."""
        monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "")
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        result = _invoke_flag(
            cli_runner, "12345", "--is-read",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output


# ============================================================
# Single email write
# ============================================================

class TestSingleWrite:
    def test_writes_outbox_double_target(self, cli_runner, cli_env, seeded_db, _unauth_writes_on):
        """单封 --is-flagged 应写 2 行 outbox (mailapp + notion), source='cli'."""
        # seeded_db: internal_id=12345, is_read=True, is_flagged=False
        result = _invoke_flag(
            cli_runner, "12345", "--is-flagged",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract(result.output)
        assert payload["data"]["dry_run"] is False
        assert payload["data"]["updated_ids"] == [12345]
        assert payload["data"]["payload"] == {"is_flagged": True}

        rows = _outbox_rows(seeded_db, 12345)
        assert len(rows) == 2
        targets = {r[1]: r for r in rows}
        assert "mailapp" in targets
        assert "notion" in targets
        # source='cli' 不被 echo prevention 拒
        assert targets["mailapp"][2] == "cli"
        assert targets["notion"][2] == "cli"
        # status 都是 pending
        assert targets["mailapp"][3] == "pending"
        assert targets["notion"][3] == "pending"

    def test_updates_sqlite_local_flags(self, cli_runner, cli_env, seeded_db, _unauth_writes_on):
        """is_read / is_flagged 立即写 email_metadata (echo prevention)."""
        # 初始 is_read=True; 我们改 is_flagged=True
        result = _invoke_flag(
            cli_runner, "12345", "--is-flagged",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output

        conn = sqlite3.connect(str(seeded_db))
        try:
            row = conn.execute(
                "SELECT is_read, is_flagged FROM email_metadata WHERE internal_id = ?",
                (12345,),
            ).fetchone()
        finally:
            conn.close()
        assert row == (1, 1)  # is_read 保留 True, is_flagged 更新为 True

    def test_processing_status_only_no_mailapp_outbox(
        self, cli_runner, cli_env, seeded_db, _unauth_writes_on,
    ):
        """只 --processing-status: MailAppFanout 不读这字段, mailapp outbox 不入队
        (mailapp_payload 为空 → enqueue 跳过)."""
        result = _invoke_flag(
            cli_runner, "12345", "--processing-status", "已完成",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract(result.output)
        entry = payload["data"]["outbox_entries"][0]
        assert entry["mailapp_outbox_id"] is None
        assert entry["notion_outbox_id"] > 0

        rows = _outbox_rows(seeded_db, 12345)
        # 只有 notion 一行
        assert len(rows) == 1
        assert rows[0][1] == "notion"

    def test_all_three_fields(self, cli_runner, cli_env, seeded_db, _unauth_writes_on):
        result = _invoke_flag(
            cli_runner, "12345",
            "--no-is-read", "--is-flagged", "--processing-status", "AI Reviewed",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract(result.output)
        assert payload["data"]["payload"] == {
            "is_read": False, "is_flagged": True, "processing_status": "AI Reviewed",
        }

        rows = _outbox_rows(seeded_db, 12345)
        assert len(rows) == 2

    def test_not_found_returns_in_result(self, cli_runner, cli_env, seeded_db, _unauth_writes_on):
        result = _invoke_flag(
            cli_runner, "99999", "--is-read",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract(result.output)
        assert payload["data"]["updated_ids"] == []
        assert payload["data"]["not_found"] == [99999]


# ============================================================
# Batch --ids
# ============================================================

class TestBatchIds:
    def test_batch_writes_outbox_for_each(self, cli_runner, cli_env, seeded_db, _unauth_writes_on):
        result = _invoke_flag(
            cli_runner, "--ids", "12345,12346", "--is-read",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract(result.output)
        assert set(payload["data"]["updated_ids"]) == {12345, 12346}
        # 2 邮件 × 2 target = 4 行
        rows_12345 = _outbox_rows(seeded_db, 12345)
        rows_12346 = _outbox_rows(seeded_db, 12346)
        assert len(rows_12345) == 2
        assert len(rows_12346) == 2

    def test_batch_partial_not_found(self, cli_runner, cli_env, seeded_db, _unauth_writes_on):
        result = _invoke_flag(
            cli_runner, "--ids", "12345,99999", "--is-read",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract(result.output)
        assert payload["data"]["updated_ids"] == [12345]
        assert payload["data"]["not_found"] == [99999]
        assert payload["meta"]["count"] == 1
        assert payload["meta"]["not_found_count"] == 1
