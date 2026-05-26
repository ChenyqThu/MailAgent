"""Phase 3 §P1-d — Connection pool behavior for CalendarEventRepository.

CalendarSyncWorker 60s × N calendars × 多次 read/write 一轮上百次 sqlite
open/close. P1-d 加 per-thread long-lived connection (threading.local +
WAL 兼容). 本测试套验证:
- 同线程多次 _conn_ctx → 复用同一 connection
- 跨线程隔离 (threading.local 语义)
- close() 释放当前线程 conn 后下次自动新开
- pool=False 退化老 open-then-close 行为 (cli subprocess / test 隔离)
- 写入持久 (commit 真生效, 不是 in-memory transaction)
"""
from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

import pytest

from src.calendar_sync import CalendarEventRepository


class TestConnectionPool:
    def test_pool_reuses_connection_same_thread(self, fresh_db: str):
        """同线程多次 _conn_ctx → 同一 sqlite3.Connection 实例."""
        repo = CalendarEventRepository(fresh_db, pool=True)

        with repo._conn_ctx() as c1:
            id1 = id(c1)
        with repo._conn_ctx() as c2:
            id2 = id(c2)
        with repo._conn_ctx() as c3:
            id3 = id(c3)

        assert id1 == id2 == id3, "pool 应复用同 connection"

    def test_pool_disabled_opens_fresh_each_time(self, fresh_db: str):
        """pool=False → 每次 _conn_ctx 新建 + close (老行为)."""
        repo = CalendarEventRepository(fresh_db, pool=False)

        with repo._conn_ctx() as c1:
            id1 = id(c1)
        with repo._conn_ctx() as c2:
            id2 = id(c2)

        # 不同 sqlite3.Connection 对象 (sqlite3.connect 每次返新实例; Python
        # gc 后可能 id 复用, 但同 ctx 内不可能).
        # 更稳健: 验证 close 后 c1 不能再用.
        with pytest.raises(sqlite3.ProgrammingError):
            c1.execute("SELECT 1")
        # c2 已 ctx 内也 close 了
        with pytest.raises(sqlite3.ProgrammingError):
            c2.execute("SELECT 1")

    def test_close_releases_pool_then_reopens(self, fresh_db: str):
        """显式 close() 后, 下次 _conn_ctx 自动新建."""
        repo = CalendarEventRepository(fresh_db, pool=True)

        with repo._conn_ctx() as c1:
            id1 = id(c1)

        repo.close()
        # close 多次幂等
        repo.close()

        with repo._conn_ctx() as c2:
            id2 = id(c2)
            # 关后新开 — sqlite3 对象不同 (即使 Python id 复用机会极小)
            # 仍能正常 query
            assert c2.execute("SELECT 1").fetchone()[0] == 1
        # 即使 id 巧合复用 (极少), 至少 c1 已 close 不能用
        with pytest.raises(sqlite3.ProgrammingError):
            c1.execute("SELECT 1")

    def test_pool_thread_isolation(self, fresh_db: str):
        """threading.local: 每线程独立 connection, sqlite3 不允许跨线程用 conn."""
        repo = CalendarEventRepository(fresh_db, pool=True)

        main_conn_id: list[int] = []
        worker_conn_id: list[int] = []
        worker_error: list[str] = []

        with repo._conn_ctx() as c_main:
            main_conn_id.append(id(c_main))

        def _worker():
            try:
                with repo._conn_ctx() as c_w:
                    worker_conn_id.append(id(c_w))
                    # 子线程拿自己的 conn, 能正常 query
                    c_w.execute("SELECT 1").fetchone()
            except Exception as e:
                worker_error.append(str(e))

        t = threading.Thread(target=_worker)
        t.start()
        t.join(timeout=5)
        assert not t.is_alive(), "worker thread hung"
        assert not worker_error, f"worker failed: {worker_error}"
        assert len(worker_conn_id) == 1
        # 子线程跟主线程 conn 是不同对象 (threading.local 语义)
        assert worker_conn_id[0] != main_conn_id[0]

    def test_pool_writes_persist(self, fresh_db: str, make_event):
        """Pool 长连接 commit 后写入真持久 (不是悬空 transaction)."""
        repo = CalendarEventRepository(fresh_db, pool=True)

        ev = make_event(uid="persist-test", summary="Persists")
        eid = repo.upsert_from_caldav_event(ev, source="caldav")
        assert eid > 0

        # 用同 repo 不同线程 / 不同 repo 实例都应读到
        repo.close()  # 显式释放当前线程 conn

        # 新 repo 实例 (新 connection) 也能读到 — 证明确实落了磁盘
        repo2 = CalendarEventRepository(fresh_db, pool=True)
        row = repo2.get_by_id(eid)
        assert row is not None
        assert row.summary == "Persists"

    def test_default_is_pool_enabled(self, fresh_db: str):
        """默认构造启用 pool (Phase 3 §P1-d 行为)."""
        repo = CalendarEventRepository(fresh_db)
        assert repo._pool_enabled is True
