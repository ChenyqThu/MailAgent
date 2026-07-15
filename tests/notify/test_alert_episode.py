"""task 07-14 — src/notify/episode.py 的 episode 状态机单测.

覆盖 PRD R5 的四分支 (enter / silent / escalate / recover) + 持久化 (跨 tracker
实例 = 跨进程重启存活) + 两阶段提交 (投递失败不得提交 → 下轮重发) + flag-off
字节级回退。纯本地判定, 不发飞书。
"""
from __future__ import annotations

import pytest

from src.notify.episode import (
    ENTER,
    ESCALATE,
    RECOVER,
    SILENT,
    AlertEpisodeTracker,
)


class _FakeStore:
    """最小 sync_state KV 替身 (镜像 test_service_alert_checks._FakeStateStore)."""

    def __init__(self, state=None):
        self.state: dict = dict(state or {})

    def get_state(self, key):
        return self.state.get(key)

    def set_state(self, key, value):
        self.state[key] = value
        return True


def _tracker(store=None, enabled=True):
    return AlertEpisodeTracker(store or _FakeStore(), enabled=enabled)


def _announce(tracker, key, value, threshold, *, delivered=True):
    """模拟调用方一轮: evaluate → (投递) → 投递成功才 commit。返回判定。"""
    action = tracker.evaluate(key, value, threshold)
    if action != SILENT and delivered:
        tracker.commit(key, action, value)
    return action


def _announce_flag(tracker, key, bad, *, delivered=True):
    action = tracker.evaluate_flag(key, bad)
    if action != SILENT and delivered:
        tracker.commit(key, action, 1.0 if bad else 0.0)
    return action


# ---------------------------------------------------------------------------
# R5 四分支
# ---------------------------------------------------------------------------


def test_below_threshold_is_silent():
    assert _announce(_tracker(), "dead_letters", 3, 5) == SILENT


def test_first_crossing_enters():
    assert _announce(_tracker(), "dead_letters", 10, 5) == ENTER


def test_constant_value_is_silent_after_enter():
    """🔴 核心: 死信恒定 10 封 → 首次告一次, 后续每轮静默 (修掉刷屏)."""
    t = _tracker()
    assert _announce(t, "dead_letters", 10, 5) == ENTER
    for _ in range(20):  # 20 轮健康检查 = 老实现会发 20 条
        assert _announce(t, "dead_letters", 10, 5) == SILENT


def test_growth_below_double_is_silent():
    t = _tracker()
    assert _announce(t, "dead_letters", 10, 5) == ENTER
    assert _announce(t, "dead_letters", 19, 5) == SILENT  # 未翻倍


def test_doubling_escalates_and_rebases():
    """10 → 20 再告; 之后基准变 20, 要 40 才再告."""
    t = _tracker()
    assert _announce(t, "dead_letters", 10, 5) == ENTER
    assert _announce(t, "dead_letters", 20, 5) == ESCALATE
    assert _announce(t, "dead_letters", 39, 5) == SILENT
    assert _announce(t, "dead_letters", 40, 5) == ESCALATE


def test_recover_below_threshold_and_reset():
    """回落到阈值下 → 恢复通知 + 复位; 复位后再越阈值能重新 enter."""
    t = _tracker()
    assert _announce(t, "dead_letters", 10, 5) == ENTER
    assert _announce(t, "dead_letters", 4, 5) == RECOVER
    assert _announce(t, "dead_letters", 4, 5) == SILENT  # 已复位, 不重复恢复
    assert _announce(t, "dead_letters", 6, 5) == ENTER  # 新 episode


def test_keys_are_independent():
    t = _tracker()
    assert _announce(t, "dead_letters", 10, 5) == ENTER
    assert _announce(t, "outbox_backlog", 10, 5) == ENTER  # 各自独立 episode
    assert _announce(t, "dead_letters", 10, 5) == SILENT


# ---------------------------------------------------------------------------
# 🔴 两阶段提交: 投递失败绝不能提交 (否则首告没送达却永久静默 = 永久漏告警)
# ---------------------------------------------------------------------------


def test_evaluate_alone_does_not_mutate_state():
    """evaluate 是纯判定: 不落盘, 可反复调用而判定不变."""
    store = _FakeStore()
    t = _tracker(store)
    for _ in range(3):
        assert t.evaluate("dead_letters", 10, 5) == ENTER
    assert store.state == {}, "evaluate 不得写 sync_state (提交是 commit 的事)"


def test_undelivered_enter_is_retried_next_round():
    """🔴 首告投递失败 (飞书挂 / level 门 / cooldown 门) → 不提交 → 下轮重发.

    若 evaluate 内部就落盘 (修复前), 这里第 2 轮起会返回 SILENT → 这条告警
    永远发不出去也永远不再重试 = 永久漏告警。
    """
    store = _FakeStore()
    t = _tracker(store)
    for _ in range(5):  # 连续 5 轮投递失败
        assert _announce(t, "dead_letters", 10, 5, delivered=False) == ENTER
    assert store.state == {}, "投递失败不得留下任何 episode 状态"
    # 飞书恢复 → 这轮投递成功 → 才提交
    assert _announce(t, "dead_letters", 10, 5, delivered=True) == ENTER
    assert store.state["alert.dead_letters.active"] == "1"
    assert _announce(t, "dead_letters", 10, 5) == SILENT


