"""issue #59 KOS 入库可靠性: 台账 (kos_ingest_log v41) + 三态返回 + 重试扫描 + 探活联动。

对应 PRD (.trellis/tasks/07-25-kos-issue-59-llm-dashboard/prd.md) 验收标准:
  1. 推送失败 → 台账 failed + 正确 error_code (不再伪装成 skipped)
  2. KOS 恢复 → 重试扫描把 failed 全推成 pushed, 无需人工介入
  3. 健康探活失败 → 整轮跳过, retry_count 不增长
  4. 永久类错误码不进重试队列, 直接终态 dead
  5. 超重试上限转 dead
  6. bulk 不再重推 producer 已成功的邮件 (台账共用); skipped 不算 done
  9. DB_VERSION 已 bump (前端 EXPECTED_DB_VERSION 一致性由
     frontend/tests/main/db_version_consistency.test.ts 兜底)
 10. 迁移在「已被 bulk 惰性建过旧形状表」的老库上幂等成功
"""

from __future__ import annotations

import sqlite3
import time
from unittest.mock import MagicMock

import pytest

from src.kos import ingest_log
from src.kos.bulk_ingest import KOSBulkIngester
from src.kos.client import KOSClient, KOSError
from src.kos.producer import (
    KosPushOutcome,
    push_email_to_kos,
    repush_stored_email_to_kos,
)
from src.mail import new_watcher as nw_mod
from src.mail.new_watcher import NewWatcher
from src.mail.sync_store import SyncStore
from src.models import Email


# ============================================================
# helpers
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


def _state(db_path: str, key: str):
    conn = sqlite3.connect(db_path)
    try:
        r = conn.execute(
            "SELECT value FROM sync_state WHERE key = ?", (key,)
        ).fetchone()
        return r[0] if r else None
    finally:
        conn.close()


def _make_email(internal_id: int = 1) -> Email:
    return Email(
        message_id=f"<m{internal_id}@x>", subject="s", sender="a@x.com",
        mailbox="收件箱",
    )


def _mock_client(*, configured=True, put_result=None, put_side_effect=None,
                 health=None, health_side_effect=None) -> MagicMock:
    client = MagicMock(spec=KOSClient)
    client.configured = configured
    if put_side_effect is not None:
        client.put_page = MagicMock(side_effect=put_side_effect)
    else:
        client.put_page = MagicMock(
            return_value=put_result or {"status": "created_or_updated", "chunks": 2}
        )
    if health_side_effect is not None:
        client.health = MagicMock(side_effect=health_side_effect)
    else:
        client.health = MagicMock(return_value=health or {"status": "ok"})
    return client


_NET_ERR = KOSError("connect timeout", code="E_KOS_NETWORK")


# ============================================================
# schema / migration (验收 9, 10)
# ============================================================

