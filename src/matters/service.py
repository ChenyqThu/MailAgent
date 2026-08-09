"""Transactional Matter aggregate service."""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from .models import (
    MATTER_ACTOR_KINDS,
    MATTER_HEALTH_VALUES,
    MATTER_ITEM_KINDS,
    MATTER_ITEM_STATUSES,
    MATTER_PRIORITIES,
    MATTER_STATUSES,
    MatterActorKind,
    MatterItemKind,
    format_public_id,
    normalize_tags,
)
from .repository import MatterRepository

TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
ACTION_ONLY_ITEM_FIELDS = {
    "status",
    "priority",
    "owner_kind",
    "owner_id",
    "waiting_on_stakeholder_id",
    "due_at",
    "completed_at",
    "checklist",
}
MANUAL_UPDATE_FIELDS = {"status", "health", "current_summary"}
DIRECT_PATCH_FIELDS = {
    "title",
    "description",
    "matter_type",
    "tags",
    "due_at",
    "waiting_context",
    "next_attention_at",
    "attention_reason",
}


class MatterError(RuntimeError):
    def __init__(self, code: str, message: str, *, hint: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint


@dataclass(frozen=True)
class Actor:
    kind: str = MatterActorKind.USER.value
    actor_id: str | None = None


class MatterService:
    def __init__(self, repository: MatterRepository, *, clock_ms=None):
        self.repository = repository
        self.clock_ms = clock_ms or (lambda: int(time.time() * 1000))

    def create_matter(
        self,
        data: Mapping[str, Any],
        *,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
    ) -> dict[str, Any]:
        self._validate_actor(actor)
        title = str(data.get("title") or "").strip()
        if not title:
            raise MatterError("E_INVALID_ARG", "title is required")
        status = str(data.get("status") or "inbox")
        health = str(data.get("health") or "unknown")
        priority = str(data.get("priority") or "p1")
        self._require_value("status", status, MATTER_STATUSES)
        self._require_value("health", health, MATTER_HEALTH_VALUES)
        self._require_value("priority", priority, MATTER_PRIORITIES)
        tags = normalize_tags(data.get("tags"))
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        with self.repository.transaction() as conn:
            replay = self._replay(conn, dedupe_key, "matter_created")
            if replay:
                return replay
            seq = self.repository.allocate_sequence(conn, now)
            public_id = format_public_id(seq)
            matter_id = self.repository.insert_matter(
                conn,
                {
                    "public_id": public_id,
                    "title": title,
                    "description": str(data.get("description") or ""),
                    "matter_type": self._optional_text(data.get("matter_type")),
                    "tags_json": self._dump(tags),
                    "status": status,
                    "health": health,
                    "priority": priority,
                    "owner_id": actor.actor_id,
                    "source": source or "desktop_ui",
                    "due_at": data.get("due_at"),
                    "waiting_context_json": self._dump(data["waiting_context"])
                    if data.get("waiting_context") is not None
                    else None,
                    "last_activity_at": now,
                    "created_at": now,
                    "updated_at": now,
                },
            )
            self.refresh_search_projection(conn, matter_id)
            event_id = self._append_event(
                conn,
                matter_id=matter_id,
                kind="matter_created",
                actor=actor,
                source=source,
                dedupe_key=dedupe_key,
                reason=reason,
                payload={"public_id": public_id},
                happened_at=now,
            )
            matter = self.repository.get_matter_by_id(conn, matter_id)
            return self._mutation(matter, [event_id])

    def get_matter(
        self, public_id: str, *, include: Sequence[str] = ()
    ) -> dict[str, Any]:
        with self.repository.connect() as conn:
            matter = self.repository.get_matter(conn, public_id)
            if not matter:
                raise MatterError("E_MATTER_NOT_FOUND", f"matter {public_id} not found")
            result: dict[str, Any] = {"matter": matter}
            include_set = set(include)
            if "items" in include_set:
                result["items"] = self.repository.list_items(
                    conn, matter["id"], include_deleted=True
                )
            if "timeline" in include_set:
                result["timeline"], _ = self.repository.list_events(
                    conn, matter["id"], cursor=None, limit=100
                )
            if "updates" in include_set:
                result["updates"] = self.repository.list_updates(conn, matter["id"])
            return result

    def list_matters(
        self,
        *,
        filters: Mapping[str, Any],
        cursor: tuple[int, int] | None,
        limit: int,
        sort: str,
    ) -> dict[str, Any]:
        with self.repository.connect() as conn:
            items, next_cursor, total = self.repository.list_matters(
                conn, filters=filters, cursor=cursor, limit=limit, sort=sort
            )
        return {"items": items, "next_cursor": next_cursor, "total": total}

    def patch_matter(
        self,
        public_id: str,
        patch: Mapping[str, Any],
        *,
        expected_version: int,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
    ) -> dict[str, Any]:
        unknown = set(patch) - DIRECT_PATCH_FIELDS - MANUAL_UPDATE_FIELDS
        if unknown:
            raise MatterError(
                "E_INVALID_ARG", f"unsupported patch fields: {sorted(unknown)}"
            )
        if "description" in patch and actor.kind != MatterActorKind.USER.value:
            raise MatterError(
                "E_INVALID_ARG", "description can only be changed by a user"
            )
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        with self.repository.transaction() as conn:
            replay = self._replay(conn, dedupe_key, "matter_updated")
            if replay:
                return replay
            matter = self._require_matter(conn, public_id)
            direct_changes: dict[str, Any] = {
                "updated_at": now,
                "last_activity_at": now,
            }
            for field in DIRECT_PATCH_FIELDS:
                if field not in patch:
                    continue
                value = patch[field]
                if field == "title":
                    value = str(value or "").strip()
                    if not value:
                        raise MatterError("E_INVALID_ARG", "title cannot be empty")
                elif field == "matter_type":
                    value = self._optional_text(value)
                elif field == "tags":
                    field = "tags_json"
                    value = self._dump(normalize_tags(value))
                elif field == "waiting_context":
                    field = "waiting_context_json"
                    value = self._dump(value) if value is not None else None
                direct_changes[field] = value
            manual = {
                field: patch[field] for field in MANUAL_UPDATE_FIELDS if field in patch
            }
            if "status" in manual:
                self._require_value("status", str(manual["status"]), MATTER_STATUSES)
            if "health" in manual:
                self._require_value(
                    "health", str(manual["health"]), MATTER_HEALTH_VALUES
                )
            update_id = None
            if manual:
                reviewed = dict(manual)
                update_id = self.repository.insert_update(
                    conn,
                    {
                        "matter_id": matter["id"],
                        "review_status": "accepted",
                        "summary": manual.get("current_summary"),
                        "from_event_id": None,
                        "to_event_id": None,
                        "anchored_matter_version": expected_version,
                        "original_proposal_json": self._dump(
                            {"kind": "manual", "changes": reviewed}
                        ),
                        "reviewed_result_json": self._dump(reviewed),
                        "changes_json": self._dump(reviewed),
                        "citations_json": "[]",
                        "created_by_kind": actor.kind,
                        "created_by_id": actor.actor_id,
                        "created_at": now,
                        "reviewed_at": now,
                        "reviewed_by_kind": actor.kind,
                        "reviewed_by_id": actor.actor_id,
                        "accepted_at": now,
                        "official_state_version": expected_version + 1,
                    },
                )
                if "status" in manual:
                    direct_changes["status"] = str(manual["status"])
                if "health" in manual:
                    direct_changes["health"] = str(manual["health"])
                if "current_summary" in manual:
                    direct_changes.update(
                        {
                            "current_summary": manual["current_summary"],
                            "summary_at": now,
                            "summary_by_kind": actor.kind,
                            "summary_by_id": actor.actor_id,
                        }
                    )
                direct_changes["latest_accepted_update_id"] = update_id
            if not self.repository.cas_update_matter(
                conn, matter["id"], expected_version, direct_changes
            ):
                raise self._version_conflict()
            self.refresh_search_projection(conn, matter["id"])
            event_id = self._append_event(
                conn,
                matter_id=matter["id"],
                kind="matter_updated",
                actor=actor,
                source=source,
                dedupe_key=dedupe_key,
                reason=reason,
                update_id=update_id,
                payload={"fields": sorted(patch)},
                happened_at=now,
            )
            return self._mutation(
                self.repository.get_matter_by_id(conn, matter["id"]), [event_id]
            )

    def archive(self, public_id: str, **mutation: Any) -> dict[str, Any]:
        return self._timestamp_transition(
            public_id, "archive", "archived_at", True, **mutation
        )

    def reopen(self, public_id: str, **mutation: Any) -> dict[str, Any]:
        return self._timestamp_transition(
            public_id, "reopen", "archived_at", False, **mutation
        )

    def trash(self, public_id: str, **mutation: Any) -> dict[str, Any]:
        return self._timestamp_transition(
            public_id, "trash", "deleted_at", True, **mutation
        )

    def restore(self, public_id: str, **mutation: Any) -> dict[str, Any]:
        return self._timestamp_transition(
            public_id, "restore", "deleted_at", False, **mutation
        )

    def permanently_delete(
        self,
        public_id: str,
        *,
        expected_version: int,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
    ) -> dict[str, Any]:
        with self.repository.transaction() as conn:
            matter = self._require_matter(conn, public_id)
            if matter["version"] != expected_version:
                raise self._version_conflict()
            if matter["deleted_at"] is None:
                raise MatterError(
                    "E_INVALID_STATE", "matter must be in Trash before permanent delete"
                )
            if not self.repository.cas_update_matter(
                conn, matter["id"], expected_version, {"updated_at": self.clock_ms()}
            ):
                raise self._version_conflict()
            self.repository.delete_matter(conn, matter["id"])
            return {"deleted": True, "public_id": public_id}

    def create_item(
        self,
        public_id: str,
        data: Mapping[str, Any],
        *,
        expected_version: int,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
    ) -> dict[str, Any]:
        kind = str(data.get("kind") or "")
        title = str(data.get("title") or "").strip()
        self._require_value("kind", kind, MATTER_ITEM_KINDS)
        if not title:
            raise MatterError("E_INVALID_ARG", "item title is required")
        normalized = self._normalize_item(kind, data)
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        with self.repository.transaction() as conn:
            replay = self._replay(conn, dedupe_key, "item_created", include_item=True)
            if replay:
                return replay
            matter = self._require_matter(conn, public_id)
            if not self.repository.cas_update_matter(
                conn,
                matter["id"],
                expected_version,
                {"updated_at": now, "last_activity_at": now},
            ):
                raise self._version_conflict()
            item_id = self.repository.insert_item(
                conn,
                {
                    "matter_id": matter["id"],
                    "kind": kind,
                    "title": title,
                    "description": self._optional_text(data.get("description")),
                    "position": int(data.get("position") or 0),
                    **normalized,
                    "created_by_kind": actor.kind,
                    "created_by_id": actor.actor_id,
                    "created_at": now,
                    "updated_at": now,
                },
            )
            self.refresh_search_projection(conn, matter["id"])
            event_id = self._append_event(
                conn,
                matter_id=matter["id"],
                kind="item_created",
                actor=actor,
                source=source,
                dedupe_key=dedupe_key,
                reason=reason,
                item_id=item_id,
                payload={"kind": kind},
                happened_at=now,
            )
            return self._mutation(
                self.repository.get_matter_by_id(conn, matter["id"]),
                [event_id],
                item=self.repository.get_item(conn, matter["id"], item_id),
            )

    def update_item(
        self, public_id: str, item_id: int, patch: Mapping[str, Any], **mutation: Any
    ):
        return self._mutate_item(public_id, item_id, patch, "item_updated", **mutation)

    def delete_item(self, public_id: str, item_id: int, **mutation: Any):
        return self._mutate_item(
            public_id,
            item_id,
            {"deleted_at": self.clock_ms()},
            "item_deleted",
            **mutation,
        )

    def restore_item(self, public_id: str, item_id: int, **mutation: Any):
        return self._mutate_item(
            public_id, item_id, {"deleted_at": None}, "item_restored", **mutation
        )

    def list_items(self, public_id: str, **filters: Any) -> list[dict[str, Any]]:
        with self.repository.connect() as conn:
            matter = self._require_matter(conn, public_id)
            return self.repository.list_items(conn, matter["id"], **filters)

    def timeline(
        self, public_id: str, *, cursor: int | None, limit: int
    ) -> dict[str, Any]:
        with self.repository.connect() as conn:
            matter = self._require_matter(conn, public_id)
            items, next_cursor = self.repository.list_events(
                conn, matter["id"], cursor=cursor, limit=limit
            )
            return {"items": items, "next_cursor": next_cursor}

    def add_note(
        self, public_id: str, data: Mapping[str, Any], **mutation: Any
    ) -> dict[str, Any]:
        note = dict(data)
        note["kind"] = MatterItemKind.NOTE.value
        return self.create_item(public_id, note, **mutation)

    def _mutate_item(
        self,
        public_id: str,
        item_id: int,
        patch: Mapping[str, Any],
        event_kind: str,
        *,
        expected_version: int,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
    ) -> dict[str, Any]:
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        with self.repository.transaction() as conn:
            replay = self._replay(conn, dedupe_key, event_kind, include_item=True)
            if replay:
                return replay
            matter = self._require_matter(conn, public_id)
            item = self.repository.get_item(conn, matter["id"], item_id)
            if not item:
                raise MatterError("E_CHILD_NOT_FOUND", f"item {item_id} not found")
            changes = dict(patch)
            kind = str(changes.get("kind", item["kind"]))
            self._require_value("kind", kind, MATTER_ITEM_KINDS)
            if "title" in changes:
                changes["title"] = str(changes["title"] or "").strip()
                if not changes["title"]:
                    raise MatterError("E_INVALID_ARG", "item title cannot be empty")
            combined = {**item, **changes}
            normalized = self._normalize_item(kind, combined)
            if kind != MatterItemKind.ACTION.value:
                normalized = {
                    key: value for key, value in normalized.items() if key != "kind"
                }
            changes.update(normalized)
            changes["kind"] = kind
            changes["updated_at"] = now
            if not self.repository.cas_update_matter(
                conn,
                matter["id"],
                expected_version,
                {"updated_at": now, "last_activity_at": now},
            ):
                raise self._version_conflict()
            if not self.repository.update_item(conn, matter["id"], item_id, changes):
                raise MatterError("E_CHILD_NOT_FOUND", f"item {item_id} not found")
            self.refresh_search_projection(conn, matter["id"])
            event_id = self._append_event(
                conn,
                matter_id=matter["id"],
                kind=event_kind,
                actor=actor,
                source=source,
                dedupe_key=dedupe_key,
                reason=reason,
                item_id=item_id,
                payload={"fields": sorted(patch)},
                happened_at=now,
            )
            return self._mutation(
                self.repository.get_matter_by_id(conn, matter["id"]),
                [event_id],
                item=self.repository.get_item(conn, matter["id"], item_id),
            )

    def _timestamp_transition(
        self,
        public_id: str,
        operation: str,
        column: str,
        set_value: bool,
        *,
        expected_version: int,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
    ) -> dict[str, Any]:
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        event_kind = {
            "archive": "matter_archived",
            "reopen": "matter_reopened",
            "trash": "matter_trashed",
            "restore": "matter_restored",
        }[operation]
        with self.repository.transaction() as conn:
            replay = self._replay(conn, dedupe_key, event_kind)
            if replay:
                return replay
            matter = self._require_matter(conn, public_id)
            current = matter[column]
            if set_value and current is not None:
                raise MatterError("E_INVALID_STATE", f"matter is already {operation}d")
            if not set_value and current is None:
                raise MatterError("E_INVALID_STATE", f"matter is not {operation}d")
            changes: dict[str, Any] = {
                column: now if set_value else None,
                "updated_at": now,
            }
            by_prefix = "archived" if column == "archived_at" else "deleted"
            changes[f"{by_prefix}_by_kind"] = actor.kind if set_value else None
            changes[f"{by_prefix}_by_id"] = actor.actor_id if set_value else None
            if column == "deleted_at":
                changes["purge_after"] = now + TRASH_RETENTION_MS if set_value else None
            if not self.repository.cas_update_matter(
                conn, matter["id"], expected_version, changes
            ):
                raise self._version_conflict()
            self.refresh_search_projection(conn, matter["id"])
            event_id = self._append_event(
                conn,
                matter_id=matter["id"],
                kind=event_kind,
                actor=actor,
                source=source,
                dedupe_key=dedupe_key,
                reason=reason,
                payload={},
                happened_at=now,
            )
            return self._mutation(
                self.repository.get_matter_by_id(conn, matter["id"]), [event_id]
            )

    def _normalize_item(self, kind: str, data: Mapping[str, Any]) -> dict[str, Any]:
        if kind != MatterItemKind.ACTION.value:
            offending = [
                field
                for field in ACTION_ONLY_ITEM_FIELDS
                if data.get(field) not in (None, [], ())
            ]
            if offending:
                raise MatterError(
                    "E_INVALID_ARG",
                    f"non-action item cannot set action fields: {sorted(offending)}",
                )
            return {
                "status": None,
                "priority": None,
                "owner_kind": None,
                "owner_id": None,
                "waiting_on_stakeholder_id": None,
                "due_at": None,
                "completed_at": None,
                "checklist_json": "[]",
                "source_resource_id": data.get("source_resource_id"),
                "source_locator_json": self._dump(data["source_locator"])
                if data.get("source_locator") is not None
                else None,
            }
        status = data.get("status") or "open"
        priority = data.get("priority")
        self._require_value("status", str(status), MATTER_ITEM_STATUSES)
        if priority is not None:
            self._require_value("priority", str(priority), MATTER_PRIORITIES)
        owner_kind = data.get("owner_kind")
        if owner_kind is not None:
            self._require_value("owner_kind", str(owner_kind), MATTER_ACTOR_KINDS)
        checklist = data.get("checklist") or []
        if not isinstance(checklist, list):
            raise MatterError("E_INVALID_ARG", "checklist must be a list")
        seen_ids: set[str] = set()
        normalized_checklist = []
        for entry in checklist:
            if not isinstance(entry, Mapping):
                raise MatterError("E_INVALID_ARG", "checklist entries must be objects")
            entry_id = str(entry.get("id") or "").strip()
            text = str(entry.get("text") or "").strip()
            if not entry_id or not text or entry_id in seen_ids:
                raise MatterError(
                    "E_INVALID_ARG", "checklist entries need unique stable id and text"
                )
            seen_ids.add(entry_id)
            normalized_checklist.append(
                {"id": entry_id, "text": text, "done": bool(entry.get("done"))}
            )
        return {
            "status": str(status),
            "priority": priority,
            "owner_kind": owner_kind,
            "owner_id": data.get("owner_id"),
            "waiting_on_stakeholder_id": data.get("waiting_on_stakeholder_id"),
            "due_at": data.get("due_at"),
            "completed_at": data.get("completed_at"),
            "checklist_json": self._dump(normalized_checklist),
            "source_resource_id": data.get("source_resource_id"),
            "source_locator_json": self._dump(data["source_locator"])
            if data.get("source_locator") is not None
            else None,
        }

    def _append_event(
        self,
        conn: sqlite3.Connection,
        *,
        matter_id: int,
        kind: str,
        actor: Actor,
        source: str,
        dedupe_key: str,
        payload: Mapping[str, Any],
        happened_at: int,
        reason: str | None,
        item_id: int | None = None,
        update_id: int | None = None,
    ) -> int:
        event_payload = dict(payload)
        event_payload.update(
            {
                "source": source,
                "reason": reason,
                "idempotency_key": dedupe_key[:16] + "…",
            }
        )
        return self.repository.insert_event(
            conn,
            {
                "matter_id": matter_id,
                "kind": kind,
                "happened_at": happened_at,
                "actor_kind": actor.kind,
                "actor_id": actor.actor_id,
                "source": source or "desktop_ui",
                "item_id": item_id,
                "update_id": update_id,
                "dedupe_key": dedupe_key,
                "payload_json": self._dump(event_payload),
                "created_at": happened_at,
            },
        )

    def _replay(
        self,
        conn: sqlite3.Connection,
        dedupe_key: str,
        expected_kind: str,
        *,
        include_item: bool = False,
    ) -> dict[str, Any] | None:
        event = self.repository.find_event(conn, dedupe_key)
        if not event:
            return None
        if event["kind"] != expected_kind:
            raise MatterError(
                "E_IDEMPOTENCY_CONFLICT",
                "idempotency key was used for another mutation",
            )
        matter = self.repository.get_matter_by_id(conn, event["matter_id"])
        extra = {}
        if include_item and event.get("item_id"):
            extra["item"] = self.repository.get_item(
                conn, event["matter_id"], event["item_id"]
            )
        return self._mutation(matter, [event["id"]], **extra)

    def _require_matter(
        self, conn: sqlite3.Connection, public_id: str
    ) -> dict[str, Any]:
        matter = self.repository.get_matter(conn, public_id)
        if not matter:
            raise MatterError("E_MATTER_NOT_FOUND", f"matter {public_id} not found")
        return matter

    @staticmethod
    def _mutation(
        matter: dict[str, Any] | None, event_ids: list[int], **extra: Any
    ) -> dict[str, Any]:
        result = {
            "matter": matter,
            "version": matter["version"] if matter else None,
            "event_ids": event_ids,
            "warnings": [],
            "undo": None,
        }
        result.update(extra)
        return result

    @staticmethod
    def _version_conflict() -> MatterError:
        return MatterError(
            "E_VERSION_CONFLICT",
            "matter version changed",
            hint="Reload the Matter and retry with the latest version.",
        )

    @staticmethod
    def _require_value(field: str, value: str, allowed: Sequence[str]) -> None:
        if value not in allowed:
            raise MatterError("E_INVALID_ARG", f"invalid {field}: {value}")

    @staticmethod
    def _validate_actor(actor: Actor) -> None:
        if actor.kind not in MATTER_ACTOR_KINDS:
            raise MatterError("E_INVALID_ARG", f"invalid actor kind: {actor.kind}")

    @staticmethod
    def _optional_text(value: Any) -> str | None:
        if value is None:
            return None
        text = str(value).strip()
        return text or None

    @staticmethod
    def _dump(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    @staticmethod
    def _dedupe(idempotency_key: str) -> str:
        key = str(idempotency_key or "").strip()
        if not key:
            raise MatterError("E_INVALID_ARG", "idempotency_key is required")
        return key

    def refresh_search_projection(
        self, conn: sqlite3.Connection, matter_id: int
    ) -> None:
        """P2 extension seam; v44 has no search projection table yet."""
