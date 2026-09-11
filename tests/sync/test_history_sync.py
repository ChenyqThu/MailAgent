"""同步历史邮件 (task 09-11) 的执行器 —— ``src/sync/history_sync.py``。

钉死的不变量:

- **只补不删**: 本地已有的邮件一行都不动; 扫描之后才被 watcher 抢先收进来的那封
  (merge guard 命中) 算"已存在", 不是失败也不是新增;
- 补回来的行带 ``ingest_reason='history_sync'`` —— 三个实时性钩子据它不触发;
- **增量水位全程不动** (历史同步与增量链路无关);
- 新邮件优先于历史邮件被处理 (pending 按收信时间从新到旧取);
- 取消: 不再投喂, 已入库的照常处理完, 终态 aborted;
- 停滞 (watcher 没在跑): 结束并留下**可见原因**, 不静默显示成功;
- 进程重启续跑: 不重复入库, 累计计数接着累加;
- 截断视图: 覆盖不完整必须原样上报。
"""
from __future__ import annotations

import os

os.environ.setdefault("USER_EMAIL", "ci@example.test")

from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from src.mail.backend.types import HistoryScanResult
from src.mail.sync_store import SyncStore
from src.services.errors import ServiceInvalidArgError
from src.sync import history_sync as hs

TODAY = date.today()
SINCE = (TODAY - timedelta(days=1)).isoformat()
UNTIL = TODAY.isoformat()


def _row(msgid: str, *, hours_ago: int = 1, mailbox: str = "收件箱") -> dict:
    when = datetime.now(timezone.utc) - timedelta(hours=hours_ago)
    return {
        "message_id": msgid,
        "subject": f"subject {msgid}",
        "sender": "alice@example.test",
        "sender_name": "Alice",
        "date_received": when.isoformat(),
        "mailbox": mailbox,
        "is_read": False,
        "is_flagged": False,
        "thread_id": None,
        "backend_origin": "davmail",
        "imap_uid": 1,
    }


class _Backend:
    """窗口扫描替身。"""

    def __init__(self, rows, *, complete=True, covered_from=None):
        self.rows = rows
        self.complete = complete
        self.covered_from = covered_from
        self.windows: list[tuple] = []

    def scan_history_window(self, since_utc, until_utc):
        self.windows.append((since_utc, until_utc))
        # 每个切片都返回同一批 (调用方按 Message-ID 归并) —— 顺带证明切片间去重有效。
        return HistoryScanResult(
            items=[dict(r) for r in self.rows],
            complete=self.complete,
            covered_from=self.covered_from,
        )


class _Pipeline:
    """watcher 待同步流水线的替身: 每次被调用就把若干 pending 行推进到终态。

    挂在 ``time.sleep`` 上 —— runner 每等一拍, 流水线就前进一步, 测试因此零真实等待。
    """

    def __init__(self, store, *, outcome="synced", per_tick=10):
        self.store = store
        self.outcome = outcome
        self.per_tick = per_tick
        self.ticks = 0

    def __call__(self, _seconds=0):
        self.ticks += 1
        if self.outcome == "stall":
            return
        for meta in self.store.get_pending_emails(limit=self.per_tick):
            iid = meta["internal_id"]
            if self.outcome == "synced":
                self.store.mark_synced_v3(iid, f"page-{iid}")
            elif self.outcome == "local_only":
                self.store.mark_skipped(iid, reason="notion_date_filter")
            elif self.outcome == "failed":
                self.store.mark_failed_v3(iid, "boom")


@pytest.fixture()
def store(tmp_path):
    return SyncStore(str(tmp_path / "t.db"))


@pytest.fixture(autouse=True)
def fast_clock(monkeypatch):
    """把等待节拍压到 0, 停滞阈值压到"两拍没动静"。"""
    monkeypatch.setattr(hs, "POLL_INTERVAL_SEC", 0)
    monkeypatch.setattr(hs, "THROTTLE_WAIT_SEC", 0)
    monkeypatch.setattr(hs, "STALL_TIMEOUT_SEC", 0.05)
    monkeypatch.setattr(hs, "CANCEL_DRAIN_SEC", 0.05)


def _deps(store, backend):
    return SimpleNamespace(sync_store=store, backend=backend)


def _run(store, backend, *, job_id=1, since=SINCE, until=UNTIL, hook=None):
    return hs.run_history_sync_job(
        _deps(store, backend), job_id=job_id,
        params={"since": since, "until": until}, on_unit_done=hook,
    )


def _live(store, job_id=1):
    return hs.read_live_state(store, job_id)


def _rows(store) -> list[dict]:
    return [store.get(i) for i in _ids(store)]


def _ids(store) -> list[int]:
    import sqlite3

    conn = sqlite3.connect(str(store.db_path))
    try:
        return [r[0] for r in conn.execute(
            "SELECT internal_id FROM email_metadata ORDER BY internal_id"
        )]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 参数校验 (与前端同一条式子, design §5.1)
# ---------------------------------------------------------------------------


