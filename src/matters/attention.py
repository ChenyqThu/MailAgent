"""Matter Attention predicates, episode reconciliation, and triage mutations."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Mapping

from .events import (
    ATTENTION_DISMISSED,
    ATTENTION_OPENED,
    ATTENTION_RESOLVED,
    ATTENTION_SNOOZED,
)
from .models import MATTER_ATTENTION_KINDS, MATTER_ATTENTION_SEVERITIES, MATTER_ATTENTION_STATES
from .repository import MatterRepository
from .service import Actor, MatterError, MatterService

WAIT_OVERDUE_DAYS = 7
DEADLINE_NEAR_DAYS = 3
SNOOZE_3D_MS = 3 * 24 * 60 * 60 * 1000

#: 事件驱动的信号（run 失败等由 `open_signal` 逐次上报，不进 `reconcile` 的判据/清账循环）。
#: 判据型信号（逾期/临期/健康度/待评审）由 `_collect_facts` 每 tick 重算 —— 两类的
#: 「resolved 之后还能不能重开」语义不同，见 `_open_episode_in_conn`。
EVENT_DRIVEN_ATTENTION_KINDS = ("run_failed", "context_gap")

_SEVERITY_RANK = {"info": 0, "warn": 1, "critical": 2}


@dataclass(frozen=True)
class AttentionFact:
    matter_id: int
    kind: str
    subject_key: str
    severity: str
    why: str
    payload: Mapping[str, Any] | None = None


class AttentionService(MatterService):
    def __init__(self, repository: MatterRepository, *, clock_ms=None):
        super().__init__(repository, clock_ms=clock_ms)

    def reconcile(self) -> dict[str, Any]:
        now = self.clock_ms()
        changed_matter_ids: set[int] = set()
        with self.repository.transaction() as conn:
            facts = self._collect_facts(conn, now)
            facts_by_key = {
                (fact.matter_id, fact.kind, fact.subject_key): fact for fact in facts
            }
            rows = conn.execute(
                "SELECT * FROM matter_attention WHERE kind NOT IN ("
                + ",".join("?" for _ in EVENT_DRIVEN_ATTENTION_KINDS)
                + ")",
                EVENT_DRIVEN_ATTENTION_KINDS,
            ).fetchall()
            existing = {
                (int(row["matter_id"]), row["kind"], row["subject_key"]): dict(row)
                for row in rows
                if row["state"] in ("open", "snoozed")
            }
            for key, fact in facts_by_key.items():
                row = existing.get(key)
                if row is None:
                    opened = self._open_episode_in_conn(conn, fact, now)
                    if opened is not None:
                        changed_matter_ids.add(fact.matter_id)
                    continue
                changes: dict[str, Any] = {"last_observed_at": now, "why": fact.why}
                if fact.payload is not None:
                    changes["payload_json"] = self._dump(dict(fact.payload))
                if row["state"] == "snoozed" and row["snoozed_until"] is not None and now > int(row["snoozed_until"]):
                    changes.update(
                        state="open", snoozed_until=None, last_notified_at=None
                    )
                    changed_matter_ids.add(fact.matter_id)
                if _SEVERITY_RANK[fact.severity] > _SEVERITY_RANK[row["severity"]]:
                    changes.update(severity=fact.severity, last_notified_at=None)
                    changed_matter_ids.add(fact.matter_id)
                conn.execute(
                    "UPDATE matter_attention SET "
                    + ", ".join(f"{column}=?" for column in changes)
                    + " WHERE id=?",
                    (*changes.values(), row["id"]),
                )
            for key, row in existing.items():
                if key in facts_by_key:
                    continue
                signal_id = int(row["id"])
                conn.execute(
                    "UPDATE matter_attention SET state='resolved', resolved_at=?, "
                    "cleared_at=COALESCE(cleared_at, ?), snoozed_until=NULL, "
                    "payload_json=? WHERE id=?",
                    (now, now, self._dump({"resolved_by": "system"}), signal_id),
                )
                self._append_attention_event(
                    conn,
                    matter_id=int(row["matter_id"]),
                    signal_id=signal_id,
                    kind=ATTENTION_RESOLVED,
                    actor=Actor(kind="system"),
                    source="matter_agenda",
                    now=now,
                    payload={"signal_id": signal_id, "resolved_by": "system"},
                )
                changed_matter_ids.add(int(row["matter_id"]))
            for row in rows:
                key = (int(row["matter_id"]), row["kind"], row["subject_key"])
                if (
                    row["state"] in ("resolved", "dismissed")
                    and row["cleared_at"] is None
                    and key not in facts_by_key
                ):
                    conn.execute(
                        "UPDATE matter_attention SET cleared_at=? WHERE id=?",
                        (now, row["id"]),
                    )
        return {"changed_matter_ids": sorted(changed_matter_ids)}

    def list_attention(
        self,
        *,
        public_id: str | None = None,
        state: str | None = "open",
        kind: str | None = None,
    ) -> list[dict[str, Any]]:
        if state is not None and state not in MATTER_ATTENTION_STATES:
            raise MatterError("E_INVALID_ARG", f"invalid attention state: {state}")
        if kind is not None and kind not in MATTER_ATTENTION_KINDS:
            raise MatterError("E_INVALID_ARG", f"invalid attention kind: {kind}")
        with self.repository.connect() as conn:
            clauses: list[str] = []
            params: list[Any] = []
            if public_id is not None:
                matter = self._require_matter(conn, public_id)
                clauses.append("a.matter_id=?")
                params.append(matter["id"])
            if state is not None:
                clauses.append("a.state=?")
                params.append(state)
            if kind is not None:
                clauses.append("a.kind=?")
                params.append(kind)
            where = " WHERE " + " AND ".join(clauses) if clauses else ""
            rows = conn.execute(
                "SELECT a.*, m.public_id, m.title AS matter_title, m.status AS matter_status, "
                "m.health AS matter_health, m.priority AS matter_priority "
                "FROM matter_attention a JOIN matter m ON m.id=a.matter_id"
                + where
                + " ORDER BY a.first_opened_at DESC, a.id DESC",
                params,
            ).fetchall()
            return [self._project_attention(row) for row in rows]

    def open_signal(
        self,
        *,
        matter_id: int,
        kind: str,
        subject_key: str,
        severity: str,
        why: str,
        payload: Mapping[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        fact = AttentionFact(matter_id, kind, subject_key, severity, why, payload)
        now = self.clock_ms()
        with self.repository.transaction() as conn:
            return self._open_episode_in_conn(conn, fact, now)

    def resolve_subject(
        self,
        conn: sqlite3.Connection,
        *,
        matter_id: int,
        kind: str,
        subject_key: str,
        state: str,
        now: int,
        actor: Actor,
        source: str,
    ) -> None:
        target = "dismissed" if state == "dismissed" else "resolved"
        timestamp_column = "dismissed_at" if target == "dismissed" else "resolved_at"
        row = conn.execute(
            "SELECT * FROM matter_attention WHERE matter_id=? AND kind=? AND subject_key=? "
            "AND state IN ('open','snoozed') ORDER BY id DESC LIMIT 1",
            (matter_id, kind, subject_key),
        ).fetchone()
        if row is None:
            return
        conn.execute(
            f"UPDATE matter_attention SET state=?, {timestamp_column}=?, snoozed_until=NULL WHERE id=?",
            (target, now, row["id"]),
        )
        event_kind = ATTENTION_DISMISSED if target == "dismissed" else ATTENTION_RESOLVED
        self._append_attention_event(
            conn,
            matter_id=matter_id,
            signal_id=int(row["id"]),
            kind=event_kind,
            actor=actor,
            source=source,
            now=now,
            payload={"signal_id": int(row["id"]), "resolved_by": actor.kind},
        )

    def triage(
        self,
        public_id: str,
        signal_id: int,
        action: str,
        *,
        idempotency_key: str,
        reason: str | None = None,
        until: int | None = None,
    ) -> dict[str, Any]:
        if action not in ("resolve", "snooze", "dismiss"):
            raise MatterError("E_INVALID_ARG", f"unsupported attention action: {action}")
        now = self.clock_ms()
        with self.repository.transaction() as conn:
            matter = self._require_matter(conn, public_id)
            expected_event = {
                "resolve": ATTENTION_RESOLVED,
                "snooze": ATTENTION_SNOOZED,
                "dismiss": ATTENTION_DISMISSED,
            }[action]
            replay = self.repository.find_event(conn, idempotency_key)
            if replay is not None:
                replay_signal_id = (replay.get("payload") or {}).get("signal_id")
                if replay["kind"] != expected_event or int(replay_signal_id or 0) != signal_id:
                    raise MatterError(
                        "E_IDEMPOTENCY_CONFLICT",
                        "idempotency key was used for another mutation",
                    )
                current = conn.execute(
                    "SELECT a.*, m.public_id, m.title AS matter_title, m.status AS matter_status, "
                    "m.health AS matter_health, m.priority AS matter_priority "
                    "FROM matter_attention a JOIN matter m ON m.id=a.matter_id WHERE a.id=?",
                    (signal_id,),
                ).fetchone()
                return self._mutation(
                    self.repository.get_matter_by_id(conn, int(matter["id"])),
                    [int(replay["id"])],
                    signal=self._project_attention(current),
                )
            row = conn.execute(
                "SELECT * FROM matter_attention WHERE id=? AND matter_id=?",
                (signal_id, matter["id"]),
            ).fetchone()
            if row is None:
                raise MatterError("E_CHILD_NOT_FOUND", f"signal {signal_id} not found")
            if action == "snooze":
                if until is None or int(until) <= now:
                    raise MatterError("E_INVALID_ARG", "snooze until must be in the future")
                changes = {"state": "snoozed", "snoozed_until": int(until)}
                event_kind = ATTENTION_SNOOZED
            elif action == "dismiss":
                changes = {"state": "dismissed", "dismissed_at": now, "snoozed_until": None}
                event_kind = ATTENTION_DISMISSED
            else:
                changes = {"state": "resolved", "resolved_at": now, "snoozed_until": None}
                event_kind = ATTENTION_RESOLVED
            cursor = conn.execute(
                "UPDATE matter_attention SET "
                + ", ".join(f"{column}=?" for column in changes)
                + " WHERE id=? AND matter_id=? AND state IN ('open','snoozed')",
                (*changes.values(), signal_id, matter["id"]),
            )
            if cursor.rowcount != 1:
                raise MatterError("E_INVALID_STATE", "attention signal is already closed")
            event_id = self._append_attention_event(
                conn,
                matter_id=int(matter["id"]),
                signal_id=signal_id,
                kind=event_kind,
                actor=Actor(kind="user"),
                source="desktop_ui",
                now=now,
                payload={"signal_id": signal_id, "reason": reason, **changes},
                dedupe_key=idempotency_key,
            )
            updated = conn.execute(
                "SELECT a.*, m.public_id, m.title AS matter_title, m.status AS matter_status, "
                "m.health AS matter_health, m.priority AS matter_priority "
                "FROM matter_attention a JOIN matter m ON m.id=a.matter_id WHERE a.id=?",
                (signal_id,),
            ).fetchone()
            return self._mutation(
                self.repository.get_matter_by_id(conn, int(matter["id"])),
                [event_id],
                signal=self._project_attention(updated),
            )

    def acknowledge_notified(self, public_id: str, signal_id: int) -> dict[str, Any]:
        now = self.clock_ms()
        with self.repository.transaction() as conn:
            matter = self._require_matter(conn, public_id)
            cursor = conn.execute(
                "UPDATE matter_attention SET last_notified_at=? WHERE id=? AND matter_id=? "
                "AND state='open'",
                (now, signal_id, matter["id"]),
            )
            if cursor.rowcount != 1:
                row = conn.execute(
                    "SELECT id FROM matter_attention WHERE id=? AND matter_id=?",
                    (signal_id, matter["id"]),
                ).fetchone()
                if row is None:
                    raise MatterError("E_CHILD_NOT_FOUND", f"signal {signal_id} not found")
                raise MatterError("E_INVALID_STATE", "attention signal is not open")
            return {"signal_id": signal_id, "last_notified_at": now}

    def eligible_notifications(self, level: str) -> list[dict[str, Any]]:
        if level == "off":
            return []
        with self.repository.connect() as conn:
            clauses = ["a.state='open'", "a.last_notified_at IS NULL"]
            if level == "high":
                clauses.append("(a.severity='critical' OR a.kind='needs_review')")
            rows = conn.execute(
                "SELECT a.*, m.public_id, m.title AS matter_title FROM matter_attention a "
                "JOIN matter m ON m.id=a.matter_id WHERE " + " AND ".join(clauses)
                + " ORDER BY a.first_opened_at, a.id"
            ).fetchall()
            return [self._project_attention(row) for row in rows]

    def _collect_facts(self, conn: sqlite3.Connection, now: int) -> list[AttentionFact]:
        facts: list[AttentionFact] = []
        today = datetime.fromtimestamp(now / 1000).date()
        cutoff = now - WAIT_OVERDUE_DAYS * 24 * 60 * 60 * 1000
        matters = conn.execute(
            "SELECT * FROM matter WHERE deleted_at IS NULL AND archived_at IS NULL "
            "AND status NOT IN ('done','canceled')"
        ).fetchall()
        for matter in matters:
            matter_id = int(matter["id"])
            if matter["health"] in ("at_risk", "off_track"):
                severity = "warn" if matter["health"] == "at_risk" else "critical"
                facts.append(AttentionFact(
                    matter_id, "health_down", "health", severity,
                    "事项健康度为有风险" if severity == "warn" else "事项健康度为偏离计划",
                ))
            due_at = matter["due_at"]
            if due_at is not None:
                due_date = datetime.fromtimestamp(int(due_at) / 1000).date()
                days = (due_date - today).days
                if 0 <= days <= DEADLINE_NEAR_DAYS:
                    facts.append(AttentionFact(
                        matter_id, "deadline_near", f"due:{due_date.isoformat()}", "warn",
                        f"事项将在 {days} 天后到期" if days else "事项今天到期",
                    ))
            items = conn.execute(
                "SELECT * FROM matter_item WHERE matter_id=? AND kind='action' AND deleted_at IS NULL",
                (matter_id,),
            ).fetchall()
            for item in items:
                item_id = int(item["id"])
                status = item["status"]
                due_date = (
                    datetime.fromtimestamp(int(item["due_at"]) / 1000).date()
                    if item["due_at"] is not None else None
                )
                if status == "waiting" and (
                    (due_date is not None and due_date < today) or int(item["updated_at"]) <= cutoff
                ):
                    days = max(1, (now - int(item["updated_at"])) // (24 * 60 * 60 * 1000))
                    facts.append(AttentionFact(
                        matter_id, "wait_overdue", f"item:{item_id}", "critical",
                        f"等待「{item['title']}」已 {days} 天",
                    ))
                if status in ("open", "in_progress") and due_date is not None and due_date < today:
                    days = (today - due_date).days
                    facts.append(AttentionFact(
                        matter_id, "action_overdue", f"item:{item_id}", "critical",
                        f"行动项「{item['title']}」已逾期 {days} 天",
                    ))
            updates = conn.execute(
                "SELECT id FROM matter_update WHERE matter_id=? AND review_status='pending'",
                (matter_id,),
            ).fetchall()
            for update in updates:
                update_id = int(update["id"])
                facts.append(AttentionFact(
                    matter_id, "needs_review", f"update:{update_id}", "info",
                    "有一条 Agent 提案等待评审", {"update_id": update_id},
                ))
        return facts

    def _open_episode_in_conn(
        self, conn: sqlite3.Connection, fact: AttentionFact, now: int
    ) -> dict[str, Any] | None:
        if fact.kind not in MATTER_ATTENTION_KINDS or fact.severity not in MATTER_ATTENTION_SEVERITIES:
            raise MatterError("E_INVALID_ARG", "invalid attention signal vocabulary")
        active = conn.execute(
            "SELECT * FROM matter_attention WHERE matter_id=? AND kind=? AND subject_key=? "
            "AND state IN ('open','snoozed') ORDER BY id DESC LIMIT 1",
            (fact.matter_id, fact.kind, fact.subject_key),
        ).fetchone()
        if active is not None:
            return None
        previous = conn.execute(
            "SELECT * FROM matter_attention WHERE matter_id=? AND kind=? AND subject_key=? "
            "ORDER BY id DESC LIMIT 1",
            (fact.matter_id, fact.kind, fact.subject_key),
        ).fetchone()
        # 判据仍为真时，owner 的「解决/忽略」= 直到判据翻转前不再报（0813 A20）：
        # `cleared_at IS NULL` = 判据自上次人工处置后从未消失过 —— reconcile 观察到判据
        # 翻转才停 `cleared_at`，之后同一事实再成立才算新 episode（recurrence_no+1）。
        # 此前只认 dismissed，用户点「解决」而逾期仍为真时，下一 tick 就原样重开 ——
        # 「解决」按不灭。resolved 的豁免只给判据型信号：run_failed/context_gap 是
        # 事件驱动、没有清账循环，resolved 也豁免会把「同一 run 再次失败」永久静默。
        if previous is not None and previous["cleared_at"] is None:
            if previous["state"] == "dismissed":
                return None
            if (
                previous["state"] == "resolved"
                and fact.kind not in EVENT_DRIVEN_ATTENTION_KINDS
            ):
                return None
        recurrence_no = int(previous["recurrence_no"]) + 1 if previous is not None else 1
        cursor = conn.execute(
            "INSERT INTO matter_attention(matter_id,kind,subject_key,state,severity,why," 
            "recurrence_no,first_opened_at,last_observed_at,payload_json) VALUES (?,?,?,'open',?,?,?,?,?,?)",
            (
                fact.matter_id, fact.kind, fact.subject_key, fact.severity, fact.why,
                recurrence_no, now, now,
                self._dump(dict(fact.payload)) if fact.payload is not None else None,
            ),
        )
        signal_id = int(cursor.lastrowid)
        self._append_attention_event(
            conn,
            matter_id=fact.matter_id,
            signal_id=signal_id,
            kind=ATTENTION_OPENED,
            actor=Actor(kind="system"),
            source="matter_agenda",
            now=now,
            payload={"signal_id": signal_id, "kind": fact.kind, "severity": fact.severity},
        )
        row = conn.execute("SELECT * FROM matter_attention WHERE id=?", (signal_id,)).fetchone()
        return self._project_attention(row)

    def _append_attention_event(
        self,
        conn: sqlite3.Connection,
        *,
        matter_id: int,
        signal_id: int,
        kind: str,
        actor: Actor,
        source: str,
        now: int,
        payload: Mapping[str, Any],
        dedupe_key: str | None = None,
    ) -> int:
        return self._append_event(
            conn,
            matter_id=matter_id,
            kind=kind,
            actor=actor,
            source=source,
            dedupe_key=dedupe_key or f"attention:{kind}:{signal_id}",
            payload=payload,
            happened_at=now,
            reason=None,
        )

    @classmethod
    def _project_attention(cls, row: sqlite3.Row | Mapping[str, Any]) -> dict[str, Any]:
        result = dict(row)
        payload = result.pop("payload_json", None)
        try:
            result["payload"] = json.loads(payload) if payload else None
        except (TypeError, json.JSONDecodeError):
            result["payload"] = None
        if "public_id" in result:
            result["matter"] = {
                "public_id": result.pop("public_id"),
                "title": result.pop("matter_title"),
                "status": result.pop("matter_status", None),
                "health": result.pop("matter_health", None),
                "priority": result.pop("matter_priority", None),
            }
        return result
