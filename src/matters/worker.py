"""Minute agenda worker for Matter schedules, retries, Attention, and notifications."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from loguru import logger

from src.agents.schedule_rule import parse_anchor, parse_rule, prev_occurrence
from src.events.publisher import safe_publish

from .attention import AttentionService
from .models import MatterRunTrigger
from .repository import MatterRepository
from .run_service import MatterRunService
from .triggers import (
    EVENT_TRIGGER_CRITERIA,
    idempotency_key,
    is_legacy_shape,
    marker_key,
    parse_trigger_set,
)

TICK_SECONDS = 60
CATCHUP_WINDOW = timedelta(minutes=30)
MATTER_RUN_RETRY_BACKOFF = (timedelta(minutes=5), timedelta(minutes=30))


class MatterAgendaWorker:
    def __init__(
        self,
        *,
        repository: MatterRepository,
        sync_store: Any,
        notify_level_reader: Callable[[], str] | None = None,
        clock_ms: Callable[[], int] | None = None,
        run_service: MatterRunService | None = None,
    ):
        self.repository = repository
        self.sync_store = sync_store
        self.notify_level_reader = notify_level_reader or (lambda: "high")
        self.clock_ms = clock_ms or (lambda: int(datetime.now(timezone.utc).timestamp() * 1000))
        self.attention = AttentionService(repository, clock_ms=self.clock_ms)
        self.run_service = run_service or MatterRunService(repository, clock_ms=self.clock_ms)

    async def run(self, shutdown_event: asyncio.Event) -> None:
        while not shutdown_event.is_set():
            await self.tick()
            try:
                await asyncio.wait_for(shutdown_event.wait(), timeout=TICK_SECONDS)
            except asyncio.TimeoutError:
                pass

    async def tick(self) -> None:
        changed: set[int] = set()
        try:
            await asyncio.to_thread(self._schedule_tick)
            changed.update(await asyncio.to_thread(self._retry_tick))
        except Exception as exc:  # noqa: BLE001
            logger.exception(f"[matter-agenda] schedule/retry tick failed: {exc}")
        try:
            result = await asyncio.to_thread(self.attention.reconcile)
            changed.update(result["changed_matter_ids"])
            if changed:
                # perf-sse-realtime: payload 增发 public_ids —— 前端缓存键用的是
                # publicId 字符串, 之前只发内部数字主键 matter_ids 导致消费端只能按
                # 形状全量失效 (sse-events.md 记为踩坑活证据)。matter_ids 保留一版
                # (SSE 是对外可观察面, 不做无预告的字段删除)。
                safe_publish(
                    "matter.attention",
                    data={
                        "matter_ids": sorted(changed),
                        "public_ids": await asyncio.to_thread(
                            self._public_ids_for, sorted(changed)
                        ),
                    },
                )
            level = await asyncio.to_thread(self._notify_level)
            notifications = await asyncio.to_thread(
                self.attention.eligible_notifications, level
            )
            for signal in notifications:
                matter = signal["matter"]
                safe_publish(
                    "matter.notify",
                    data={
                        "matter_id": signal["matter_id"],
                        "public_id": matter["public_id"],
                        "matter_title": matter["title"],
                        "signal_id": signal["id"],
                        "kind": signal["kind"],
                        "severity": signal["severity"],
                        "why": signal["why"],
                    },
                )
        except Exception as exc:  # noqa: BLE001
            logger.exception(f"[matter-agenda] attention tick failed: {exc}")

    def _public_ids_for(self, matter_ids: list[int]) -> list[str]:
        """内部数字主键 → public_id（``matter.attention`` payload 用, 保持输入序）。

        失败返 [] —— 消费端 (useEventBridge) 拿不到 public_ids 时回落按形状全量失效,
        与旧行为等价, 不会漏刷。
        """
        if not matter_ids:
            return []
        try:
            with self.repository.connect() as conn:
                placeholders = ",".join("?" for _ in matter_ids)
                rows = conn.execute(
                    f"SELECT id, public_id FROM matter WHERE id IN ({placeholders})",
                    matter_ids,
                ).fetchall()
            by_id = {int(row["id"]): str(row["public_id"]) for row in rows}
            return [by_id[i] for i in matter_ids if i in by_id]
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[matter-agenda] public_id mapping failed: {exc}")
            return []

    def _notify_level(self) -> str:
        try:
            value = self.notify_level_reader()
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[matter-agenda] notify level read failed, using high: {exc}")
            return "high"
        return value if value in ("high", "all", "off") else "high"

    def _schedule_tick(self) -> set[int]:
        """遍历所有启用的 trigger entry，按 kind 分派到三条判定路径（P6-B D6/D16）。

        🔴 单条 entry 解析失败**只跳过那一条** —— 一个坏掉的 event trigger 不该顺带
        让同一事项的定时跟进也停摆。
        """
        now = datetime.fromtimestamp(self.clock_ms() / 1000, timezone.utc)
        changed: set[int] = set()
        with self.repository.connect() as conn:
            rows = conn.execute(
                "SELECT id,public_id,schedule_json FROM matter WHERE deleted_at IS NULL "
                "AND archived_at IS NULL AND status NOT IN ('done','canceled') "
                "AND agent_enabled=1 AND schedule_json IS NOT NULL"
            ).fetchall()
        for row in rows:
            matter_id = int(row["id"])
            raw = row["schedule_json"]
            try:
                legacy = is_legacy_shape(raw)
                entries = parse_trigger_set(raw, seed=str(matter_id))
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    f"[matter-agenda] skipping matter={row['public_id']}: {exc}"
                )
                continue
            for entry in entries:
                if not entry.enabled:
                    continue
                try:
                    fired = self._fire_trigger(row, matter_id, entry, now, legacy=legacy)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        f"[matter-agenda] skipping trigger {entry.id} "
                        f"matter={row['public_id']}: {exc}"
                    )
                    continue
                if fired:
                    changed.add(matter_id)
        return changed

    def _fire_trigger(self, row, matter_id: int, entry, now, *, legacy: bool) -> bool:
        """判定单条 trigger 是否该触发；触发则入队并推进 marker。返回是否入队。"""
        if entry.kind == MatterRunTrigger.MANUAL:
            return False
        if entry.kind == MatterRunTrigger.SCHEDULE:
            occurrence = prev_occurrence(
                parse_rule(entry.rule), entry.timezone, parse_anchor(entry.anchor), now
            )
            if occurrence is None or now - occurrence > CATCHUP_WINDOW:
                return False
            stamp = occurrence.isoformat()
            key = marker_key(matter_id, entry, legacy=legacy)
            marker = self.sync_store.get_state(key)
            if marker:
                try:
                    if occurrence <= datetime.fromisoformat(marker):
                        return False
                except ValueError:
                    logger.warning(f"[matter-agenda] invalid marker {key}={marker!r}")
        else:
            # EVENT / CONDITION：判据各自产出一个**稳定**的证据标识；marker 存的就是它。
            # 同一条持续 open 的信号、同一个已消费过的事件，标识不变 ⇒ 只 fire 一次。
            stamp = (
                self._event_evidence(matter_id, entry)
                if entry.kind == MatterRunTrigger.EVENT
                else self._condition_evidence(matter_id, entry)
            )
            if stamp is None:
                return False
            key = marker_key(matter_id, entry, legacy=legacy)
            if self.sync_store.get_state(key) == stamp:
                return False

        self.run_service.enqueue_run(
            row["public_id"],
            idempotency_key=idempotency_key(matter_id, entry, stamp, legacy=legacy),
            source=f"matter_{entry.kind}",
            trigger_kind=str(entry.kind),
        )
        self.sync_store.set_state(key, stamp)
        return True

    def _event_evidence(self, matter_id: int, entry) -> str | None:
        """最新一条符合该 event trigger 判据的 `matter_event` 行 id。"""
        event_kind, resource_kinds = EVENT_TRIGGER_CRITERIA[entry.event_type]
        with self.repository.connect() as conn:
            rows = conn.execute(
                "SELECT e.id, e.payload_json FROM matter_event e "
                "WHERE e.matter_id=? AND e.kind=? ORDER BY e.id DESC LIMIT 20",
                (matter_id, event_kind),
            ).fetchall()
            for event_row in rows:
                if not resource_kinds:
                    return f"event:{int(event_row['id'])}"
                try:
                    payload = json.loads(event_row["payload_json"] or "{}")
                except (TypeError, ValueError):
                    continue
                kind = payload.get("resource_kind") or payload.get("kind")
                if kind in resource_kinds:
                    return f"event:{int(event_row['id'])}"
        return None

    def _condition_evidence(self, matter_id: int, entry) -> str | None:
        """该条件当前是否有 open 信号；返回信号的稳定标识。"""
        with self.repository.connect() as conn:
            signal = conn.execute(
                "SELECT id, subject_key FROM matter_attention "
                "WHERE matter_id=? AND kind=? AND state='open' ORDER BY id LIMIT 1",
                (matter_id, entry.condition),
            ).fetchone()
        if signal is None:
            return None
        return f"signal:{int(signal['id'])}:{signal['subject_key']}"

    def _retry_tick(self) -> set[int]:
        now = self.clock_ms()
        changed: set[int] = set()
        with self.repository.connect() as conn:
            matters = conn.execute(
                "SELECT id,public_id FROM matter WHERE deleted_at IS NULL AND archived_at IS NULL "
                "AND status NOT IN ('done','canceled')"
            ).fetchall()
            histories = {
                int(matter["id"]): conn.execute(
                    "SELECT * FROM matter_run WHERE matter_id=? AND completed_at IS NOT NULL "
                    "ORDER BY completed_at DESC,id DESC",
                    (matter["id"],),
                ).fetchall()
                for matter in matters
            }
        public_ids = {int(matter["id"]): matter["public_id"] for matter in matters}
        for matter_id, rows in histories.items():
            if not rows or rows[0]["status"] != "fail":
                continue
            failures = []
            for row in rows:
                if row["status"] != "fail":
                    break
                failures.append(row)
            latest = failures[0]
            if latest["trigger_kind"] == "manual":
                if self.attention.open_signal(
                    matter_id=matter_id,
                    kind="run_failed",
                    subject_key=f"run:{int(latest['id'])}",
                    severity="critical",
                    why="手动跟进运行失败，需要检查后重试",
                    payload={"run_id": int(latest["id"])},
                ):
                    changed.add(matter_id)
                continue
            failure_count = len(failures)
            if failure_count <= len(MATTER_RUN_RETRY_BACKOFF):
                completed_at = int(latest["completed_at"] or 0)
                delay_ms = int(
                    MATTER_RUN_RETRY_BACKOFF[failure_count - 1].total_seconds() * 1000
                )
                if now - completed_at < delay_ms:
                    continue
                self.run_service.enqueue_run(
                    public_ids[matter_id],
                    idempotency_key=(
                        f"matter_followup:{matter_id}:retry:{int(latest['id'])}"
                    ),
                    source="matter_retry",
                    trigger_kind="schedule",
                )
            else:
                if self.attention.open_signal(
                    matter_id=matter_id,
                    kind="run_failed",
                    subject_key=f"run:{int(latest['id'])}",
                    severity="critical",
                    why="定时跟进连续失败 3 次，需要人工处理",
                    payload={"run_id": int(latest["id"]), "attempts": failure_count},
                ):
                    changed.add(matter_id)
        return changed
