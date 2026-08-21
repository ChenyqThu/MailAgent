"""v68 —— notification 通知中心条目表 (task 08-20-notification-center 步骤 2)。

盯四件事:
① 新库满梯子后表在, 列集合**逐字**相等 (漏一列 / 多一列都红), 三条索引全在;
② v67 老库升级 (DROP TABLE + 版本拨回 67) 能补上, 连开两次 SyncStore 幂等;
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
    CONTACT_SUGGESTION_INDEX_DDLS,
    MATTER_INDEX_DDLS,
    NOTIFICATION_INDEX_DDLS,
    NOTIFICATION_TABLE_DDLS,
    SyncStore,
    _INITIALIZED_DBS,
)

EXPECTED_COLUMNS = {
    "id",
    "category",
    "source",
    "severity",
    "state",
    "dedupe_key",
    "recurrence_no",
    "title",
    "body",
    "payload_json",
    "first_created_at",
    "last_event_at",
    "read_at",
    "snoozed_until",
    "resolved_at",
    "dismissed_at",
}

EXPECTED_INDEXES = {
    "uq_notification_active_dedupe",
    "idx_notification_list",
    "idx_notification_unread",
}


def _columns(path) -> set:
    with sqlite3.connect(path) as conn:
        return {row[1] for row in conn.execute("PRAGMA table_info(notification)")}


def _indexes(path) -> set:
    with sqlite3.connect(path) as conn:
        return {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index' "
                "AND tbl_name='notification' AND name NOT LIKE 'sqlite_%'"
            )
        }


def _version(path) -> int:
    with sqlite3.connect(path) as conn:
        return int(
            conn.execute(
                "SELECT value FROM sync_state WHERE key='db_version'"
            ).fetchone()[0]
        )


def test_v68_fresh_database_has_notification_table(tmp_path):
    path = tmp_path / "sync.db"
    store = SyncStore(str(path))
    assert store.DB_VERSION >= 68
    assert _columns(path) == EXPECTED_COLUMNS
    assert EXPECTED_INDEXES <= _indexes(path)
    assert _version(path) == SyncStore.DB_VERSION


def test_v68_partial_unique_dedupe_guards_active_rows(tmp_path):
    """活跃期内同 dedupe_key 只允许一条 —— 计次语义的数据库最终防线。

    resolved 之后同 key 能再落一行 (跨代复活), 否则 publish 的「resolved 后开新行」
    规则会在库这一层被挡死。
    """
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    insert = (
        "INSERT INTO notification "
        "(category, source, severity, state, dedupe_key, title, "
        " first_created_at, last_event_at) "
        "VALUES ('results', 'agent_run', 'info', ?, 'agent_run:1', '标题', 1000, 1000)"
    )
    with sqlite3.connect(path) as conn:
        conn.execute(insert, ("open",))
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(insert, ("snoozed",))  # snoozed 同样算活跃
        conn.execute("UPDATE notification SET state='resolved', resolved_at=2000")
        conn.execute(insert, ("open",))  # 关掉之后同 key 可以再开一条 (新的一代)
        conn.commit()
        assert conn.execute("SELECT COUNT(*) FROM notification").fetchone()[0] == 2


def test_v67_to_v68_replay_and_idempotency(tmp_path):
    """老库降级模拟 + 连开两次。

    🔴 顺带清进程内 init 门闩: 门闩只在 `current_version == DB_VERSION` 时短路,
    这里版本已拨回 67 所以自然会重跑迁移, clear 是保险 (别的用例可能先建过同 inode)。
    """
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TABLE notification")
        conn.execute("UPDATE sync_state SET value='67' WHERE key='db_version'")
        conn.commit()
    _INITIALIZED_DBS.clear()
    assert _columns(path) == set()  # 没这句, 表没被删掉时本用例也会「通过」

    SyncStore(str(path))
    SyncStore(str(path))
    assert _columns(path) == EXPECTED_COLUMNS
    assert EXPECTED_INDEXES <= _indexes(path)
    assert _version(path) == SyncStore.DB_VERSION


def test_notification_ddls_stay_out_of_other_groups():
    """🔴 防回: 混进 CONTACT_*/MATTER_* 任一组, 那些组的旧块就会对老库重放本表。"""
    joined = " ".join(
        (*CONTACT_INDEX_DDLS, *CONTACT_SUGGESTION_INDEX_DDLS, *MATTER_INDEX_DDLS)
    )
    assert "notification" not in joined
    assert all("notification" in ddl for ddl in NOTIFICATION_TABLE_DDLS)
    assert all("notification" in ddl for ddl in NOTIFICATION_INDEX_DDLS)
