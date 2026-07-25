"""GET /api/kos/stats — envelope conformance + 与 CLI 单源一致 (issue #59, PRD R8)。

聚合语义的覆盖在 tests/kos/test_stats.py; 这里锁的是路由层契约:
envelope / days 边界 / 表缺失降级 / 有数据时确实读的是同一个聚合函数。

有数据的用例用 ISOLATED repo (自建临时库 + dependency_overrides), 不往 session 共享
库里建 kos_ingest_log —— 与 admin/stats 的隔离理由同款。
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from src.api.app import app
from src.api.deps import get_repository
from src.kos.ingest_log import (
    STATE_HEALTH_CHECKED_AT,
    STATE_HEALTH_CONSEC_FAILURES,
    STATE_HEALTH_STATUS,
    STATE_LAST_SUCCESS_AT,
)
from src.mail.sync_store import KOS_INGEST_LOG_TABLE_DDL as _DDL_LOG
from src.repository import AttachmentStore, EmailRepository

_DDL_STATE = """
CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT, updated_at REAL)
"""


@pytest.fixture(autouse=True)
def _pin_enabled_env(monkeypatch: pytest.MonkeyPatch):
    """enabled 判据会热读开发机 .env —— 钉死, 否则断言随机器漂。"""
    monkeypatch.setenv("MAILAGENT_KOS_INGEST_ENABLED", "false")


def _meta_sqlite(body: dict) -> None:
    assert body["status"] == "success"
    assert body["schema_version"] == 1
    assert body["error"] is None
    assert body["meta"]["source"] == "sqlite"
    assert body["meta"]["duration_ms"] >= 0


@pytest.fixture()
def kos_client(tmp_path: Path, attach_dir: Path):
    """TestClient 指向自建的、带 kos_ingest_log 数据的临时库。"""
    db = tmp_path / "kos.db"
    now = time.time()
    conn = sqlite3.connect(str(db))
    conn.execute(_DDL_LOG)
    conn.execute(_DDL_STATE)
    conn.executemany(
        "INSERT INTO kos_ingest_log "
        "(internal_id, status, pushed_at, retry_count, next_retry_at, error_code, source) "
        "VALUES (?,?,?,?,?,?,?)",
        [
            (1, "pushed", now, 0, None, None, "producer"),
            (2, "pushed", now, 0, None, None, "bulk"),
            (3, "failed", now, 2, now + 300, "E_KOS_NETWORK", "producer"),
            (4, "dead", now, 5, None, "E_KOS_TOKEN_NETWORK", "producer"),
            (5, "skipped", now, 0, None, None, "producer"),
        ],
    )
    conn.executemany(
        "INSERT INTO sync_state (key, value, updated_at) VALUES (?,?,?)",
        [
            (STATE_LAST_SUCCESS_AT, str(now), now),
            (STATE_HEALTH_STATUS, "ok", now),
            (STATE_HEALTH_CHECKED_AT, str(now), now),
            (STATE_HEALTH_CONSEC_FAILURES, "0", now),
        ],
    )
    conn.commit()
    conn.close()

    repo = EmailRepository(
        db_path=str(db), attachment_store=AttachmentStore(base_dir=str(attach_dir))
    )
    app.dependency_overrides[get_repository] = lambda: repo
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    app.dependency_overrides.pop(get_repository, None)


def test_kos_stats_table_missing_fallback(client):
    """fixture 库没有 kos_ingest_log → 零值形状, 200。"""
    r = client.get("/api/kos/stats", params={"days": 7})
    assert r.status_code == 200
    body = r.json()
    _meta_sqlite(body)

    data = body["data"]
    assert data["_source"] == "table_missing"
    assert data["total"] == 0
    assert data["by_status"] == {"pushed": 0, "failed": 0, "dead": 0, "skipped": 0}
    assert data["pending_retry"] == 0
    assert data["dead_count"] == 0
    assert data["days"] == 7
    assert len(data["daily"]) == 7


def test_kos_stats_days_zero_invalid(client):
    r = client.get("/api/kos/stats", params={"days": 0})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_kos_stats_all_time_days_minus_one(client):
    r = client.get("/api/kos/stats", params={"days": -1})
    assert r.status_code == 200
    assert r.json()["data"]["days"] == -1
    assert r.json()["data"]["since_ts"] is None


def test_kos_stats_live_query(kos_client):
    r = kos_client.get("/api/kos/stats", params={"days": 7})
    assert r.status_code == 200
    body = r.json()
    _meta_sqlite(body)

    data = body["data"]
    assert data["enabled"] is False  # 由 _pin_enabled_env 钉住
    assert data["_source"] == "live_query"
    assert data["total"] == 5
    assert data["by_status"] == {"pushed": 2, "failed": 1, "dead": 1, "skipped": 1}
    assert data["by_error_code"] == {"E_KOS_NETWORK": 1, "E_KOS_TOKEN_NETWORK": 1}
    assert data["pending_retry"] == 1
    assert data["dead_count"] == 1
    assert data["health"]["ok"] is True
    assert data["health"]["checked_at"] is not None
    assert data["last_success_ts"] is not None
    assert len(data["daily"]) == 7


def test_kos_stats_matches_single_source(kos_client, tmp_path: Path):
    """路由与 CLI 同一个聚合函数 —— 端点 data 必须与直调结果逐字段相等。"""
    from src.kos.stats import collect_kos_stats

    # kos_client fixture 请求的是同一个 test-scoped tmp_path → 同一个库文件。
    db = tmp_path / "kos.db"
    direct = collect_kos_stats(db, days=7)
    via_http = kos_client.get("/api/kos/stats", params={"days": 7}).json()["data"]

    # since_ts / daily 依赖调用时刻, 其余字段应完全一致。
    for key in ("enabled", "by_status", "by_error_code", "pending_retry",
                "dead_count", "total", "health", "_source"):
        assert via_http[key] == direct[key], key
