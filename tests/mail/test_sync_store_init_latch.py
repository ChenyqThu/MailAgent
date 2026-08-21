"""SyncStore 的进程内 init 门闩 (task 08-20 通讯录后端性能批 R3)。

serve-api 每个写请求 new 一个 ServiceContext ⇒ new 一个 SyncStore, 活库 log 实测
37 秒内跑了 16 次完整 `_init_database()`（129 条 CREATE IF NOT EXISTS + PRAGMA 探列）,
全在共享的事件循环上。门闩让「同一个库文件 + 已停在本版本」的重复构造只做一次廉价
版本探测。

本用例盯三件事:
① 复构造真的跳过了 DDL 重放 (不是「跑了但看不出来」);
② 门闩**不能**吞掉需要跑的迁移 —— 库被降版后必须重跑;
③ 门闩按 (路径, dev, ino) 记 —— 同路径删掉重建的库照样建表 (测试常这么干)。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.mail import sync_store as sync_store_module
from src.mail.sync_store import SyncStore


@pytest.fixture(autouse=True)
def _clean_latch():
    sync_store_module._INITIALIZED_DBS.clear()
    yield
    sync_store_module._INITIALIZED_DBS.clear()


def _version(path) -> int:
    with sqlite3.connect(path) as conn:
        return int(
            conn.execute(
                "SELECT value FROM sync_state WHERE key='db_version'"
            ).fetchone()[0]
        )


def _count_ddl(monkeypatch) -> list[int]:
    """数 init 期间真正发出的 CREATE/ALTER 条数 (计数器在返回的 list[0])。

    走 `set_trace_callback` 而不是包 `cursor.execute` —— 后者在 CPython 里改不动
    (`sqlite3.Cursor` 是 immutable type)。
    """
    counter = [0]
    original = SyncStore._get_connection

    def traced(self):
        conn = original(self)
        conn.set_trace_callback(
            lambda sql: counter.__setitem__(
                0,
                counter[0]
                + (1 if str(sql).lstrip()[:6].upper() in ("CREATE", "ALTER ") else 0),
            )
        )
        return conn

    monkeypatch.setattr(SyncStore, "_get_connection", traced)
    return counter


def test_second_construction_skips_the_ddl_replay(tmp_path, monkeypatch):
    path = tmp_path / "sync.db"
    SyncStore(str(path))  # 首次: 完整建表 + 迁移梯子

    counter = _count_ddl(monkeypatch)
    SyncStore(str(path))
    # 只剩 `CREATE TABLE IF NOT EXISTS sync_state` 那一条 (版本探测的前置)。
    assert counter[0] <= 1


def test_latch_does_not_swallow_a_pending_migration(tmp_path, monkeypatch):
    """🔴 库被降版 = 有迁移要跑, 门闩必须让路 (迁移重放测试全靠这条)。"""
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        conn.execute("DROP INDEX IF EXISTS idx_contact_known")
        conn.execute("UPDATE sync_state SET value='66' WHERE key='db_version'")
        conn.commit()

    counter = _count_ddl(monkeypatch)
    SyncStore(str(path))
    assert counter[0] > 1
    assert _version(path) == SyncStore.DB_VERSION
    with sqlite3.connect(path) as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' "
            "AND name='idx_contact_known'"
        ).fetchone()[0] == 1


def test_latch_keys_on_inode_so_a_recreated_file_is_initialised(tmp_path):
    """同一路径删掉重建 (测试的家常动作) 必须重新建表, 不能被上一个库的门闩挡住。"""
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    path.unlink()

    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        tables = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
    assert {"email_metadata", "contact", "contact_email"} <= tables
