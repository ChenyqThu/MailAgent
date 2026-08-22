from __future__ import annotations

import asyncio
import json
import sqlite3
from datetime import datetime, timezone

from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.service import MatterService
from src.matters.worker import MatterAgendaWorker

NOW_DT = datetime(2026, 8, 11, 9, 5, tzinfo=timezone.utc)
NOW = int(NOW_DT.timestamp() * 1000)
RULE = {
    "freq": "daily", "interval": 1, "weekdays": [], "monthMode": "date",
    "monthDay": 1, "ordinal": 1, "weekday": 0, "hour": 9, "minute": 0, "clamp": False,
}


class FakeRuns:
    def __init__(self, *, coalesced=False):
        self.calls = []
        self.coalesced = coalesced

    def enqueue_run(self, public_id, **kwargs):
        self.calls.append((public_id, kwargs))
        return {"run": {"id": 1}, "coalesced": self.coalesced}


class FakeState:
    def __init__(self):
        self.values = {}

    def get_state(self, key):
        return self.values.get(key)

    def set_state(self, key, value):
        self.values[key] = value
        return True


def _matter(path, *, agent_profile_id="p1"):
    repo = MatterRepository(path)
    service = MatterService(repo, clock_ms=lambda: NOW)
    result = service.create_matter({"title": "scheduled"}, idempotency_key="create", source="test")
    matter = result["matter"]
    schedule = {"kind": "schedule", "rule": RULE, "anchor": "2026-08-01", "timezone": "UTC"}
    with sqlite3.connect(path) as conn:
        conn.execute(
            "UPDATE matter SET agent_enabled=1,agent_profile_id=?,schedule_json=? WHERE id=?",
            (agent_profile_id, json.dumps(schedule), matter["id"]),
        )
        conn.commit()
    return repo, matter


def test_schedule_fire_marker_catchup_and_coalesced_consumption(tmp_path):
    path = tmp_path / "schedule.db"
    SyncStore(str(path))
    repo, matter = _matter(path)
    state = FakeState()
    runs = FakeRuns(coalesced=True)
    worker = MatterAgendaWorker(
        repository=repo, sync_store=state,
        clock_ms=lambda: NOW, run_service=runs,
    )
    assert worker._schedule_tick() == {matter["id"]}
    assert len(runs.calls) == 1
    marker_key = f"matter.schedule.last_fire.{matter['id']}"
    assert state.values[marker_key].startswith("2026-08-11T09:00:00")
    assert worker._schedule_tick() == set()
    assert len(runs.calls) == 1

    late = MatterAgendaWorker(
        repository=repo, sync_store=FakeState(),
        clock_ms=lambda: NOW + 31 * 60 * 1000, run_service=FakeRuns(),
    )
    assert late._schedule_tick() == set()


# 0811 dogfood 反馈：定时跟进原本带 `AND agent_profile_id IS NOT NULL`，把自动化卡在
# 「必须先手工建一个 Custom Agent」上 —— 而 P4 D2 已写明 profile 只贡献 model/title/persona，
# 工具面与任务契约都是服务端强制的（run_spec.py 的四处消费全有 `if profile` 守卫）。
# 这条钉住「未绑定也能被定时选中」，防止那半个条件被回填。
def test_schedule_tick_enqueues_enabled_unbound_matter(tmp_path):
    path = tmp_path / "schedule-unbound.db"
    SyncStore(str(path))
    repo, matter = _matter(path, agent_profile_id=None)
    with sqlite3.connect(path) as conn:
        bound = conn.execute(
            "SELECT agent_profile_id FROM matter WHERE id=?", (matter["id"],)
        ).fetchone()[0]
    assert bound is None, "前置：这条用例的意义就在于 profile 为空"

    runs = FakeRuns()
    worker = MatterAgendaWorker(
        repository=repo,
        sync_store=FakeState(),
        clock_ms=lambda: NOW,
        run_service=runs,
    )

    assert worker._schedule_tick() == {matter["id"]}
    # 幂等键的具体格式归 run_service 所有，这里不手抄（同文件既有用例同样只断调用发生）。
    assert len(runs.calls) == 1
    public_id, kwargs = runs.calls[0]
    assert public_id == matter["public_id"]
    assert kwargs["trigger_kind"] == "schedule"


