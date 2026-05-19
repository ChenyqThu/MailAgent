"""tests/cli/test_admin_stage4.py — Sprint 15 Stage 4.

`mailagent admin fts-health / pm2-status / queue-depth / stats --section outbox`.
"""

from __future__ import annotations

import json
import sqlite3
import subprocess
import time
from unittest.mock import patch, MagicMock

import pytest

from tests.cli.conftest import extract_last_json_object as _extract


def _invoke_admin(cli_runner, *args, db_path):
    from src.cli.main import app
    return cli_runner.invoke(app, ["--db-path", str(db_path), "admin", *args])


# ============================================================
# admin fts-health
# ============================================================

class TestFtsHealth:
    def test_fts_health_synced(self, cli_runner, cli_env, seeded_db):
        result = _invoke_admin(
            cli_runner, "fts-health", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract(result.output)
        d = payload["data"]
        assert d["body_rows"] >= 1
        assert d["fts_rows"] >= 1
        assert d["gap"] == 0
        assert d["integrity_check"] == "ok"
        assert d["healthy"] is True
        assert isinstance(d["fts_size_bytes"], int)

    def test_fts_health_unhealthy_when_gap(self, cli_runner, cli_env, seeded_db):
        """手工删一行 fts → gap > 0 → healthy=False."""
        conn = sqlite3.connect(str(seeded_db))
        try:
            conn.execute("DELETE FROM email_body_fts WHERE rowid = 12345")
            conn.commit()
        finally:
            conn.close()

        result = _invoke_admin(
            cli_runner, "fts-health", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0
        payload = _extract(result.output)
        assert payload["data"]["gap"] >= 1
        assert payload["data"]["healthy"] is False


# ============================================================
# admin pm2-status
# ============================================================

class TestPm2Status:
    def test_pm2_not_installed_handled(self, cli_runner, cli_env, seeded_db):
        with patch("subprocess.run", side_effect=FileNotFoundError("pm2")):
            result = _invoke_admin(
                cli_runner, "pm2-status", "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0, result.output
        payload = _extract(result.output)
        assert payload["data"]["pm2_available"] is False
        assert payload["data"]["mail_sync"] is None
        assert "pm2 CLI not installed" in payload["data"]["error"]

    def test_pm2_mail_sync_online(self, cli_runner, cli_env, seeded_db):
        fake_jlist = [
            {
                "name": "mail-sync",
                "pid": 12345,
                "pm2_env": {
                    "status": "online",
                    "pm_uptime": int((time.time() - 3600) * 1000),
                    "restart_time": 2,
                },
                "monit": {"memory": 100 * 1024 * 1024, "cpu": 1.5},
            },
        ]
        fake_result = MagicMock(
            returncode=0,
            stdout=json.dumps(fake_jlist),
            stderr="",
        )
        with patch("subprocess.run", return_value=fake_result):
            result = _invoke_admin(
                cli_runner, "pm2-status", "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        payload = _extract(result.output)
        ms = payload["data"]["mail_sync"]
        assert ms is not None
        assert ms["online"] is True
        assert ms["pid"] == 12345
        assert ms["memory_mb"] == 100.0
        assert ms["cpu_percent"] == 1.5
        assert ms["restart_count"] == 2
        assert 3500 <= ms["uptime_sec"] <= 3700

    def test_pm2_mail_sync_not_running(self, cli_runner, cli_env, seeded_db):
        """pm2 jlist 返回但 mail-sync 不在 → mail_sync=null."""
        fake_result = MagicMock(returncode=0, stdout="[]", stderr="")
        with patch("subprocess.run", return_value=fake_result):
            result = _invoke_admin(
                cli_runner, "pm2-status", "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        payload = _extract(result.output)
        assert payload["data"]["pm2_available"] is True
        assert payload["data"]["mail_sync"] is None

    def test_pm2_timeout(self, cli_runner, cli_env, seeded_db):
        with patch(
            "subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd="pm2", timeout=5.0),
        ):
            result = _invoke_admin(
                cli_runner, "pm2-status", "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        payload = _extract(result.output)
        assert payload["data"]["pm2_available"] is False
        assert "timeout" in payload["data"]["error"].lower()


# ============================================================
# admin queue-depth
# ============================================================

class TestQueueDepth:
    def test_basic_shape(self, cli_runner, cli_env, seeded_db):
        result = _invoke_admin(
            cli_runner, "queue-depth", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract(result.output)
        d = payload["data"]
        # 3 块都在
        assert "sync_store" in d
        assert "outbox" in d
        assert "llm_processing" in d
        # sync_store 子字段
        for k in ("pending", "fetch_failed", "failed", "dead_letter"):
            assert k in d["sync_store"]
        # outbox 子字段
        for k in ("pending", "processing", "failed", "dead_letter", "done", "total"):
            assert k in d["outbox"]

    def test_reflects_outbox_data(self, cli_runner, cli_env, seeded_db):
        """写 2 行 outbox + 1 个标记 done → queue-depth 反映状态."""
        from src.sync.outbox import OutboxRepository
        repo = OutboxRepository(str(seeded_db))
        oid1 = repo.enqueue(
            internal_id=12345, op_type="flag_sync", target="mailapp", payload={}
        )
        oid2 = repo.enqueue(
            internal_id=12345, op_type="flag_sync", target="notion", payload={}
        )
        repo.mark_processing(oid1)
        repo.mark_done(oid1)

        result = _invoke_admin(
            cli_runner, "queue-depth", "-o", "json", db_path=seeded_db,
        )
        payload = _extract(result.output)
        ob = payload["data"]["outbox"]
        assert ob["done"] == 1
        assert ob["pending"] == 1
        assert ob["total"] == 2

    def test_sync_store_reflects_seeded(self, cli_runner, cli_env, seeded_db):
        """seeded_db 含 1 synced + 1 failed → sync_store section."""
        result = _invoke_admin(
            cli_runner, "queue-depth", "-o", "json", db_path=seeded_db,
        )
        payload = _extract(result.output)
        ss = payload["data"]["sync_store"]
        assert ss["synced"] == 1
        assert ss["failed"] == 1


# ============================================================
# admin stats --section outbox 扩展
# ============================================================

class TestStatsOutboxSection:
    def test_section_outbox(self, cli_runner, cli_env, seeded_db):
        result = _invoke_admin(
            cli_runner, "stats", "--section", "outbox", "-o", "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _extract(result.output)
        assert "outbox" in payload["data"]
        ob = payload["data"]["outbox"]
        assert "by_status" in ob
        assert "by_target" in ob
        assert "age_buckets" in ob
        assert "total" in ob

    def test_section_all_includes_outbox(self, cli_runner, cli_env, seeded_db):
        result = _invoke_admin(
            cli_runner, "stats", "--section", "all", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0
        payload = _extract(result.output)
        # outbox 段必须在 all 视图里
        assert "outbox" in payload["data"]
