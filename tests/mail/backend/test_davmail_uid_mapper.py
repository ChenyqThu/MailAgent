"""DavMailUidMapper 单元测试.

覆盖 review HIGH/MEDIUM:
- HIGH #7: 单 SQLite 连接 + executemany batch UPDATE (不再每条 connect 一次)
- count_pending 旧 bug ``IN ('applescript', NULL)`` 修复 — NULL backend_origin 也统计
- imap_uid=-1 sentinel 标记 permanent miss
- resume from _LAST_INTERNAL_ID_KEY (续传)
"""
from __future__ import annotations

import sqlite3
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from src.mail.backend.davmail_uid_mapper import (
    DavMailUidMapper,
    _LAST_INTERNAL_ID_KEY,
)
from src.mail.sync_store import SyncStore


@pytest.fixture
def temp_store(tmp_path: Path):
    """构造一个真实的 SyncStore (临时 db), 注入几条不同 backend_origin 状态的邮件."""
    db_path = tmp_path / "test_sync_store.db"
    store = SyncStore(str(db_path))

    # 插入测试数据 (用 v3 save_email 模拟 applescript / davmail / 不同 backfill 状态)
    rows = [
        # backend_origin='applescript' + imap_uid IS NULL + message_id 有 → 待 backfill
        {
            "internal_id": 100, "message_id": "m1@x", "subject": "A",
            "mailbox": "收件箱", "backend_origin": "applescript",
        },
        {
            "internal_id": 101, "message_id": "m2@x", "subject": "B",
            "mailbox": "收件箱", "backend_origin": "applescript",
        },
        # backend_origin NULL (老 v3 row, 未迁移) + imap_uid NULL → 也应该被 backfill (旧 bug)
        {
            "internal_id": 102, "message_id": "m3@x", "subject": "C",
            "mailbox": "收件箱",
        },
        # imap_uid 已有 → 跳过
        {
            "internal_id": 103, "message_id": "m4@x", "subject": "D",
            "mailbox": "收件箱", "backend_origin": "applescript",
            "imap_uid": 999, "imap_uidvalidity": 5,
        },
        # message_id 缺 → 跳过 (无法反查)
        {
            "internal_id": 104, "message_id": None, "subject": "E",
            "mailbox": "收件箱", "backend_origin": "applescript",
        },
        # backend_origin='davmail' → 跳过 (本来就是 davmail 抓的)
        {
            "internal_id": 1_000_000_000, "message_id": "m6@x", "subject": "F",
            "mailbox": "收件箱", "backend_origin": "davmail",
            "imap_uid": 1, "imap_uidvalidity": 5,
        },
    ]
    for r in rows:
        store.save_email(r)
    yield str(db_path), store


def _make_cfg(db_path: str):
    return SimpleNamespace(
        sync_store_db_path=db_path,
        davmail_imap_host="127.0.0.1",
        davmail_imap_port=1143,
        user_email="me@x.com",
        davmail_cipher_key="test-key",
    )


def test_count_pending_includes_null_backend_origin(temp_store):
    """旧 bug: ``IN ('applescript', NULL)`` 会漏算 NULL backend_origin 的行.

    修复后应该数到 100, 101, 102 (三行, 不含 imap_uid 已有 / message_id 缺 / davmail).
    """
    db_path, store = temp_store
    mapper = DavMailUidMapper(_make_cfg(db_path), store)
    assert mapper.count_pending() == 3


def test_fetch_batch_to_backfill_excludes_processed(temp_store):
    """已 backfill (imap_uid 有值) / 缺 message_id / davmail origin 不应进 batch."""
    db_path, store = temp_store
    mapper = DavMailUidMapper(_make_cfg(db_path), store, batch_size=10)
    batch = mapper._fetch_batch_to_backfill(after_internal_id=0)
    iids = [b[0] for b in batch]
    assert sorted(iids) == [100, 101, 102]


def test_fetch_batch_resume_from_internal_id(temp_store):
    """已处理 N 后, 续跑应该 SELECT internal_id > N."""
    db_path, store = temp_store
    mapper = DavMailUidMapper(_make_cfg(db_path), store, batch_size=10)
    batch = mapper._fetch_batch_to_backfill(after_internal_id=101)
    assert [b[0] for b in batch] == [102]