def _insert_fail(path, matter_id, run_id, trigger, completed_at):
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO matter_run(id,matter_id,trigger_kind,idempotency_key,status,queued_at," 
            "started_at,completed_at,created_at) VALUES (?,?,?,?,'fail',?,?,?,?)",
            (run_id, matter_id, trigger, f"fail:{run_id}", completed_at - 2, completed_at - 1, completed_at, completed_at - 2),
        )
        conn.commit()


def test_retry_chain_manual_no_retry_schedule_backoff_and_terminal_episode(tmp_path):
    path = tmp_path / "retry.db"
    SyncStore(str(path))
    repo = MatterRepository(path)
    base = MatterService(repo, clock_ms=lambda: NOW)
    manual = base.create_matter({"title": "manual"}, idempotency_key="m", source="test")["matter"]
    _insert_fail(path, manual["id"], 1, "manual", NOW - 10 * 60 * 1000)
    runs = FakeRuns()
    worker = MatterAgendaWorker(repository=repo, sync_store=FakeState(), clock_ms=lambda: NOW, run_service=runs)
    worker._retry_tick()
    assert runs.calls == []
    assert worker.attention.list_attention(public_id=manual["public_id"])[0]["kind"] == "run_failed"

    scheduled = base.create_matter({"title": "scheduled"}, idempotency_key="s", source="test")["matter"]
    _insert_fail(path, scheduled["id"], 2, "schedule", NOW - 6 * 60 * 1000)
    worker._retry_tick()
    assert runs.calls[-1][1]["idempotency_key"].endswith(":retry:2")
    with sqlite3.connect(path) as conn:
        conn.execute(
            "UPDATE matter_run SET completed_at=? WHERE id=2",
            (NOW - 40 * 60 * 1000,),
        )
        conn.commit()
    _insert_fail(path, scheduled["id"], 3, "schedule", NOW - 31 * 60 * 1000)
    worker._retry_tick()
    assert runs.calls[-1][1]["idempotency_key"].endswith(":retry:3")
    _insert_fail(path, scheduled["id"], 4, "schedule", NOW - 1)
    worker._retry_tick()
    terminal = worker.attention.list_attention(public_id=scheduled["public_id"])[0]
    assert terminal["kind"] == "run_failed" and terminal["payload"]["attempts"] == 3


def test_noop_scheduled_run_creates_no_retry_or_notification(tmp_path):
    path = tmp_path / "noop.db"
    SyncStore(str(path))
    repo = MatterRepository(path)
    base = MatterService(repo, clock_ms=lambda: NOW)
    matter = base.create_matter(
        {"title": "noop"}, idempotency_key="noop", source="test"
    )["matter"]
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO matter_run(matter_id,trigger_kind,idempotency_key,status," 
            "queued_at,started_at,completed_at,created_at) "
            "VALUES (?,'schedule','noop-run','noop',1,2,3,1)",
            (matter["id"],),
        )
        conn.commit()
    worker = MatterAgendaWorker(
        repository=repo,
        sync_store=FakeState(),
        clock_ms=lambda: NOW,
        run_service=FakeRuns(),
    )
    assert worker._retry_tick() == set()
    assert worker.attention.list_attention(public_id=matter["public_id"]) == []
    assert worker.attention.eligible_notifications("all") == []


# ==================== P6-B D6/D15/D16：EVENT / CONDITION 两条新判定路径 ====================


def _matter_with_triggers(path, triggers):
    """建一个事项并写入 v2 trigger envelope（绕过 service 直接写库，专测 worker 判定）。"""
    repo = MatterRepository(path)
    service = MatterService(repo, clock_ms=lambda: NOW)
    result = service.create_matter({"title": "triggered"}, idempotency_key="create", source="test")
    matter = result["matter"]
    with sqlite3.connect(path) as conn:
        conn.execute(
            "UPDATE matter SET agent_enabled=1,schedule_json=? WHERE id=?",
            (json.dumps({"v": 2, "triggers": triggers}), matter["id"]),
        )
        conn.commit()
    return repo, matter


def _worker(repo, state):
    return MatterAgendaWorker(
        repository=repo, sync_store=state,
        clock_ms=lambda: NOW, run_service=FakeRuns(),
    )