class TestSchemaMigration:
    def test_db_version_includes_avatar_migration(self):
        # v43 引入 avatar 迁移；后续版本推进（v44 matters、v45 资源域）不该让本测试
        # 变红——钉下界而非死等号（死 pin 在 P1 升 44 时就已断，因 kos 目录不在
        # P1 验收口径里才拖到 P2 才被发现）。
        assert SyncStore.DB_VERSION >= 43

    def test_fresh_db_has_full_schema_and_index(self, tmp_path):
        store = _store(tmp_path)
        conn = sqlite3.connect(_db(store))
        cols = {r[1] for r in conn.execute("PRAGMA table_info(kos_ingest_log)")}
        assert {"internal_id", "slug", "status", "chunks", "error", "pushed_at",
                "retry_count", "next_retry_at", "error_code", "source"} <= cols
        idx = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_kos_ingest_retry'"
        ).fetchone()
        assert idx is not None
        conn.close()

    def test_migration_idempotent_on_bulk_created_old_shape(self, tmp_path):
        """验收 10: 老库该表已被 bulk_ingest 惰性建成 6 列旧形状 + 有数据 →
        迁移补 4 列不丢行, retry_count 回填默认 0; 重复 init 幂等。"""
        db = str(tmp_path / "old.db")
        conn = sqlite3.connect(db)
        conn.execute("""
            CREATE TABLE kos_ingest_log (
                internal_id INTEGER PRIMARY KEY,
                slug TEXT, status TEXT, chunks INTEGER, error TEXT, pushed_at REAL
            )
        """)
        conn.execute(
            "INSERT INTO kos_ingest_log VALUES (7, 'sources/email/7', 'pushed', 3, NULL, 1.0)"
        )
        conn.commit()
        conn.close()

        SyncStore(db)  # 迁移
        row = _row(db, 7)
        assert row["status"] == "pushed" and row["chunks"] == 3
        assert row["retry_count"] == 0 and row["next_retry_at"] is None

        SyncStore(db)  # 重复 init 幂等
        assert _row(db, 7)["status"] == "pushed"

    def test_migration_schedules_legacy_failed_rows(self, tmp_path):
        """老 bulk 时代的 failed 行 (next_retry_at=NULL) 迁移时排一次立即到期,
        否则永远不满足 due 判据、以「永久积压」形态挂在 Dashboard 上。"""
        db = str(tmp_path / "old.db")
        conn = sqlite3.connect(db)
        conn.execute("""
            CREATE TABLE kos_ingest_log (
                internal_id INTEGER PRIMARY KEY,
                slug TEXT, status TEXT, chunks INTEGER, error TEXT, pushed_at REAL
            )
        """)
        conn.execute(
            "INSERT INTO kos_ingest_log VALUES (8, 's', 'failed', 0, 'boom', 1.0)"
        )
        conn.commit()
        conn.close()
        SyncStore(db)
        assert ingest_log.due_retry_count(db) == 1

    def test_bulk_ensure_log_table_upgrades_old_shape(self, tmp_path):
        """bulk 对未经 SyncStore 迁移的 --db-path 独立跑时, _ensure_log_table
        也要把旧形状补齐 (共用 ensure_kos_ingest_log_schema)。"""
        db = str(tmp_path / "bulk.db")
        conn = sqlite3.connect(db)
        conn.execute("CREATE TABLE email_metadata (internal_id INTEGER PRIMARY KEY, sync_status TEXT)")
        conn.execute("CREATE TABLE llm_processing (internal_id INTEGER PRIMARY KEY, labels_json TEXT)")
        conn.execute("""
            CREATE TABLE kos_ingest_log (
                internal_id INTEGER PRIMARY KEY,
                slug TEXT, status TEXT, chunks INTEGER, error TEXT, pushed_at REAL
            )
        """)
        conn.commit()
        conn.close()
        KOSBulkIngester(db_path=db, client=MagicMock())
        conn = sqlite3.connect(db)
        cols = {r[1] for r in conn.execute("PRAGMA table_info(kos_ingest_log)")}
        conn.close()
        assert {"retry_count", "next_retry_at", "error_code", "source"} <= cols


# ============================================================
# 错误码分类 (PRD §2.2 / D3)
# ============================================================

class TestErrorClassification:
    @pytest.mark.parametrize("code", sorted(ingest_log.TRANSIENT_ERROR_CODES))
    def test_transient_codes(self, code):
        assert ingest_log.is_transient_error(code) is True

    @pytest.mark.parametrize("code", sorted(ingest_log.PERMANENT_ERROR_CODES))
    def test_permanent_codes(self, code):
        assert ingest_log.is_transient_error(code) is False

    def test_http_split_by_status(self):
        assert ingest_log.is_transient_error("E_KOS_HTTP", 500) is True
        assert ingest_log.is_transient_error("E_KOS_HTTP", 503) is True
        assert ingest_log.is_transient_error("E_KOS_HTTP", 404) is False
        assert ingest_log.is_transient_error("E_KOS_HTTP", 422) is False

    def test_http_without_status_conservative_permanent(self):
        """D3: 拿不到 status 保守按永久 (避免对 4xx 无限重试烧预算)。"""
        assert ingest_log.is_transient_error("E_KOS_HTTP", None) is False

    def test_unknown_codes_default_transient(self):
        """未列名 code (E_KOS_TOOL_ERROR / E_KOS_UNEXPECTED / 未来新增) 按瞬时:
        重试有界 (max_attempts 后自落 dead); 误判成永久 = 永久空洞。"""
        assert ingest_log.is_transient_error("E_KOS_TOOL_ERROR") is True
        assert ingest_log.is_transient_error("E_KOS_UNEXPECTED") is True


# ============================================================
# 台账 record 函数
# ============================================================

