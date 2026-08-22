"""NotifyCenter 写面/读面单测 (task 08-20-notification-center 步骤 3)。

覆盖 implement.md「测试计划」点名用例:

- dedupe/recurrence: 计次未读化 / resolved·dismissed 后新行计次续接 /
  severity 只升不降 / 并发 IntegrityError 兜底路径;
- snooze 读口径: 到期视同 open (行为测试, 不测 ``_OPEN_PREDICATE`` 实现);
- mark_all_read: 清零计数 + 时刻快照边界 (未来行不被标);
- 事件形状**防回加闸**: data 键集 ⊆ {category}, 绝不带行 id
  (matter.attention id-space 墓志铭);
- commit-then-emit: 事件到达时行已对外可见。

🔴 全程 tmp_path 建库 (SyncStore 落表后只取 db_path), 绝不碰真实库。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import SyncStore
from src.notify.center import NotifyCenter, NotifyCenterError

T0 = 1_700_000_000_000  # 任意毫秒基准


class Clock:
    def __init__(self, now: int = T0):
        self.now = now

    def __call__(self) -> int:
        return self.now


@pytest.fixture
def db_path(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))  # 落表 (v68 迁移)
    return str(path)


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def center(db_path, clock):
    return NotifyCenter(db_path, clock_ms=clock)


def _rows(db_path):
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        return [
            dict(row)
            for row in conn.execute(
                "SELECT * FROM notification ORDER BY id"
            ).fetchall()
        ]


def _publish(center, *, dedupe_key="agent_run:1", severity="info", **kw):
    defaults = dict(
        category="results", source="agent_run", title="标题", dedupe_key=dedupe_key,
        severity=severity, emit_event=False,
    )
    defaults.update(kw)
    return center.publish(**defaults)


# ==================== dedupe / recurrence ====================


def test_publish_creates_open_unread_row(center, db_path):
    result = _publish(center, body="摘要", payload={"link": {"type": "route", "to": "/x"}})
    assert result.created is True
    assert result.recurrence_no == 1
    (row,) = _rows(db_path)
    assert row["id"] == result.id
    assert row["state"] == "open"
    assert row["read_at"] is None
    assert row["first_created_at"] == row["last_event_at"] == T0
    assert row["recurrence_no"] == 1


def test_same_key_twice_bumps_single_row_and_unreads(center, clock, db_path):
    first = _publish(center, title="第一次", body="b1")
    center.mark_read(first.id)
    clock.now = T0 + 5_000
    second = _publish(center, title="第二次", body="b2")
    assert second.created is False
    assert second.id == first.id
    assert second.recurrence_no == 2
    (row,) = _rows(db_path)  # 没开新行
    assert row["recurrence_no"] == 2
    assert row["read_at"] is None  # 计次未读化: 又发生了, 用户该再看见
    assert row["title"] == "第二次" and row["body"] == "b2"  # 文案刷新为最新一次
    assert row["last_event_at"] == T0 + 5_000
    assert row["first_created_at"] == T0  # 首见时间不动


def test_resolved_then_publish_opens_new_generation(center, clock, db_path):
    _publish(center)
    assert center.resolve_by_dedupe("agent_run:1", emit_event=False) == 1
    clock.now = T0 + 10_000
    result = _publish(center)
    assert result.created is True
    assert result.recurrence_no == 2  # 跨代续接: 上一代 +1
    rows = _rows(db_path)
    assert len(rows) == 2  # 历史行是审计轨迹, 不改老行
    assert rows[0]["state"] == "resolved" and rows[0]["resolved_at"] == T0
    assert rows[1]["state"] == "open" and rows[1]["recurrence_no"] == 2


def test_dismissed_then_publish_opens_new_generation(center, db_path):
    _publish(center)
    with sqlite3.connect(db_path) as conn:  # dismiss 动作端点是 M2, 直接摆状态
        conn.execute(
            "UPDATE notification SET state='dismissed', dismissed_at=? "
            "WHERE dedupe_key='agent_run:1'",
            (T0 + 1,),
        )
    result = _publish(center)
    assert result.created is True  # 与 attention 判据型「dismissed 永不重开」有意不同
    assert result.recurrence_no == 2
    assert len(_rows(db_path)) == 2


def test_severity_monotone_upgrade(center, db_path):
    _publish(center, severity="info")
    _publish(center, severity="critical")
    _publish(center, severity="warn")  # 降级触发不把 critical 拉回去
    (row,) = _rows(db_path)
    assert row["severity"] == "critical"
    assert row["recurrence_no"] == 3


def test_integrity_race_falls_back_to_bump(center, monkeypatch, db_path):
    """并发窗口兜底: 首查漏看活跃行 → INSERT 撞 partial unique → 重查转计次。"""
    _publish(center)  # 预插活跃行
    original = NotifyCenter._active_row
    calls = {"n": 0}

    def racy(self, conn, dedupe_key):
        calls["n"] += 1
        if calls["n"] == 1:
            return None  # 模拟竞态: 首查没看见
        return original(self, conn, dedupe_key)

    monkeypatch.setattr(NotifyCenter, "_active_row", racy)
    result = _publish(center)
    assert calls["n"] == 2  # 确实走了「撞车 → 重查」而不是首查命中
    assert result.created is False
    assert result.recurrence_no == 2
    assert len(_rows(db_path)) == 1


def test_publish_rejects_invalid_enums(center):
    with pytest.raises(NotifyCenterError) as exc:
        _publish(center, category="nope")
    assert exc.value.code == "E_INVALID_ARG"
    with pytest.raises(NotifyCenterError) as exc:
        _publish(center, severity="fatal")
    assert exc.value.code == "E_INVALID_ARG"


# ==================== snooze 读口径 (到期唤醒是读侧语义) ====================


def test_snooze_expired_treated_as_open(center, clock):
    result = _publish(center)
    clock.now = T0 + 1_000
    center.snooze(result.id, until_ms=T0 + 2_000)
    clock.now = T0 + 3_000  # 已过期
    listed = center.list(state="open")
    assert [item["id"] for item in listed.items] == [result.id]
    assert listed.items[0]["state"] == "snoozed"  # state 不跃迁, 读侧视同 open
    assert center.unread_count()["total"] == 1
    assert center.list(state="snoozed").items == []  # 精确过滤 = 未到期的


def test_snooze_pending_hidden_from_open(center, clock):
    result = _publish(center)
    clock.now = T0 + 1_000
    center.snooze(result.id, until_ms=T0 + 60_000)
    assert center.list(state="open").items == []
    assert center.unread_count()["total"] == 0
    assert [item["id"] for item in center.list(state="snoozed").items] == [result.id]


def test_snooze_guards(center, clock):
    result = _publish(center)
    with pytest.raises(NotifyCenterError) as exc:
        center.snooze(result.id, until_ms=T0)  # 不在未来
    assert exc.value.code == "E_INVALID_ARG"
    with pytest.raises(NotifyCenterError) as exc:
        center.snooze(999_999, until_ms=T0 + 1_000)
    assert exc.value.code == "E_NOT_FOUND"
    center.resolve(result.id)
    with pytest.raises(NotifyCenterError) as exc:
        center.snooze(result.id, until_ms=T0 + 1_000)  # 已关闭行 CAS 拒绝
    assert exc.value.code == "E_INVALID_STATE"


def test_resolve_projection_and_dedupe_miss(center):
    result = _publish(center)
    projected = center.resolve(result.id)
    assert projected["state"] == "resolved" and projected["resolved_at"] == T0
    assert center.resolve_by_dedupe("agent_run:1", emit_event=False) == 0  # 无活跃行


# ==================== 已读轴 ====================


def test_mark_read_idempotent_and_missing(center, clock):
    result = _publish(center)
    clock.now = T0 + 1_000
    first = center.mark_read(result.id)
    assert first["read_at"] == T0 + 1_000
    clock.now = T0 + 9_000
    second = center.mark_read(result.id)  # 幂等: 已读行不动
    assert second["read_at"] == T0 + 1_000
    with pytest.raises(NotifyCenterError) as exc:
        center.mark_read(999_999)
    assert exc.value.code == "E_NOT_FOUND"


def test_mark_all_read_clears_and_returns_count(center):
    for key in ("a", "b", "c"):
        _publish(center, dedupe_key=key)
    assert center.unread_count()["total"] == 3
    assert center.mark_all_read() == 3
    assert center.unread_count()["total"] == 0
    assert center.mark_all_read() == 0  # 幂等


def test_mark_all_read_snapshot_boundary(center, clock, db_path):
    """并发 publish 进来的新行 (last_event_at > now) 不被顺手标掉。"""
    for key in ("a", "b", "c"):
        _publish(center, dedupe_key=key)
    clock.now = T0 + 60_000
    future = _publish(center, dedupe_key="d")  # 「未来」行
    clock.now = T0  # mark_all_read 的处理时刻回到快照点
    assert center.mark_all_read() == 3
    with sqlite3.connect(db_path) as conn:
        (unread_id,) = conn.execute(
            "SELECT id FROM notification WHERE read_at IS NULL"
        ).fetchone()
    assert unread_id == future.id


def test_mark_all_read_category_scope(center):
    _publish(center, dedupe_key="a", category="results")
    _publish(center, dedupe_key="b", category="system", source="system_alert")
    assert center.mark_all_read(category="system") == 1
    assert center.unread_count()["by_category"] == {
        "action_required": 0, "reviews": 0, "results": 1, "system": 0,
    }


# ==================== 未读计数两轴 + 单条读 (M2 批 B1) ====================


def test_unread_count_by_severity_axis(center):
    """bySeverity 轴 (铃铛 critical 红点档数据源) 与 byCategory 同口径。"""
    _publish(center, dedupe_key="a", category="results", severity="info")
    _publish(center, dedupe_key="b", category="system", source="system_alert",
             severity="critical")
    _publish(center, dedupe_key="c", category="system", source="system_alert",
             severity="warn")
    read_one = _publish(center, dedupe_key="d", category="system",
                        source="system_alert", severity="critical")
    center.mark_read(read_one.id)  # 已读不计
    counts = center.unread_count()
    assert counts["total"] == 3
    assert counts["by_severity"] == {"info": 1, "warn": 1, "critical": 1}
    assert counts["by_category"]["system"] == 2
    # 两轴同口径: resolved 行在两边同时消失
    center.resolve_by_dedupe("b", emit_event=False)
    counts = center.unread_count()
    assert counts["by_severity"] == {"info": 1, "warn": 1, "critical": 0}
    assert counts["by_category"]["system"] == 1
    assert counts["total"] == 2


def test_unread_count_by_severity_counts_expired_snooze(center, clock):
    """到期 snoozed 视同 open —— bySeverity 与 total 必须一起把它算进来。"""
    result = _publish(center, dedupe_key="s", category="system",
                      source="system_alert", severity="critical")
    center.snooze(result.id, until_ms=T0 + 60_000)
    assert center.unread_count()["by_severity"]["critical"] == 0  # 未到期
    clock.now = T0 + 61_000
    counts = center.unread_count()
    assert counts["by_severity"]["critical"] == 1 and counts["total"] == 1


def test_get_projection_and_missing(center):
    """`get()` 供 POST /publish 回单条投影 (publish 只回 id/created/计次)。"""
    link = {"link": {"type": "route", "to": "/x"}}
    result = _publish(center, dedupe_key="g", payload=link)
    projected = center.get(result.id)
    assert projected["id"] == result.id
    assert projected["state"] == "open"
    assert projected["payload"] == link
    with pytest.raises(NotifyCenterError) as exc:
        center.get(999_999)
    assert exc.value.code == "E_NOT_FOUND"


# ==================== 事件形状防回加闸 + commit-then-emit ====================


@pytest.fixture
def captured_events(monkeypatch, db_path):
    captured = []

    def fake_publish(event_type, *, internal_id=None, data=None, source="mailagent"):
        with sqlite3.connect(db_path) as conn:  # 独立连接: 只看得见已 commit 的行
            visible = conn.execute(
                "SELECT COUNT(*) FROM notification"
            ).fetchone()[0]
        captured.append(
            {"event_type": event_type, "data": data, "source": source,
             "visible_rows": visible}
        )

    monkeypatch.setattr("src.notify.center.safe_publish", fake_publish)
    return captured


def test_event_shape_guard(center, clock, captured_events):
    """🔴 防回加: data 键集 ⊆ {category} —— 拦「顺手把行 id 塞进事件」。"""
    result = center.publish(
        category="system", source="system_alert", title="t",
        dedupe_key="alert:x", severity="critical",
    )
    center.mark_read(result.id)
    center.mark_all_read()
    clock.now = T0 + 1_000
    center.snooze(result.id, until_ms=T0 + 60_000)
    center.resolve(result.id)
    center.publish(category="system", source="system_alert", title="t",
                   dedupe_key="alert:x")
    center.resolve_by_dedupe("alert:x")
    center.emit_changed()
    assert len(captured_events) >= 7
    for event in captured_events:
        assert event["event_type"] == "notification.changed"
        assert event["source"] == "notify-center"
        assert set((event["data"] or {}).keys()) <= {"category"}


def test_emit_after_commit_and_suppression(center, captured_events):
    _publish(center)  # emit_event=False
    assert captured_events == []
    center.emit_changed(category="results")  # 手动 flush
    result = center.publish(
        category="results", source="agent_run", title="t2", dedupe_key="agent_run:2",
    )
    assert result.created is True
    assert len(captured_events) == 2
    # commit-then-emit: 事件回调的独立连接已看得见两行 (事务内发会读到旧值)
    assert captured_events[1]["visible_rows"] == 2
    assert captured_events[1]["data"] == {"category": "results"}


# ==================== list 面 ====================


def test_list_filters_and_counts(center, clock):
    _publish(center, dedupe_key="a", category="results")
    clock.now = T0 + 1_000
    _publish(center, dedupe_key="b", category="system", source="system_alert")
    clock.now = T0 + 2_000
    r3 = _publish(center, dedupe_key="c", category="system", source="system_alert")
    center.mark_read(r3.id)

    all_open = center.list(state="open")
    assert [item["dedupe_key"] for item in all_open.items] == ["c", "b", "a"]  # 时间倒序
    assert all_open.total == 3 and all_open.unread == 2

    system_only = center.list(category="system", unread_only=True)
    assert [item["dedupe_key"] for item in system_only.items] == ["b"]
    assert system_only.total == 1 and system_only.unread == 1

    page = center.list(state="open", limit=1, offset=1)
    assert [item["dedupe_key"] for item in page.items] == ["b"]
    assert page.total == 3

    with pytest.raises(NotifyCenterError) as exc:
        center.list(state="dismissed")  # M1 不开放的口径
    assert exc.value.code == "E_INVALID_ARG"


def test_list_projection_payload(center, db_path):
    _publish(center, dedupe_key="a", payload={"link": {"type": "session", "sessionId": "s1"}})
    _publish(center, dedupe_key="b")
    with sqlite3.connect(db_path) as conn:
        # 坏 JSON 被表的 json_valid CHECK 挡在库外; 「静默 None」分支用
        # 合法 JSON 但非 dict 的形状打 (投影只认 dict)。
        conn.execute(
            "UPDATE notification SET payload_json='[1,2]' WHERE dedupe_key='b'"
        )
    items = {item["dedupe_key"]: item for item in center.list(state="open").items}
    assert items["a"]["payload"] == {"link": {"type": "session", "sessionId": "s1"}}
    assert items["b"]["payload"] is None
    assert "payload_json" not in items["a"]  # 投影只暴露解析后的 payload
