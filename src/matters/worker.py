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
from .repository import MatterRepository
from .run_service import MatterRunService

TICK_SECONDS = 60
CATCHUP_WINDOW = timedelta(minutes=30)
MATTER_RUN_RETRY_BACKOFF = (timedelta(minutes=5), timedelta(minutes=30))


class MatterAgendaWorker:
    def __init__(
        self,
        *,
        repository: MatterRepository,
        sync_store: Any,
        matter_agent_enabled: bool,
        notify_level_reader: Callable[[], str] | None = None,
        clock_ms: Callable[[], int] | None = None,
        run_service: MatterRunService | None = None,
    ):
        self.repository = repository
        self.sync_store = sync_store
        self.matter_agent_enabled = matter_agent_enabled
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
        if self.matter_agent_enabled:
            try:
                await asyncio.to_thread(self._schedule_tick)
                changed.update(await asyncio.to_thread(self._retry_tick))
            except Exception as exc:  # noqa: BLE001
                logger.exception(f"[matter-agenda] schedule/retry tick failed: {exc}")
        try:
            result = await asyncio.to_thread(self.attention.reconcile)
            changed.update(result["changed_matter_ids"])
            if changed:
                safe_publish("matter.attention", data={"matter_ids": sorted(changed)})
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

    def _notify_level(self) -> str:
        try:
            value = self.notify_level_reader()
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[matter-agenda] notify level read failed, using high: {exc}")
            return "high"
        return value if value in ("high", "all", "off") else "high"

    def _schedule_tick(self) -> set[int]:
        now = datetime.fromtimestamp(self.clock_ms() / 1000, timezone.utc)
        changed: set[int] = set()
        with self.repository.connect() as conn:
            rows = conn.execute(
                "SELECT id,public_id,schedule_json FROM matter WHERE deleted_at IS NULL "
                "AND archived_at IS NULL AND status NOT IN ('done','canceled') "
                "AND agent_enabled=1 AND agent_profile_id IS NOT NULL "
                "AND schedule_json IS NOT NULL"
            ).fetchall()
        for row in rows:
            try:
                schedule = json.loads(row["schedule_json"])
                if not isinstance(schedule, dict) or schedule.get("kind") != "schedule":
                    raise ValueError("invalid schedule shape")
                rule = parse_rule(schedule.get("rule"))
                anchor = parse_anchor(schedule.get("anchor"))
                timezone_name = schedule.get("timezone")
                if not isinstance(timezone_name, str) or not timezone_name:
                    raise ValueError("timezone is required")
                occurrence = prev_occurrence(rule, timezone_name, anchor, now)
                if occurrence is None or now - occurrence > CATCHUP_WINDOW:
                    continue
                marker_key = f"matter.schedule.last_fire.{int(row['id'])}"
                marker = self.sync_store.get_state(marker_key)
                occurrence_iso = occurrence.isoformat()
                if marker:
                    try:
                        if occurrence <= datetime.fromisoformat(marker):
                            continue
                    except ValueError:
                        logger.warning(f"[matter-agenda] invalid marker {marker_key}={marker!r}")
                self.run_service.enqueue_run(
                    row["public_id"],
                    idempotency_key=(
                        f"matter_followup:{int(row['id'])}:schedule:{occurrence_iso}"
                    ),
                    source="matter_schedule",
                    trigger_kind="schedule",
                )
                self.sync_store.set_state(marker_key, occurrence_iso)
                changed.add(int(row["id"]))
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    f"[matter-agenda] skipping schedule matter={row['public_id']}: {exc}"
                )
        return changed

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