class TestLedgerRecords:
    def test_first_failure_schedules_first_backoff(self, tmp_path):
        db = _db(_store(tmp_path))
        now = time.time()
        status = ingest_log.record_failure(
            db, 1, "sources/email/1", "E_KOS_NETWORK", "boom", "producer", True
        )
        assert status == "failed"
        row = _row(db, 1)
        assert row["status"] == "failed" and row["error_code"] == "E_KOS_NETWORK"
        assert row["retry_count"] == 0 and row["source"] == "producer"
        assert now + 55 <= row["next_retry_at"] <= now + 65

    def test_repeated_failures_backoff_then_dead(self, tmp_path):
        """验收 5: 首失败 retry_count=0, 每次重试失败 +1, 达 max_attempts 转 dead。"""
        db = _db(_store(tmp_path))
        ingest_log.record_failure(db, 1, "s", "E_KOS_NETWORK", "x", "producer", True,
                                  max_attempts=3)
        for expected_count, expected_status in [(1, "failed"), (2, "failed"), (3, "dead")]:
            status = ingest_log.record_failure(
                db, 1, "s", "E_KOS_NETWORK", "x", "producer", True, max_attempts=3
            )
            row = _row(db, 1)
            assert status == expected_status == row["status"]
            assert row["retry_count"] == expected_count
        assert _row(db, 1)["next_retry_at"] is None  # dead 不再排程

    def test_permanent_error_goes_straight_to_dead(self, tmp_path):
        """验收 4: 永久类不进重试队列。"""
        db = _db(_store(tmp_path))
        status = ingest_log.record_failure(
            db, 1, "s", "E_KOS_UNAUTHORIZED", "401", "producer", False
        )
        assert status == "dead"
        row = _row(db, 1)
        assert row["status"] == "dead" and row["next_retry_at"] is None
        assert ingest_log.due_retry_count(db) == 0

    def test_pushed_clears_retry_state_and_sets_last_success(self, tmp_path):
        db = _db(_store(tmp_path))
        ingest_log.record_failure(db, 1, "s", "E_KOS_NETWORK", "x", "producer", True)
        ingest_log.record_pushed(db, 1, "sources/email/1", 5, "producer")
        row = _row(db, 1)
        assert row["status"] == "pushed" and row["chunks"] == 5
        assert row["retry_count"] == 0 and row["next_retry_at"] is None
        assert row["error"] is None and row["error_code"] is None
        # 值格式 = ISO 字符串 (davmail synced_at 先例, 跨 lane 契约)
        from datetime import datetime as _dt
        assert _dt.fromisoformat(_state(db, ingest_log.STATE_LAST_SUCCESS_AT))

    def test_skipped_never_overwrites_pushed(self, tmp_path):
        db = _db(_store(tmp_path))
        ingest_log.record_pushed(db, 1, "s", 2, "producer")
        ingest_log.record_skipped(db, 1, "s", "priority_floor", "producer")
        assert _row(db, 1)["status"] == "pushed"

    def test_skipped_converges_failed_out_of_retry_queue(self, tmp_path):
        """重推重判时不再够格 → skipped 覆盖 failed, 退出重试队列 (不然永远重扫)。"""
        db = _db(_store(tmp_path))
        ingest_log.record_failure(db, 1, "s", "E_KOS_NETWORK", "x", "producer", True)
        ingest_log.record_skipped(db, 1, "s", "priority_floor", "producer")
        row = _row(db, 1)
        assert row["status"] == "skipped" and row["next_retry_at"] is None

    def test_due_and_claim_honor_schedule_and_limit(self, tmp_path):
        db = _db(_store(tmp_path))
        now = time.time()
        conn = sqlite3.connect(db)
        for iid, next_at in [(1, now - 10), (2, now - 5), (3, now + 999), (4, now - 1)]:
            conn.execute(
                "INSERT INTO kos_ingest_log (internal_id, slug, status, retry_count, next_retry_at) "
                "VALUES (?, 's', 'failed', 0, ?)",
                (iid, next_at),
            )
        conn.commit()
        conn.close()
        assert ingest_log.due_retry_count(db) == 3
        assert ingest_log.claim_due_retries(db, 2) == [1, 2]  # next_retry_at 升序
        assert ingest_log.claim_due_retries(db, 10) == [1, 2, 4]

    def test_health_transitions_and_recovered_signal(self, tmp_path):
        db = _db(_store(tmp_path))
        assert ingest_log.record_health(db, False, "conn refused") is False
        assert _state(db, ingest_log.STATE_HEALTH_STATUS) == "error"
        assert _state(db, ingest_log.STATE_HEALTH_CONSEC_FAILURES) == "1"
        assert ingest_log.record_health(db, False, "still down") is False
        assert _state(db, ingest_log.STATE_HEALTH_CONSEC_FAILURES) == "2"
        # error → ok = 刚恢复 (重试 worker 放宽 chunk 的信号)
        assert ingest_log.record_health(db, True) is True
        assert _state(db, ingest_log.STATE_HEALTH_STATUS) == "ok"
        assert _state(db, ingest_log.STATE_HEALTH_CONSEC_FAILURES) == "0"
        assert _state(db, ingest_log.STATE_HEALTH_ERROR) == ""
        # ok → ok 不算恢复
        assert ingest_log.record_health(db, True) is False


