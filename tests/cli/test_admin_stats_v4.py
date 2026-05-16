"""admin stats v4_rollout section tests (PR-4 US-008).

Covers:
- v4_rollout 无数据时 _source=no_data_yet
- 有数据时 _source=stats_reporter_last_snapshot + 字段完整
- staleness > 300s 加 _warn_stale
- --section v4_rollout 只返回该段
"""

from __future__ import annotations

import sqlite3
import time

import pytest

from tests.cli.conftest import extract_last_json_object as _xj


def _invoke_stats(cli_runner, *args, db_path):
    from src.cli.main import app

    return cli_runner.invoke(
        app, ["--db-path", str(db_path), "admin", "stats", *args],
    )


class TestV4RolloutSection:
    def test_no_data_yet(self, cli_runner, cli_env, seeded_db):
        result = _invoke_stats(
            cli_runner, "--section", "v4_rollout", "-o", "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _xj(result.output)
        v4 = payload["data"]["v4_rollout"]
        assert v4["_source"] == "no_data_yet"

    def test_with_snapshot_returns_real_data(self, cli_runner, cli_env, seeded_db):
        # 直接写一条 v4_rollout_stats 行
        conn = sqlite3.connect(str(seeded_db))
        try:
            conn.execute(
                """INSERT INTO v4_rollout_stats
                     (flushed_at, from_sqlite_hit, fallback_miss, fallback_error,
                      route_latency_p99_ms, body_miss_internal_ids, window_seconds)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (time.time(), 100, 5, 1, 12.5, '[53001, 53002]', 60),
            )
            conn.commit()
        finally:
            conn.close()

        result = _invoke_stats(
            cli_runner, "--section", "v4_rollout", "-o", "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _xj(result.output)
        v4 = payload["data"]["v4_rollout"]
        assert v4["_source"] == "stats_reporter_last_snapshot"
        assert v4["from_sqlite_hit"] == 100
        assert v4["fallback_miss"] == 5
        assert v4["fallback_error"] == 1
        assert v4["route_latency_p99_ms"] == pytest.approx(12.5)
        assert v4["body_miss_internal_ids"] == [53001, 53002]
        assert v4["window_seconds"] == 60
        assert v4["_staleness_seconds"] is not None and v4["_staleness_seconds"] >= 0
        # 新鲜数据不应加 _warn_stale
        assert "_warn_stale" not in v4

    def test_stale_snapshot_emits_warning(self, cli_runner, cli_env, seeded_db):
        # 1 小时前的 snapshot
        ts_old = time.time() - 3600
        conn = sqlite3.connect(str(seeded_db))
        try:
            conn.execute(
                """INSERT INTO v4_rollout_stats
                     (flushed_at, from_sqlite_hit, fallback_miss, fallback_error,
                      route_latency_p99_ms, body_miss_internal_ids, window_seconds)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (ts_old, 50, 0, 0, 5.0, None, 60),
            )
            conn.commit()
        finally:
            conn.close()

        result = _invoke_stats(
            cli_runner, "--section", "v4_rollout", "-o", "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 0
        payload = _xj(result.output)
        v4 = payload["data"]["v4_rollout"]
        assert v4["_staleness_seconds"] > 300
        assert "_warn_stale" in v4
        assert "stale" in v4["_warn_stale"].lower() or "old" in v4["_warn_stale"].lower()

    def test_section_filter_only_v4(self, cli_runner, cli_env, seeded_db):
        result = _invoke_stats(
            cli_runner, "--section", "v4_rollout", "-o", "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 0
        payload = _xj(result.output)
        # data 只含 v4_rollout, 不含其他 section
        assert "v4_rollout" in payload["data"]
        assert "watcher" not in payload["data"]
        assert "sync_store" not in payload["data"]