def test_undelivered_escalate_keeps_old_baseline():
    """恶化告警投递失败 → 基准不得抬高 (否则要等 40 才有机会重试 20 的告警)."""
    t = _tracker()
    assert _announce(t, "dead_letters", 10, 5) == ENTER
    assert _announce(t, "dead_letters", 20, 5, delivered=False) == ESCALATE
    assert _announce(t, "dead_letters", 20, 5, delivered=True) == ESCALATE  # 重试
    assert _announce(t, "dead_letters", 20, 5) == SILENT  # 提交后才静默


def test_undelivered_recover_keeps_episode_active():
    """恢复通知投递失败 → 保持 active → 下轮重试 (否则用户永远收不到「已解除」)."""
    t = _tracker()
    assert _announce(t, "dead_letters", 10, 5) == ENTER
    assert _announce(t, "dead_letters", 0, 5, delivered=False) == RECOVER
    assert _announce(t, "dead_letters", 0, 5, delivered=True) == RECOVER  # 重试
    assert _announce(t, "dead_letters", 0, 5) == SILENT  # 提交后才复位


def test_commit_silent_is_noop():
    store = _FakeStore()
    _tracker(store).commit("dead_letters", SILENT, 3)
    assert store.state == {}


# ---------------------------------------------------------------------------
# 持久化 = 跨进程重启存活 (PRD 核心验收)
# ---------------------------------------------------------------------------


def test_state_survives_new_tracker_instance():
    """新建 tracker 实例 (= 进程重启) 读回落盘状态 → 数量没变不重新告警."""
    store = _FakeStore()
    assert _announce(_tracker(store), "dead_letters", 10, 5) == ENTER
    # 进程重启: 全新 tracker, 零内存态, 只有 sync_state
    assert _announce(_tracker(store), "dead_letters", 10, 5) == SILENT


def test_state_survives_real_sqlite_restart(tmp_path):
    """🔴 真 SQLite 落盘: 老 _cooldown_map 是纯内存, 重启即复发 —— 这条抓的就是它.

    用真 SyncStore (而非 dict 替身) 跑一遍, 证明 alert.* 键真的进了 sync_state
    表, 且新开的 store 连接能读回来。
    """
    from src.mail.sync_store import SyncStore

    db = str(tmp_path / "sync_store.db")
    assert _announce(
        AlertEpisodeTracker(SyncStore(db)), "dead_letters", 10, 5
    ) == ENTER

    # 新 SyncStore 连接 = 新进程
    store2 = SyncStore(db)
    assert _announce(AlertEpisodeTracker(store2), "dead_letters", 10, 5) == SILENT
    assert store2.get_state("alert.dead_letters.active") == "1"
    assert float(store2.get_state("alert.dead_letters.last_alerted_value")) == 10.0
    assert store2.get_state("alert.dead_letters.entered_at")  # 诊断字段已写

    # 恢复后状态复位, 同样跨连接可见
    assert _announce(AlertEpisodeTracker(store2), "dead_letters", 0, 5) == RECOVER
    assert SyncStore(db).get_state("alert.dead_letters.active") == "0"


# ---------------------------------------------------------------------------
# 布尔型状态告警 (service_unhealthy / radar_unavailable) → 纯 edge-triggered
# ---------------------------------------------------------------------------


def test_flag_episode_is_edge_triggered():
    t = _tracker()
    assert _announce_flag(t, "radar_unavailable", False) == SILENT
    assert _announce_flag(t, "radar_unavailable", True) == ENTER
    assert _announce_flag(t, "radar_unavailable", True) == SILENT  # 翻倍分支不适用
    assert _announce_flag(t, "radar_unavailable", True) == SILENT
    assert _announce_flag(t, "radar_unavailable", False) == RECOVER
    assert _announce_flag(t, "radar_unavailable", False) == SILENT
    assert _announce_flag(t, "radar_unavailable", True) == ENTER


@pytest.mark.parametrize("corrupt", ["", "not-a-number", "nan", "inf"])
def test_flag_never_returns_escalate_even_with_corrupt_baseline(corrupt):
    """🔴 HIGH-2: active=1 但 baseline 缺失/损坏 (commit 多键部分写入) 时,
    底层 evaluate fail-open 返回 ESCALATE; evaluate_flag 必须归一成 ENTER ——
    否则只认 ENTER 的布尔调用方本轮不告警、基准却被写好 → 之后永久静默。
    """
    store = _FakeStore({
        "alert.radar_unavailable.active": "1",
        "alert.radar_unavailable.last_alerted_value": corrupt,
    })
    t = _tracker(store)
    assert t.evaluate("radar_unavailable", 1.0, 1.0) == ESCALATE  # 底层 fail-open
    assert t.evaluate_flag("radar_unavailable", True) == ENTER    # 对外归一
    # 归一后调用方会告警 + commit → 基准自愈
    t.commit("radar_unavailable", ENTER, 1.0)
    assert t.evaluate_flag("radar_unavailable", True) == SILENT


