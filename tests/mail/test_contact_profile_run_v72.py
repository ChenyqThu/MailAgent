"""v72 —— contact_profile_run 画像执行台账 (task 08-27-l4-tab-workspace P4a)。

盯四件事:
① 新库满梯子后表在, 列集合**逐字**相等 (漏一列 / 多一列都红), 索引在;
② v71 老库升级 (DROP TABLE + 版本拨回 71) 能补上, 连开两次 SyncStore 幂等;
③ 版本推进到 `SyncStore.DB_VERSION` (不写死数字 —— 后续批次 bump 时本文件不用改);
④ 防回: 本组 DDL **不进** CONTACT_*/MATTER_* 既有组 (那几组会被旧块对老库整组重放,
   v52 教训)。

🔴 全程 tmp_path 建库, 绝不碰 userData / 仓库 data/ 的真实库。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import (
    CONTACT_INDEX_DDLS,
    CONTACT_PROFILE_RUN_INDEX_DDLS,
    CONTACT_PROFILE_RUN_TABLE_DDLS,
    CONTACT_SUGGESTION_INDEX_DDLS,
    MATTER_INDEX_DDLS,
    MATTER_TABLE_DDLS,
    SyncStore,
    _INITIALIZED_DBS,
)

EXPECTED_COLUMNS = {
    "id",
    "started_at",
    "completed_at",
    "status",
    "candidates",
    "ran",
    "ok_count",
    "skipped",
    "failed",
    "error",
}

EXPECTED_INDEXES = {"idx_contact_profile_run_recent"}


def _columns(path) -> set:
    with sqlite3.connect(path) as conn:
        return {row[1] for row in conn.execute("PRAGMA table_info(contact_profile_run)")}


def _indexes(path) -> set:
    with sqlite3.connect(path) as conn:
        return {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index' "
                "AND tbl_name='contact_profile_run' AND name NOT LIKE 'sqlite_%'"
            )
        }


def _version(path) -> int:
    with sqlite3.connect(path) as conn:
        return int(
            conn.execute(
                "SELECT value FROM sync_state WHERE key='db_version'"
            ).fetchone()[0]
        )


def test_v72_fresh_database_has_contact_profile_run_table(tmp_path):
    path = tmp_path / "sync.db"
    store = SyncStore(str(path))
    assert store.DB_VERSION >= 72
    assert _columns(path) == EXPECTED_COLUMNS
    assert EXPECTED_INDEXES <= _indexes(path)
    assert _version(path) == SyncStore.DB_VERSION


def test_v72_status_check_rejects_unknown_value(tmp_path):
    """status 三值域是库这一层的最终防线 —— 写进第四个值就是记录列上一个渲染不出的状态。"""
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    insert = (
        "INSERT INTO contact_profile_run "
        "(started_at, completed_at, status, candidates, ran, ok_count, skipped, failed) "
        "VALUES (1000, 2000, ?, 0, 0, 0, 0, 0)"
    )
    with sqlite3.connect(path) as conn:
        for good in ("ok", "fail", "noop"):
            conn.execute(insert, (good,))
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(insert, ("running",))
        conn.commit()
        assert conn.execute("SELECT COUNT(*) FROM contact_profile_run").fetchone()[0] == 3


def test_v71_to_v72_replay_and_idempotency(tmp_path):
    """老库降级模拟 + 连开两次。

    🔴 顺带清进程内 init 门闩: 门闩只在 `current_version == DB_VERSION` 时短路, 这里版本
    已拨回 71 所以自然会重跑迁移, clear 是保险 (别的用例可能先建过同 inode)。
    🔴 迁移测试不用 DROP COLUMN —— 本版本是纯新表, DROP TABLE 即可 (房规: 要去列一律重建)。
    """
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TABLE contact_profile_run")
        conn.execute("UPDATE sync_state SET value='71' WHERE key='db_version'")
        conn.commit()
    _INITIALIZED_DBS.clear()
    assert _columns(path) == set()  # 没这句, 表没被删掉时本用例也会「通过」

    SyncStore(str(path))
    SyncStore(str(path))
    assert _columns(path) == EXPECTED_COLUMNS
    assert EXPECTED_INDEXES <= _indexes(path)
    assert _version(path) == SyncStore.DB_VERSION


def test_v72_replay_preserves_existing_rows(tmp_path):
    """幂等重放不能把既有台账冲掉 (CREATE TABLE IF NOT EXISTS 而不是 DROP + CREATE)。"""
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO contact_profile_run "
            "(started_at, completed_at, status, candidates, ran, ok_count, skipped, failed) "
            "VALUES (1000, 2000, 'ok', 3, 3, 3, 0, 0)"
        )
        conn.execute("UPDATE sync_state SET value='71' WHERE key='db_version'")
        conn.commit()
    _INITIALIZED_DBS.clear()

    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM contact_profile_run").fetchone()[0] == 1


def test_contact_profile_run_ddls_stay_out_of_other_groups():
    """🔴 防回: 混进 CONTACT_*/MATTER_* 任一组, 那些组的旧块就会对老库重放本表。"""
    joined = " ".join(
        (
            *CONTACT_INDEX_DDLS,
            *CONTACT_SUGGESTION_INDEX_DDLS,
            *MATTER_INDEX_DDLS,
            *MATTER_TABLE_DDLS,
        )
    )
    assert "contact_profile_run" not in joined
    assert all("contact_profile_run" in ddl for ddl in CONTACT_PROFILE_RUN_TABLE_DDLS)
    assert all("contact_profile_run" in ddl for ddl in CONTACT_PROFILE_RUN_INDEX_DDLS)
