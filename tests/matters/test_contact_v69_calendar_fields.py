"""v69 —— contact 的日历三列 meeting_count / last_met_at / next_meeting_at
(task 08-24 L4 批次 1 · 通讯录日历第三源)。

盯四件事:
① 新库满梯子后三列全在, 且 db_version 推到当前 `SyncStore.DB_VERSION`
   (动态取值 —— 后续批次 bump schema 时本文件不用改);
② v68 老库升级能补上三列, 既有行一个字段不动, 新列取默认值 (0 / NULL / NULL);
③ 重入幂等 (版本拨回 68 重跑不炸, 已有值不被清零);
④ fresh create 与迁移后 contact 的**列集**等价 (列序有偏移是 ALTER ADD 的既有事实)。

🔴 降级模拟按仓规「迁移测试禁 DROP COLUMN 一律重建」: 从 canonical DDL 摘掉三行
列定义重建老形状表。摘取器带断言 —— 摘不到三行就直接红, 不静默造出一张与 v68
不同形状的表 (那样 ② 会变成假绿)。
"""

from __future__ import annotations

import sqlite3

from src.mail.sync_store import (
    CONTACT_TABLE_DDLS,
    CONTACT_V67_INDEXES,
    SyncStore,
    _INITIALIZED_DBS,
)

V69_COLUMNS = ("meeting_count", "last_met_at", "next_meeting_at")


def _columns(path, table: str = "contact") -> list[str]:
    with sqlite3.connect(path) as conn:
        return [row[1] for row in conn.execute(f"PRAGMA table_info({table})")]


def _version(path) -> str:
    with sqlite3.connect(path) as conn:
        return conn.execute(
            "SELECT value FROM sync_state WHERE key='db_version'"
        ).fetchone()[0]


def _v68_contact_ddl() -> str:
    """canonical contact DDL 去掉三列 = v68 形状 (建成临时表名)。"""
    ddl = next(d for d in CONTACT_TABLE_DDLS if "IF NOT EXISTS contact (" in d)
    kept: list[str] = []
    dropped: list[str] = []
    for line in ddl.splitlines():
        stripped = line.strip()
        column = stripped.split(" ", 1)[0]
        if column in V69_COLUMNS:
            dropped.append(column)
            continue
        kept.append(line)
    assert sorted(dropped) == sorted(V69_COLUMNS), (
        f"摘取器没在 canonical DDL 里找全三列 (只摘到 {dropped}) —— "
        "老形状造错了, 下面的升级用例会变成假绿"
    )
    return "\n".join(kept).replace("IF NOT EXISTS contact (", "IF NOT EXISTS contact_v68 (", 1)


def _downgrade_to_v68(path) -> None:
    """contact 退回 v68 形状 (重建, 不 DROP COLUMN) + db_version 拨回 68。

    🔴 顺带清进程内 init 门闩 —— 否则第二次构造 SyncStore 被门闩挡在 DDL 之外,
    这个用例就永远测不到迁移本身。
    """
    keep = [c for c in _columns(path) if c not in V69_COLUMNS]
    cols = ", ".join(keep)
    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute(_v68_contact_ddl())
        conn.execute(f"INSERT INTO contact_v68 ({cols}) SELECT {cols} FROM contact")
        conn.execute("DROP TABLE contact")
        conn.execute("ALTER TABLE contact_v68 RENAME TO contact")
        # v68 老库上这三条索引是在位的 (v67 建的, 随表重建掉了) —— 补回来, 免得
        # 升级后的形状与真实老库不一致。
        for _name, ddl in CONTACT_V67_INDEXES:
            conn.execute(ddl)
        conn.execute("UPDATE sync_state SET value='68' WHERE key='db_version'")
        conn.commit()
    _INITIALIZED_DBS.clear()


def _seed_contact(path) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO contact (id, display_name, kind, is_self, mail_count, "
            "sent_to_count, first_seen_at, last_seen_at, created_at, updated_at) "
            "VALUES (1,'Alice','person',0,9,3,100,900,10,20)"
        )
        conn.commit()


def test_fresh_db_has_calendar_columns(tmp_path):
    path = tmp_path / "fresh.db"
    SyncStore(str(path))
    assert set(V69_COLUMNS) <= set(_columns(path))
    assert _version(path) == str(SyncStore.DB_VERSION)


def test_v68_upgrade_adds_columns_without_touching_rows(tmp_path):
    path = tmp_path / "upgrade.db"
    SyncStore(str(path))
    _seed_contact(path)
    _downgrade_to_v68(path)
    assert set(_columns(path)).isdisjoint(V69_COLUMNS)

    SyncStore(str(path))

    assert set(V69_COLUMNS) <= set(_columns(path))
    assert _version(path) == str(SyncStore.DB_VERSION)
    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        row = dict(conn.execute("SELECT * FROM contact WHERE id=1").fetchone())
    # 既有字段一个不动
    assert (row["display_name"], row["mail_count"], row["sent_to_count"]) == ("Alice", 9, 3)
    assert (row["first_seen_at"], row["last_seen_at"]) == (100, 900)
    # 新列取默认值: 计数 0, 两个时间 NULL (存量不回填 —— 会议史由扫描器重算)
    assert row["meeting_count"] == 0
    assert row["last_met_at"] is None and row["next_meeting_at"] is None


def test_replay_keeps_existing_values(tmp_path):
    """老库半程重放 (只拨版本号不动列): 三列不能被再 ALTER 一次, 值也不许清零。"""
    path = tmp_path / "replay.db"
    SyncStore(str(path))
    _seed_contact(path)
    with sqlite3.connect(path) as conn:
        conn.execute(
            "UPDATE contact SET meeting_count=4, last_met_at=1700000000000, "
            "next_meeting_at=1800000000000 WHERE id=1"
        )
        conn.execute("UPDATE sync_state SET value='68' WHERE key='db_version'")
        conn.commit()
    _INITIALIZED_DBS.clear()

    SyncStore(str(path))

    with sqlite3.connect(path) as conn:
        row = conn.execute(
            "SELECT meeting_count, last_met_at, next_meeting_at FROM contact WHERE id=1"
        ).fetchone()
    assert row == (4, 1700000000000, 1800000000000)
    assert _version(path) == str(SyncStore.DB_VERSION)


def test_migrated_column_set_equals_fresh(tmp_path):
    fresh = tmp_path / "fresh2.db"
    SyncStore(str(fresh))

    migrated = tmp_path / "migrated.db"
    SyncStore(str(migrated))
    _downgrade_to_v68(migrated)
    SyncStore(str(migrated))

    assert set(_columns(migrated)) == set(_columns(fresh))
