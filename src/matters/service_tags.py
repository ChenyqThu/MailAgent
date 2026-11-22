"""Matter tag styling, rename, and deletion mixin for MatterService."""

from __future__ import annotations

import sqlite3
from typing import Any, Mapping, Sequence

from .events import MATTER_UPDATED
from .models import (
    MATTER_TAG_COLORS,
    MATTER_TAG_DEFAULT_COLOR,
    MATTER_TAG_DEFAULT_SHAPE,
    MATTER_TAG_SHAPES,
    normalize_tags,
)
from .proposal_scope import SCOPE_NOTHING
from .resource_identity import MatterError
from .service_common import Actor


class _MatterTagMixin:
    """Tag management methods for MatterService."""

    def list_tags(self) -> list[dict[str, Any]]:
        with self.repository.connect() as conn:
            return self.repository.list_tags(conn)

    def upsert_tag_style(
        self,
        name: str,
        *,
        color: str,
        shape: str,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
        reverses_event_id: int | None = None,
    ) -> dict[str, Any]:
        del reverses_event_id
        self._validate_actor(actor)
        tag_name = self._normalize_tag_name(name)
        color = str(color)
        shape = str(shape)
        self._require_value("color", color, MATTER_TAG_COLORS)
        self._require_value("shape", shape, MATTER_TAG_SHAPES)
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        replay_payload = {"name": tag_name, "color": color, "shape": shape}
        with self._transaction() as conn:
            replay = self._tag_replay(
                conn, dedupe_key, "tag_style_upsert", replay_payload
            )
            if replay:
                return replay
            self.repository.upsert_tag(
                conn, name=tag_name, color=color, shape=shape, created_at=now
            )
            tag = self._listed_tag(conn, tag_name)
            result = {
                "tag": tag,
                "event_ids": [],
                "warnings": [],
            }
            self._store_tag_mutation(
                conn,
                dedupe_key,
                operation="tag_style_upsert",
                payload=replay_payload,
                result=result,
                now=now,
            )
            return result

    def rename_tag(
        self,
        old_name: str,
        new_name: str,
        *,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
        reverses_event_id: int | None = None,
    ) -> dict[str, Any]:
        self._validate_actor(actor)
        old_tag_name = self._normalize_tag_name(old_name)
        new_tag_name = self._normalize_tag_name(new_name)
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        replay_payload = {"old_name": old_tag_name, "new_name": new_tag_name}
        with self._transaction() as conn:
            replay = self._tag_replay(conn, dedupe_key, "tag_rename", replay_payload)
            if replay:
                return replay
            if old_tag_name == new_tag_name:
                tag = self._listed_tag(conn, new_tag_name)
                result = {
                    "tag": tag,
                    "event_ids": [],
                    "warnings": ["same_name"],
                }
                self._store_tag_mutation(
                    conn,
                    dedupe_key,
                    operation="tag_rename",
                    payload=replay_payload,
                    result=result,
                    now=now,
                )
                return result
            old_defined = self.repository.get_tag(conn, old_tag_name) is not None
            old_referenced = self.repository.tag_is_referenced(
                conn, old_tag_name, include_deleted=True
            )
            if not old_defined and not old_referenced:
                raise MatterError("E_NOT_FOUND", f"tag {old_tag_name} not found")
            self.repository.merge_or_rename_tag_definition(
                conn, old_name=old_tag_name, new_name=new_tag_name, created_at=now
            )
            changed = self.repository.rename_tag_references(
                conn, old_name=old_tag_name, new_name=new_tag_name, updated_at=now
            )
            tag = self._listed_tag(conn, new_tag_name)
            event_ids = self._append_tag_reference_events(
                conn,
                changed,
                dedupe_key=dedupe_key,
                actor=actor,
                source=source,
                reason=reason,
                now=now,
                payload={
                    "fields": ["tags"],
                    "operation": "tag_rename",
                    "old_name": old_tag_name,
                    "new_name": new_tag_name,
                },
                reverses_event_id=reverses_event_id,
            )
            result = {
                "tag": tag,
                "event_ids": event_ids,
                "warnings": [],
                "affected_count": len(changed),
            }
            self._store_tag_mutation(
                conn,
                dedupe_key,
                operation="tag_rename",
                payload=replay_payload,
                result=result,
                now=now,
            )
            return result

    def delete_tag(
        self,
        name: str,
        *,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
        reverses_event_id: int | None = None,
    ) -> dict[str, Any]:
        self._validate_actor(actor)
        tag_name = self._normalize_tag_name(name)
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        replay_payload = {"name": tag_name}
        with self._transaction() as conn:
            replay = self._tag_replay(conn, dedupe_key, "tag_delete", replay_payload)
            if replay:
                return replay
            defined = self.repository.delete_tag(conn, tag_name)
            referenced = self.repository.tag_is_referenced(
                conn, tag_name, include_deleted=True
            )
            if not defined and not referenced:
                raise MatterError("E_NOT_FOUND", f"tag {tag_name} not found")
            changed = self.repository.remove_tag_references(
                conn, name=tag_name, updated_at=now
            )
            event_ids = self._append_tag_reference_events(
                conn,
                changed,
                dedupe_key=dedupe_key,
                actor=actor,
                source=source,
                reason=reason,
                now=now,
                payload={
                    "fields": ["tags"],
                    "operation": "tag_delete",
                    "name": tag_name,
                },
                reverses_event_id=reverses_event_id,
            )
            result = {
                "deleted": True,
                "name": tag_name,
                "event_ids": event_ids,
                "warnings": [],
                "affected_count": len(changed),
            }
            self._store_tag_mutation(
                conn,
                dedupe_key,
                operation="tag_delete",
                payload=replay_payload,
                result=result,
                now=now,
            )
            return result

    def _tag_replay(
        self,
        conn: sqlite3.Connection,
        dedupe_key: str,
        operation: str,
        payload: Mapping[str, Any],
    ) -> dict[str, Any] | None:
        stored = self.repository.get_tag_mutation(conn, dedupe_key)
        if not stored:
            return None
        if stored.get("operation") != operation or stored.get("payload") != dict(payload):
            raise MatterError(
                "E_IDEMPOTENCY_CONFLICT",
                "idempotency key was used for another mutation",
            )
        result = stored.get("result")
        return dict(result) if isinstance(result, Mapping) else None

    def _store_tag_mutation(
        self,
        conn: sqlite3.Connection,
        dedupe_key: str,
        *,
        operation: str,
        payload: Mapping[str, Any],
        result: Mapping[str, Any],
        now: int,
    ) -> None:
        self.repository.put_tag_mutation(
            conn,
            dedupe_key,
            value={
                "operation": operation,
                "payload": dict(payload),
                "result": dict(result),
            },
            updated_at=now,
        )

    def _append_tag_reference_events(
        self,
        conn: sqlite3.Connection,
        changed_rows: Sequence[Mapping[str, Any]],
        *,
        dedupe_key: str,
        actor: Actor,
        source: str,
        reason: str | None,
        now: int,
        payload: Mapping[str, Any],
        reverses_event_id: int | None,
    ) -> list[int]:
        event_ids: list[int] = []
        for row in changed_rows:
            matter_id = int(row["id"])
            # 重命名/删除标签只改 tags_json —— 提案结构上碰不到标签，不作废任何提案。
            self._mark_stale_proposals(
                conn, matter_id, int(row.get("version") or 0) + 1, SCOPE_NOTHING
            )
            self.refresh_search_projection(conn, matter_id)
            event_ids.append(
                self._append_event(
                    conn,
                    matter_id=matter_id,
                    kind=MATTER_UPDATED,
                    actor=actor,
                    source=source,
                    dedupe_key=f"{dedupe_key}:matter:{matter_id}",
                    reason=reason,
                    payload=dict(payload),
                    happened_at=now,
                    reverses_event_id=reverses_event_id,
                )
            )
        return event_ids

    @staticmethod
    def _normalize_tag_name(value: Any) -> str:
        try:
            tags = normalize_tags([str(value or "")])
        except ValueError as exc:
            raise MatterError("E_INVALID_ARG", str(exc)) from exc
        if not tags:
            raise MatterError("E_INVALID_ARG", "tag name is required")
        return tags[0]

    def _listed_tag(self, conn: sqlite3.Connection, name: str) -> dict[str, Any]:
        for tag in self.repository.list_tags(conn):
            if tag["name"] == name:
                return tag
        return {
            "name": name,
            "color": MATTER_TAG_DEFAULT_COLOR.value,
            "shape": MATTER_TAG_DEFAULT_SHAPE.value,
            "created_at": None,
            "usage_count": 0,
            "inferred": True,
        }
