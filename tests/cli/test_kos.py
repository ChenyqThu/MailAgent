"""CLI kos 子命令测试 (issue #59 — 知识库入库台账统计)。

聚合语义的覆盖在 tests/kos/test_stats.py (单源函数); 这里只锁 CLI 侧契约:
group 挂上了 / json envelope 字段 / days 边界 / text 模式不炸。
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

from src.kos.ingest_log import (
    STATE_HEALTH_CONSEC_FAILURES,
    STATE_HEALTH_STATUS,
    STATE_LAST_SUCCESS_AT,
)
from src.mail.sync_store import KOS_INGEST_LOG_TABLE_DDL as _DDL_LOG
from tests.cli.conftest import extract_last_json_object as _last_json


import pytest


@pytest.fixture(autouse=True)
def _pin_enabled_env(monkeypatch: pytest.MonkeyPatch):
    """enabled 判据会热读开发机 .env —— 钉死, 否则断言随机器漂。"""
    monkeypatch.setenv("MAILAGENT_KOS_INGEST_ENABLED", "false")


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app
    return cli_runner.invoke(app, ["--db-path", str(db_path), *args])


def _seed_log(db_path: Path) -> None:
    now = time.time()
    conn = sqlite3.connect(str(db_path))
    conn.execute(_DDL_LOG)  # v41 migration 已建, 这里是 IF NOT EXISTS 的双保险
    conn.executemany(
        "INSERT INTO kos_ingest_log "
        "(internal_id, status, pushed_at, retry_count, next_retry_at, error_code, source) "
        "VALUES (?,?,?,?,?,?,?)",
        [
            (1, "pushed", now, 0, None, None, "producer"),
            (2, "failed", now, 2, now + 300, "E_KOS_NETWORK", "producer"),
            (3, "dead", now, 5, None, "E_KOS_TOKEN_NETWORK", "producer"),
            (4, "skipped", now, 0, None, None, "producer"),
        ],
    )
    conn.executemany(
        "INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES (?,?,?)",
        [
            (STATE_LAST_SUCCESS_AT, str(now), now),
            (STATE_HEALTH_STATUS, "ok", now),
            (STATE_HEALTH_CONSEC_FAILURES, "0", now),
        ],
    )
    conn.commit()
    conn.close()


def test_kos_stats_json_contract(cli_runner, empty_db: Path):
    _seed_log(empty_db)
    result = _invoke(cli_runner, "-o", "json", "kos", "stats", "--days", "7",
                     db_path=empty_db)
    assert result.exit_code == 0, result.output

    data = _last_json(result.output)["data"]

    assert data["enabled"] is False  # 由 _pin_enabled_env 钉住
    assert data["days"] == 7
    assert data["total"] == 4
    assert data["by_status"] == {
        "pushed": 1, "failed": 1, "dead": 1, "skipped": 1, "pending": 0,
    }
    assert data["by_error_code"] == {"E_KOS_NETWORK": 1, "E_KOS_TOKEN_NETWORK": 1}
    assert data["pending_retry"] == 1
    assert data["dead_count"] == 1
    assert data["health"]["ok"] is True
    assert data["last_success_ts"] is not None
    assert len(data["daily"]) == 7
    assert data["_source"] == "live_query"


def test_kos_stats_table_missing(cli_runner, empty_db: Path):
    """未经 v41 迁移的外部 / 旧库 (无 kos_ingest_log) → 零值不报错。

    v41 起 SyncStore 无条件建表 (D2), 正常路径恒有表 → 显式 DROP 模拟缺表现场
    (与 test_llm.py::test_stats_table_missing_fallback 同款)。
    """
    conn = sqlite3.connect(str(empty_db))
    try:
        conn.execute("DROP TABLE kos_ingest_log")
        conn.commit()
    finally:
        conn.close()

    result = _invoke(cli_runner, "-o", "json", "kos", "stats", db_path=empty_db)
    assert result.exit_code == 0, result.output

    data = _last_json(result.output)["data"]
    assert data["_source"] == "table_missing"
    assert data["total"] == 0
    assert data["by_status"] == {
        "pushed": 0, "failed": 0, "dead": 0, "skipped": 0, "pending": 0,
    }


def test_kos_stats_days_zero_rejected(cli_runner, empty_db: Path):
    result = _invoke(cli_runner, "-o", "json", "kos", "stats", "--days", "0",
                     db_path=empty_db)
    assert result.exit_code == 2
    assert _last_json(result.output)["error"]["code"] == "E_INVALID_ARG"


def test_kos_stats_all_time(cli_runner, empty_db: Path):
    _seed_log(empty_db)
    result = _invoke(cli_runner, "-o", "json", "kos", "stats", "--days", "-1",
                     db_path=empty_db)
    assert result.exit_code == 0, result.output
    data = _last_json(result.output)["data"]
    assert data["days"] == -1
    assert data["since_ts"] is None


def test_kos_stats_text_output(cli_runner, empty_db: Path):
    _seed_log(empty_db)
    result = _invoke(cli_runner, "-o", "text", "kos", "stats", db_path=empty_db)
    assert result.exit_code == 0, result.output
    assert "enabled=" in result.output
    assert "pending_retry" in result.output
    assert "dead_count" in result.output
    assert "E_KOS_NETWORK" in result.output


def test_kos_stats_enabled_true_with_producer_credentials(
    cli_runner, empty_db: Path, monkeypatch
):
    """开关 + 三个 producer 凭据齐全 → enabled=true (前端据此显区)。"""
    monkeypatch.setenv("MAILAGENT_KOS_INGEST_ENABLED", "true")
    monkeypatch.setenv("KOS_MCP_BASE", "https://kos.example.test")
    monkeypatch.setenv("MAILAGENT_BULK_CLIENT_ID", "cid")
    monkeypatch.setenv("MAILAGENT_BULK_CLIENT_SECRET", "secret")

    result = _invoke(cli_runner, "-o", "json", "kos", "stats", db_path=empty_db)
    assert result.exit_code == 0, result.output
    assert _last_json(result.output)["data"]["enabled"] is True
