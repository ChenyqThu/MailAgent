"""v46 migration (Matters P4): matter_run 表 + 4 索引 + matter 绑定四列。

组织照 v45 先例（tests/matters/test_matter_v45_migration.py）：新库直建 / 45→46
升级路径 / 幂等重跑。
"""

from __future__ import annotations

import sqlite3

from src.mail.sync_store import SyncStore

BINDING_COLUMNS = (
    "agent_profile_id",
    "agent_enabled",
    "matter_instructions",
    "schedule_json",
)
RUN_INDEXES = (
    "uq_matter_run_idempotency",
    "uq_matter_run_one_active",
    "idx_matter_run_history",
    "idx_matter_run_async_job",
)


def _columns(path, table: str) -> set[str]:
    with sqlite3.connect(path) as conn:
        return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def _indexes(path) -> set[str]:
    with sqlite3.connect(path) as conn:
        return {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index'"
            )
        }


def _db_version(path) -> str:
    with sqlite3.connect(path) as conn:
        return conn.execute(
            "SELECT value FROM sync_state WHERE key='db_version'"
        ).fetchone()[0]


def downgrade_to_v45(path) -> None:
    """回退到 v45 形状：删 matter_run 表 + 删 matter 绑定四列 + version=45。"""
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TABLE matter_run")
        for column in BINDING_COLUMNS:
            conn.execute(f"ALTER TABLE matter DROP COLUMN {column}")
        conn.execute("UPDATE sync_state SET value='45' WHERE key='db_version'")
        conn.commit()


def test_v46_fresh_db_has_run_table_binding_columns_and_indexes(tmp_path):
    path = tmp_path / "fresh.db"
    SyncStore(str(path))
    assert BINDING_COLUMNS[0] in _columns(path, "matter")
    assert set(BINDING_COLUMNS) <= _columns(path, "matter")
    run_columns = _columns(path, "matter_run")
    assert {
        "id", "matter_id", "agent_profile_id", "async_job_id", "chat_session_id",
        "trigger_kind", "trigger_payload_json", "idempotency_key",
        "input_watermark_json", "output_watermark_json", "status", "model",
        "usage_json", "cost_usd", "error_json", "queued_at", "started_at",
        "completed_at", "cancel_requested_at", "canceled_at",
        "coalesced_trigger_count", "created_at",
    } <= run_columns
    assert set(RUN_INDEXES) <= _indexes(path)
    assert _db_version(path) == str(SyncStore.DB_VERSION)


def test_v46_upgrade_from_45_is_equivalent_to_fresh(tmp_path):
    fresh = tmp_path / "fresh.db"
    migrated = tmp_path / "migrated.db"
    SyncStore(str(fresh))
    SyncStore(str(migrated))
    downgrade_to_v45(migrated)
    assert "matter_run" not in {
        t
        for t in _indexes(migrated)
    }  # sanity: run indexes died with the table
    SyncStore(str(migrated))

    assert _columns(fresh, "matter") == _columns(migrated, "matter")
    assert _columns(fresh, "matter_run") == _columns(migrated, "matter_run")
    assert set(RUN_INDEXES) <= _indexes(migrated)
    assert _db_version(migrated) == str(SyncStore.DB_VERSION)


def test_v46_upgrade_preserves_existing_matter_rows_and_is_idempotent(tmp_path):
    path = tmp_path / "idempotent.db"
    SyncStore(str(path))
    downgrade_to_v45(path)
    with sqlite3.connect(path) as conn:
        conn.execute("INSERT INTO matter_seq(created_at) VALUES (1)")
        conn.execute(
            "INSERT INTO matter(public_id,title,created_at,updated_at) "
            "VALUES ('MAT-0001','Existing',1,1)"
        )
        conn.commit()
    SyncStore(str(path))
    SyncStore(str(path))  # 幂等重跑
    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM matter WHERE public_id='MAT-0001'").fetchone()
        assert row["title"] == "Existing"
        # ALTER 加列后默认值就位（agent_enabled NOT NULL DEFAULT 0）。
        assert row["agent_enabled"] == 0
        assert row["agent_profile_id"] is None
        # partial unique index 生效：同 matter 两条活跃(started)行必须被拒。
        conn.execute(
            "INSERT INTO matter_run(matter_id,trigger_kind,idempotency_key,"
            "queued_at,started_at,created_at) VALUES (1,'manual','k1',1,2,1)"
        )
        try:
            conn.execute(
                "INSERT INTO matter_run(matter_id,trigger_kind,idempotency_key,"
                "queued_at,started_at,created_at) VALUES (1,'manual','k2',1,2,1)"
            )
            raise AssertionError("uq_matter_run_one_active did not fire")
        except sqlite3.IntegrityError:
            pass