# ---------------------------------------------------------------------------
# flag-off 回退 (MAILAGENT_ALERT_EPISODE=false)
# ---------------------------------------------------------------------------


def test_disabled_tracker_always_alerts_and_never_recovers():
    """字节级回退: 判据成立就 ENTER (=每轮都告), 从不静默/恢复, 且不碰 sync_state."""
    store = _FakeStore()
    t = _tracker(store, enabled=False)
    for _ in range(5):
        assert _announce(t, "dead_letters", 10, 5) == ENTER
    assert _announce(t, "dead_letters", 4, 5) == SILENT  # 不发, 也不发恢复通知
    assert _announce_flag(t, "radar_unavailable", True) == ENTER
    assert _announce_flag(t, "radar_unavailable", True) == ENTER
    assert store.state == {}, "flag-off 不得碰 sync_state"


# ---------------------------------------------------------------------------
# fail-open: 坏状态 / store 抛异常都不能吞掉告警
# ---------------------------------------------------------------------------


def test_corrupt_last_value_fails_open_to_escalate_and_self_heals():
    store = _FakeStore({
        "alert.dead_letters.active": "1",
        "alert.dead_letters.last_alerted_value": "not-a-number",
    })
    t = _tracker(store)
    assert _announce(t, "dead_letters", 10, 5) == ESCALATE  # 宁可多发
    assert float(store.state["alert.dead_letters.last_alerted_value"]) == 10.0
    assert _announce(t, "dead_letters", 10, 5) == SILENT  # 基准已自愈


@pytest.mark.parametrize("baseline", ["inf", "-inf", "nan"])
def test_non_finite_baseline_treated_as_corrupt(baseline):
    """MEDIUM: float('inf'/'nan') 解析得动却会毒化翻倍判定 (value < inf*2 恒真
    → 永久静默) → 必须按损坏处理, fail-open 告警并自愈。"""
    store = _FakeStore({
        "alert.dead_letters.active": "1",
        "alert.dead_letters.last_alerted_value": baseline,
    })
    t = _tracker(store)
    assert _announce(t, "dead_letters", 10, 5) == ESCALATE
    assert float(store.state["alert.dead_letters.last_alerted_value"]) == 10.0


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_observation_never_recovers_active_episode(bad):
    """🔴 MEDIUM: `nan >= threshold` 恒 False → 活动 episode 会被误判 RECOVER 并
    清状态 (假恢复 + 丢 episode)。非有限观测值必须一律 SILENT 保持现状。"""
    store = _FakeStore()
    t = _tracker(store)
    assert _announce(t, "dead_letters", 10, 5) == ENTER
    assert t.evaluate("dead_letters", bad, 5) == SILENT
    assert store.state["alert.dead_letters.active"] == "1"  # episode 仍在
    # 观测值恢复正常后照常工作
    assert _announce(t, "dead_letters", 3, 5) == RECOVER


@pytest.mark.parametrize("bad", [float("nan"), float("inf")])
def test_non_finite_threshold_is_silent(bad):
    assert _tracker().evaluate("dead_letters", 10, bad) == SILENT


def test_store_exceptions_fail_open():
    class _BoomStore:
        def get_state(self, key):
            raise RuntimeError("db locked")

        def set_state(self, key, value):
            raise RuntimeError("db locked")

    t = _tracker(_BoomStore())
    assert t.evaluate("dead_letters", 10, 5) == ENTER  # 不抛, 且倾向发告警
    t.commit("dead_letters", ENTER, 10)  # 写失败也不得抛
    assert t.evaluate_flag("radar_unavailable", True) == ENTER


def test_zero_baseline_does_not_escalate_every_round():
    """阈值配成 0 时 last_value=0, '翻倍' 恒成立 → 必须靠 value>last 挡住刷屏."""
    t = _tracker()
    assert _announce(t, "dead_letters", 0, 0) == ENTER
    assert _announce(t, "dead_letters", 0, 0) == SILENT


@pytest.mark.parametrize("value,expected", [(4.9, SILENT), (5.0, ENTER), (5.1, ENTER)])
def test_threshold_boundary_is_gte(value, expected):
    assert _tracker().evaluate("dead_letters", value, 5) == expected


def test_partial_commit_write_fails_open_not_silent():
    """多键部分写入 (active=1 成功, last_alerted_value 失败) → 下一轮必须 fail-open
    到「发告警」而非「永久静默」—— 这是不引入单事务/单 JSON 值的前提。"""
    class _PartialStore(_FakeStore):
        def set_state(self, key, value):
            if key.endswith(".last_alerted_value"):
                raise RuntimeError("write dropped")
            return super().set_state(key, value)

    store = _PartialStore()
    t = _tracker(store)
    assert _announce(t, "dead_letters", 10, 5) == ENTER
    assert store.state["alert.dead_letters.active"] == "1"
    assert "alert.dead_letters.last_alerted_value" not in store.state  # 残缺
    assert t.evaluate("dead_letters", 10, 5) == ESCALATE  # fail-open 继续告警
