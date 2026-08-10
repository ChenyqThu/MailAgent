from __future__ import annotations

import sqlite3

from src.mail.sync_store import SyncStore


MATTER_TABLES = {"matter_seq", "matter", "matter_item", "matter_event", "matter_update"}
MATTER_INDEXES = {
    "uq_matter_public_id",
    "idx_matter_live_status",
    "idx_matter_item_live",
    "uq_matter_event_dedupe",
    "idx_matter_event_timeline",
    "idx_matter_update_review",
}


def _names(path, object_type: str) -> set[str]:
    with sqlite3.connect(str(path)) as conn:
        return {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type=?", (object_type,)
            ).fetchall()
        }


def _version(path) -> int:
    with sqlite3.connect(str(path)) as conn:
        return int(
            conn.execute(
                "SELECT value FROM sync_state WHERE key='db_version'"
            ).fetchone()[0]
        )


def test_v44_adds_matter_tables_and_is_idempotent(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    with sqlite3.connect(str(path)) as conn:
        for table in MATTER_TABLES:
            conn.execute(f"DROP TABLE {table}")
        conn.execute("UPDATE sync_state SET value='43' WHERE key='db_version'")
        conn.commit()

    SyncStore(str(path))
    SyncStore(str(path))

    assert MATTER_TABLES <= _names(path, "table")
    assert MATTER_INDEXES <= _names(path, "index")
    # 版本终值跟 DB_VERSION 走（v45 起由 tests/matters/test_matter_v45_migration.py
    # 另行 pin 当前版本号）；本测试只钉 v44 语义——matter 五表/索引可从 43 幂等重建。
    assert _version(path) == SyncStore.DB_VERSION >= 44
