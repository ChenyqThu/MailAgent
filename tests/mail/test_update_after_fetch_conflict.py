"""需求 1（P0）回归闸：update_after_fetch message_id UNIQUE 冲突处理。

2026-07-14 幽灵行事故的病根 —— 幽灵行 retry 时拿到正确 message_id 写回, 撞上真身
行占用的 UNIQUE 约束 → 整条 UPDATE 回滚 → sender 也没写进去 → Notion 400 → 无限
retry（每轮先重传附件）。

覆盖:
    - message_id 撞上 **已 synced** 的真身 → 当前行（幽灵行）被 **物理删除**（CASCADE
      清 body/attachment/outbox, 不再 retry）, 真身逐字节完好（铁律：不误伤真邮件）
    - message_id 撞上 **未 synced** 的行 → 无法判定真身 → 谁都不动, 返回 FAILED
    - 无冲突（同一行自己的 message_id / 全新 message_id）→ OK, 正常写入
    - 空 message_id patch（只补 to/cc）→ OK, 不触发冲突路径
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

import pytest

from src.mail.sync_store import SyncStore, UpdateAfterFetchResult


@pytest.fixture
def store(tmp_path: Path) -> SyncStore:
    return SyncStore(str(tmp_path / "t.db"))


def _insert(
    store: SyncStore,
    internal_id: int,
    *,
    message_id: str | None = None,
    sync_status: str = "pending",
    sender: str = "",
    notion_page_id: str | None = None,
) -> None:
    """直接 INSERT 一行 metadata（绕过 mark_* API，精确控制起点状态）。"""
    now = time.time()
    conn = sqlite3.connect(str(store.db_path))
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute(
        """INSERT INTO email_metadata
           (internal_id, message_id, sync_status, sender, mailbox,
            notion_page_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, '收件箱', ?, ?, ?)""",
        (internal_id, message_id, sync_status, sender, notion_page_id, now, now),
    )
    conn.commit()
    conn.close()


def _row(store: SyncStore, internal_id: int) -> sqlite3.Row:
    conn = sqlite3.connect(str(store.db_path))
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT * FROM email_metadata WHERE internal_id = ?", (internal_id,)
    ).fetchone()
    conn.close()
    return row


def _seed_downstream(store: SyncStore, internal_id: int) -> None:
    """给某行插 body/attachment/outbox 各一条 —— 验证 DUPLICATE 物理删除时 CASCADE 清干净。"""
    now = time.time()
    conn = sqlite3.connect(str(store.db_path))
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute(
        """INSERT INTO email_body
           (internal_id, body_markdown, fetched_at, fetched_source)
           VALUES (?, 'ghost body', ?, 'test')""",
        (internal_id, now),
    )
    conn.execute(
        """INSERT INTO email_attachment
           (internal_id, filename, created_at)
           VALUES (?, 'ghost.png', ?)""",
        (internal_id, now),
    )
    conn.execute(
        """INSERT INTO email_outbox
           (internal_id, op_type, target, payload_json, status, created_at, updated_at)
           VALUES (?, 'flag', 'notion', '{}', 'pending', ?, ?)""",
        (internal_id, now, now),
    )
    conn.commit()
    conn.close()


def _downstream_counts(store: SyncStore, internal_id: int) -> tuple[int, int, int]:
    """(body, attachment, outbox) 行数, 用于断言 CASCADE 归零。"""
    conn = sqlite3.connect(str(store.db_path))
    try:
        body = conn.execute(
            "SELECT COUNT(*) FROM email_body WHERE internal_id = ?", (internal_id,)
        ).fetchone()[0]
        att = conn.execute(
            "SELECT COUNT(*) FROM email_attachment WHERE internal_id = ?", (internal_id,)
        ).fetchone()[0]
        outbox = conn.execute(
            "SELECT COUNT(*) FROM email_outbox WHERE internal_id = ?", (internal_id,)
        ).fetchone()[0]
    finally:
        conn.close()
    return body, att, outbox


class TestGhostRowConflict:
    """幽灵行 message_id 撞上真身 → 物理删除, 不误伤真邮件。"""

    def test_conflict_with_synced_twin_deletes_ghost_row(self, store: SyncStore):
        """真身已 synced → 幽灵行被物理删除 + CASCADE 清 body/attachment/outbox, 返回 DUPLICATE。"""
        # 真身：早已 synced, 有 Notion 页
        _insert(
            store,
            100,
            message_id="<real@example.com>",
            sync_status="synced",
            sender="alice@example.com",
            notion_page_id="page-100",
        )
        # 幽灵行：sender 空, 现在 fetch 拿回了真实 message_id；下游 body/att/outbox 各一条
        _insert(store, 999, message_id=None, sync_status="failed", sender="")
        _seed_downstream(store, 999)
        assert _downstream_counts(store, 999) == (1, 1, 1)  # 前置：确有下游行

        result = store.update_after_fetch(
            999,
            {
                "message_id": "<real@example.com>",
                "sender": "alice@example.com",
                "subject": "real subject",
            },
        )

        assert result is UpdateAfterFetchResult.DUPLICATE
        assert _row(store, 999) is None  # 幽灵行已物理删除
        assert _downstream_counts(store, 999) == (0, 0, 0)  # CASCADE 归零

    def test_conflict_leaves_real_twin_untouched(self, store: SyncStore):
        """铁律：解决冲突时绝不改动真身那一行（幽灵行删除, 真身逐字节完好）。"""
        _insert(
            store,
            100,
            message_id="<real@example.com>",
            sync_status="synced",
            sender="alice@example.com",
            notion_page_id="page-100",
        )
        _seed_downstream(store, 100)  # 真身自己的下游行, 断言零触碰
        _insert(store, 999, message_id=None, sync_status="failed", sender="")
        _seed_downstream(store, 999)
        before = dict(_row(store, 100))

        store.update_after_fetch(999, {"message_id": "<real@example.com>"})

        after = dict(_row(store, 100))
        assert after == before  # 真身逐字节不变
        assert _downstream_counts(store, 100) == (1, 1, 1)  # 真身下游行零触碰

    def test_ghost_row_not_pulled_back_into_retry(self, store: SyncStore):
        """DUPLICATE 物理删除后, 幽灵行不再出现在重试队列 → 无限 retry 被切断。"""
        _insert(
            store,
            100,
            message_id="<real@example.com>",
            sync_status="synced",
            notion_page_id="page-100",
        )
        _insert(store, 999, message_id=None, sync_status="failed", sender="")

        store.update_after_fetch(999, {"message_id": "<real@example.com>"})

        # 行已删除 → get_ready_for_retry / get_dead_letter_emails 都查不到
        ready_ids = {e["internal_id"] for e in store.get_ready_for_retry(limit=100)}
        assert 999 not in ready_ids
        dead = {e["internal_id"] for e in store.get_dead_letter_emails(limit=100)}
        assert 999 not in dead  # 也没落进死信


class TestConflictWithUnsyncedTwinIsAmbiguous:
    """真身未 synced → 无法判定谁是真邮件 → 谁都不动（宁留垃圾不吞真邮件）。"""

    @pytest.mark.parametrize("twin_status", ["pending", "failed", "fetch_failed"])
    def test_conflict_with_unsynced_twin_returns_failed(
        self, store: SyncStore, twin_status: str
    ):
        _insert(
            store,
            100,
            message_id="<ambiguous@example.com>",
            sync_status=twin_status,
        )
        _insert(store, 999, message_id=None, sync_status="failed", sender="")

        result = store.update_after_fetch(
            999, {"message_id": "<ambiguous@example.com>", "sender": "x@y.com"}
        )

        assert result is UpdateAfterFetchResult.FAILED
        # 两行都不动：当前行状态保持 failed（未被误改成 skipped）
        current = _row(store, 999)
        assert current["sync_status"] == "failed"
        assert current["sender"] == ""  # UPDATE 未发生
        twin = _row(store, 100)
        assert twin["sync_status"] == twin_status  # 真身候选也没动


class TestNoConflictNormalPath:
    """无冲突时 update_after_fetch 行为不变（零漂移 pin）。"""

    def test_new_message_id_writes_ok(self, store: SyncStore):
        _insert(store, 42, message_id=None, sync_status="pending", sender="")

        result = store.update_after_fetch(
            42, {"message_id": "<fresh@example.com>", "sender": "bob@example.com"}
        )

        assert result is UpdateAfterFetchResult.OK
        row = _row(store, 42)
        assert row["message_id"] == "<fresh@example.com>"
        assert row["sender"] == "bob@example.com"

    def test_same_row_own_message_id_writes_ok(self, store: SyncStore):
        """再次写回自己已有的 message_id（owner==self）不算冲突。"""
        _insert(store, 42, message_id="<mine@example.com>", sync_status="failed")

        result = store.update_after_fetch(
            42, {"message_id": "<mine@example.com>", "subject": "updated"}
        )

        assert result is UpdateAfterFetchResult.OK
        assert _row(store, 42)["subject"] == "updated"

    def test_patch_without_message_id_skips_conflict_check(self, store: SyncStore):
        """只补 to/cc 的 patch（无 message_id）→ 不触发冲突路径。"""
        _insert(
            store,
            100,
            message_id="<real@example.com>",
            sync_status="synced",
        )
        _insert(store, 42, message_id=None, sync_status="pending")

        result = store.update_after_fetch(42, {"to_addr": "team@example.com"})

        assert result is UpdateAfterFetchResult.OK
        assert _row(store, 42)["to_addr"] == "team@example.com"

    def test_empty_patch_returns_ok(self, store: SyncStore):
        _insert(store, 42, message_id=None, sync_status="pending")
        assert store.update_after_fetch(42, {}) is UpdateAfterFetchResult.OK
