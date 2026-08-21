"""v67 —— contact 表本体的三条读路径索引 (task 08-20 通讯录后端性能批)。

盯四件事:
① 新库满梯子后三条索引全在, 且 db_version = 67;
② v66 老库升级 (退回 66 + DROP 三条索引) 能补上, 数据一行不动;
③ 重入幂等 (版本拨回 66 重跑不炸、结果不变);
④ 失败不落 version: 索引名被别人占了 → 迁移 raise, 版本停在 66。

🔴 降级模拟只 DROP INDEX 不 DROP COLUMN (仓内教训「迁移测试禁 DROP COLUMN 一律重建」)。
另附: 三条索引**不在** `CONTACT_INDEX_DDLS` 里 —— 那一组会被 v54 块对老库重放,
混进去等于给 v54..v66 每个中间版本加一个新炸点 (v52 教训)。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import (
    CONTACT_INDEX_DDLS,
    CONTACT_V67_INDEXES,
    SyncStore,
    SyncStoreMigrationError,
    _INITIALIZED_DBS,
)

V67_INDEX_NAMES = {name for name, _ in CONTACT_V67_INDEXES}


def _contact_indexes(path) -> set[str]:
    with sqlite3.connect(path) as conn:
        return {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index' "
                "AND tbl_name='contact' AND name NOT LIKE 'sqlite_%'"
            )
        }


def _version(path) -> str:
    with sqlite3.connect(path) as conn:
        return conn.execute(
            "SELECT value FROM sync_state WHERE key='db_version'"
        ).fetchone()[0]


def _downgrade_to_v66(path) -> None:
    """退回 v66 形状: 三条索引删掉 + db_version 拨回 66 (表结构 v66 与 v67 完全相同,
    本版本是纯索引版)。🔴 顺带清进程内 init 门闩 —— 否则第二次构造 SyncStore 会被
    门闩挡在 DDL 之外, 这个用例就永远测不到迁移本身。"""
    with sqlite3.connect(path) as conn:
        for name in V67_INDEX_NAMES:
            conn.execute(f"DROP INDEX IF EXISTS {name}")
        conn.execute("UPDATE sync_state SET value='66' WHERE key='db_version'")
        conn.commit()
    _INITIALIZED_DBS.clear()


def test_fresh_db_has_all_three_indexes(tmp_path):
    path = tmp_path / "fresh.db"
    SyncStore(str(path))
    assert V67_INDEX_NAMES <= _contact_indexes(path)
    assert _version(path) == "67"


def test_v66_upgrade_adds_indexes_without_touching_rows(tmp_path):
    path = tmp_path / "upgrade.db"
    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO contact (id, display_name, kind, is_self, mail_count, "
            "sent_to_count, created_at, updated_at) VALUES (1,'Alice','person',0,9,3,1,1)"
        )
        conn.commit()
    _downgrade_to_v66(path)
    assert _contact_indexes(path).isdisjoint(V67_INDEX_NAMES)

    SyncStore(str(path))
    assert V67_INDEX_NAMES <= _contact_indexes(path)
    assert _version(path) == "67"
    with sqlite3.connect(path) as conn:
        row = conn.execute(
            "SELECT display_name, mail_count, sent_to_count FROM contact WHERE id=1"
        ).fetchone()
    assert row == ("Alice", 9, 3)


def test_replay_is_idempotent(tmp_path):
    path = tmp_path / "replay.db"
    SyncStore(str(path))
    before = _contact_indexes(path)
    assert V67_INDEX_NAMES <= before  # 没这句, 三条索引全没建时本用例也会「通过」
    # 只拨版本号不删索引 = 老库半程重放: CREATE INDEX IF NOT EXISTS 必须照常收敛。
    with sqlite3.connect(path) as conn:
        conn.execute("UPDATE sync_state SET value='66' WHERE key='db_version'")
        conn.commit()
    _INITIALIZED_DBS.clear()
    SyncStore(str(path))
    assert _contact_indexes(path) == before
    assert _version(path) == "67"


def test_index_name_taken_by_other_object_fails_without_bumping_version(tmp_path):
    path = tmp_path / "conflict.db"
    SyncStore(str(path))
    _downgrade_to_v66(path)
    with sqlite3.connect(path) as conn:
        # 用同名索引占位但建在别的表上 → CREATE INDEX 撞名, 且 guard 复查
        # sqlite_master 时**能**找到同名对象……所以这里必须占成「建不出来又查不到」:
        # 建一个同名的 view (CREATE INDEX 会 OperationalError, guard 查 type='index'
        # 查不到 → 真失败)。
        conn.execute("CREATE VIEW idx_contact_known AS SELECT 1")
        conn.commit()
    with pytest.raises(SyncStoreMigrationError):
        SyncStore(str(path))
    assert _version(path) == "66"


def test_v67_indexes_stay_out_of_contact_index_ddls():
    """🔴 防回: 三条索引若被塞进 `CONTACT_INDEX_DDLS`, v54 块会对老库整组重放它们。"""
    joined = " ".join(CONTACT_INDEX_DDLS)
    for name in V67_INDEX_NAMES:
        assert name not in joined