def _open_signal(path, matter_id, kind, subject_key="health"):
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO matter_attention"
            "(matter_id,kind,subject_key,state,severity,why,recurrence_no,"
            "first_opened_at,last_observed_at) "
            "VALUES (?,?,?,'open','warn','why',1,?,?)",
            (matter_id, kind, subject_key, NOW, NOW),
        )
        conn.commit()


def test_condition_trigger_fires_once_while_signal_stays_open(tmp_path):
    """🔴 同一条持续 open 的信号只能 fire 一次 —— 否则条件成立期间每 tick 都跑一次。"""
    path = tmp_path / "cond.db"
    SyncStore(str(path))
    repo, matter = _matter_with_triggers(path, [
        {"id": "mtr_c1", "kind": "condition", "enabled": True, "condition": "health_down"},
    ])
    _open_signal(path, matter["id"], "health_down")
    state = FakeState()
    worker = _worker(repo, state)

    assert worker._schedule_tick() == {matter["id"]}
    assert worker._schedule_tick() == set(), "signal still open → must not re-fire"
    assert len(worker.run_service.calls) == 1
    assert worker.run_service.calls[0][1]["trigger_kind"] == "condition"


def test_condition_trigger_does_not_fire_without_open_signal(tmp_path):
    path = tmp_path / "cond-none.db"
    SyncStore(str(path))
    repo, matter = _matter_with_triggers(path, [
        {"id": "mtr_c1", "kind": "condition", "enabled": True, "condition": "action_overdue"},
    ])
    worker = _worker(repo, FakeState())
    assert worker._schedule_tick() == set()
    assert worker.run_service.calls == []


def test_event_trigger_fires_on_new_matching_event_only(tmp_path):
    path = tmp_path / "event.db"
    SyncStore(str(path))
    repo, matter = _matter_with_triggers(path, [
        {"id": "mtr_e1", "kind": "event", "enabled": True,
         "event_type": "resource_linked_mail"},
    ])
    state = FakeState()
    worker = _worker(repo, state)

    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO matter_event(matter_id,kind,actor_kind,source,payload_json,"
            "happened_at,created_at,dedupe_key) "
            "VALUES (?,'resource_linked','user','test',?,?,?,'evt-1')",
            (matter["id"], json.dumps({"resource_kind": "email"}), NOW, NOW),
        )
        conn.commit()

    assert worker._schedule_tick() == {matter["id"]}
    assert worker._schedule_tick() == set(), "same event must not re-fire"
    assert worker.run_service.calls[0][1]["trigger_kind"] == "event"


def test_event_trigger_ignores_events_of_other_resource_kinds(tmp_path):
    path = tmp_path / "event-doc.db"
    SyncStore(str(path))
    repo, matter = _matter_with_triggers(path, [
        {"id": "mtr_e1", "kind": "event", "enabled": True,
         "event_type": "resource_doc_updated"},
    ])
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO matter_event(matter_id,kind,actor_kind,source,payload_json,"
            "happened_at,created_at,dedupe_key) "
            "VALUES (?,'resource_updated','user','test',?,?,?,'evt-2')",
            (matter["id"], json.dumps({"resource_kind": "email"}), NOW, NOW),
        )
        conn.commit()
    worker = _worker(repo, FakeState())
    assert worker._schedule_tick() == set()


def test_disabled_trigger_never_fires(tmp_path):
    path = tmp_path / "disabled.db"
    SyncStore(str(path))
    repo, matter = _matter_with_triggers(path, [
        {"id": "mtr_c1", "kind": "condition", "enabled": False, "condition": "health_down"},
    ])
    _open_signal(path, matter["id"], "health_down")
    worker = _worker(repo, FakeState())
    assert worker._schedule_tick() == set()


