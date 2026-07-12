"""admin + llm READ endpoints: envelope conformance + temp-DB resilience.

These are repo-backed reads (meta.source='sqlite'). We assert the §3.4 envelope
and that they degrade gracefully on the trimmed test schema:
  - admin/health returns 200 with healthy:false (some REQUIRED_TABLES absent in
    the trimmed fixture) and a correct db_version_expected.
  - llm/stats returns 200 with the table-missing fallback (no llm_processing
    table in the fixture).

admin/stats is exercised against an ISOLATED repo because the endpoint
constructs a real SyncStore, whose __init__ runs _init_database() and would
mutate (create v17 tables on) the shared session DB.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

import pytest

from src.api.deps import get_repository
from src.repository import AttachmentStore, EmailRepository


def _meta_sqlite(body: dict) -> None:
    assert body["status"] == "success"
    assert body["schema_version"] == 1
    assert body["error"] is None
    assert body["meta"]["source"] == "sqlite"
    assert body["meta"]["duration_ms"] >= 0


# ---------------------------------------------------------------------------
# GET /api/admin/health
# ---------------------------------------------------------------------------


def test_admin_health_envelope_and_version(client):
    from src.mail.sync_store import SyncStore

    r = client.get("/api/admin/health")
    assert r.status_code == 200  # healthy:false still returns 200 by design.
    body = r.json()
    _meta_sqlite(body)

    data = body["data"]
    assert data["db_accessible"] is True
    assert data["db_version"] == SyncStore.DB_VERSION
    assert data["db_version_expected"] == SyncStore.DB_VERSION
    # The trimmed fixture lacks some REQUIRED_TABLES → reported missing, not crash.
    assert "tables_missing" in data
    assert isinstance(data["tables_present"], list)
    assert "email_metadata" in data["tables_present"]
    # C9: host file layout must NOT leak — no absolute db_path in the payload.
    assert "db_path" not in data


def test_admin_health_workers_and_davmail_fields(client, tmp_path):
    """E4 WP1/WP2: /api/admin/health 追加 workers 心跳 + davmail 摘要 + 动态 notes.

    isolated DB (自建 sync_state + supervise/watchdog 键) → 断言字段反解与
    CLI 面对齐; 纯诊断字段不改 healthy 计算语义。
    """
    from src.api.app import app

    db = tmp_path / "health.db"
    conn = sqlite3.connect(str(db))
    conn.execute(
        "CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT, updated_at REAL)"
    )
    now = time.time()
    from src.mail.sync_store import SyncStore

    for k, v in (
        ("db_version", str(SyncStore.DB_VERSION)),
        ("worker.fanout.status", "running"),
        ("worker.fanout.restart_count", "1"),
        ("worker.watcher.status", "crashloop_stopped"),
        ("worker.watcher.last_error", "RuntimeError('boom')"),
        ("davmail.last_probe_at", "2026-07-11T00:00:00+00:00"),
        ("davmail.token_age_days", "85.3"),
        ("davmail.imap_reachable", "1"),
    ):
        conn.execute(
            "INSERT INTO sync_state (key, value, updated_at) VALUES (?,?,?)",
            (k, v, now),
        )
    conn.commit()
    conn.close()

    repo = EmailRepository(
        db_path=str(db),
        attachment_store=AttachmentStore(base_dir=str(tmp_path / "att")),
    )
    app.dependency_overrides[get_repository] = lambda: repo
    try:
        r = client.get("/api/admin/health")
    finally:
        app.dependency_overrides.pop(get_repository, None)

    assert r.status_code == 200
    data = r.json()["data"]
    # healthy 语义不变: 该 DB 缺 REQUIRED_TABLES → healthy false, 但与新字段无关
    assert data["healthy"] is False

    workers = data["workers"]
    assert workers["fanout"]["status"] == "running"
    assert workers["fanout"]["restart_count"] == 1
    assert workers["watcher"]["status"] == "crashloop_stopped"

    davmail = data["davmail"]
    assert davmail["token_age_days"] == 85.3
    assert davmail["imap_reachable"] is True

    combined = " ".join(data["notes"])
    assert "crash-loop 停摆" in combined
    assert "85.3" in combined  # token 老化提示 (≥80d)


def test_admin_health_worker_staleness(client, tmp_path):
    """E4 第二批 D3: last_started_at 早于 max(service.start_history) → stale:true;
    晚于 / **boot 同一秒** → 不写字段; 缺 last_started_at / 垃圾值 → 不炸不标
    (与 CLI 面对齐)."""
    import json as _json
    from datetime import datetime, timezone

    from src.api.app import app
    from src.mail.sync_store import SyncStore

    db = tmp_path / "stale.db"
    conn = sqlite3.connect(str(db))
    conn.execute(
        "CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT, updated_at REAL)"
    )
    now = time.time()
    # 本次 boot = 1 分钟前, 强制带小数 (真实 time.time() 形态) —— 秒粒度对齐回归:
    # worker 心跳 ISO 是整秒截断, float 直比会把 boot 同秒启动的 worker 误标 stale。
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
    for k, v in (
        ("db_version", str(SyncStore.DB_VERSION)),
        ("service.start_history", _json.dumps([boot_at - 7200, boot_at])),
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
            "INSERT INTO sync_state (key, value, updated_at) VALUES (?,?,?)",
            (k, v, now),
        )
    conn.commit()
    conn.close()

    repo = EmailRepository(
        db_path=str(db),
        attachment_store=AttachmentStore(base_dir=str(tmp_path / "att")),
    )
    app.dependency_overrides[get_repository] = lambda: repo
    try:
        r = client.get("/api/admin/health")
    finally:
        app.dependency_overrides.pop(get_repository, None)

    assert r.status_code == 200
    workers = r.json()["data"]["workers"]
    assert workers["old_worker"]["stale"] is True
    assert "stale" not in workers["fresh_worker"]
    assert "stale" not in workers["same_second"]
    assert "stale" not in workers["no_heartbeat"]
    assert "stale" not in workers["bad_ts"]


def test_admin_health_workers_empty_on_trimmed_fixture(client):
    """无 worker.% / davmail.* 键 → workers={} davmail=null notes=[] (不臆造)."""
    r = client.get("/api/admin/health")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["workers"] == {}
    assert data["davmail"] is None
    assert data["notes"] == []


def test_admin_health_redacts_db_path_on_error(client, tmp_path):
    """C9: a missing DB → error field carries a generic message with no path.

    Point the repo at a non-existent file; the endpoint must still 200 with
    healthy:false and an ``error`` that does not contain the (absolute) path.
    """
    from src.api.app import app
    from src.repository import AttachmentStore, EmailRepository

    ghost = tmp_path / "deep" / "nested" / "ghost.db"  # never created
    repo = EmailRepository(
        db_path=str(ghost),
        attachment_store=AttachmentStore(base_dir=str(tmp_path / "att")),
    )
    app.dependency_overrides[get_repository] = lambda: repo
    try:
        r = client.get("/api/admin/health")
    finally:
        # Drop our override; the function-scoped `client` fixture re-installs its
        # own get_repository override fresh for every test, so popping is enough.
        app.dependency_overrides.pop(get_repository, None)

    assert r.status_code == 200
    data = r.json()["data"]
    assert data["db_accessible"] is False
    assert "db_path" not in data
    assert data.get("error") == "database file not found"
    # The absolute path / any path separator-bearing fragment must not appear.
    assert str(ghost) not in data.get("error", "")
    assert "ghost.db" not in data.get("error", "")


# ---------------------------------------------------------------------------
# GET /api/llm/stats
# ---------------------------------------------------------------------------


def test_llm_stats_table_missing_fallback(client):
    """No llm_processing table in the fixture → zeroed rollup, 200."""
    r = client.get("/api/llm/stats", params={"days": 7})
    assert r.status_code == 200
    body = r.json()
    _meta_sqlite(body)
    data = body["data"]
    assert data["total"] == 0
    assert data["by_status"] == {}
    assert data["days"] == 7
    assert data["cost"]["input_tokens"] == 0
    assert data["_source"] == "table_missing"


def test_llm_stats_days_zero_invalid(client):
    r = client.get("/api/llm/stats", params={"days": 0})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_llm_stats_all_time_days_minus_one(client):
    r = client.get("/api/llm/stats", params={"days": -1})
    assert r.status_code == 200
    assert r.json()["data"]["days"] == -1
    assert r.json()["data"]["since_ts"] is None


# ---------------------------------------------------------------------------
# GET /api/admin/dead-letter
# ---------------------------------------------------------------------------


def test_admin_dead_letter_empty(client):
    """No dead_letter rows in the fixture → empty list + count meta."""
    r = client.get("/api/admin/dead-letter")
    assert r.status_code == 200
    body = r.json()
    _meta_sqlite(body)
    assert body["data"] == []
    assert body["meta"]["count"] == 0
    assert body["meta"]["limit"] == 50


def test_admin_dead_letter_limit_out_of_range_400(client):
    r = client.get("/api/admin/dead-letter", params={"limit": 0})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"

    r = client.get("/api/admin/dead-letter", params={"limit": 9999})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


# ---------------------------------------------------------------------------
# GET /api/admin/stats — C6: read endpoint must NOT mutate the DB
# ---------------------------------------------------------------------------


@pytest.fixture()
def isolated_client(client, tmp_path: Path):
    """Client whose repo points at a fresh empty DB.

    Post-C6 the endpoint no longer instantiates SyncStore (which would run
    _init_database / migrations), so an empty file must yield a zeroed section
    without any DDL. The private DB keeps the shared session fixture untouched.
    """
    from src.api.app import app

    db = tmp_path / "iso.db"
    sqlite3.connect(str(db)).close()  # bare file: no tables.
    iso_repo = EmailRepository(
        db_path=str(db),
        attachment_store=AttachmentStore(base_dir=str(tmp_path / "att")),
    )
    app.dependency_overrides[get_repository] = lambda: iso_repo
    yield client
    # Restore handled by the outer `client` fixture teardown popping the override.


def test_admin_stats_envelope(isolated_client):
    r = isolated_client.get("/api/admin/stats")
    assert r.status_code == 200
    body = r.json()
    _meta_sqlite(body)
    section = body["data"]["sync_store"]
    # Empty DB → zeroed section, shape present (table-missing falls back to 0/{}).
    assert section["total_emails"] == 0
    assert section["by_status"] == {}
    assert section["by_mailbox"] == {}
    assert section["failure_queue"] == 0
    assert section["last_max_row_id"] is None
    assert section["last_sync_time"] is None
    assert section["_source"] == "live_query"


def test_admin_stats_does_not_mutate_db(client, tmp_path: Path):
    """C6 regression: GET /api/admin/stats must not create/migrate any table.

    The pre-fix code built ``SyncStore(db_path)`` whose __init__ runs
    _init_database() (CREATE TABLE IF NOT EXISTS + db_version write). We point the
    repo at a bare DB, hit stats, and assert the DB is *still bare* afterwards.
    """
    from src.api.app import app

    db = tmp_path / "bare.db"
    sqlite3.connect(str(db)).close()  # zero tables.

    def _tables() -> set[str]:
        conn = sqlite3.connect(str(db))
        try:
            return {
                r[0]
                for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
        finally:
            conn.close()

    assert _tables() == set()  # precondition: truly empty.

    repo = EmailRepository(
        db_path=str(db),
        attachment_store=AttachmentStore(base_dir=str(tmp_path / "att")),
    )
    app.dependency_overrides[get_repository] = lambda: repo
    try:
        r = client.get("/api/admin/stats")
    finally:
        app.dependency_overrides.pop(get_repository, None)

    assert r.status_code == 200
    assert r.json()["data"]["sync_store"]["total_emails"] == 0
    # The decisive assertion: no schema was materialised by the read endpoint.
    assert _tables() == set()


def test_admin_stats_counts_from_shared_fixture(client):
    """Stats reflect the seeded corpus via read-only SQL (no SyncStore build)."""
    r = client.get("/api/admin/stats")
    assert r.status_code == 200
    section = r.json()["data"]["sync_store"]
    # Fixture seeds 2 emails: one 'synced' (收件箱), one 'pending' (收件箱).
    assert section["total_emails"] == 2
    assert section["by_status"].get("synced") == 1
    assert section["by_status"].get("pending") == 1
    assert section["by_mailbox"].get("收件箱") == 2
    assert section["_source"] == "live_query"