# ============================================================
# 通知中心接线 (task 08-20-notification-center M2 批 B3b, design §7「KOS 推送放弃 dead」行)
# ============================================================

def _notifications(db_path: str) -> list[dict]:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute("SELECT * FROM notification ORDER BY id").fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


class TestDeadNotification:
    def test_permanent_error_notifies_dead(self, tmp_path):
        db = _db(_store(tmp_path))
        status = ingest_log.record_failure(
            db, 1, "sources/email/1", "E_KOS_UNAUTHORIZED", "401", "producer", False
        )
        assert status == "dead"

        rows = _notifications(db)
        assert len(rows) == 1
        row = rows[0]
        assert row["category"] == "system"
        assert row["severity"] == "warn"
        assert row["source"] == "kos"
        assert row["dedupe_key"] == "kos_ingest:dead"
        assert "internal_id=1" in row["body"] and "E_KOS_UNAUTHORIZED" in row["body"]
        import json as _json
        payload = _json.loads(row["payload_json"])
        assert payload["link"] == {"type": "route", "to": "/settings", "search": {"tab": "integrations"}}

    def test_retry_exhausted_dead_notifies(self, tmp_path):
        db = _db(_store(tmp_path))
        for _ in range(2):
            ingest_log.record_failure(db, 1, "s", "E_KOS_NETWORK", "x", "producer", True,
                                      max_attempts=2)
        status = ingest_log.record_failure(
            db, 1, "s", "E_KOS_NETWORK", "x", "producer", True, max_attempts=2
        )
        assert status == "dead"
        rows = _notifications(db)
        assert len(rows) == 1
        assert rows[0]["severity"] == "warn"

    def test_failed_not_dead_does_not_notify(self, tmp_path):
        db = _db(_store(tmp_path))
        status = ingest_log.record_failure(
            db, 1, "s", "E_KOS_NETWORK", "x", "producer", True
        )
        assert status == "failed"
        assert _notifications(db) == []

    def test_two_distinct_dead_events_aggregate_and_bump_recurrence(self, tmp_path):
        """design §3.2: 聚合到同一 dedupe_key, 不逐条开行 (骚扰面对策)。"""
        db = _db(_store(tmp_path))
        ingest_log.record_failure(db, 1, "s1", "E_KOS_UNAUTHORIZED", "401", "producer", False)
        ingest_log.record_failure(db, 2, "s2", "E_KOS_NOT_CONFIGURED", "no cfg", "producer", False)

        rows = _notifications(db)
        assert len(rows) == 1
        assert rows[0]["recurrence_no"] == 2
        assert "internal_id=2" in rows[0]["body"]  # 文案刷新为最新一次

    def test_notify_publish_failure_does_not_break_ledger_write(self, tmp_path, monkeypatch):
        from src.notify.center import NotifyCenter

        def boom(*a, **kw):
            raise RuntimeError("notify center down")

        monkeypatch.setattr(NotifyCenter, "publish", boom)
        db = _db(_store(tmp_path))
        status = ingest_log.record_failure(
            db, 1, "s", "E_KOS_UNAUTHORIZED", "401", "producer", False
        )
        assert status == "dead"
        assert _row(db, 1)["status"] == "dead"


# ============================================================
# producer 三态 + 台账双写 (验收 1)
# ============================================================