def test_broken_entry_does_not_starve_sibling_trigger(tmp_path):
    """🔴 一条坏掉的 trigger 不该让同一事项的其它 trigger 一起停摆。"""
    path = tmp_path / "mixed.db"
    SyncStore(str(path))
    repo, matter = _matter_with_triggers(path, [
        {"id": "mtr_ok", "kind": "condition", "enabled": True, "condition": "health_down"},
        {"id": "mtr_bad", "kind": "schedule", "enabled": True,
         "rule": {"freq": "daily"}, "anchor": "2026-08-01", "timezone": "UTC"},
    ])
    _open_signal(path, matter["id"], "health_down")
    worker = _worker(repo, FakeState())
    # 坏的那条（rule 缺键，深校验在 schedule_rule 里才炸）被单独跳过，
    # 同一事项的 condition 触发照常工作。
    assert worker._schedule_tick() == {matter["id"]}
    assert [c[1]["trigger_kind"] for c in worker.run_service.calls] == ["condition"]


def test_manual_trigger_never_auto_fires(tmp_path):
    path = tmp_path / "manual.db"
    SyncStore(str(path))
    repo, _ = _matter_with_triggers(path, [
        {"id": "mtr_m1", "kind": "manual", "enabled": True},
    ])
    worker = _worker(repo, FakeState())
    assert worker._schedule_tick() == set()


# ==================== 通知中心：关注信号写入 + 投递水位自 ack（M3 批 C1）====================
# 老 macOS 弹窗链（matter_notifications.ts + /notified ack 端点）已退役：弹窗唯一路径 =
# NC 行 → main 的 notification_fanout。`last_notified_at` 由 worker 在 eligible 循环内
# 自 ack —— NC 落库成功才写（两阶段）；needs_review（NC 有意跳过）无条件写；
# 没 ack 的信号留在 eligible，下一 tick 重试（NC dedupe 吸收为计次）。


def _notifications(path):
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute("SELECT * FROM notification ORDER BY id")]
    finally:
        conn.close()


def _capture_events(monkeypatch):
    """收集两条链发出的 SSE：worker 的 matter.notify + NotifyCenter 的 notification.changed。"""
    import src.matters.worker as worker_mod
    import src.notify.center as center_mod

    events: list = []

    def record(event_type, data=None, **kwargs):
        events.append((event_type, data))

    monkeypatch.setattr(worker_mod, "safe_publish", record)
    monkeypatch.setattr(center_mod, "safe_publish", record)
    return events


def _matter_with_health(path, title, health):
    repo = MatterRepository(path)
    service = MatterService(repo, clock_ms=lambda: NOW)
    matter = service.create_matter(
        {"title": title}, idempotency_key=f"create-{title}", source="test"
    )["matter"]
    with sqlite3.connect(str(path)) as conn:
        conn.execute(
            "UPDATE matter SET health=? WHERE id=?", (health, matter["id"])
        )
        conn.commit()
    return repo, matter


def test_attention_notify_writes_notification_center_and_acks_watermark(tmp_path, monkeypatch):
    path = tmp_path / "attn-notify.db"
    SyncStore(str(path))
    repo, matter = _matter_with_health(path, "偏离计划的事项", "off_track")
    events = _capture_events(monkeypatch)
    worker = MatterAgendaWorker(
        repository=repo, sync_store=FakeState(),
        clock_ms=lambda: NOW, run_service=FakeRuns(),
    )
    asyncio.run(worker.tick())

    rows = _notifications(path)
    assert len(rows) == 1
    row = rows[0]
    with sqlite3.connect(str(path)) as conn:
        signal_id, notified_at = conn.execute(
            "SELECT id, last_notified_at FROM matter_attention"
        ).fetchone()
    assert row["category"] == "action_required" and row["severity"] == "critical"
    assert row["source"] == "matter"
    assert row["dedupe_key"] == f"matter_attention:{signal_id}"
    assert row["title"] == "偏离计划的事项" and "健康度" in row["body"]
    assert json.loads(row["payload_json"])["link"] == {
        "type": "matter", "publicId": matter["public_id"],
    }
    # NC 落库成功 → worker 同轮自 ack（老 ack 端点已退役，水位不再依赖 App 在场；
    # 断链时代的症状是信号永留 eligible → NC 每 tick 计次 → fanout 每分钟重弹）
    assert notified_at == NOW
    # renderer 消费面的 matter.notify 照发（attention 角标/列表靠它刷新）
    assert [e for e in events if e[0] == "matter.notify"], "matter.notify 必须照旧发出"


