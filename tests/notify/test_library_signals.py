"""``notify_library_file_written`` 单测 (task 09-03-library-p2-write-and-links)。

覆盖：① commit 之后调用 → 落一条 results/info 通知，payload.link 形状对；
② 同一 file_id 反复调用 → 聚合计次到同一活跃行（不刷屏）；
③ 不同 file_id → 各自开新行（dedupe_key 不互相踩）；
④ NotifyCenter.publish 抛异常 → 整段吞掉，不影响调用方；
⑤ 🔴 死锁纪律回归：在调用方**未提交**的写事务内调用 → 抢不到锁，本函数吞掉那次失败
（不抛、但也没落到行）——这正是头注警告的「写了没人知道」会真实发生的方式，钉住「必须
在 commit 之后调用」不是空话。

🔴 全程 tmp_path 建库（``SyncStore`` 落表只取 db_path），绝不碰真实库；⑤ 用缩短的
busy_timeout 让红测试快跑（抄 ``tests/contacts/test_governance.py`` 的
``_patch_notify_center_fast_timeout`` 范式，不改生产默认）。
"""

from __future__ import annotations

import json
import sqlite3

import pytest

from src.mail.sync_store import SyncStore
from src.notify.center import NotifyCenter
from src.notify.library_signals import notify_library_file_written


@pytest.fixture
def db_path(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))  # 落表（含 notification）
    return str(path)


def _fetch_notifications(db_path: str) -> list[dict]:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute("SELECT * FROM notification ORDER BY id").fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


def _patch_notify_center_fast_timeout(monkeypatch) -> None:
    """把 NotifyCenter 内部连接的 busy_timeout 缩短到亚秒级 —— 只用于让「事务内调用会
    卡住」的红测试快跑，不改生产默认（``NotifyCenter._connect`` 硬编码
    timeout=30.0/busy_timeout=30000，抄 test_governance.py 同名函数）。"""

    def _fast_connect(self):
        conn = sqlite3.connect(self.db_path, timeout=0.2)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 200")
        return conn

    monkeypatch.setattr(NotifyCenter, "_connect", _fast_connect)


def test_publishes_results_info_with_library_link(db_path):
    notify_library_file_written(db_path, file_id=7, rel_path="agent-docs/2026-09-03.md")

    rows = _fetch_notifications(db_path)
    assert len(rows) == 1
    row = rows[0]
    assert row["category"] == "results"
    assert row["severity"] == "info"
    assert row["source"] == "library"
    assert row["dedupe_key"] == "library_file:7"
    assert "agent-docs/2026-09-03.md" in row["body"]
    payload = json.loads(row["payload_json"])
    assert payload["link"] == {"type": "library", "fileId": 7}


def test_same_file_id_bumps_recurrence_not_a_new_row(db_path):
    notify_library_file_written(db_path, file_id=7, rel_path="agent-docs/a.md")
    notify_library_file_written(db_path, file_id=7, rel_path="agent-docs/a.md")

    rows = _fetch_notifications(db_path)
    assert len(rows) == 1  # 聚合到同一行，不是两行
    assert rows[0]["recurrence_no"] == 2


def test_different_file_id_gets_its_own_row(db_path):
    notify_library_file_written(db_path, file_id=7, rel_path="agent-docs/a.md")
    notify_library_file_written(db_path, file_id=8, rel_path="agent-docs/b.md")

    rows = _fetch_notifications(db_path)
    assert len(rows) == 2
    dedupe_keys = {r["dedupe_key"] for r in rows}
    assert dedupe_keys == {"library_file:7", "library_file:8"}


def test_publish_failure_is_swallowed(db_path, monkeypatch):
    def boom(*a, **kw):
        raise RuntimeError("notify center down")

    monkeypatch.setattr(NotifyCenter, "publish", boom)

    notify_library_file_written(db_path, file_id=7, rel_path="agent-docs/a.md")  # 不应抛出
    assert _fetch_notifications(db_path) == []


def test_called_inside_open_transaction_is_swallowed_not_delivered(db_path, monkeypatch):
    """🔴 头注警告的死锁纪律：调用方事务未提交时调用本函数，NotifyCenter 抢不到
    BEGIN IMMEDIATE 的锁而抛 OperationalError('database is locked')——本函数把它吞掉，
    调用方感觉不到任何异常，但通知**没有**落库。这正是「必须在 commit 之后调用」这条
    纪律存在的理由：违反它不是「变慢」而是「静默丢通知」。"""
    _patch_notify_center_fast_timeout(monkeypatch)

    conn = sqlite3.connect(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "INSERT INTO notification (category, source, severity, state, dedupe_key, "
            "recurrence_no, title, body, first_created_at, last_event_at) "
            "VALUES ('results','other','info','open','other:1',1,'t','b',0,0)"
        )
        # conn 仍处于未提交的写事务 —— 在这个窗口里调用本函数。
        notify_library_file_written(db_path, file_id=7, rel_path="agent-docs/a.md")
    finally:
        conn.rollback()
        conn.close()

    assert _fetch_notifications(db_path) == []  # rollback 之后一条都没有：确实没写进去
