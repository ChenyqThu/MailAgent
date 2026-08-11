from __future__ import annotations

import sqlite3

from src.mail.sync_store import SyncStore


TAG_COLUMNS = {"name", "color", "shape", "created_at"}


def _columns(path, table: str) -> set[str]:
    with sqlite3.connect(path) as conn:
        return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def _version(path) -> str:
    with sqlite3.connect(path) as conn:
        return conn.execute(
            "SELECT value FROM sync_state WHERE key='db_version'"
        ).fetchone()[0]


def _seed_matter(path, *, public_id: str, agent_enabled: int, schedule_json) -> None:
    """写一行"存量"事项，用来盯 v50 迁移有没有偷偷改既有数据。"""
    with sqlite3.connect(path) as conn:
        conn.execute("INSERT INTO matter_seq(created_at) VALUES (1)")
        conn.execute(
            "INSERT INTO matter(public_id,title,agent_enabled,schedule_json,"
            "created_at,updated_at) VALUES (?,?,?,?,1,1)",
            (public_id, "Existing", agent_enabled, schedule_json),
        )
        conn.commit()


def _downgrade_to_v49(path) -> None:
    """把库退回 v49 形状：删标签定义表 + 去掉 goal_checks_json 列。

    `goal_checks_json` 没有被任何索引或其它列的 CHECK 引用，所以 SQLite 的
    ``DROP COLUMN`` 在这里是干净的（本仓 SQLite ≥ 3.35）。
    """
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TABLE matter_tag")
        conn.execute("ALTER TABLE matter DROP COLUMN goal_checks_json")
        conn.execute("UPDATE sync_state SET value='49' WHERE key='db_version'")
        conn.commit()


def test_v50_fresh_db_has_tag_table_and_goal_checks(tmp_path):
    path = tmp_path / "fresh.db"
    SyncStore(str(path))
    assert TAG_COLUMNS <= _columns(path, "matter_tag")
    assert "goal_checks_json" in _columns(path, "matter")
    assert _version(path) == str(SyncStore.DB_VERSION)


def test_v50_new_matter_defaults_agent_enabled_on(tmp_path):
    """D2：建表默认从 0 翻成 1，**新建**事项默认开自动跟进。"""
    path = tmp_path / "default.db"
    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        conn.execute("INSERT INTO matter_seq(created_at) VALUES (1)")
        conn.execute(
            "INSERT INTO matter(public_id,title,created_at,updated_at) "
            "VALUES ('MAT-0001','Fresh',1,1)"
        )
        row = conn.execute(
            "SELECT agent_enabled, goal_checks_json FROM matter WHERE public_id='MAT-0001'"
        ).fetchone()
    assert row[0] == 1
    assert row[1] == "[]"


def test_v50_upgrade_from_49_matches_fresh_shape(tmp_path):
    fresh = tmp_path / "fresh.db"
    migrated = tmp_path / "migrated.db"
    SyncStore(str(fresh))
    SyncStore(str(migrated))
    _downgrade_to_v49(migrated)
    SyncStore(str(migrated))
    assert _columns(migrated, "matter") == _columns(fresh, "matter")
    assert _columns(migrated, "matter_tag") == _columns(fresh, "matter_tag")
    assert _version(migrated) == str(SyncStore.DB_VERSION)


def test_v50_upgrade_leaves_existing_rows_untouched(tmp_path):
    """🔴 D2 的硬约束：存量事项不回填 —— 升级不许把 agent_enabled 从 0 改成 1，
    也不许给没有排程的事项塞一个默认排程。用户没要求过的事项不该在升级后
    突然开始自动跑跟进。"""
    path = tmp_path / "existing.db"
    SyncStore(str(path))
    _downgrade_to_v49(path)
    _seed_matter(path, public_id="MAT-0001", agent_enabled=0, schedule_json=None)

    SyncStore(str(path))

    with sqlite3.connect(path) as conn:
        row = conn.execute(
            "SELECT agent_enabled, schedule_json, goal_checks_json FROM matter "
            "WHERE public_id='MAT-0001'"
        ).fetchone()
    assert row[0] == 0, "v50 migration must not flip agent_enabled on existing matters"
    assert row[1] is None, "v50 migration must not seed a schedule on existing matters"
    assert row[2] == "[]", "ALTER-added column should default to an empty list"


def test_v50_migration_rerun_is_idempotent(tmp_path):
    path = tmp_path / "idempotent.db"
    SyncStore(str(path))
    _downgrade_to_v49(path)
    SyncStore(str(path))
    SyncStore(str(path))
    assert TAG_COLUMNS <= _columns(path, "matter_tag")
    assert "goal_checks_json" in _columns(path, "matter")


def test_v50_tag_table_rejects_unknown_color_and_shape(tmp_path):
    path = tmp_path / "check.db"
    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO matter_tag(name,color,shape,created_at) "
            "VALUES ('ok','--c-ok','ring',1)"
        )
        for bad_color, bad_shape in (("#ff0000", "ring"), ("--c-ok", "triangle")):
            try:
                conn.execute(
                    "INSERT INTO matter_tag(name,color,shape,created_at) VALUES (?,?,?,1)",
                    (f"bad-{bad_color}-{bad_shape}", bad_color, bad_shape),
                )
                raise AssertionError(
                    f"matter_tag CHECK did not fire for ({bad_color}, {bad_shape})"
                )
            except sqlite3.IntegrityError:
                pass
