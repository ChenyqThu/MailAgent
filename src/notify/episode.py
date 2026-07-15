"""状态型告警的 episode 状态机 (task 07-14).

状态型告警 = 判据成立后**不会自行消失**的告警 (死信数 ≥ 阈值 / 服务不健康 /
outbox 积压 / token age…)。原实现每轮健康检查都无条件调 ``alert_xxx()``, 仅靠
``FeishuAlertNotifier`` 内存态 ``_cooldown_map`` (默认 300s) 限流 → 每 5min 一条
刷到人工干预为止; 且冷却是纯内存的, 进程重启即清空 → 重启后立刻复发。

本模块把 ``src/mail/davmail_watchdog.py`` 已验证的范式 —— 「**调用方持有状态 +
落盘 sync_state**」(``_announced_*`` + ``_write_state``) —— 下沉成通用能力:
进入异常态告一次 → 中间静默 → 值翻倍 (显著恶化) 才再告 → 恢复时告一次并复位。

``Alerter`` 的**投递 / 冷却语义一行不改**(``send_alert`` / ``_check_cooldown`` /
``_cooldown_map`` 原样); 仅有的 alert.py 改动是三个 recovery 通知的 level
(info→warning, 否则被 enabled_levels 门挡掉发不出) + 给本模块用到的 ``alert_*``
方法补 ``return``(纯增量, 原返回 None 且无人读)。

🔴 **两阶段提交 (evaluate → 投递 → commit)**
``evaluate()`` **只判定不落盘**; 调用方必须在告警**真的投递成功后**才调
``commit()``。因为 ``send_alert()`` 会在三种情况下静默返回 False —— level 门
(``enabled_levels`` 不含该级别) / 300s cooldown 门 / 网络或 webhook 失败 ——
若判定时就落盘, 这条告警就被永久标成「已告警」, value 恒定则之后永远 SILENT,
**首告从未送达 = 永久漏告警**。投递失败 → 不 commit → 下轮重新判定重发。

sync_state key 约定 (镜像 ``davmail.*`` 键先例 → 非 schema 变更, **不 bump
DB_VERSION**):

  alert.<key>.active              '1' / '0'
  alert.<key>.last_alerted_value  最近一次**成功告警**时的观测值 (浮点字符串)
  alert.<key>.entered_at          episode 进入时间 (ISO, 仅诊断用)

状态落盘 → 跨进程 (serve / serve-api) 共享 + 跨重启存活。

**多键部分写入是安全的**: commit 的 2-3 次 ``set_state`` 若中途失败, 各种残缺
组合 (active=1 但 last 缺失 / active=0 但 last 残留 / …) 下一轮都 fail-open 落到
「发告警」而非「静默」, 并在下次 commit 时自愈 —— 故不引入单事务 / 单 JSON 值
(那会牺牲 ``sqlite3 'SELECT * FROM sync_state WHERE key LIKE "alert.%"'`` 的逐
字段可观测性, 而这正是 davmail.* 键先例的价值)。见 tests/notify/
test_alert_episode.py 的部分写入用例。
"""

from __future__ import annotations

import math
from datetime import datetime
from typing import Optional, Protocol, Tuple

from loguru import logger

# evaluate() 的判定结果
ENTER = "enter"        # 首次越阈值 → 发告警
ESCALATE = "escalate"  # episode 内显著恶化 (值翻倍) → 再发一次
SILENT = "silent"      # 不发 (episode 内无显著变化, 或压根没越阈值)
RECOVER = "recover"    # 回落到阈值下 → 发恢复通知并复位


class _StateStore(Protocol):
    """只用到 sync_state 的 KV 面 (SyncStore 的子集)。"""

    def get_state(self, key: str) -> Optional[str]: ...

    def set_state(self, key: str, value: str) -> bool: ...