class TestProducerLedgerIntegration:
    @pytest.mark.asyncio
    async def test_failure_writes_failed_row_with_code(self, tmp_path):
        """验收 1: 失败 → 台账 failed + 正确 error_code (不再无痕丢弃)。"""
        db = _db(_store(tmp_path))
        client = _mock_client(put_side_effect=KOSError(
            "token network", code="E_KOS_TOKEN_NETWORK"))
        outcome = await push_email_to_kos(
            _make_email(1), 1, ai_priority="critical", priority_floor="normal",
            client=client, db_path=db,
        )
        assert outcome.failed and outcome.error_code == "E_KOS_TOKEN_NETWORK"
        row = _row(db, 1)
        assert row["status"] == "failed"
        assert row["error_code"] == "E_KOS_TOKEN_NETWORK"
        assert row["source"] == "producer" and row["next_retry_at"] is not None

    @pytest.mark.asyncio
    async def test_success_writes_pushed_row(self, tmp_path):
        db = _db(_store(tmp_path))
        client = _mock_client(put_result={"status": "created_or_updated", "chunks": 4})
        outcome = await push_email_to_kos(
            _make_email(2), 2, ai_priority="critical", priority_floor="normal",
            client=client, db_path=db,
        )
        assert outcome.pushed
        row = _row(db, 2)
        assert row["status"] == "pushed" and row["chunks"] == 4

    @pytest.mark.asyncio
    async def test_floor_skip_writes_skipped_row(self, tmp_path):
        db = _db(_store(tmp_path))
        client = _mock_client()
        outcome = await push_email_to_kos(
            _make_email(3), 3, ai_priority="low", priority_floor="normal",
            client=client, db_path=db,
        )
        assert outcome.skipped and outcome.reason == "priority_floor"
        row = _row(db, 3)
        assert row["status"] == "skipped" and "priority_floor" in row["error"]

    @pytest.mark.asyncio
    async def test_no_db_path_means_no_ledger(self, tmp_path):
        """向后兼容: 不传 db_path (直调/测试) → 不写台账。"""
        db = _db(_store(tmp_path))
        client = _mock_client(put_side_effect=_NET_ERR)
        outcome = await push_email_to_kos(
            _make_email(4), 4, ai_priority="critical", priority_floor="normal",
            client=client,
        )
        assert outcome.failed
        assert _row(db, 4) is None

    @pytest.mark.asyncio
    async def test_ledger_write_failure_does_not_raise(self, tmp_path, monkeypatch):
        """fire-and-forget 纪律: 写台账炸了也只 warning, 不上抛。"""
        db = _db(_store(tmp_path))
        client = _mock_client()
        monkeypatch.setattr(
            ingest_log, "record_pushed",
            MagicMock(side_effect=sqlite3.OperationalError("locked")),
        )
        outcome = await push_email_to_kos(
            _make_email(5), 5, ai_priority="critical", priority_floor="normal",
            client=client, db_path=db,
        )
        assert outcome.pushed  # 推送本身成功, 台账失败不改变结局


# ============================================================
# repush (重试路径, 与增量同路径)
# ============================================================

class TestRepushStoredEmail:
    @pytest.mark.asyncio
    async def test_repush_success_converges_failed_to_pushed(self, tmp_path):
        """验收 2 内核: failed 行经重推转 pushed, 无需人工。"""
        store = _store(tmp_path)
        db = _db(store)
        _save_synced(store, 10)
        ingest_log.record_failure(db, 10, "sources/email/10", "E_KOS_NETWORK", "x",
                                  "producer", True)
        client = _mock_client()
        outcome = await repush_stored_email_to_kos(db, 10, client=client)
        assert outcome.pushed
        assert _row(db, 10)["status"] == "pushed"
        # payload 走同一 builder: put_page(slug, content)
        args = client.put_page.call_args.args
        assert args[0] == "sources/email/10" and args[1].startswith("---\n")

    @pytest.mark.asyncio
    async def test_repush_gate_change_converges_to_skipped(self, tmp_path):
        """重判时 gate 不过 (require_labeled 且未标注) → skipped 退出队列。"""
        store = _store(tmp_path)
        db = _db(store)
        _save_synced(store, 11)
        ingest_log.record_failure(db, 11, "s", "E_KOS_NETWORK", "x", "producer", True)
        client = _mock_client()
        outcome = await repush_stored_email_to_kos(
            db, 11, client=client, require_labeled=True,
        )
        assert outcome.skipped and outcome.reason == "unlabeled"
        assert _row(db, 11)["status"] == "skipped"
        client.put_page.assert_not_called()

    @pytest.mark.asyncio
    async def test_repush_metadata_gone_marks_dead(self, tmp_path):
        store = _store(tmp_path)
        db = _db(store)
        ingest_log.record_failure(db, 12, "s", "E_KOS_NETWORK", "x", "producer", True)
        outcome = await repush_stored_email_to_kos(db, 12, client=_mock_client())
        assert outcome.failed and outcome.error_code == "E_KOS_SOURCE_GONE"
        assert _row(db, 12)["status"] == "dead"


