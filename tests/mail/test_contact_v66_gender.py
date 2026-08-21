"""v66 contact.gender 列迁移。"""

from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import SyncStore


def _columns(path) -> set[str]:
    with sqlite3.connect(path) as conn:
        return {row[1] for row in conn.execute("PRAGMA table_info(contact)")}


def _version(path) -> int:
    with sqlite3.connect(path) as conn:
        return int(
            conn.execute(
                "SELECT value FROM sync_state WHERE key='db_version'"
            ).fetchone()[0]
        )


def test_v66_gender_column_fresh_replay_and_idempotency(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    assert "gender" in _columns(path)
    with sqlite3.connect(path) as conn, pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO contact (gender, kind, created_at, updated_at) "
            "VALUES ('unknown', 'person', 1, 1)"
        )

    with sqlite3.connect(path) as conn:
        conn.execute("ALTER TABLE contact DROP COLUMN gender")
        conn.execute("UPDATE sync_state SET value='65' WHERE key='db_version'")
        conn.commit()
    assert "gender" not in _columns(path)

    SyncStore(str(path))
    SyncStore(str(path))
    # 版本判据用 `>= 66`: 本用例盯的是 gender 列迁移, 不该在每次 bump DB_VERSION 时
    # 跟着改数字 (== 常量那种写法在 v67 那次 bump 上当场红了)。
    assert "gender" in _columns(path) and _version(path) >= 66
