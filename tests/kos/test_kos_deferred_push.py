"""issue #64 Lane A: KOS hook 抢跑 LLM hook → 增量入库丢 AI 标签的修复。

根因: new_watcher 步骤 9 `_maybe_trigger_llm_hook` 是 fire-and-forget, 步骤 10
KOS hook 紧接着**同步**读 LLMProcessingStore().get_labels → LLM 还没写完, 100%
读空 (活库实测 83/83 封 pushed_at 平均早于 llm_processing.updated_at 911s)。
后果: priority floor 结构性失效 (23 封 ⚪低 被推入库) / 增量页面无 AI 标签 /
KOS_REQUIRE_LABELED 一开即全 skipped 停摆。

修复 (deferred first-push): 会跑 LLM 的邮件 hook 不直接推, 台账落 status='pending'
行 (record_deferred), 由 6c _process_kos_retry_queue 在 llm_processing 终态
(success/gave_up) 或 DEFER_MAX_CHECKS 兜底后用 repush_stored_email_to_kos 从
SQLite SSoT 重建 payload 首推。钉住的验收:
  ① LLM 标签就位后才推 KOS (含 payload 真的带标签)
  ② LLM 未启用时仍能入库 (直推路径)
  ③ LLM 失败 (gave_up) 时仍能入库 (无标签保底)
  ④ 同一封不会被推两次
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time
from unittest.mock import MagicMock

import pytest

from src.kos import ingest_log
from src.kos.client import KOSClient
from src.kos.producer import llm_labels_settled
from src.mail import new_watcher as nw_mod
from src.mail.new_watcher import NewWatcher
from src.mail.sync_store import SyncStore
from src.models import Email


# ============================================================
# helpers (镜像 tests/kos/test_ingest_reliability.py)
# ============================================================

def _store(tmp_path) -> SyncStore:
    return SyncStore(str(tmp_path / "t.db"))


def _db(store: SyncStore) -> str:
    return str(store.db_path)


def _save_synced(store: SyncStore, internal_id: int, **kw) -> None:
    store.save_email({
        "internal_id": internal_id,
        "message_id": f"<m{internal_id}@x>",
        "subject": f"subject {internal_id}",
        "sender": "a@x.com",
        "mailbox": "收件箱",
        "sync_status": "synced",
        **kw,
    })


def _row(db_path: str, internal_id: int):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(
            "SELECT * FROM kos_ingest_log WHERE internal_id = ?", (internal_id,)
        ).fetchone()
    finally:
        conn.close()


def _seed_llm(db_path: str, internal_id: int, status: str, labels=None) -> None:
    """写一行 llm_processing (fresh SyncStore 库 v37 起首启即建该表)。"""
    now = time.time()
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT OR REPLACE INTO llm_processing "
            "(internal_id, status, retry_count, labels_json, created_at, updated_at) "
            "VALUES (?, ?, 0, ?, ?, ?)",
            (internal_id, status,
             json.dumps(labels, ensure_ascii=False) if labels else None, now, now),
        )
        conn.commit()
    finally:
        conn.close()


def _expire_deferred(db_path: str, internal_id: int) -> None:
    """把 pending 行的 next_retry_at 拨到过去, 让 6c 立即 claim 到。"""
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "UPDATE kos_ingest_log SET next_retry_at = ? WHERE internal_id = ?",
            (time.time() - 1, internal_id),
        )
        conn.commit()
    finally:
        conn.close()


def _make_email(internal_id: int = 1, mailbox: str = "收件箱") -> Email:
    return Email(
        message_id=f"<m{internal_id}@x>", subject="s", sender="a@x.com",
        mailbox=mailbox,
    )


def _mock_client(*, configured=True) -> MagicMock:
    client = MagicMock(spec=KOSClient)
    client.configured = configured
    client.put_page = MagicMock(
        return_value={"status": "created_or_updated", "chunks": 2}
    )
    client.health = MagicMock(return_value={"status": "ok"})
    return client


def _hook_watcher(store: SyncStore, *, llm_active: bool,
                  folder_llm_disabled=frozenset()) -> NewWatcher:
    """hook 测试用最小 watcher (镜像 NewWatcher.__new__ 构造惯例)。"""
    w = NewWatcher.__new__(NewWatcher)
    w.sync_store = store
    w._llm_runner = object() if llm_active else None
    w._folder_llm_disabled = folder_llm_disabled
    # 直推路径的 fetch 块用到 email_repo; 返回值内容对断言无关紧要
    w.email_repo = MagicMock()
    w.email_repo.get_body_markdown.return_value = "body"
    w.email_repo.get_attachments.return_value = []
    return w


def _scan_watcher(store: SyncStore) -> NewWatcher:
    w = NewWatcher.__new__(NewWatcher)
    w.sync_store = store
    w._kos_unhealthy_until = None
    return w


async def _drain_bg(w: NewWatcher) -> None:
    tasks = getattr(w, "_bg_tasks", None)
    if tasks:
        await asyncio.gather(*tasks)


@pytest.fixture
def kos_flags_on(monkeypatch):
    """hook + 6c 的 flag 门显式置开 (不依赖 repo .env 的现值)。"""
    monkeypatch.setattr(nw_mod.settings, "mailagent_kos_ingest_enabled", True,
                        raising=False)
    monkeypatch.setattr(nw_mod.settings, "kos_retry_enabled", True, raising=False)
    monkeypatch.setattr(nw_mod.settings, "kos_ingest_dry_run", False, raising=False)
    monkeypatch.setattr(nw_mod.settings, "kos_ingest_priority_floor", "normal",
                        raising=False)
    monkeypatch.setattr(nw_mod.settings, "kos_require_labeled", False, raising=False)


@pytest.fixture
def patched_client(monkeypatch):
    """producer 内部 make_bulk_kos_client 全部拿这个 mock (直推 + repush 两路径)。"""
    client = _mock_client()
    monkeypatch.setattr("src.kos.producer.make_bulk_kos_client", lambda: client)
    return client


# ============================================================
# 台账 deferred 原语
# ============================================================

class TestDeferredLedger:
    def test_record_deferred_creates_pending_row_with_schedule(self, tmp_path):
        db = _db(_store(tmp_path))
        now = time.time()
        ingest_log.record_deferred(db, 1, "sources/email/1", "producer")
        row = _row(db, 1)
        assert row["status"] == "pending" and row["source"] == "producer"
        assert "await_llm_labels" in row["error"]
        assert row["retry_count"] == 0
        lo = now + ingest_log.DEFER_CHECK_INTERVAL_SEC - 5
        hi = now + ingest_log.DEFER_CHECK_INTERVAL_SEC + 5
        assert lo <= row["next_retry_at"] <= hi

    def test_record_deferred_never_overwrites_pushed(self, tmp_path):
        """已入库的事实更强 —— 邮件 fetch 重试成功后 hook 重触发不得降级 pushed。"""
        db = _db(_store(tmp_path))
        ingest_log.record_pushed(db, 1, "s", 2, "producer")
        ingest_log.record_deferred(db, 1, "s", "producer")
        assert _row(db, 1)["status"] == "pushed"

    def test_record_deferred_resets_failed_row(self, tmp_path):
        """邮件重新同步 → 重新走完整判定 (failed 的失败重试计数归零, 回等标签)。"""
        db = _db(_store(tmp_path))
        ingest_log.record_failure(db, 1, "s", "E_KOS_NETWORK", "x", "producer", True)
        ingest_log.record_deferred(db, 1, "s", "producer")
        row = _row(db, 1)
        assert row["status"] == "pending" and row["retry_count"] == 0

    def test_claim_due_deferred_only_due_pending(self, tmp_path):
        db = _db(_store(tmp_path))
        now = time.time()
        conn = sqlite3.connect(db)
        rows = [
            (1, "pending", 3, now - 10),
            (2, "pending", 0, now - 5),
            (3, "pending", 0, now + 999),  # 未到期
            (4, "failed", 0, now - 1),     # failed 不归 deferred 队列
        ]
        for iid, st, rc, next_at in rows:
            conn.execute(
                "INSERT INTO kos_ingest_log "
                "(internal_id, slug, status, retry_count, next_retry_at) "
                "VALUES (?, 's', ?, ?, ?)",
                (iid, st, rc, next_at),
            )
        conn.commit()
        conn.close()
        assert ingest_log.claim_due_deferred(db, 1) == [(1, 3)]  # 升序 + limit
        assert ingest_log.claim_due_deferred(db, 10) == [(1, 3), (2, 0)]

    def test_claim_due_retries_ignores_pending(self, tmp_path):
        """反向隔离: pending 行绝不被 failed 重试队列捞走 (它还没推过)。"""
        db = _db(_store(tmp_path))
        ingest_log.record_deferred(db, 1, "s", "producer")
        _expire_deferred(db, 1)
        assert ingest_log.claim_due_retries(db, 10) == []

    def test_bump_deferred_increments_and_reschedules(self, tmp_path):
        db = _db(_store(tmp_path))
        ingest_log.record_deferred(db, 1, "s", "producer")
        _expire_deferred(db, 1)
        now = time.time()
        ingest_log.bump_deferred(db, 1)
        row = _row(db, 1)
        assert row["status"] == "pending" and row["retry_count"] == 1
        assert row["next_retry_at"] >= now + ingest_log.DEFER_CHECK_INTERVAL_SEC - 5
        # 只动 pending 行
        ingest_log.record_pushed(db, 2, "s", 1, "producer")
        ingest_log.bump_deferred(db, 2)
        assert _row(db, 2)["retry_count"] == 0


class TestLlmSettled:
    @pytest.mark.parametrize("status,expect", [
        ("success", True), ("gave_up", True),
        ("pending", False), ("failed", False),
    ])
    def test_terminal_states(self, tmp_path, status, expect):
        db = _db(_store(tmp_path))
        _seed_llm(db, 1, status)
        assert llm_labels_settled(db, 1) is expect

    def test_no_row_not_settled(self, tmp_path):
        """无行 (LLM dispatch 窗口 / dispatch 失败孤例) → 未定, 靠 checks 上限兜底。"""
        db = _db(_store(tmp_path))
        assert llm_labels_settled(db, 1) is False


# ============================================================
# hook 侧: defer vs 直推 (验收 ①② + 应急回退)
# ============================================================

class TestKosHookDefer:
    @pytest.mark.asyncio
    async def test_llm_active_defers_instead_of_immediate_push(
        self, tmp_path, kos_flags_on, patched_client
    ):
        """🔴 钉修复: LLM 会跑 → hook 不再立即推 (旧行为 = 此刻 labels 恒空照推),
        改为台账落 pending 行等 6c。改动前本测试必失败 (put_page 被调)。"""
        store = _store(tmp_path)
        _save_synced(store, 101)
        w = _hook_watcher(store, llm_active=True)
        w._maybe_trigger_kos_hook(_make_email(101), 101, "page101")
        await _drain_bg(w)
        patched_client.put_page.assert_not_called()
        row = _row(_db(store), 101)
        assert row["status"] == "pending" and "await_llm_labels" in row["error"]

    @pytest.mark.asyncio
    async def test_llm_disabled_pushes_immediately(
        self, tmp_path, kos_flags_on, patched_client, monkeypatch
    ):
        """验收 ②: LLM 未启用 (_llm_runner=None) → 不 defer, 直推入库
        (labels 空是事实而非 race, 不能把这些邮件卡在队列里)。"""
        store = _store(tmp_path)
        _save_synced(store, 102)
        monkeypatch.setattr(
            "src.llm_agent.store.LLMProcessingStore",
            lambda: MagicMock(get_labels=MagicMock(return_value=None)),
        )
        w = _hook_watcher(store, llm_active=False)
        w._maybe_trigger_kos_hook(_make_email(102), 102, "page102")
        await _drain_bg(w)
        patched_client.put_page.assert_called_once()
        assert _row(_db(store), 102)["status"] == "pushed"

    @pytest.mark.asyncio
    async def test_folder_llm_disabled_pushes_immediately(
        self, tmp_path, kos_flags_on, patched_client, monkeypatch
    ):
        """FOLDER_LLM_DISABLED 文件夹不跑 LLM → 没有标签可等, 同样直推。"""
        store = _store(tmp_path)
        _save_synced(store, 103, mailbox="MyProject")
        monkeypatch.setattr(
            "src.llm_agent.store.LLMProcessingStore",
            lambda: MagicMock(get_labels=MagicMock(return_value=None)),
        )
        w = _hook_watcher(
            store, llm_active=True, folder_llm_disabled=frozenset({"MyProject"})
        )
        w._maybe_trigger_kos_hook(
            _make_email(103, mailbox="MyProject"), 103, "page103"
        )
        await _drain_bg(w)
        patched_client.put_page.assert_called_once()
        assert _row(_db(store), 103)["status"] == "pushed"

    @pytest.mark.asyncio
    async def test_retry_flag_off_falls_back_to_immediate_push(
        self, tmp_path, kos_flags_on, patched_client, monkeypatch
    ):
        """应急回退: MAILAGENT_KOS_RETRY_ENABLED=false → 6c 不跑, defer 无消费者
        会永久卡队 → hook 保持直推老行为 (带 race 但不丢数据)。"""
        store = _store(tmp_path)
        _save_synced(store, 104)
        monkeypatch.setattr(nw_mod.settings, "kos_retry_enabled", False,
                            raising=False)
        monkeypatch.setattr(
            "src.llm_agent.store.LLMProcessingStore",
            lambda: MagicMock(get_labels=MagicMock(return_value=None)),
        )
        w = _hook_watcher(store, llm_active=True)
        w._maybe_trigger_kos_hook(_make_email(104), 104, "page104")
        await _drain_bg(w)
        patched_client.put_page.assert_called_once()
        assert _row(_db(store), 104)["status"] == "pushed"

    @pytest.mark.asyncio
    async def test_dry_run_stays_on_immediate_path(
        self, tmp_path, kos_flags_on, patched_client, monkeypatch
    ):
        """dry_run 语义不变: 不 defer (defer 后 6c repush 是真推), 走直推路径的
        dry-run 分支 → 不真推、台账 skipped(dry_run)。"""
        store = _store(tmp_path)
        _save_synced(store, 105)
        monkeypatch.setattr(nw_mod.settings, "kos_ingest_dry_run", True,
                            raising=False)
        monkeypatch.setattr(
            "src.llm_agent.store.LLMProcessingStore",
            lambda: MagicMock(get_labels=MagicMock(return_value=None)),
        )
        w = _hook_watcher(store, llm_active=True)
        w._maybe_trigger_kos_hook(_make_email(105), 105, "page105")
        await _drain_bg(w)
        patched_client.put_page.assert_not_called()
        row = _row(_db(store), 105)
        assert row["status"] == "skipped" and "dry_run" in row["error"]


# ============================================================
# 6c 扫描侧: 标签就位后首推 (验收 ①③④ + 兜底)
# ============================================================

class TestDeferredScan:
    @pytest.mark.asyncio
    async def test_labels_ready_pushes_with_ai_labels(
        self, tmp_path, kos_flags_on, patched_client
    ):
        """验收 ①: llm_processing 终态 success + labels 就位 → 6c 首推, payload
        真的带 AI 标签 (与 bulk 路径形态一致)。"""
        store = _store(tmp_path)
        db = _db(store)
        _save_synced(store, 201)
        ingest_log.record_deferred(db, 201, "sources/email/201", "producer")
        _expire_deferred(db, 201)
        _seed_llm(db, 201, "success", labels={
            "priority": "🔴 紧急", "action_type": "回复", "ai_summary": "重要结论",
        })
        await _scan_watcher(store)._process_kos_retry_queue()
        patched_client.put_page.assert_called_once()
        slug, content = patched_client.put_page.call_args.args
        assert slug == "sources/email/201"
        assert "ai_priority: '🔴 紧急'" in content
        assert "重要结论" in content
        assert _row(db, 201)["status"] == "pushed"

    @pytest.mark.asyncio
    async def test_low_priority_correctly_floored_after_labels(
        self, tmp_path, kos_flags_on, patched_client
    ):
        """floor 修复实证: ⚪低 邮件在标签就位后被 floor=normal 正确拦下 (skipped)。
        修复前 labels 恒空 → None→normal 恒过 floor → 23 封 ⚪低 误入库。"""
        store = _store(tmp_path)
        db = _db(store)
        _save_synced(store, 202)
        ingest_log.record_deferred(db, 202, "sources/email/202", "producer")
        _expire_deferred(db, 202)
        _seed_llm(db, 202, "success", labels={"priority": "⚪ 低"})
        await _scan_watcher(store)._process_kos_retry_queue()
        patched_client.put_page.assert_not_called()
        row = _row(db, 202)
        assert row["status"] == "skipped" and "priority_floor" in row["error"]

    @pytest.mark.asyncio
    async def test_gave_up_pushes_without_labels(
        self, tmp_path, kos_flags_on, patched_client
    ):
        """验收 ③: LLM 失败重试到 gave_up → 不会再有标签 → 无标签保底入库
        (等标签绝不能把数据质量问题变成数据丢失问题)。"""
        store = _store(tmp_path)
        db = _db(store)
        _save_synced(store, 203)
        ingest_log.record_deferred(db, 203, "sources/email/203", "producer")
        _expire_deferred(db, 203)
        _seed_llm(db, 203, "gave_up")
        await _scan_watcher(store)._process_kos_retry_queue()
        patched_client.put_page.assert_called_once()
        assert _row(db, 203)["status"] == "pushed"

    @pytest.mark.asyncio
    async def test_not_settled_bumps_without_push_or_probe(
        self, tmp_path, kos_flags_on, patched_client
    ):
        """LLM 还在跑 (pending) → 只 bump 检查轮数, 不推; 全 waiting 的 tick 连
        探活都不发 (无网络工作)。"""
        store = _store(tmp_path)
        db = _db(store)
        _save_synced(store, 204)
        ingest_log.record_deferred(db, 204, "sources/email/204", "producer")
        _expire_deferred(db, 204)
        _seed_llm(db, 204, "pending")
        await _scan_watcher(store)._process_kos_retry_queue()
        patched_client.put_page.assert_not_called()
        patched_client.health.assert_not_called()
        row = _row(db, 204)
        assert row["status"] == "pending" and row["retry_count"] == 1
        assert row["next_retry_at"] > time.time()  # 已重排到未来

    @pytest.mark.asyncio
    async def test_orphan_reaches_cap_then_pushes(
        self, tmp_path, kos_flags_on, patched_client
    ):
        """孤例兜底 (实测 internal_id=1000010856 无 llm_processing 行): 等待轮数
        达 DEFER_MAX_CHECKS 后无标签也推, 不永久卡队。"""
        store = _store(tmp_path)
        db = _db(store)
        _save_synced(store, 205)
        ingest_log.record_deferred(db, 205, "sources/email/205", "producer")
        conn = sqlite3.connect(db)
        conn.execute(
            "UPDATE kos_ingest_log SET retry_count = ?, next_retry_at = ? "
            "WHERE internal_id = 205",
            (ingest_log.DEFER_MAX_CHECKS, time.time() - 1),
        )
        conn.commit()
        conn.close()
        await _scan_watcher(store)._process_kos_retry_queue()
        patched_client.put_page.assert_called_once()
        assert _row(db, 205)["status"] == "pushed"

    @pytest.mark.asyncio
    async def test_no_double_push_after_pushed(
        self, tmp_path, kos_flags_on, patched_client
    ):
        """验收 ④: 首推成功转 pushed → 后续 tick claim 不到, 不会推第二次。"""
        store = _store(tmp_path)
        db = _db(store)
        _save_synced(store, 206)
        ingest_log.record_deferred(db, 206, "sources/email/206", "producer")
        _expire_deferred(db, 206)
        _seed_llm(db, 206, "success", labels={"priority": "🔴 紧急"})
        w = _scan_watcher(store)
        await w._process_kos_retry_queue()
        await w._process_kos_retry_queue()
        assert patched_client.put_page.call_count == 1
        assert _row(db, 206)["status"] == "pushed"

    @pytest.mark.asyncio
    async def test_mixed_failed_and_deferred_one_tick(
        self, tmp_path, kos_flags_on, patched_client
    ):
        """failed 重试与 label-ready deferred 同 tick 都被处理 (两队列并行不互挤)。"""
        store = _store(tmp_path)
        db = _db(store)
        for iid in (207, 208):
            _save_synced(store, iid)
        ingest_log.record_failure(db, 207, "sources/email/207", "E_KOS_NETWORK",
                                  "x", "producer", True)
        conn = sqlite3.connect(db)
        conn.execute(
            "UPDATE kos_ingest_log SET next_retry_at = ? WHERE internal_id = 207",
            (time.time() - 1,),
        )
        conn.commit()
        conn.close()
        ingest_log.record_deferred(db, 208, "sources/email/208", "producer")
        _expire_deferred(db, 208)
        _seed_llm(db, 208, "success", labels={"priority": "🔴 紧急"})
        await _scan_watcher(store)._process_kos_retry_queue()
        assert patched_client.put_page.call_count == 2
        assert _row(db, 207)["status"] == "pushed"
        assert _row(db, 208)["status"] == "pushed"