def test_span_rule_is_a_date_difference():
    """跨度判据是日期差: 365 天合法, 366 天不合法。"""
    today = date(2026, 9, 11)
    hs.validate_range("2025-09-11", "2026-09-11", today=today)     # 差 365
    with pytest.raises(ServiceInvalidArgError):
        hs.validate_range("2025-09-10", "2026-09-11", today=today)  # 差 366


def test_range_order_and_future_are_rejected():
    today = date(2026, 9, 11)
    with pytest.raises(ServiceInvalidArgError):
        hs.validate_range("2026-09-11", "2026-09-10", today=today)
    with pytest.raises(ServiceInvalidArgError):
        hs.validate_range("2026-09-01", "2026-09-12", today=today)
    with pytest.raises(ServiceInvalidArgError):
        hs.validate_range("not-a-date", "2026-09-11", today=today)


def test_day_slices_are_newest_first_and_cover_every_day():
    slices = hs._day_slices(date(2026, 9, 9), date(2026, 9, 11))
    assert len(slices) == 3
    assert slices[0][0] > slices[1][0] > slices[2][0]     # 最新的一天先扫
    # 逐天首尾相接, 不留缝也不重叠
    assert slices[0][0] == slices[1][1]
    assert slices[1][0] == slices[2][1]


def test_unsupported_backend_is_rejected(store):
    with pytest.raises(ServiceInvalidArgError):
        _run(store, SimpleNamespace())        # 没有 scan_history_window


# ---------------------------------------------------------------------------
# 入库语义
# ---------------------------------------------------------------------------


def test_missing_mail_is_ingested_with_history_provenance(store, monkeypatch):
    backend = _Backend([_row("a@t"), _row("b@t")])
    monkeypatch.setattr(hs.time, "sleep", _Pipeline(store))

    results, summary = _run(store, backend)

    rows = _rows(store)
    assert sorted(r["message_id"] for r in rows) == ["a@t", "b@t"]
    assert {r["ingest_reason"] for r in rows} == {"history_sync"}
    assert (summary.total, summary.succeeded, summary.failed) == (2, 2, 0)
    counts = _live(store)["counts"]
    assert (counts["added"], counts["notion_synced"], counts["existing"]) == (2, 2, 0)


def test_local_mail_is_left_alone(store, monkeypatch):
    """本地已有的不重复入库、也不改动既有行。"""
    store.save_email({
        "internal_id": 42, "message_id": "a@t", "subject": "old",
        "date_received": datetime.now(timezone.utc).isoformat(),
        "mailbox": "收件箱", "sync_status": "synced", "notion_page_id": "p-old",
    })
    backend = _Backend([_row("a@t"), _row("b@t")])
    monkeypatch.setattr(hs.time, "sleep", _Pipeline(store))

    _, summary = _run(store, backend)

    assert store.get(42)["notion_page_id"] == "p-old"       # 一行都没动
    assert summary.total == 1                                # 只有 b@t 是缺的
    counts = _live(store)["counts"]
    assert (counts["existing"], counts["added"]) == (1, 1)


def test_watcher_winning_the_race_counts_as_existing_not_failed(store, monkeypatch):
    """判出"本地缺"之后、这封写进去之前, watcher 先把它收了进来。

    竞态窗口在**指纹比对与写入之间** —— 比对用的是那一刻的快照, 所以这里让
    ``get_all_message_ids`` 返回旧快照、返回前把邮件落库。写入时 message_id 撞
    UNIQUE → merge guard 并进既有行 → 新分配的 internal_id 查不到。这是"已存在",
    既不是失败也不是新增。
    """
    real_fingerprints = store.get_all_message_ids

    def _snapshot_then_race():
        known = real_fingerprints()      # 比对基于这一刻
        store.save_email({               # 之后 watcher 才收到同一封
            "internal_id": 7, "message_id": "a@t", "subject": "by watcher",
            "date_received": datetime.now(timezone.utc).isoformat(),
            "mailbox": "收件箱", "sync_status": "synced",
        })
        return known

    monkeypatch.setattr(store, "get_all_message_ids", _snapshot_then_race)
    backend = _Backend([_row("a@t")])
    monkeypatch.setattr(hs.time, "sleep", _Pipeline(store))

    _, summary = _run(store, backend)

    assert summary.failed == 0
    assert summary.skipped == 1                  # 计"已存在"而不是失败
    assert _live(store)["counts"]["existing"] == 1
    assert len(_ids(store)) == 1                 # 没有产生重复行


def test_new_mail_is_processed_before_history_mail(store, monkeypatch):
    """待同步队列按收信时间从新到旧取 —— 刚到的新邮件排在补录的老邮件前面。"""
    backend = _Backend([_row("old@t", hours_ago=20)])
    # 不推进流水线: 让历史邮件停在 pending, 好观察排队顺序
    monkeypatch.setattr(hs.time, "sleep", _Pipeline(store, outcome="stall"))
    _run(store, backend)

    store.save_email({
        "internal_id": 999, "message_id": "fresh@t", "subject": "just arrived",
        "date_received": datetime.now(timezone.utc).isoformat(),
        "mailbox": "收件箱", "sync_status": "pending",
    })

    pending = store.get_pending_emails(limit=10)
    assert pending[0]["message_id"] == "fresh@t"