@pytest.mark.asyncio
async def test_backfill_batch_uses_executemany(temp_store, monkeypatch):
    """HIGH #7: 整批 backfill UPDATE 应通过 executemany 一次性提交, 而非每条 UPDATE
    一次 sqlite.connect (旧版每条 50/batch × 8857 邮件 ≈ 8857 次 connect, 主 loop 卡顿).
    """
    db_path, store = temp_store
    mapper = DavMailUidMapper(_make_cfg(db_path), store, batch_size=10)

    fake_imap = MagicMock()
    fake_imap.select.return_value = ("OK", [b""])
    fake_imap.untagged_responses = {"UIDVALIDITY": [b"99"]}

    def fake_lookup(imap, mid):
        return {"m1@x": 1000, "m2@x": 1001, "m3@x": None}.get(mid)

    monkeypatch.setattr(
        "src.mail.backend.davmail_backend.DavMailBackend._lookup_uid_by_message_id",
        staticmethod(fake_lookup),
    )
    monkeypatch.setattr(
        "src.mail.backend.davmail_uid_mapper.imap_connect",
        lambda *a, **kw: fake_imap,
    )

    # 拦截 _backfill_one_batch 内的 sqlite3.connect, 监控 executemany 调用
    import src.mail.backend.davmail_uid_mapper as mod
    orig_connect = sqlite3.connect
    executemany_calls: list[str] = []
    execute_update_calls: list[str] = []

    class _WrapConn:
        def __init__(self, inner):
            self._inner = inner

        def executemany(self, sql, params):
            executemany_calls.append(sql)
            return self._inner.executemany(sql, params)

        def execute(self, sql, *args, **kwargs):
            # 监控有没有人在 backfill 路径里逐条 UPDATE
            if "UPDATE email_metadata" in sql:
                execute_update_calls.append(sql)
            return self._inner.execute(sql, *args, **kwargs)

        def __getattr__(self, name):
            return getattr(self._inner, name)

        def __enter__(self):
            self._inner.__enter__()
            return self

        def __exit__(self, *a):
            return self._inner.__exit__(*a)

    def wrapped_connect(*args, **kwargs):
        return _WrapConn(orig_connect(*args, **kwargs))

    monkeypatch.setattr(mod.sqlite3, "connect", wrapped_connect)

    result = await mapper.run_backfill()

    assert result["backfilled"] == 2
    assert result["missing"] == 1
    assert result["processed"] == 3

    # 核心断言: backfill batch 一定通过 executemany, 不是逐条 UPDATE.execute
    assert executemany_calls, "没有调用 executemany — HIGH #7 修复失效"
    # 一次 batch 内最多 2 次 executemany (backfill + missing 各一次), 不会是 3 个
    # 独立 execute UPDATE.
    assert len(execute_update_calls) == 0, (
        f"backfill 路径仍在逐条 execute UPDATE: {execute_update_calls}"
    )

    # 验证 SQLite 真的更新了
    conn = orig_connect(db_path)
    row1 = conn.execute(
        "SELECT imap_uid, imap_uidvalidity FROM email_metadata WHERE internal_id=100"
    ).fetchone()
    assert row1[0] == 1000 and row1[1] == 99
    row3 = conn.execute(
        "SELECT imap_uid FROM email_metadata WHERE internal_id=102"
    ).fetchone()
    assert row3[0] == -1  # sentinel for permanent miss
    conn.close()


@pytest.mark.asyncio
async def test_backfill_progress_persisted(temp_store, monkeypatch):
    """续传 marker (_LAST_INTERNAL_ID_KEY) 应该写到 sync_state."""
    db_path, store = temp_store
    mapper = DavMailUidMapper(_make_cfg(db_path), store, batch_size=10)

    fake_imap = MagicMock()
    fake_imap.select.return_value = ("OK", [b""])
    fake_imap.untagged_responses = {"UIDVALIDITY": [b"99"]}
    monkeypatch.setattr(
        "src.mail.backend.davmail_backend.DavMailBackend._lookup_uid_by_message_id",
        staticmethod(lambda imap, mid: 555),
    )
    monkeypatch.setattr(
        "src.mail.backend.davmail_uid_mapper.imap_connect",
        lambda *a, **kw: fake_imap,
    )

    await mapper.run_backfill()
    resume = store.get_state(_LAST_INTERNAL_ID_KEY)
    # 最后一条 backfill 是 internal_id 102, marker 应该 = 102
    assert resume == "102"


@pytest.mark.asyncio
async def test_backfill_imap_connect_fail_marks_failed(temp_store, monkeypatch):
    """IMAP 连接失败时整批 failed, 不应阻塞 / 不写错数据."""
    db_path, store = temp_store
    mapper = DavMailUidMapper(_make_cfg(db_path), store, batch_size=10)

    monkeypatch.setattr(
        "src.mail.backend.davmail_uid_mapper.imap_connect",
        lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("connect refused")),
    )

    result = await mapper.run_backfill()
    assert result["failed"] >= 3
    assert result["backfilled"] == 0
