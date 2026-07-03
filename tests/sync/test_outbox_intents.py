"""tests/sync/test_outbox_intents.py — E2-D flag_sync 共享入队层.

覆盖 src/sync/outbox_intents.py:
- enqueue_flag_sync: mailapp/notion 单双 target 入队 + 空 payload 跳过语义
- mirror_and_enqueue_flag_sync: update_local_flags (echo prevention) 先行 + 入队
- 归一断言: handlers / reverse_sync / mail_write 三个消费模块绑定的入队函数
  与 src/sync/outbox_intents 是同一对象 —— 反向写只有这一个入队面。
"""

from __future__ import annotations

import sqlite3
import time
from unittest.mock import MagicMock

import pytest

from src.mail.sync_store import SyncStore
from src.sync.outbox import OutboxRepository
from src.sync.outbox_intents import (
    FlagSyncEnqueueResult,
    enqueue_flag_sync,
    mirror_and_enqueue_flag_sync,
)


@pytest.fixture
def db_path(tmp_path):
    """真 SQLite: schema + 1 邮件 row."""
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    conn = sqlite3.connect(str(path))
    try:
        now = time.time()
        conn.execute(
            "INSERT INTO email_metadata (internal_id, message_id, sync_status, "
            "is_read, is_flagged, mailbox, notion_page_id, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (7001, "<intent-msg@example.com>", "synced", 0, 0, "收件箱",
             "page-uuid-intent", now, now),
        )
        conn.commit()
    finally:
        conn.close()
    return str(path)


@pytest.fixture
def sync_store(db_path):
    return SyncStore(db_path)


@pytest.fixture
def outbox_repo(db_path):
    return OutboxRepository(db_path)


# ============================================================
# enqueue_flag_sync — 纯入队
# ============================================================

class TestEnqueueFlagSync:
    def test_mailapp_only(self, outbox_repo):
        result = enqueue_flag_sync(
            outbox_repo, 7001,
            mailapp_payload={"is_read": True},
            source="notion_webhook",
        )
        assert result.mailapp_outbox_id is not None
        assert result.notion_outbox_id is None
        rows = outbox_repo.list_by_internal_id(7001)
        assert len(rows) == 1
        assert rows[0].target == "mailapp"
        assert rows[0].op_type == "flag_sync"
        assert rows[0].payload == {"is_read": True}
        assert rows[0].source == "notion_webhook"

    def test_dual_target(self, outbox_repo):
        result = enqueue_flag_sync(
            outbox_repo, 7001,
            mailapp_payload={"is_read": True, "is_flagged": True},
            notion_payload={"is_read": True, "is_flagged": True,
                            "processing_status": "已同步"},
            source="cli",
        )
        assert result.mailapp_outbox_id is not None
        assert result.notion_outbox_id is not None
        rows = outbox_repo.list_by_internal_id(7001)
        assert {r.target for r in rows} == {"mailapp", "notion"}
        notion_row = next(r for r in rows if r.target == "notion")
        assert notion_row.payload["processing_status"] == "已同步"

    def test_empty_mailapp_payload_skipped(self, outbox_repo):
        """空 mailapp payload → 不入 mailapp 队 (mail_write '只改 processing_status'
        场景的历史 truthiness 语义)."""
        result = enqueue_flag_sync(
            outbox_repo, 7001,
            mailapp_payload={},
            notion_payload={"processing_status": "已完成"},
            source="cli",
        )
        assert result.mailapp_outbox_id is None
        assert result.notion_outbox_id is not None
        rows = outbox_repo.list_by_internal_id(7001)
        assert [r.target for r in rows] == ["notion"]

    def test_notion_none_skipped(self, outbox_repo):
        """notion_payload=None → 不入 notion 队 (handlers 防回环路径)."""
        result = enqueue_flag_sync(
            outbox_repo, 7001,
            mailapp_payload={"is_flagged": False},
            source="ai_reviewed_handler",
        )
        assert result.notion_outbox_id is None
        rows = outbox_repo.list_by_internal_id(7001)
        assert [r.target for r in rows] == ["mailapp"]

    def test_echo_prevention_passthrough(self, outbox_repo):
        """source='notion_webhook' + target='notion' 由 OutboxRepository.enqueue
        silent skip (返 -1) — 共享层不重复实现, 语义透传."""
        result = enqueue_flag_sync(
            outbox_repo, 7001,
            notion_payload={"is_read": True},
            source="notion_webhook",
        )
        assert result.notion_outbox_id == -1
        rows = outbox_repo.list_by_internal_id(7001)
        assert all(r.target != "notion" for r in rows)