def test_attention_notification_severity_maps_straight_through(tmp_path, monkeypatch):
    """severity 值域两侧同为 info/warn/critical → 直通，不需要映射表。"""
    path = tmp_path / "attn-severity.db"
    SyncStore(str(path))
    repo = MatterRepository(path)
    service = MatterService(repo, clock_ms=lambda: NOW)
    expected = {}
    for severity in ("info", "warn", "critical"):
        matter = service.create_matter(
            {"title": f"事项-{severity}"}, idempotency_key=f"c-{severity}", source="test"
        )["matter"]
        # context_gap 是事件驱动信号：reconcile 不碰它，能原样活到 eligible 那一步
        signal = MatterAgendaWorker(
            repository=repo, sync_store=FakeState(), clock_ms=lambda: NOW,
            run_service=FakeRuns(),
        ).attention.open_signal(
            matter_id=matter["id"], kind="context_gap", subject_key="ctx",
            severity=severity, why=f"缺资料-{severity}",
        )
        expected[f"matter_attention:{signal['id']}"] = severity

    _capture_events(monkeypatch)
    worker = MatterAgendaWorker(
        repository=repo, sync_store=FakeState(), clock_ms=lambda: NOW,
        run_service=FakeRuns(), notify_level_reader=lambda: "all",
    )
    asyncio.run(worker.tick())

    got = {row["dedupe_key"]: row["severity"] for row in _notifications(path)}
    assert got == expected


def test_attention_notification_skips_needs_review_but_keeps_other_kinds(tmp_path, monkeypatch):
    """`needs_review` 信号不进通知中心 (提案审阅由 run_service 的 reviews 条目精准覆盖)；
    其余 kind (如 context_gap) 仍照发。renderer 消费的 `matter.notify` 不受影响，两者都照发。
    🔴 needs_review 虽被 NC 跳过，投递水位也必须**无条件** ack —— 不 ack 就永留
    eligible，`matter.notify` 每 tick 重发。

    🔴 needs_review 必须走真实的 `matter_update(review_status='pending')` 事实产生
    （`_collect_facts` 现场生成，不是 `open_signal` 直插）——`needs_review` 不在
    `EVENT_DRIVEN_ATTENTION_KINDS` 里，`reconcile()` 会按事实表校验它；直插一条无
    backing fact 的 needs_review 信号会被 reconcile 当成陈旧信号在本轮就地 resolve
    掉，测试会在还没测到 `_publish_attention_notification` 之前就假阳性通过。
    """
    path = tmp_path / "attn-needs-review.db"
    SyncStore(str(path))
    repo = MatterRepository(path)
    service = MatterService(repo, clock_ms=lambda: NOW)
    m_review = service.create_matter(
        {"title": "有提案待审阅"}, idempotency_key="c-review", source="test"
    )["matter"]
    m_gap = service.create_matter(
        {"title": "缺资料"}, idempotency_key="c-gap", source="test"
    )["matter"]
    with sqlite3.connect(str(path)) as conn:
        conn.execute(
            "INSERT INTO matter_update (matter_id, review_status, anchored_matter_version, "
            "created_by_kind, created_at) VALUES (?, 'pending', 1, 'agent', ?)",
            (m_review["id"], NOW),
        )
        conn.commit()
    gap_signal = MatterAgendaWorker(
        repository=repo, sync_store=FakeState(), clock_ms=lambda: NOW, run_service=FakeRuns(),
    ).attention.open_signal(
        matter_id=m_gap["id"], kind="context_gap", subject_key="ctx",
        severity="warn", why="缺资料",
    )

    events = _capture_events(monkeypatch)
    worker = MatterAgendaWorker(
        repository=repo, sync_store=FakeState(), clock_ms=lambda: NOW,
        run_service=FakeRuns(), notify_level_reader=lambda: "all",
    )
    asyncio.run(worker.tick())

    rows = _notifications(path)
    # 唯一落库的一条就是 context_gap 那条；needs_review 一条都不该有
    assert [row["dedupe_key"] for row in rows] == [f"matter_attention:{gap_signal['id']}"]
    # renderer 侧两条信号的 matter.notify 都照发（不受通知中心跳过 needs_review 影响）
    matter_notify_kinds = {
        e[1]["kind"] for e in events if e[0] == "matter.notify"
    }
    assert matter_notify_kinds == {"needs_review", "context_gap"}
    # 两条都已写投递水位：context_gap 在 NC 落库成功后 ack；needs_review 无条件 ack
    with sqlite3.connect(str(path)) as conn:
        watermarks = dict(
            conn.execute("SELECT kind, last_notified_at FROM matter_attention").fetchall()
        )
    assert watermarks["needs_review"] is not None
    assert watermarks["context_gap"] is not None