# ============================================================
# watcher 第 6c 步 _process_kos_retry_queue (验收 2, 3)
# ============================================================

def _watcher(store: SyncStore) -> NewWatcher:
    w = NewWatcher.__new__(NewWatcher)
    w.sync_store = store
    w._kos_unhealthy_until = None
    return w


@pytest.fixture
def retry_flags_on(monkeypatch):
    """6c 的两道 flag 门显式置开 (不依赖 repo .env 的现值)。"""
    monkeypatch.setattr(nw_mod.settings, "mailagent_kos_ingest_enabled", True,
                        raising=False)
    monkeypatch.setattr(nw_mod.settings, "kos_retry_enabled", True, raising=False)


def _seed_failed(store: SyncStore, ids: list[int]) -> None:
    # 先存邮件、再统一写台账 —— 不能在持有未提交写事务的连接期间交错走 store 的
    # 另一条连接 save_email (会互等写锁, 30s busy timeout 把测试拖成分钟级)。
    for iid in ids:
        _save_synced(store, iid)
    db = _db(store)
    now = time.time()
    conn = sqlite3.connect(db)
    for iid in ids:
        conn.execute(
            "INSERT INTO kos_ingest_log "
            "(internal_id, slug, status, retry_count, next_retry_at, error_code, source) "
            "VALUES (?, ?, 'failed', 0, ?, 'E_KOS_NETWORK', 'producer')",
            (iid, f"sources/email/{iid}", now - 1),
        )
    conn.commit()
    conn.close()


class TestKosRetryQueue:
    @pytest.mark.asyncio
    async def test_healthy_tick_drains_batch(self, tmp_path, monkeypatch, retry_flags_on):
        """验收 2: KOS 恢复后重试队列把 failed 推成 pushed, 无需人工。"""
        store = _store(tmp_path)
        _seed_failed(store, [21, 22, 23])
        client = _mock_client()
        monkeypatch.setattr("src.kos.producer.make_bulk_kos_client", lambda: client)
        await _watcher(store)._process_kos_retry_queue()
        for iid in (21, 22, 23):
            assert _row(_db(store), iid)["status"] == "pushed"
        assert _state(_db(store), ingest_log.STATE_HEALTH_STATUS) == "ok"

    @pytest.mark.asyncio
    async def test_batch_capped_per_tick(self, tmp_path, monkeypatch, retry_flags_on):
        """镜像 6b 的 limit=3/tick: 5 封到期一个 tick 只推 3 封, 其余下 tick 再来。"""
        store = _store(tmp_path)
        _seed_failed(store, [41, 42, 43, 44, 45])
        client = _mock_client()
        monkeypatch.setattr("src.kos.producer.make_bulk_kos_client", lambda: client)
        await _watcher(store)._process_kos_retry_queue()
        rows = [_row(_db(store), iid) for iid in (41, 42, 43, 44, 45)]
        assert sum(1 for r in rows if r["status"] == "pushed") == nw_mod.KOS_RETRY_BATCH_PER_TICK
        assert sum(1 for r in rows if r["status"] == "failed") == 2

    @pytest.mark.asyncio
    async def test_unhealthy_skips_and_cools_down_no_burn(self, tmp_path, monkeypatch,
                                                          retry_flags_on):
        """验收 3: 探活失败 → 整段跳过、不逐封试、retry_count 不增长; 冷却期内
        连探活都不再发 (不对着倒掉的 KOS 每 5s tick 空转)。"""
        store = _store(tmp_path)
        _seed_failed(store, [31, 32])
        client = _mock_client(health_side_effect=RuntimeError("conn refused"))
        monkeypatch.setattr("src.kos.producer.make_bulk_kos_client", lambda: client)
        w = _watcher(store)
        await w._process_kos_retry_queue()
        client.put_page.assert_not_called()
        for iid in (31, 32):
            row = _row(_db(store), iid)
            assert row["status"] == "failed" and row["retry_count"] == 0
        assert _state(_db(store), ingest_log.STATE_HEALTH_STATUS) == "error"
        assert w._kos_unhealthy_until is not None
        # 冷却期内的下一个 tick: 探活不再发 (call_count 不涨)
        await w._process_kos_retry_queue()
        assert client.health.call_count == 1

    @pytest.mark.asyncio
    async def test_no_backlog_no_health_probe(self, tmp_path, monkeypatch, retry_flags_on):
        """无到期行 → 不探活不推送 (每 tick 只有一次轻量 SQLite 队列探测)。"""
        store = _store(tmp_path)
        client = _mock_client()
        monkeypatch.setattr("src.kos.producer.make_bulk_kos_client", lambda: client)
        await _watcher(store)._process_kos_retry_queue()
        client.health.assert_not_called()
        client.put_page.assert_not_called()

    @pytest.mark.asyncio
    async def test_flag_gates_make_it_inert(self, tmp_path, monkeypatch):
        """flag 门: ingest 关 / retry 显式 false → 连队列探测都不发, 行原样。"""
        store = _store(tmp_path)
        _seed_failed(store, [51])
        client = _mock_client()
        monkeypatch.setattr("src.kos.producer.make_bulk_kos_client", lambda: client)
        w = _watcher(store)

        monkeypatch.setattr(nw_mod.settings, "mailagent_kos_ingest_enabled", False,
                            raising=False)
        await w._process_kos_retry_queue()
        client.health.assert_not_called()

        monkeypatch.setattr(nw_mod.settings, "mailagent_kos_ingest_enabled", True,
                            raising=False)
        monkeypatch.setattr(nw_mod.settings, "kos_retry_enabled", False, raising=False)
        await w._process_kos_retry_queue()  # env 显式 false 应急回退
        client.health.assert_not_called()
        assert _row(_db(store), 51)["status"] == "failed"


