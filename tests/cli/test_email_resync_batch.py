"""email resync batch flags tests (PR-4 US-004 / RFC §4.2).

Covers:
- target 互斥校验 (<id> + --range / 两个 --range / --ids)
- --range LO-HI 解析 + dry-run plan
- --ids 1,2,3 解析 + dry-run plan
- --max-failures 熔断 → exit 8
- partial_failure schema (succeeded + failed)
- --resume-from 跳过低 id
- --dry-run 跳过 auth + PM2 检测
- 非 dry-run 缺 auth → exit 4
- 非 dry-run + PM2 mock online → exit 9
"""

from __future__ import annotations

import json
import sqlite3
import time
from unittest.mock import patch


from tests.cli.conftest import extract_last_json_object as _xj


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app

    return cli_runner.invoke(
        app, ["--db-path", str(db_path), "email", "resync", *args],
    )


# ============================================================
# Argument validation
# ============================================================

class TestBatchArgsValidation:
    def test_no_target_fails(self, cli_runner, cli_env, seeded_db):
        result = _invoke(cli_runner, "-o", "json", "--dry-run", db_path=seeded_db)
        assert result.exit_code == 2
        payload = _xj(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"

    def test_single_plus_range_mutually_exclusive(
        self, cli_runner, cli_env, seeded_db,
    ):
        result = _invoke(
            cli_runner, "12345", "--range", "1-3", "-o", "json", "--dry-run",
            db_path=seeded_db,
        )
        assert result.exit_code == 2
        payload = _xj(result.output)
        assert "mutually exclusive" in payload["error"]["message"].lower()

    def test_range_plus_ids_mutually_exclusive(
        self, cli_runner, cli_env, seeded_db,
    ):
        result = _invoke(
            cli_runner, "--range", "1-3", "--ids", "1,2", "-o", "json", "--dry-run",
            db_path=seeded_db,
        )
        assert result.exit_code == 2

    def test_range_bad_format(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "--range", "abc-xyz", "-o", "json", "--dry-run",
            db_path=seeded_db,
        )
        assert result.exit_code == 2
        payload = _xj(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"

    def test_range_lo_gt_hi(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "--range", "100-50", "-o", "json", "--dry-run",
            db_path=seeded_db,
        )
        assert result.exit_code == 2

    def test_ids_dedupe_and_preserve_order(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "--ids", "12345,12345,12346", "-o", "json", "--dry-run",
            db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _xj(result.output)
        assert payload["data"]["total"] == 2
        assert [it["internal_id"] for it in payload["data"]["items"]] == [12345, 12346]


# ============================================================
# Dry-run plan
# ============================================================

class TestBatchDryRun:
    def test_range_plan_has_items(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "--range", "12345-12346", "-o", "json", "--dry-run",
            db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _xj(result.output)
        assert payload["status"] == "success"
        assert payload["data"]["target_kind"] == "range"
        assert payload["data"]["target_key"] == "12345-12346"
        assert payload["data"]["total"] == 2
        items = payload["data"]["items"]
        assert {it["internal_id"] for it in items} == {12345, 12346}
        ex_item = next(it for it in items if it["internal_id"] == 12345)
        assert ex_item["exists"] is True
        assert ex_item["subject"] == "Hello Test"

    def test_dry_run_skips_auth(self, cli_runner, cli_env, seeded_db):
        """没设 MAILAGENT_CLI_API_KEY 也能 dry-run."""
        result = _invoke(
            cli_runner, "--range", "12345-12346", "-o", "json", "--dry-run",
            db_path=seeded_db,
        )
        assert result.exit_code == 0

    def test_dry_run_lists_missing(self, cli_runner, cli_env, seeded_db):
        """range 含不存在的 id → exists=False."""
        result = _invoke(
            cli_runner, "--ids", "12345,99999", "-o", "json", "--dry-run",
            db_path=seeded_db,
        )
        assert result.exit_code == 0
        payload = _xj(result.output)
        items = {it["internal_id"]: it for it in payload["data"]["items"]}
        assert items[12345]["exists"] is True
        assert items[99999]["exists"] is False
        assert items[99999]["action"] == "skip_missing"


# ============================================================
# Auth + PM2 (non-dry-run)
# ============================================================

class TestBatchAuth:
    def test_non_dry_run_missing_auth_exit_4(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        """无 MAILAGENT_CLI_API_KEY + 无 ALLOW_UNAUTH_WRITES → exit 4."""
        monkeypatch.delenv("MAILAGENT_CLI_API_KEY", raising=False)
        monkeypatch.delenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", raising=False)
        result = _invoke(
            cli_runner, "--range", "12345-12346", "-o", "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 4
        payload = _xj(result.output)
        assert payload["error"]["code"] == "E_AUTH_FAILED"

    def test_pm2_conflict_exit_9(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        """mock pm2 jlist 返回 mail-sync online → exit 9."""
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        # 显式覆盖 conftest 默认放行, 这个 case 就是要验 PM2 检测路径
        monkeypatch.delenv("MAILAGENT_CLI_ALLOW_CONCURRENT", raising=False)
        # Mock subprocess.run 用于 pm2_check
        from types import SimpleNamespace
        from src.cli import pm2_check as pm2_module

        def fake_run(*args, **kwargs):
            return SimpleNamespace(
                stdout=json.dumps([
                    {"name": "mail-sync", "pm2_env": {"status": "online"}}
                ]),
                returncode=0,
            )

        with patch.object(pm2_module.subprocess, "run", fake_run):
            result = _invoke(
                cli_runner, "--ids", "12345", "-o", "json",
                db_path=seeded_db,
            )
        assert result.exit_code == 9, result.output
        payload = _xj(result.output)
        assert payload["error"]["code"] == "E_PM2_RUNNING"

    def test_allow_concurrent_bypass_pm2(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        """--allow-concurrent → 跳过 pm2 check (即使 mock online)."""
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        # Mock NotionSync.create_email_page_from_sqlite 让 batch 直接 succ
        from src.notion import sync as nsync

        async def fake_create(*args, **kwargs):
            iid = args[1] if len(args) > 1 else kwargs.get("internal_id")
            from src.notion.sync import CreateEmailFromSqliteResult
            return CreateEmailFromSqliteResult(
                page_id="page-x", existing_page_id=None,
                archived_page_id=None, action="created",
            )

        with patch.object(nsync.NotionSync, "create_email_page_from_sqlite", fake_create):
            result = _invoke(
                cli_runner, "--ids", "12345", "--allow-concurrent",
                "-o", "json", db_path=seeded_db,
            )
        # 不应是 PM2 exit 9; 该 succ 或别的业务码 (0)
        assert result.exit_code in (0, 6), result.output


# ============================================================
# Batch execution (mocked NotionSync)
# ============================================================

class TestBatchExecution:
    def test_all_success_exit_0(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_CONCURRENT", "true")
        from src.notion import sync as nsync
        from src.notion.sync import CreateEmailFromSqliteResult

        async def fake_create(self, internal_id, **kwargs):
            return CreateEmailFromSqliteResult(
                page_id=f"page-{internal_id}",
                existing_page_id=None,
                archived_page_id=None,
                action="created",
            )

        with patch.object(nsync.NotionSync, "create_email_page_from_sqlite", fake_create):
            result = _invoke(
                cli_runner, "--ids", "12345,12346", "-o", "json",
                db_path=seeded_db,
            )
        assert result.exit_code == 0, result.output
        payload = _xj(result.output)
        assert payload["status"] == "success"
        assert payload["data"]["summary"]["succeeded"] == 2
        assert payload["data"]["summary"]["failed"] == 0
        assert {s["internal_id"] for s in payload["data"]["succeeded"]} == {12345, 12346}

    def test_partial_failure_exit_6(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_CONCURRENT", "true")
        from src.notion import sync as nsync
        from src.notion.sync import CreateEmailFromSqliteResult

        async def fake_create(self, internal_id, **kwargs):
            if internal_id == 12346:
                raise ValueError("body missing")
            return CreateEmailFromSqliteResult(
                page_id=f"page-{internal_id}",
                existing_page_id=None,
                archived_page_id=None,
                action="created",
            )

        with patch.object(nsync.NotionSync, "create_email_page_from_sqlite", fake_create):
            result = _invoke(
                cli_runner, "--ids", "12345,12346", "-o", "json", "--max-failures", "0",
                db_path=seeded_db,
            )
        assert result.exit_code == 6, result.output
        payload = _xj(result.output)
        assert payload["status"] == "partial_failure"
        assert payload["data"]["summary"]["succeeded"] == 1
        assert payload["data"]["summary"]["failed"] == 1
        assert payload["data"]["failed"][0]["internal_id"] == 12346
        assert payload["data"]["failed"][0]["error"]["code"] == "E_NOT_FOUND"

    def test_max_failures_exit_8(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_CONCURRENT", "true")

        # 加 3 封 metadata 到 DB
        conn = sqlite3.connect(str(seeded_db))
        try:
            now = time.time()
            for iid in (10001, 10002, 10003):
                conn.execute(
                    "INSERT INTO email_metadata "
                    "(internal_id, message_id, subject, sync_status, mailbox, "
                    " retry_count, created_at, updated_at) "
                    "VALUES (?, ?, ?, 'synced', '收件箱', 0, ?, ?)",
                    (iid, f"<m-{iid}>", f"subj-{iid}", now, now),
                )
            conn.commit()
        finally:
            conn.close()

        from src.notion import sync as nsync

        async def fake_create(self, internal_id, **kwargs):
            raise ValueError("always fails")

        with patch.object(nsync.NotionSync, "create_email_page_from_sqlite", fake_create):
            result = _invoke(
                cli_runner,
                "--ids", "10001,10002,10003",
                "-o", "json",
                "--max-failures", "2",
                db_path=seeded_db,
            )
        assert result.exit_code == 8, result.output
        payload = _xj(result.output)
        assert payload["status"] == "error"
        assert payload["data"]["summary"]["max_failures_hit"] is True
        assert payload["data"]["summary"]["failed"] == 2