def test_attention_batch_emits_single_changed_event(tmp_path, monkeypatch):
    """一轮多条信号 → 通知逐条落库，刷新信号只发一条（design §3.2 批量写）。"""
    path = tmp_path / "attn-batch.db"
    SyncStore(str(path))
    repo, _ = _matter_with_health(path, "风险一", "off_track")
    _matter_with_health(path, "风险二", "off_track")
    events = _capture_events(monkeypatch)
    worker = MatterAgendaWorker(
        repository=repo, sync_store=FakeState(),
        clock_ms=lambda: NOW, run_service=FakeRuns(),
    )
    asyncio.run(worker.tick())

    assert len(_notifications(path)) == 2
    changed = [e for e in events if e[0] == "notification.changed"]
    assert len(changed) == 1
    assert changed[0][1] == {"category": "action_required"}


def test_attention_notification_failure_does_not_break_macos_chain(tmp_path, monkeypatch):
    path = tmp_path / "attn-boom.db"
    SyncStore(str(path))
    repo, _ = _matter_with_health(path, "写通知会炸", "off_track")
    events = _capture_events(monkeypatch)
    worker = MatterAgendaWorker(
        repository=repo, sync_store=FakeState(),
        clock_ms=lambda: NOW, run_service=FakeRuns(),
    )

    def boom(**kwargs):
        raise RuntimeError("notification table gone")

    monkeypatch.setattr(worker._notify_center, "publish", boom)
    asyncio.run(worker.tick())

    assert _notifications(path) == []
    assert [e for e in events if e[0] == "matter.notify"], "matter.notify 不受通知中心失败牵连"
    assert [e for e in events if e[0] == "notification.changed"] == []
    # 🔴 两阶段：NC 落库失败 → 不写投递水位，信号留在 eligible，下一 tick 重试
    with sqlite3.connect(str(path)) as conn:
        notified_at = conn.execute(
            "SELECT last_notified_at FROM matter_attention"
        ).fetchone()[0]
    assert notified_at is None


def test_reconcile_watermark_reset_republishes_as_recurrence_bump(tmp_path, monkeypatch):
    """reconcile 清水位（severity 升档）→ 信号重新 eligible → NC 同 dedupe 行计次 +1 并再 ack。

    这是「重新提醒」链路：fanout 的防重键是 `${id}:${recurrenceNo}`，recurrence 变化
    才会再弹一次 macOS 通知 —— 升档必须走到 NC 计次并把水位写回，缺一环用户就
    看不到第二次提醒（或每 tick 被骚扰）。
    """
    path = tmp_path / "attn-rebump.db"
    SyncStore(str(path))
    repo, _ = _matter_with_health(path, "先有风险后偏离", "at_risk")
    _capture_events(monkeypatch)
    worker = MatterAgendaWorker(
        repository=repo, sync_store=FakeState(), clock_ms=lambda: NOW,
        run_service=FakeRuns(), notify_level_reader=lambda: "all",
    )
    asyncio.run(worker.tick())
    first = _notifications(path)
    assert [row["recurrence_no"] for row in first] == [1]
    assert first[0]["severity"] == "warn"
    with sqlite3.connect(str(path)) as conn:
        assert (
            conn.execute("SELECT last_notified_at FROM matter_attention").fetchone()[0]
            == NOW
        )
        conn.execute("UPDATE matter SET health='off_track'")
        conn.commit()

    asyncio.run(worker.tick())
    rows = _notifications(path)
    assert len(rows) == 1, "同 dedupe_key 必须计次，不许开第二行"
    assert rows[0]["recurrence_no"] == 2
    assert rows[0]["severity"] == "critical"
    with sqlite3.connect(str(path)) as conn:
        notified_at = conn.execute(
            "SELECT last_notified_at FROM matter_attention"
        ).fetchone()[0]
    assert notified_at == NOW, "重新 publish 后水位要再写回（否则每 tick 重发）"