# ============================================================
# bulk 与增量共用台账 (验收 6)
# ============================================================

class TestBulkSharesLedger:
    def test_bulk_done_means_pushed_only(self, tmp_path):
        """验收 6: 「done = 仅 status='pushed'」—— producer 已成功的 bulk 不重推
        (省整页 re-embed); producer 记的 failed/skipped **不算 done**, 否则默认的
        bulk 补漏跑恰恰漏掉需要补的那批 (team-lead 核实点 2)。"""
        store = _store(tmp_path)
        db = _db(store)
        for iid in (1, 2, 3, 4, 5):
            _save_synced(store, iid)
        ingest_log.record_pushed(db, 1, "s", 2, "producer")   # 增量已成功
        ingest_log.record_skipped(db, 2, "s", "priority_floor", "producer")
        ingest_log.record_failure(db, 3, "s", "E_KOS_NETWORK", "x", "producer", True)
        # 4/5 无台账行
        ing = KOSBulkIngester(db_path=db, client=MagicMock())
        assert set(ing._candidates(None, False, False)) == {2, 3, 4, 5}
        # v41 起 --retry-failed 与默认等价 (参数保留仅为 CLI 兼容)
        assert set(ing._candidates(None, True, False)) == {2, 3, 4, 5}

    def test_bulk_failure_enters_retry_queue(self, tmp_path):
        """bulk 失败也进统一重试队列 (瞬时 → failed + 排程, 增量 worker 会补)。"""
        store = _store(tmp_path)
        db = _db(store)
        _save_synced(store, 9)
        client = MagicMock(spec=KOSClient)
        client.configured = True
        ing = KOSBulkIngester(db_path=db, client=client)
        ing._build_one = lambda iid: (f"sources/email/{iid}", "content")  # type: ignore[method-assign]
        ing._put_with_retry = MagicMock(side_effect=KOSError(
            "down", code="E_KOS_NETWORK"))
        stats = ing.run(verify_canary=False)
        assert stats["failed"] == 1
        row = _row(db, 9)
        assert row["status"] == "failed" and row["source"] == "bulk"
        assert row["error_code"] == "E_KOS_NETWORK" and row["next_retry_at"] is not None


class TestOutcomeShape:
    def test_outcome_flags(self):
        assert KosPushOutcome(status="pushed").pushed
        assert KosPushOutcome(status="skipped").skipped
        assert KosPushOutcome(status="failed").failed