class AlertEpisodeTracker:
    """状态型告警的 episode 判定器 (状态落 sync_state, 自身无内存态)。

    用法 —— **判定与提交分离**, commit 必须在投递成功后:

        action = tracker.evaluate("dead_letters", count, threshold)
        if action in (ENTER, ESCALATE):
            if await alerter.alert_dead_letters(count, threshold):  # 真送达才 True
                tracker.commit("dead_letters", action, count)
        elif action == RECOVER:
            if await alerter.alert_recovery("死信队列"):
                tracker.commit("dead_letters", action, count)

    Args:
        store: 提供 get_state/set_state 的 sync_store。
        enabled: ``MAILAGENT_ALERT_EPISODE``。False → 判据成立就告、从不静默 /
            恢复, 且 ``commit`` 是 no-op (不碰 sync_state), 即逐字回退到 episode
            化之前的行为 (去重仍由 Alerter 的 300s 内存冷却兜底)。误判 silent =
            漏告警, 比刷屏危险 → 必须留一键回退。

    失败策略一律 **fail-open**: 读 / 写 sync_state 出错、状态损坏 → 倾向发告警,
    宁可多发也不漏发。唯一例外是非有限观测值 (NaN/inf, 见 ``evaluate``)。
    """

    def __init__(self, store: _StateStore, *, enabled: bool = True) -> None:
        self.store = store
        self.enabled = enabled

    # ── public API ─────────────────────────────────────────────────────

    def evaluate(self, key: str, value: float, threshold: float) -> str:
        """判定 ``key`` 本轮该做什么。**只读不写** —— 落盘见 ``commit()``。

        调用方**每轮都要调**(即使判据不成立), 否则 episode 永远不会复位。
        """
        # NaN/inf 防线: `nan >= threshold` 恒 False → 活动 episode 会被误判成
        # RECOVER 并清状态 (假恢复); 非有限阈值同理。据无效观测值宣告任何跃迁都
        # 是错的 → 一律 SILENT (保持 active 原样不动) + 可观测日志。
        if not (math.isfinite(value) and math.isfinite(threshold)):
            logger.warning(
                f"[alert-episode] non-finite input ({key}): "
                f"value={value!r} threshold={threshold!r} → 保持现状不跃迁"
            )
            return SILENT

        if not self.enabled:
            return ENTER if value >= threshold else SILENT

        active, last_value = self._read(key)
        triggered = value >= threshold

        if not active:
            return ENTER if triggered else SILENT

        if not triggered:
            return RECOVER

        # 翻倍才再告。last_value 缺失/损坏/非有限 (状态残缺) → fail-open 当作
        # 恶化 → 发告警 + commit 时自愈基准; last_value ≤ 0 时「翻倍」无意义
        # (0*2 还是 0 → 每轮都判恶化 = 刷屏回归), 故同时要求值真的变大。
        if last_value is not None and (
            value < last_value * 2 or value <= last_value
        ):
            return SILENT
        return ESCALATE

    def evaluate_flag(self, key: str, bad: bool) -> str:
        """布尔型状态告警 (无「数量」维度, 如 service_unhealthy / radar_unavailable)。

        退化为纯 edge-triggered, 对外**只暴露 ENTER / SILENT / RECOVER 三态**:
        布尔量没有「恶化」维度, 调用方不该被迫认识 ESCALATE。

        🔴 ESCALATE 必须归一成 ENTER 而非丢弃: 状态残缺时 (active=1 但
        last_alerted_value 缺失/损坏, 例如 commit 的多次 set_state 中途失败)
        底层 evaluate 会 fail-open 返回 ESCALATE; 若调用方只认 ENTER, 这轮既不
        告警、基准又被写好 → 之后一路 SILENT 到恢复为止 = 永久漏告警。
        """
        action = self.evaluate(key, 1.0 if bad else 0.0, 1.0)
        return ENTER if action == ESCALATE else action

    def commit(self, key: str, action: str, value: float) -> None:
        """把 ``evaluate`` 的判定落盘 —— **只在告警真的投递成功后调**。

        投递失败就别调: 下一轮 evaluate 会重新给出同样的判定并重发 (fail-open
        落到「重发」而非「永久静默」)。``SILENT`` 无状态变化, 传进来是 no-op。
        """
        if not self.enabled:
            return  # flag-off 不碰 sync_state (字节级回退)
        if action == ENTER:
            self._write(f"alert.{key}.active", "1")
            self._write(f"alert.{key}.last_alerted_value", repr(float(value)))
            self._write(
                f"alert.{key}.entered_at",
                datetime.now().isoformat(timespec="seconds"),
            )
        elif action == ESCALATE:
            self._write(f"alert.{key}.last_alerted_value", repr(float(value)))
        elif action == RECOVER:
            self._write(f"alert.{key}.active", "0")
            self._write(f"alert.{key}.last_alerted_value", "")

    # ── sync_state 读写 (镜像 davmail_watchdog._write_state 范式) ────────

    def _read(self, key: str) -> Tuple[bool, Optional[float]]:
        try:
            active = self.store.get_state(f"alert.{key}.active") == "1"
            raw = self.store.get_state(f"alert.{key}.last_alerted_value")
        except Exception as e:  # noqa: BLE001 — 告警链路不能被 SQLite 打挂
            logger.debug(f"[alert-episode] read failed ({key}): {e}")
            return False, None
        last_value: Optional[float] = None
        if raw:
            try:
                last_value = float(raw)
            except (TypeError, ValueError):
                last_value = None  # 值损坏 → fail-open
            else:
                if not math.isfinite(last_value):
                    # 'inf' / 'nan' 能被 float() 解析却会毒化翻倍判定
                    # (value < inf*2 恒真 → 永久静默) → 同样按损坏处理
                    last_value = None
        return active, last_value

    def _write(self, key: str, value: str) -> None:
        try:
            self.store.set_state(key, value)
        except Exception as e:  # noqa: BLE001 — 落盘失败最多下轮重发, 不漏发
            logger.debug(f"[alert-episode] write failed ({key}): {e}")