def test_increment_watermark_is_never_touched(store, monkeypatch):
    store.set_last_max_row_id(12345)
    backend = _Backend([_row("a@t")])
    monkeypatch.setattr(hs.time, "sleep", _Pipeline(store))

    _run(store, backend)

    assert store.get_last_max_row_id() == 12345


def test_local_only_and_failed_are_counted_separately(store, monkeypatch):
    backend = _Backend([_row("a@t")])
    monkeypatch.setattr(hs.time, "sleep", _Pipeline(store, outcome="local_only"))
    _, summary = _run(store, backend)
    assert (_live(store)["counts"]["local_only"], summary.failed) == (1, 0)

    backend2 = _Backend([_row("c@t")])
    monkeypatch.setattr(hs.time, "sleep", _Pipeline(store, outcome="failed"))
    _, summary2 = _run(store, backend2, job_id=2)
    assert (_live(store, 2)["counts"]["failed"], summary2.failed) == (1, 1)


# ---------------------------------------------------------------------------
# 控制面: 取消 / 停滞 / 续跑 / 限流 / 覆盖不完整
# ---------------------------------------------------------------------------


def test_cancel_stops_feeding_and_ends_aborted(store, monkeypatch):
    monkeypatch.setattr(hs, "BATCH_SIZE", 1)
    rows = [_row(f"m{i}@t", hours_ago=i + 1) for i in range(4)]
    backend = _Backend(rows)
    pipeline = _Pipeline(store)

    def _sleep_then_cancel(seconds=0):
        pipeline(seconds)
        hs.request_cancel(store, 1)        # 第一批处理完就按下取消

    monkeypatch.setattr(hs.time, "sleep", _sleep_then_cancel)

    _, summary = _run(store, backend)

    assert summary.aborted is True
    assert summary.aborted_reason == "cancelled"
    assert len(_ids(store)) < len(rows)    # 剩下的没有再入库


def test_stall_ends_with_a_visible_reason(store, monkeypatch):
    """watcher 没在跑 → 不能静默显示成功, 必须留下原因。"""
    backend = _Backend([_row("a@t")])
    monkeypatch.setattr(hs.time, "sleep", _Pipeline(store, outcome="stall"))

    _, summary = _run(store, backend)

    assert summary.failed == 1
    assert "停滞" in (_live(store)["last_error"] or "")
    assert store.get(_ids(store)[0])["sync_status"] == "pending"   # 行不回滚


def test_restart_resume_does_not_reingest_and_keeps_counts(store, monkeypatch):
    """进程重启 → JobWorker 重新排队 → 重扫。已写入的行此时已在本地, 自然计"已存在"。"""
    backend = _Backend([_row("a@t")])
    monkeypatch.setattr(hs.time, "sleep", _Pipeline(store))
    _run(store, backend)
    first_ids = _ids(store)

    _, summary = _run(store, backend)       # 同一个 job_id 再跑一遍

    assert _ids(store) == first_ids          # 没有重复行
    assert summary.total == 0                # 已经不缺了
    assert _live(store)["counts"]["added"] == 1   # 累计计数接着算, 没被清零


def test_incomplete_coverage_is_reported(store, monkeypatch):
    covered = datetime.now(timezone.utc) - timedelta(hours=6)
    backend = _Backend([_row("a@t")], complete=False, covered_from=covered)
    monkeypatch.setattr(hs.time, "sleep", _Pipeline(store))

    _run(store, backend)

    live = _live(store)
    assert live["complete"] is False
    assert live["covered_from"] == covered.astimezone().strftime("%Y-%m-%d")


def test_throttled_scan_waits_then_continues(store, monkeypatch):
    """EWS 限流期间原地等, 限流解除后照常完成。"""
    paused = {"n": 2}

    def _is_paused(_store, **_kw):
        if paused["n"] > 0:
            paused["n"] -= 1
            return True
        return False

    monkeypatch.setattr(hs, "is_uid_backfill_paused", _is_paused)
    backend = _Backend([_row("a@t")])
    monkeypatch.setattr(hs.time, "sleep", _Pipeline(store))

    _, summary = _run(store, backend)

    assert paused["n"] == 0                 # 真的等过
    assert summary.succeeded == 1


def test_progress_hook_can_stop_the_run(store, monkeypatch):
    """JobWorker 的协作式停 (hook 返 False) 必须被尊重。"""
    monkeypatch.setattr(hs, "BATCH_SIZE", 1)
    backend = _Backend([_row(f"m{i}@t", hours_ago=i + 1) for i in range(3)])
    monkeypatch.setattr(hs.time, "sleep", _Pipeline(store))

    _, summary = _run(store, backend, hook=lambda _res, _summary: False)

    assert summary.aborted is True
    assert len(_ids(store)) == 1            # 第一封之后就停了
