"""B1: outbox payload_json 的 JS/Python 逐字节契约 golden.

``write_ops.ts::writeFlagDirect`` (TS) 与 ``OutboxRepository.enqueue`` (Python)
现共用同一条原子 UPSERT SQL（``ON CONFLICT(...) WHERE status='pending' DO UPDATE
SET payload_json = json_patch(...)``）。本测试锁 **Python 侧** payload_json 字节
序列 == 共享 golden；对侧 ``frontend/tests/main/write_ops_outbox_parity.test.ts``
锁 **TS 侧** == 同一 golden。两者同 golden → 双跑期（B1 后 D1 前 TS 直写与 Python
in-process 写并存）逐字节一致，根除「两份手抄 merge 漂移」。

golden 语义（实测自 SQLite json_patch）:
- INSERT 新行 = 应用层紧凑 sorted（无空格 + key 字典序）。
- merge = ``json_patch`` 输出：紧凑、保留 **base key 顺序**、新 key 追加于尾、
  后写覆盖同 key（RFC7396）。中文 **不转义**。

⚠️ 改 golden 必须同步改 TS 侧的 ``GOLDEN`` 常量，否则契约失去意义。
"""
from __future__ import annotations

import sqlite3
import time

import pytest

from src.mail.sync_store import SyncStore
from src.sync.outbox import OutboxRepository

# 共享 golden —— 逐字节等同 write_ops_outbox_parity.test.ts 的 GOLDEN_NOTION。
# 序列: (传入 payload, 该 target pending 行在本步后的 payload_json)。
GOLDEN_NOTION = [
    ({"is_read": True}, '{"is_read":true}'),
    ({"is_flagged": False}, '{"is_read":true,"is_flagged":false}'),
    (
        {"is_read": False, "processing_status": "已完成"},
        '{"is_read":false,"is_flagged":false,"processing_status":"已完成"}',
    ),
]


@pytest.fixture
def repo(tmp_path):
    """v20 schema 库（含 ux_outbox_pending_intent）+ 一行 email_metadata 供 FK。"""
    path = tmp_path / "sync.db"
    SyncStore(str(path))  # 触发 _init_database → v20 partial unique index
    conn = sqlite3.connect(str(path))
    try:
        now = time.time()
        conn.execute(
            "INSERT INTO email_metadata (internal_id, sync_status, created_at, updated_at) "
            "VALUES (1001, 'synced', ?, ?)",
            (now, now),
        )
        conn.commit()
    finally:
        conn.close()
    return OutboxRepository(str(path))


def _payload_json(repo: OutboxRepository, outbox_id: int) -> str:
    conn = sqlite3.connect(repo.db_path)
    try:
        return conn.execute(
            "SELECT payload_json FROM email_outbox WHERE outbox_id = ?", (outbox_id,)
        ).fetchone()[0]
    finally:
        conn.close()


def test_notion_payload_json_byte_parity_golden(repo):
    """enqueue 序列产出的 payload_json 逐字节 == 共享 golden（= TS writeFlagDirect）。"""
    oid = None
    for payload, expected in GOLDEN_NOTION:
        rid = repo.enqueue(
            internal_id=1001, op_type="flag_sync", target="notion",
            payload=payload, source="cli",
        )
        if oid is None:
            oid = rid
        assert rid == oid, "同 (internal_id, op_type, target) pending 应 merge 而非新增行"
        assert _payload_json(repo, oid) == expected


def test_insert_is_compact_sorted(repo):
    """首次 INSERT payload_json = 紧凑（无空格）+ sorted（is_flagged < is_read）。"""
    oid = repo.enqueue(
        internal_id=1001, op_type="flag_sync", target="mailapp",
        payload={"is_read": True, "is_flagged": False}, source="cli",
    )
    assert _payload_json(repo, oid) == '{"is_flagged":false,"is_read":true}'


def test_merge_overwrites_and_appends(repo):
    """merge: 覆盖同 key（保留 base 顺序）+ 追加新 key 于尾（json_patch base-order）。"""
    oid = repo.enqueue(
        internal_id=1001, op_type="flag_sync", target="mailapp",
        payload={"is_read": True}, source="cli",
    )
    repo.enqueue(
        internal_id=1001, op_type="flag_sync", target="mailapp",
        payload={"is_read": False, "is_flagged": True}, source="cli",
    )
    assert _payload_json(repo, oid) == '{"is_read":false,"is_flagged":true}'