# ============================================================
# mirror_and_enqueue_flag_sync — SQLite 镜像 + 入队
# ============================================================

class TestMirrorAndEnqueue:
    def test_mirror_then_enqueue(self, sync_store, outbox_repo):
        result = mirror_and_enqueue_flag_sync(
            sync_store, outbox_repo, 7001,
            local_read=True,
            local_flagged=True,
            local_processing_status="已同步",
            mailapp_payload={"is_read": True, "is_flagged": True},
            source="reverse_sync_poll",
        )
        assert isinstance(result, FlagSyncEnqueueResult)
        assert result.mailapp_outbox_id is not None
        # SQLite 已镜像目标态 (echo prevention)
        record = sync_store.get(7001)
        assert bool(record["is_read"]) is True
        assert bool(record["is_flagged"]) is True
        assert record["processing_status"] == "已同步"

    def test_mirror_without_processing_status(self, sync_store, outbox_repo):
        """processing_status 缺省 None — flag_changed 路径不写状态机字段."""
        mirror_and_enqueue_flag_sync(
            sync_store, outbox_repo, 7001,
            local_read=True,
            local_flagged=False,
            mailapp_payload={"is_read": True},
            source="notion_webhook",
        )
        record = sync_store.get(7001)
        assert bool(record["is_read"]) is True
        assert not record.get("processing_status")


# ============================================================
# 归一断言 — 三个消费模块共用同一入队函数 (E2-D 验收)
# ============================================================

class TestSingleEnqueueSurface:
    def test_consumers_bind_same_function(self):
        """handlers / reverse_sync / mail_write 绑定的入队函数与源模块同一对象:
        反向写 flag_sync 只有 src/sync/outbox_intents 这一个入队面。"""
        import src.events.handlers as handlers_mod
        import src.mail.reverse_sync as reverse_mod
        import src.services.mail_write as mail_write_mod
        import src.sync.outbox_intents as intents_mod

        assert handlers_mod.mirror_and_enqueue_flag_sync \
            is intents_mod.mirror_and_enqueue_flag_sync
        assert reverse_mod.mirror_and_enqueue_flag_sync \
            is intents_mod.mirror_and_enqueue_flag_sync
        assert mail_write_mod.mirror_and_enqueue_flag_sync \
            is intents_mod.mirror_and_enqueue_flag_sync
        # 薄入口 (只入队不镜像) 同样单一来源
        assert handlers_mod.enqueue_flag_sync is intents_mod.enqueue_flag_sync
        assert reverse_mod.enqueue_flag_sync is intents_mod.enqueue_flag_sync

    def test_mail_write_set_flags_routes_through_shared_layer(
        self, sync_store, outbox_repo, monkeypatch
    ):
        """mail_write.set_flags 的入队经共享层 (mock 断言): patch 消费模块命名空间
        里的 mirror_and_enqueue_flag_sync, 断言被调且承载 dual-target 语义."""
        import src.services.mail_write as mail_write_mod
        from src.services.mail_write import MailWriteService

        calls = []

        def _spy(store, repo, iid, **kwargs):
            calls.append((iid, kwargs))
            return FlagSyncEnqueueResult(mailapp_outbox_id=1, notion_outbox_id=2)

        monkeypatch.setattr(mail_write_mod, "mirror_and_enqueue_flag_sync", _spy)
        # 写鉴权/pm2 guard 不是本测试对象
        monkeypatch.setattr(mail_write_mod, "require_write_auth", lambda actor: None)
        monkeypatch.setattr(
            mail_write_mod, "check_pm2_conflict",
            lambda allow_concurrent=False: None,
        )

        meta = MagicMock()
        meta.is_read = False
        meta.is_flagged = False
        ctx = MagicMock()
        ctx.email_repo.get_metadata.return_value = meta
        ctx.sync_store = sync_store

        svc = MailWriteService(ctx)
        result = svc.set_flags(
            [7001], is_read=True, is_flagged=True,
            actor=MagicMock(), allow_concurrent=True,
        )

        assert result.updated_ids == [7001]
        assert len(calls) == 1
        iid, kwargs = calls[0]
        assert iid == 7001
        assert kwargs["mailapp_payload"] == {"is_read": True, "is_flagged": True}
        assert kwargs["notion_payload"] == {"is_read": True, "is_flagged": True}
        assert kwargs["source"] == "cli"
        assert result.outbox_entries == [
            {"internal_id": 7001, "mailapp_outbox_id": 1, "notion_outbox_id": 2}
        ]
