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

    def test_workers_empty_and_davmail_null_without_state_keys(
        self, cli_runner, cli_env, seeded_db,
    ):
        """E4 WP1/WP2: 无 worker.% / davmail.* 键时新字段为空值, notes 不变."""
        from src.cli.commands import admin

        result = _invoke_admin(
            cli_runner, "health", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        data = _extract_last_json_object(result.output)["data"]
        assert data["workers"] == {}
        assert data["davmail"] is None
        assert data["notes"] == list(admin.HEALTH_WATCH_NOTES)

    def test_workers_heartbeat_and_davmail_summary(
        self, cli_runner, cli_env, seeded_db,
    ):
        """E4 WP1/WP2: supervise 心跳键 + davmail.* 键 → workers/davmail 字段 +
        crashloop 停摆 / token 老化的动态 notes; healthy 语义不受影响."""
        import sqlite3
        import time

        conn = sqlite3.connect(str(seeded_db))
        now = time.time()
        for k, v in (
            ("worker.fanout.status", "running"),
            ("worker.fanout.last_started_at", "2026-07-11T00:00:00+00:00"),
            ("worker.fanout.restart_count", "2"),
            ("worker.watcher.status", "crashloop_stopped"),
            ("worker.watcher.last_error", "RuntimeError('boom')"),
            ("davmail.last_probe_at", "2026-07-11T00:00:00+00:00"),
            ("davmail.token_age_days", "85.3"),
            ("davmail.imap_reachable", "1"),
        ):
            conn.execute(
                "INSERT OR REPLACE INTO sync_state (key, value, updated_at) "
                "VALUES (?,?,?)",
                (k, v, now),
            )
        conn.commit()
        conn.close()

        result = _invoke_admin(
            cli_runner, "health", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        data = _extract_last_json_object(result.output)["data"]
        # 纯诊断字段, 不改 healthy 计算语义 (crashloop 也不翻 healthy)
        assert data["healthy"] is True

        workers = data["workers"]
        assert workers["fanout"]["status"] == "running"
        assert workers["fanout"]["restart_count"] == 2
        assert workers["fanout"]["last_started_at"] == "2026-07-11T00:00:00+00:00"
        assert workers["watcher"]["status"] == "crashloop_stopped"

        davmail = data["davmail"]
        assert davmail["token_age_days"] == 85.3
        assert davmail["imap_reachable"] is True

        combined = " ".join(data["notes"])
        assert "crash-loop 停摆" in combined
        assert "watcher" in combined
        assert "85.3" in combined  # token 老化提示 (≥80d)

    def test_worker_staleness_from_start_history(
        self, cli_runner, cli_env, seeded_db,
    ):
        """E4 第二批 D3: last_started_at 早于本次 boot → stale:true;
        晚于 / **boot 同一秒** → 不写字段; 缺 last_started_at / 垃圾值 → 不炸不标."""
        import json
        import sqlite3
        import time
        from datetime import datetime, timezone

        now = time.time()
        # 本次 boot = 1 分钟前, 强制带小数 (真实 time.time() 形态) —— 秒粒度对齐
        # 回归: 心跳 ISO 是整秒截断, float 直比会把同秒启动的 worker 误标 stale。
        boot_at = int(now) - 60 + 0.7
        before_boot = datetime.fromtimestamp(
            boot_at - 3600, tz=timezone.utc,
        ).isoformat(timespec="seconds")
        after_boot = datetime.fromtimestamp(
            boot_at + 30, tz=timezone.utc,
        ).isoformat(timespec="seconds")
        same_second = datetime.fromtimestamp(
            int(boot_at), tz=timezone.utc,
        ).isoformat(timespec="seconds")  # floor(boot_at) < boot_at, 但同一秒

        conn = sqlite3.connect(str(seeded_db))
        for k, v in (
            ("service.start_history", json.dumps([boot_at - 7200, boot_at])),
            ("worker.old_worker.status", "running"),
            ("worker.old_worker.last_started_at", before_boot),
            ("worker.fresh_worker.status", "running"),
            ("worker.fresh_worker.last_started_at", after_boot),
            ("worker.same_second.status", "running"),
            ("worker.same_second.last_started_at", same_second),
            ("worker.no_heartbeat.status", "running"),
            ("worker.bad_ts.status", "running"),
            ("worker.bad_ts.last_started_at", "not-a-timestamp"),
        ):
            conn.execute(
                "INSERT OR REPLACE INTO sync_state (key, value, updated_at) "
                "VALUES (?,?,?)",
                (k, v, now),
            )
        conn.commit()
        conn.close()

        result = _invoke_admin(
            cli_runner, "health", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        workers = _extract_last_json_object(result.output)["data"]["workers"]
        assert workers["old_worker"]["stale"] is True
        assert "stale" not in workers["fresh_worker"]
        assert "stale" not in workers["same_second"]
        assert "stale" not in workers["no_heartbeat"]
        assert "stale" not in workers["bad_ts"]

    def test_davmail_token_age_sentinel_maps_to_null(
        self, cli_runner, cli_env, seeded_db,
    ):
        """token_age_days 的 '-1' 哨兵 (token 文件不可读) → None, 不触发老化 note."""
        import sqlite3
        import time

        conn = sqlite3.connect(str(seeded_db))
        now = time.time()
        for k, v in (
            ("davmail.last_probe_at", "2026-07-11T00:00:00+00:00"),
            ("davmail.token_age_days", "-1"),
            ("davmail.imap_reachable", "0"),
        ):
            conn.execute(
                "INSERT OR REPLACE INTO sync_state (key, value, updated_at) "
                "VALUES (?,?,?)",
                (k, v, now),
            )
        conn.commit()
        conn.close()

        result = _invoke_admin(
            cli_runner, "health", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        data = _extract_last_json_object(result.output)["data"]
        assert data["davmail"]["token_age_days"] is None
        assert data["davmail"]["imap_reachable"] is False
        assert not any("未刷新" in n for n in data["notes"])


class TestAdminExportDiagnostics:
    def test_export_diagnostics_smoke(
        self, cli_runner, cli_env, seeded_db, tmp_path, monkeypatch,
    ):
        """E4 第二批 D2 smoke: envelope data 形状 {zip_path,size_bytes,entry_count,
        skipped} + zip 五件套 + config_snapshot 无明文邮箱 (cli_env USER_EMAIL)."""
        import json as _json
        import shutil
        import zipfile
        from pathlib import Path

        logs_dir = tmp_path / "diag-logs"
        logs_dir.mkdir()
        (logs_dir / "sync.log").write_text("hello diagnostic log")
        # log_file 定 DATA_ROOT/logs 派生根; 指到 tmp 免打包真实 repo logs/
        monkeypatch.setenv("LOG_FILE", str(logs_dir / "sync.log"))

        result = _invoke_admin(
            cli_runner, "export-diagnostics",
            "--app-version", "9.9.9", "--no-quick-check", "-o", "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        data = _extract_last_json_object(result.output)["data"]
        assert set(data) == {"zip_path", "size_bytes", "entry_count", "skipped"}
        zip_path = Path(data["zip_path"])
        assert zip_path.exists()
        assert data["size_bytes"] == zip_path.stat().st_size > 0
        assert isinstance(data["entry_count"], int) and data["entry_count"] >= 5
        assert isinstance(data["skipped"], list)

        try:
            with zipfile.ZipFile(zip_path) as zf:
                names = set(zf.namelist())
                for required in (
                    "health.json", "config_snapshot.json",
                    "db_check.json", "manifest.json",
                ):
                    assert required in names
                assert "logs/sync.log" in names

                manifest = _json.loads(zf.read("manifest.json"))
                assert manifest["app_version"] == "9.9.9"

                health = _json.loads(zf.read("health.json"))
                assert health["healthy"] is True

                # 值级邮箱脱敏: USER_EMAIL=test@example.com 绝不明文出现
                snapshot_text = zf.read("config_snapshot.json").decode("utf-8")
                assert "test@example.com" not in snapshot_text
                assert "***@***" in snapshot_text
        finally:
            # zip 落在 mkdtemp (契约: 前端 copy 后清理); 测试自行清理
            shutil.rmtree(zip_path.parent, ignore_errors=True)


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
